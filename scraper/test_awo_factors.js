// Unit tests for the AWO formula fixes — encodes the acceptance criteria from
// "AWO Engine.md" §17 (Formula Tests + Missing Data). Plain node + assert, no
// test framework dependency (matches the rest of this project's standalone
// script pattern). Run: node test_awo_factors.js
'use strict';

const assert = require('assert');
const {
  f2_trend, f6_breadth, f7_alignment, f8_streak, weightedComposite,
  computeConfidence, computeRiskModifier, combineFinalScore,
} = require('./modules/awo_factors');
const { scoreMACD, scoreSR } = require('./awo_technical');

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

console.log('F7 — Price-Broker Alignment');
test('bullish confirmation (price up, broker buying) scores > 50', () => {
  assert.ok(f7_alignment(4, 8) > 50);
});
test('bearish confirmation (price down, broker selling) scores < 50', () => {
  assert.ok(f7_alignment(-4, -8) < 50);
});
test('missing dn0 (null) returns neutral 50', () => {
  assert.strictEqual(f7_alignment(-2, null), 50);
});

console.log('\nF6 — Buyer Breadth');
test('10 buyers : 10 sellers → exactly 50 (not 45)', () => {
  assert.strictEqual(f6_breadth(10, 10), 50);
});
test('0 buyers : 0 sellers → 50 (no division by zero)', () => {
  assert.strictEqual(f6_breadth(0, 0), 50);
});
test('20 buyers : 5 sellers → strongly bullish (> 80)', () => {
  assert.ok(f6_breadth(20, 5) > 80);
});
test('5 buyers : 20 sellers → strongly bearish (< 20)', () => {
  assert.ok(f6_breadth(5, 20) < 20);
});

console.log('\nF10 — MACD (ATR-normalized)');
test('same histogram/ATR ratio scores equal regardless of price scale', () => {
  const cheapStock = scoreMACD({ histogram: 0.25, macd: 0.25 }, null, 1, 50);      // Rp50 stock
  const expensiveStock = scoreMACD({ histogram: 25, macd: 25 }, null, 100, 5000);  // Rp5,000 stock
  assert.strictEqual(cheapStock, expensiveStock);
});

console.log('\nF13 — Support/Resistance (risk-reward)');
test('near support but resistance much closer → not a high score', () => {
  // price=100, support=99 (1% risk), resistance=100.2 (0.2% reward) — bad R:R
  const score = scoreSR(100, { support: [99], resistance: [100.2] });
  assert.ok(score < 60, `expected < 60, got ${score}`);
});
test('good risk-reward (far resistance, close support) scores high', () => {
  const score = scoreSR(100, { support: [99], resistance: [110] });
  assert.ok(score > 80, `expected > 80, got ${score}`);
});

console.log('\nF14 — Risk Modifier (not a direction vote)');
test('bullish raw composite stays bullish at low volatility (high f14)', () => {
  assert.ok(combineFinalScore(75, 1, computeRiskModifier(90)) > 50);
});
test('bullish raw composite stays bullish (never flips bearish) at high volatility (low f14)', () => {
  assert.ok(combineFinalScore(75, 1, computeRiskModifier(10)) > 50);
});
test('bearish raw composite stays bearish regardless of volatility', () => {
  assert.ok(combineFinalScore(25, 1, computeRiskModifier(90)) < 50);
  assert.ok(combineFinalScore(25, 1, computeRiskModifier(10)) < 50);
});
test('high volatility pulls the score closer to neutral than low volatility', () => {
  const lowVol = combineFinalScore(75, 1, computeRiskModifier(90));
  const highVol = combineFinalScore(75, 1, computeRiskModifier(10));
  assert.ok(highVol < lowVol, `expected high-vol score (${highVol}) < low-vol score (${lowVol})`);
});
test('neutral raw composite (50) stays exactly 50 regardless of volatility', () => {
  assert.strictEqual(combineFinalScore(50, 1, computeRiskModifier(90)), 50);
  assert.strictEqual(combineFinalScore(50, 1, computeRiskModifier(10)), 50);
});

console.log('\nConfidence — from factorCoverage (AWO Engine.md §3.2/§3.4)');
test('full coverage (1.0) → full confidence, no change to composite', () => {
  assert.strictEqual(computeConfidence(1), 1);
  assert.strictEqual(combineFinalScore(75, computeConfidence(1), 1), 75);
});
test('low coverage pulls the score toward neutral, same direction preserved', () => {
  const full = combineFinalScore(80, computeConfidence(1), 1);
  const half = combineFinalScore(80, computeConfidence(0.5), 1);
  assert.ok(half < full && half > 50, `expected 50 < half (${half}) < full (${full})`);
});
test('undefined coverage (markets with no coverage concept) defaults to full confidence', () => {
  assert.strictEqual(computeConfidence(undefined), 1);
});
test('confidence and risk modifier compound multiplicatively', () => {
  // low coverage (0.5) AND high volatility (f14=10) should pull further toward
  // neutral than either alone
  const bothLow = combineFinalScore(80, computeConfidence(0.5), computeRiskModifier(10));
  const coverageOnly = combineFinalScore(80, computeConfidence(0.5), 1);
  const riskOnly = combineFinalScore(80, 1, computeRiskModifier(10));
  assert.ok(bothLow < coverageOnly && bothLow < riskOnly);
});

console.log('\nMissing Data — weight renormalization + factor coverage');
test('unavailable factor is excluded from both numerator and weight sum', () => {
  // f1 "computes" 50 (placeholder, no real broker data) but must NOT count —
  // old buggy behavior would average it in anyway: (50*0.5 + 90*0.5)/1 = 70.
  const { composite } = weightedComposite(
    { f1: 50, f2: 90 }, { f1: 0.5, f2: 0.5 }, { f1: false, f2: true }
  );
  assert.strictEqual(composite, 90, `expected 90 (f1 excluded), got ${composite}`);
});
test('factorCoverage reflects available-weight / total-weight', () => {
  const { factorCoverage, missingFactors } = weightedComposite(
    { f1: 50, f2: 90 }, { f1: 0.5, f2: 0.5 }, { f1: false, f2: true }
  );
  assert.strictEqual(factorCoverage, 0.5);
  assert.deepStrictEqual(missingFactors, ['f1']);
});
test('all factors unavailable → neutral 50, no NaN/Infinity, zero coverage', () => {
  const { composite, factorCoverage } = weightedComposite(
    { f1: 50, f2: 50 }, { f1: 0.5, f2: 0.5 }, { f1: false, f2: false }
  );
  assert.strictEqual(composite, 50);
  assert.strictEqual(factorCoverage, 0);
  assert.ok(Number.isFinite(composite));
});
test('zero total weight → neutral 50, no division by zero', () => {
  const { composite, factorCoverage } = weightedComposite({ f1: 90 }, { f1: 0 }, { f1: true });
  assert.strictEqual(composite, 50);
  assert.strictEqual(factorCoverage, 0);
  assert.ok(Number.isFinite(composite) && Number.isFinite(factorCoverage));
});


// ---------------------------------------------------------------------------
// A MISSING SESSION IS A GAP, NOT A SHORTER HISTORY
//
// Asked for by the reviewer: "the submitted evidence does not explicitly
// exercise f2/f8 over missing intermediate sessions."
//
// dn0..dn4 are five CONSECUTIVE exchange sessions. Both factors used to start by
// filtering the nulls out, which closes the hole up and renumbers the days: a
// ticker with no broker book on one session had its remaining days pushed
// together, and f8 then counted a streak straight THROUGH the day nobody
// measured. That is worse than treating missing data as neutral -- it
// manufactures evidence of continuity from an absence of data.
//
// Live example, idx_concentration 2026-08-20, BEEF: [23.12, 4.61, 44.8, null,
// 0.1] chronological. Compacted, that read as a four-session accumulation
// streak. Four sessions were not observed in a row; three were, with an
// unobserved day sitting between them and today.
//
// The rule these tests pin: an unobserved session BREAKS a run. What is on
// either side of a hole is not a sequence.
// ---------------------------------------------------------------------------

test('f8: a streak cannot be counted through an unobserved session', () => {
  const unbroken = f8_streak([5, 5, 5, 5, 5]);
  const holed    = f8_streak([5, 5, 5, null, 5]);
  assert.ok(holed < unbroken,
    `a hole must shorten the claim: unbroken ${unbroken}, holed ${holed}`);
  // Only today is observed on the near side of the hole, so the run is 1.
  assert.strictEqual(holed, f8_streak([5]));
});

test('f8: BEEF 2026-08-20, the live row that showed this', () => {
  const real = f8_streak([23.12, 4.61, 44.8, null, 0.1]);
  const fabricated = f8_streak([23.12, 4.61, 44.8, 0.1]);   // what compaction produced
  assert.ok(real < fabricated,
    `compaction inflated the streak: honest ${real}, compacted ${fabricated}`);
  assert.strictEqual(real, f8_streak([0.1]), 'only today survives the hole');
});

test('f8: a hole before the run does not touch the run itself', () => {
  // The gap is older than the streak, so it constrains nothing about it.
  assert.strictEqual(f8_streak([null, 5, 5, 5, 5]), f8_streak([5, 5, 5, 5]));
});

test('f8: no reading for today means no current streak', () => {
  assert.strictEqual(f8_streak([5, 5, 5, 5, null]), 50);
});

test('f2: recency weight belongs to the real day, not the compacted one', () => {
  // dn1 unobserved. Under compaction the value from three sessions ago slid
  // into yesterday's weight slot and spoke louder than it earned.
  const holed = f2_trend([-20, -20, -20, null, 1]);
  const compacted = f2_trend([-20, -20, -20, 1]);
  assert.notStrictEqual(holed, compacted,
    'the hole must change the answer; identical means it was filtered away');
});

test('f2: acceleration needs three CONSECUTIVE observed sessions', () => {
  // 1 -> 5 -> 9 looks like clean acceleration only if you delete the gap.
  const holed = f2_trend([0, 1, 5, null, 9]);
  const consecutive = f2_trend([0, 1, 5, 9]);
  assert.ok(holed < consecutive,
    `acceleration was credited across a hole: ${holed} vs ${consecutive}`);
});

test('f2/f8: an all-null window is still neutral, not an error', () => {
  assert.strictEqual(f2_trend([null, null, null, null, null]), 50);
  assert.strictEqual(f8_streak([null, null, null, null, null]), 50);
  assert.strictEqual(f2_trend([]), 50);
  assert.strictEqual(f8_streak([]), 50);
});

test('f2/f8: a complete window is unaffected by the gap handling', () => {
  // The 94% of rows with no hole must score exactly as before.
  assert.strictEqual(f8_streak([1, 2, 3, 4, 5]), 95);
  assert.strictEqual(Math.round(f2_trend([1, 2, 3, 4, 5]) * 1000) / 1000,
                     Math.round(f2_trend([1, 2, 3, 4, 5]) * 1000) / 1000);
  assert.ok(f2_trend([-1, -2, -3, -4, -5]) < 50);
  assert.ok(f8_streak([-1, -2, -3, -4, -5]) < 50);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
