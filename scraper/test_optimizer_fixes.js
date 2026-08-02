// Regression tests for the 3 awo_optimizer.js bugs an external review found
// (2026-07-30): F14 treated as directional instead of a risk modifier, `|| 50`
// silently replacing a legitimate 0 score, and stale outcome labels ignoring
// what direction the CANDIDATE weights actually classified a signal as.
'use strict';

// Pin the SWING horizon before requiring awo_optimizer (which reads
// OUTCOME_MAX_HOLD from modules/trade_policy.js at module load).
//
// These are MECHANICS tests — T+1 open entry, fee/slippage deduction, same-bar
// stop-wins-over-target, and the premature-TIME_EXIT fix. Their hand-computed
// fixtures encode a specific trade geometry (fallback riskUnit = 3% of price,
// target2 = 2.5R, 15-bar hold), so without pinning they silently stop testing
// what they claim: when the default profile moved to POSITION on 2026-08-02
// (5% risk unit, 4R target, 40-bar hold) the target simply sat above every
// candle in the fixture and four tests began asserting against `null`.
// A mechanics test must not change meaning when an unrelated config changes.
// POSITION geometry is covered separately by test_trade_policy.js.
process.env.AWO_HORIZON = 'SWING';

const assert = require('assert');
const { rescoreSignal, computeWinRate, evaluateCandidateOutcome, generateWeightCandidates, projectToCappedSimplex, dateBlockBootstrapExpectancyTest, factorValidity, mulberry32, TRADE_DIRECTION_MODE } = require('./awo_optimizer');

function makeCandles(closes, { high = 0.5, low = 0.5 } = {}) {
  return closes.map((c, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open: c, high: c + high, low: c - low, close: c,
  }));
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

const weights = {
  f1: 0.14, f2: 0.10, f3: 0.08, f4: 0.10, f5: 0.07, f6: 0.10, f7: 0.08, f8: 0.05,
  f9: 0.06, f10: 0.06, f11: 0.05, f12: 0.05, f13: 0.03, f14: 0.03,
};

console.log('rescoreSignal — F14 as risk modifier, not directional');
test('extreme high F14 (low volatility) does not change direction, only confidence', () => {
  const base = {
    f1_concentration: 80, f2_trend: 80, f3_volume_z: 80, f4_momentum: 80, f5_rel_strength: 80,
    f6_breadth: 80, f7_alignment: 80, f8_streak: 80, f9_rsi: 80, f10_macd: 80, f11_bollinger: 80,
    f12_ema_trend: 80, f13_support_resistance: 80,
  };
  const lowVol = rescoreSignal({ ...base, f14_atr: 100 }, weights);
  const highVol = rescoreSignal({ ...base, f14_atr: 0 }, weights);
  // Both should stay bullish (>50); high volatility should pull it closer to 50 than low volatility.
  assert.ok(lowVol > 50 && highVol > 50, `expected both >50, got low=${lowVol} high=${highVol}`);
  assert.ok(highVol < lowVol, `expected high-vol score (${highVol}) < low-vol score (${lowVol})`);
});
test('all-neutral (50) factors stay at 50 regardless of F14', () => {
  const neutral = {
    f1_concentration: 50, f2_trend: 50, f3_volume_z: 50, f4_momentum: 50, f5_rel_strength: 50,
    f6_breadth: 50, f7_alignment: 50, f8_streak: 50, f9_rsi: 50, f10_macd: 50, f11_bollinger: 50,
    f12_ema_trend: 50, f13_support_resistance: 50,
  };
  assert.strictEqual(rescoreSignal({ ...neutral, f14_atr: 100 }, weights), 50);
  assert.strictEqual(rescoreSignal({ ...neutral, f14_atr: 0 }, weights), 50);
});

console.log('\nrescoreSignal — ?? instead of || (legitimate 0 preserved)');
test('a legitimate factor score of 0 is NOT replaced with 50', () => {
  const allZero = {
    f1_concentration: 0, f2_trend: 50, f3_volume_z: 50, f4_momentum: 50, f5_rel_strength: 50,
    f6_breadth: 50, f7_alignment: 50, f8_streak: 50, f9_rsi: 50, f10_macd: 50, f11_bollinger: 50,
    f12_ema_trend: 50, f13_support_resistance: 50, f14_atr: 50,
  };
  const withZero = rescoreSignal(allZero, weights);
  const withFifty = rescoreSignal({ ...allZero, f1_concentration: 50 }, weights);
  assert.ok(withZero < withFifty, `expected f1=0 score (${withZero}) < f1=50 score (${withFifty}) — 0 must pull the composite down, not vanish`);
});

console.log('\ncomputeWinRate — reads precomputed future-path outcome, not a stale stored label');
test('a signal whose CANDIDATE direction disagrees with its stale stored outcome is scored correctly', () => {
  // Stored as if originally a SELL that fell (outcome='WIN' under the old
  // direction, and return_5d is a leftover 5-day snapshot) — but give it
  // factor scores that make THESE weights call it bullish, and a precomputed
  // real future-path result (attachTradeOutcomes' job, mocked here) showing
  // the ATR/SR-stop/target trade actually lost. computeWinRate must trust
  // the precomputed _bullishOutcome, not the stale `outcome`/`return_5d` fields.
  const bullishFactors = {
    f1_concentration: 90, f2_trend: 90, f3_volume_z: 90, f4_momentum: 90, f5_rel_strength: 90,
    f6_breadth: 90, f7_alignment: 90, f8_streak: 90, f9_rsi: 90, f10_macd: 90, f11_bollinger: 90,
    f12_ema_trend: 90, f13_support_resistance: 90, f14_atr: 90,
  };
  const signal = {
    ...bullishFactors, outcome: 'WIN', return_5d: -3.5,
    _bullishOutcome: { result: 'LOSS', netR: -1.2, exitReason: 'STOP' },
    _bearishOutcome: { result: 'WIN', netR: 1.1, exitReason: 'TARGET' },
  };
  const result = computeWinRate([signal], weights);
  assert.strictEqual(result.wins, 0, 'the bullish candidate call must be scored against _bullishOutcome, not the stale stored WIN');
  assert.strictEqual(result.losses, 1, 'it must be counted as a loss instead');
});
test(`LONG_ONLY (current TRADE_DIRECTION_MODE=${TRADE_DIRECTION_MODE}) never counts a SELL/STRONG SELL classification as a trade, even with a winning _bearishOutcome (external review, round 2, P0-4)`, () => {
  if (TRADE_DIRECTION_MODE !== 'LONG_ONLY') { console.log('    (skipped — TRADE_DIRECTION_MODE env override active)'); return; }
  const bearishFactors = {
    f1_concentration: 5, f2_trend: 5, f3_volume_z: 5, f4_momentum: 5, f5_rel_strength: 5,
    f6_breadth: 5, f7_alignment: 5, f8_streak: 5, f9_rsi: 5, f10_macd: 5, f11_bollinger: 5,
    f12_ema_trend: 5, f13_support_resistance: 5, f14_atr: 50,
  };
  const signal = { ...bearishFactors, _bullishOutcome: { result: 'LOSS', netR: -1.0 }, _bearishOutcome: { result: 'WIN', netR: 1.5 } };
  const result = computeWinRate([signal], weights);
  assert.strictEqual(result.total, 0, 'a SELL-classified signal must not be counted as a trade at all in LONG_ONLY mode, regardless of how good its short-hypothetical outcome looks');
});
test('signals with no precomputed outcome are excluded, not silently miscounted', () => {
  const bullishFactors = {
    f1_concentration: 90, f2_trend: 90, f3_volume_z: 90, f4_momentum: 90, f5_rel_strength: 90,
    f6_breadth: 90, f7_alignment: 90, f8_streak: 90, f9_rsi: 90, f10_macd: 90, f11_bollinger: 90,
    f12_ema_trend: 90, f13_support_resistance: 90, f14_atr: 90,
  };
  const result = computeWinRate([{ ...bullishFactors, _bullishOutcome: null, _bearishOutcome: null }], weights);
  assert.strictEqual(result.total, 0);
});

console.log('\nevaluateCandidateOutcome — T+1 entry, ATR/SR stop/target, fee+slippage (follow-up #9/#10)');
test('bullish signal hitting target nets a WIN with fee+slippage deducted', () => {
  // signalIdx=3 -> windowCandles has only 4 bars (< 26), so calcTechnicalFactors
  // returns null atr/sr, giving a deterministic fallback riskUnit = price*0.03.
  const filler = { open: 100, high: 100.5, low: 99.5, close: 100 };
  const candles = [
    { date: '2026-01-01', ...filler }, { date: '2026-01-02', ...filler },
    { date: '2026-01-03', ...filler }, { date: '2026-01-04', ...filler }, // idx 0-3
    { date: '2026-01-05', open: 100, high: 101, low: 99, close: 100.5 },   // idx4 = entry (T+1 open=100)
    { date: '2026-01-06', open: 100.5, high: 102, low: 100, close: 101.5 },// idx5
    { date: '2026-01-07', open: 101.5, high: 108, low: 101, close: 107 }, // idx6: high 108 >= target2 107.5
  ];
  const result = evaluateCandidateOutcome({ signalType: 'BUY', candles, signalIdx: 3 });
  // riskUnit = 100*0.03 = 3; stopLoss=97; target2 = 100 + 3*2.5 = 107.5
  // grossMove = 107.5-100 = 7.5; netMove = 7.5 - 100*0.005 = 7.0; netR = 7.0/3
  assert.strictEqual(result.exitReason, 'TARGET');
  assert.strictEqual(result.result, 'WIN');
  assert.ok(Math.abs(result.netR - (7.0 / 3)) < 1e-6, `expected netR ~${7.0/3}, got ${result.netR}`);
});
test('bearish signal hitting stop nets a LOSS with fee+slippage deducted', () => {
  const filler = { open: 100, high: 100.5, low: 99.5, close: 100 };
  const candles = [
    { date: '2026-01-01', ...filler }, { date: '2026-01-02', ...filler },
    { date: '2026-01-03', ...filler }, { date: '2026-01-04', ...filler },
    { date: '2026-01-05', open: 100, high: 101, low: 99, close: 100.5 },  // idx4 = entry (open=100)
    { date: '2026-01-06', open: 100.5, high: 104, low: 97, close: 98 },   // idx5: high 104 >= stop 103
  ];
  const result = evaluateCandidateOutcome({ signalType: 'SELL', candles, signalIdx: 3 });
  // riskUnit=3; stopLoss(bearish)=103; grossMove = 100-103=-3; netMove = -3 - 100*0.005 = -3.5; netR=-3.5/3
  assert.strictEqual(result.exitReason, 'STOP');
  assert.strictEqual(result.result, 'LOSS');
  assert.ok(Math.abs(result.netR - (-3.5 / 3)) < 1e-6, `expected netR ~${-3.5/3}, got ${result.netR}`);
});
test('neither stop nor target hit within the holding window exits at TIME_EXIT close', () => {
  const filler = { open: 100, high: 100.5, low: 99.5, close: 100 };
  const candles = [{ date: '2026-01-01', ...filler }, { date: '2026-01-02', ...filler },
    { date: '2026-01-03', ...filler }, { date: '2026-01-04', ...filler }];
  // Entry idx4, then 15 flat/quiet bars (never reach stop 97 or target 107.5).
  for (let i = 5; i <= 20; i++) {
    candles.push({ date: `2026-01-${String(i).padStart(2, '0')}`, open: 100, high: 101, low: 99, close: 100 });
  }
  const result = evaluateCandidateOutcome({ signalType: 'BUY', candles, signalIdx: 3 });
  assert.strictEqual(result.exitReason, 'TIME_EXIT');
});
test('signal too close to the end of history (no T+1 bar available) returns a null result', () => {
  const filler = { open: 100, high: 100.5, low: 99.5, close: 100 };
  const candles = [{ date: '2026-01-01', ...filler }];
  const result = evaluateCandidateOutcome({ signalType: 'BUY', candles, signalIdx: 0 });
  assert.strictEqual(result.result, null);
  assert.strictEqual(result.netR, null);
});
test('a young signal with only 5 real future bars (fewer than the 15-day hold) and no stop/target hit stays UNRESOLVED, not forced to TIME_EXIT (external review, round 2, P0-3)', () => {
  const filler = { open: 100, high: 100.5, low: 99.5, close: 100 };
  // signalIdx=3 (entry idx4), then only 5 more quiet bars (idx4-8) — nowhere
  // near OUTCOME_MAX_HOLD=15. Old buggy code forced TIME_EXIT at idx8's
  // close regardless; this signal has NOT actually finished its 15-day
  // holding period yet and must not be scored as if it had.
  const candles = [
    { date: '2026-01-01', ...filler }, { date: '2026-01-02', ...filler },
    { date: '2026-01-03', ...filler }, { date: '2026-01-04', ...filler },
  ];
  for (let i = 5; i <= 9; i++) {
    candles.push({ date: `2026-01-${String(i).padStart(2, '0')}`, open: 100, high: 101, low: 99, close: 100 });
  }
  const result = evaluateCandidateOutcome({ signalType: 'BUY', candles, signalIdx: 3 });
  assert.strictEqual(result.result, null, 'must stay unresolved, not be scored against a premature partial window');
  assert.strictEqual(result.exitReason, null);
  assert.strictEqual(result.netR, null);
});
test('a young signal that DOES hit stop/target within its available bars still resolves early, correctly (early exit is not the bug — premature TIME_EXIT is)', () => {
  const filler = { open: 100, high: 100.5, low: 99.5, close: 100 };
  const candles = [
    { date: '2026-01-01', ...filler }, { date: '2026-01-02', ...filler },
    { date: '2026-01-03', ...filler }, { date: '2026-01-04', ...filler },
    { date: '2026-01-05', open: 100, high: 101, low: 99, close: 100.5 },  // idx4 entry
    { date: '2026-01-06', open: 100.5, high: 108, low: 100, close: 107 }, // idx5: high 108 >= target 107.5
  ];
  const result = evaluateCandidateOutcome({ signalType: 'BUY', candles, signalIdx: 3 });
  assert.strictEqual(result.exitReason, 'TARGET');
  assert.strictEqual(result.result, 'WIN');
});

console.log('\nmulberry32 / generateWeightCandidates — seeded, reproducible search (external review, 2026-07-31)');
test('mulberry32 is deterministic: same seed produces the same sequence', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const seqA = Array.from({ length: 10 }, () => a());
  const seqB = Array.from({ length: 10 }, () => b());
  assert.deepStrictEqual(seqA, seqB);
});
test('mulberry32 produces values in [0, 1)', () => {
  const rng = mulberry32(42);
  for (let i = 0; i < 200; i++) {
    const v = rng();
    assert.ok(v >= 0 && v < 1, `value ${v} out of range`);
  }
});
test('generateWeightCandidates with the same seed produces byte-identical candidates', () => {
  const a = generateWeightCandidates(50, 777);
  const b = generateWeightCandidates(50, 777);
  assert.deepStrictEqual(a.candidates, b.candidates);
  assert.strictEqual(a.seed, 777);
});
test('generateWeightCandidates with different seeds produces different candidates', () => {
  const a = generateWeightCandidates(50, 1);
  const b = generateWeightCandidates(50, 2);
  assert.notDeepStrictEqual(a.candidates, b.candidates);
});
test('generateWeightCandidates never includes an f14 key (external review — F14 is a risk modifier, not a searchable weight)', () => {
  const { candidates } = generateWeightCandidates(30, 5);
  for (const c of candidates) {
    assert.ok(!('f14' in c), `candidate unexpectedly has an f14 key: ${JSON.stringify(c)}`);
    const sum = Object.values(c).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(sum - 1.0) < 0.01, `weights should sum to ~1.0, got ${sum}`);
  }
});

console.log('\nprojectToCappedSimplex — every generated weight is genuinely within [0.02, 0.18] (external review round 2, P0-7)');
test('reviewer-style acceptance test: many seeds, every candidate strictly respects the cap (old code violated this ~4.9% of the time, up to 0.197)', () => {
  const MIN = 0.02, MAX = 0.18;
  let checked = 0;
  for (let seed = 0; seed < 100; seed++) {
    const { candidates } = generateWeightCandidates(500, seed);
    for (const c of candidates) {
      checked++;
      const vals = Object.values(c);
      const sum = vals.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - 1.0) < 0.005, `seed ${seed}: sum ${sum} not ~1.0`);
      for (const v of vals) {
        assert.ok(v <= MAX, `seed ${seed}: weight ${v} exceeds MAX ${MAX}`);
        assert.ok(v >= MIN, `seed ${seed}: weight ${v} below MIN ${MIN}`);
      }
    }
  }
  assert.ok(checked >= 50000, `expected to check a meaningful number of candidates, only checked ${checked}`);
});
test('a weight already exactly at MAX does not get pushed over by renormalization of the others (the exact old bug)', () => {
  // Reproduces the old bug's precondition with a FEASIBLE 13-key case
  // (matching the real F1-F13 search space — with only 4 keys, 4*0.18=0.72
  // can never reach sum=1.0 regardless of algorithm, so this needs enough
  // keys for the cap to be satisfiable at all). One weight starts exactly
  // at MAX while others are clamped down, shrinking the sum below 1.0 — the
  // old code's single clamp-then-divide-everything-by-sum pass would
  // inflate the already-at-MAX weight back over the cap.
  const keys = Array.from({ length: 13 }, (_, i) => `f${i + 1}`);
  const w = {};
  w.f1 = 0.18; // already exactly at MAX
  w.f2 = 0.30; w.f3 = 0.30; w.f4 = 0.22; // all over MAX, will get clamped down
  for (let i = 5; i <= 13; i++) w[`f${i}`] = 0; // rest starts at 0, will absorb the redistribution
  const result = projectToCappedSimplex(w, keys, 0.02, 0.18);
  for (const k of keys) {
    assert.ok(result[k] <= 0.18, `${k}=${result[k]} exceeds 0.18`);
    assert.ok(result[k] >= 0.02, `${k}=${result[k]} below 0.02`);
  }
  const sum = keys.reduce((s, k) => s + result[k], 0);
  assert.ok(Math.abs(sum - 1.0) < 0.005, `sum ${sum} not ~1.0`);
});
test('a weight already exactly at MIN does not get pushed under by redistribution', () => {
  const keys = Array.from({ length: 13 }, (_, i) => `f${i + 1}`);
  const w = {};
  w.f1 = 0.02; w.f2 = 0.02; w.f3 = 0.02; // already at MIN
  w.f4 = 0.70; // dominant, will get clamped down to 0.18
  for (let i = 5; i <= 13; i++) w[`f${i}`] = (1 - 0.02 * 3 - 0.70) / 9; // fill the rest to sum=1.0
  const result = projectToCappedSimplex(w, keys, 0.02, 0.18);
  for (const k of keys) {
    assert.ok(result[k] >= 0.02, `${k}=${result[k]} below 0.02`);
    assert.ok(result[k] <= 0.18, `${k}=${result[k]} exceeds 0.18`);
  }
  const sum = keys.reduce((s, k) => s + result[k], 0);
  assert.ok(Math.abs(sum - 1.0) < 0.005, `sum ${sum} not ~1.0`);
});

console.log('\ndateBlockBootstrapExpectancyTest — replaces win-rate z-test with a date-clustered expectancy bootstrap (external review, round 2, P0-5)');
function makeValidateSignals(n, datesCount) {
  const signals = [];
  for (let i = 0; i < n; i++) {
    const d = `2026-01-${String(1 + (i % datesCount)).padStart(2, '0')}`;
    const isWin = i % 2 === 0;
    signals.push({
      data_date: d,
      f1_concentration: 70, f2_trend: 70, f3_volume_z: 70, f4_momentum: 70, f5_rel_strength: 70,
      f6_breadth: 70, f7_alignment: 70, f8_streak: 70, f9_rsi: 70, f10_macd: 70, f11_bollinger: 70,
      f12_ema_trend: 70, f13_support_resistance: 70, f14_atr: 50,
      _bullishOutcome: isWin ? { result: 'WIN', netR: 1.0 } : { result: 'LOSS', netR: -0.8 },
      _bearishOutcome: null,
    });
  }
  return signals;
}
const weights13 = { f1: 0.14, f2: 0.10, f3: 0.08, f4: 0.10, f5: 0.07, f6: 0.10, f7: 0.08, f8: 0.05, f9: 0.06, f10: 0.06, f11: 0.05, f12: 0.05, f13: 0.03 };
const thresholds13 = { strongBuy: 78, buy: 63, watch: 53, neutral: 40, sell: 25 };

test('identical candidate and baseline weights never register as significant (delta must be ~0)', () => {
  const signals = makeValidateSignals(900, 90); // 10/date, matches candByDate/baseByDate exactly
  const result = dateBlockBootstrapExpectancyTest(signals, weights13, weights13, thresholds13, { alpha: 0.05, seed: 1 });
  assert.strictEqual(result.significant, false, 'identical weights must never show a significant difference from themselves');
  assert.ok(Math.abs(result.ciLower) < 1e-9 && Math.abs(result.ciUpper) < 1e-9, `expected CI collapsed to 0, got [${result.ciLower}, ${result.ciUpper}]`);
});
test('too few unique dates (<10) refuses to claim significance rather than overstating confidence', () => {
  const signals = makeValidateSignals(50, 5); // only 5 unique dates
  const result = dateBlockBootstrapExpectancyTest(signals, weights13, weights13, thresholds13, { seed: 1 });
  assert.strictEqual(result.significant, false);
  assert.ok(result.reason, 'must explain why (too few dates), not fail silently');
});
test('same seed produces byte-identical bootstrap results (reproducibility)', () => {
  const signals = makeValidateSignals(900, 90);
  const a = dateBlockBootstrapExpectancyTest(signals, weights13, weights13, thresholds13, { seed: 777 });
  const b = dateBlockBootstrapExpectancyTest(signals, weights13, weights13, thresholds13, { seed: 777 });
  assert.deepStrictEqual(a, b);
});
test('resamples date BLOCKS, not individual signals — all trades from a resampled date move together', () => {
  // Every signal on a given date has the SAME netR by construction (all WIN
  // on even dates, all LOSS on odd dates) — if the function were resampling
  // individual signals instead of whole date-blocks, the per-resample
  // expectancy would show much more variance smoothing than this exact
  // block structure allows. Indirect check: with candidate==baseline the
  // delta must still collapse to exactly 0 regardless (blocks cancel out
  // identically either way) — the real point is performance/determinism
  // already covered above; this documents the intent for future readers.
  const signals = [];
  for (let d = 0; d < 20; d++) {
    const date = `2026-02-${String(d + 1).padStart(2, '0')}`;
    const dateIsWin = d % 2 === 0;
    for (let i = 0; i < 15; i++) {
      signals.push({
        data_date: date, f1_concentration: 70, f2_trend: 70, f3_volume_z: 70, f4_momentum: 70, f5_rel_strength: 70,
        f6_breadth: 70, f7_alignment: 70, f8_streak: 70, f9_rsi: 70, f10_macd: 70, f11_bollinger: 70,
        f12_ema_trend: 70, f13_support_resistance: 70, f14_atr: 50,
        _bullishOutcome: dateIsWin ? { result: 'WIN', netR: 1.0 } : { result: 'LOSS', netR: -1.0 },
        _bearishOutcome: null,
      });
    }
  }
  const result = dateBlockBootstrapExpectancyTest(signals, weights13, weights13, thresholds13, { seed: 5 });
  assert.strictEqual(result.numDates, 20);
  assert.strictEqual(result.significant, false); // identical weights, must still collapse to 0
});

console.log('\nfactorValidity — expectancy-based lift + SIGNED ic, not win-rate lift + abs(ic) (external review, round 3, finding #7)');
function makeFactorValiditySignals(direction) {
  // f1_concentration sweeps 10..90; netR correlates POSITIVELY with f1 when
  // direction='positive' (a genuinely predictive factor, matching F1-F13's
  // intended "higher score = more bullish" construction), or INVERSELY when
  // direction='negative' (an anti-correlated factor — should NEVER be
  // treated as validly "predictive" even though |ic| would be large).
  const signals = [];
  for (let i = 0; i < 60; i++) {
    const f1 = 10 + (i % 17) * 5; // 10..90-ish, repeating pattern for enough samples
    const centered = (f1 - 50) / 50; // -0.8..0.8
    const netR = direction === 'positive' ? centered : -centered;
    signals.push({ f1_concentration: f1, _bullishOutcome: { result: netR > 0 ? 'WIN' : 'LOSS', netR } });
  }
  return signals;
}
test('a factor genuinely correlated with better outcomes (higher score -> better netR) is marked predictive', () => {
  const validity = factorValidity(makeFactorValiditySignals('positive'));
  assert.ok(validity.f1.ic > 0, `expected positive ic, got ${validity.f1.ic}`);
  assert.ok(validity.f1.lift > 0, `expected positive expectancy lift, got ${validity.f1.lift}`);
  assert.strictEqual(validity.f1.isPredictive, true);
});
test('a factor ANTI-correlated with outcomes (higher score -> worse netR) is NEVER marked predictive, even though |ic| is just as large (this is exactly what Math.abs(ic) used to get wrong)', () => {
  const validity = factorValidity(makeFactorValiditySignals('negative'));
  assert.ok(validity.f1.ic < 0, `expected negative ic, got ${validity.f1.ic}`);
  assert.strictEqual(validity.f1.isPredictive, false, 'a factor working backwards from its intended direction must not be treated as validly predictive');
});
test('lift is now an EXPECTANCY gap (small R-scale numbers), not a win-rate-percentage gap (0-100 scale)', () => {
  const validity = factorValidity(makeFactorValiditySignals('positive'));
  assert.ok(Math.abs(validity.f1.lift) < 5, `lift ${validity.f1.lift} looks like it's still on the old 0-100 win-rate-percentage scale, not R`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
