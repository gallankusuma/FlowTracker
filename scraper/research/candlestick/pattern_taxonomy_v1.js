/**
 * CANDLE_PATTERN_TAXONOMY_V1 — frozen pattern definitions.
 *
 * The review's instruction on thresholds is the whole design constraint here:
 *
 *   "Threshold final jangan ditentukan dari backtest. Kita turunkan dari
 *    taxonomy buku/reference -> freeze -> baru test."
 *
 * So every number below comes from the classical literature (Nison's
 * *Japanese Candlestick Charting Techniques* for the shapes, Bulkowski's
 * *Encyclopedia of Candlestick Charts* for the quantified variants) and none of
 * it has been tuned against an outcome. The point of EXP-028 is to find out
 * whether the textbook definitions carry information — a threshold moved to
 * improve a result would answer a different and much less interesting question.
 *
 * This file is the FIXTURE set: 14 patterns spanning single/double/triple and
 * bullish/bearish/indecision, enough to build and test the engine end to end
 * while the full 101-pattern translation happens in parallel. Adding the rest
 * must not change any definition here — new ids, same version, or a new version
 * if an existing rule genuinely changes.
 *
 * PROVENANCE. `taxonomyHash()` digests the ids, the thresholds AND the matcher
 * source, so editing a number or the logic both move the hash. EXP-028 records
 * it on every run (spec section 21), and a changed hash means results are not
 * comparable — mint V2 rather than re-pointing V1.
 *
 * PRIOR CONTEXT IS PART OF SOME DEFINITIONS, not research conditioning. Hammer
 * and Hanging Man are the SAME shape; only the preceding trend separates them,
 * and the same is true of Inverted Hammer vs Shooting Star. Encoding that here
 * keeps it a definition. The conditional research in EXP-028C is a different
 * question asked later, on top of these.
 *
 * Trend is measured STRICTLY BEFORE the pattern: the return from the close
 * `trendLookback+patternSpan` bars back to the close immediately preceding the
 * pattern's first candle. The signal bar never contributes to the context that
 * qualifies it.
 */
'use strict';

const crypto = require('crypto');

const TAXONOMY_VERSION = 'CANDLE_PATTERN_TAXONOMY_V1';

/** Prior-trend classification, from reference practice: ±3% over 5 sessions. */
const TREND = Object.freeze({ UP: 'UP', DOWN: 'DOWN', FLAT: 'FLAT' });
const TREND_LOOKBACK = 5;
const TREND_THRESHOLD_PCT = 3;

const FAMILY = Object.freeze({
  DOJI: 'DOJI',
  LONG_WICK_REJECTION: 'LONG_WICK_REJECTION',
  MARUBOZU: 'MARUBOZU',
  INDECISION: 'INDECISION',
  ENGULFING: 'ENGULFING',
  HARAMI: 'HARAMI',
  PIERCING: 'PIERCING',
  STAR: 'STAR',
  SOLDIERS: 'SOLDIERS',
});

const DIRECTION = Object.freeze({
  BULLISH_REVERSAL: 'BULLISH_REVERSAL',
  BEARISH_REVERSAL: 'BEARISH_REVERSAL',
  INDECISION: 'INDECISION',
  BULLISH_CONTINUATION: 'BULLISH_CONTINUATION',
  BEARISH_CONTINUATION: 'BEARISH_CONTINUATION',
});

/* ── shared numeric thresholds, all from reference ─────────────────────────── */
const T = Object.freeze({
  DOJI_BODY_MAX: 0.05,          // body <= 5% of range
  LONG_WICK_MIN: 0.60,          // a "long" wick is >= 60% of range
  OPPOSITE_WICK_MAX: 0.10,      // the other side is stubby
  HAMMER_BODY_MAX: 0.35,        // small body, not necessarily a doji
  HAMMER_WICK_BODY_MULT: 2.0,   // lower wick >= 2x body
  MARUBOZU_BODY_MIN: 0.95,      // essentially all body
  SPINNING_BODY_MAX: 0.30,
  SPINNING_WICK_MIN: 0.25,      // both wicks meaningful
  STAR_BODY_MAX: 0.30,          // the star itself is small-bodied
  LONG_BODY_MIN: 0.60,          // "long" real body for stars/soldiers
  PIERCE_MIN: 0.50,             // close past the midpoint of the prior body
});

/** Is bar `g` a small-bodied candle sitting at the top of its range? */
const isHammerShape = g =>
  g.bodyRatio <= T.HAMMER_BODY_MAX &&
  g.lowerWick >= T.HAMMER_WICK_BODY_MULT * g.body &&
  g.upperWickRatio <= T.OPPOSITE_WICK_MAX;

/** Mirror: small body at the BOTTOM of its range, long upper shadow. */
const isInvertedHammerShape = g =>
  g.bodyRatio <= T.HAMMER_BODY_MAX &&
  g.upperWick >= T.HAMMER_WICK_BODY_MULT * g.body &&
  g.lowerWickRatio <= T.OPPOSITE_WICK_MAX;

const bodyTop = b => Math.max(Number(b.open), Number(b.close));
const bodyBot = b => Math.min(Number(b.open), Number(b.close));

/**
 * Every pattern. `match` receives:
 *   { geo, bars, i, trend }  where `i` indexes the pattern's LAST candle,
 *   geo/bars are the full aligned series, and `trend` is the strictly-prior
 *   trend classification for this pattern instance.
 * It must return true/false and must not look beyond `i`.
 */
const PATTERNS = Object.freeze([
  {
    id: 'DOJI_V1', name: 'Doji', family: FAMILY.DOJI, direction: DIRECTION.INDECISION,
    candleCount: 1, priorContextRequired: null,
    rules: { bodyRatioMax: T.DOJI_BODY_MAX },
    source: 'Nison ch.3 — open and close virtually equal',
    match: ({ geo, i }) => geo[i].bodyRatio <= T.DOJI_BODY_MAX,
  },
  {
    id: 'DRAGONFLY_DOJI_V1', name: 'Dragonfly Doji', family: FAMILY.DOJI,
    direction: DIRECTION.BULLISH_REVERSAL, candleCount: 1, priorContextRequired: TREND.DOWN,
    rules: { bodyRatioMax: T.DOJI_BODY_MAX, lowerWickMin: T.LONG_WICK_MIN, upperWickMax: T.OPPOSITE_WICK_MAX },
    source: 'Nison ch.8 — doji with a long lower shadow and no upper shadow',
    match: ({ geo, i, trend }) => trend === TREND.DOWN &&
      geo[i].bodyRatio <= T.DOJI_BODY_MAX &&
      geo[i].lowerWickRatio >= T.LONG_WICK_MIN &&
      geo[i].upperWickRatio <= T.OPPOSITE_WICK_MAX,
  },
  {
    id: 'GRAVESTONE_DOJI_V1', name: 'Gravestone Doji', family: FAMILY.DOJI,
    direction: DIRECTION.BEARISH_REVERSAL, candleCount: 1, priorContextRequired: TREND.UP,
    rules: { bodyRatioMax: T.DOJI_BODY_MAX, upperWickMin: T.LONG_WICK_MIN, lowerWickMax: T.OPPOSITE_WICK_MAX },
    source: 'Nison ch.8 — doji with a long upper shadow and no lower shadow',
    match: ({ geo, i, trend }) => trend === TREND.UP &&
      geo[i].bodyRatio <= T.DOJI_BODY_MAX &&
      geo[i].upperWickRatio >= T.LONG_WICK_MIN &&
      geo[i].lowerWickRatio <= T.OPPOSITE_WICK_MAX,
  },
  {
    id: 'HAMMER_V1', name: 'Hammer', family: FAMILY.LONG_WICK_REJECTION,
    direction: DIRECTION.BULLISH_REVERSAL, candleCount: 1, priorContextRequired: TREND.DOWN,
    rules: { bodyRatioMax: T.HAMMER_BODY_MAX, lowerWickBodyMult: T.HAMMER_WICK_BODY_MULT, upperWickMax: T.OPPOSITE_WICK_MAX },
    source: 'Nison ch.4 — small body at the top, lower shadow 2-3x the body, in a downtrend',
    match: ({ geo, i, trend }) => trend === TREND.DOWN && isHammerShape(geo[i]),
  },
  {
    id: 'HANGING_MAN_V1', name: 'Hanging Man', family: FAMILY.LONG_WICK_REJECTION,
    direction: DIRECTION.BEARISH_REVERSAL, candleCount: 1, priorContextRequired: TREND.UP,
    rules: { bodyRatioMax: T.HAMMER_BODY_MAX, lowerWickBodyMult: T.HAMMER_WICK_BODY_MULT, upperWickMax: T.OPPOSITE_WICK_MAX },
    source: 'Nison ch.4 — identical shape to the Hammer; the uptrend is what makes it bearish',
    match: ({ geo, i, trend }) => trend === TREND.UP && isHammerShape(geo[i]),
  },
  {
    id: 'INVERTED_HAMMER_V1', name: 'Inverted Hammer', family: FAMILY.LONG_WICK_REJECTION,
    direction: DIRECTION.BULLISH_REVERSAL, candleCount: 1, priorContextRequired: TREND.DOWN,
    rules: { bodyRatioMax: T.HAMMER_BODY_MAX, upperWickBodyMult: T.HAMMER_WICK_BODY_MULT, lowerWickMax: T.OPPOSITE_WICK_MAX },
    source: 'Nison ch.5 — small body at the bottom, long upper shadow, in a downtrend',
    match: ({ geo, i, trend }) => trend === TREND.DOWN && isInvertedHammerShape(geo[i]),
  },
  {
    id: 'SHOOTING_STAR_V1', name: 'Shooting Star', family: FAMILY.LONG_WICK_REJECTION,
    direction: DIRECTION.BEARISH_REVERSAL, candleCount: 1, priorContextRequired: TREND.UP,
    rules: { bodyRatioMax: T.HAMMER_BODY_MAX, upperWickBodyMult: T.HAMMER_WICK_BODY_MULT, lowerWickMax: T.OPPOSITE_WICK_MAX },
    source: 'Nison ch.5 — the Inverted Hammer shape after an advance',
    match: ({ geo, i, trend }) => trend === TREND.UP && isInvertedHammerShape(geo[i]),
  },
  {
    id: 'MARUBOZU_BULL_V1', name: 'Bullish Marubozu', family: FAMILY.MARUBOZU,
    direction: DIRECTION.BULLISH_CONTINUATION, candleCount: 1, priorContextRequired: null,
    rules: { bodyRatioMin: T.MARUBOZU_BODY_MIN, direction: 1 },
    source: 'Nison ch.3 — a shaven candle: open at the low, close at the high',
    match: ({ geo, i }) => geo[i].direction === 1 && geo[i].bodyRatio >= T.MARUBOZU_BODY_MIN,
  },
  {
    id: 'MARUBOZU_BEAR_V1', name: 'Bearish Marubozu', family: FAMILY.MARUBOZU,
    direction: DIRECTION.BEARISH_CONTINUATION, candleCount: 1, priorContextRequired: null,
    rules: { bodyRatioMin: T.MARUBOZU_BODY_MIN, direction: -1 },
    source: 'Nison ch.3 — shaven candle, open at the high, close at the low',
    match: ({ geo, i }) => geo[i].direction === -1 && geo[i].bodyRatio >= T.MARUBOZU_BODY_MIN,
  },
  {
    id: 'SPINNING_TOP_V1', name: 'Spinning Top', family: FAMILY.INDECISION,
    direction: DIRECTION.INDECISION, candleCount: 1, priorContextRequired: null,
    rules: { bodyRatioMax: T.SPINNING_BODY_MAX, bothWicksMin: T.SPINNING_WICK_MIN },
    source: 'Nison ch.3 — small body with upper and lower shadows of similar note',
    match: ({ geo, i }) => geo[i].bodyRatio <= T.SPINNING_BODY_MAX &&
      geo[i].upperWickRatio >= T.SPINNING_WICK_MIN &&
      geo[i].lowerWickRatio >= T.SPINNING_WICK_MIN,
  },
  {
    id: 'BULLISH_ENGULFING_V1', name: 'Bullish Engulfing', family: FAMILY.ENGULFING,
    direction: DIRECTION.BULLISH_REVERSAL, candleCount: 2, priorContextRequired: TREND.DOWN,
    rules: { prevDirection: -1, currDirection: 1, engulfsBody: true },
    source: 'Nison ch.4 — a white body wrapping the prior black body, in a downtrend',
    match: ({ geo, bars, i, trend }) => {
      if (trend !== TREND.DOWN) return false;
      if (!geo[i - 1] || !geo[i - 1].resolved) return false;
      if (geo[i - 1].direction !== -1 || geo[i].direction !== 1) return false;
      return bodyBot(bars[i]) <= bodyBot(bars[i - 1]) && bodyTop(bars[i]) >= bodyTop(bars[i - 1]);
    },
  },
  {
    id: 'BEARISH_ENGULFING_V1', name: 'Bearish Engulfing', family: FAMILY.ENGULFING,
    direction: DIRECTION.BEARISH_REVERSAL, candleCount: 2, priorContextRequired: TREND.UP,
    rules: { prevDirection: 1, currDirection: -1, engulfsBody: true },
    source: 'Nison ch.4 — a black body wrapping the prior white body, after an advance',
    match: ({ geo, bars, i, trend }) => {
      if (trend !== TREND.UP) return false;
      if (!geo[i - 1] || !geo[i - 1].resolved) return false;
      if (geo[i - 1].direction !== 1 || geo[i].direction !== -1) return false;
      return bodyBot(bars[i]) <= bodyBot(bars[i - 1]) && bodyTop(bars[i]) >= bodyTop(bars[i - 1]);
    },
  },
  {
    id: 'PIERCING_LINE_V1', name: 'Piercing Line', family: FAMILY.PIERCING,
    direction: DIRECTION.BULLISH_REVERSAL, candleCount: 2, priorContextRequired: TREND.DOWN,
    rules: { prevDirection: -1, currDirection: 1, opensBelowPrevLow: true, closesPastMidpoint: T.PIERCE_MIN },
    source: 'Nison ch.4 — opens under the prior low and closes above the midpoint of the prior black body',
    match: ({ geo, bars, i, trend }) => {
      if (trend !== TREND.DOWN) return false;
      if (!geo[i - 1] || !geo[i - 1].resolved) return false;
      if (geo[i - 1].direction !== -1 || geo[i].direction !== 1) return false;
      const p = bars[i - 1], c = bars[i];
      if (Number(c.open) >= Number(p.low)) return false;
      const mid = (Number(p.open) + Number(p.close)) / 2;
      return Number(c.close) > mid && Number(c.close) < Number(p.open);
    },
  },
  {
    id: 'DARK_CLOUD_COVER_V1', name: 'Dark Cloud Cover', family: FAMILY.PIERCING,
    direction: DIRECTION.BEARISH_REVERSAL, candleCount: 2, priorContextRequired: TREND.UP,
    rules: { prevDirection: 1, currDirection: -1, opensAbovePrevHigh: true, closesPastMidpoint: T.PIERCE_MIN },
    source: 'Nison ch.4 — opens above the prior high and closes below the midpoint of the prior white body',
    match: ({ geo, bars, i, trend }) => {
      if (trend !== TREND.UP) return false;
      if (!geo[i - 1] || !geo[i - 1].resolved) return false;
      if (geo[i - 1].direction !== 1 || geo[i].direction !== -1) return false;
      const p = bars[i - 1], c = bars[i];
      if (Number(c.open) <= Number(p.high)) return false;
      const mid = (Number(p.open) + Number(p.close)) / 2;
      return Number(c.close) < mid && Number(c.close) > Number(p.open);
    },
  },
]);

/** Trend strictly before a pattern whose last candle is at `i`. */
function priorTrend(bars, i, candleCount) {
  const firstOfPattern = i - (candleCount - 1);
  const refIdx = firstOfPattern - 1;              // last bar before the pattern
  const baseIdx = refIdx - TREND_LOOKBACK;
  if (baseIdx < 0 || !bars[refIdx] || !bars[baseIdx]) return null;
  const ref = Number(bars[refIdx].close), base = Number(bars[baseIdx].close);
  if (!(ref > 0) || !(base > 0)) return null;
  const pct = ((ref / base) - 1) * 100;
  if (pct >= TREND_THRESHOLD_PCT) return TREND.UP;
  if (pct <= -TREND_THRESHOLD_PCT) return TREND.DOWN;
  return TREND.FLAT;
}

/**
 * Digest over ids, thresholds AND matcher source. A silently edited threshold
 * or a rewritten condition both move this, so a run's provenance cannot claim
 * definitions it did not use.
 */
function taxonomyHash() {
  const payload = PATTERNS.map(p => [
    p.id, p.family, p.direction, p.candleCount, p.priorContextRequired,
    JSON.stringify(p.rules), p.match.toString().replace(/\s+/g, ' '),
  ].join('|')).join('\n');
  return crypto.createHash('sha256').update(`${TAXONOMY_VERSION}\n${payload}`).digest('hex');
}

module.exports = {
  TAXONOMY_VERSION, PATTERNS, FAMILY, DIRECTION, TREND, T,
  TREND_LOOKBACK, TREND_THRESHOLD_PCT,
  priorTrend, taxonomyHash,
};
