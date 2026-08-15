// Tests for EXP-028C context features.
//
// The whole point of this module is "strictly prior". The review said it twice
// because it is the thing most likely to be got wrong, and a leak here would be
// invisible in the output: a pattern would appear to predict a situation it had
// itself defined. So most of these tests exist to prove the pattern bar cannot
// reach its own context.
'use strict';

const assert = require('assert');
const cf = require('./research/candlestick/context_features');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

console.log('\nstrictly prior windows');
test('priorHigh EXCLUDES the bar itself — the gap-to-new-high case', () => {
  // 10 quiet bars topping at 105, then a bar that spikes to 200.
  const high = [...Array(10).fill(105), 200];
  const i = 10;
  assert.strictEqual(cf.priorHigh(high, i, 10), 105,
    'if the entry bar leaked in this would be 200 and the stock would look "at its high" by construction');
});

test('priorLow likewise excludes the bar', () => {
  const low = [...Array(10).fill(95), 10];
  assert.strictEqual(cf.priorLow(low, 10, 10), 95);
});

test('priorMean averages i-n .. i-1, never i', () => {
  const close = [...Array(20).fill(100), 999];
  assert.strictEqual(cf.priorMean(close, 20, 20), 100);
});

test('a hole anywhere in the window makes the feature null, not a shorter window', () => {
  const high = [105, 105, NaN, 105, 105, 105];
  assert.strictEqual(cf.priorHigh(high, 5, 5), null);
  const close = [100, 100, NaN, 100, 100, 100];
  assert.strictEqual(cf.priorMean(close, 5, 5), null);
});

test('insufficient history yields null rather than a partial window', () => {
  const close = [100, 101, 102];
  assert.strictEqual(cf.priorMean(close, 2, 20), null);
  assert.strictEqual(cf.priorHigh([100, 101, 102], 2, 20), null);
});

console.log('\nprior return and trend bucketing');
test('priorReturnPct ends at i-1, so the pattern bar cannot move its own trend', () => {
  // flat at 100 for 10 bars, then the pattern bar jumps to 200
  const close = [...Array(10).fill(100), 200];
  assert.ok(near(cf.priorReturnPct(close, 10, 5), 0));
  assert.strictEqual(cf.trendBucket(cf.priorReturnPct(close, 10, 5)), 'FLAT');
});

test('trend thresholds are symmetric at +/-3%', () => {
  assert.strictEqual(cf.trendBucket(3), 'UP');
  assert.strictEqual(cf.trendBucket(-3), 'DOWN');
  assert.strictEqual(cf.trendBucket(2.99), 'FLAT');
  assert.strictEqual(cf.trendBucket(-2.99), 'FLAT');
  assert.strictEqual(cf.trendBucket(null), null);
});

console.log('\ndistances are measured FROM the pattern close TO a prior reference');
test('a bar closing at the prior 20D high reads 0%, not a new high', () => {
  const n = 30;
  const close = new Array(n).fill(100), high = new Array(n).fill(110), low = new Array(n).fill(90);
  const volume = new Array(n).fill(1000);
  close[25] = 110;                                  // closes exactly at the prior high
  const ctx = cf.contextAt({ open: close, high, low, close, volume, atrSeries: null }, 25);
  assert.ok(near(ctx.distancePrior20DHigh, 0), `got ${ctx.distancePrior20DHigh}`);
});

test('a gap above the prior high shows POSITIVE distance, which is the informative case', () => {
  const n = 30;
  const close = new Array(n).fill(100), high = new Array(n).fill(110), low = new Array(n).fill(90);
  const volume = new Array(n).fill(1000);
  close[25] = 121; high[25] = 130;                  // 10% above the prior 110 high
  const ctx = cf.contextAt({ open: close, high, low, close, volume, atrSeries: null }, 25);
  assert.ok(near(ctx.distancePrior20DHigh, 10), `got ${ctx.distancePrior20DHigh}`);
});

console.log('\nvolume');
test('volume z-score compares the bar against a strictly prior window', () => {
  const volume = [...Array(20).fill(100), 300];
  const r = cf.volumeZ(volume, 20, 20);
  assert.ok(near(r.ratio, 3), `ratio=${r.ratio}`);
  assert.strictEqual(r.z, null, 'zero-variance prior window cannot give a z');
});

test('a varied prior window does give a z', () => {
  const volume = Array.from({ length: 20 }, (_, k) => 100 + (k % 5) * 10);
  volume.push(500);
  const r = cf.volumeZ(volume, 20, 20);
  assert.ok(r.z > 5, `z=${r.z}`);
});

console.log('\nATR percentile');
test('percentile is computed against a strictly prior reference distribution', () => {
  const n = 300;
  const atr = new Float64Array(n);
  for (let k = 0; k < n; k++) atr[k] = 1;
  atr[290] = 99;                                    // today far above everything before
  const p = cf.priorAtrPercentile(atr, 290, 252);
  assert.ok(p > 0.99, `p=${p}`);
});

test('not enough prior history returns null', () => {
  const atr = new Float64Array(50).fill(1);
  assert.strictEqual(cf.priorAtrPercentile(atr, 20, 252), null);
});

console.log('\nbucketing stays coarse on purpose');
test('buckets are three-way and null-safe', () => {
  const b = cf.bucketise({ trend10: 'DOWN', distanceMA20: -9, volumeVs20D: 2.5, atrPercentile: 0.8 });
  assert.deepStrictEqual(b, { TREND: 'DOWN', LOCATION: 'BELOW_MA20', VOLUME: 'HIGH_VOL', VOLATILITY: 'HIGH_ATR' });
  const nulls = cf.bucketise({ trend10: null, distanceMA20: null, volumeVs20D: null, atrPercentile: null });
  assert.deepStrictEqual(nulls, { TREND: null, LOCATION: null, VOLUME: null, VOLATILITY: null });
});

test('bucket boundaries land where the definitions say', () => {
  assert.strictEqual(cf.bucketise({ distanceMA20: -5 }).LOCATION, 'BELOW_MA20');
  assert.strictEqual(cf.bucketise({ distanceMA20: -4.99 }).LOCATION, 'NEAR_MA20');
  assert.strictEqual(cf.bucketise({ volumeVs20D: 2 }).VOLUME, 'HIGH_VOL');
  assert.strictEqual(cf.bucketise({ volumeVs20D: 0.5 }).VOLUME, 'LOW_VOL');
  assert.strictEqual(cf.bucketise({ atrPercentile: 0.7 }).VOLATILITY, 'HIGH_ATR');
  assert.strictEqual(cf.bucketise({ atrPercentile: 0.3 }).VOLATILITY, 'LOW_ATR');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
