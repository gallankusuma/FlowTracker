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

console.log('\nperiodReturns — weights come from the ledger, not the plan');

t('a fully invested book returns the weighted move', () => {
  // The ledger and the plan must DISAGREE here, or the test proves nothing.
  // The first version of this case used target_json '[]' and asserted 0, which
  // the reverted plan-based implementation also returns — it passed either way.
  // So the plan here names a THIRD ticker that was never filled: a plan-based
  // reading would price CCC's +50%, the ledger correctly ignores it.
  const ctx = makeCtx({ AAA: move(100, 110), BBB: move(100, 90), CCC: move(100, 150) });
  const log = LOG.map(l => ({ ...l, target_json: '["AAA","BBB","CCC"]' }));
  const rows = [
    { ticker: 'AAA', entry_date: DATES[1], exit_date: null, weight: 0.5 },
    { ticker: 'BBB', entry_date: DATES[1], exit_date: null, weight: 0.5 },
  ];
  const { port } = periodReturns(ctx, log, rows);
  // +10% and -10% at half weight each nets to zero. An unweighted mean over the
  // planned book would have returned (0.10 - 0.10 + 0.50) / 3 = +16.67%.
  assert.ok(Math.abs(port[0] - 0) < 1e-9, `got ${(port[0] * 100).toFixed(2)}% — a plan-based reading gives +16.67%`);
});

t('the ledger ignores a planned name that never filled', () => {
  const ctx = makeCtx({ AAA: move(100, 100), GHOST: move(100, 300) });
  const log = LOG.map(l => ({ ...l, target_json: '["AAA","GHOST"]' }));
  const rows = [{ ticker: 'AAA', entry_date: DATES[1], exit_date: null, weight: 0.5 }];
  const { port } = periodReturns(ctx, log, rows);
  assert.strictEqual(port[0], 0, 'GHOST was planned but never filled and must contribute nothing');
});

t('a PARTIAL fill earns nothing on the unfilled slice — the old mean reinvested it', () => {
  // Two of four intended names filled, so recorded weights sum to 0.5.
  const ctx = makeCtx({ AAA: move(100, 120), BBB: move(100, 120) });
  const rows = [
    { ticker: 'AAA', entry_date: DATES[1], exit_date: null, weight: 0.25 },
    { ticker: 'BBB', entry_date: DATES[1], exit_date: null, weight: 0.25 },
  ];
  const { port } = periodReturns(ctx, LOG, rows);
  // Half the book at +20% is +10%. An unweighted mean over the filled names
  // would have said +20%, silently reinvesting the idle cash.
  assert.ok(Math.abs(port[0] - 0.10) < 1e-9, `expected +10%, got ${(port[0] * 100).toFixed(2)}%`);
});

t('a position that failed to SELL still counts — it used to vanish', () => {
  // STUCK is absent from every target_json (it is what the strategy wanted out
  // of), so the plan-based version could never see it. It is in the ledger.
  const ctx = makeCtx({ STUCK: move(100, 80) });
  const rows = [{ ticker: 'STUCK', entry_date: DATES[0], exit_date: null, weight: 1.0 }];
  const { port } = periodReturns(ctx, LOG, rows);
  assert.ok(Math.abs(port[0] - (-0.20)) < 1e-9, `expected -20%, got ${(port[0] * 100).toFixed(2)}%`);
});

t('a HALTED holding is marked at its last real close, not dropped', () => {
  // No print on the final bar. The old code required p1 > 0 and skipped the
  // name, so a position going untradeable contributed 0.00% instead of a loss.
  const ctx = makeCtx({ HALT: [
    { open: 100, close: 100 }, { open: 100, close: 100 },
    { open: 70, close: 70 }, { open: 0, close: null },
  ] });
  const rows = [{ ticker: 'HALT', entry_date: DATES[0], exit_date: null, weight: 1.0 }];
  const { port } = periodReturns(ctx, LOG, rows);
  assert.ok(Math.abs(port[0] - (-0.30)) < 1e-9, `expected -30% from the last real close, got ${(port[0] * 100).toFixed(2)}%`);
});

t('a position entered AFTER the window opens earns nothing in it, but still pays to enter', () => {
  // Entering ON the closing boundary is the boundary case worth pinning: the
  // name contributes no price return to this period because it was not held
  // through any of it, yet the entry cost is real and lands here.
  const ctx = makeCtx({ LATE: move(100, 200) });
  const rows = [{ ticker: 'LATE', entry_date: DATES[3], exit_date: null, weight: 1.0 }];
  const { port } = periodReturns(ctx, LOG, rows);
  assert.ok(Math.abs(port[0] - (-0.0020)) < 1e-9,
    `expected only the buy cost and none of the +100% move, got ${port[0]}`);
});

t('a position exited BEFORE the window opens is not counted in it', () => {
  const ctx = makeCtx({ GONE: move(100, 200) });
  const rows = [{ ticker: 'GONE', entry_date: DATES[0], exit_date: DATES[1], weight: 1.0 }];
  const { port } = periodReturns(ctx, LOG, rows);
  assert.strictEqual(port[0], 0);
});

console.log('\nperiodReturns — costs come from events that happened');

t('an entry at the period boundary is charged the buy cost', () => {
  const ctx = makeCtx({ NEW: flat(100) });
  const rows = [{ ticker: 'NEW', entry_date: DATES[3], exit_date: null, weight: 1.0 }];
  const { port } = periodReturns(ctx, LOG, rows);
  assert.ok(Math.abs(port[0] - (-0.0020)) < 1e-9, `expected the 0.20% buy cost, got ${port[0]}`);
});

t('an exit at the period boundary is charged the sell cost', () => {
  const ctx = makeCtx({ OUT: flat(100) });
  const rows = [{ ticker: 'OUT', entry_date: DATES[0], exit_date: DATES[3], weight: 1.0 }];
  const { port } = periodReturns(ctx, LOG, rows);
  // Held flat through the window, sold at the boundary: only the sell cost.
  assert.ok(Math.abs(port[0] - (-0.0030)) < 1e-9, `expected the 0.30% sell cost, got ${port[0]}`);
});

t('re-entering from flat is NOT free — the old churn term made it so', () => {
  // The previous book was empty, so `book.length ? ... : 0` gave churn 0 and
  // charged nothing for putting the whole portfolio back on.
  const ctx = makeCtx({ A: flat(100), B: flat(100) });
  const rows = [
    { ticker: 'A', entry_date: DATES[3], exit_date: null, weight: 0.5 },
    { ticker: 'B', entry_date: DATES[3], exit_date: null, weight: 0.5 },
  ];
  const { port, avgTurnover } = periodReturns(ctx, LOG, rows);
  assert.ok(port[0] < 0, 'entering a full book must cost something');
  assert.ok(Math.abs(avgTurnover - 1.0) < 1e-9, `turnover should be the full book, got ${avgTurnover}`);
});

console.log('\nperiodReturns — regime labels');

t('regimes come from the recorded label, never from the reason string', () => {
  // INSUFFICIENT_UNIVERSE is a data outage. Deriving the label from `reason`
  // made an outage count as a market regime, which is what let the 3-regime
  // gate be satisfied only by something being broken (review P1.1).
  const ctx = makeCtx({ A: flat(100) });
  const log = [
    { as_of_date: DATES[0], exposure: 1, reason: 'INSUFFICIENT_UNIVERSE (3 < 20) — book unchanged', regime_label: 'BULL', target_json: '[]' },
    { as_of_date: DATES[2], exposure: 1, reason: 'REGIME_FLAT — IHSG below its own 200d SMA', regime_label: 'BULL', target_json: '[]' },
  ];
  const { regimes } = periodReturns(ctx, log, []);
  assert.deepStrictEqual(regimes, ['BULL'], JSON.stringify(regimes));
});

t('a missing label is null, not a fabricated regime', () => {
  const ctx = makeCtx({ A: flat(100) });
  const log = [
    { as_of_date: DATES[0], exposure: 1, reason: 'INVESTED', regime_label: null, target_json: '[]' },
    { as_of_date: DATES[2], exposure: 1, reason: 'INVESTED', regime_label: null, target_json: '[]' },
  ];
  const { regimes } = periodReturns(ctx, log, []);
  assert.deepStrictEqual(regimes, [null]);
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
