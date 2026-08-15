/**
 * CANDLE GEOMETRY — the measurement layer beneath every pattern definition.
 *
 * EXP-028 asks whether classical candlestick patterns carry predictive
 * information on IDX. Every pattern in the taxonomy is expressed as thresholds
 * over the primitives computed here, so anything wrong at this level is wrong
 * in all 101 patterns at once. That is why this is a module with its own tests
 * rather than arithmetic inlined into a detector.
 *
 * WHAT THE DATA ACTUALLY LOOKS LIKE (measured 2026-08-15, 503,297 bars in
 * idx_stock_prices — not assumed, and it changed the design):
 *
 *   split adjustment   Yahoo's `quote` series is already split-adjusted. BBCA
 *                      spans its 2021-10-13 1:5 split continuously at ~7,200 ->
 *                      ~7,500 rather than dropping 5x, and only 17 of 502,647
 *                      daily transitions move more than 60%. The review's stated
 *                      worry — a split forging a giant candle — does not apply.
 *
 *   range == 0         11.01% of bars. high == low, so EVERY ratio below is 0/0.
 *
 *   range < 5 ticks    30.05% of bars. Median range is SIX ticks.
 *
 * That last number is the one that shapes this module. On a 2-tick range,
 * body_ratio can only be 0, 0.5 or 1, so "the body is under 10% of range" is not
 * a statement about market indecision — it is a statement about the price grid.
 * A Doji detector run over such bars would harvest the tick size and report it
 * as a finding, and rare patterns would suffer most because their samples are
 * smallest.
 *
 * The response is NOT to silently drop those bars. It is to measure the
 * resolution and hand it downstream: `ticksInRange` and `geometryReliable` ride
 * alongside every reading, so an analysis can require resolution, and — more
 * usefully — can SHOW how much a result depends on that requirement. Dropping
 * 30% of the sample inside a helper would make that impossible to see.
 *
 * UNRESOLVED IS NOT FALSE. A bar whose geometry cannot be computed returns
 * `null` fields with a stated reason, per the EXP-028 data contract. It must
 * never reach a detector as a well-formed candle that simply failed a test.
 */
'use strict';

/**
 * IDX tick sizes (fraksi harga), used to judge how coarse a bar's geometry is.
 * These are price BANDS, not a continuous function.
 */
const TICK_BANDS = Object.freeze([
  { below: 200, tick: 1 },
  { below: 500, tick: 2 },
  { below: 2000, tick: 5 },
  { below: 5000, tick: 10 },
  { below: Infinity, tick: 25 },
]);

function tickSize(price) {
  for (const b of TICK_BANDS) if (price < b.below) return b.tick;
  return 25;
}

/**
 * Bars below this many ticks of range carry geometry the price grid dominates.
 * Reported, not enforced: see the module note. 5 is the value the 2026-08-15
 * distribution scan used, where it separates the coarse 30% from the rest.
 */
const MIN_TICKS_FOR_RELIABLE_GEOMETRY = 5;

/**
 * A close this far from the previous close is not a session, it is a bad print.
 *
 * IDX auto-rejection caps a single session at roughly 20-35% depending on the
 * price band, so 50% cannot occur in normal trading. The scan found exactly this
 * shape — ASJT 463 -> 8 -> 444, MAPI 825 -> 82 -> 815: a collapse and a full
 * recovery the next day. A split never comes back.
 *
 * Deliberately generous, and deliberately one-sided in time: it compares against
 * the PREVIOUS close only. Using the next bar would identify these more sharply
 * but would put future information into a per-bar annotation, and annotations
 * have a way of migrating into features.
 */
const IMPLAUSIBLE_MOVE = 0.50;

/** Every reason a bar can fail to produce geometry. Stated, never silent. */
const UNRESOLVED = Object.freeze({
  MISSING_OHLC: 'MISSING_OHLC',
  NON_POSITIVE: 'NON_POSITIVE',
  INCONSISTENT: 'INCONSISTENT',       // high < low, or close outside [low, high]
  ZERO_RANGE: 'ZERO_RANGE',
  IMPLAUSIBLE_MOVE: 'IMPLAUSIBLE_MOVE',
});

/**
 * Geometry for one bar.
 *
 * @param {{open:number, high:number, low:number, close:number, volume?:number}} bar
 * @param {{prevClose?:number|null}} [ctx]  prior session's close, for gap and
 *        the bad-print check. Omit only when there is genuinely no prior bar.
 * @returns {{
 *   resolved: boolean, reason: string|null,
 *   range:number|null, body:number|null, upperWick:number|null, lowerWick:number|null,
 *   bodyRatio:number|null, upperWickRatio:number|null, lowerWickRatio:number|null,
 *   closeLocation:number|null, rangePct:number|null, gapPct:number|null,
 *   direction:number|null, ticksInRange:number|null, geometryReliable:boolean
 * }}
 */
function candleGeometry(bar, ctx = {}) {
  const unresolved = (reason) => ({
    resolved: false, reason,
    range: null, body: null, upperWick: null, lowerWick: null,
    bodyRatio: null, upperWickRatio: null, lowerWickRatio: null,
    closeLocation: null, rangePct: null, gapPct: null,
    direction: null, ticksInRange: null, geometryReliable: false,
  });

  if (!bar) return unresolved(UNRESOLVED.MISSING_OHLC);
  const o = Number(bar.open), h = Number(bar.high), l = Number(bar.low), c = Number(bar.close);
  if (![o, h, l, c].every(Number.isFinite)) return unresolved(UNRESOLVED.MISSING_OHLC);
  if (![o, h, l, c].every(v => v > 0)) return unresolved(UNRESOLVED.NON_POSITIVE);

  // A bar that contradicts itself is corrupt, not merely odd. Checked before
  // anything is derived from it, because every ratio below assumes this holds.
  if (h < l || c > h || c < l || o > h || o < l) return unresolved(UNRESOLVED.INCONSISTENT);

  const prevClose = ctx.prevClose == null ? null : Number(ctx.prevClose);
  if (prevClose != null && prevClose > 0) {
    const move = Math.abs(c / prevClose - 1);
    if (move > IMPLAUSIBLE_MOVE) return unresolved(UNRESOLVED.IMPLAUSIBLE_MOVE);
  }

  const range = h - l;
  const body = Math.abs(c - o);
  const upperWick = h - Math.max(o, c);
  const lowerWick = Math.min(o, c) - l;

  const tick = tickSize(c);
  const ticksInRange = range / tick;

  if (range <= 0) {
    // Defined bar, undefined shape: open == high == low == close. Every ratio
    // would be 0/0. This is 11% of the table, so it is a first-class outcome
    // rather than an edge case.
    return { ...unresolved(UNRESOLVED.ZERO_RANGE), range: 0, body: 0, upperWick: 0, lowerWick: 0, ticksInRange: 0 };
  }

  return {
    resolved: true,
    reason: null,
    range,
    body,
    upperWick,
    lowerWick,
    bodyRatio: body / range,
    upperWickRatio: upperWick / range,
    lowerWickRatio: lowerWick / range,
    // Where the close sits within the day's range: 1 = closed on the high.
    closeLocation: (c - l) / range,
    rangePct: (range / c) * 100,
    gapPct: prevClose != null && prevClose > 0 ? ((o / prevClose) - 1) * 100 : null,
    direction: c > o ? 1 : c < o ? -1 : 0,
    ticksInRange,
    geometryReliable: ticksInRange >= MIN_TICKS_FOR_RELIABLE_GEOMETRY,
  };
}

/**
 * Average true range over the trailing `period` bars ending at `i`, inclusive.
 *
 * Used for `range_vs_atr`, which the review asks be stored next to every
 * detection so a later analysis can ask whether an "edge" is really just
 * unusually large bars. Returns null rather than a partial average when the
 * window is not fully available — a short-window ATR is a different statistic
 * wearing the same name.
 *
 * @param {Array<{high:number,low:number,close:number}>} bars ascending by date
 */
function atrAt(bars, i, period = 14) {
  if (!Array.isArray(bars) || i < period) return null;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const b = bars[k], p = bars[k - 1];
    if (!b || !p) return null;
    const h = Number(b.high), l = Number(b.low), pc = Number(p.close);
    if (![h, l, pc].every(Number.isFinite)) return null;
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return sum / period;
}

/**
 * Geometry for a whole series, with prevClose threaded through and ATR attached.
 * Index alignment with `bars` is preserved exactly — unresolved bars keep their
 * slot so a multi-candle pattern can never accidentally treat bar i-1 as the
 * previous TRADED bar when a session was refused in between.
 */
function geometrySeries(bars, { atrPeriod = 14 } = {}) {
  const out = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const prev = i > 0 ? bars[i - 1] : null;
    const g = candleGeometry(bars[i], { prevClose: prev ? prev.close : null });
    const atr = atrAt(bars, i, atrPeriod);
    out[i] = {
      ...g,
      atr,
      rangeVsAtr: g.resolved && atr > 0 ? g.range / atr : null,
    };
  }
  return out;
}

module.exports = {
  candleGeometry,
  geometrySeries,
  atrAt,
  tickSize,
  TICK_BANDS,
  MIN_TICKS_FOR_RELIABLE_GEOMETRY,
  IMPLAUSIBLE_MOVE,
  UNRESOLVED,
};
