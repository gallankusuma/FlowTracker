/**
 * modules/awo_factors.js
 * Single source of truth for the F1-F8 broker/bandarmology factor formulas —
 * previously duplicated independently in server.js, regenerate_signal_history.js,
 * and backtest_signal_scanner_badges.js (exactly the drift risk flagged as
 * deferred in the 2026-07-19 AWO overfitting incident: "f1-f8 computed with
 * independent, non-shared formulas... this is the actual root-cause fix").
 * All three now import from here so a future formula change can't silently
 * diverge between live scoring, backfill, and backtest again.
 *
 * Fixed 2026-07-28 after an external code review (see project memory) found
 * several real bugs, verified against production code + data before fixing:
 *
 *   F7 — sameDirection collapsed "price down + broker selling" (bearish
 *        confirmation) and "price up + broker buying" (bullish confirmation)
 *        into the SAME high-score branch. A falling stock on heavy broker
 *        selling scored as bullish as a rising stock on heavy buying.
 *   F6 — `pct > 50 ? 1 : -1` made an exact 10-buyer/10-seller split (pct=50,
 *        a textbook neutral case) resolve to -1 (bearish), giving F6=45
 *        instead of 50. Fixed with Math.sign(pct-50), which is 0 at the tie.
 *   F4 — `RSI>70 && momentum<0` (an "overbought, now dropping" reversal
 *        pattern) added +8 to the composite instead of subtracting — a sign
 *        flip, breaks symmetry with the other 3 RSI-momentum branches which
 *        are all correctly signed.
 *   F1/F2/F7 dn0 scale — the code comment claimed dn0 (top-3-broker net flow
 *        as % of total broker flow that day) ranges "-10 to +10". Queried
 *        the real data: it's mathematically bounded to ±100 (percentage),
 *        average |dn0| ~12, legitimately reaching 40-90+ on strongly
 *        concentrated days. F1's sigmoid and F7's brokerIntensity cap were
 *        calibrated for the stale ±10 assumption, saturating almost
 *        immediately and losing discriminative power across most of the
 *        real range. Recalibrated below. (Separately, ~84/25946 rows had
 *        |dn0|>100 from a genuine source bug in autoCalculateConcentration's
 *        `totalNet || 1` fallback — fixed at the source in server.js, not
 *        something these formulas should route around.)
 *   F2 acceleration — "3 days improving" got the same +8 bonus whether it
 *        was genuine bullish acceleration (+2,+5,+8) or still-net-selling-
 *        but-easing (-8,-5,-2). Added a partial-credit tier for
 *        improving-but-still-negative / weakening-but-still-positive.
 *
 * F3, F5, F8 had no confirmed bugs — unchanged, kept here only so all of
 * F1-F8 live in one importable place.
 */
'use strict';

const stats = require('./statistics');

/** Broker-dependent — needs today's top-3-broker net concentration (dn0). */
function f1_concentration(dn0) {
  if (dn0 === null || dn0 === undefined) return 50;
  if (dn0 > 0) {
    return stats.clamp(stats.sigmoid(dn0, 0.06), 50, 100);
  }
  return stats.clamp(50 + dn0 * 0.5, 0, 50);
}

/**
 * A session we did not observe is a HOLE, not a shorter history.
 *
 * dn0..dn4 are five CONSECUTIVE exchange sessions, and both broker-history
 * factors used to open with `dnValues.filter(v => v !== null)`. That closes the
 * hole up and RENUMBERS the days: the value from three sessions ago slides into
 * yesterday's slot, and a run is counted straight through the day nobody
 * measured. It is worse than treating missing data as neutral -- it manufactures
 * evidence of continuity out of an absence of data.
 *
 * Live on 2026-08-20, BEEF read [23.12, 4.61, 44.8, null, 0.1]. Compacted, that
 * was published as a four-session accumulation streak. Four sessions were not
 * observed in a row.
 *
 * 6.1% of idx_concentration rows since 2026-01-01 carry an interior gap, so this
 * is neither rare nor theoretical. The two helpers below are the rule: a null
 * breaks a run, and recency weight belongs to the day that actually held it.
 */

/** Length of the run of same-signed values ending at the last session, stopping at a gap. */
function runToGap(dnValues, positive) {
  let count = 0;
  for (let i = dnValues.length - 1; i >= 0; i--) {
    const v = dnValues[i];
    if (v === null || v === undefined) break;   // unobserved: nothing continued through it
    if (positive ? v > 0 : v < 0) count++;
    else break;
  }
  return count;
}

/** Recency-weighted mean where the weight is the value's REAL position, gaps skipped. */
function positionalWeightedAvg(dnValues) {
  let sumV = 0, sumW = 0;
  for (let i = 0; i < dnValues.length; i++) {
    const v = dnValues[i];
    if (v === null || v === undefined) continue;
    const w = i + 1;
    sumV += v * w;
    sumW += w;
  }
  return sumW > 0 ? sumV / sumW : 0;
}

/** Broker-dependent — needs 5-day concentration history (dn0..dn4). */
function f2_trend(dnValues) {
  if (!dnValues || dnValues.length === 0) return 50;
  const valid = dnValues.filter(v => v !== null && v !== undefined);
  if (valid.length === 0) return 50;

  const positives = valid.filter(v => v > 0).length;
  const total = valid.length;

  // How OFTEN it accumulated is order-free, so the observed days answer it.
  const directionScore = (positives / total) * 100;
  // How RECENTLY it did is not: weight by the real session index.
  const weighted = positionalWeightedAvg(dnValues);
  const recentBias = weighted > 0 ? Math.min(weighted * 0.5, 15) : Math.max(weighted * 0.5, -15);

  // Acceleration bonus, now sign-aware: genuine same-direction acceleration
  // gets the full ±8, but a streak that's still negative-yet-improving (or
  // positive-yet-weakening) only gets partial credit — it's a real signal,
  // just a weaker one than an outright trend reversal.
  let accelBonus = 0;
  const last3 = dnValues.slice(-3);
  const last3Observed = last3.length === 3 && last3.every(v => v !== null && v !== undefined);
  if (last3Observed) {
    const allIncreasing = last3.every((v, i) => i === 0 || v > last3[i - 1]);
    const allDecreasing = last3.every((v, i) => i === 0 || v < last3[i - 1]);
    const allPositive = last3.every(v => v > 0);
    const allNegative = last3.every(v => v < 0);
    if (allPositive && allIncreasing) accelBonus = 8;
    else if (allNegative && allDecreasing) accelBonus = -8;
    else if (allNegative && allIncreasing) accelBonus = 3;
    else if (allPositive && allDecreasing) accelBonus = -3;
  }

  return stats.clamp(directionScore + recentBias + accelBonus, 0, 100);
}

/** Pure volume/price — no broker dependency, portable to any market. */
function f3_volumeZ(volumes, priceDirection) {
  if (!volumes || volumes.length < 5) return 50;
  const z = stats.zScoreFromArray(volumes);

  let score = 50 + z * 12.5;

  if (z > 1 && priceDirection > 0) score += 10;
  if (z > 1 && priceDirection < 0) score -= 10;

  if (volumes.length >= 5) {
    const recent = volumes.slice(-5);
    const earlier = volumes.slice(-10, -5);
    if (earlier.length >= 3) {
      const recentAvg = stats.mean(recent);
      const earlierAvg = stats.mean(earlier);
      if (earlierAvg > 0) {
        const volTrend = (recentAvg - earlierAvg) / earlierAvg;
        if (volTrend > 0.3) score += 5;
        if (volTrend < -0.3) score -= 3;
      }
    }
  }

  return stats.clamp(score, 0, 100);
}

/** Pure price — no broker dependency, portable to any market. */
function f4_momentum(prices) {
  if (!prices || prices.length < 6) return 50;
  const roc5 = stats.roc(prices, 5);
  const roc3 = stats.roc(prices, Math.min(3, prices.length - 1));
  const combined = roc5 * 0.6 + roc3 * 0.4;

  let score = 50 + combined * 5;

  if (prices.length >= 15) {
    const rsiVal = stats.rsi(prices, 14);
    if (rsiVal < 30 && combined > 0) score += 8;  // oversold bounce
    if (rsiVal > 70 && combined < 0) score -= 8;  // overbought drop (was += — sign bug, fixed)
    if (rsiVal < 30 && combined < 0) score -= 5;  // still falling in oversold
    if (rsiVal > 70 && combined > 0) score -= 5;  // still rising in overbought
  }

  return stats.clamp(score, 0, 100);
}

/**
 * Pure price + cross-sectional market average — no broker dependency.
 * CONTRACT: both args must be percentage POINTS (3.2 for +3.2%), not decimal
 * fractions (0.032) — sigmoid(0.032 * 0.8) barely moves off 50, so a caller
 * accidentally passing a decimal silently neuters this factor.
 */
function f5_relStrength(stockChangePct, marketAvgChangePct) {
  const excess = stockChangePct - marketAvgChangePct;
  return stats.clamp(stats.sigmoid(excess, 0.8), 0, 100);
}

/** Broker-dependent — needs today's net-buyer/net-seller broker counts. */
function f6_breadth(numBuyers, numSellers) {
  const total = numBuyers + numSellers;
  if (total === 0) return 50;
  const pct = (numBuyers / total) * 100;

  let countBonus = 0;
  if (total >= 15) countBonus = 5;
  if (total >= 25) countBonus = 8;

  // Fixed: was `pct > 50 ? 1 : -1`, which made an exact 50:50 split resolve
  // to -1 (bearish). Math.sign is 0 at the tie, so the bonus vanishes
  // instead of injecting a false direction.
  const direction = Math.sign(pct - 50);
  return stats.clamp(pct + countBonus * direction, 0, 100);
}

/** Broker-dependent — needs today's price change % and concentration (dn0). */
function f7_alignment(priceChangePct, dn0) {
  if (dn0 === null || dn0 === undefined) return 50;

  const priceIntensity = Math.min(Math.abs(priceChangePct), 5) / 5; // 0-1
  // Recalibrated cap from 8 to 40 — real dn0 averages ~12 and legitimately
  // reaches 40-90+ on strong days; capping at 8 meant almost any nonzero
  // concentration already maxed this out.
  const brokerIntensity = Math.min(Math.abs(dn0), 40) / 40; // 0-1
  const alignmentStrength = priceIntensity * brokerIntensity;

  // Fixed: previously "sameDirection" (both positive OR both negative) was
  // a single branch that always scored HIGH (bullish), so a falling stock
  // with heavy broker selling — genuine bearish confirmation — scored as
  // bullish as a rising stock with heavy buying. Now split into four
  // explicit, correctly-signed cases.
  if (priceChangePct > 0 && dn0 > 0) {
    return stats.clamp(50 + alignmentStrength * 45, 50, 95);   // bullish confirmation
  }
  if (priceChangePct < 0 && dn0 < 0) {
    return stats.clamp(50 - alignmentStrength * 45, 5, 50);    // bearish confirmation
  }
  if (priceChangePct < 0 && dn0 > 0.5) {
    // Stealth accumulation — broker buying on dip
    return stats.clamp(55 + brokerIntensity * 15, 50, 72);
  }
  if (priceChangePct > 0 && dn0 < -0.5) {
    // Distribution into strength — broker selling while price rises
    return stats.clamp(45 - brokerIntensity * 15, 28, 50);
  }
  return 50;
}

/** Broker-dependent — needs 5-day concentration history (dn0..dn4). */
function f8_streak(dnValues) {
  if (!dnValues || dnValues.length === 0) return 50;
  if (dnValues.every(v => v === null || v === undefined)) return 50;

  // runToGap, not stats.streak over the compacted array: a run ends at the first
  // session we did not observe. If the most recent session is itself unobserved
  // there is no current streak to report at all.
  const posStreak = runToGap(dnValues, true);
  const negStreak = runToGap(dnValues, false);

  let accelBonus = 0;
  if (posStreak >= 2) {
    const streakVals = dnValues.slice(dnValues.length - posStreak);
    const increasing = streakVals.every((v, i) => i === 0 || v >= streakVals[i - 1] * 0.9);
    if (increasing) accelBonus = 5;
  }
  if (negStreak >= 2) {
    const streakVals = dnValues.slice(dnValues.length - negStreak);
    const deepening = streakVals.every((v, i) => i === 0 || v <= streakVals[i - 1] * 0.9);
    if (deepening) accelBonus = -5;
  }

  if (posStreak > 0) {
    return stats.clamp(50 + posStreak * 10 + accelBonus, 50, 95);
  }
  if (negStreak > 0) {
    return stats.clamp(50 - negStreak * 10 + accelBonus, 5, 50);
  }
  return 50;
}

/**
 * Risk Modifier — F14 (ATR/volatility) as a RISK multiplier, per
 * "AWO Engine.md" §3.3. ATR measures risk, not direction: "low volatility =
 * bullish, high volatility = bearish" (the old flat weighted-sum treatment)
 * is a category error. Low volatility means normal risk (near-full effect,
 * →1.0); high volatility means reduced trust in position sizing (pulled
 * toward 0.5) — a statement about RISK, not a new directional opinion.
 *
 * Added 2026-07-28 as `applyVolatilityConfidence` (a single multiplier that
 * conflated this with Confidence below); split into its own function
 * 2026-07-29 once Confidence got a real, independent input (factorCoverage).
 *
 * @param {number} f14Score - the f14 (ATR) score, 0-100, high = low volatility
 * @returns {number} 0.5 (max volatility) .. 1.0 (min volatility)
 */
function computeRiskModifier(f14Score) {
  const f14 = Number.isFinite(f14Score) ? Math.max(0, Math.min(100, f14Score)) : 50;
  return 0.5 + (f14 / 100) * 0.5;
}

/**
 * Confidence — per "AWO Engine.md" §3.2: "how strong and consistent is the
 * evidence?" Added 2026-07-29, driven by factorCoverage (see
 * weightedComposite): a composite built from fewer available factors is
 * inherently less trustworthy than one built from all of them, in direct
 * proportion to the weight actually missing.
 *
 * Callers that don't have a coverage concept yet (US stocks, IHSG, S&P 500 —
 * no broker-optional factors to begin with, always full weight) pass
 * `undefined` and get full confidence (1.0) — an honest "no coverage signal
 * exists here," not a hack, and not a behavior change for those call sites.
 *
 * @param {number|undefined} factorCoverage - 0-1, from weightedComposite; undefined if N/A
 * @returns {number} 0-1
 */
function computeConfidence(factorCoverage) {
  if (!Number.isFinite(factorCoverage)) return 1;
  return Math.max(0, Math.min(1, factorCoverage));
}

/**
 * Final Score, per "AWO Engine.md" §3.4:
 *   Final = 50 + (Directional - 50) × Confidence × RiskModifier
 * Replaces the old single-multiplier applyVolatilityConfidence — Confidence
 * (how much evidence do we have) and Risk Modifier (how volatile/risky is
 * it right now) are independent questions with independent answers; only
 * their PRODUCT belonged in one number, not the concepts themselves.
 *
 * @param {number} rawComposite - 0-100 directional score, computed WITHOUT f14
 * @param {number} confidence - 0-1, from computeConfidence
 * @param {number} riskModifier - 0-1, from computeRiskModifier
 * @returns {number} 0-100, rounded
 */
function combineFinalScore(rawComposite, confidence, riskModifier) {
  const final = 50 + (rawComposite - 50) * confidence * riskModifier;
  return Math.round(Math.max(0, Math.min(100, final)));
}

/**
 * Combines factor scores into one composite WITHOUT silently keeping a
 * missing factor's full weight at a neutral 50 — added 2026-07-29 per
 * "AWO Engine.md" P1-06 (Missing Factor Handling). Previously, when a
 * ticker had no broker/concentration data for the day, f1/f2/f6/f7/f8
 * still defaulted to a neutral score but kept their FULL weight in the
 * average, silently diluting the composite toward 50 instead of being
 * excluded and having the remaining available factors' weights
 * renormalized up — exactly what the spec warns against.
 *
 * @param {Object} scores - { f1: number, ... } 0-100 each, all keys in weights must be present
 * @param {Object} weights - { f1: number, ... } same keys as scores
 * @param {Object} availability - { f1: boolean, ... } false = this factor's score is a
 *   placeholder (no real data), so exclude it from both numerator and weight sum
 * @returns {{composite: number, factorCoverage: number, missingFactors: string[]}}
 */
function weightedComposite(scores, weights, availability) {
  let numerator = 0, availableWeight = 0, totalWeight = 0;
  const missingFactors = [];
  for (const key of Object.keys(weights)) {
    const w = weights[key] || 0;
    totalWeight += w;
    if (availability[key] === false) { missingFactors.push(key); continue; }
    numerator += (scores[key] ?? 50) * w;
    availableWeight += w;
  }
  return {
    composite: availableWeight > 0 ? numerator / availableWeight : 50,
    factorCoverage: totalWeight > 0 ? availableWeight / totalWeight : 0,
    missingFactors,
  };
}

module.exports = {
  f1_concentration, f2_trend, f3_volumeZ, f4_momentum,
  f5_relStrength, f6_breadth, f7_alignment, f8_streak,
  weightedComposite, computeConfidence, computeRiskModifier, combineFinalScore,
};
