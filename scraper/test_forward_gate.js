/**
 * Tests for modules/forward_gate.js — the promotion gate the 2026-08-03 review
 * found was printing requirements it never evaluated (P0.6) against a sample
 * unit that was not independent (P0.7).
 */
'use strict';

const assert = require('assert');
const fg = require('./modules/forward_gate');

/** A record that clears every criterion, used as the baseline to perturb from. */
const PASSING = {
  rebalanceDecisions: 30, calendarMonths: 14, distinctRegimes: 3,
  fills: 80, profitFactor: 1.4, excessReturn: 0.06,
};

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n          ${e.message}`); }
}

console.log('\nforward_gate — profitFactor');

t('computes gross profit over gross loss', () => {
  assert.strictEqual(fg.profitFactor([10, -5, 5, -5]), 1.5);
});

t('returns null on an empty record rather than a number a gate would compare', () => {
  assert.strictEqual(fg.profitFactor([]), null);
});

t('returns null when every value is non-finite', () => {
  assert.strictEqual(fg.profitFactor([null, undefined, NaN]), null);
});

t('returns Infinity for wins with no losses, not null', () => {
  // A flawless record must not read as "no record". Infinity >= 1.10 is true,
  // which is the correct answer; null would be silently treated as missing.
  assert.strictEqual(fg.profitFactor([3, 4]), Infinity);
});

t('returns 0 for an all-losing record — a real value, not "no record"', () => {
  assert.strictEqual(fg.profitFactor([-3, -4]), 0);
  assert.strictEqual(fg.evaluateForwardGate({ ...PASSING, profitFactor: 0 }).status, 'NOT_ELIGIBLE');
});

console.log('\nforward_gate — informationRatio');

t('is null with fewer than two periods', () => {
  assert.strictEqual(fg.informationRatio([0.01], [0.005], 10), null);
});

t('is null when excess return has no dispersion, not a huge number', () => {
  // The exact trap that produced a 7.2e15 "information ratio" in the IC code:
  // a constant series leaves float residue in the standard deviation.
  const p = [0.02, 0.02, 0.02, 0.02], b = [0.01, 0.01, 0.01, 0.01];
  assert.strictEqual(fg.informationRatio(p, b, 10), null);
});

t('is positive when the portfolio consistently beats the benchmark', () => {
  const ir = fg.informationRatio([0.03, 0.01, 0.04, 0.02], [0.01, 0.005, 0.01, 0.012], 10);
  assert.ok(ir > 0, `expected > 0, got ${ir}`);
});

t('is negative when the portfolio consistently loses to the benchmark', () => {
  const ir = fg.informationRatio([0.01, 0.005, 0.00, 0.002], [0.03, 0.01, 0.04, 0.012], 10);
  assert.ok(ir < 0, `expected < 0, got ${ir}`);
});

t('annualises by rebalance frequency, so a faster cadence scales the ratio up', () => {
  const p = [0.03, 0.01, 0.04, 0.02], b = [0.01, 0.005, 0.01, 0.012];
  assert.ok(fg.informationRatio(p, b, 5) > fg.informationRatio(p, b, 20));
});

console.log('\nforward_gate — maxDrawdown / compound');

t('compounds fractional returns into an equity curve from 1', () => {
  const eq = fg.compound([0.1, -0.1]);
  assert.ok(Math.abs(eq[1] - 0.99) < 1e-12, `got ${eq[1]}`);
});

t('measures drawdown from the running peak', () => {
  assert.ok(Math.abs(fg.maxDrawdown([1, 1.5, 1.2, 1.8]) - 0.2) < 1e-12);
});

t('is zero for a monotonically rising curve', () => {
  assert.strictEqual(fg.maxDrawdown([1, 1.1, 1.2]), 0);
});

console.log('\nforward_gate — distinctRegimes');

t('counts distinct labels and ignores empty ones', () => {
  assert.strictEqual(fg.distinctRegimes(['BULL', 'BULL', 'BEAR', null, '']), 2);
});

console.log('\nforward_gate — evaluateForwardGate');

t('a fully qualifying record is eligible for review', () => {
  assert.strictEqual(fg.evaluateForwardGate(PASSING).status, 'ELIGIBLE_FOR_REVIEW');
});

t('an uncomputed profit factor FAILS instead of silently passing', () => {
  // This is P0.6 exactly: the old promote gate compared `undefined < 1.10`,
  // which is false, so an uncomputed profit factor passed the check.
  const r = fg.evaluateForwardGate({ ...PASSING, profitFactor: undefined });
  assert.strictEqual(r.status, 'NOT_ELIGIBLE');
  assert.ok(r.failed.includes('profit factor'));
});

t('a null profit factor also fails', () => {
  assert.strictEqual(fg.evaluateForwardGate({ ...PASSING, profitFactor: null }).status, 'NOT_ELIGIBLE');
});

t('a null excess return fails rather than being treated as zero', () => {
  const r = fg.evaluateForwardGate({ ...PASSING, excessReturn: null });
  assert.ok(r.failed.includes('excess over the eligible universe, net of costs'));
});

t('exactly matching the benchmark is not enough — excess must be strictly positive', () => {
  assert.strictEqual(fg.evaluateForwardGate({ ...PASSING, excessReturn: 0 }).status, 'NOT_ELIGIBLE');
});

t('many fills cannot substitute for few decisions (P0.7)', () => {
  // 240 positions from 5 rebalances is 5 observations, not 240. The old gate
  // counted trades and would have passed this.
  const r = fg.evaluateForwardGate({ ...PASSING, rebalanceDecisions: 5, fills: 240 });
  assert.strictEqual(r.status, 'NOT_ELIGIBLE');
  assert.ok(r.failed.includes('independent rebalance decisions (LIVE)'));
});

t('a record confined to one market regime is not eligible', () => {
  const r = fg.evaluateForwardGate({ ...PASSING, distinctRegimes: 1 });
  assert.ok(r.failed.includes('distinct market regimes covered'));
});

t('a short record fails on calendar duration even with enough decisions', () => {
  const r = fg.evaluateForwardGate({ ...PASSING, calendarMonths: 3 });
  assert.ok(r.failed.includes('calendar months of LIVE record'));
});

t('reports every failed criterion, not just the first', () => {
  const r = fg.evaluateForwardGate({
    rebalanceDecisions: 0, calendarMonths: 0, distinctRegimes: 0,
    fills: 0, profitFactor: null, excessReturn: null,
  });
  assert.strictEqual(r.failed.length, 6);
});

t('surfaces excluded replay decisions instead of hiding them', () => {
  const r = fg.evaluateForwardGate({ ...PASSING, replayDecisions: 19 });
  assert.strictEqual(r.replayDecisionsExcluded, 19);
});

t('an invalid ledger blocks the gate outright, it does not merely warn', () => {
  // Rows without units/cost_basis read as costing nothing, so cash and NAV are
  // wrong and every metric built on them is meaningless (review P1.3).
  const r = fg.evaluateForwardGate({ ...PASSING, ledgerValid: false });
  assert.strictEqual(r.status, 'NOT_ELIGIBLE');
  assert.ok(r.failed.some(f => /units and a cost basis/.test(f)), JSON.stringify(r.failed));
});

t('a valid ledger does not add a criterion', () => {
  assert.strictEqual(fg.evaluateForwardGate({ ...PASSING, ledgerValid: true }).status, 'ELIGIBLE_FOR_REVIEW');
  assert.strictEqual(fg.evaluateForwardGate(PASSING).status, 'ELIGIBLE_FOR_REVIEW');
});

t('eligibility is explicitly not an instruction to deploy capital', () => {
  assert.ok(/not an instruction to deploy capital/i.test(fg.evaluateForwardGate(PASSING).note));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
