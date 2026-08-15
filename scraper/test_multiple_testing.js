// Tests for EXP-028's multiple-testing layer.
//
// This is the guard against 101 patterns x 4 horizons manufacturing winners out
// of noise, so it is worth more scrutiny than the thing it guards. Benjamini-
// Hochberg in particular has one step that is easy to omit and impossible to
// notice afterwards: the monotonicity sweep.
'use strict';

const assert = require('assert');
const mt = require('./research/candlestick/multiple_testing');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

console.log('\none-sample test');
test('a mean of zero is not significant', () => {
  const r = mt.oneSampleP([-1, 1, -1, 1, -1, 1, -1, 1]);
  assert.ok(near(r.mean, 0));
  assert.ok(r.p > 0.9, `p=${r.p}`);
});

test('a consistent non-zero mean is', () => {
  const v = Array.from({ length: 100 }, (_, i) => 1 + ((i % 5) - 2) * 0.1);
  const r = mt.oneSampleP(v);
  assert.ok(r.p < 1e-6, `p=${r.p}`);
  assert.strictEqual(r.n, 100);
});

test('sd uses n-1, not n', () => {
  // values 2,4,4,4,5,5,7,9: population sd = 2, sample sd = 2.13809...
  const r = mt.oneSampleP([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.ok(near(r.sd, 2.1380899, 1e-5), `sd=${r.sd}`);
});

test('too few points yields nulls rather than a confident nonsense', () => {
  const r = mt.oneSampleP([1, 2]);
  assert.strictEqual(r.p, null);
});

test('zero variance cannot produce an infinite t', () => {
  const r = mt.oneSampleP([3, 3, 3, 3, 3]);
  assert.strictEqual(r.p, null);
});

console.log('\nBenjamini-Hochberg');
test('the classic worked example rejects the right number', () => {
  // Benjamini & Hochberg 1995, table 1 p-values, alpha 0.05, m=15 -> 4 rejections
  const ps = [0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344,
              0.0459, 0.3240, 0.4262, 0.5719, 0.6528, 0.7590, 1.000];
  const entries = ps.map(p => ({ p }));
  const r = mt.benjaminiHochberg(entries, 0.05);
  assert.strictEqual(r.m, 15);
  assert.strictEqual(r.rejected, 4, `rejected=${r.rejected}`);
});

test('q-values are monotone — the step that is easy to skip', () => {
  const ps = [0.01, 0.02, 0.03, 0.04, 0.05, 0.9];
  const entries = ps.map(p => ({ p }));
  mt.benjaminiHochberg(entries, 0.05);
  const qs = entries.map(e => e.q);
  for (let i = 1; i < qs.length; i++) {
    assert.ok(qs[i] >= qs[i - 1] - 1e-12, `q not monotone at ${i}: ${qs[i - 1]} -> ${qs[i]}`);
  }
});

test('q is never above 1', () => {
  const entries = [{ p: 0.9 }, { p: 0.95 }, { p: 0.99 }];
  mt.benjaminiHochberg(entries, 0.05);
  for (const e of entries) assert.ok(e.q <= 1, `q=${e.q}`);
});

test('pure noise gets almost nothing through, which is the whole point', () => {
  // 400 uniform p-values, deterministic: at alpha .05 BH should reject ~0
  const entries = Array.from({ length: 400 }, (_, i) => ({ p: (i + 0.5) / 400 }));
  const r = mt.benjaminiHochberg(entries, 0.05);
  assert.ok(r.rejected <= 1, `rejected=${r.rejected} from uniform p-values`);
});

test('a real signal buried in 400 noise tests still surfaces', () => {
  const entries = Array.from({ length: 400 }, (_, i) => ({ p: (i + 0.5) / 400 }));
  entries.push({ p: 1e-8 }, { p: 1e-7 }, { p: 1e-6 });
  const r = mt.benjaminiHochberg(entries, 0.05);
  assert.ok(r.rejected >= 3, `rejected=${r.rejected}`);
});

test('untestable rows pass through and do NOT inflate m', () => {
  const entries = [{ p: 0.001 }, { p: null }, { p: 0.002 }, { p: undefined }];
  const r = mt.benjaminiHochberg(entries, 0.05);
  assert.strictEqual(r.m, 2, 'only computable tests count towards m');
  assert.strictEqual(entries[1].q, null);
  assert.strictEqual(entries[1].rejected, false);
});

console.log('\nevidence tiers');
test('tiers follow the spec thresholds exactly', () => {
  assert.strictEqual(mt.evidenceTier(29), 'INSUFFICIENT_DATA');
  assert.strictEqual(mt.evidenceTier(30), 'EXPLORATORY');
  assert.strictEqual(mt.evidenceTier(99), 'EXPLORATORY');
  assert.strictEqual(mt.evidenceTier(100), 'BASELINE_ELIGIBLE');
  assert.strictEqual(mt.evidenceTier(null), 'INSUFFICIENT_DATA');
});

console.log('\nnon-overlapping anchors');
test('spacing is measured on the exchange index, not array position', () => {
  // Sessions 0,1,2,50,51,52 — a filtered array whose positions lie about gaps
  const rows = [0, 1, 2, 50, 51, 52].map(sessionIndex => ({ sessionIndex }));
  const out = mt.nonOverlappingAnchors(rows, 5);
  assert.deepStrictEqual(out.map(r => r.sessionIndex), [0, 50]);
});

test('every kept pair really is at least H sessions apart', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ sessionIndex: i * 3 }));
  for (const H of [1, 3, 5, 10]) {
    const out = mt.nonOverlappingAnchors(rows, H);
    for (let i = 1; i < out.length; i++) {
      assert.ok(out[i].sessionIndex - out[i - 1].sessionIndex >= H,
        `H=${H} gap ${out[i].sessionIndex - out[i - 1].sessionIndex}`);
    }
  }
});

test('H=1 keeps everything, since consecutive windows cannot overlap', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ sessionIndex: i }));
  assert.strictEqual(mt.nonOverlappingAnchors(rows, 1).length, 10);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
