'use strict';
/**
 * Parity test — modules/us_score_engine.js must score EXACTLY as the inline
 * server.js block it replaced.
 *
 * The extraction was done so the US signal-history backfill could score through
 * the same function the live scanner uses. That only helps if the move was
 * lossless, and "I only moved it" is precisely the claim this project has had
 * falsified before: the F14 directional-weight bug survived in a copy-pasted
 * scoring block until an external review found it, and the 2026-07-19
 * overfitting incident traced to the same class of drift.
 *
 * So the pre-extraction source is kept verbatim in us_score_original_fixture.js
 * and both are run over the same inputs. Not a smoke test -- a bit-for-bit
 * comparison of every returned number, over price paths chosen to reach the
 * branches that differ (trends, gaps, flat stretches, zero volume).
 *
 * Usage: node scraper/test_us_score_engine.js
 */
const assert = require('assert');

const {
  f3_volumeZ, f4_momentum, f5_relStrength,
  computeConfidence, computeRiskModifier, combineFinalScore,
} = require('./modules/awo_factors');
const { DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS } = require('./modules/score_engine');
const { computeConvictionTier } = require('./modules/conviction');

const { computeUSStockFactors, US_TECH_WEIGHTS } = require('./modules/us_score_engine');
const FACTOR_WINDOW = 60;   // mirrors the module's constant; the test pins the value

// The original called server.js's classifySignal, which reads the LIVE
// optimized thresholds. Injecting DEFAULT_THRESHOLDS here matches what the
// module does when a caller supplies them, so the two are compared on equal
// terms rather than one being handed a different rule.
function classifySignal(score) {
  const t = DEFAULT_THRESHOLDS;
  if (score >= t.strongBuy) return 'STRONG BUY';
  if (score >= t.buy) return 'BUY';
  if (score >= t.watch) return 'WATCH';
  if (score >= t.neutral) return 'NEUTRAL';
  if (score >= t.sell) return 'SELL';
  return 'STRONG SELL';
}

const original = require('./us_score_original_fixture')({
  DEFAULT_WEIGHTS, f3_volumeZ, f4_momentum, f5_relStrength,
  combineFinalScore, computeConfidence, computeRiskModifier,
  classifySignal, computeConvictionTier,
});

/** Deterministic PRNG — a failure has to be reproducible to be fixable. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a price path. `drift` and `vol` are per-bar; `volumeMode` covers the
 * zero-volume case, which is the one that can divide by zero in f3.
 */
function series(n, { seed = 1, start = 100, drift = 0, vol = 0.01, volumeMode = 'normal' } = {}) {
  const rand = rng(seed);
  const out = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    px = Math.max(0.01, px * (1 + drift + (rand() - 0.5) * 2 * vol));
    const hi = px * (1 + rand() * vol);
    const lo = px * (1 - rand() * vol);
    const vRaw = volumeMode === 'zero' ? 0
      : volumeMode === 'spiky' ? Math.floor(1e6 * (rand() < 0.1 ? 20 : 1) * (0.5 + rand()))
        : Math.floor(1e6 * (0.5 + rand()));
    out.push({
      date: new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10),
      open: Math.round(px * 1e4) / 1e4,
      high: Math.round(hi * 1e4) / 1e4,
      low: Math.round(lo * 1e4) / 1e4,
      close: Math.round(px * 1e4) / 1e4,
      volume: vRaw,
    });
  }
  return out;
}

/** Flat prices — every momentum/volatility denominator collapses. */
function flat(n, px = 50) {
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10),
    open: px, high: px, low: px, close: px, volume: 1000000,
  }));
}

const CASES = [];
let seed = 1000;
for (const n of [15, 16, 30, 60, 61, 120, 300]) {
  for (const drift of [0, 0.004, -0.004]) {
    for (const vol of [0.004, 0.02, 0.08]) {
      for (const volumeMode of ['normal', 'spiky']) {
        CASES.push({
          label: `n=${n} drift=${drift} vol=${vol} ${volumeMode}`,
          candles: series(n, { seed: seed++, drift, vol, volumeMode }),
        });
      }
    }
  }
}
CASES.push({ label: 'flat 60', candles: flat(60) });
CASES.push({ label: 'flat 200', candles: flat(200) });
CASES.push({ label: 'zero volume 80', candles: series(80, { seed: 77, volumeMode: 'zero' }) });
CASES.push({ label: 'penny prices', candles: series(90, { seed: 88, start: 0.42, vol: 0.05 }) });
CASES.push({ label: 'four-figure prices', candles: series(90, { seed: 99, start: 4200, vol: 0.02 }) });
CASES.push({ label: 'too short (14)', candles: series(14, { seed: 5 }) });

const MARKET_DIRS = ['BULLISH', 'BEARISH', 'NEUTRAL'];
const MARKET_AVGS = [0, 1.7, -1.7];

let checks = 0, failures = 0;
// Counts long-series cases where the windowed F3 actually differs from the
// unwindowed one. If this stayed at zero the assertions above would be
// vacuously true and the test would prove nothing about the change it exists
// to pin -- so it is asserted at the end, not merely printed.
let diverged = 0;

for (const c of CASES) {
  for (const dir of MARKET_DIRS) {
    for (const avg of MARKET_AVGS) {
      const b = computeUSStockFactors(c.candles, dir, avg, { thresholds: DEFAULT_THRESHOLDS });
      const origFull = original.computeUSStockFactors(c.candles, dir, avg);
      const origWin = original.computeUSStockFactors(c.candles.slice(-FACTOR_WINDOW), dir, avg);
      checks++;
      try {
        if (b === null || origFull === null) {
          assert.strictEqual(b, origFull, 'one returned null and the other did not');
          continue;
        }

        if (c.candles.length <= FACTOR_WINDOW) {
          // At or below the window the two receive literally the same input, so
          // this is the plain "the move changed nothing" proof: deep equality
          // over the WHOLE object -- composite, every factor, indicators, trade
          // plan, conviction tier. Comparing only `composite` would let a
          // changed stop-loss or tier through untouched.
          assert.deepStrictEqual(b, origFull);
          continue;
        }

        // Above the window there is exactly ONE intended difference: F3 and F4
        // see the last FACTOR_WINDOW bars instead of the whole array, because
        // f3_volumeZ z-scores whatever it is handed and that array is about to
        // become twenty years long (see the constant's note in the module).
        //
        // Asserting BOTH halves is what makes this a proof rather than a
        // hand-wave: the changed fields must equal the original fed the window,
        // and every unchanged field must still equal the original fed
        // everything. A stray edit lands on one side or the other.
        assert.strictEqual(b.factors.volumeZ, origWin.factors.volumeZ, 'volumeZ != windowed original');
        assert.strictEqual(b.factors.momentum, origWin.factors.momentum, 'momentum != windowed original');
        assert.strictEqual(b.factors.relStrength, origWin.factors.relStrength, 'relStrength != windowed original');

        for (const k of ['rsi', 'macd', 'bollinger', 'emaTrend', 'supportResistance', 'atr']) {
          // calcTechnicalFactors was ALREADY given slice(-60) before the move,
          // so these must be untouched by the window change.
          assert.strictEqual(b.factors[k], origFull.factors[k], `factors.${k} moved`);
          assert.strictEqual(b.factors[k], origWin.factors[k], `factors.${k} disagrees across windows`);
        }
        assert.deepStrictEqual(b.indicators, origFull.indicators, 'indicators moved');
        // computeWeeklyTrend still gets the FULL array in both -- more weekly
        // history converges the EMAs rather than distorting them, which is the
        // lesson from the EMA seed-window guard.
        assert.strictEqual(b.weeklyTrend, origFull.weeklyTrend, 'weeklyTrend moved');
        if (b.factors.volumeZ !== origFull.factors.volumeZ) diverged++;
      } catch (e) {
        failures++;
        console.log(`FAIL  ${c.label}  dir=${dir} avg=${avg}`);
        console.log(`      ${e.message.split('\n').slice(0, 6).join('\n      ')}`);
      }
    }
  }
}

// The weights table itself must survive the move -- a renormalization drift
// here would shift every score by a constant and still "look fine".
const origW = original.US_TECH_WEIGHTS;
for (const k of Object.keys(origW)) {
  checks++;
  try {
    assert.strictEqual(US_TECH_WEIGHTS[k], origW[k], `US_TECH_WEIGHTS.${k}`);
  } catch (e) { failures++; console.log(`FAIL  ${e.message}`); }
}
checks++;
try {
  assert.deepStrictEqual(Object.keys(US_TECH_WEIGHTS).sort(), Object.keys(origW).sort());
} catch (e) { failures++; console.log(`FAIL  weight keys differ: ${e.message}`); }

// And the sum must still be 1.0, which is what keeps the composite on the
// 0-100 scale the thresholds are written against.
checks++;
const wsum = Object.values(US_TECH_WEIGHTS).reduce((a, b) => a + b, 0);
if (Math.abs(wsum - 1) > 1e-12) { failures++; console.log(`FAIL  weights sum to ${wsum}, not 1`); }

console.log(`\nus_score_engine parity: ${checks - failures}/${checks} checks passed ` +
  `(${CASES.length} price paths x ${MARKET_DIRS.length} directions x ${MARKET_AVGS.length} market averages)`);
if (!diverged) {
  console.log('FAIL  no long-series case produced a different F3 — the window assertions are vacuous');
  failures++;
}
console.log(`  <= ${FACTOR_WINDOW} bars: bit-for-bit identical to the pre-extraction implementation`);
console.log(`  >  ${FACTOR_WINDOW} bars: F3/F4 equal the original fed the window (${diverged} cases where that`);
console.log('     genuinely differs), every other field equals the original fed everything');
if (failures) { console.log(`
${failures} FAILED — the extraction is NOT accounted for`); process.exit(1); }
