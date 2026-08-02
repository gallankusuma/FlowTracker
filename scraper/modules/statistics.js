/**
 * modules/statistics.js
 * Pure math / statistics utility functions for FlowTracker Quantitative Signal Engine
 * Zero external dependencies.
 *
 * Functions:
 *   mean, stdDev, zScore, sma, ema, roc, normalize, sigmoid,
 *   bollingerWidth, correlation, percentile, clamp
 */

'use strict';

// ─── Basic Statistics ─────────────────────────────────────────────────────────

/** Arithmetic mean of an array */
function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/** Standard Deviation (population) */
function stdDev(arr) {
  if (!arr || arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

/**
 * Z-Score: how many standard deviations a value is from the mean
 * Z > 2  = very unusual (top 2.5%)
 * Z > 1  = somewhat unusual (top 16%)
 * Z ≈ 0  = normal
 */
function zScore(value, avg, sd) {
  if (sd === 0 || sd === undefined) return 0;
  return (value - avg) / sd;
}

/**
 * Calculate Z-Score from an array (last value vs rest)
 * Useful for volume anomaly: zScoreFromArray([...volumes])
 */
function zScoreFromArray(arr) {
  if (!arr || arr.length < 3) return 0;
  const latest = arr[arr.length - 1];
  const rest = arr.slice(0, -1);
  return zScore(latest, mean(rest), stdDev(rest));
}

// ─── Moving Averages ──────────────────────────────────────────────────────────

/** Simple Moving Average */
function sma(arr, period) {
  if (!arr || arr.length < period) return arr ? mean(arr) : 0;
  const slice = arr.slice(-period);
  return mean(slice);
}

/** Exponential Moving Average — returns array of EMA values */
function ema(arr, period) {
  if (!arr || arr.length === 0) return [];
  const k = 2 / (period + 1);
  const result = [arr[0]];
  for (let i = 1; i < arr.length; i++) {
    result.push(arr[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

/** Get latest EMA value */
function emaLatest(arr, period) {
  const vals = ema(arr, period);
  return vals.length > 0 ? vals[vals.length - 1] : 0;
}

// ─── Momentum ─────────────────────────────────────────────────────────────────

/**
 * Rate of Change (momentum indicator)
 * ROC = ((current - previous) / previous) * 100
 * @param {number[]} prices - Array of prices (oldest first)
 * @param {number} period - Lookback period
 * @returns {number} ROC percentage
 */
function roc(prices, period = 5) {
  if (!prices || prices.length < period + 1) return 0;
  const current = prices[prices.length - 1];
  const prev = prices[prices.length - 1 - period];
  if (prev === 0) return 0;
  return ((current - prev) / prev) * 100;
}

/**
 * Relative Strength Index (RSI)
 * RSI > 70 = overbought, RSI < 30 = oversold
 */
function rsi(prices, period = 14) {
  if (!prices || prices.length < period + 1) return 50; // neutral default
  
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ─── Normalization & Scaling ──────────────────────────────────────────────────

/** Normalize a value to 0–100 scale given min/max bounds */
function normalize(value, min, max) {
  if (max === min) return 50;
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}

/**
 * Sigmoid smoothing — maps any value to 0–100 with smooth curve
 * Useful for converting raw scores to bounded confidence
 * @param {number} x - input value (centered around 0)
 * @param {number} steepness - controls curve steepness (default 1)
 */
function sigmoid(x, steepness = 1) {
  return 100 / (1 + Math.exp(-steepness * x));
}

/** Clamp value between min and max */
function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

// ─── Bollinger Bands ──────────────────────────────────────────────────────────

/**
 * Bollinger Band Width — measures volatility
 * Narrow width (squeeze) = impending breakout
 * Wide width = high volatility
 * @returns {{ upper, middle, lower, width, percentB }} last bar's BB values
 */
function bollingerBands(prices, period = 20, multiplier = 2) {
  if (!prices || prices.length < period) {
    return { upper: 0, middle: 0, lower: 0, width: 0, percentB: 50 };
  }
  
  const slice = prices.slice(-period);
  const middle = mean(slice);
  const sd = stdDev(slice);
  const upper = middle + multiplier * sd;
  const lower = middle - multiplier * sd;
  const width = middle > 0 ? ((upper - lower) / middle) * 100 : 0;
  const current = prices[prices.length - 1];
  const percentB = (upper - lower) > 0
    ? ((current - lower) / (upper - lower)) * 100
    : 50;
  
  return { upper, middle, lower, width, percentB: clamp(percentB, 0, 100) };
}

// ─── Correlation ──────────────────────────────────────────────────────────────

/**
 * Pearson Correlation Coefficient between two arrays
 * Returns -1 to 1 (1 = perfectly correlated, -1 = inversely correlated)
 */
function correlation(arr1, arr2) {
  const n = Math.min(arr1.length, arr2.length);
  if (n < 3) return 0;
  
  const a = arr1.slice(-n);
  const b = arr2.slice(-n);
  const meanA = mean(a);
  const meanB = mean(b);
  
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const dA = a[i] - meanA;
    const dB = b[i] - meanB;
    num += dA * dB;
    denA += dA * dA;
    denB += dB * dB;
  }
  
  const denom = Math.sqrt(denA * denB);
  return denom === 0 ? 0 : num / denom;
}

// ─── Percentile ───────────────────────────────────────────────────────────────

/**
 * What percentile does `value` fall in within `arr`?
 * Returns 0–100
 */
function percentile(arr, value) {
  if (!arr || arr.length === 0) return 50;
  const below = arr.filter(v => v < value).length;
  return (below / arr.length) * 100;
}

// ─── Significance Testing ─────────────────────────────────────────────────────

/** Standard normal CDF via Abramowitz & Stegun erf approximation */
function normalCDF(z) {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/**
 * One-tailed two-proportion z-test: is p1 (wins1/n1) significantly GREATER than p2 (wins2/n2)?
 * Returns { z, pValue, significant(alpha) } — pValue is the one-tailed probability of
 * observing this large a gap (or larger) by chance if the true win rates were equal.
 */
function twoProportionZTest(wins1, n1, wins2, n2) {
  if (n1 <= 0 || n2 <= 0) return { z: 0, pValue: 1 };
  const p1 = wins1 / n1;
  const p2 = wins2 / n2;
  const pPooled = (wins1 + wins2) / (n1 + n2);
  const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, pValue: 1 };
  const z = (p1 - p2) / se;
  const pValue = 1 - normalCDF(z); // one-tailed: P(p1 > p2 by chance)
  return { z, pValue };
}

// ─── Streak Detection ─────────────────────────────────────────────────────────

/**
 * Count consecutive positive (or negative) values from the end of array
 * @param {number[]} arr - Array of values (e.g. daily net flow)
 * @param {boolean} positive - true = count positive streak, false = negative
 * @returns {number} streak length
 */
function streak(arr, positive = true) {
  if (!arr || arr.length === 0) return 0;
  let count = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (positive ? arr[i] > 0 : arr[i] < 0) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Weighted average — give more weight to recent values
 * Uses linear weighting: last value gets weight N, second-to-last N-1, etc.
 */
function weightedAvg(arr) {
  if (!arr || arr.length === 0) return 0;
  let sumW = 0, sumV = 0;
  for (let i = 0; i < arr.length; i++) {
    const w = i + 1;
    sumV += arr[i] * w;
    sumW += w;
  }
  return sumW > 0 ? sumV / sumW : 0;
}

module.exports = {
  mean, stdDev, zScore, zScoreFromArray,
  sma, ema, emaLatest,
  roc, rsi,
  normalize, sigmoid, clamp,
  bollingerBands,
  correlation,
  percentile,
  streak,
  weightedAvg,
  normalCDF,
  twoProportionZTest,
};
