/**
 * AWO Technical Analysis Module
 * 
 * Calculates technical indicators from OHLCV price data
 * and converts them into 0-100 factor scores for the AWO system.
 * 
 * Factors:
 *   f9  — RSI Zone (overbought/oversold awareness)
 *   f10 — MACD Signal (trend direction + momentum)
 *   f11 — Bollinger Position (mean reversion + volatility)
 *   f12 — EMA Trend (short-term trend direction)
 *   f13 — Support/Resistance proximity
 *   f14 — ATR Volatility regime
 */

'use strict';

const tradePolicy = require('./modules/trade_policy');

// ─── Core Indicator Calculations ──────────────────────────────────

/**
 * Simple Moving Average
 */
function sma(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

/**
 * Exponential Moving Average
 */
function ema(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let e = sma(arr.slice(0, period), period);
  for (let i = period; i < arr.length; i++) {
    e = arr[i] * k + e * (1 - k);
  }
  return e;
}

/**
 * How much of an EMA is still its SEED after `bars` observations?
 *
 * An EMA is path-dependent: it is seeded with an SMA of the first `period` bars
 * and then decays that seed by (1 - 2/(period+1)) per bar. Feed it a short
 * window and the answer is mostly the seed -- a number from the start of the
 * window, barely updated -- while still being printed as though it were an EMA.
 *
 * Nothing errors. The value comes out, looks plausible, and is wrong:
 *
 *     EMA(200) on 210 bars -> 90.5% seed
 *     EMA(200) on 280 bars -> 44.9% seed
 *     EMA(200) on 600 bars ->  1.8% seed
 *     EMA(50)  on  60 bars -> 67.0% seed
 *
 * Measured on IHSG, the 280-bar window this project used gave an EMA200 0.95%
 * away from the full-history value, and flipped detectPriceRegime's label on 16
 * of 1,830 sessions -- clustered at trend transitions, which is exactly where a
 * regime label is read.
 *
 * The short periods are fine and always were: EMA(8) on 60 bars leaves under
 * 0.01% seed, so our EMA(8) and a charting platform's are the same number. This
 * is a guard against LONG periods on short windows, not a correction to the
 * indicators already in use.
 */
function emaSeedWeight(period, bars) {
  if (!(period > 0) || !(bars > 0)) return 1;
  if (bars <= period) return 1;
  return Math.pow(1 - 2 / (period + 1), bars - period);
}

/**
 * The fewest bars an EMA(period) needs before its seed is worth less than `tol`.
 *
 * Derived rather than tabulated, so it stays correct if a period is changed:
 *   (1 - 2/(p+1))^(n-p) < tol   ->   n > p + ln(tol) / ln(1 - 2/(p+1))
 *
 * @param {number} period
 * @param {number} [tol=0.02] acceptable residual seed weight, 0..1
 */
function emaMinBars(period, tol = 0.02) {
  if (!(period > 0)) return 0;
  const decay = 1 - 2 / (period + 1);
  if (decay <= 0) return period;
  return period + Math.ceil(Math.log(tol) / Math.log(decay));
}

/**
 * RSI (Relative Strength Index)
 * @returns {number|null} RSI value 0-100
 */
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  
  let avgGain = 0, avgLoss = 0;
  
  // Initial average
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;
  
  // Smooth with Wilder's method
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
    }
  }
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Full EMA series (one value per input index, null before `period` bars
 * exist) — unlike `ema()` above, which only returns the final value.
 * Needed by calcMACD so fast/slow EMA are advanced in lockstep, one bar at a
 * time, rather than each being separately "fast-forwarded" from its own seed
 * (see calcMACD's fix note — that's exactly the bug this replaces).
 */
function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const result = new Array(values.length).fill(null);
  if (values.length < period) return result;
  let e = sma(values.slice(0, period), period);
  result[period - 1] = e;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    result[i] = e;
  }
  return result;
}

/**
 * MACD (Moving Average Convergence Divergence)
 *
 * Fixed 2026-07-30 (external review): the previous implementation seeded the
 * fast EMA "as of" bar `fast-1`, then jumped the loop straight to bar `slow`
 * without recursively advancing it through bars `fast..slow-1` — a real
 * misalignment, not just imprecision. Traced numerically on synthetic data:
 * it produced an outright SIGN FLIP at bar 26 (buggy macd=-2.02 vs correct
 * +2.04), which would have flipped golden/death-cross detection and thus
 * scoreMACD's BUY/SELL read. Fixed by building full, independently-correct
 * EMA series for fast and slow, then taking their difference at each aligned
 * index — no recursion-count mismatch possible this way.
 *
 * @returns {{ macd: number, signal: number, histogram: number }|null}
 */
function calcMACD(closes, fast = 12, slow = 26, sig = 9) {
  if (closes.length < slow + sig) return null;

  const fastSeries = emaSeries(closes, fast);
  const slowSeries = emaSeries(closes, slow);

  const macdHistory = [];
  for (let i = slow - 1; i < closes.length; i++) {
    if (fastSeries[i] == null || slowSeries[i] == null) continue;
    macdHistory.push(fastSeries[i] - slowSeries[i]);
  }

  if (macdHistory.length < sig) return null;

  const macdLine = macdHistory[macdHistory.length - 1];
  const signalLine = ema(macdHistory, sig);
  if (signalLine === null) return null;

  return {
    macd: macdLine,
    signal: signalLine,
    histogram: macdLine - signalLine,
  };
}

/**
 * Bollinger Bands
 * @returns {{ upper: number, middle: number, lower: number, width: number, pctB: number }|null}
 */
function calcBollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  
  const slice = closes.slice(-period);
  const middle = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + Math.pow(v - middle, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  
  const upper = middle + mult * stdDev;
  const lower = middle - mult * stdDev;
  const width = upper - lower;
  const currentPrice = closes[closes.length - 1];
  const pctB = width > 0 ? (currentPrice - lower) / width : 0.5;
  
  return { upper, middle, lower, width, pctB };
}

/**
 * ATR (Average True Range)
 * @returns {number|null}
 */
function calcATR(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return null;
  
  const trueRanges = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);
  }
  
  if (trueRanges.length < period) return null;
  
  // Wilder smoothing
  let atr = trueRanges.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  
  return atr;
}

/**
 * Find support and resistance levels using pivot points
 * @returns {{ support: number[], resistance: number[] }}
 */
function calcSupportResistance(highs, lows, closes, lookback = 20) {
  if (highs.length < lookback) return { support: [], resistance: [] };
  
  const recentHighs = highs.slice(-lookback);
  const recentLows = lows.slice(-lookback);
  
  // Find local maxima (resistance) and minima (support)
  const resistance = [];
  const support = [];
  
  for (let i = 2; i < recentHighs.length - 2; i++) {
    if (recentHighs[i] > recentHighs[i-1] && recentHighs[i] > recentHighs[i-2] &&
        recentHighs[i] > recentHighs[i+1] && recentHighs[i] > recentHighs[i+2]) {
      resistance.push(recentHighs[i]);
    }
    if (recentLows[i] < recentLows[i-1] && recentLows[i] < recentLows[i-2] &&
        recentLows[i] < recentLows[i+1] && recentLows[i] < recentLows[i+2]) {
      support.push(recentLows[i]);
    }
  }
  
  // Add simple levels: recent high, recent low, SMA 20
  const sma20 = sma(closes, Math.min(20, closes.length));
  
  return {
    support: support.length > 0 ? support : [Math.min(...recentLows)],
    resistance: resistance.length > 0 ? resistance : [Math.max(...recentHighs)],
    sma20,
  };
}

// ─── Factor Score Conversions (0-100) ─────────────────────────────

/**
 * f9: RSI Zone Score
 * 
 * For BUY signals: oversold = good (high score), overbought = bad (low score)
 * The score represents "room to go up"
 * 
 * RSI < 30: Score 90-100 (oversold, bounce expected)
 * RSI 30-45: Score 70-85 (not overbought yet, room to run)
 * RSI 45-55: Score 50-60 (neutral)
 * RSI 55-70: Score 30-45 (getting extended)
 * RSI > 70: Score 5-25 (overbought, risky to buy)
 */
/**
 * @param {string|null} trendDirection - 'BULLISH'|'BEARISH'|'NEUTRAL', derived
 *   from EMA9/EMA21 separation. Pure mean-reversion RSI scoring has a known
 *   pitfall (Schwab's own RSI education makes this point): overbought can
 *   persist a long time in a genuine uptrend without reversing, so punishing
 *   RSI>55 the same amount regardless of trend context over-penalizes strong
 *   trending stocks. This softens (not removes) the penalty/reward when the
 *   stock is already in a confirmed trend — blends 40% of the way toward a
 *   mild-not-harsh read instead of the full contrarian score.
 */
function scoreRSI(rsi, trendDirection) {
  if (rsi === null) return 50;
  let base;
  if (rsi <= 20) base = 100;
  else if (rsi <= 30) base = 85 + (30 - rsi) * 1.5;
  else if (rsi <= 45) base = 65 + (45 - rsi) * 1.3;
  else if (rsi <= 55) base = 50 + (55 - rsi) * 1.5;
  else if (rsi <= 70) base = 30 + (70 - rsi) * 1.3;
  else if (rsi <= 80) base = 15 + (80 - rsi) * 1.5;
  else base = Math.max(0, 15 - (rsi - 80) * 1.5);

  if (trendDirection === 'BULLISH' && rsi > 55) {
    return Math.round(base + (62 - base) * 0.4);
  }
  if (trendDirection === 'BEARISH' && rsi < 45) {
    return Math.round(base + (38 - base) * 0.4);
  }
  return Math.round(base);
}

/**
 * f10: MACD Signal Score
 * 
 * Bullish: MACD > Signal (histogram positive) = high score
 * Bearish: MACD < Signal (histogram negative) = low score
 * Crossover bonus: histogram just turned positive = extra boost
 */
/**
 * @param {number|null} atr - raw ATR(14), used to normalize the histogram so
 *   this score is scale-independent across stocks. A histogram of 0.10 means
 *   something very different for a Rp5,000 stock than a Rp50 one — the old
 *   `histogram * 500` was tuned for one implicit price range and silently
 *   saturated (or barely moved) everywhere else. Falls back to 2% of price
 *   if ATR isn't available yet.
 */
function scoreMACD(macdResult, prevHistogram, atr, currentPrice) {
  if (!macdResult) return 50;

  const { histogram, macd } = macdResult;
  let score = 50;

  const norm = (atr && atr > 0) ? atr : (currentPrice && currentPrice > 0 ? currentPrice * 0.02 : null);
  if (norm) {
    const histNorm = histogram / norm;
    score = 50 + 35 * Math.tanh(histNorm / 0.25);
  } else if (histogram > 0) {
    score = 60 + Math.min(histogram * 500, 35); // legacy fallback — only if neither ATR nor price is known
  } else {
    score = 40 - Math.min(Math.abs(histogram) * 500, 35);
  }

  // Crossover bonus
  if (prevHistogram !== undefined && prevHistogram !== null) {
    if (prevHistogram <= 0 && histogram > 0) {
      score = Math.min(100, score + 15); // Golden cross bonus
    } else if (prevHistogram >= 0 && histogram < 0) {
      score = Math.max(0, score - 15); // Death cross penalty
    }
  }
  
  // MACD above zero line = extra bullish context
  if (macd > 0) score = Math.min(100, score + 5);
  else score = Math.max(0, score - 5);
  
  return Math.round(Math.max(0, Math.min(100, score)));
}

/**
 * f11: Bollinger Position Score
 * 
 * %B near 0 (lower band): Score high (potential bounce)
 * %B near 0.5 (middle): Score medium
 * %B near 1 (upper band): Score low (extended, may pullback)
 * 
 * Also considers band width (squeeze = potential breakout)
 */
function scoreBollinger(bb) {
  if (!bb) return 50;
  
  const { pctB, width, middle } = bb;
  
  // Position score: lower = more room to go up
  let posScore;
  if (pctB <= 0) posScore = 95;          // Below lower band: very oversold
  else if (pctB <= 0.2) posScore = 80 + (0.2 - pctB) * 75;
  else if (pctB <= 0.5) posScore = 50 + (0.5 - pctB) * 100;
  else if (pctB <= 0.8) posScore = 30 + (0.8 - pctB) * 67;
  else if (pctB <= 1.0) posScore = 10 + (1.0 - pctB) * 100;
  else posScore = 5;                      // Above upper band: very overbought
  
  // Squeeze (narrow band) means expansion/breakout is more LIKELY soon — it
  // says nothing about which direction, so it shouldn't inject a bullish
  // bias on its own (the old flat +10/+5 did, even when %B was near the
  // middle with no directional read at all). Instead it amplifies whatever
  // direction %B already leans — raises confidence in the existing read
  // rather than manufacturing a new one.
  const widthPct = middle > 0 ? (width / middle) * 100 : 0;
  let squeezeFactor = 0;
  if (widthPct < 5) squeezeFactor = 0.20;   // Tight squeeze
  else if (widthPct < 8) squeezeFactor = 0.10;
  const squeezeBonus = (posScore - 50) * squeezeFactor;

  return Math.round(Math.max(0, Math.min(100, posScore + squeezeBonus)));
}

/**
 * f12: EMA Trend Score
 * 
 * Price > EMA9 > EMA21 = strong uptrend (high score)
 * Price < EMA9 < EMA21 = strong downtrend (low score)
 * EMA9 crossing above EMA21 = bullish signal
 */
function scoreEMATrend(currentPrice, ema9, ema21, prevEma9, prevEma21) {
  if (ema9 === null || ema21 === null || !currentPrice) return 50;
  
  let score = 50;
  
  // Price position relative to EMAs
  const aboveEma9 = currentPrice > ema9;
  const aboveEma21 = currentPrice > ema21;
  const ema9AboveEma21 = ema9 > ema21;
  
  if (aboveEma9 && aboveEma21 && ema9AboveEma21) {
    // Strong uptrend
    const strength = ((currentPrice - ema21) / ema21) * 100;
    score = 75 + Math.min(strength * 3, 25);
  } else if (aboveEma21 && ema9AboveEma21) {
    // Uptrend with minor pullback
    score = 65;
  } else if (aboveEma21) {
    // Above long-term, mixed short-term
    score = 55;
  } else if (!aboveEma9 && !aboveEma21 && !ema9AboveEma21) {
    // Strong downtrend
    const weakness = ((ema21 - currentPrice) / ema21) * 100;
    score = 25 - Math.min(weakness * 3, 20);
  } else if (!aboveEma21) {
    // Below long-term
    score = 35;
  }
  
  // EMA crossover bonus
  if (prevEma9 !== null && prevEma21 !== null) {
    const wasBearish = prevEma9 <= prevEma21;
    const isBullish = ema9 > ema21;
    if (wasBearish && isBullish) score = Math.min(100, score + 15); // Golden cross
    if (!wasBearish && !isBullish) score = Math.max(0, score - 15); // Death cross
  }
  
  return Math.round(Math.max(0, Math.min(100, score)));
}

/**
 * f13: Support/Resistance Score — risk/reward based.
 *
 * risk = distance down to support, reward = distance up to resistance,
 * score = 100 * RR/(1+RR). Replaces a previous version that returned a flat
 * 85 for anything within 2% of support REGARDLESS of resistance distance —
 * so a stock 1% above support but only 0.2% below resistance (terrible R:R)
 * scored the same "great entry" as one with tons of room to run. This
 * version always weighs both sides, and RR 1:1 lands exactly on neutral 50.
 */
function scoreSR(currentPrice, sr) {
  if (!sr || !currentPrice) return 50;

  const { support, resistance } = sr;

  const nearestSupport = support.length > 0
    ? support.reduce((a, b) => Math.abs(b - currentPrice) < Math.abs(a - currentPrice) ? b : a)
    : null;
  const nearestResistance = resistance.length > 0
    ? resistance.reduce((a, b) => Math.abs(b - currentPrice) < Math.abs(a - currentPrice) ? b : a)
    : null;

  if (!nearestSupport || !nearestResistance) return 50;

  const risk = currentPrice - nearestSupport;
  const reward = nearestResistance - currentPrice;

  if (risk <= 0) return 20;   // price at/below "support" — level already broken, bearish
  if (reward <= 0) return 80; // price at/above "resistance" — already broken out, bullish

  const rr = reward / risk;
  return Math.round(Math.max(0, Math.min(100, (100 * rr) / (1 + rr))));
}

/**
 * f14: ATR Volatility Score
 * 
 * Low volatility (tight range): Higher score (controlled risk)
 * Moderate volatility: Medium score
 * High volatility: Lower score for BUY (wild swings = risky)
 * 
 * ATR as % of price
 */
function scoreATR(atr, currentPrice, historicalATRs) {
  if (atr === null || !currentPrice) return 50;
  
  const atrPct = (atr / currentPrice) * 100;
  
  // Lower volatility = more predictable = better for signal reliability
  if (atrPct <= 1) return 80;      // Very tight, controlled
  if (atrPct <= 2) return 70;      // Normal, healthy
  if (atrPct <= 3) return 55;      // Moderate
  if (atrPct <= 5) return 40;      // Getting volatile
  if (atrPct <= 8) return 25;      // High vol, signals less reliable
  return 10;                        // Extreme volatility
}

// ─── Main Function: Calculate All Technical Factors ───────────────

/**
 * Calculate all technical factors for a stock given OHLCV data
 * 
 * @param {Array} candles - Array of { date, open, high, low, close, volume }
 *                          sorted by date ascending, at least 30 candles needed
 * @returns {{ f9: number, f10: number, f11: number, f12: number, f13: number, f14: number, indicators: object }}
 */
function calcTechnicalFactors(candles) {
  // Fixed 2026-07-31 (external review, round 3, findings #2/#4): this used to
  // short-circuit EVERYTHING (f9-f14, all forced to a fake neutral 50) below
  // 26 candles — but each factor has its own, much smaller real minimum:
  // RSI(14) needs 15, Bollinger(20)/Support-Resistance(20) need 20, ATR(14)
  // needs 15, EMA21 needs 21, only MACD(12,26,9) genuinely needs 35. A stock
  // with, say, 20 days of history got RSI/Bollinger/S-R all silently faked
  // as 50 even though real math was possible — and score_engine.js's single
  // `technicalAvailable = candles.length >= 15` flag then marked all of
  // f9-f13 "available" for the weighted composite regardless, so the fake
  // 50s weren't even excluded, just quietly diluting the composite. Each
  // calcX/scoreX pair below already null-guards independently (calcRSI
  // returns null under 15 bars, scoreRSI returns 50 on null input, etc.) —
  // so removing this blanket gate and letting each indicator hit its own
  // real minimum is enough; `factorAvailable` below reports which ones
  // actually got real data this call, for score_engine.js to use per-factor
  // instead of one shared flag.
  candles = candles || [];
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const currentPrice = closes[closes.length - 1];
  
  // Calculate indicators
  const rsi = calcRSI(closes, 14);
  const macdResult = calcMACD(closes, 12, 26, 9);
  const bb = calcBollinger(closes, 20, 2);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const atr = calcATR(highs, lows, closes, 14);
  const sr = calcSupportResistance(highs, lows, closes, 20);
  
  // Previous values for crossover detection
  const prevCloses = closes.slice(0, -1);
  const prevEma9 = prevCloses.length >= 9 ? ema(prevCloses, 9) : null;
  const prevEma21 = prevCloses.length >= 21 ? ema(prevCloses, 21) : null;
  
  // Previous MACD histogram for crossover
  let prevHistogram = null;
  if (prevCloses.length >= 35) {
    const prevMACD = calcMACD(prevCloses, 12, 26, 9);
    if (prevMACD) prevHistogram = prevMACD.histogram;
  }

  // Trend regime for F9's context-aware RSI scoring — same EMA9/EMA21
  // separation-with-deadband idea as computeWeeklyTrend, just on the daily
  // series computed here rather than a weekly resample.
  let trendDirection = 'NEUTRAL';
  if (ema9 !== null && ema21 !== null && ema21 !== 0) {
    const sep = Math.abs(ema9 - ema21) / Math.abs(ema21);
    if (sep > 0.01) trendDirection = ema9 > ema21 ? 'BULLISH' : 'BEARISH';
  }

  // Score each factor
  const f9 = scoreRSI(rsi, trendDirection);
  const f10 = scoreMACD(macdResult, prevHistogram, atr, currentPrice);
  const f11 = scoreBollinger(bb);
  const f12 = scoreEMATrend(currentPrice, ema9, ema21, prevEma9, prevEma21);
  const f13 = scoreSR(currentPrice, sr);
  const f14 = scoreATR(atr, currentPrice);
  
  // Mirrors each scoreX() function's own null-guard exactly (see comment
  // above calcTechnicalFactors) — this is what actually happened this call,
  // not a candle-count guess. f13 needs BOTH a support and a resistance
  // level, same condition scoreSR uses internally to decide whether it has
  // a real nearestSupport/nearestResistance pair to work with.
  const srHasBothLevels = !!(sr && sr.support.length > 0 && sr.resistance.length > 0);

  // f12 compares EMA9 against EMA21, and an EMA carries its SMA seed forward.
  // At the 60 candles every caller passes, EMA9 keeps under 0.01% seed and
  // EMA21 about 2.4% -- both fine, and this guard changes nothing today. It
  // exists for the change that comes later: swap 21 for 50 without widening the
  // window and the seed is 67%, the number still prints, and nothing complains.
  // That is not a hypothetical -- it is what detectPriceRegime did with EMA200
  // on 280 bars until it was measured.
  const emaSeedOk = closes.length >= emaMinBars(21, 0.05) && closes.length >= emaMinBars(9, 0.05);

  const factorAvailable = {
    f9: rsi !== null,
    f10: !!macdResult,
    f11: !!bb,
    f12: ema9 !== null && ema21 !== null && emaSeedOk,
    f13: srHasBothLevels,
    f14: atr !== null,
  };

  return {
    f9, f10, f11, f12, f13, f14,
    factorAvailable,
    indicators: {
      rsi: rsi !== null ? Math.round(rsi * 100) / 100 : null,
      macd: macdResult ? {
        macd: Math.round(macdResult.macd * 100) / 100,
        signal: Math.round(macdResult.signal * 100) / 100,
        histogram: Math.round(macdResult.histogram * 100) / 100,
      } : null,
      bb: bb ? {
        upper: Math.round(bb.upper * 100) / 100,
        middle: Math.round(bb.middle * 100) / 100,
        lower: Math.round(bb.lower * 100) / 100,
        pctB: Math.round(bb.pctB * 1000) / 1000,
      } : null,
      ema9: ema9 !== null ? Math.round(ema9 * 100) / 100 : null,
      ema21: ema21 !== null ? Math.round(ema21 * 100) / 100 : null,
      atr: atr !== null ? Math.round(atr * 100) / 100 : null,
      sr: sr && (sr.support.length || sr.resistance.length) ? {
        support: sr.support.map(v => Math.round(v * 100) / 100),
        resistance: sr.resistance.map(v => Math.round(v * 100) / 100),
      } : null,
    },
  };
}

// ─── Batch Processing Helper ──────────────────────────────────────

/**
 * Calculate technical factors for multiple stocks using DB pool
 * 
 * @param {object} pool - MySQL connection pool
 * @param {string[]} tickers - List of stock codes
 * @param {string} asOfDate - Date to calculate as-of (YYYY-MM-DD)
 * @param {number} lookback - Number of days of history to use
 * @returns {Object<string, { f9-f14, indicators }>}
 */
async function calcTechnicalBatch(pool, tickers, asOfDate, lookback = 60) {
  const results = {};
  
  // Load OHLCV for all tickers in one query
  const [rows] = await pool.query(
    `SELECT stock_code, date, open_price, high_price, low_price, close_price, volume
     FROM idx_stock_prices
     WHERE stock_code IN (?) AND date <= ?
     ORDER BY stock_code, date`,
    [tickers, asOfDate]
  );
  
  // Group by ticker
  const byTicker = {};
  for (const r of rows) {
    if (!byTicker[r.stock_code]) byTicker[r.stock_code] = [];
    byTicker[r.stock_code].push({
      date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date),
      open: parseFloat(r.open_price),
      high: parseFloat(r.high_price),
      low: parseFloat(r.low_price),
      close: parseFloat(r.close_price),
      volume: parseInt(r.volume) || 0,
    });
  }
  
  // Calculate for each ticker — always routed through calcTechnicalFactors
  // (fixed 2026-07-31, external review round 3, findings #2/#4) rather than
  // this loop keeping its own separate "too little data" shortcut; two
  // independent blanket-50 gates (this one at <10, the other formerly at
  // <26) is exactly how the per-indicator minimums got lost in the first
  // place. calcTechnicalFactors is safe on `undefined`/short/empty candle
  // arrays on its own — nothing below is computable under 10 candles anyway
  // (RSI, the cheapest indicator, needs 15), so this is a no-op for real
  // results, just a single code path instead of two.
  for (const ticker of tickers) {
    const candles = byTicker[ticker];
    const recent = candles ? candles.slice(-lookback) : [];
    results[ticker] = calcTechnicalFactors(recent);
  }
  
  return results;
}

/**
 * Derive an entry/stop-loss/target trade plan for a directional signal.
 *
 * Stop-loss is volatility-based (ATR), which is a position-sizing/risk-sizing
 * technique — distinct from (and unaffected by) whether RSI/Bollinger/S-R are
 * good predictive *scoring* factors. If a support/resistance level sits in a
 * sane band around the ATR-based level, the stop/target snaps to that level
 * instead (technically-grounded placement beats a pure volatility guess).
 * Falls back to a fixed 3% risk unit when ATR/candle history is unavailable.
 *
 * Geometry (risk unit as a multiple of ATR, target multiples in R) comes from
 * modules/trade_policy.js so the plan matches the horizon the system is
 * actually traded on — see that module for why these knobs must move together.
 * Pass `opts` to override per call; backtests use this to sweep the horizon.
 *
 * @param {number} currentPrice
 * @param {'STRONG BUY'|'BUY'|'SELL'|'STRONG SELL'} signal - WATCH/NEUTRAL should not be passed in
 * @param {number|null} atr - raw ATR(14) value (price units, not the 0-100 score)
 * @param {{support:number[], resistance:number[]}|null} sr
 * @param {{riskAtrMult?:number, fallbackRiskPct?:number, target1R?:number, target2R?:number, targetSnapCeilingR?:number}} [opts]
 * @returns {{entry:number, stopLoss:number, target1:number, target2:number, riskReward:number}|null}
 */
function computeTradePlan(currentPrice, signal, atr, sr, opts) {
  const policy = tradePolicy.resolve(opts);
  if (!currentPrice || currentPrice <= 0) return null;
  // WATCH sits at composite score 53-62 (always above the 50 neutral midpoint
  // per classifySignal's thresholds), i.e. it's already bullish-leaning by
  // construction — just not strong enough to be a full BUY. Treat it the same
  // direction as BUY so watchlist candidates can still get a (speculative)
  // trade plan and be saved to the journal, instead of silently having none.
  const isBullish = signal === 'STRONG BUY' || signal === 'BUY' || signal === 'WATCH';
  const isBearish = signal === 'SELL' || signal === 'STRONG SELL';
  if (!isBullish && !isBearish) return null;

  const riskUnit = atr && atr > 0
    ? atr * policy.riskAtrMult
    : currentPrice * (policy.fallbackRiskPct / 100);
  const dir = isBullish ? 1 : -1;

  let stopLoss = currentPrice - dir * riskUnit;

  // Snap stop to the nearest support (bullish) / resistance (bearish) if one
  // sits in a sane band (0.5x-3x the raw risk unit away) — a real level beats
  // an arbitrary volatility guess.
  const snapLevels = isBullish ? (sr?.support || []) : (sr?.resistance || []);
  const candidateSnap = snapLevels
    .filter(lvl => dir * (currentPrice - lvl) > 0) // must be on the risk side of price
    .filter(lvl => {
      const dist = Math.abs(currentPrice - lvl);
      return dist >= riskUnit * 0.5 && dist <= riskUnit * 3;
    })
    .sort((a, b) => Math.abs(currentPrice - a) - Math.abs(currentPrice - b))[0];
  if (candidateSnap !== undefined) {
    stopLoss = candidateSnap - dir * (riskUnit * 0.2); // small buffer beyond the level
  }

  const actualRisk = Math.abs(currentPrice - stopLoss);
  let target1 = currentPrice + dir * actualRisk * policy.target1R;
  let target2 = currentPrice + dir * actualRisk * policy.target2R;

  // Snap target2 to the nearest resistance (bullish) / support (bearish) if
  // one sits between target1 and a reasonable ceiling (targetSnapCeilingR).
  const targetSnapLevels = isBullish ? (sr?.resistance || []) : (sr?.support || []);
  const candidateTarget = targetSnapLevels
    .filter(lvl => dir * (lvl - currentPrice) > 0)
    .filter(lvl => {
      const dist = Math.abs(lvl - currentPrice);
      return dist >= actualRisk * policy.target1R && dist <= actualRisk * policy.targetSnapCeilingR;
    })
    .sort((a, b) => Math.abs(a - currentPrice) - Math.abs(b - currentPrice))[0];
  if (candidateTarget !== undefined) {
    target2 = candidateTarget;
  }

  const round2 = v => Math.round(v * 100) / 100;
  return {
    entry: round2(currentPrice),
    stopLoss: round2(stopLoss),
    target1: round2(target1),
    target2: round2(target2),
    riskReward: actualRisk > 0 ? round2(Math.abs(target2 - currentPrice) / actualRisk) : null,
  };
}

/**
 * Aggregate daily OHLCV candles into weekly candles (Mon-Sun buckets), so the same
 * price series can be re-examined on a higher timeframe without a second data
 * source — just a resample of history we already have.
 *
 * @param {{date:string, open:number, high:number, low:number, close:number, volume:number}[]} dailyCandles - oldest first
 * @returns {{date:string, open:number, high:number, low:number, close:number, volume:number}[]} oldest first
 */
function aggregateWeekly(dailyCandles) {
  if (!dailyCandles || dailyCandles.length === 0) return [];
  const weekKey = dateStr => {
    const d = new Date(dateStr + 'T00:00:00Z');
    const day = d.getUTCDay(); // 0=Sun..6=Sat
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() + mondayOffset);
    return monday.toISOString().slice(0, 10);
  };

  const buckets = new Map();
  for (const c of dailyCandles) {
    const key = weekKey(c.date);
    if (!buckets.has(key)) {
      buckets.set(key, { date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    } else {
      const b = buckets.get(key);
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close; // candles arrive oldest-first, so last write wins = latest close
      b.date = c.date;
      b.volume += c.volume;
    }
  }
  return Array.from(buckets.values());
}

/**
 * Top-down trend context: aggregate to weekly candles and classify the weekly
 * trend via EMA9/EMA21 (same construct as the daily f12 EMA-trend factor, just on
 * a higher timeframe). This is deliberately NOT folded into the composite score —
 * it's surfaced as separate context so a directional signal that fights the weekly
 * trend can be flagged rather than silently re-scored on an unvalidated assumption.
 *
 * @param {{date:string, open:number, high:number, low:number, close:number, volume:number}[]} dailyCandles - oldest first, ideally 1+ year for a stable EMA21
 * @returns {{trend:'BULLISH'|'BEARISH'|'NEUTRAL', weeklyClose:number|null, weeklyEma9:number|null, weeklyEma21:number|null, weeksAvailable:number}}
 */
function computeWeeklyTrend(dailyCandles) {
  const weekly = aggregateWeekly(dailyCandles);
  if (weekly.length < 21) {
    return { trend: 'NEUTRAL', weeklyClose: null, weeklyEma9: null, weeklyEma21: null, weeksAvailable: weekly.length };
  }
  const closes = weekly.map(w => w.close);
  const weeklyClose = closes[closes.length - 1];
  const weeklyEma9 = ema(closes, 9);
  const weeklyEma21 = ema(closes, 21);

  // Deadband: require the EMAs to actually separate meaningfully (>0.5% of price)
  // before calling a trend — a razor-thin, noise-level EMA9/EMA21 gap isn't a
  // confirmed trend, it's a flat/choppy market that should read as NEUTRAL.
  const emaSeparationPct = weeklyEma21 !== 0 ? Math.abs(weeklyEma9 - weeklyEma21) / Math.abs(weeklyEma21) : 0;
  let trend = 'NEUTRAL';
  if (emaSeparationPct > 0.005) {
    if (weeklyEma9 > weeklyEma21 && weeklyClose > weeklyEma21) trend = 'BULLISH';
    else if (weeklyEma9 < weeklyEma21 && weeklyClose < weeklyEma21) trend = 'BEARISH';
  }

  return {
    trend,
    weeklyClose: Math.round(weeklyClose * 100) / 100,
    weeklyEma9: Math.round(weeklyEma9 * 100) / 100,
    weeklyEma21: Math.round(weeklyEma21 * 100) / 100,
    weeksAvailable: weekly.length,
  };
}

module.exports = {
  emaSeedWeight,
  emaMinBars,
  calcRSI,
  calcMACD,
  calcBollinger,
  calcATR,
  calcSupportResistance,
  calcTechnicalFactors,
  calcTechnicalBatch,
  computeTradePlan,
  aggregateWeekly,
  computeWeeklyTrend,
  scoreRSI,
  scoreMACD,
  scoreBollinger,
  scoreEMATrend,
  scoreSR,
  scoreATR,
  sma,
  ema,
  emaSeries,
};
