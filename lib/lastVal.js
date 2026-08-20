/**
 * LAST VAL — one-sided IDX transaction value, and the filter that reads it.
 *
 * WHY THIS IS A SEPARATE FILE. It used to live inside the Flow Analyzer page,
 * where nothing could execute it. The 2026-08-18 10:50 review asked for "a
 * focused filter/sort fixture at the 10B boundary", and a boundary cannot be
 * pinned by a component that only runs in a browser. Plain CommonJS on purpose:
 * the page imports it through webpack and `scraper/test_last_val.js` requires it
 * directly, so the filter under test is literally the shipped one.
 *
 * WHAT THE NUMBER IS. `turnover` is SUM(buy_val + sell_val), which counts every
 * trade twice — one side's buy is the other side's sell — so it is exactly 2x
 * the value that changed hands. LAST VAL is the one-sided figure: the
 * conventional IDX "nilai transaksi", and what the reference site publishes
 * under that name. Display, filter and sort must all read this one, because
 * filtering on a scale the column does not show is how "min 10B" silently meant
 * 5B.
 *
 * THE FORMAT. The server's formatVal() emits T, B, M, K, or a bare number for
 * anything under a thousand. An earlier version handled only T/B/M, so "929.2K"
 * fell through and was read as 929.2 BILLION — a million times too large, which
 * put the smallest rows at the top of a descending sort. A bare number had the
 * same bug at a factor of a billion. The multipliers are keyed off the suffix
 * explicitly now, and an unrecognised suffix means raw rupiah rather than
 * silently inheriting the units of whatever branch happened to return last.
 */
'use strict';

/** Suffix -> multiplier that converts the printed number into BILLIONS of rupiah. */
const VAL_UNITS = {
  T: 1e3,     // trillions -> billions
  B: 1,
  M: 1e-3,
  K: 1e-6,
};

/**
 * Parse a formatted value string into billions of rupiah.
 * @param {string} s e.g. "12.4B", "929.2K", "1.05T", "4500"
 * @returns {number} billions of rupiah; 0 for anything unparseable
 */
function parseLastVal(s) {
  if (!s) return 0;
  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  const suffix = String(s).trim().slice(-1).toUpperCase();
  const mult = VAL_UNITS[suffix];
  // No suffix means formatVal printed the raw figure, which is in rupiah.
  return mult === undefined ? n / 1e9 : n * mult;
}

/**
 * Does a row's LAST VAL fall inside the requested range?
 *
 * INCLUSIVE at both ends, deliberately. A user typing "min 10" means "at least
 * 10B", and a row printed as exactly 10.0B has to survive it — an exclusive
 * bound would drop the very row the number names, and the drop would be
 * invisible because the row simply is not there to notice.
 *
 * NaN means "the box is empty", not "no rows match": an unparsed filter must not
 * silently exclude everything.
 *
 * @param {string} formatted the row's LAST VAL as displayed
 * @param {number} min billions; NaN = no lower bound
 * @param {number} max billions; NaN = no upper bound
 */
function withinLastVal(formatted, min, max) {
  const v = parseLastVal(formatted);
  if (!isNaN(min) && v < min) return false;
  if (!isNaN(max) && v > max) return false;
  return true;
}

module.exports = { VAL_UNITS, parseLastVal, withinLastVal };
