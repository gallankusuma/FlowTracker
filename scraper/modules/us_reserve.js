'use strict';
/**
 * US reserved periods, v2 — the machine-readable half of `HOLDOUT_US_2026-09-05.md`.
 *
 * The document is authoritative for *why*; this file is authoritative for *what*,
 * so that a research script cannot quietly disagree with it. EXP-026 taught the
 * cost of the alternative: a window that lives only in prose moves without anyone
 * touching the source, and a FROZEN experiment silently changed population.
 *
 * The v1 US holdout (2024-01-01 onward) was BURNED by EXP-047 and can never be
 * un-burned. Nothing here restores it; these are its replacements.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Absolute dates, never relative tokens. A `range=25y` boundary slides one
 *  session per day, which would make a reserve's own edge depend on when it is
 *  opened — the defect this constant exists to prevent. */
const RESERVE = {
  B: {
    id: 'RESERVE-US-B',
    from: '2001-04-09',          // Nasdaq decimalization complete; see doc §2
    to: '2006-09-04',
    direction: 'backward',
    admits: 'mechanism',         // NOT sufficient alone for timing/entry rules
  },
  F: {
    id: 'RESERVE-US-F',
    from: '2026-09-05',
    to: null,                    // open-ended; gated on anchor count, not a date
    direction: 'forward',
    admits: 'any',
  },
};

/** Already read. Free to explore; can never again serve as S3 evidence. */
const SPENT = {
  discovery: { from: '2007-02-28', to: '2018-12-31' },
  validation: { from: '2019-01-01', to: '2023-12-29' },
  burned: { from: '2024-01-01', to: '2026-09-01', burnedBy: 'EXP-047' },
};

/** Frozen cross-section. If this changes, the reserve's universe changes and the
 *  definition must be re-issued under a new date rather than edited. */
const UNIVERSE_SHA256_PREFIX = 'bbf75253052844b3';

/** S1/S3 both require >= 30 independent anchors (PROMOTION_CONTRACT.md). */
const MIN_ANCHORS = 30;

const iso = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const within = (d, w) => d >= w.from && (w.to === null || d <= w.to);

/** Which partition a session belongs to. Dates before RESERVE.B.from are BELOW_FLOOR
 *  — inadmissible for geometry-sensitive work because of the pre-decimal tick grid. */
function classify(date) {
  const d = iso(date);
  if (d < RESERVE.B.from) return 'BELOW_FLOOR';
  if (within(d, RESERVE.B)) return 'RESERVE_B';
  if (within(d, SPENT.discovery)) return 'DISCOVERY';
  if (within(d, SPENT.validation)) return 'VALIDATION';
  if (within(d, SPENT.burned)) return 'BURNED';
  if (within(d, RESERVE.F)) return 'RESERVE_F';
  // Two short gaps land here, both fetched-but-never-read:
  //   2006-09-05 .. 2007-02-27  (us_signal_history starts 2007-02-28)
  //   2026-09-02 .. 2026-09-04  (EXP-047 stopped at 2026-09-01)
  // Treated as SPENT rather than reserved because neither is long enough to be a
  // holdout — ~120 and 3 sessions, 6 and 0 anchors at H=20 against a bar of 30.
  // Calling a 6-anchor window a reserve would be exactly the small-n artefact
  // PROMOTION_CONTRACT.md S2 says to report as unresolvable.
  return 'SPENT_UNREAD';
}

/**
 * Refuse reserve data unless it was explicitly opened. Mirrors
 * `research/candlestick/exp028_oos.js` — the refusal prints why, because a guard
 * that fails silently teaches nothing.
 *
 * @param {string[]|Date[]} dates  sessions the caller is about to compute over
 * @param {{openHoldout?: boolean, reserve?: 'B'|'F', label?: string}} opts
 */
function assertAdmissible(dates, opts = {}) {
  const { openHoldout = false, reserve = null, label = 'this run' } = opts;
  const seen = new Set(dates.map(classify));

  const belowFloor = seen.has('BELOW_FLOOR');
  if (belowFloor) {
    throw new Error(
      `${label} includes sessions before ${RESERVE.B.from}, the decimalization floor.\n` +
      '  Pre-decimal US bars quote in sixteenths, so range, gap and stop-hit geometry\n' +
      '  belong to a different instrument. See HOLDOUT_US_2026-09-05.md §2.');
  }

  for (const key of ['B', 'F']) {
    const tag = key === 'B' ? 'RESERVE_B' : 'RESERVE_F';
    if (!seen.has(tag)) continue;
    if (openHoldout && reserve === key) continue;
    throw new Error(
      `${label} would read ${RESERVE[key].id} (${RESERVE[key].from} .. ${RESERVE[key].to || 'onward'}).\n` +
      `  This is a SINGLE-USE reserved period. Reading it spends it permanently.\n` +
      `  Pass --open-holdout and set reserve='${key}' only after the candidate's\n` +
      '  definition and policy are frozen and hashed, per PROMOTION_CONTRACT.md S3.\n' +
      (key === 'F'
        ? '  RESERVE-US-F additionally requires passing RESERVE-US-B first (doc §4).\n'
        : ''));
  }
  return true;
}

/** SQL fragment excluding both reserves — for ordinary exploratory work. */
function sqlExcludeReserves(col = 'date') {
  return `(${col} > '${RESERVE.B.to}' AND ${col} < '${RESERVE.F.from}')`;
}

/** Hash of the definition document, so a silently edited boundary is detectable. */
function definitionHash() {
  const p = path.join(__dirname, '..', '..', 'HOLDOUT_US_2026-09-05.md');
  if (!fs.existsSync(p)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
}

module.exports = {
  RESERVE, SPENT, MIN_ANCHORS, UNIVERSE_SHA256_PREFIX,
  classify, assertAdmissible, sqlExcludeReserves, definitionHash,
};
