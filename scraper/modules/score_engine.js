/**
 * modules/score_engine.js — Single source of truth scoring function
 * (Review.md P0-2, follow-up item #7, 2026-07-30).
 *
 * Every caller that needs an AWO composite score — live signal-scanner,
 * historical backfill, backtest replay, and the weight optimizer — should
 * call `scoreAtTimestamp()` with already-fetched inputs, instead of
 * separately re-assembling F1-F13 + weightedComposite + combineFinalScore +
 * classifySignal locally. Before this, that assembly sequence was
 * copy-pasted (with real, caught drift — see the 2026-07-19 overfitting
 * incident and the 2026-07-28 formula-review fixes) across server.js and
 * ~8 backtest/backfill scripts.
 *
 * Deliberately a PURE function — no database access, no fetching. Each
 * caller is still responsible for FETCHING and no-lookahead-slicing its own
 * inputs (that part legitimately differs between a live Express route, a
 * backtest loop reading an in-memory Map, and the optimizer re-scoring a
 * stored historical row); only the actual scoring MATH is now guaranteed
 * identical everywhere, and testable as such (see test_score_parity.js).
 *
 * Migrated so far: awo_optimizer.js (rescoreSignal), server.js (main
 * /api/signal-scanner loop and computeStockFactorsLive). NOT yet migrated:
 * regenerate_signal_history.js and the backtest_*.js scripts — each has its
 * own trade-simulation wrapper already independently verified against real
 * data this session (see BACKTEST_EXPERIMENTS.md); migrating them is real
 * remaining work, not done in this pass to avoid destabilizing already-
 * validated backtest results without a clear need.
 */
'use strict';

const {
  f1_concentration, f2_trend, f3_volumeZ, f4_momentum, f5_relStrength,
  f6_breadth, f7_alignment, f8_streak,
  weightedComposite, computeConfidence, computeRiskModifier, combineFinalScore,
} = require('./awo_factors');
const { calcTechnicalFactors } = require('../awo_technical');
const { detectPriceRegime } = require('./regime_engine');

// F14 deliberately absent (external review, 2026-07-31): it's a risk
// MODIFIER (computeRiskModifier), never a directional weight —
// combineFactorScores strips any f14 key before the weighted sum regardless,
// so an f14 entry here would be pure dead weight, and worse, an inconsistent
// object shape vs. what the optimizer now generates (see awo_optimizer.js's
// generateWeightCandidates).
//
// Raw literals below still sum to 0.97, not 1.00 — they're the ORIGINAL
// F1-F13 shares from when F14's 0.03 was still part of the same 1.00 total.
// `weightedComposite()` self-normalizes by dividing by the AVAILABLE weight
// sum, so this never changed any actual score — but a "default" that
// doesn't sum to 1.00 is a real audit/config footgun (external review,
// round 3, 2026-07-31, finding #11), so DEFAULT_WEIGHTS is the RENORMALIZED
// export; RAW_F1_13_SHARES is kept only as the documented starting point.
const RAW_F1_13_SHARES = {
  f1: 0.14, f2: 0.10, f3: 0.08, f4: 0.10,
  f5: 0.07, f6: 0.10, f7: 0.08, f8: 0.05,
  f9: 0.06, f10: 0.06, f11: 0.05, f12: 0.05,
  f13: 0.03,
};
function normalizeToOne(raw) {
  const keys = Object.keys(raw);
  const sum = keys.reduce((s, k) => s + raw[k], 0);
  const out = {};
  for (const k of keys) out[k] = Math.round((raw[k] / sum) * 1000) / 1000;
  const drift = Math.round((1.0 - keys.reduce((s, k) => s + out[k], 0)) * 1000) / 1000;
  out[keys[0]] = Math.round((out[keys[0]] + drift) * 1000) / 1000;
  return out;
}
const DEFAULT_WEIGHTS = normalizeToOne(RAW_F1_13_SHARES);
const DEFAULT_THRESHOLDS = { strongBuy: 78, buy: 63, watch: 53, neutral: 40, sell: 25 };

function classifySignal(score, thresholds = DEFAULT_THRESHOLDS) {
  const t = thresholds;
  if (score >= t.strongBuy) return 'STRONG BUY';
  if (score >= t.buy) return 'BUY';
  if (score >= t.watch) return 'WATCH';
  if (score >= t.neutral) return 'NEUTRAL';
  if (score >= t.sell) return 'SELL';
  return 'STRONG SELL';
}

/**
 * The actual shared core: given F1-F13 scores + F14 + availability, combine
 * into directional/confidence/risk/final/decision. `scoreAtTimestamp` below
 * calls this after computing F1-F14 from raw market/broker data; callers
 * that already HAVE precomputed factor scores (the optimizer, re-testing
 * many weight candidates against the same stored historical factors without
 * recomputing them from raw prices every time) call this directly instead —
 * either way, this one function is what decides the score. This is the
 * piece that used to independently drift between server.js and
 * awo_optimizer.js (F14 summed vs risk-modifier being the concrete bug an
 * external review caught 2026-07-30).
 *
 * @param {Object} f1_13 - { f1, f2, ..., f13 } scores, 0-100 each
 * @param {number} f14 - ATR/volatility score, 0-100
 * @param {Object} availability - { f1: bool, ... } per weightedComposite
 * @param {Object} weights - defaults to DEFAULT_WEIGHTS
 * @param {Object} thresholds - defaults to DEFAULT_THRESHOLDS
 */
function combineFactorScores(f1_13, f14, availability = {}, weights = DEFAULT_WEIGHTS, thresholds = DEFAULT_THRESHOLDS) {
  // Bug found by external review 2026-07-31: weightedComposite() iterates
  // Object.keys(weights) — if `weights` carries an f14 entry (DEFAULT_WEIGHTS
  // and every optimizer candidate did), it silently contributed `50 * weights.f14`
  // to the directional numerator/denominator (f1_13 has no f14 key, so the
  // `scores[key] ?? 50` fallback fired every time), pulling EVERY live score
  // toward neutral by however much weight was assigned to f14 — on top of the
  // separate, correct computeRiskModifier(f14) multiplication below. Verified
  // empirically: 13 factors all scoring 80 with f14 present in weights produced
  // composite=79.1 instead of 80.0. F14 is a risk MODIFIER, not a directional
  // vote — it must never reach weightedComposite at all.
  const { f14: _unusedF14Weight, ...directionalWeights } = weights;
  const { composite: directionalScore, factorCoverage, missingFactors } = weightedComposite(f1_13, directionalWeights, availability);
  const confidence = computeConfidence(factorCoverage);
  const riskModifier = computeRiskModifier(f14);
  const finalScore = combineFinalScore(directionalScore, confidence, riskModifier);
  const decision = classifySignal(finalScore, thresholds);
  return { directionalScore, factorCoverage, missingFactors, confidence, riskModifier, finalScore, decision };
}

/**
 * @param {Object} params
 * @param {string} params.symbol
 * @param {string} params.timestamp - "as of" date (ISO date string), for
 *   labeling only — the CALLER must ensure candles/brokerData contain
 *   nothing after this date (no lookahead is enforced here, only labeled).
 * @param {Object} params.marketData
 * @param {Array<{date:string,open:number,high:number,low:number,close:number,volume:number}>} params.marketData.candles
 *   oldest-first, ending at or before `timestamp`
 * @param {number} [params.marketData.marketAvgChangePct] - cross-sectional
 *   market average daily change %, for F5 (relative strength); defaults to 0
 * @param {Object} [params.brokerData]
 * @param {{dn0:number,dn1:number,dn2:number,dn3:number,dn4:number}|null} [params.brokerData.concentration]
 *   null/omitted if no concentration data exists for this symbol+date
 * @param {{netBuyers:number,netSellers:number}|null} [params.brokerData.breadth]
 *   null/omitted if no breadth data exists for this symbol+date
 * @param {Object} [params.weights] - defaults to DEFAULT_WEIGHTS
 * @param {Object} [params.thresholds] - defaults to DEFAULT_THRESHOLDS
 * @param {string} [params.modelVersion]
 * @param {string} [params.configVersion]
 * @returns {Object} standardized score object (Review.md P0-2 shape)
 */
function scoreAtTimestamp({
  symbol, timestamp, marketData, brokerData,
  weights = DEFAULT_WEIGHTS, thresholds = DEFAULT_THRESHOLDS,
  modelVersion = null, configVersion = null,
}) {
  const candles = marketData?.candles || [];
  const marketAvgChangePct = marketData?.marketAvgChangePct ?? 0;
  const conc = brokerData?.concentration ?? null;
  const breadth = brokerData?.breadth ?? null;

  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const dailyChangePct = last && prev && prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : 0;
  const priceDirection = dailyChangePct > 0 ? 1 : dailyChangePct < 0 ? -1 : 0;

  const dn0 = conc ? Number(conc.dn0 ?? 0) : null;
  const dnValues = conc
    ? [conc.dn4, conc.dn3, conc.dn2, conc.dn1, conc.dn0].map(v => v !== null && v !== undefined ? Number(v) : null)
    : [];
  const brokerDataAvailable = !!conc;
  const breadthDataAvailable = !!breadth;

  const f1 = f1_concentration(dn0);
  const f2 = f2_trend(dnValues.filter(v => v !== null));
  const f3 = f3_volumeZ(volumes, priceDirection);
  const f4 = f4_momentum(closes);
  const f5 = f5_relStrength(dailyChangePct, marketAvgChangePct);
  const f6 = f6_breadth(breadth?.netBuyers || 0, breadth?.netSellers || 0);
  const f7 = f7_alignment(dailyChangePct, dn0);
  const f8 = f8_streak(dnValues.filter(v => v !== null));

  // Fixed 2026-07-31 (external review, round 2 P1, then round 3 findings
  // #2/#4): first fix used one shared `technicalAvailable = candles.length
  // >= 15` flag for F9-F13 — better than "always available," but still
  // wrong, since it applied RSI's minimum (15 bars) to Bollinger/S-R (need
  // 20) and EMA-trend (needs 21) and MACD (needs 35) alike. A stock with,
  // say, 16 bars was marked available on all five even though only RSI
  // could produce a real reading — the other four were still fake-50s
  // sneaking into the weighted composite as if they were real. Now each
  // factor gets its own availability straight from calcTechnicalFactors,
  // which checks its OWN indicator's real null/non-null state (see that
  // function's comment for the exact per-indicator minimums).
  const tech = calcTechnicalFactors(candles.slice(-60));
  const { f9, f10, f11, f12, f13, f14 } = tech;
  const indicators = tech.indicators;

  const factorScores = { f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13, f14 };
  const factorAvailability = {
    f1: brokerDataAvailable, f2: brokerDataAvailable, f3: true, f4: true, f5: true,
    f6: breadthDataAvailable, f7: brokerDataAvailable, f8: brokerDataAvailable,
    f9: tech.factorAvailable.f9, f10: tech.factorAvailable.f10, f11: tech.factorAvailable.f11,
    f12: tech.factorAvailable.f12, f13: tech.factorAvailable.f13,
  };

  const { directionalScore, factorCoverage, missingFactors, confidence, riskModifier, finalScore, decision } =
    combineFactorScores({ f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13 }, f14, factorAvailability, weights, thresholds);

  let regime = null;
  try { regime = candles.length ? detectPriceRegime(candles.slice(-280)).regime : null; } catch {}

  const reasonCodes = [];
  if (!brokerDataAvailable) reasonCodes.push('NO_BROKER_DATA');
  if (!breadthDataAvailable) reasonCodes.push('NO_BREADTH_DATA');
  if (factorCoverage < 0.65) reasonCodes.push('LOW_FACTOR_COVERAGE');

  return {
    symbol, timestamp, regime,
    eligibleSetup: null, // Setup Library not implemented — AWO Engine.md §6, deliberately deferred
    factorScores: Object.fromEntries(Object.entries(factorScores).map(([k, v]) => [k, Math.round(v)])),
    factorAvailability,
    factorCoverage: Math.round(factorCoverage * 100) / 100,
    missingFactors,
    directionalScore: Math.round(directionalScore),
    confidence: Math.round(confidence * 100) / 100,
    riskModifier: Math.round(riskModifier * 100) / 100,
    finalScore,
    decision,
    reasonCodes,
    indicators,
    modelVersion,
    configVersion,
  };
}

module.exports = { scoreAtTimestamp, combineFactorScores, DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS, classifySignal };
