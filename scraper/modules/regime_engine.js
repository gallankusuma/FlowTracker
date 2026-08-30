/**
 * Price-Action Regime Engine — "AWO Engine.md" §5.
 *
 * Classifies TREND_UP / TREND_DOWN / RANGE / HIGH_VOLATILITY / UNKNOWN from
 * a candle series (works for a single stock's own OHLC or an index's, e.g.
 * IHSG — same math either way), using EMA50/200 + ADX14 + ATR/BB-width
 * percentile per the spec's §5.1-5.2. Added 2026-07-29 as the first
 * post-Sprint-0 slice of AWO Engine.md, per the user's explicit choice to
 * build it as an INFORMATIONAL badge first (not a scoring input, not a
 * signal gate) — the same lesson learned from the Counter-trend hard gate,
 * which got retracted after a fixed-formula re-backtest showed it didn't
 * hold. This regime gets the same treatment: surface it, watch it against
 * real outcomes, only promote it to something that filters/sizes signals
 * once it's been validated.
 *
 * NOT the same thing as `awo_regime.js`'s `detectRegime(pool)` — that one is
 * a MARKET-WIDE regime (TRENDING/RANGING/VOLATILE/DEFAULT) derived from
 * cross-sectional breadth/volume-Z/trend-consistency across all tracked
 * stocks, used for the (currently disabled) regime-specific weight
 * optimizer and stored as `regime_at_signal` in idx_signal_history. This
 * module is a PER-INSTRUMENT price-action regime (a single stock's or
 * IHSG's own EMA/ADX/ATR), a different signal entirely — hence the
 * different name (`detectPriceRegime`) to avoid the two ever being
 * confused at a call site or in an API response.
 *
 * All thresholds live in REGIME_CONFIG (not hard-coded in the branch logic)
 * per the spec's explicit requirement.
 */
'use strict';

const { ema, emaMinBars, emaSeedWeight } = require('../awo_technical');

const REGIME_CONFIG = {
  trendThreshold: 0.01,      // EMA50 must move >1% over emaSlopeLookback days to count as rising/falling
  emaSlopeLookback: 10,      // trading days used to measure EMA50 slope
  adxTrendMin: 20,           // ADX14 >= this required to confirm TREND_UP/TREND_DOWN
  atrHighVolPercentile: 90,  // ATR percentile >= this → HIGH_VOLATILITY, overrides trend check
  percentileLookback: 252,   // trading days of history used to rank current ATR/BB-width
  // DERIVED, not chosen. An EMA is seeded with an SMA and decays that seed by
  // (1 - 2/(p+1)) per bar, so a short window returns mostly the seed while still
  // being printed as an EMA. The old value of 210 left the EMA200 **90.5% seed**,
  // and the 280 the callers actually passed left 44.9%.
  //
  // Measured, not argued: on IHSG that 280-bar EMA200 came out 0.95% away from
  // the full-history value and flipped this function's label on 16 of 1,830
  // sessions -- clustered at trend transitions, which is exactly where a regime
  // label gets read. A 400-bar window already removed every one of those 16.
  //
  // 5% is the tolerance because below it the measured price error falls under
  // 0.1%, finer than the tick grid that could change any decision. Deriving the
  // figure means it follows automatically if the EMA period is ever changed.
  minCandles: emaMinBars(200, 0.05) + 10,   // 501 + slope lookback = 511
};

/**
 * ADX14 (Average Directional Index) — not used by any existing F1-F14 factor
 * score, added specifically for regime classification (trend STRENGTH,
 * distinct from trend DIRECTION which EMA50/200 already cover).
 * @returns {number|null} 0-100, higher = stronger trend (either direction)
 */
function calcADX(highs, lows, closes, period = 14) {
  if (!highs || highs.length < period * 2 + 5) return null;

  const plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < highs.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }

  // Wilder smoothing (cumulative-sum style, standard ADX definition)
  const wilderSmooth = (arr) => {
    const out = [];
    let sum = arr.slice(0, period).reduce((s, v) => s + v, 0);
    out.push(sum);
    for (let i = period; i < arr.length; i++) {
      sum = sum - sum / period + arr[i];
      out.push(sum);
    }
    return out;
  };

  const smPlusDM = wilderSmooth(plusDM);
  const smMinusDM = wilderSmooth(minusDM);
  const smTR = wilderSmooth(tr);

  const dx = [];
  for (let i = 0; i < smTR.length; i++) {
    if (smTR[i] === 0) { dx.push(0); continue; }
    const plusDI = 100 * smPlusDM[i] / smTR[i];
    const minusDI = 100 * smMinusDM[i] / smTR[i];
    const diSum = plusDI + minusDI;
    dx.push(diSum === 0 ? 0 : 100 * Math.abs(plusDI - minusDI) / diSum);
  }
  if (dx.length < period) return null;

  let adx = dx.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }
  return adx;
}

/**
 * Where the current ATR sits (0-100 percentile) against its own trailing
 * history — deliberately a rolling simple-average-of-true-range series
 * rather than repeatedly re-running the Wilder-smoothed calcATR at every
 * historical point (same concept, far cheaper: O(n) instead of O(n²)).
 *
 * True range is normalized by that day's close (% of price) before ranking
 * — same scale-invariance fix as F10/MACD's ATR normalization earlier this
 * session. Without it, any stock on a long uptrend has mechanically larger
 * ABSOLUTE point-ranges late in the series purely because price is higher,
 * which would misread "price went up a lot" as "volatility increased" even
 * when the day-to-day PERCENTAGE range never changed.
 */
function computeATRPercentile(highs, lows, closes, period = 14, lookback = 252) {
  if (!highs || highs.length < period + 20) return null;
  const trPct = [];
  for (let i = 1; i < highs.length; i++) {
    const rawTR = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trPct.push(closes[i] > 0 ? rawTR / closes[i] : 0);
  }
  const atrSeries = [];
  for (let i = period - 1; i < trPct.length; i++) {
    const window = trPct.slice(i - period + 1, i + 1);
    atrSeries.push(window.reduce((s, v) => s + v, 0) / period);
  }
  const recent = atrSeries.slice(-lookback);
  if (recent.length < 20) return null;
  const current = recent[recent.length - 1];
  // Tie-corrected percentile rank: plain `<=` inflates to 100 whenever the
  // history is (near-)constant, since every past value "ties" the current
  // one and all of them count as "below or equal" — a flat-volatility stock
  // would misread its own noise as an extreme-percentile spike. Ties instead
  // count as half a rank, the standard percentile-rank convention.
  const below = recent.filter(v => v < current).length;
  const equal = recent.filter(v => v === current).length;
  return Math.round(((below + 0.5 * equal) / recent.length) * 100);
}

/** Same percentile-rank idea, for Bollinger Band width (squeeze vs. expansion). */
function computeBBWidthPercentile(closes, period = 20, lookback = 252) {
  if (!closes || closes.length < period + 20) return null;
  const widths = [];
  for (let i = period; i <= closes.length; i++) {
    const slice = closes.slice(i - period, i);
    const middle = slice.reduce((s, v) => s + v, 0) / period;
    const variance = slice.reduce((s, v) => s + Math.pow(v - middle, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    widths.push(middle > 0 ? (4 * stdDev) / middle : 0); // (upper-lower)/middle, mult=2
  }
  const recent = widths.slice(-lookback);
  if (recent.length < 20) return null;
  const current = recent[recent.length - 1];
  const below = recent.filter(v => v <= current).length;
  return Math.round((below / recent.length) * 100);
}

/**
 * Classify the current regime from a candle series. Per §5.2's baseline rule:
 * HIGH_VOLATILITY overrides everything (a strong trend inside an extreme-ATR
 * regime is still un-actionable risk), then TREND_UP/TREND_DOWN require price
 * AND EMA50 both on the same side of EMA200, a rising/falling EMA50 slope,
 * and ADX confirming real trend strength — otherwise RANGE. UNKNOWN only when
 * there isn't enough history to compute the inputs at all.
 *
 * @param {Array<{high:number, low:number, close:number}>} candles - oldest→newest
 * @param {typeof REGIME_CONFIG} config
 * @returns {{regime: string, reason: string, inputs: object}}
 */
function detectPriceRegime(candles, config = REGIME_CONFIG) {
  if (!candles || candles.length < config.minCandles) {
    return { regime: 'UNKNOWN', reason: 'insufficient_history', inputs: { candleCount: candles?.length || 0 } };
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const currentPrice = closes[closes.length - 1];

  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);

  const pastCloses = closes.slice(0, closes.length - config.emaSlopeLookback);
  const ema50Past = pastCloses.length >= 50 ? ema(pastCloses, 50) : null;
  const ema50Slope = (ema50 !== null && ema50Past !== null && ema50Past !== 0)
    ? (ema50 - ema50Past) / ema50Past : null;

  const adx14 = calcADX(highs, lows, closes, 14);
  const atrPercentile = computeATRPercentile(highs, lows, closes, 14, config.percentileLookback);
  const bbWidthPercentile = computeBBWidthPercentile(closes, 20, config.percentileLookback);

  const inputs = {
    price: Math.round(currentPrice * 100) / 100,
    ema50: ema50 !== null ? Math.round(ema50 * 100) / 100 : null,
    ema200: ema200 !== null ? Math.round(ema200 * 100) / 100 : null,
    ema50Slope: ema50Slope !== null ? Math.round(ema50Slope * 10000) / 10000 : null,
    adx14: adx14 !== null ? Math.round(adx14 * 100) / 100 : null,
    atrPercentile, bbWidthPercentile,
  };

  if (ema200 === null || ema50Slope === null || adx14 === null) {
    return { regime: 'UNKNOWN', reason: 'insufficient_indicator_data', inputs };
  }

  // The second guard, and the one minCandles alone cannot give. minCandles is
  // checked against `candles`, but a caller can hand over a slice that satisfies
  // it while still being too short for the EMA to have shed its seed -- which is
  // exactly what `slice(-280)` did here for years. Refusing is the honest answer:
  // a regime label computed from a 45%-seed EMA200 is not a weaker label, it is
  // a different quantity wearing the name.
  const seed200 = emaSeedWeight(200, closes.length);
  if (seed200 > 0.05) {
    return {
      regime: 'UNKNOWN',
      reason: `ema200_seed_weight_${(seed200 * 100).toFixed(1)}pct_over_5pct`,
      inputs: { ...inputs, barsSupplied: closes.length, barsNeeded: emaMinBars(200, 0.05) },
    };
  }

  if (atrPercentile !== null && atrPercentile >= config.atrHighVolPercentile) {
    return { regime: 'HIGH_VOLATILITY', reason: `atr_percentile_${atrPercentile}`, inputs };
  }

  if (currentPrice > ema200 && ema50 > ema200 &&
      ema50Slope > config.trendThreshold && adx14 >= config.adxTrendMin) {
    return { regime: 'TREND_UP', reason: 'price_and_ema50_above_ema200_rising_adx_confirmed', inputs };
  }

  if (currentPrice < ema200 && ema50 < ema200 &&
      ema50Slope < -config.trendThreshold && adx14 >= config.adxTrendMin) {
    return { regime: 'TREND_DOWN', reason: 'price_and_ema50_below_ema200_falling_adx_confirmed', inputs };
  }

  return { regime: 'RANGE', reason: 'no_confirmed_trend_or_high_vol', inputs };
}

/**
 * Shadow-mode gate verdict (P1 follow-up #13, 2026-07-30): what a counter-
 * trend regime GATE would decide for a given signal, WITHOUT ever actually
 * blocking anything — this is computed and logged only, per the module's
 * own design note above ("watch it against real outcomes, only promote it
 * to something that filters/sizes signals once it's been validated"). The
 * rule tested is the most natural hypothesis: a bullish call fighting a
 * confirmed downtrend, or a bearish call fighting a confirmed uptrend, is
 * "counter-trend"; HIGH_VOLATILITY overrides everything per §5's own framing
 * of it as un-actionable risk regardless of direction.
 *
 * @param {string} signalType - 'STRONG BUY'|'BUY'|'WATCH'|'NEUTRAL'|'SELL'|'STRONG SELL'
 * @param {string|null} regime - detectPriceRegime's .regime field
 * @returns {{wouldBlock: boolean, reason: string}}
 */
function regimeGateVerdict(signalType, regime) {
  const isBullish = signalType === 'STRONG BUY' || signalType === 'BUY';
  const isBearish = signalType === 'STRONG SELL' || signalType === 'SELL';
  if (!isBullish && !isBearish) return { wouldBlock: false, reason: 'not_directional' };
  if (!regime || regime === 'UNKNOWN') return { wouldBlock: false, reason: 'no_regime_data' };
  if (regime === 'HIGH_VOLATILITY') return { wouldBlock: true, reason: 'high_volatility' };
  if (isBullish && regime === 'TREND_DOWN') return { wouldBlock: true, reason: 'counter_trend_down' };
  if (isBearish && regime === 'TREND_UP') return { wouldBlock: true, reason: 'counter_trend_up' };
  return { wouldBlock: false, reason: 'aligned_or_range' };
}

module.exports = {
  REGIME_CONFIG, calcADX, computeATRPercentile, computeBBWidthPercentile, detectPriceRegime,
  regimeGateVerdict,
};
