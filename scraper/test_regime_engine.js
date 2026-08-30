// Unit tests for the Market Regime Engine ("AWO Engine.md" §5). Synthetic
// candle series built to exercise each branch of detectRegime's baseline
// rule.
//
// The builders supply 700 candles, not the 250 they used to: an EMA200 needs
// ~500 bars before its SMA seed is worth under 5%, and below that the engine
// now refuses rather than answering from the seed. These cases test regime
// LOGIC, so they get valid input -- lowering the engine's threshold to keep a
// 250-bar fixture green would be fitting the guard to the test. Plain node + assert, matching test_awo_factors.js's pattern.
// Run: node test_regime_engine.js
'use strict';

const assert = require('assert');
const { detectPriceRegime, calcADX, computeATRPercentile, computeBBWidthPercentile, regimeGateVerdict, REGIME_CONFIG } = require('./modules/regime_engine');
const { emaSeedWeight, emaMinBars } = require('./awo_technical');

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
function buildTrendUpCandles(days = 700) {
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
function buildTrendDownCandles(days = 700) {
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
function buildRangeCandles(days = 700) {
  const candles = [];
  for (let i = 0; i < days; i++) {
    // An EXACT number of cycles (period 50, length 700 = 14 of them), so the
    // series ends where it started and "no net drift" is true by construction
    // rather than by luck of the phase. With the old `sin(i/8)` the period was
    // 16*PI, which divides no round length -- at 250 bars it happened to end
    // flat and at 700 it ended mid-swing, which read as TREND_DOWN. The fixture
    // was fragile to its own length, and lengthening it exposed that.
    const close = 100 + 4 * Math.sin(i * 2 * Math.PI / 50) + (i % 3 === 0 ? 0.3 : -0.2);
    candles.push({ high: close + 0.4, low: close - 0.4, close });
  }
  return candles;
}

// Same sideways base, but the most recent ~15 days get a big volatility spike
// (wide daily ranges) while price level stays roughly flat — should push ATR
// percentile to the top without satisfying the trend conditions.
function buildHighVolatilityCandles(days = 700) {
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


// ---------------------------------------------------------------------------
// A LONG EMA ON A SHORT WINDOW IS NOT A WEAKER EMA -- IT IS A DIFFERENT NUMBER
//
// An EMA is seeded with an SMA of its first `period` bars and decays that seed
// by (1 - 2/(period+1)) each bar. Hand it a short window and most of what comes
// back IS the seed: a figure from the start of the window, barely updated, and
// printed under the name of an EMA. Nothing errors, and the value looks fine.
//
// This engine used minCandles 210 while every caller passed slice(-280), which
// left the EMA200 90.5% and 44.9% seed. Measured on IHSG, that 280-bar EMA200
// sat 0.95% from the full-history value and flipped the regime label on 16 of
// 1,830 sessions -- clustered at trend transitions, which is where a regime
// label is actually read. A 400-bar window removed all sixteen.
// ---------------------------------------------------------------------------

function trendSeries(n, start = 1000) {
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p *= 1 + 0.0008 + Math.sin(i / 17) * 0.004;
    out.push({ high: p * 1.006, low: p * 0.994, close: p });
  }
  return out;
}

console.log('');
console.log('EMA seed weight — the guard');

test('the seed weight formula reproduces the numbers that motivated this', () => {
  assert.ok(Math.abs(emaSeedWeight(200, 210) - 0.905) < 0.01, `210 bars: ${emaSeedWeight(200, 210)}`);
  assert.ok(Math.abs(emaSeedWeight(200, 280) - 0.449) < 0.01, `280 bars: ${emaSeedWeight(200, 280)}`);
  assert.ok(emaSeedWeight(200, 600) < 0.02);
});

test('short periods were never the problem, and the guard must not claim they were', () => {
  // EMA(8) on 60 bars is exact: ours and a charting platform's are one number.
  assert.ok(emaSeedWeight(8, 60) < 0.0001, `EMA(8) on 60 bars: ${emaSeedWeight(8, 60)}`);
  assert.ok(emaSeedWeight(9, 60) < 0.001);
  assert.ok(emaMinBars(8) <= 60 && emaMinBars(9) <= 60);
});

test('emaMinBars is derived, so it follows a changed period instead of going stale', () => {
  for (const p of [8, 21, 50, 200]) {
    const n = emaMinBars(p, 0.05);
    assert.ok(emaSeedWeight(p, n) <= 0.05, `EMA(${p}) at ${n} bars is still ${emaSeedWeight(p, n)}`);
    assert.ok(emaSeedWeight(p, n - 1) > 0.05, `EMA(${p}) at ${n - 1} should not yet qualify`);
  }
});

test('minCandles is derived from the tolerance, not a hardcoded number', () => {
  assert.strictEqual(REGIME_CONFIG.minCandles, emaMinBars(200, 0.05) + 10);
  assert.ok(REGIME_CONFIG.minCandles > 280, 'the old 210/280 pair is what this prevents');
});

console.log('');
console.log('the engine refuses rather than answering from a seed');

test('280 candles — what every caller used to pass — is UNKNOWN now', () => {
  const r = detectPriceRegime(trendSeries(280));
  assert.strictEqual(r.regime, 'UNKNOWN');
  assert.ok(/insufficient_history|ema200_seed_weight/.test(r.reason), `reason was ${r.reason}`);
});

test('the refusal names what was supplied and what was needed', () => {
  // A bare UNKNOWN is not actionable: whoever hits it must be able to see that
  // the fix is more history, not a different ticker.
  const r = detectPriceRegime(trendSeries(280));
  if (r.reason.indexOf('ema200_seed_weight') === 0) {
    assert.ok(r.inputs.barsSupplied === 280 && r.inputs.barsNeeded > 280);
  } else {
    assert.strictEqual(r.inputs.candleCount, 280);
  }
});

test('a seed-clean window still produces a real label', () => {
  const r = detectPriceRegime(trendSeries(700));
  assert.notStrictEqual(r.regime, 'UNKNOWN', `700 clean candles should decide; got ${r.reason}`);
});

test('the second guard covers what minCandles cannot', () => {
  // minCandles is checked against the array handed over, so a slice can satisfy
  // it and still be too short for the EMA. That is exactly how slice(-280)
  // survived, and the seed check is what closes it.
  assert.ok(emaSeedWeight(200, REGIME_CONFIG.minCandles) <= 0.05);
  assert.strictEqual(detectPriceRegime(trendSeries(REGIME_CONFIG.minCandles - 1)).regime, 'UNKNOWN');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
