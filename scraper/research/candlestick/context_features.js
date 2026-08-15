/**
 * Context features for EXP-028C — trend, location, volatility, volume.
 *
 * EVERY FEATURE HERE IS STRICTLY PRIOR TO THE PATTERN BAR.
 *
 * The review states the rule and then states it again for the case most likely
 * to be got wrong: "High/low harus i-20 ... i-1, bukan inclusive entry" and
 * "High-distance semantics harus strictly prior saat dipakai sebagai pre-entry
 * setup metric; jangan memasukkan entry bar kalau labelnya 'distance from prior
 * high'." A name that gaps to a new high on the pattern bar would otherwise set
 * its own reference and read as "at its high" by construction — the metric would
 * be measuring the pattern instead of the situation the pattern appeared in.
 *
 * This is the same defect `modules/breakout.js` exists to prevent on the outcome
 * side, arriving from the other direction.
 *
 * ONE DELIBERATE DEVIATION FROM CONVENTION, stated rather than buried. The
 * moving averages are computed over i-N .. i-1, EXCLUDING the pattern bar,
 * because the spec files them under "Location / Strictly prior". A conventional
 * MA20 includes today. The difference is one bar and it is not a lookahead
 * question either way — including today's close is not future information — but
 * consistency with the stated contract matters more than matching convention,
 * and a reader comparing these numbers to a charting package should know.
 *
 * Distances are measured FROM the pattern bar's close TO a strictly-prior
 * reference. That is the only place the pattern bar enters.
 */
'use strict';

const TREND_BUCKETS = Object.freeze(['DOWN', 'FLAT', 'UP']);
const TREND_THRESHOLD_PCT = 3;      // same bar as the taxonomy's own trend rule

/** Mean of closes over [i-n, i-1]. Null unless the whole window is real. */
function priorMean(close, i, n) {
  if (i - n < 0) return null;
  let s = 0;
  for (let k = i - n; k <= i - 1; k++) {
    const v = close[k];
    if (!Number.isFinite(v) || !(v > 0)) return null;
    s += v;
  }
  return s / n;
}

/** Highest high over [i-n, i-1]; null if any session in the window is missing. */
function priorHigh(high, i, n) {
  if (i - n < 0) return null;
  let m = -Infinity;
  for (let k = i - n; k <= i - 1; k++) {
    const v = high[k];
    if (!Number.isFinite(v) || !(v > 0)) return null;
    if (v > m) m = v;
  }
  return m === -Infinity ? null : m;
}

/** Lowest low over [i-n, i-1]. */
function priorLow(low, i, n) {
  if (i - n < 0) return null;
  let m = Infinity;
  for (let k = i - n; k <= i - 1; k++) {
    const v = low[k];
    if (!Number.isFinite(v) || !(v > 0)) return null;
    if (v < m) m = v;
  }
  return m === Infinity ? null : m;
}

/** Return over the n sessions ending at i-1, i.e. close[i-1] vs close[i-1-n]. */
function priorReturnPct(close, i, n) {
  const a = close[i - 1 - n], b = close[i - 1];
  if (!Number.isFinite(a) || !Number.isFinite(b) || !(a > 0) || !(b > 0)) return null;
  return (b / a - 1) * 100;
}

function trendBucket(pct) {
  if (pct === null) return null;
  if (pct >= TREND_THRESHOLD_PCT) return 'UP';
  if (pct <= -TREND_THRESHOLD_PCT) return 'DOWN';
  return 'FLAT';
}

/** ATR over [i-period, i-1] — strictly prior, unlike the outcome-side ATR. */
function priorAtr(high, low, close, i, period = 14) {
  if (i - period - 1 < 0) return null;
  let s = 0;
  for (let k = i - period; k <= i - 1; k++) {
    const h = high[k], l = low[k], pc = close[k - 1];
    if (![h, l, pc].every(Number.isFinite)) return null;
    s += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return s / period;
}

/**
 * Percentile rank of the current prior-ATR within its own trailing history.
 * Compares the strictly-prior ATR at i against the same statistic computed at
 * each of the previous `window` sessions, so the reference distribution is also
 * strictly prior.
 */
function priorAtrPercentile(atrSeries, i, window = 252) {
  const cur = atrSeries[i];
  if (!Number.isFinite(cur) || i - window < 0) return null;
  let below = 0, n = 0;
  for (let k = i - window; k <= i - 1; k++) {
    const v = atrSeries[k];
    if (!Number.isFinite(v)) continue;
    n++; if (v <= cur) below++;
  }
  return n >= Math.floor(window / 2) ? below / n : null;
}

/**
 * Volume z-score against the prior 20 sessions. Volume is the one feature where
 * the pattern bar's OWN value is the quantity of interest — "did this candle
 * print on unusual volume" — so the bar's volume is compared against a strictly
 * prior distribution rather than being excluded from itself.
 */
function volumeZ(volume, i, n = 20) {
  if (i - n < 0) return { ratio: null, z: null };
  const v = volume[i];
  if (!Number.isFinite(v)) return { ratio: null, z: null };
  const w = [];
  for (let k = i - n; k <= i - 1; k++) if (Number.isFinite(volume[k])) w.push(volume[k]);
  if (w.length < Math.floor(n / 2)) return { ratio: null, z: null };
  const mean = w.reduce((a, b) => a + b, 0) / w.length;
  if (!(mean > 0)) return { ratio: null, z: null };
  let ss = 0;
  for (const x of w) ss += (x - mean) ** 2;
  const sd = Math.sqrt(ss / Math.max(1, w.length - 1));
  return { ratio: v / mean, z: sd > 0 ? (v - mean) / sd : null };
}

/**
 * All context features for bar i. Arrays are aligned to the canonical session
 * axis, with NaN where the ticker did not trade — a hole makes any window
 * covering it return null rather than silently spanning further back.
 */
function contextAt({ open, high, low, close, volume, atrSeries }, i) {
  const c = close[i];
  const dist = (ref) => (ref === null || !(ref > 0) || !Number.isFinite(c) ? null : (c / ref - 1) * 100);

  const ma20 = priorMean(close, i, 20);
  const ma60 = priorMean(close, i, 60);
  const ph20 = priorHigh(high, i, 20);
  const ph60 = priorHigh(high, i, 60);
  const pl20 = priorLow(low, i, 20);
  const pl60 = priorLow(low, i, 60);
  const r5 = priorReturnPct(close, i, 5);
  const r10 = priorReturnPct(close, i, 10);
  const r20 = priorReturnPct(close, i, 20);
  const vz = volumeZ(volume, i, 20);

  return {
    returnPrev5D: r5, returnPrev10D: r10, returnPrev20D: r20,
    trend5: trendBucket(r5), trend10: trendBucket(r10), trend20: trendBucket(r20),
    distanceMA20: dist(ma20), distanceMA60: dist(ma60),
    distancePrior20DHigh: dist(ph20), distancePrior60DHigh: dist(ph60),
    distancePrior20DLow: dist(pl20), distancePrior60DLow: dist(pl60),
    atr: atrSeries ? atrSeries[i] : null,
    atrPercentile: atrSeries ? priorAtrPercentile(atrSeries, i, 252) : null,
    volumeVs20D: vz.ratio, volumeZScore: vz.z,
  };
}

/** Strictly-prior ATR for every bar, so percentile ranks share one definition. */
function priorAtrSeries(high, low, close, period = 14) {
  const out = new Float64Array(close.length).fill(NaN);
  for (let i = 0; i < close.length; i++) {
    const v = priorAtr(high, low, close, i, period);
    if (v !== null) out[i] = v;
  }
  return out;
}

/**
 * Buckets for the single-factor passes. Kept coarse ON PURPOSE: the review's
 * rule is one context at a time, and fine bucketing is combination research
 * wearing a disguise — twenty thin cells per pattern is curve-fitting whether
 * or not the cells are labelled as one factor.
 */
function bucketise(ctx) {
  const b = {};
  b.TREND = ctx.trend10;                                    // DOWN / FLAT / UP
  b.LOCATION = ctx.distanceMA20 === null ? null
    : ctx.distanceMA20 <= -5 ? 'BELOW_MA20'
      : ctx.distanceMA20 >= 5 ? 'ABOVE_MA20' : 'NEAR_MA20';
  b.VOLUME = ctx.volumeVs20D === null ? null
    : ctx.volumeVs20D >= 2 ? 'HIGH_VOL'
      : ctx.volumeVs20D <= 0.5 ? 'LOW_VOL' : 'NORMAL_VOL';
  b.VOLATILITY = ctx.atrPercentile === null ? null
    : ctx.atrPercentile >= 0.7 ? 'HIGH_ATR'
      : ctx.atrPercentile <= 0.3 ? 'LOW_ATR' : 'MID_ATR';
  return b;
}

module.exports = {
  contextAt, bucketise, priorAtrSeries,
  priorMean, priorHigh, priorLow, priorReturnPct, priorAtr, priorAtrPercentile, volumeZ,
  trendBucket, TREND_BUCKETS, TREND_THRESHOLD_PCT,
};
