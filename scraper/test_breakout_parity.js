// Parity between modules/breakout.js and the frozen EXP-025 implementation.
//
// EXP-026 twice re-described EXP-025's breakout contract and twice got it wrong
// (R0 used an intraday +5% touch, R1 used a window that included the entry bar).
// The review's acceptance criterion for closing that P2 was a DETERMINISTIC
// PARITY TEST against the canonical implementation, not an argument that the
// difference probably does not matter.
//
// The reference below is transcribed from backtest_precursor_trajectory.js:
//
//     for (let k = i - HIGH_LOOKBACK; k < i; k++) { ... }   // i-20 .. i-1
//     priorHigh.set(`${t}|${sessions[i]}`, hi);
//     ...
//     isWinner = ret >= WIN_THRESHOLD && p1 > hi;
//
// It is a copy ON PURPOSE: a test that imports the thing it is testing proves
// nothing. This file is the second opinion.
//
// No database. Runs in CI.
'use strict';

const assert = require('assert');
const bo = require('./modules/breakout');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

/** EXP-025's logic, transcribed, operating on the same inputs. */
function exp025Reference(series, sessions, i) {
  const H = 5, LOOK = 20, WIN = 5;
  if (i < LOOK) return null;
  const entry = series.get(sessions[i]);
  const exitDate = sessions[i + H];
  if (!entry || !exitDate) return null;
  const exit = series.get(exitDate);
  if (!exit) return null;
  let hi = -Infinity;
  for (let k = i - LOOK; k < i; k++) {
    const c = series.get(sessions[k]);
    if (c === undefined) return null;
    if (c.c > hi) hi = c.c;
  }
  const ret = (exit.c / entry.c - 1) * 100;
  return ret >= WIN && exit.c > hi;
}

// A deterministic pseudo-random price generator: same series every run.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSeries(seed, n, { holes = [] } = {}) {
  const rnd = mulberry32(seed);
  const sessions = [];
  const series = new Map();
  let px = 1000;
  for (let k = 0; k < n; k++) {
    const d = `2026-${String(1 + Math.floor(k / 28)).padStart(2, '0')}-${String(1 + (k % 28)).padStart(2, '0')}`;
    sessions.push(d);
    px = Math.max(50, px * (1 + (rnd() - 0.48) * 0.06));
    if (!holes.includes(k)) series.set(d, { c: Math.round(px * 100) / 100 });
  }
  return { sessions, series };
}

console.log('\nbreakout parity — modules/breakout.js vs the frozen EXP-025 implementation');
{
  // Sweep many seeds and every entry index: the two must agree on EVERY case,
  // including the nulls.
  let compared = 0, agreed = 0, winners = 0, excluded = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const { sessions, series } = buildSeries(seed, 120);
    for (let i = 0; i < sessions.length; i++) {
      const mine = bo.genuineBreakout(series, sessions, i);
      const ref = exp025Reference(series, sessions, i);
      compared++;
      const mineVal = mine === null ? null : mine.winner;
      if (mineVal === ref) agreed++;
      if (ref === true) winners++;
      if (ref === null) excluded++;
    }
  }
  test(`agrees on all ${compared} generated cases`, () =>
    assert.strictEqual(agreed, compared, `${compared - agreed} disagreements`));
  test('the sweep actually produced winners (the test is not vacuous)', () =>
    assert.ok(winners > 50, `only ${winners} winners`));
  test('the sweep actually produced exclusions', () =>
    assert.ok(excluded > 50, `only ${excluded} exclusions`));
}

console.log('\nthe window is STRICTLY BEFORE entry — the bar this got wrong in R1');
{
  // Entry bar is the highest close in i-19..i, but NOT in i-20..i-1.
  // Under R1's bounds the entry bar raises the bar to clear; under EXP-025's it
  // does not. Constructed so the two disagree if the bounds are wrong.
  const sessions = [];
  const series = new Map();
  for (let k = 0; k < 30; k++) {
    const d = `d${String(k).padStart(2, '0')}`;
    sessions.push(d);
    // flat at 100 for the prior window, entry spikes to 130, exit at 132
    let c = 100;
    if (k === 20) c = 130;          // entry bar: a new high by itself
    if (k === 25) c = 132;          // exit bar: +1.5% over entry
    series.set(d, { c });
  }
  const i = 20;
  const r = bo.genuineBreakout(series, sessions, i);
  test('prior high excludes the entry bar (100, not 130)', () =>
    assert.strictEqual(r.priorHigh, 100, `priorHigh=${r.priorHigh}`));
  test('forward return is measured entry->exit', () =>
    assert.ok(Math.abs(r.forwardReturnPct - ((132 / 130 - 1) * 100)) < 1e-9, String(r.forwardReturnPct)));
  test('and it is NOT a winner, because +1.5% < +5% threshold', () =>
    assert.strictEqual(r.winner, false));
  test('the reference implementation agrees exactly', () =>
    assert.strictEqual(exp025Reference(series, sessions, i), r.winner));
}

console.log('\nboth conditions are required, and both are load-bearing');
{
  const mk = (entryC, exitC, priorC) => {
    const sessions = [], series = new Map();
    for (let k = 0; k < 30; k++) {
      const d = `s${String(k).padStart(2, '0')}`;
      sessions.push(d);
      let c = priorC;
      if (k === 20) c = entryC;
      if (k === 25) c = exitC;
      series.set(d, { c });
    }
    return { sessions, series };
  };
  // +10% forward but exit does NOT clear the prior high -> not a breakout
  let { sessions, series } = mk(100, 110, 200);
  test('+10% forward that fails to clear the prior high is NOT a breakout', () =>
    assert.strictEqual(bo.genuineBreakout(series, sessions, 20).winner, false));
  // clears the prior high but only +2% forward -> not a breakout
  ({ sessions, series } = mk(100, 102, 90));
  test('clearing the prior high on only +2% is NOT a breakout', () =>
    assert.strictEqual(bo.genuineBreakout(series, sessions, 20).winner, false));
  // both -> breakout
  ({ sessions, series } = mk(100, 112, 105));
  test('+12% forward AND clearing the prior high IS a breakout', () =>
    assert.strictEqual(bo.genuineBreakout(series, sessions, 20).winner, true));
  test('the reference agrees on all three', () => {
    for (const [e, x, p, want] of [[100, 110, 200, false], [100, 102, 90, false], [100, 112, 105, true]]) {
      const s = mk(e, x, p);
      assert.strictEqual(exp025Reference(s.series, s.sessions, 20), want);
    }
  });
}

console.log('\nincomplete windows are EXCLUDED, never silently false');
{
  const { sessions, series } = buildSeries(7, 60, { holes: [10] });   // hole inside i-20..i-1 for i=25
  test('a hole in the prior window returns null (excluded)', () =>
    assert.strictEqual(bo.genuineBreakout(series, sessions, 25), null));
  test('the reference also excludes it', () =>
    assert.strictEqual(exp025Reference(series, sessions, 25), null));
  test('too little history returns null rather than guessing', () =>
    assert.strictEqual(bo.genuineBreakout(series, sessions, 5), null));
  const missingExit = buildSeries(9, 60, { holes: [30] });
  test('a missing EXIT bar is excluded too', () =>
    assert.strictEqual(bo.genuineBreakout(missingExit.series, missingExit.sessions, 25), null));
}

console.log('\nthe frozen constants are the EXP-025 ones');
{
  test('threshold 5%, horizon 5 sessions, lookback 20', () => {
    assert.strictEqual(bo.WIN_THRESHOLD_PCT, 5);
    assert.strictEqual(bo.HORIZON_SESSIONS, 5);
    assert.strictEqual(bo.HIGH_LOOKBACK, 20);
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
