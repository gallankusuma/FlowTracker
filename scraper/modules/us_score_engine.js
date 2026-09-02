'use strict';
/**
 * modules/us_score_engine.js — the US composite, extracted from server.js.
 *
 * ── WHY IT MOVED ─────────────────────────────────────────────────────────────
 *
 * `computeUSStockFactors` lived inside server.js and was not exported, so the
 * US signal-history backfill had exactly two options: re-implement the scoring,
 * or move it. Re-implementing is the precise defect `modules/score_engine.js`
 * exists to prevent on the IDX side — that assembly sequence was copy-pasted
 * across server.js and ~8 scripts and drifted for real twice (the 2026-07-19
 * overfitting incident, and F14 being summed as a directional factor instead of
 * applied as a risk modifier, caught by external review 2026-07-30).
 *
 * A backfilled history that scores differently from the live scanner is worse
 * than no history at all: every backtest run on it would measure a system
 * nobody is running. So this is a pure extraction — same code, same order of
 * operations, same rounding.
 *
 * ── THE ONE THING THAT IS NOT A PURE MOVE, AND WHY ───────────────────────────
 *
 * server.js's `classifySignal` reads LIVE optimized thresholds via
 * `getActiveThresholds()`, which change when the optimizer promotes a
 * candidate. Baking today's thresholds into a replay of 2006 would label
 * history with a rule that did not exist then, and hard-coding
 * DEFAULT_THRESHOLDS would silently change what the live scanner returns.
 *
 * So thresholds are INJECTED. server.js passes its live getter and behaves
 * exactly as before; the backfill passes DEFAULT_THRESHOLDS and records that it
 * did. The composite score itself does not depend on thresholds at all — only
 * the BUY/SELL label does — so research that ranks on `composite` is unaffected
 * either way.
 *
 * ── WHAT IS NOT HERE ─────────────────────────────────────────────────────────
 *
 * F1, F2, F6, F7, F8. They need per-broker concentration and buyer/seller
 * counts that do not exist for US equities and never will — there is no public
 * US equivalent of the IDX broker-summary feed. Measured on IDX (EXP-042),
 * those five carry 48.4% of the directional weight, so the US composite is not
 * a port of the IDX composite; it is the half of it that can travel.
 */

const {
  f3_volumeZ, f4_momentum, f5_relStrength,
  computeConfidence, computeRiskModifier, combineFinalScore,
} = require('./awo_factors');
const { DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS } = require('./score_engine');
const { computeConvictionTier } = require('./conviction');
const { calcTechnicalFactors, computeWeeklyTrend, computeTradePlan } = require('../awo_technical');

/**
 * The eight IDX weights that survive the port, renormalized to 1.0 so the
 * composite stays on the 0-100 scale the thresholds expect.
 *
 * Note what this renormalization quietly does: F1/F2/F6/F7/F8's 48.4% is
 * redistributed proportionally across the survivors, so the US composite gives
 * momentum-cluster factors a far larger share than IDX does. That is a
 * consequence of the port, not a decision anyone made — the same "weights are
 * an accident" problem EXP-042 registered on the IDX side, arriving here by a
 * different route.
 */
const US_TECH_WEIGHTS = (() => {
  const base = {
    f3: DEFAULT_WEIGHTS.f3, f4: DEFAULT_WEIGHTS.f4, f5: DEFAULT_WEIGHTS.f5,
    f9: DEFAULT_WEIGHTS.f9, f10: DEFAULT_WEIGHTS.f10, f11: DEFAULT_WEIGHTS.f11,
    f12: DEFAULT_WEIGHTS.f12, f13: DEFAULT_WEIGHTS.f13,
  };
  const sum = Object.values(base).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v / sum]));
})();

/**
 * Bars fed to the price/volume factors.
 *
 * ── WHY THIS CONSTANT EXISTS, AND WHY IT IS A CORRECTION ─────────────────────
 *
 * The pre-extraction code handed `calcTechnicalFactors` a 60-bar slice but
 * handed F3 and F4 the ENTIRE candle array. F4's lookbacks are bounded
 * (roc 3/5, rsi 14), so it does not care. **F3 does**: `f3_volumeZ` calls
 * `zScoreFromArray(volumes)` over everything it is given, so the "volume
 * z-score" is computed against whatever history happens to be in the table.
 *
 * That was invisible while `us_stock_prices` held six months. It stops being
 * invisible the moment it holds twenty years: a 2026 session's volume would be
 * scored against 2006 volumes, and since traded volume trends over decades the
 * z-score would mostly measure that trend rather than "is today unusual". Worse
 * for research, the factor's MEANING would drift across the sample -- an early
 * row scored against 60 bars, a late one against 5,000 -- which is not
 * lookahead but is definition instability, and it would quietly poison any
 * backtest run on the resulting history.
 *
 * So the deep backfill forced the question rather than creating it. Doing
 * nothing was also a change: F3 on the live US scanner shifts the instant the
 * deep history lands. Bounding it is the controlled version of a change that
 * was going to happen anyway, and it restores parity with the IDX path, whose
 * callers already pass 60 candles.
 *
 * 60 matches the slice `calcTechnicalFactors` was already getting one line
 * below, so all eight factors now see the same window.
 */
const FACTOR_WINDOW = 60;

function classify(score, t) {
  if (score >= t.strongBuy) return 'STRONG BUY';
  if (score >= t.buy) return 'BUY';
  if (score >= t.watch) return 'WATCH';
  if (score >= t.neutral) return 'NEUTRAL';
  if (score >= t.sell) return 'SELL';
  return 'STRONG SELL';
}

/**
 * Technical + price-derived composite/signal/tradePlan for one ticker's candle
 * history — shared by the US scanner, the deep-dive route and the signal-history
 * backfill.
 *
 * `marketAvgChangePct` is the cross-sectional mean daily change across all
 * US_TICKERS for the SAME day as the last candle in `candles`. It is passed in
 * rather than computed here so a caller running a historical rolling window can
 * supply the correct point-in-time value instead of today's — the lookahead this
 * signature exists to make hard to introduce.
 *
 * @param {Array<{date:string,open:number,high:number,low:number,close:number,volume:number}>} candles
 *   oldest-first, ending at the as-of bar. Nothing after it.
 * @param {string} marketDirection
 * @param {number} [marketAvgChangePct]
 * @param {{thresholds?: Object}} [options] thresholds default to DEFAULT_THRESHOLDS
 */
function computeUSStockFactors(candles, marketDirection, marketAvgChangePct = 0, options = {}) {
  if (!candles || candles.length < 15) return null;
  const thresholds = options.thresholds || DEFAULT_THRESHOLDS;
  const tech = calcTechnicalFactors(candles.slice(-FACTOR_WINDOW));

  // FACTOR_WINDOW, not the whole array. See the constant's note -- this is a
  // deliberate correction, and the only behavioural difference from the
  // pre-extraction code. test_us_score_engine.js pins it: below the window the
  // two are bit-identical, above it the new result equals the old one fed the
  // last FACTOR_WINDOW bars, and nothing else moved.
  const win = candles.slice(-FACTOR_WINDOW);
  const closes = win.map(c => c.close);
  const volumes = win.map(c => c.volume || 0);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const dailyChangePct = prev && prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : 0;

  const f3 = f3_volumeZ(volumes, dailyChangePct);
  const f4 = f4_momentum(closes);
  const f5 = f5_relStrength(dailyChangePct, marketAvgChangePct);

  const rawComposite8 =
    f3 * US_TECH_WEIGHTS.f3 + f4 * US_TECH_WEIGHTS.f4 + f5 * US_TECH_WEIGHTS.f5 +
    tech.f9 * US_TECH_WEIGHTS.f9 + tech.f10 * US_TECH_WEIGHTS.f10 + tech.f11 * US_TECH_WEIGHTS.f11 +
    tech.f12 * US_TECH_WEIGHTS.f12 + tech.f13 * US_TECH_WEIGHTS.f13;
  const composite = combineFinalScore(rawComposite8, computeConfidence(undefined), computeRiskModifier(tech.f14));
  const signal = classify(composite, thresholds);

  let weeklyTrend = null;
  try { weeklyTrend = computeWeeklyTrend(candles); } catch {}
  let trendAligned = null;
  if (weeklyTrend && weeklyTrend.trend !== 'NEUTRAL') {
    const isBullishSignal = signal === 'STRONG BUY' || signal === 'BUY';
    const isBearishSignal = signal === 'SELL' || signal === 'STRONG SELL';
    if (isBullishSignal) trendAligned = weeklyTrend.trend === 'BULLISH';
    else if (isBearishSignal) trendAligned = weeklyTrend.trend === 'BEARISH';
  }

  const currentPrice = last.close;
  let tradePlan = null;
  try { tradePlan = computeTradePlan(currentPrice, signal, tech.indicators?.atr ?? null, tech.indicators?.sr ?? null); } catch {}

  const convictionTier = computeConvictionTier({ source: 'awo', trendAligned, signal, marketDirection, market: 'US' });

  return {
    composite, signal,
    factors: {
      volumeZ: Math.round(f3), momentum: Math.round(f4), relStrength: Math.round(f5),
      rsi: Math.round(tech.f9), macd: Math.round(tech.f10), bollinger: Math.round(tech.f11),
      emaTrend: Math.round(tech.f12), supportResistance: Math.round(tech.f13), atr: Math.round(tech.f14),
    },
    indicators: tech.indicators, weeklyTrend: weeklyTrend?.trend ?? null, trendAligned, tradePlan,
    convictionTier: convictionTier.tier, sizeMultiplier: convictionTier.sizeMultiplier, tierReason: convictionTier.reason,
  };
}

module.exports = { computeUSStockFactors, US_TECH_WEIGHTS };
