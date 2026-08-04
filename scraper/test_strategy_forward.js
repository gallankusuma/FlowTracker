/**
 * Tests for the forward recorder's ledger accounting (review P1.4).
 *
 * The 2026-08-04 review's remaining findings all lived in the LIVE ledger, and
 * nothing exercised it: the golden fixture covers strategy_book plus backtest
 * execution, and the unit suites cover execution.js and forward_gate.js one
 * layer down, but the glue that turns a plan into positions and positions into
 * a performance number was untested.
 *
 * `periodReturns` is pure given (ctx, logRows, positionRows), so the part that
 * actually got the numbers wrong is testable with a fixture and no database.
 * Each case below is one of the specific ways the old plan-based version lied.
 */
'use strict';

const assert = require('assert');
const { periodReturns } = require('./strategy_forward');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n          ${e.message}`); }
}

// Three trading dates. Decisions sit at index 0 and 2, so the holding period
// runs from the execution bar after the first (1) to the execution bar after
// the second (3) -- hence four bars.
const DATES = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];

function makeCtx(seriesSpec) {
  const series = new Map();
  for (const [ticker, bars] of Object.entries(seriesSpec)) {
    series.set(ticker, {
      open: bars.map(b => b.open), high: bars.map(b => b.high ?? b.open),
      close: bars.map(b => b.close), value: bars.map(() => 10e9),
      dn0: bars.map(() => 0.5), dn0Raw: bars.map(() => 0.5),
    });
  }
  return {
    tradingDates: DATES,
    dateIdx: new Map(DATES.map((d, i) => [d, i])),
    series,
    ihsgClose: [1000, 1000, 1000, 1000],   // flat index: benchmark contributes 0
    ihsgSma: [null, null, null, null],
  };
}

const LOG = [
  { as_of_date: DATES[0], exposure: 1, reason: 'INVESTED', regime_label: 'BULL', target_json: '[]' },
  { as_of_date: DATES[2], exposure: 1, reason: 'INVESTED', regime_label: 'BEAR', target_json: '[]' },
];
// Period runs from bar 1 (exec after decision 0) to bar 3 (exec after decision 2).
const flat = p => [{ open: p, close: p }, { open: p, close: p }, { open: p, close: p }, { open: p, close: p }];
const move = (p0, p1) => [{ open: p0, close: p0 }, { open: p0, close: p0 }, { open: p0, close: p0 }, { open: p1, close: p1 }];

const { cashAt, navAt } = require('./strategy_forward');
const BUY_COST = 0.0020, SELL_COST = 0.0030;

/**
 * Build a ledger row the way cmdFill does: spend `spend` of the book at `px`,
 * receive units net of the buy fee. Exits carry proceeds net of the sell fee.
 * Costs are therefore INSIDE the NAV path and never added as a separate term.
 */
function pos(ticker, entryDate, entryPx, spend, exitDate, exitPx) {
  const units = (spend * (1 - BUY_COST)) / entryPx;
  return {
    ticker, entry_date: entryDate, exit_date: exitDate || null,
    units, cost_basis: spend,
    proceeds: exitDate ? units * exitPx * (1 - SELL_COST) : null,
    weight: spend, status: exitDate ? 'CLOSED' : 'OPEN',
  };
}

console.log('\nperiodReturns — one authoritative NAV series');

// port[0] is the DEPLOYMENT LEG added for review P1.1: INITIAL_CAPITAL to the
// NAV after the first execution, so the cost of opening the book is inside the
// reported return instead of sitting in its denominator. The first HOLDING
// period is therefore port[1].
const HOLD = 1;

t('the deployment leg charges the cost of opening the book', () => {
  const ctx = makeCtx({ AAA: flat(100) });
  const rows = [pos('AAA', DATES[1], 100, 1.0)];
  const { port } = periodReturns(ctx, LOG, rows);
  assert.ok(Math.abs(port[0] - (-BUY_COST)) < 1e-9,
    `expected the ${(BUY_COST * 100).toFixed(2)}% opening cost, got ${(port[0] * 100).toFixed(3)}%`);
});

t('with nothing bought, the deployment leg is flat rather than a loss', () => {
  const ctx = makeCtx({ AAA: flat(100) });
  const { port } = periodReturns(ctx, LOG, []);
  assert.ok(Math.abs(port[0]) < 1e-12, `got ${port[0]}`);
});

t('the NAV path, not a weighted price move, is what is reported', () => {
  // Half the book in each of two names, one +10% and one -10%.
  const ctx = makeCtx({ AAA: move(100, 110), BBB: move(100, 90), CCC: move(100, 150) });
  const log = LOG.map(l => ({ ...l, target_json: '["AAA","BBB","CCC"]' }));
  const rows = [pos('AAA', DATES[1], 100, 0.5), pos('BBB', DATES[1], 100, 0.5)];
  const { port } = periodReturns(ctx, log, rows);
  const nav0 = navAt(rows, ctx.series, 1, DATES[1]);
  const nav1 = navAt(rows, ctx.series, 3, DATES[3]);
  assert.ok(Math.abs(port[HOLD] - (nav1 / nav0 - 1)) < 1e-12, 'the holding period must BE the NAV ratio');
  // +10% and -10% cancel, so the book is flat. A plan-based reading would have
  // priced CCC, which was never bought, at (0.10 - 0.10 + 0.50) / 3 = +16.67%.
  assert.ok(Math.abs(port[HOLD]) < 1e-9, `expected flat, got ${(port[HOLD] * 100).toFixed(3)}%`);
});

t('a PARTIAL fill leaves the rest in cash and earns nothing on it', () => {
  // Two of four intended names filled: half the book deployed, half idle.
  const ctx = makeCtx({ AAA: move(100, 120), BBB: move(100, 120) });
  const rows = [pos('AAA', DATES[1], 100, 0.25), pos('BBB', DATES[1], 100, 0.25)];
  const { port } = periodReturns(ctx, LOG, rows);
  // Deployed half at +20% is about +10% on the book. An unweighted mean over
  // the filled names would have said +20%, reinvesting the idle cash.
  assert.ok(port[HOLD] > 0.095 && port[HOLD] < 0.105, `expected about +10%, got ${(port[HOLD] * 100).toFixed(3)}%`);
});

t('a position that failed to SELL still counts — it used to vanish', () => {
  // STUCK is absent from every target_json, so a plan-based reading is blind to
  // it. It is in the ledger, so the NAV sees the loss.
  const ctx = makeCtx({ STUCK: move(100, 80) });
  const rows = [pos('STUCK', DATES[0], 100, 1.0)];
  const { port } = periodReturns(ctx, LOG, rows);
  assert.ok(port[HOLD] < -0.19 && port[HOLD] > -0.21, `expected about -20%, got ${(port[HOLD] * 100).toFixed(3)}%`);
});

t('a HALTED holding is marked at its last real close, not dropped', () => {
  const ctx = makeCtx({ HALT: [
    { open: 100, close: 100 }, { open: 100, close: 100 },
    { open: 70, close: 70 }, { open: 0, close: null },
  ] });
  const rows = [pos('HALT', DATES[0], 100, 1.0)];
  const { port } = periodReturns(ctx, LOG, rows);
  assert.ok(port[HOLD] < -0.29 && port[HOLD] > -0.31, `expected about -30% from the last real close, got ${(port[HOLD] * 100).toFixed(3)}%`);
});

t('the ledger ignores a planned name that never filled', () => {
  const ctx = makeCtx({ AAA: move(100, 100), GHOST: move(100, 300) });
  const log = LOG.map(l => ({ ...l, target_json: '["AAA","GHOST"]' }));
  const rows = [pos('AAA', DATES[1], 100, 0.5)];
  const { port } = periodReturns(ctx, log, rows);
  assert.ok(Math.abs(port[HOLD]) < 1e-9, 'GHOST was planned, never filled, and must contribute nothing');
});

console.log('\ncashAt / navAt — the book cannot spend what it does not have');

t('cash falls by the cost basis and rises by the proceeds', () => {
  const rows = [pos('A', DATES[1], 100, 0.4, DATES[3], 150)];
  assert.ok(Math.abs(cashAt(rows, DATES[0]) - 1.0) < 1e-12, 'before entry the book is all cash');
  assert.ok(Math.abs(cashAt(rows, DATES[1]) - 0.6) < 1e-12, 'entry removes exactly the cost basis');
  const after = cashAt(rows, DATES[3]);
  assert.ok(after > 0.6, 'a profitable exit must return more than it cost');
});

t('a realized LOSS shrinks the book, so the next allocation shrinks with it', () => {
  // This is review P0.5. Under the old rule capacity was 1 - committedWeight,
  // which is blind to realized P&L: after this loss it would still authorise a
  // full notional 1.0 against a NAV of 0.8, funded by nothing.
  const ctx = makeCtx({ A: move(100, 100) });
  const rows = [pos('A', DATES[0], 100, 1.0, DATES[1], 80)];
  const cash = cashAt(rows, DATES[1]);
  assert.ok(cash < 0.81 && cash > 0.79, `expected about 0.80 of book left, got ${cash.toFixed(4)}`);
  const nav = navAt(rows, ctx.series, 1, DATES[1]);
  assert.ok(Math.abs(nav - cash) < 1e-12, 'with nothing held, NAV is cash');
});

t('NAV is cash plus the marked value of what is held', () => {
  const ctx = makeCtx({ A: move(100, 200) });
  const rows = [pos('A', DATES[1], 100, 0.5)];
  const nav = navAt(rows, ctx.series, 3, DATES[3]);
  const expected = 0.5 + (0.5 * (1 - BUY_COST) / 100) * 200;
  assert.ok(Math.abs(nav - expected) < 1e-12, `got ${nav}, expected ${expected}`);
});

t('a compounded weighted return and the NAV path disagree — the NAV path wins', () => {
  // The reviewer's own example: half stock, half cash, stock 100 -> 200 -> 300.
  // Weights fixed at entry compound to 1.875; the actual book is 2.00.
  const dates = ['d0', 'd1', 'd2', 'd3'];
  const series = new Map([['S', { open: [100, 100, 200, 300], high: [100, 100, 200, 300], close: [100, 100, 200, 300], value: [1, 1, 1, 1], dn0: [0, 0, 0, 0], dn0Raw: [0, 0, 0, 0] }]]);
  const rows = [{ ticker: 'S', entry_date: dates[1], exit_date: null, units: 0.005, cost_basis: 0.5, proceeds: null }];
  const navMid = 0.5 + 0.005 * 200;      // 1.5
  const navEnd = 0.5 + 0.005 * 300;      // 2.0
  assert.ok(Math.abs(navAt(rows, series, 2, dates[2]) - navMid) < 1e-12);
  assert.ok(Math.abs(navAt(rows, series, 3, dates[3]) - navEnd) < 1e-12);
  // The old method: +50% then +25%, compounding to 1.875 rather than 2.00.
  assert.ok(Math.abs(1.5 * 1.25 - 1.875) < 1e-12);
  assert.notStrictEqual(navEnd, 1.875);
});

console.log('\nperiodReturns — regime labels');

t('regimes come from the recorded label, never from the reason string', () => {
  const ctx = makeCtx({ A: flat(100) });
  const log = [
    { as_of_date: DATES[0], exposure: 1, reason: 'INSUFFICIENT_UNIVERSE (3 < 20) — book unchanged', regime_label: 'BULL', target_json: '[]' },
    { as_of_date: DATES[2], exposure: 1, reason: 'REGIME_FLAT — IHSG below its own 200d SMA', regime_label: 'BULL', target_json: '[]' },
  ];
  const { regimes } = periodReturns(ctx, log, []);
  // One label for the deployment leg, one for the holding period.
  assert.deepStrictEqual(regimes, ['BULL', 'BULL'], JSON.stringify(regimes));
});

t('a missing label is null, not a fabricated regime', () => {
  const ctx = makeCtx({ A: flat(100) });
  const log = [
    { as_of_date: DATES[0], exposure: 1, reason: 'INVESTED', regime_label: null, target_json: '[]' },
    { as_of_date: DATES[2], exposure: 1, reason: 'INVESTED', regime_label: null, target_json: '[]' },
  ];
  const { regimes } = periodReturns(ctx, log, []);
  assert.deepStrictEqual(regimes, [null, null]);
});

console.log('\nsnapshotHash — content, not shape');

const { snapshotHash } = require('./strategy_forward');

t('changing a close price changes the hash', () => {
  const a = makeCtx({ A: flat(100) });
  const b = makeCtx({ A: flat(100) });
  b.series.get('A').close[2] = 101;              // corrected in place, same row count
  assert.notStrictEqual(snapshotHash(a), snapshotHash(b));
});

t('changing a HIGH changes the hash — it is the 52-week rank numerator', () => {
  const a = makeCtx({ A: flat(100) });
  const b = makeCtx({ A: flat(100) });
  b.series.get('A').high[2] = 150;
  assert.notStrictEqual(snapshotHash(a), snapshotHash(b));
});

t('changing a traded VALUE changes the hash — it drives the liquidity screen', () => {
  const a = makeCtx({ A: flat(100) });
  const b = makeCtx({ A: flat(100) });
  b.series.get('A').value[2] = 1;
  assert.notStrictEqual(snapshotHash(a), snapshotHash(b));
});

t('changing a dn0 changes the hash', () => {
  const a = makeCtx({ A: flat(100) });
  const b = makeCtx({ A: flat(100) });
  b.series.get('A').dn0[2] = -0.9;
  b.series.get('A').dn0Raw[2] = -0.9;
  assert.notStrictEqual(snapshotHash(a), snapshotHash(b));
});

t('a dn0 restated ABOVE the clip bound still changes the hash', () => {
  // Both 120 and 950 clip to 100, so hashing the clipped value produced a
  // bit-identical digest for two genuinely different datasets — the exact
  // failure a content hash exists to prevent. The raw value is hashed.
  const a = makeCtx({ A: flat(100) });
  const b = makeCtx({ A: flat(100) });
  a.series.get('A').dn0[2] = 100; a.series.get('A').dn0Raw[2] = 120;
  b.series.get('A').dn0[2] = 100; b.series.get('A').dn0Raw[2] = 950;
  assert.notStrictEqual(snapshotHash(a), snapshotHash(b));
});

t('changing the IHSG series changes the hash — it decides invested vs flat', () => {
  const a = makeCtx({ A: flat(100) });
  const b = makeCtx({ A: flat(100) });
  b.ihsgClose[2] = 900;
  assert.notStrictEqual(snapshotHash(a), snapshotHash(b));
});

t('identical data hashes identically regardless of ticker insertion order', () => {
  const a = makeCtx({ AAA: flat(100), BBB: flat(200) });
  const b = makeCtx({ BBB: flat(200), AAA: flat(100) });
  assert.strictEqual(snapshotHash(a), snapshotHash(b));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
