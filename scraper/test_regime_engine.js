// Unit tests for the Market Regime Engine ("AWO Engine.md" §5). Synthetic
// candle series built to exercise each branch of detectRegime's baseline
// rule. Plain node + assert, matching test_awo_factors.js's pattern.
// Run: node test_regime_engine.js
'use strict';

const assert = require('assert');
const { detectPriceRegime, calcADX, computeATRPercentile, computeBBWidthPercentile, regimeGateVerdict } = require('./modules/regime_engine');

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

// Steady compounding uptrend, tight daily range (low volatility, strong
// directional consistency). Band width gets deterministic sine-based jitter
// rather than a perfectly constant %, since a perfectly uniform band leaves
// the ATR-percentile ranking decided by floating-point noise alone (an
// unrealistic degenerate case real market data never actually produces).
function buildTrendUpCandles(days = 250) {
  const candles = [];
  let price = 100;
  for (let i = 0; i < days; i++) {
    price *= 1.0018; // ~0.18%/day compounding
    const bandJitter = 1 + 0.4 * Math.sin(i * 1.7);
    candles.push({ high: price * (1 + 0.004 * bandJitter), low: price * (1 - 0.004 * bandJitter), close: price });
  }
  return candles;
}

// Steady compounding downtrend, same construction as the uptrend (constant
// average % daily band, with the same jitter) so it's a fair mirror — NOT a
// geometric reflection of the uptrend series, which would distort the
// normalized volatility along the way.
function buildTrendDownCandles(days = 250) {
  const candles = [];
  let price = 100;
  for (let i = 0; i < days; i++) {
    price *= 0.9982; // ~-0.18%/day compounding
    const bandJitter = 1 + 0.4 * Math.sin(i * 1.7);
    candles.push({ high: price * (1 + 0.004 * bandJitter), low: price * (1 - 0.004 * bandJitter), close: price });
  }
  return candles;
}

// Sideways oscillation, no net drift, tight range.
function buildRangeCandles(days = 250) {
  const candles = [];
  for (let i = 0; i < days; i++) {
    const close = 100 + 4 * Math.sin(i / 8) + (i % 3 === 0 ? 0.3 : -0.2);
    candles.push({ high: close + 0.4, low: close - 0.4, close });
  }
  return candles;
}

// Same sideways base, but the most recent ~15 days get a big volatility spike
// (wide daily ranges) while price level stays roughly flat — should push ATR
// percentile to the top without satisfying the trend conditions.
function buildHighVolatilityCandles(days = 250) {
  const candles = buildRangeCandles(days);
  const spikeStart = candles.length - 15;
  for (let i = spikeStart; i < candles.length; i++) {
    const close = candles[i].close;
    candles[i] = { high: close + 9, low: close - 9, close };
  }
  return candles;
}

console.log('detectPriceRegime — branch classification');
test('steady compounding uptrend → TREND_UP', () => {
  const { regime } = detectPriceRegime(buildTrendUpCandles());
  assert.strictEqual(regime, 'TREND_UP');
});
test('steady compounding downtrend → TREND_DOWN', () => {
  const { regime } = detectPriceRegime(buildTrendDownCandles());
  assert.strictEqual(regime, 'TREND_DOWN');
});
test('sideways oscillation with no net drift → RANGE', () => {
  const { regime } = detectPriceRegime(buildRangeCandles());
  assert.strictEqual(regime, 'RANGE');
});
test('recent volatility spike on a sideways base → HIGH_VOLATILITY', () => {
  const { regime, inputs } = detectPriceRegime(buildHighVolatilityCandles());
  assert.strictEqual(regime, 'HIGH_VOLATILITY', `got ${regime}, atrPercentile=${inputs.atrPercentile}`);
});
test('too little history → UNKNOWN, not a crash', () => {
  const { regime, reason } = detectPriceRegime(buildRangeCandles(50));
  assert.strictEqual(regime, 'UNKNOWN');
  assert.strictEqual(reason, 'insufficient_history');
});
test('empty/undefined candles → UNKNOWN, no throw', () => {
  assert.strictEqual(detectPriceRegime(undefined).regime, 'UNKNOWN');
  assert.strictEqual(detectPriceRegime([]).regime, 'UNKNOWN');
});

console.log('\ncalcADX — sanity');
test('strong directional move → high ADX', () => {
  const c = buildTrendUpCandles();
  const adx = calcADX(c.map(x => x.high), c.map(x => x.low), c.map(x => x.close));
  assert.ok(adx > 20, `expected ADX > 20, got ${adx}`);
});
test('choppy sideways move → lower ADX than the trend case', () => {
  const trend = buildTrendUpCandles();
  const range = buildRangeCandles();
  const adxTrend = calcADX(trend.map(x => x.high), trend.map(x => x.low), trend.map(x => x.close));
  const adxRange = calcADX(range.map(x => x.high), range.map(x => x.low), range.map(x => x.close));
  assert.ok(adxRange < adxTrend, `expected range ADX (${adxRange}) < trend ADX (${adxTrend})`);
});
test('insufficient data → null, not NaN or a throw', () => {
  assert.strictEqual(calcADX([1, 2], [1, 2], [1, 2]), null);
});

console.log('\nPercentile helpers — no NaN/Infinity, bounded 0-100');
test('ATR percentile of the volatility-spike series is high', () => {
  const c = buildHighVolatilityCandles();
  const p = computeATRPercentile(c.map(x => x.high), c.map(x => x.low), c.map(x => x.close));
  assert.ok(p >= 90, `expected >= 90, got ${p}`);
  assert.ok(Number.isFinite(p));
});
test('ATR percentile of a flat calm series stays bounded 0-100', () => {
  const c = buildRangeCandles();
  const p = computeATRPercentile(c.map(x => x.high), c.map(x => x.low), c.map(x => x.close));
  assert.ok(p === null || (p >= 0 && p <= 100));
});
test('BB width percentile is bounded and finite', () => {
  const c = buildTrendUpCandles();
  const p = computeBBWidthPercentile(c.map(x => x.close));
  assert.ok(p === null || (Number.isFinite(p) && p >= 0 && p <= 100));
});

console.log('\nregimeGateVerdict — shadow-mode counter-trend gate (P1 follow-up #13, never enforced)');
test('BUY fighting a confirmed downtrend would be blocked', () => {
  const v = regimeGateVerdict('BUY', 'TREND_DOWN');
  assert.strictEqual(v.wouldBlock, true);
  assert.strictEqual(v.reason, 'counter_trend_down');
});
test('SELL fighting a confirmed uptrend would be blocked', () => {
  const v = regimeGateVerdict('STRONG SELL', 'TREND_UP');
  assert.strictEqual(v.wouldBlock, true);
  assert.strictEqual(v.reason, 'counter_trend_up');
});
test('BUY aligned with an uptrend would NOT be blocked', () => {
  const v = regimeGateVerdict('STRONG BUY', 'TREND_UP');
  assert.strictEqual(v.wouldBlock, false);
});
test('any directional signal in HIGH_VOLATILITY would be blocked regardless of direction', () => {
  assert.strictEqual(regimeGateVerdict('BUY', 'HIGH_VOLATILITY').wouldBlock, true);
  assert.strictEqual(regimeGateVerdict('SELL', 'HIGH_VOLATILITY').wouldBlock, true);
});
test('RANGE never blocks', () => {
  assert.strictEqual(regimeGateVerdict('BUY', 'RANGE').wouldBlock, false);
  assert.strictEqual(regimeGateVerdict('SELL', 'RANGE').wouldBlock, false);
});
test('non-directional signals (WATCH/NEUTRAL) are never blocked', () => {
  assert.strictEqual(regimeGateVerdict('WATCH', 'TREND_DOWN').wouldBlock, false);
  assert.strictEqual(regimeGateVerdict('NEUTRAL', 'TREND_UP').wouldBlock, false);
});
test('missing/UNKNOWN regime never blocks (no data to gate on)', () => {
  assert.strictEqual(regimeGateVerdict('BUY', null).wouldBlock, false);
  assert.strictEqual(regimeGateVerdict('BUY', 'UNKNOWN').wouldBlock, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
