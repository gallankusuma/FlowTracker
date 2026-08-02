/**
 * awo_optimizer.js — Adaptive Weight Optimizer: Core Optimization Engine
 * ──────────────────────────────────────────────────────────────────────
 * Random-search weight optimizer for the 14-factor signal scoring engine
 * (8 broker-flow factors + 6 technical-analysis factors).
 *
 * Algorithm:
 *   1. Load signal history with outcomes
 *   2. Split into TRAIN (70%) / VALIDATE (30%) chronologically (single static split)
 *   3. Score 3000 randomly-generated weight candidates on TRAIN set
 *   4. Validate top 20 candidates on VALIDATE set
 *   5. Walk the validated ranking and adopt the first candidate that survives:
 *      - no factor holding >MAX_FACTOR_WEIGHT/2 of total weight without empirical
 *        train-set predictiveness (lift/IC from awo_analyzer)
 *      - minimum directional (BUY/SELL-class) sample size in validate
 *      - statistically significant improvement over baseline (two-proportion
 *        z-test, Bonferroni-corrected for the 20 candidates being tested)
 *      - no cross-tier monotonicity violation (a lower-scored tier meaningfully
 *        outperforming a higher-scored one on average forward return)
 *   6. If nothing survives, no weights are adopted this run.
 *
 * NOTE: despite earlier docs claiming "grid search + walk-forward validation",
 * candidate generation is unseeded random search and the split is a single
 * static cut, not rolling walk-forward folds — that gap is real and is exactly
 * what caused the 2026-07-19 overfitting incident these safeguards address.
 * Proper purged walk-forward CV is still a follow-up, not yet implemented here.
 *
 * Exports:
 *   optimizeWeights(pool, currentWeights)
 *   optimizeThresholds(signals, weights)
 */

'use strict';

const stats = require('./modules/statistics');
const { FACTORS, informationCoefficient } = require('./awo_analyzer');
const { combineFactorScores, classifySignal, DEFAULT_THRESHOLDS: SCORE_ENGINE_THRESHOLDS, DEFAULT_WEIGHTS: SCORE_ENGINE_DEFAULT_WEIGHTS } = require('./modules/score_engine');
const { calcTechnicalFactors, computeTradePlan } = require('./awo_technical');
const tradePolicy = require('./modules/trade_policy');

// Same cost assumption as the backtest scripts (backtest_baseline_comparison.js
// etc.) — a labeled ASSUMPTION (typical IDX retail order of magnitude), not
// this user's confirmed real broker fee schedule.
const FEE_BUY_PCT = 0.15, FEE_SELL_PCT = 0.25, SLIPPAGE_PCT = 0.10;
const ROUND_TRIP_COST_PCT = FEE_BUY_PCT + FEE_SELL_PCT + SLIPPAGE_PCT;
// Trading days a simulated signal may be held before a TIME_EXIT is forced.
// Was a hardcoded 15 (a 1-3 week swing horizon); now sourced from
// modules/trade_policy.js so it stays in lockstep with the live paper trader's
// MAX_HOLD_DAYS and with computeTradePlan's stop/target geometry — three knobs
// that must describe the same trading style or the optimizer trains on outcomes
// the live system would never produce. Read once at module load: a mid-run
// change would make earlier and later candidates incomparable.
const OUTCOME_MAX_HOLD = tradePolicy.active().maxHoldBars;

// Added 2026-07-31 (external review, round 2, P0-4): BACKTEST_EXPERIMENTS.md
// documents every backtest as "Direction: Long only", but `computeWinRate`
// counted SELL/STRONG SELL as tradeable SHORT positions, `optimizeThresholds`
// only ever considered BUY, and paper trading opened SELL trades too — three
// different, silently inconsistent notions of "direction" feeding the SAME
// candidate-selection pipeline. LONG_ONLY is the default because that's what
// the registry already claims and what IDX retail accounts can actually
// execute without a separate short-selling facility; SELL/STRONG SELL are
// treated as exit/avoid signals, not short entries, whenever this is set.
const TRADE_DIRECTION_MODE = process.env.TRADE_DIRECTION_MODE || 'LONG_ONLY';

function toDateStr(d) {
  return d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0];
}

/**
 * Evaluate what would ACTUALLY have happened for a candidate direction,
 * walking forward through real future OHLC bars — Review.md's
 * `evaluateCandidateOutcome` ask (follow-up #9/#10, 2026-07-30). Replaces
 * the old return_5d-snapshot approximation with T+1 open entry, ATR/SR-based
 * stop/target via the SAME `computeTradePlan` the live system uses, a
 * bounded holding period, and fee+slippage applied to a net result.
 *
 * @param {'BUY'|'STRONG BUY'|'SELL'|'STRONG SELL'} signalType
 * @param {Array<{date,open,high,low,close}>} candles - full history, oldest-first
 * @param {number} signalIdx - index into candles where the signal fired (data_date)
 * @returns {{result:'WIN'|'LOSS'|null, netR:number|null, exitReason:string|null}}
 */
function evaluateCandidateOutcome({ signalType, candles, signalIdx }) {
  const entryIdx = signalIdx + 1; // T+1 open
  if (!candles || entryIdx >= candles.length) return { result: null, netR: null, exitReason: null };

  // ATR/SR computed from data up to and including the SIGNAL day only — no
  // lookahead — same discipline as every backtest script this session.
  const windowCandles = candles.slice(0, signalIdx + 1);
  let atr = null, sr = null;
  try {
    const tech = calcTechnicalFactors(windowCandles.slice(-60));
    atr = tech.indicators?.atr ?? null;
    sr = tech.indicators?.sr ?? null;
  } catch {}

  const entryPrice = candles[entryIdx].open;
  const plan = computeTradePlan(entryPrice, signalType, atr, sr);
  if (!plan || !Number.isFinite(plan.stopLoss)) return { result: null, netR: null, exitReason: null };

  const isBullish = signalType === 'STRONG BUY' || signalType === 'BUY';
  const risk = Math.abs(entryPrice - plan.stopLoss);
  if (risk <= 0) return { result: null, netR: null, exitReason: null };

  // Fixed 2026-07-31 (external review, round 2 — P0-3): `lastIdx` clamps to
  // `candles.length - 1` when fewer than OUTCOME_MAX_HOLD future bars exist
  // yet (a recent signal, still "young"). The old code unconditionally
  // exited at that clamped last bar with `exitReason = 'TIME_EXIT'` — i.e. a
  // signal only 3 real days old got scored as if its FULL 15-day holding
  // period had already played out, using whatever price happened to be on
  // day 3. Now: TIME_EXIT only fires once OUTCOME_MAX_HOLD bars have
  // genuinely been available since entry; otherwise the signal is correctly
  // reported unresolved (same rule `walkForwardResolve` in
  // modules/paper_trading.js already used).
  const availableBars = candles.length - entryIdx;
  const lastIdx = Math.min(entryIdx + OUTCOME_MAX_HOLD - 1, candles.length - 1);
  let exitPrice = null, exitReason = null, holdDays = null;
  for (let j = entryIdx; j <= lastIdx; j++) {
    const bar = candles[j];
    const hitStop = isBullish ? bar.low <= plan.stopLoss : bar.high >= plan.stopLoss;
    const hitTarget = isBullish ? bar.high >= plan.target2 : bar.low <= plan.target2;
    // Same-bar ambiguity resolves to STOP (conservative) — AWO Engine.md §9.5.
    if (hitStop) { exitPrice = plan.stopLoss; exitReason = 'STOP'; holdDays = j - entryIdx + 1; break; }
    if (hitTarget) { exitPrice = plan.target2; exitReason = 'TARGET'; holdDays = j - entryIdx + 1; break; }
    if (j === lastIdx && availableBars >= OUTCOME_MAX_HOLD) {
      exitPrice = bar.close; exitReason = 'TIME_EXIT'; holdDays = j - entryIdx + 1;
    }
  }
  if (exitPrice === null) return { result: null, netR: null, exitReason: null, holdDays: null };

  const grossMove = isBullish ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
  const netMove = grossMove - (entryPrice * (ROUND_TRIP_COST_PCT / 100));
  const netR = netMove / risk;
  // holdDays added 2026-08-01 for backtest_momentum_leadership.js's reporting
  // (avg holding period) — purely additive, existing callers that destructure
  // only {result, netR, exitReason} are unaffected.
  return { result: netR > 0 ? 'WIN' : 'LOSS', netR, exitReason, holdDays };
}

/**
 * Precompute BOTH possible outcomes (as-if-BUY, as-if-SELL) for every signal
 * ONCE, attached directly to each signal object as `_bullishOutcome`/
 * `_bearishOutcome`. This MUST happen before the candidate search loop, not
 * inside `computeWinRate` — the trade-simulation walk-forward only depends
 * on direction + entry/exit mechanics, never on which weight CANDIDATE
 * produced that direction, so recomputing it per-candidate (3000+ times in
 * `optimizeWeights`) would redo identical, expensive work for no reason.
 */
async function attachTradeOutcomes(pool, signals) {
  const tickers = [...new Set(signals.map(s => s.stock_code))];
  if (tickers.length === 0) return;

  const [priceRows] = await pool.query(
    `SELECT stock_code, date, open_price o, high_price h, low_price l, close_price c
     FROM idx_stock_prices WHERE stock_code IN (?) ORDER BY date ASC`,
    [tickers]
  );
  const candlesByTicker = new Map();
  for (const r of priceRows) {
    if (!candlesByTicker.has(r.stock_code)) candlesByTicker.set(r.stock_code, []);
    candlesByTicker.get(r.stock_code).push({
      date: toDateStr(r.date), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c),
    });
  }
  const dateIndexByTicker = new Map();
  for (const [ticker, candles] of candlesByTicker) {
    const m = new Map();
    candles.forEach((c, i) => m.set(c.date, i));
    dateIndexByTicker.set(ticker, m);
  }

  for (const s of signals) {
    const candles = candlesByTicker.get(s.stock_code);
    const dateStr = toDateStr(s.data_date);
    const signalIdx = candles ? dateIndexByTicker.get(s.stock_code)?.get(dateStr) : undefined;
    if (candles && signalIdx !== undefined) {
      s._bullishOutcome = evaluateCandidateOutcome({ signalType: 'BUY', candles, signalIdx });
      s._bearishOutcome = evaluateCandidateOutcome({ signalType: 'SELL', candles, signalIdx });
    } else {
      s._bullishOutcome = null;
      s._bearishOutcome = null;
    }
  }
}

// Grid search parameters
const WEIGHT_STEPS = [0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.22, 0.25, 0.30];
const MIN_SIGNALS_TRAIN = 30; // minimum signals in train set
const MIN_SIGNALS_VALIDATE = 15; // minimum signals in validation set
const TOP_N_CANDIDATES = 20; // how many grid candidates to validate

// ─── Overfitting safeguards ────────────────────────────────────────────────
const MAX_FACTOR_WEIGHT = 0.18; // no single factor may exceed this share of total weight
const MIN_FACTOR_WEIGHT = 0.02;
const MIN_DIRECTIONAL_VALIDATE = 30; // minimum BUY/SELL-class signals in validate set behind a reported win rate
const SIGNIFICANCE_ALPHA = 0.05; // base false-positive rate for "is this candidate really better"
const BONFERRONI_ALPHA = SIGNIFICANCE_ALPHA / TOP_N_CANDIDATES; // corrected for testing TOP_N_CANDIDATES candidates
const MIN_TIER_SAMPLE = 15; // minimum signals in a tier before its avg return counts toward monotonicity
// R-multiples, not percentage points (external review, 2026-07-31 — see
// checkMonotonicity's doc comment for why this switched from return_5d%).
const MONOTONICITY_TOLERANCE_R = 0.2;
// factorValidity's predictiveness thresholds — R-multiples, not percentage
// points (external review, round 3, 2026-07-31 — see factorValidity's doc
// comment for why "lift" switched from a win-rate gap to an expectancy gap).
const MIN_FACTOR_LIFT_R = 0.05;
const MIN_FACTOR_IC = 0.05; // SIGNED, not abs() — see factorValidity's doc comment

// ─── Profitability gates (external review, 2026-07-31) ─────────────────────
// Previously the optimizer ranked and adopted candidates by WIN RATE alone
// (avgPnL was only a tiebreaker within 0.5pp), meaning a 70%-win-rate
// candidate with avg win +0.2R / avg loss -1.5R — a net LOSER — could win.
// Ranking and adoption now both require real profitability, not just
// accuracy. Numbers below are the reviewer's own suggested starting points,
// not formally derived — expected to be revisited once real data volume
// allows.
const MIN_TRAIN_SAMPLE_FOR_RANKING = 20; // floor before a candidate is even eligible for the train-set ranking, so a lucky 3-trade streak can't reach the top
const MIN_OOS_EXPECTANCY = 0; // out-of-sample (validate) expectancy must be positive
const MIN_OOS_PROFIT_FACTOR = 1.20; // out-of-sample profit factor floor
const MIN_EXPECTANCY_IMPROVEMENT = 0.05; // candidate must beat baseline's OOS expectancy by at least this many R

/**
 * Re-score a signal with given weights and return composite score.
 *
 * Migrated 2026-07-30 (follow-up #7 — single source of truth) to call
 * `combineFactorScores()` from `modules/score_engine.js` — the SAME
 * function server.js's live scoring now calls (see the fix note that used
 * to live here: F14 was being summed directly as a 14th directional vote,
 * inconsistent with the live engine's risk-modifier treatment since
 * 2026-07-28/29; `|| 50` was also silently replacing a legitimate score of
 * 0). Both bugs are now structurally impossible to reintroduce here, since
 * this file no longer has its own copy of the combination logic to drift.
 * Note: `idx_signal_history` doesn't store per-factor availability, so
 * every factor here is treated as available (confidence stays at 1) — this
 * recovers F14's directional-vs-risk consistency, not server.js's
 * missing-data coverage behavior (which needs raw broker data this stored
 * row doesn't retain).
 */
function rescoreSignal(signal, weights) {
  const f1 = Number(signal.f1_concentration ?? 50);
  const f2 = Number(signal.f2_trend ?? 50);
  const f3 = Number(signal.f3_volume_z ?? 50);
  const f4 = Number(signal.f4_momentum ?? 50);
  const f5 = Number(signal.f5_rel_strength ?? 50);
  const f6 = Number(signal.f6_breadth ?? 50);
  const f7 = Number(signal.f7_alignment ?? 50);
  const f8 = Number(signal.f8_streak ?? 50);
  // Technical factors
  const f9  = Number(signal.f9_rsi ?? 50);
  const f10 = Number(signal.f10_macd ?? 50);
  const f11 = Number(signal.f11_bollinger ?? 50);
  const f12 = Number(signal.f12_ema_trend ?? 50);
  const f13 = Number(signal.f13_support_resistance ?? 50);
  const f14 = Number(signal.f14_atr ?? 50);

  const { finalScore } = combineFactorScores(
    { f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13 }, f14, {}, weights
  );
  return finalScore;
}

/**
 * Classify signal based on composite score and thresholds — thin wrapper
 * kept for call-site compatibility below; delegates to the same
 * `classifySignal` server.js's live scoring uses (modules/score_engine.js).
 */
function classifyWithThresholds(score, thresholds) {
  return classifySignal(score, thresholds);
}

const DEFAULT_THRESHOLDS = SCORE_ENGINE_THRESHOLDS;

/**
 * Compute win rate for a set of signals with given weights
 * More sophisticated: considers prediction accuracy for directional signals
 *
 * Fixed 2026-07-30 (external review, two rounds):
 *   1. Previously read the STORED `s.outcome` field, labeled for whatever
 *      direction the signal had when it was ORIGINALLY saved — if these
 *      candidate weights reclassify the same signal to the OPPOSITE
 *      direction, the stale label would silently credit the wrong result.
 *   2. Then fixed to recompute WIN/LOSS from `return_5d` against the
 *      candidate's own classified direction — better, but still just a
 *      5-day-later snapshot, not a real trade (no T+1 entry, no stop/target,
 *      no fee/slippage, no holding-period discipline).
 * Now uses `s._bullishOutcome`/`s._bearishOutcome` — precomputed by
 * `attachTradeOutcomes()` via `evaluateCandidateOutcome`, a REAL future-path
 * walk-forward simulation (T+1 open, ATR/SR stop/target via the same
 * `computeTradePlan` the live system uses, fee+slippage, bounded holding
 * period). Signals without precomputed outcomes (no price history matched)
 * are excluded, same "can't evaluate what we don't know" principle as
 * everywhere else in this codebase.
 *
 * Also returns `expectancy` (mean net R, i.e. the SAME quantity as
 * `avgPnL` — kept as an alias since callers below were written against
 * `avgPnL` before this fix) and `profitFactor` (gross winning R / gross
 * losing R). Added 2026-07-31 (external review): a candidate can have a
 * high win rate and still be a net loser — e.g. 70% win rate at +0.2R avg
 * win / -1.5R avg loss is unprofitable — so ranking/adoption decisions
 * downstream must use expectancy/profit factor, not win rate alone. Win
 * rate is still returned and still meaningful as an INFORMATIONAL metric.
 */
function computeWinRate(signals, weights, thresholds = DEFAULT_THRESHOLDS) {
  let wins = 0;
  let losses = 0;
  let totalPnL = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  for (const s of signals) {
    const score = rescoreSignal(s, weights);
    const signal = classifyWithThresholds(score, thresholds);

    const isBullish = ['STRONG BUY', 'BUY'].includes(signal);
    // In LONG_ONLY mode (default — see TRADE_DIRECTION_MODE), SELL/STRONG
    // SELL are exit/avoid warnings, not tradeable short positions — they
    // never count toward win rate/expectancy here.
    const isBearish = TRADE_DIRECTION_MODE !== 'LONG_ONLY' && ['STRONG SELL', 'SELL'].includes(signal);
    if (!isBullish && !isBearish) continue; // skip WATCH/NEUTRAL (and SELL-class signals in LONG_ONLY mode)

    const outcome = isBullish ? s._bullishOutcome : s._bearishOutcome;
    if (!outcome || !outcome.result) continue; // no trade-simulation data available for this signal

    if (outcome.result === 'WIN') { wins++; grossProfit += outcome.netR; }
    else { losses++; grossLoss += Math.abs(outcome.netR); }
    totalPnL += outcome.netR;
  }

  const total = wins + losses;
  const winRate = total > 0 ? (wins / total) * 100 : 0;
  const avgPnL = total > 0 ? totalPnL / total : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);

  return { winRate, wins, losses, total, avgPnL, expectancy: avgPnL, profitFactor };
}

/**
 * Deterministic PRNG (mulberry32) — external review, 2026-07-31: candidate
 * generation previously used raw `Math.random()`, unseeded, so a run could
 * never be reproduced from a stored seed and "did today's search just get
 * unlucky" could never be distinguished from "the data genuinely changed."
 * Same algorithm already used elsewhere in this codebase's backtest scripts
 * (backtest_baseline_comparison.js's Random Entry baseline) for consistency.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate smart weight combinations using constraint:
 * - All weights sum to 1.0
 * - Each weight between 0.05 and 0.30
 *
 * Uses stratified random sampling instead of full grid (which would be 10^8 combos)
 *
 * @param {number} numCandidates
 * @param {number} [seed] - defaults to a fresh random seed if not provided
 *   (still recorded in the return value either way, so every run is
 *   reproducible after the fact even when the caller doesn't pin one).
 * @returns {{candidates: Object[], seed: number}}
 */
function generateWeightCandidates(numCandidates = 5000, seed = Date.now() >>> 0) {
  const rng = mulberry32(seed);
  const candidates = [];

  // Strategy 1: Random perturbation of default weights (2000 candidates)
  // F14 excluded (external review, 2026-07-31): it's a risk MODIFIER
  // (computeRiskModifier), never a directional weight — combineFactorScores
  // now strips any f14 key before the weighted sum regardless, so letting
  // the optimizer vary it here only wasted search space, inflated the
  // multiple-testing burden, and fragmented candidate identity (two
  // candidates with identical real F1-F13 weights but different f14 used to
  // hash to different paper-trading track records for zero behavioral
  // difference).
  const defaultW = {
    f1: 0.14, f2: 0.10, f3: 0.08, f4: 0.10, f5: 0.07, f6: 0.10, f7: 0.08, f8: 0.05,
    f9: 0.06, f10: 0.06, f11: 0.05, f12: 0.05, f13: 0.03,
  };
  const keys = Object.keys(defaultW);

  for (let i = 0; i < Math.floor(numCandidates * 0.4); i++) {
    const w = { ...defaultW };
    // Perturb 2-4 random weights
    const numPerturb = 2 + Math.floor(rng() * 3);
    for (let j = 0; j < numPerturb; j++) {
      const k = keys[Math.floor(rng() * keys.length)];
      w[k] = Math.max(0.03, Math.min(MAX_FACTOR_WEIGHT, w[k] + (rng() - 0.5) * 0.12));
    }
    // Normalize to sum = 1.0
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    for (const k of keys) w[k] = Math.round((w[k] / sum) * 1000) / 1000;
    candidates.push(w);
  }

  // Strategy 2: Extreme weight configs — test "what if factor X is emphasized" (1000)
  // Capped at MAX_FACTOR_WEIGHT (not a full-dominance 0.30 sweep) so this strategy
  // can no longer manufacture a single-factor-dominant candidate by construction.
  for (let fi = 0; fi < keys.length; fi++) {
    for (let n = 0; n < Math.floor(numCandidates * 0.1 / keys.length); n++) {
      const w = {};
      const remaining = 1.0 - MAX_FACTOR_WEIGHT;
      for (let k = 0; k < keys.length; k++) {
        w[keys[k]] = k === fi ? MAX_FACTOR_WEIGHT : (remaining / (keys.length - 1)) + (rng() - 0.5) * 0.06;
      }
      // Normalize
      const sum = Object.values(w).reduce((a, b) => a + b, 0);
      for (const k of keys) w[k] = Math.max(0.03, Math.round((w[k] / sum) * 1000) / 1000);
      const sum2 = Object.values(w).reduce((a, b) => a + b, 0);
      w[keys[0]] += Math.round((1.0 - sum2) * 1000) / 1000; // fix rounding
      candidates.push(w);
    }
  }

  // Strategy 3: Fully random (remaining)
  const remaining = numCandidates - candidates.length;
  for (let i = 0; i < remaining; i++) {
    const raw = keys.map(() => 0.03 + rng() * 0.27);
    const sum = raw.reduce((a, b) => a + b, 0);
    const w = {};
    keys.forEach((k, idx) => w[k] = Math.round((raw[idx] / sum) * 1000) / 1000);
    // Fix rounding to exactly 1.0
    const sum2 = Object.values(w).reduce((a, b) => a + b, 0);
    w[keys[0]] += Math.round((1.0 - sum2) * 1000) / 1000;
    candidates.push(w);
  }

  // Final safety pass — capped-simplex projection (fixed 2026-07-31, external
  // review round 2, P0-7). The OLD version did one clamp-then-renormalize
  // pass: clamp every weight into [MIN,MAX], then divide everything by the
  // new (smaller) sum to bring the total back to 1.0. That renormalization
  // divides EVERY weight — including ones already sitting exactly at
  // MAX_FACTOR_WEIGHT — by a number less than 1, which INFLATES them back
  // above the cap. Verified empirically: ~4.9% of 150,000 generated
  // candidates across 50 seeds exceeded 0.18, up to 0.197.
  //
  // Fixed with proper iterative capped-simplex projection: clamp violating
  // weights and LOCK them at the boundary, redistribute only the remaining
  // budget across the still-unlocked weights, and repeat — since
  // redistribution can itself push a previously-fine weight over the cap,
  // this must iterate until nothing new gets locked, not just run once.
  for (let i = 0; i < candidates.length; i++) {
    candidates[i] = projectToCappedSimplex(candidates[i], keys, MIN_FACTOR_WEIGHT, MAX_FACTOR_WEIGHT);
  }

  return { candidates, seed };
}

/**
 * Iterative capped-simplex projection: redistributes weight so every key
 * ends in [min, max] and the total is exactly 1.0, without letting
 * renormalization push an already-capped weight back over the boundary.
 * Pure function — exported for direct testing (external review round 2,
 * P0-7's suggested acceptance test: 1000 seeds, every candidate checked).
 *
 * Water-filling by AVAILABLE ROOM, not by current value (fixed during this
 * same review pass): an earlier version redistributed the remaining/excess
 * budget proportionally to each key's CURRENT value — which breaks for a
 * key sitting at exactly 0 (or already at a boundary), since a 0-weighted
 * key can never receive any share of a proportional-to-value split even
 * though it has plenty of room to grow. Distributing proportionally to
 * (max - current) when adding, or (current - min) when removing, handles
 * that correctly regardless of starting value.
 */
function projectToCappedSimplex(w, keys, min, max) {
  for (const k of keys) w[k] = Math.max(min, Math.min(max, w[k]));

  for (let iter = 0; iter < keys.length + 1; iter++) {
    const sum = keys.reduce((s, k) => s + w[k], 0);
    const diff = 1.0 - sum;
    if (Math.abs(diff) < 1e-9) break;

    if (diff > 0) {
      // Total is short of 1.0 — add the deficit to keys with room below max,
      // proportional to how much room each one has.
      const adjustable = keys.filter(k => w[k] < max);
      const room = adjustable.reduce((s, k) => s + (max - w[k]), 0);
      if (adjustable.length === 0 || room <= 0) break; // fully saturated, cannot add more
      for (const k of adjustable) w[k] += diff * ((max - w[k]) / room);
    } else {
      // Total exceeds 1.0 — remove the excess from keys with room above min,
      // proportional to how much room each one has.
      const adjustable = keys.filter(k => w[k] > min);
      const room = adjustable.reduce((s, k) => s + (w[k] - min), 0);
      if (adjustable.length === 0 || room <= 0) break; // fully saturated, cannot remove more
      for (const k of adjustable) w[k] -= (-diff) * ((w[k] - min) / room);
    }
    // Re-clamp after every pass — the proportional split can still leave a
    // value a hair past its boundary from floating-point rounding.
    for (const k of keys) w[k] = Math.max(min, Math.min(max, w[k]));
  }

  // Round to 3dp, then push any rounding drift onto whichever key has room
  // in the right direction, so the total is exactly 1.0 without reopening a
  // boundary violation.
  for (const k of keys) w[k] = Math.round(w[k] * 1000) / 1000;
  const sum = keys.reduce((s, k) => s + w[k], 0);
  const drift = Math.round((1.0 - sum) * 1000) / 1000;
  const adjustKey = (drift > 0 ? keys.find(k => w[k] < max) : keys.find(k => w[k] > min)) || keys[0];
  w[adjustKey] = Math.max(min, Math.min(max, Math.round((w[adjustKey] + drift) * 1000) / 1000));

  return w;
}

/**
 * Compute lightweight per-factor predictiveness (lift + IC) directly from an
 * in-memory signal set (no DB round-trip).
 *
 * Fixed 2026-07-31 (external review): previously delegated the "lift" half
 * to awo_analyzer's `splitAnalysis()`, which splits on the STORED `outcome`
 * field — labeled for whichever direction the signal was ORIGINALLY
 * classified as at save time, the exact same staleness bug fixed in
 * `computeWinRate` earlier (2026-07-30). And "ic" used `return_5d`, a crude
 * 5-day snapshot, not a real trade. Both now use `_bullishOutcome`
 * (precomputed by `attachTradeOutcomes()` before this is ever called) — a
 * real T+1/ATR-SR-stop-target/fee-adjusted simulation, matching the exact
 * same outcome definition `computeWinRate` and `optimizeThresholds` use.
 * (Deliberately always the BULLISH hypothetical here, not per-signal
 * direction — F1-F13 scores are constructed so "higher = more bullish-
 * leaning" regardless of what a particular candidate ends up classifying a
 * row as, so "does a higher score predict a better bullish outcome" is the
 * question this needs to answer, same as `splitAnalysis`'s original intent.)
 *
 * Fixed AGAIN 2026-07-31 (external review, round 3, finding #7): "lift" was
 * still a WIN-RATE gap (high-score group win rate minus low-score group win
 * rate) — inconsistent with the rest of this file's shift to expectancy as
 * the real objective (a factor can raise win rate while making average
 * losses bigger, net negative). Switched to an EXPECTANCY gap. Also
 * `isPredictive` used `Math.abs(ic) > 0.05`, which let a NEGATIVE
 * correlation count as "predictive" — but every F1-F13 factor is
 * constructed so "higher score = more bullish-leaning"; a genuinely
 * negative IC means the factor is anti-correlated with its own intended
 * direction (working backwards), which should never pass a "this factor is
 * validly predictive" check. Now requires a SIGNED, positive IC.
 */
function factorValidity(signals) {
  const validity = {};
  for (const f of FACTORS) {
    const withOutcome = signals.filter(s => s[f.key] != null && s._bullishOutcome?.result);
    if (withOutcome.length < 10) {
      validity[f.short] = { lift: 0, ic: 0, isPredictive: false };
      continue;
    }
    const values = withOutcome.map(s => Number(s[f.key]));
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const high = withOutcome.filter(s => Number(s[f.key]) >= median);
    const low = withOutcome.filter(s => Number(s[f.key]) < median);
    const expHigh = high.length > 0 ? high.reduce((s, x) => s + Number(x._bullishOutcome.netR), 0) / high.length : 0;
    const expLow = low.length > 0 ? low.reduce((s, x) => s + Number(x._bullishOutcome.netR), 0) / low.length : 0;
    const lift = Math.round((expHigh - expLow) * 1000) / 1000;

    const ic = informationCoefficient(
      withOutcome.map(s => Number(s[f.key])),
      withOutcome.map(s => Number(s._bullishOutcome.netR))
    );
    validity[f.short] = {
      lift,
      ic,
      isPredictive: lift > MIN_FACTOR_LIFT_R && ic > MIN_FACTOR_IC,
    };
  }
  return validity;
}

/**
 * Reject a candidate if any factor holding more than MAX_FACTOR_WEIGHT/2 of the
 * total weight is not empirically predictive on the train set. This is the direct
 * fix for the f9=0.392 incident: f9 (RSI) held 39% of the live weight while showing
 * a negative win/loss gap on the full dataset — this check would have refused it.
 */
function hasUnvalidatedDominantFactor(weights, validity) {
  const DOMINANCE_THRESHOLD = MAX_FACTOR_WEIGHT / 2;
  for (const [key, w] of Object.entries(weights)) {
    if (w > DOMINANCE_THRESHOLD && validity[key] && !validity[key].isPredictive) {
      return key;
    }
  }
  return null;
}

/**
 * Check that average forward outcome is (roughly) monotonic across signal
 * tiers: STRONG SELL <= SELL <= NEUTRAL <= WATCH <= BUY <= STRONG BUY.
 * Tiers with fewer than MIN_TIER_SAMPLE signals are skipped (too noisy to
 * judge). Returns the first violation found, or null if the ordering holds
 * within MONOTONICITY_TOLERANCE_R.
 *
 * Fixed 2026-07-31 (external review): switched from `return_5d` (a crude
 * 5-day price snapshot, in %) to `_bullishOutcome.netR` (the same real
 * T+1/stop-target/fee-adjusted simulation every other safeguard now uses,
 * in R-multiples) — same "don't judge candidates against a proxy the live
 * system doesn't actually trade" fix as `factorValidity` above. Tolerance
 * rescaled from percentage points to R accordingly (MONOTONICITY_TOLERANCE_R).
 */
function checkMonotonicity(signals, weights, thresholds) {
  const tierOrder = ['STRONG SELL', 'SELL', 'NEUTRAL', 'WATCH', 'BUY', 'STRONG BUY'];
  const byTier = {};
  for (const s of signals) {
    const score = rescoreSignal(s, weights);
    const tier = classifyWithThresholds(score, thresholds);
    if (!byTier[tier]) byTier[tier] = [];
    if (s._bullishOutcome?.netR != null) byTier[tier].push(Number(s._bullishOutcome.netR));
  }

  const tierAvg = tierOrder.map(t => ({
    tier: t,
    n: (byTier[t] || []).length,
    avgReturn: (byTier[t] || []).length > 0 ? stats.mean(byTier[t]) : null,
  })).filter(t => t.n >= MIN_TIER_SAMPLE);

  for (let i = 1; i < tierAvg.length; i++) {
    const prev = tierAvg[i - 1];
    const curr = tierAvg[i];
    if (curr.avgReturn < prev.avgReturn - MONOTONICITY_TOLERANCE_R) {
      return {
        violation: true,
        detail: `${curr.tier} (avg ${curr.avgReturn.toFixed(3)}R, n=${curr.n}) underperforms ${prev.tier} (avg ${prev.avgReturn.toFixed(3)}R, n=${prev.n}) by more than ${MONOTONICITY_TOLERANCE_R}R`,
      };
    }
  }
  return { violation: false, detail: null, tierAvg };
}

const BOOTSTRAP_RESAMPLES = 2000;

/**
 * Date-block bootstrap significance test on EXPECTANCY difference — fixed
 * 2026-07-31 (external review, round 2, P0-5). Replaces
 * `stats.twoProportionZTest`, which had two real problems: (1) it tested
 * whether WIN RATE differed significantly, but the optimizer's actual
 * ranking/adoption objective is expectancy (see the P0-1 ranking fix
 * above) — a candidate could have identical win rate to baseline but much
 * better expectancy and be wrongly rejected, or the reverse; (2) treating
 * each signal as an independent Bernoulli trial overstates the effective
 * sample size, since many tickers on the same date are correlated (a
 * market-wide move affects all of them together) — a handful of unusual
 * DATES, not hundreds of independent signals, can actually be driving a
 * result that LOOKS statistically solid signal-by-signal.
 *
 * Resamples DATE BLOCKS (not individual signals) with replacement, so
 * within-date correlation is preserved in every resample, and builds an
 * empirical confidence interval for (candidate expectancy − baseline
 * expectancy). The candidate only passes if the LOWER bound of that
 * interval is still > 0 — i.e. even under resampling uncertainty, the
 * candidate beats baseline.
 *
 * Honest limitation: `alpha` is applied directly to this bootstrap's
 * percentiles as an approximation of the same Bonferroni correction the old
 * z-test used (BONFERRONI_ALPHA, i.e. still corrected for testing
 * TOP_N_CANDIDATES candidates per run) — with BOOTSTRAP_RESAMPLES=2000 the
 * extreme-tail percentile this implies (~0.00125) is only resolved to
 * roughly the 2-3 most extreme resampled values, which is coarser than a
 * proper analytical correction would give. The multiple-candidate walk
 * (stop at the first candidate that clears every gate, in ranked order)
 * still provides real additional protection beyond this test alone.
 */
function dateBlockBootstrapExpectancyTest(signals, candidateWeights, baselineWeights, thresholds, { alpha = SIGNIFICANCE_ALPHA, resamples = BOOTSTRAP_RESAMPLES, seed = 42 } = {}) {
  const byDate = new Map();
  for (const s of signals) {
    const d = toDateStr(s.data_date);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(s);
  }
  const dates = [...byDate.keys()];
  if (dates.length < 10) {
    return { significant: false, ciLower: null, ciUpper: null, numDates: dates.length, reason: 'too few unique dates for a block bootstrap (need >=10)' };
  }

  function directionalNetRs(dateSignals, weights) {
    const out = [];
    for (const s of dateSignals) {
      const score = rescoreSignal(s, weights);
      const signal = classifyWithThresholds(score, thresholds);
      const isBullish = ['STRONG BUY', 'BUY'].includes(signal);
      const isBearish = TRADE_DIRECTION_MODE !== 'LONG_ONLY' && ['STRONG SELL', 'SELL'].includes(signal);
      if (!isBullish && !isBearish) continue;
      const outcome = isBullish ? s._bullishOutcome : s._bearishOutcome;
      if (!outcome || !outcome.result) continue;
      out.push(outcome.netR);
    }
    return out;
  }

  const candByDate = new Map(), baseByDate = new Map();
  for (const d of dates) {
    candByDate.set(d, directionalNetRs(byDate.get(d), candidateWeights));
    baseByDate.set(d, directionalNetRs(byDate.get(d), baselineWeights));
  }

  const rng = mulberry32(seed);
  const deltas = new Array(resamples);
  for (let i = 0; i < resamples; i++) {
    let candSum = 0, candN = 0, baseSum = 0, baseN = 0;
    for (let j = 0; j < dates.length; j++) {
      const d = dates[Math.floor(rng() * dates.length)];
      for (const r of candByDate.get(d)) { candSum += r; candN++; }
      for (const r of baseByDate.get(d)) { baseSum += r; baseN++; }
    }
    deltas[i] = (candN > 0 ? candSum / candN : 0) - (baseN > 0 ? baseSum / baseN : 0);
  }
  deltas.sort((a, b) => a - b);
  const lowerIdx = Math.max(0, Math.floor(resamples * (alpha / 2)));
  const upperIdx = Math.min(resamples - 1, Math.ceil(resamples * (1 - alpha / 2)));
  const ciLower = deltas[lowerIdx];
  const ciUpper = deltas[upperIdx];
  return { significant: ciLower > 0, ciLower, ciUpper, numDates: dates.length, resamples };
}

/**
 * Main optimizer: find optimal weights using historical signal outcomes
 */
async function optimizeWeights(pool, currentWeights = null) {
  const startTime = Date.now();

  // 1. Load all signals with outcomes.
  // `outcome != 'NEUTRAL'` REMOVED (external review, 2026-07-31): a row
  // labeled NEUTRAL was labeled that way under the ORIGINAL weights/
  // thresholds active when it was saved. A candidate being evaluated here
  // might classify that same historical row as BUY or SELL — excluding it
  // at the SQL level meant candidates were never even evaluated against
  // part of their own true opportunity universe. `attachTradeOutcomes()`
  // below computes each candidate's own real forward-path outcome directly
  // from price data regardless of this stored label, so nothing downstream
  // depends on the excluded rows being gone — only `outcome IS NOT NULL`
  // (this row is old enough to have a resolvable outcome at all) is a real
  // requirement.
  const [signals] = await pool.query(`
    SELECT data_date, stock_code, composite_score, signal_type, outcome,
           f1_concentration, f2_trend, f3_volume_z, f4_momentum,
           f5_rel_strength, f6_breadth, f7_alignment, f8_streak,
           f9_rsi, f10_macd, f11_bollinger, f12_ema_trend,
           f13_support_resistance, f14_atr,
           price_at_signal, price_5d_later, return_5d, regime_at_signal
    FROM idx_signal_history
    WHERE outcome IS NOT NULL
    ORDER BY data_date ASC
  `);

  if (signals.length < MIN_SIGNALS_TRAIN + MIN_SIGNALS_VALIDATE) {
    return {
      status: 'INSUFFICIENT_DATA',
      message: `Need at least ${MIN_SIGNALS_TRAIN + MIN_SIGNALS_VALIDATE} signals with outcomes, got ${signals.length}`,
      totalSignals: signals.length,
    };
  }

  // 1b. Precompute real future-path trade outcomes ONCE per signal (both
  // possible directions) — see attachTradeOutcomes' doc comment for why
  // this must happen before, not during, the 3000-candidate search below.
  await attachTradeOutcomes(pool, signals);

  // 2. Chronological split: 70% train, 30% validate — by UNIQUE DATE, with a
  // purge gap, not by row count (external review, 2026-07-31). Two real bugs
  // fixed together here:
  //   (a) splitting by row index could cut a single calendar date in half —
  //       some tickers' signals from date D landing in train, others from the
  //       SAME date D landing in validate, when `signals` (sorted by
  //       data_date but with many tickers sharing each date) crossed the
  //       70% row boundary mid-date.
  //   (b) no purge gap — a train-set signal firing shortly before the
  //       boundary has its outcome walked forward up to OUTCOME_MAX_HOLD
  //       trading days, which could land on bars dated INTO the validate
  //       period. That train signal's label would then depend on
  //       information from the validate window, undermining the
  //       train/validate independence the significance test assumes.
  // Fix: split on unique dates, then drop any TRAIN signal within
  // OUTCOME_MAX_HOLD trading days of the boundary (its outcome could reach
  // into validate dates) — a purged split, not full rolling walk-forward
  // CV (still a follow-up, see BACKTEST_EXPERIMENTS.md).
  const uniqueDates = [...new Set(signals.map(s => toDateStr(s.data_date)))].sort();
  const dateSplitIdx = Math.floor(uniqueDates.length * 0.7);
  const boundaryDate = uniqueDates[dateSplitIdx];
  const purgeStartDate = uniqueDates[Math.max(0, dateSplitIdx - OUTCOME_MAX_HOLD)];

  const trainSet = signals.filter(s => toDateStr(s.data_date) < purgeStartDate);
  const validateSet = signals.filter(s => toDateStr(s.data_date) >= boundaryDate);
  const purgedCount = signals.length - trainSet.length - validateSet.length;

  // 3. Current baseline
  // Fixed 2026-07-31 (external review, round 2, P1): this fallback used to
  // be a stale 8-factor-only literal (no F9-F14 at all) predating the
  // technical-factor expansion — only ever mattered when `optimizeWeights`
  // is called with no `currentWeights` (never happens via the real
  // /api/awo/optimize/run route, which always passes `getActiveWeights()`,
  // but a stale literal here is exactly the kind of second copy that can
  // silently drift, same lesson as the DEFAULT_WEIGHTS duplicate found
  // earlier this same review pass).
  const defaultW = currentWeights || SCORE_ENGINE_DEFAULT_WEIGHTS;
  const baselineTrainWR = computeWinRate(trainSet, defaultW);
  const baselineValidWR = computeWinRate(validateSet, defaultW);

  // 4. Generate weight candidates
  const { candidates, seed: candidateSeed } = generateWeightCandidates(3000);

  // 5. Score each candidate on train set
  const scored = candidates
    .map(w => ({ weights: w, trainResult: computeWinRate(trainSet, w) }))
    // Floor out tiny-sample candidates before ranking (external review,
    // 2026-07-31) — without this, a candidate that only classified 3 train
    // signals and happened to win all 3 could out-rank one classifying 200
    // signals at a real, smaller edge.
    .filter(c => c.trainResult.total >= MIN_TRAIN_SAMPLE_FOR_RANKING);

  // 6. Sort by TRAIN EXPECTANCY, not win rate (external review, 2026-07-31 —
  // a high-win-rate/bad-R:R candidate can still be a net loser; win rate is
  // now informational only, never the ranking key).
  scored.sort((a, b) => b.trainResult.expectancy - a.trainResult.expectancy);

  const topCandidates = scored.slice(0, TOP_N_CANDIDATES);

  // 7. Validate top candidates on out-of-sample data
  const validated = topCandidates.map(c => ({
    ...c,
    validateResult: computeWinRate(validateSet, c.weights),
  }));

  // 8. Sort by VALIDATION (out-of-sample) EXPECTANCY — the true measure.
  validated.sort((a, b) => b.validateResult.expectancy - a.validateResult.expectancy);

  // 9. Overfitting safeguards — walk the validated ranking and adopt the FIRST
  // candidate that survives every gate, instead of blindly trusting rank #1.
  // Factor validity is computed on the TRAIN set only, never validate, so this
  // check itself can't leak validate-set information into the decision.
  const validity = factorValidity(trainSet);
  const rejectionLog = [];
  let chosen = null;

  // Fixed 2026-07-31 (external review, round 3, finding #1 — the single
  // most important bug in this round): every safeguard below used to
  // validate `c.weights` against DEFAULT_THRESHOLDS, but the candidate that
  // actually gets frozen as a challenger uses `c.weights` PAIRED WITH ITS
  // OWN optimizeThresholds() result — a completely different threshold set
  // computed AFTER the safeguard walk had already finished. The backtest
  // summary attached to a challenger never described the actual weights+
  // thresholds combination paper trading would run. Now: optimizeThresholds
  // runs INSIDE this loop, per shortlisted candidate, and every gate
  // (sample size, expectancy, profit factor, bootstrap, monotonicity)
  // evaluates the EXACT final pair.
  for (const c of validated) {
    const dominantBad = hasUnvalidatedDominantFactor(c.weights, validity);
    if (dominantBad) {
      rejectionLog.push(`weights rejected: factor ${dominantBad} holds >${Math.round(MAX_FACTOR_WEIGHT / 2 * 100)}% but is not empirically predictive on train set (lift=${validity[dominantBad].lift}, ic=${validity[dominantBad].ic.toFixed(3)})`);
      continue;
    }

    const candidateThresholds = optimizeThresholds(trainSet, c.weights);
    const candidateValidateResult = computeWinRate(validateSet, c.weights, candidateThresholds);

    if (candidateValidateResult.total < MIN_DIRECTIONAL_VALIDATE) {
      rejectionLog.push(`weights rejected: only ${candidateValidateResult.total} directional validate signals under its own optimized thresholds (need >=${MIN_DIRECTIONAL_VALIDATE})`);
      continue;
    }
    // Profitability gates (external review, 2026-07-31) — a candidate can
    // clear every accuracy/significance check below and still be a net
    // loser if its wins are small and its losses are large. These two
    // checks are hard rejections, evaluated before significance/monotonicity
    // so an unprofitable candidate never reaches "chosen" regardless of how
    // statistically confident its win-rate edge looks.
    if (candidateValidateResult.expectancy <= MIN_OOS_EXPECTANCY) {
      rejectionLog.push(`weights rejected: out-of-sample expectancy ${candidateValidateResult.expectancy.toFixed(3)}R (own thresholds) is not positive (need >${MIN_OOS_EXPECTANCY}R)`);
      continue;
    }
    if (candidateValidateResult.profitFactor < MIN_OOS_PROFIT_FACTOR) {
      rejectionLog.push(`weights rejected: out-of-sample profit factor ${Number.isFinite(candidateValidateResult.profitFactor) ? candidateValidateResult.profitFactor.toFixed(2) : 'inf'} (own thresholds) is below ${MIN_OOS_PROFIT_FACTOR}`);
      continue;
    }
    // Fixed 2026-07-31 (external review, round 2, P0-5): was
    // stats.twoProportionZTest on WIN RATE — see dateBlockBootstrapExpectancyTest's
    // doc comment for why that tested the wrong quantity with an
    // overconfident independence assumption.
    const sigTest = dateBlockBootstrapExpectancyTest(
      validateSet, c.weights, defaultW, candidateThresholds,
      { alpha: BONFERRONI_ALPHA, seed: candidateSeed }
    );
    if (!sigTest.significant) {
      rejectionLog.push(`weights rejected: expectancy improvement not significant under date-block bootstrap (95% CI [${sigTest.ciLower?.toFixed(3) ?? 'n/a'}, ${sigTest.ciUpper?.toFixed(3) ?? 'n/a'}]R over ${sigTest.numDates} dates — lower bound must be >0)`);
      continue;
    }
    const mono = checkMonotonicity(validateSet, c.weights, candidateThresholds);
    if (mono.violation) {
      rejectionLog.push(`weights rejected: ${mono.detail}`);
      continue;
    }
    chosen = { ...c, validateResult: candidateValidateResult, thresholds: candidateThresholds, sigTest, monotonicity: mono };
    break;
  }

  // Still report the top-ranked candidate for transparency even when
  // nothing was adoptable — but ITS validateResult/thresholds must also be
  // the real paired combination, not the DEFAULT_THRESHOLDS pre-ranking
  // approximation, for the same reason as the loop above.
  let best = chosen;
  if (!best) {
    const fallbackThresholds = optimizeThresholds(trainSet, validated[0].weights);
    best = {
      ...validated[0],
      thresholds: fallbackThresholds,
      validateResult: computeWinRate(validateSet, validated[0].weights, fallbackThresholds),
    };
  }
  // Adoption criterion is now EXPECTANCY improvement over baseline, in R —
  // not win-rate percentage points (external review, 2026-07-31). Reported
  // `improvement` field is still win-rate-in-percent for backward-compatible
  // display purposes; `expectancyImprovement` is the real decision input.
  const improvement = best.validateResult.winRate - baselineValidWR.winRate;
  const expectancyImprovement = best.validateResult.expectancy - baselineValidWR.expectancy;
  const adopted = chosen !== null && expectancyImprovement >= MIN_EXPECTANCY_IMPROVEMENT;

  const optimalThresholds = best.thresholds;

  const elapsed = Date.now() - startTime;

  return {
    status: adopted ? 'IMPROVED' : 'NO_IMPROVEMENT',
    adopted,
    elapsed_ms: elapsed,
    totalSignals: signals.length,
    uniqueDatesCount: uniqueDates.length, // external review round 3, finding #3: the reopt gate must count new TRADING DAYS, not new rows (many rows land on the same date)
    trainSize: trainSet.length,
    validateSize: validateSet.length,
    purgedSize: purgedCount, // signals dropped by the train/validate purge gap (external review, 2026-07-31)
    splitBoundaryDate: boundaryDate,
    candidatesTested: candidates.length,
    candidateSeed, // reproducibility (external review, 2026-07-31) — re-running with this seed regenerates the identical candidate set

    safetyChecks: {
      maxFactorWeight: MAX_FACTOR_WEIGHT,
      minDirectionalValidate: MIN_DIRECTIONAL_VALIDATE,
      significanceAlpha: BONFERRONI_ALPHA,
      minOosExpectancy: MIN_OOS_EXPECTANCY,
      minOosProfitFactor: MIN_OOS_PROFIT_FACTOR,
      minExpectancyImprovement: MIN_EXPECTANCY_IMPROVEMENT,
      candidatesRejected: rejectionLog.length,
      rejectionSample: rejectionLog.slice(0, 5),
      factorValidity: validity,
    },

    baseline: {
      weights: defaultW,
      trainWinRate: Math.round(baselineTrainWR.winRate * 10) / 10,
      validateWinRate: Math.round(baselineValidWR.winRate * 10) / 10,
      trainTotal: baselineTrainWR.total,
      validateTotal: baselineValidWR.total,
      validateExpectancy: Math.round(baselineValidWR.expectancy * 1000) / 1000,
      validateProfitFactor: Number.isFinite(baselineValidWR.profitFactor) ? Math.round(baselineValidWR.profitFactor * 100) / 100 : null,
    },

    optimized: {
      weights: best.weights,
      trainWinRate: Math.round(best.trainResult.winRate * 10) / 10,
      validateWinRate: Math.round(best.validateResult.winRate * 10) / 10,
      trainTotal: best.trainResult.total,
      validateTotal: best.validateResult.total,
      avgPnL: Math.round(best.validateResult.avgPnL * 100) / 100,
      expectancy: Math.round(best.validateResult.expectancy * 1000) / 1000,
      profitFactor: Number.isFinite(best.validateResult.profitFactor) ? Math.round(best.validateResult.profitFactor * 100) / 100 : null,
      improvement: Math.round(improvement * 10) / 10,
      expectancyImprovement: Math.round(expectancyImprovement * 1000) / 1000,
    },

    thresholds: optimalThresholds,

    // Top 5 candidates for transparency
    topCandidates: validated.slice(0, 5).map((c, i) => ({
      rank: i + 1,
      weights: c.weights,
      trainWR: Math.round(c.trainResult.winRate * 10) / 10,
      validateWR: Math.round(c.validateResult.winRate * 10) / 10,
      validateExpectancy: Math.round(c.validateResult.expectancy * 1000) / 1000,
      validateProfitFactor: Number.isFinite(c.validateResult.profitFactor) ? Math.round(c.validateResult.profitFactor * 100) / 100 : null,
    })),

    // Weight change from baseline
    weightChanges: Object.keys(best.weights).map(k => ({
      factor: k,
      old: defaultW[k],
      new: best.weights[k],
      change: Math.round((best.weights[k] - (defaultW[k] || 0.125)) * 1000) / 1000,
      direction: best.weights[k] > (defaultW[k] || 0.125) ? 'INCREASED' : 'DECREASED',
    })),
  };
}

/**
 * Optimize signal classification thresholds.
 *
 * IMPORTANT: callers must pass a TRAIN-ONLY signal set (external review,
 * 2026-07-31) — this used to be called with the full train+validate signal
 * set, AFTER validate data had already been used to pick `weights` via the
 * safeguard walk in optimizeWeights(). That let the validate set influence
 * threshold selection too, so the reported validate win rate was no longer
 * genuinely out-of-sample by the time thresholds were locked in. There is
 * currently no separate third (locked test) split to evaluate the resulting
 * thresholds against — see BACKTEST_EXPERIMENTS.md's open follow-ups.
 *
 * Metric switched from win-rate*sqrt(n) to expectancy*sqrt(n) with a
 * required-positive-expectancy floor (external review, 2026-07-31) — same
 * "don't optimize accuracy at the expense of profitability" fix as
 * optimizeWeights' candidate ranking above.
 */
function optimizeThresholds(trainSignals, weights) {
  // Re-score all signals with optimal weights
  const rescored = trainSignals.map(s => ({
    ...s,
    newScore: rescoreSignal(s, weights),
  }));

  // Try different threshold configurations
  const configs = [];
  for (let sb = 72; sb <= 85; sb += 2) {
    for (let b = 58; b <= sb - 8; b += 2) {
      for (let w = 48; w <= b - 8; w += 2) {
        configs.push({ strongBuy: sb, buy: b, watch: w, neutral: 40, sell: 25 });
      }
    }
  }

  let bestConfig = DEFAULT_THRESHOLDS;
  let bestMetric = -Infinity;

  for (const config of configs) {
    // Uses the same precomputed future-path trade outcome as computeWinRate
    // (real T+1/stop/target/fee/slippage simulation), not a return_5d snapshot.
    // BUY-side only — this was previously an ACCIDENTAL inconsistency with
    // computeWinRate's weight-selection (which used to also test SHORT/SELL
    // trades); now that TRADE_DIRECTION_MODE defaults to LONG_ONLY (external
    // review, round 2, P0-4) this is the deliberately-correct, consistent
    // behavior — thresholds are only tuned for the direction this system
    // actually trades. `strongBuy`/`buy`/`watch` are the only bounds explored
    // here; `sell`/`neutral` stay at their fixed defaults (not tuned), since
    // in LONG_ONLY mode SELL classification only matters as an exit/avoid
    // signal, not a P&L-generating threshold to optimize.
    let wins = 0, losses = 0, totalR = 0, grossProfit = 0, grossLoss = 0;
    for (const s of rescored) {
      const signal = classifyWithThresholds(s.newScore, config);
      if (!['STRONG BUY', 'BUY'].includes(signal)) continue;
      const outcome = s._bullishOutcome;
      if (!outcome || !outcome.result) continue;
      if (outcome.result === 'WIN') { wins++; grossProfit += outcome.netR; }
      else { losses++; grossLoss += Math.abs(outcome.netR); }
      totalR += outcome.netR;
    }

    const total = wins + losses;
    if (total < 10) continue; // need minimum sample

    const wr = (wins / total) * 100;
    const expectancy = totalR / total;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
    if (expectancy <= MIN_OOS_EXPECTANCY) continue; // same profitability floor as candidate weight selection

    // Metric: expectancy * sqrt(sample size) — balances edge size vs coverage,
    // same shape as the old win-rate metric but on the quantity that actually
    // determines profitability.
    const metric = expectancy * Math.sqrt(total);

    if (metric > bestMetric) {
      bestMetric = metric;
      bestConfig = {
        ...config, winRate: Math.round(wr * 10) / 10, sampleSize: total,
        expectancy: Math.round(expectancy * 1000) / 1000,
        profitFactor: Number.isFinite(profitFactor) ? Math.round(profitFactor * 100) / 100 : null,
      };
    }
  }

  return bestConfig;
}

/**
 * Save optimization results to file
 */
function saveOptimizationResult(result, filePath) {
  const fs = require('fs');
  const data = {
    ...result,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return data;
}

/**
 * Load previous optimization result from file
 */
function loadOptimizationResult(filePath) {
  try {
    const fs = require('fs');
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  optimizeWeights,
  optimizeThresholds,
  rescoreSignal,
  computeWinRate,
  evaluateCandidateOutcome,
  attachTradeOutcomes,
  generateWeightCandidates,
  projectToCappedSimplex,
  dateBlockBootstrapExpectancyTest,
  factorValidity,
  mulberry32,
  saveOptimizationResult,
  loadOptimizationResult,
  DEFAULT_THRESHOLDS,
  TRADE_DIRECTION_MODE,
};
