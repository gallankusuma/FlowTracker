// Fixed 2026-07-31 (external review, round 3, findings #2/#4): calcTechnicalFactors
// used to short-circuit ALL of f9-f14 behind one `candles.length < 26` gate, and every
// live-scoring call site (modules/score_engine.js, server.js's computeStockFactorsLive,
// server.js's /api/signal-scanner ticker loop) then used one shared 15-bar (RSI's
// minimum) flag for ALL of f9-f13's availability — silently treating Bollinger(20)/
// Support-Resistance(20)/EMA-trend(21)/MACD(35) fake-50 fallbacks as real, fully-
// weighted readings whenever a stock had 15-25 days of history. This suite pins each
// indicator's real per-factor minimum and confirms factorAvailable reports it honestly.
'use strict';

const assert = require('assert');
const { calcTechnicalFactors, emaMinBars } = require('./awo_technical');
const { scoreAtTimestamp } = require('./modules/score_engine');

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}\n    ${e.message}`);
    failed++;
  }
}

// Deterministic, mildly oscillating uptrend — avoids degenerate flat-price math
// (zero stdDev, zero avgLoss) while staying realistic enough for every indicator.
function makeCandles(n, startPrice = 1000) {
  const candles = [];
  let price = startPrice;
  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i / 3) * 15;
    price = startPrice + i * 2 + wave;
    const open = price - 3;
    const close = price;
    const high = Math.max(open, close) + 5;
    const low = Math.min(open, close) - 5;
    candles.push({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, open, high, low, close, volume: 100000 + i * 500 });
  }
  return candles;
}

console.log('calcTechnicalFactors — per-indicator real minimums, not one blanket 26-bar gate (external review, round 3, findings #2/#4)');

test('0 candles: everything unavailable, no throw', () => {
  const tech = calcTechnicalFactors([]);
  assert.deepStrictEqual(tech.factorAvailable, { f9: false, f10: false, f11: false, f12: false, f13: false, f14: false });
  assert.strictEqual(tech.f9, 50);
});

test('undefined candles: everything unavailable, no throw', () => {
  const tech = calcTechnicalFactors(undefined);
  assert.strictEqual(tech.factorAvailable.f9, false);
});

test('14 candles: RSI(14) needs 15 — f9 NOT yet available', () => {
  const tech = calcTechnicalFactors(makeCandles(14));
  assert.strictEqual(tech.factorAvailable.f9, false);
});

test('15 candles: RSI(14) minimum met — f9 available with a real value, even though f10/f11/f12/f13 are not (this is exactly what the old blanket 26-bar gate got wrong)', () => {
  const tech = calcTechnicalFactors(makeCandles(15));
  assert.strictEqual(tech.factorAvailable.f9, true);
  assert.strictEqual(tech.factorAvailable.f10, false, 'MACD needs 35 bars');
  assert.strictEqual(tech.factorAvailable.f11, false, 'Bollinger needs 20 bars');
  assert.strictEqual(tech.factorAvailable.f12, false, 'EMA-trend needs 21 bars');
  assert.strictEqual(tech.factorAvailable.f13, false, 'Support/Resistance needs 20 bars');
  assert.strictEqual(tech.factorAvailable.f14, true, 'ATR(14) also only needs 15 bars');
});

test('19 candles: Bollinger/S-R (20) still not available', () => {
  const tech = calcTechnicalFactors(makeCandles(19));
  assert.strictEqual(tech.factorAvailable.f11, false);
  assert.strictEqual(tech.factorAvailable.f13, false);
});

test('20 candles: Bollinger(20) and Support/Resistance(20) become available', () => {
  const tech = calcTechnicalFactors(makeCandles(20));
  assert.strictEqual(tech.factorAvailable.f11, true);
  assert.strictEqual(tech.factorAvailable.f13, true);
  assert.strictEqual(tech.factorAvailable.f12, false, 'EMA-trend still needs 21 bars');
});

test('21 candles: EMA-trend(21) can be COMPUTED but is not yet MEANINGFUL', () => {
  // This used to assert f12 became available here, on the reasoning that 21 bars
  // is what EMA(21) needs. That is the computability minimum, not the accuracy
  // one: an EMA is seeded with an SMA of its first `period` bars, so at exactly
  // 21 bars "EMA(21)" IS that SMA -- 100% seed, an SMA wearing the name. f12
  // compares EMA9 against EMA21, and at 21 bars it is comparing a near-proper
  // EMA against a plain average, which is not the crossover the factor claims.
  //
  // The threshold is now derived: enough bars for the seed to fall under 5%.
  const tech = calcTechnicalFactors(makeCandles(21));
  assert.strictEqual(tech.factorAvailable.f12, false, 'at 21 bars EMA21 is 100% seed');
  assert.strictEqual(tech.factorAvailable.f10, false, 'MACD still needs 35 bars');
});

test('f12 becomes available once EMA21 has shed its seed', () => {
  const need = emaMinBars(21, 0.05);
  assert.strictEqual(calcTechnicalFactors(makeCandles(need - 1)).factorAvailable.f12, false);
  assert.strictEqual(calcTechnicalFactors(makeCandles(need)).factorAvailable.f12, true);
  // And production is unaffected: every caller passes 60.
  assert.ok(need <= 60, `f12 needs ${need} bars but production supplies 60`);
});

test('34 candles: MACD(26+9) still not available', () => {
  const tech = calcTechnicalFactors(makeCandles(34));
  assert.strictEqual(tech.factorAvailable.f10, false);
});

test('35 candles: everything except f12, which still wants a cleaner EMA21', () => {
  const tech = calcTechnicalFactors(makeCandles(35));
  assert.deepStrictEqual(tech.factorAvailable,
    { f9: true, f10: true, f11: true, f12: false, f13: true, f14: true });
});

test('60 candles — what production actually passes — is fully available', () => {
  const tech = calcTechnicalFactors(makeCandles(60));
  assert.deepStrictEqual(tech.factorAvailable,
    { f9: true, f10: true, f11: true, f12: true, f13: true, f14: true });
});

console.log('\nscoreAtTimestamp — partial technical availability now reaches the weighted composite\'s missingFactors instead of being silently faked as available (integration through modules/score_engine.js)');

test('16 candles: f9/f14 real, f10/f11/f12/f13 correctly reported missing (not diluted in as fake-50 "available" factors)', () => {
  const result = scoreAtTimestamp({
    symbol: 'TEST', timestamp: '2026-02-01',
    marketData: { candles: makeCandles(16), marketAvgChangePct: 0 },
    brokerData: { concentration: { dn0: 30, dn1: 32, dn2: 34, dn3: 36, dn4: 38 }, breadth: { netBuyers: 10, netSellers: 5 } },
  });
  assert.ok(!result.missingFactors.includes('f9'), 'f9 has 16 bars, RSI(14) needs 15 — should NOT be missing');
  assert.ok(result.missingFactors.includes('f10'), 'f10 (MACD, needs 35) should be missing at 16 bars');
  assert.ok(result.missingFactors.includes('f11'), 'f11 (Bollinger, needs 20) should be missing at 16 bars');
  assert.ok(result.missingFactors.includes('f12'), 'f12 (EMA-trend) should be missing at 16 bars');
  assert.ok(result.missingFactors.includes('f13'), 'f13 (Support/Resistance, needs 20) should be missing at 16 bars');
});

test('60 candles + full broker/breadth data: no missing factors at all', () => {
  // 60, not 35: f12 needs a seed-clean EMA21 now, and 60 is what every caller
  // passes anyway, so this asserts the shape production actually sees.
  const result = scoreAtTimestamp({
    symbol: 'TEST', timestamp: '2026-03-01',
    marketData: { candles: makeCandles(60), marketAvgChangePct: 0 },
    brokerData: { concentration: { dn0: 30, dn1: 32, dn2: 34, dn3: 36, dn4: 38 }, breadth: { netBuyers: 10, netSellers: 5 } },
  });
  assert.deepStrictEqual(result.missingFactors, []);
  assert.strictEqual(result.factorCoverage, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
