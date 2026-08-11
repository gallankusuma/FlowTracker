/**
 * THE CANONICAL "GENUINE BREAKOUT" DEFINITION — one implementation, shared.
 *
 * WHY THIS MODULE EXISTS (2026-08-11)
 * -----------------------------------
 * EXP-025 froze what this project means by a breakout, inline in
 * `backtest_precursor_trajectory.js`. EXP-026 then wrote its own version of the
 * "same" rule and got it wrong twice in a row:
 *
 *   R0  tested `max_profit >= 5%` — an INTRADAY HIGH touching +5% at any point —
 *       while the text claimed it was EXP-025's definition. That is a different
 *       event, and it reversed the finding: BUY looked WORSE than the universe
 *       (19.6% vs 45.7%) when on the real definition it is far BETTER.
 *   R1  fixed the metric but used the window `i-19 .. i`, which includes the
 *       entry bar, where EXP-025 uses `i-20 .. i-1`, strictly before entry.
 *
 * Two wrong readings of one frozen contract, in two consecutive rounds, is the
 * signature this codebase knows well: a definition that lives in one script and
 * is re-described by the next. The review asked for "single canonical EXP-025
 * helper, bukan copy-paste definition ketiga" before EXP-027A adds a third
 * caller. This is that helper.
 *
 * `backtest_precursor_trajectory.js` is deliberately NOT refactored to import
 * it. That script is the published record of a registry entry and the registry
 * is append-only — the same reason EXP-009/010 were left alone when
 * modules/cross_sectional.js was extracted. Equivalence is PROVEN by test
 * (`test_breakout_parity.js`) rather than achieved by editing the record.
 *
 * THE CONTRACT, stated once
 * -------------------------
 *   A name entered at session i is a WINNER iff
 *
 *     (a) close(i + HORIZON) / close(i) - 1  >=  WIN_THRESHOLD_PCT
 *     (b) close(i + HORIZON)  >  max(close over sessions i-LOOKBACK .. i-1)
 *
 *   Sessions are CANONICAL exchange sessions, never table rows. If any required
 *   session is missing for that ticker the name is EXCLUDED (null), never
 *   assumed either way — without the full prior window we cannot say whether the
 *   exit is new ground.
 *
 * Note (b) uses CLOSE on both sides and the window is STRICTLY BEFORE entry. The
 * entry bar is not in it: "distance from the prior high" must not include the
 * bar being entered on, or a name that gaps to a new high at entry sets its own
 * bar to clear.
 */
'use strict';

const WIN_THRESHOLD_PCT = 5;   // forward return required
const HORIZON_SESSIONS = 5;    // sessions held
const HIGH_LOOKBACK = 20;      // sessions of prior closes the exit must clear

/**
 * @param {Map<string, {c:number}>} series  ticker's bars keyed by ISO session date
 * @param {string[]} sessions               canonical session axis, ascending
 * @param {number} i                        index of the entry session
 * @param {object} [opts]
 * @returns {{winner:boolean, forwardReturnPct:number, priorHigh:number, exitClose:number}|null}
 *          null when the window cannot be completed — the caller must treat that
 *          as EXCLUDED, not as false.
 */
function genuineBreakout(series, sessions, i, opts = {}) {
  const threshold = opts.thresholdPct ?? WIN_THRESHOLD_PCT;
  const horizon = opts.horizon ?? HORIZON_SESSIONS;
  const lookback = opts.lookback ?? HIGH_LOOKBACK;

  if (i < lookback) return null;                 // not enough prior history
  const entry = series.get(sessions[i]);
  const exitDate = sessions[i + horizon];
  if (!entry || !exitDate) return null;
  const exit = series.get(exitDate);
  if (!exit) return null;

  // STRICTLY BEFORE ENTRY: i-lookback .. i-1. The entry bar is excluded.
  let priorHigh = -Infinity;
  for (let k = i - lookback; k < i; k++) {
    const b = series.get(sessions[k]);
    if (!b) return null;                         // incomplete window -> excluded
    if (b.c > priorHigh) priorHigh = b.c;
  }

  const forwardReturnPct = (exit.c / entry.c - 1) * 100;
  return {
    winner: forwardReturnPct >= threshold && exit.c > priorHigh,
    forwardReturnPct,
    priorHigh,
    exitClose: exit.c,
  };
}

module.exports = {
  genuineBreakout,
  WIN_THRESHOLD_PCT, HORIZON_SESSIONS, HIGH_LOOKBACK,
};
