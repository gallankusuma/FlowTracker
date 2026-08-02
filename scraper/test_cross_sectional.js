// Verification for modules/cross_sectional.js — the rank/IC primitives every
// cross-sectional diagnostic depends on. Toy cases with hand-computable answers,
// plus the exact tie behaviour IDX's ARA/ARB price limits make routine.
'use strict';

const assert = require('assert');
const cs = require('./modules/cross_sectional');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('\nrankTransform — average-rank, tie aware');
test('strictly increasing values get ranks 1..n in order', () => {
  assert.deepStrictEqual(cs.rankTransform([10, 20, 30]), [1, 2, 3]);
});
test('ranks follow value order, not input order', () => {
  assert.deepStrictEqual(cs.rankTransform([30, 10, 20]), [3, 1, 2]);
});
test('a tied pair shares the average of the positions it spans', () => {
  // values 10,10,30 occupy positions 1,2,3 -> tied pair averages to 1.5
  assert.deepStrictEqual(cs.rankTransform([10, 10, 30]), [1.5, 1.5, 3]);
});
test('an all-tied cross-section gives every element the same rank', () => {
  assert.deepStrictEqual(cs.rankTransform([7, 7, 7, 7]), [2.5, 2.5, 2.5, 2.5]);
});
test('negative and fractional values rank correctly', () => {
  assert.deepStrictEqual(cs.rankTransform([-1.5, 0, -2]), [2, 3, 1]);
});

console.log('\nspearmanIC');
test('perfectly monotonic agreement = +1', () => {
  assert.ok(Math.abs(cs.spearmanIC([1, 2, 3, 4], [10, 20, 30, 40]) - 1) < 1e-9);
});
test('perfectly monotonic disagreement = -1', () => {
  assert.ok(Math.abs(cs.spearmanIC([1, 2, 3, 4], [40, 30, 20, 10]) + 1) < 1e-9);
});
test('IC is rank-based: a monotone but non-linear return map still gives +1', () => {
  // Pearson on raw values would NOT be 1 here; Spearman must be.
  assert.ok(Math.abs(cs.spearmanIC([1, 2, 3, 4], [1, 4, 900, 10000]) - 1) < 1e-9);
});
test('below minObs returns null, not a fake 0', () => {
  assert.strictEqual(cs.spearmanIC([1, 2], [3, 4]), null);
});
test('mismatched array lengths return null rather than silently truncating', () => {
  assert.strictEqual(cs.spearmanIC([1, 2, 3], [1, 2]), null);
});
test('ARA/ARB-style tied forward returns do not crash and stay in [-1,1]', () => {
  // Four stocks all limit-up (identical capped return), scores all different.
  const ic = cs.spearmanIC([5, 1, 4, 2], [0.25, 0.25, 0.25, 0.25]);
  assert.ok(ic === null || (ic >= -1 && ic <= 1), `got ${ic}`);
});

console.log('\nbootstrapMeanCI');
test('constant series collapses to a zero-width CI at that constant', () => {
  const r = cs.bootstrapMeanCI([0.2, 0.2, 0.2, 0.2, 0.2]);
  assert.ok(Math.abs(r.mean - 0.2) < 1e-12);
  assert.ok(Math.abs(r.upper - r.lower) < 1e-12);
});
test('CI brackets the sample mean', () => {
  const vals = [-0.1, 0.05, 0.2, -0.03, 0.11, 0.07, -0.15, 0.02, 0.09, 0.04];
  const r = cs.bootstrapMeanCI(vals);
  assert.ok(r.lower <= r.mean && r.mean <= r.upper, `${r.lower} <= ${r.mean} <= ${r.upper}`);
});
test('same seed reproduces byte-identical bounds', () => {
  const vals = [0.1, -0.2, 0.3, 0.05, -0.02, 0.14, 0.09];
  const a = cs.bootstrapMeanCI(vals, { seed: 7 });
  const b = cs.bootstrapMeanCI(vals, { seed: 7 });
  assert.deepStrictEqual([a.lower, a.upper], [b.lower, b.upper]);
});
test('different seeds give different (but close) bounds', () => {
  const vals = [0.1, -0.2, 0.3, 0.05, -0.02, 0.14, 0.09];
  const a = cs.bootstrapMeanCI(vals, { seed: 1 });
  const b = cs.bootstrapMeanCI(vals, { seed: 2 });
  assert.notDeepStrictEqual([a.lower, a.upper], [b.lower, b.upper]);
});
test('NaN/null entries are filtered, not propagated', () => {
  const r = cs.bootstrapMeanCI([0.1, NaN, 0.2, null, 0.3]);
  assert.strictEqual(r.n, 3);
  assert.ok(Math.abs(r.mean - 0.2) < 1e-12);
});
test('fewer than 3 usable values refuses to claim a CI', () => {
  const r = cs.bootstrapMeanCI([0.1, NaN]);
  assert.strictEqual(r.mean, null);
});

console.log('\nicInformationRatio');
test('IR = mean/stdDev of the IC series', () => {
  const series = [0.1, 0.2, 0.3];
  const ir = cs.icInformationRatio(series);
  const mean = 0.2;
  const sd = Math.sqrt(((0.1 - mean) ** 2 + 0 + (0.3 - mean) ** 2) / 3);
  assert.ok(Math.abs(ir - mean / sd) < 1e-6, `got ${ir}, expected ~${mean / sd}`);
});
test('zero-variance IC series returns null rather than Infinity', () => {
  assert.strictEqual(cs.icInformationRatio([0.1, 0.1, 0.1]), null);
});

console.log('\nbucketByScore');
test('monotone data produces monotone bucket returns', () => {
  const scores = Array.from({ length: 100 }, (_, i) => i);
  const returns = scores.map(s => s * 0.01);
  const { buckets } = cs.bucketByScore(scores, returns, 10);
  for (let i = 1; i < 10; i++) {
    assert.ok(buckets[i].meanReturn > buckets[i - 1].meanReturn, `bucket ${i} not above ${i - 1}`);
  }
});
test('every element lands in exactly one bucket', () => {
  const scores = Array.from({ length: 97 }, (_, i) => i * 3 % 41);
  const returns = scores.map(() => Math.random());
  const { buckets } = cs.bucketByScore(scores, returns, 10);
  assert.strictEqual(buckets.reduce((s, b) => s + b.n, 0), 97);
});
test('bucket 0 is the LOWEST score bucket (direction sanity)', () => {
  const scores = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const returns = [-9, -7, -5, -3, -1, 1, 3, 5, 7, 9];
  const { buckets } = cs.bucketByScore(scores, returns, 10);
  assert.strictEqual(buckets[0].meanReturn, -9);
  assert.strictEqual(buckets[9].meanReturn, 9);
});
test('universeMean equals the plain mean of all returns', () => {
  const scores = [1, 2, 3, 4];
  const returns = [10, 20, 30, 40];
  assert.strictEqual(cs.bucketByScore(scores, returns, 2).universeMean, 25);
});
test('cross-section smaller than bucket count degrades safely', () => {
  const r = cs.bucketByScore([1, 2], [5, 7], 10);
  assert.strictEqual(r.buckets.length, 10);
  assert.strictEqual(r.universeMean, 6);
});

console.log('\nmulberry32');
test('same seed reproduces the same sequence', () => {
  const a = cs.mulberry32(123), b = cs.mulberry32(123);
  for (let i = 0; i < 50; i++) assert.strictEqual(a(), b());
});
test('output stays within [0,1)', () => {
  const r = cs.mulberry32(9);
  for (let i = 0; i < 500; i++) { const v = r(); assert.ok(v >= 0 && v < 1); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
