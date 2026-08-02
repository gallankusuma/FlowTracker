// Regression test for the calcMACD() EMA-alignment bug (external review,
// 2026-07-30) — fast EMA was seeded at bar `fast-1` then fast-forwarded to
// bar `slow` without recursively advancing through the bars in between,
// producing an outright sign flip on synthetic data. This test computes MACD
// two ways — the module's calcMACD, and a deliberately independent reference
// implementation written from scratch — and checks they agree.
'use strict';

const assert = require('assert');
const { calcMACD } = require('./awo_technical');

// Independent reference: standard textbook EMA, one full pass per series,
// no shortcuts, not sharing a single line of code with awo_technical.js.
function referenceMACD(closes, fast = 12, slow = 26, sig = 9) {
  function fullEma(values, period) {
    const k = 2 / (period + 1);
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i];
    out[period - 1] = sum / period;
    for (let i = period; i < values.length; i++) {
      out[i] = values[i] * k + out[i - 1] * (1 - k);
    }
    return out;
  }
  const fastE = fullEma(closes, fast);
  const slowE = fullEma(closes, slow);
  const macdLine = [];
  for (let i = slow - 1; i < closes.length; i++) macdLine.push(fastE[i] - slowE[i]);
  const signalE = fullEma(macdLine, sig);
  const macd = macdLine[macdLine.length - 1];
  const signal = signalE[signalE.length - 1];
  return { macd, signal, histogram: macd - signal };
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

// Synthetic trending-then-reversing series — long enough (60 bars) to
// exercise the fast/slow/signal warm-up periods fully.
function buildSeries(n = 60) {
  const closes = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    price += (i < 30 ? 1.2 : -0.8) + Math.sin(i * 0.7) * 0.5;
    closes.push(price);
  }
  return closes;
}

console.log('calcMACD vs independent reference implementation');
test('matches reference MACD line within tight tolerance', () => {
  const closes = buildSeries();
  const mine = calcMACD(closes);
  const ref = referenceMACD(closes);
  assert.ok(mine && ref, 'both should compute a result');
  assert.ok(Math.abs(mine.macd - ref.macd) < 0.01, `macd ${mine.macd} vs ref ${ref.macd}`);
});
test('matches reference signal line within tight tolerance', () => {
  const closes = buildSeries();
  const mine = calcMACD(closes);
  const ref = referenceMACD(closes);
  assert.ok(Math.abs(mine.signal - ref.signal) < 0.01, `signal ${mine.signal} vs ref ${ref.signal}`);
});
test('histogram sign matches reference (the bug flipped this)', () => {
  const closes = buildSeries();
  const mine = calcMACD(closes);
  const ref = referenceMACD(closes);
  assert.strictEqual(Math.sign(mine.histogram), Math.sign(ref.histogram),
    `mine=${mine.histogram} ref=${ref.histogram}`);
});
test('agrees across many different window lengths (not just one lucky length)', () => {
  const closes = buildSeries(80);
  for (let n = 36; n <= 80; n += 4) {
    const slice = closes.slice(0, n);
    const mine = calcMACD(slice);
    const ref = referenceMACD(slice);
    if (!mine || !ref) continue;
    assert.ok(Math.abs(mine.macd - ref.macd) < 0.01, `n=${n}: macd ${mine.macd} vs ref ${ref.macd}`);
    assert.strictEqual(Math.sign(mine.histogram), Math.sign(ref.histogram), `n=${n}: histogram sign mismatch`);
  }
});
test('insufficient data returns null, not a throw', () => {
  assert.strictEqual(calcMACD([1, 2, 3]), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
