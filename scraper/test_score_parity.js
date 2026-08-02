// Parity tests — follow-up #8 (2026-07-30): prove server.js's live scoring
// and awo_optimizer.js's rescoreSignal can no longer independently drift,
// since both now call the exact same combineFactorScores() from
// modules/score_engine.js instead of each having their own copy of the
// F1-F13+F14 combination logic (the F14-directional-vs-risk-modifier bug an
// external review caught 2026-07-30 was exactly this kind of drift).
'use strict';

const assert = require('assert');
const { combineFactorScores, scoreAtTimestamp, classifySignal, DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS } = require('./modules/score_engine');
const { rescoreSignal } = require('./awo_optimizer');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

const sampleFactors = {
  f1: 65, f2: 60, f3: 55, f4: 70, f5: 58, f6: 62, f7: 68, f8: 52,
  f9: 60, f10: 65, f11: 55, f12: 63, f13: 50,
};
const f14 = 75;

console.log('optimizer <-> live: same shared core, no independent drift possible');
test('awo_optimizer.rescoreSignal matches combineFactorScores directly for equivalent input', () => {
  const direct = combineFactorScores(sampleFactors, f14, {}, DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS);
  const viaOptimizer = rescoreSignal({
    f1_concentration: sampleFactors.f1, f2_trend: sampleFactors.f2, f3_volume_z: sampleFactors.f3,
    f4_momentum: sampleFactors.f4, f5_rel_strength: sampleFactors.f5, f6_breadth: sampleFactors.f6,
    f7_alignment: sampleFactors.f7, f8_streak: sampleFactors.f8, f9_rsi: sampleFactors.f9,
    f10_macd: sampleFactors.f10, f11_bollinger: sampleFactors.f11, f12_ema_trend: sampleFactors.f12,
    f13_support_resistance: sampleFactors.f13, f14_atr: f14,
  }, DEFAULT_WEIGHTS);
  assert.strictEqual(viaOptimizer, direct.finalScore, `optimizer=${viaOptimizer} vs direct=${direct.finalScore}`);
});
test('a full sweep of factor combinations agrees between the two call paths (not just one lucky point)', () => {
  for (let trial = 0; trial < 20; trial++) {
    const factors = {};
    for (const k of Object.keys(sampleFactors)) factors[k] = Math.round(Math.random() * 100);
    const f14trial = Math.round(Math.random() * 100);
    const direct = combineFactorScores(factors, f14trial, {}, DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS);
    const viaOptimizer = rescoreSignal({
      f1_concentration: factors.f1, f2_trend: factors.f2, f3_volume_z: factors.f3,
      f4_momentum: factors.f4, f5_rel_strength: factors.f5, f6_breadth: factors.f6,
      f7_alignment: factors.f7, f8_streak: factors.f8, f9_rsi: factors.f9,
      f10_macd: factors.f10, f11_bollinger: factors.f11, f12_ema_trend: factors.f12,
      f13_support_resistance: factors.f13, f14_atr: f14trial,
    }, DEFAULT_WEIGHTS);
    assert.strictEqual(viaOptimizer, direct.finalScore, `trial ${trial}: optimizer=${viaOptimizer} vs direct=${direct.finalScore}`);
  }
});

console.log('\nscoreAtTimestamp (raw-data path) uses the same combination core');
test('scoreAtTimestamp with neutral factors (via flat price/no broker data) stays neutral like combineFactorScores would', () => {
  const flatCandles = Array.from({ length: 70 }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000,
  }));
  const result = scoreAtTimestamp({
    symbol: 'TEST', timestamp: '2026-03-01',
    marketData: { candles: flatCandles, marketAvgChangePct: 0 },
    brokerData: {},
  });
  assert.ok(Number.isFinite(result.finalScore), 'finalScore must be a finite number');
  assert.ok(result.finalScore >= 0 && result.finalScore <= 100, `finalScore ${result.finalScore} out of 0-100 range`);
  assert.strictEqual(result.factorAvailability.f1, false, 'no brokerData.concentration → f1 unavailable');
  assert.ok(result.factorCoverage < 1, 'coverage must reflect the missing broker factors');
  assert.ok(['STRONG BUY','BUY','WATCH','NEUTRAL','SELL','STRONG SELL'].includes(result.decision));
});
test('F9-F13 are marked UNAVAILABLE (not just left at fallback 50) when there is not enough candle history to compute them (external review, round 2, P1)', () => {
  const thinCandles = Array.from({ length: 5 }, (_, i) => ({
    date: `2026-01-0${i + 1}`, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000,
  }));
  const result = scoreAtTimestamp({
    symbol: 'NEWLIST', timestamp: '2026-01-05',
    marketData: { candles: thinCandles, marketAvgChangePct: 0 },
    brokerData: { concentration: { dn0: 10, dn1: 8, dn2: 5, dn3: 3, dn4: 2 }, breadth: { netBuyers: 12, netSellers: 8 } },
  });
  for (const f of ['f9', 'f10', 'f11', 'f12', 'f13']) {
    assert.strictEqual(result.factorAvailability[f], false, `${f} must be marked unavailable with only 5 candles, not silently treated as a real reading`);
  }
  assert.ok(result.factorCoverage < 1, 'missing technical factors must reduce factorCoverage, not be invisible to it');
});
test('scoreAtTimestamp output has the exact Review.md-specified shape', () => {
  const flatCandles = Array.from({ length: 70 }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`, open: 100, high: 101, low: 99, close: 100 + i * 0.1, volume: 1000,
  }));
  const result = scoreAtTimestamp({
    symbol: 'BBCA', timestamp: '2026-03-01',
    marketData: { candles: flatCandles, marketAvgChangePct: 0.2 },
    brokerData: { concentration: { dn0: 10, dn1: 8, dn2: 5, dn3: 3, dn4: 2 }, breadth: { netBuyers: 12, netSellers: 8 } },
    modelVersion: 'awo-3.4.0', configVersion: 'idx-d1-tp-v1',
  });
  for (const key of ['regime','eligibleSetup','factorScores','factorAvailability','directionalScore','confidence','riskModifier','finalScore','decision','reasonCodes','modelVersion','configVersion']) {
    assert.ok(key in result, `missing expected field: ${key}`);
  }
  assert.strictEqual(result.modelVersion, 'awo-3.4.0');
  assert.strictEqual(result.configVersion, 'idx-d1-tp-v1');
});

console.log('\nclassifySignal — single shared threshold classification');
test('classifySignal boundaries match DEFAULT_THRESHOLDS exactly', () => {
  assert.strictEqual(classifySignal(78), 'STRONG BUY');
  assert.strictEqual(classifySignal(77), 'BUY');
  assert.strictEqual(classifySignal(63), 'BUY');
  assert.strictEqual(classifySignal(62), 'WATCH');
  assert.strictEqual(classifySignal(25), 'SELL');
  assert.strictEqual(classifySignal(24), 'STRONG SELL');
});

console.log('\ncombineFactorScores — F14 must never contaminate the directional composite (external review, 2026-07-31)');
test('an f14 entry in the weights object does not change directionalScore vs. an identical weights object with no f14 key', () => {
  const scores13 = { f1: 80, f2: 80, f3: 80, f4: 80, f5: 80, f6: 80, f7: 80, f8: 80, f9: 80, f10: 80, f11: 80, f12: 80, f13: 80 };
  const withF14 = { f1: 0.14, f2: 0.10, f3: 0.08, f4: 0.10, f5: 0.07, f6: 0.10, f7: 0.08, f8: 0.05, f9: 0.06, f10: 0.06, f11: 0.05, f12: 0.05, f13: 0.03, f14: 0.03 };
  const withoutF14 = { ...withF14 }; delete withoutF14.f14;
  const r1 = combineFactorScores(scores13, 50, {}, withF14);
  const r2 = combineFactorScores(scores13, 50, {}, withoutF14);
  assert.strictEqual(r1.directionalScore, r2.directionalScore, `with f14=${r1.directionalScore} vs without f14=${r2.directionalScore} — must be identical`);
  assert.ok(Math.abs(r1.directionalScore - 80) < 1e-6, `expected ~80 (all 13 real factors at 80), got ${r1.directionalScore} — f14's weight must not dilute toward 50`);
});
test('varying f14\'s weight value alone (weights object otherwise identical) never changes directionalScore', () => {
  const scores13 = { f1: 60, f2: 60, f3: 60, f4: 60, f5: 60, f6: 60, f7: 60, f8: 60, f9: 60, f10: 60, f11: 60, f12: 60, f13: 60 };
  const base = { f1: 0.14, f2: 0.10, f3: 0.08, f4: 0.10, f5: 0.07, f6: 0.10, f7: 0.08, f8: 0.05, f9: 0.06, f10: 0.06, f11: 0.05, f12: 0.05, f13: 0.03 };
  const scoreAt = (f14w) => combineFactorScores(scores13, 50, {}, { ...base, f14: f14w }).directionalScore;
  assert.strictEqual(scoreAt(0.01), scoreAt(0.29));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
