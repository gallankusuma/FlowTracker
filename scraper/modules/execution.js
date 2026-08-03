/**
 * Execution helpers shared by every backtest and by the live forward recorder.
 *
 * WHY THIS EXISTS (review P0.1, 2026-08-03)
 * -----------------------------------------
 * Eight sell paths across six scripts all had the same shape:
 *
 *     const px = series.get(t).open[execI];
 *     if (px > 0) cash += units * px * (1 - SELL_COST);
 *     held.delete(t);              // <- deleted even when px was not a price
 *
 * When the execution bar has no price — a suspension, a halt, a name that
 * stopped trading — the position was removed from the book with no proceeds.
 * That is not a missed fill, it is a position marked to zero and then quietly
 * discarded, and it makes an untradeable exit look free. The same scripts also
 * marked the portfolio to market with `if (px > 0) pv += units * px`, so a
 * holding with no print that day contributed nothing to portfolio value.
 *
 * A seller who cannot sell still owns the shares. `sellFill` returns null so
 * the caller keeps holding and counts a NO_FILL, and `markPrice` falls back to
 * the last real close rather than to zero.
 *
 * This mattered little while the universe was chosen with full-sample knowledge
 * (review P0.2) — such a universe contains no names that vanish, so NO_FILL was
 * 0.00% everywhere and the two biases hid each other. It is reachable now.
 */
'use strict';

/**
 * The last price genuinely observable for `s` at or before bar `i`.
 *
 * Prefers the bar's own close, then walks back. Never looks forward, and never
 * returns 0 for a name that simply did not print — the caller cannot tell those
 * two cases apart from a bare number, which is how "no price" became "worth
 * nothing".
 *
 * @param {{close:number[]}} s
 * @param {number} i
 * @param {number} [maxLookback] - refuse to mark a position off a price older
 *   than this many bars; returns null instead, so a caller can treat a long
 *   silence as unmarkable rather than silently carrying a stale figure.
 * @returns {number|null}
 */
function markPrice(s, i, maxLookback = Infinity) {
  if (!s || !Array.isArray(s.close)) return null;
  const floor = Number.isFinite(maxLookback) ? Math.max(0, i - maxLookback) : 0;
  for (let j = Math.min(i, s.close.length - 1); j >= floor; j--) {
    const c = s.close[j];
    if (c !== null && c !== undefined && c > 0) return c;
  }
  return null;
}

/**
 * Price a sale at bar `i`, or report that it cannot be executed.
 *
 * @returns {number|null} the executable price, or null for a NO_FILL — in which
 *   case the caller MUST keep the position and try again next rebalance.
 */
function sellFill(s, i) {
  if (!s || !Array.isArray(s.open)) return null;
  const px = s.open[i];
  return px > 0 ? px : null;
}

/** Same question for the buy side, kept here so both live in one place. */
function buyFill(s, i) {
  if (!s || !Array.isArray(s.open)) return null;
  const px = s.open[i];
  return px > 0 ? px : null;
}

/**
 * Portfolio value of `held` at bar `i`, using the execution price where one
 * exists and the last real close otherwise.
 *
 * @param {Map<string, number>} held - ticker -> units
 * @param {Map<string, object>} series
 * @param {number} i
 * @param {number} [maxLookback]
 * @returns {{value:number, unmarkable:string[]}} `unmarkable` names contributed
 *   nothing because no price could be found at all — reported rather than
 *   folded into the total, so a caller can say so instead of pretending.
 */
function markToMarket(held, series, i, maxLookback = Infinity) {
  let value = 0;
  const unmarkable = [];
  for (const [t, units] of held) {
    const s = series.get(t);
    const px = (s && s.open && s.open[i] > 0) ? s.open[i] : markPrice(s, i, maxLookback);
    if (px === null) { unmarkable.push(t); continue; }
    value += units * px;
  }
  return { value, unmarkable };
}

module.exports = { markPrice, sellFill, buyFill, markToMarket };
