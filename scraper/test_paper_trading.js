// Unit tests for modules/paper_trading.js (P1 follow-up #18, 2026-07-30).
// candidateKeyFromWeights and walkForwardResolve are pure functions, tested
// directly without a database — same pattern as evaluateCandidateOutcome's
// tests in test_optimizer_fixes.js. generatePaperTrades/resolvePaperTrades'
// DB I/O is exercised indirectly via these two pure building blocks.
'use strict';

const assert = require('assert');
const { candidateKeyFromWeights, walkForwardResolve, summarizeTrades, generatePaperTrades, MAX_HOLD_DAYS } = require('./modules/paper_trading');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); failed++; }
}
// For the 2 tests below that genuinely need `await` (generatePaperTrades is
// async) — collected and awaited before the final tally, so pass/fail counts
// can't be printed before these actually resolve.
const asyncTests = [];
function testAsync(name, fn) {
  asyncTests.push(
    Promise.resolve().then(fn)
      .then(() => { console.log(`  ✓ ${name}`); passed++; })
      .catch(err => { console.log(`  ✗ ${name}\n    ${err.message}`); failed++; })
  );
}

console.log('candidateKeyFromWeights — stable identity across repeated /run calls');
test('identical weights produce the identical key', () => {
  const w = { f1: 0.14, f2: 0.10, f3: 0.08 };
  assert.strictEqual(candidateKeyFromWeights(w), candidateKeyFromWeights({ ...w }));
});
test('key is independent of property insertion order', () => {
  const a = { f1: 0.14, f2: 0.10, f3: 0.08 };
  const b = { f3: 0.08, f1: 0.14, f2: 0.10 };
  assert.strictEqual(candidateKeyFromWeights(a), candidateKeyFromWeights(b));
});
test('meaningfully different weights produce a different key', () => {
  const a = { f1: 0.14, f2: 0.10 };
  const b = { f1: 0.20, f2: 0.10 };
  assert.notStrictEqual(candidateKeyFromWeights(a), candidateKeyFromWeights(b));
});
test('floating-point noise below the rounding precision does not change the key', () => {
  const a = { f1: 0.14, f2: 0.10 };
  const b = { f1: 0.1400001, f2: 0.10 };
  assert.strictEqual(candidateKeyFromWeights(a), candidateKeyFromWeights(b));
});
test('same weights but DIFFERENT thresholds produce different keys (external review, 2026-07-31 — two candidates that classify signals differently must not share a paper track record)', () => {
  const w = { f1: 0.14, f2: 0.10 };
  const thresholdsA = { strongBuy: 78, buy: 63, watch: 53, neutral: 40, sell: 25 };
  const thresholdsB = { strongBuy: 80, buy: 65, watch: 55, neutral: 40, sell: 25 };
  assert.notStrictEqual(candidateKeyFromWeights(w, thresholdsA), candidateKeyFromWeights(w, thresholdsB));
});
test('same weights and thresholds but different model version produce different keys', () => {
  const w = { f1: 0.14, f2: 0.10 };
  const t = { strongBuy: 78, buy: 63, watch: 53, neutral: 40, sell: 25 };
  assert.notStrictEqual(candidateKeyFromWeights(w, t, '3.3-awo'), candidateKeyFromWeights(w, t, '4.0.0-research'));
});
test('identical weights AND identical thresholds still produce the identical key', () => {
  const w = { f1: 0.14, f2: 0.10 };
  const t = { strongBuy: 78, buy: 63, watch: 53, neutral: 40, sell: 25 };
  assert.strictEqual(candidateKeyFromWeights(w, { ...t }), candidateKeyFromWeights(w, { ...t }));
});
test('nonbehavioral research-metric fields (winRate/sampleSize/expectancy/profitFactor) on the thresholds object are ignored for identity (external review, round 3, finding #8 — optimizeThresholds() returns exactly this shape)', () => {
  const w = { f1: 0.14, f2: 0.10 };
  const behavioral = { strongBuy: 78, buy: 63, watch: 53, neutral: 40, sell: 25 };
  const withResearchMetrics = { ...behavioral, winRate: 52, sampleSize: 120, expectancy: 0.18, profitFactor: 1.31 };
  const withDifferentResearchMetrics = { ...behavioral, winRate: 61, sampleSize: 87, expectancy: 0.22, profitFactor: 1.44 };
  assert.strictEqual(
    candidateKeyFromWeights(w, withResearchMetrics),
    candidateKeyFromWeights(w, withDifferentResearchMetrics),
    'two runs landing on the SAME behavioral thresholds must produce the same candidate key regardless of what research metrics happen to be attached'
  );
  assert.strictEqual(candidateKeyFromWeights(w, withResearchMetrics), candidateKeyFromWeights(w, behavioral), 'must also match the key computed from behavioral-only fields');
});

console.log('\ngeneratePaperTrades — must use the caller-supplied candidateKey, never recompute one (external review, round 2, P0-1)');
testAsync('throws if candidateKey is omitted, instead of silently recomputing a possibly-different one', async () => {
  const w = { f1: 0.14 };
  const t = { strongBuy: 78, buy: 63, watch: 53, neutral: 40, sell: 25 };
  await assert.rejects(() => generatePaperTrades({ query: async () => { throw new Error('should not be called'); } }, w, t, undefined));
});
testAsync('inserted paper trades are tagged with EXACTLY the candidateKey passed in, matching what a challenger frozen with a modelVersion would use', async () => {
  const w = { f1: 90, f2: 90, f3: 90, f4: 90, f5: 90, f6: 90, f7: 90, f8: 90, f9: 90, f10: 90, f11: 90, f12: 90, f13: 90 };
  const t = { strongBuy: 78, buy: 63, watch: 53, neutral: 40, sell: 25 };
  const frozenKey = candidateKeyFromWeights(w, t, '4.0.0-research'); // exactly how getOrFreezeChallenger computes it
  const insertedKeys = [];
  const mockPool = {
    async query(sql, params) {
      if (sql.includes('SELECT MAX(data_date)')) return [[{ d: '2026-07-30' }]];
      if (sql.includes('FROM idx_signal_history WHERE data_date')) {
        return [[{ stock_code: 'BBCA', f1: 90, f2: 90, f3: 90, f4: 90, f5: 90, f6: 90, f7: 90, f8: 90, f9: 90, f10: 90, f11: 90, f12: 90, f13: 90, f14: 50, price_at_signal: 9000 }]];
      }
      if (sql.includes('INSERT IGNORE INTO awo_paper_trades')) { insertedKeys.push(params[0]); return [{}]; }
      throw new Error('unexpected query: ' + sql);
    },
  };
  const result = await generatePaperTrades(mockPool, w, t, frozenKey);
  assert.strictEqual(result.generated, 1);
  assert.strictEqual(insertedKeys.length, 1);
  assert.strictEqual(insertedKeys[0], frozenKey, 'the INSERTed candidate_key must match the frozen challenger key exactly — this is what P0-1 broke (paper trades filed under a different, unversioned key that getPaperTradeSummary could never find)');
});
testAsync('a SELL/STRONG SELL classification never opens a paper trade in LONG_ONLY mode (external review, round 2, P0-4 — was previously opened unconditionally, inconsistent with the "Long only" backtest registry and BUY-only threshold optimization)', async () => {
  const bearishW = { f1: 5, f2: 5, f3: 5, f4: 5, f5: 5, f6: 5, f7: 5, f8: 5, f9: 5, f10: 5, f11: 5, f12: 5, f13: 5 };
  const t = { strongBuy: 78, buy: 63, watch: 53, neutral: 40, sell: 25 };
  const key = candidateKeyFromWeights(bearishW, t, '4.0.0-research');
  const insertedKeys = [];
  const mockPool = {
    async query(sql, params) {
      if (sql.includes('SELECT MAX(data_date)')) return [[{ d: '2026-07-30' }]];
      if (sql.includes('FROM idx_signal_history WHERE data_date')) {
        return [[{ stock_code: 'BBCA', f1: 5, f2: 5, f3: 5, f4: 5, f5: 5, f6: 5, f7: 5, f8: 5, f9: 5, f10: 5, f11: 5, f12: 5, f13: 5, f14: 50, price_at_signal: 9000 }]];
      }
      if (sql.includes('INSERT IGNORE INTO awo_paper_trades')) { insertedKeys.push(params[0]); return [{}]; }
      throw new Error('unexpected query: ' + sql);
    },
  };
  const result = await generatePaperTrades(mockPool, bearishW, t, key);
  assert.strictEqual(result.generated, 0, 'a bearish/SELL classification must not generate a paper trade in the default LONG_ONLY mode');
  assert.strictEqual(insertedKeys.length, 0);
});

console.log('\nsummarizeTrades — profitFactor must actually exist (external review, round 2, P0-2: the /promote gate referenced this field but it was never computed, so `undefined < 1.10` silently passed every candidate)');
test('a losing track record (0 wins, all losses) has profitFactor 0, not null/undefined', () => {
  const rows = [
    { status: 'LOSS', net_r: -1.2, signal_date: '2026-07-01' },
    { status: 'LOSS', net_r: -0.8, signal_date: '2026-07-02' },
  ];
  const s = summarizeTrades(rows);
  assert.strictEqual(s.profitFactor, 0);
  assert.ok(s.profitFactor < 1.10, 'a 0/10-win record must fail the profit-factor gate, not silently pass it');
});
test('all-wins track record has profitFactor Infinity, correctly treated as passing', () => {
  const rows = [
    { status: 'WIN', net_r: 1.5, signal_date: '2026-07-01' },
    { status: 'WIN', net_r: 0.8, signal_date: '2026-07-02' },
  ];
  const s = summarizeTrades(rows);
  assert.strictEqual(s.profitFactor, Infinity);
});
test('no resolved trades yet has profitFactor null, not a false-passing number', () => {
  const rows = [{ status: 'PENDING_ENTRY', net_r: null, signal_date: '2026-07-01' }];
  const s = summarizeTrades(rows);
  assert.strictEqual(s.profitFactor, null);
});
test('a realistic mixed record computes the correct profit factor', () => {
  const rows = [
    { status: 'WIN', net_r: 2.0, signal_date: '2026-07-01' },
    { status: 'WIN', net_r: 1.0, signal_date: '2026-07-02' },
    { status: 'LOSS', net_r: -1.0, signal_date: '2026-07-03' },
  ];
  const s = summarizeTrades(rows);
  // grossProfit=3.0, grossLoss=1.0 -> PF=3.0
  assert.strictEqual(s.profitFactor, 3);
});

console.log('\nwalkForwardResolve — pure trade-resolution decision, no DB');
function candles(spec) {
  // spec: array of [date, open, high, low, close]
  return spec.map(([date, open, high, low, close]) => ({ date, open, high, low, close }));
}

test('bullish trade hitting target resolves WIN with fee/slippage deducted', () => {
  const bars = candles([
    ['2026-01-02', 100, 101, 99, 100.5],
    ['2026-01-03', 100.5, 108, 100, 107],
  ]);
  const trade = { entryPrice: 100, stopLoss: 97, target: 107.5, direction: 'BUY' };
  const r = walkForwardResolve(trade, bars);
  assert.strictEqual(r.exitReason, 'TARGET');
  assert.strictEqual(r.result, 'WIN');
  // risk=3, gross=7.5, net=7.5-100*0.005=7.0, netR=7/3
  assert.ok(Math.abs(r.netR - (7 / 3)) < 1e-6, `expected ~${7/3}, got ${r.netR}`);
});
test('bearish trade hitting stop resolves LOSS', () => {
  const bars = candles([
    ['2026-01-02', 100, 101, 99, 100.5],
    ['2026-01-03', 100.5, 104, 97, 98],
  ]);
  const trade = { entryPrice: 100, stopLoss: 103, target: 92.5, direction: 'SELL' };
  const r = walkForwardResolve(trade, bars);
  assert.strictEqual(r.exitReason, 'STOP');
  assert.strictEqual(r.result, 'LOSS');
});
test('not enough real bars yet (fewer than MAX_HOLD_DAYS, no stop/target hit) stays unresolved', () => {
  const bars = candles([
    ['2026-01-02', 100, 101, 99, 100],
    ['2026-01-03', 100, 101, 99, 100],
  ]); // only 2 bars, well under MAX_HOLD_DAYS, no stop/target hit
  const trade = { entryPrice: 100, stopLoss: 90, target: 130, direction: 'BUY' };
  const r = walkForwardResolve(trade, bars);
  assert.strictEqual(r.result, null, 'must not force a resolution before enough real days have elapsed');
});
test(`reaching exactly MAX_HOLD_DAYS (${MAX_HOLD_DAYS}) real bars with no hit forces TIME_EXIT`, () => {
  const bars = candles(
    Array.from({ length: MAX_HOLD_DAYS }, (_, i) => [`2026-02-${String(i + 1).padStart(2, '0')}`, 100, 101, 99, 100])
  );
  const trade = { entryPrice: 100, stopLoss: 90, target: 130, direction: 'BUY' };
  const r = walkForwardResolve(trade, bars);
  assert.strictEqual(r.exitReason, 'TIME_EXIT');
  assert.ok(r.result === 'WIN' || r.result === 'LOSS');
});
test('zero-risk trade (entry equals stop) is rejected, not divide-by-zero', () => {
  const bars = candles([['2026-01-02', 100, 101, 99, 100]]);
  const trade = { entryPrice: 100, stopLoss: 100, target: 110, direction: 'BUY' };
  const r = walkForwardResolve(trade, bars);
  assert.strictEqual(r.result, null);
  assert.ok(Number.isFinite(r.netR) || r.netR === null);
});

(async () => {
  await Promise.all(asyncTests);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
