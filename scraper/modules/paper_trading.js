/**
 * Paper Trading — P1 follow-up #18, 2026-07-30.
 *
 * "Jalankan paper trading sebelum model promotion" — before any optimizer
 * candidate is allowed into live scoring via POST /api/awo/optimize/promote,
 * it must first accumulate a real, forward-looking (never backfilled) paper
 * trading track record: what would THIS candidate's weights have signaled,
 * each day going forward from when it became eligible, and how did those
 * signals actually resolve once real future price data arrived.
 *
 * Deliberately NOT a backtest — `generatePaperTrades` only ever looks at the
 * most recent day's already-live signal, and `resolvePaperTrades` only ever
 * advances using price data that has genuinely already landed in
 * `idx_stock_prices` by the time it runs. There is no way to shortcut real
 * calendar time elapsing; that is the entire point of this gate (same
 * lesson as the 2026-07-19 overfitting incident and the Counter-trend gate
 * retraction — a candidate that only looks good in-sample/backtest is not
 * the same as one that holds up going forward).
 */
'use strict';

const crypto = require('crypto');
const { combineFactorScores } = require('./score_engine');
const { computeTradePlan, calcTechnicalFactors } = require('../awo_technical');
const tradePolicy = require('./trade_policy');

const ROUND_TRIP_COST_PCT = 0.50; // same assumption as awo_optimizer.js / all backtest scripts
// Was a hardcoded 15 alongside awo_optimizer.js's identical hardcoded 15 — two
// copies of one decision. Now both read modules/trade_policy.js, so the live
// paper trader can never resolve trades on a different horizon than the
// optimizer that selected them. NOTE: the exit policy is not part of
// candidateKeyFromWeights (see its doc), so changing profiles requires an
// AWO_MODEL_VERSION bump to auto-archive any in-flight challenger.
const MAX_HOLD_DAYS = tradePolicy.active().maxHoldBars;
// Same TRADE_DIRECTION_MODE as awo_optimizer.js (external review, round 2,
// P0-4) — paper trading used to open SELL/STRONG SELL trades unconditionally,
// inconsistent with BACKTEST_EXPERIMENTS.md's "Long only" registry entries
// and with optimizeThresholds (BUY-only). Kept as a separate env read (not
// imported from awo_optimizer.js) to avoid a circular require between the
// two modules; must be kept in sync if this mode is ever made configurable
// per-environment rather than a fixed default.
const TRADE_DIRECTION_MODE = process.env.TRADE_DIRECTION_MODE || 'LONG_ONLY';

function toDateStr(d) {
  return d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0];
}

/**
 * A STABLE identity for "this candidate", independent of when /run happened
 * to save it. This matters because /run overwrites AWO_RESULT_FILE (and its
 * `savedAt`) every time the daily cron calls it — if paper trades were keyed
 * by that timestamp, a candidate that keeps getting re-found day after day
 * would have its track record reset to zero every single day instead of
 * accumulating. Keying off a hash of the weights themselves means the SAME
 * candidate accumulates one continuous track record across as many days as
 * it keeps being found, while a genuinely NEW/different candidate starts a
 * fresh track record, exactly as intended.
 *
 * Fixed 2026-07-31 (external review): previously hashed `weights` alone.
 * Two candidates with identical weights but DIFFERENT thresholds classify
 * signals differently (a real behavioral difference) but would have
 * collapsed onto the same key, mixing their paper track records. Now hashes
 * weights + thresholds + modelVersion together. Still not a full immutable
 * candidate registry (fee model / exit policy versions aren't tracked
 * separately yet since this codebase has exactly one of each right now) —
 * see BACKTEST_EXPERIMENTS.md's open follow-ups.
 *
 * Fixed AGAIN 2026-07-31 (external review, round 3, finding #8): only the
 * 5 BEHAVIORAL threshold fields are hashed now — `optimizeThresholds()` in
 * awo_optimizer.js returns its winning config with research metrics
 * (`winRate`, `sampleSize`, `expectancy`, `profitFactor`) mixed into the
 * SAME object, and that whole object used to get passed straight through
 * here. Two runs that land on the EXACT same behavioral thresholds
 * (strongBuy/buy/watch/neutral/sell — the only fields that affect
 * `classifySignal`) but with slightly different research-metric values
 * attached (e.g. a marginally different sample size from one more day of
 * data) would hash to different keys and fragment what should be one
 * continuous track record — the opposite of this function's entire purpose.
 *
 * @param {Object} weights
 * @param {Object} thresholds - only strongBuy/buy/watch/neutral/sell are
 *   used for identity; any other fields present (e.g. optimizeThresholds'
 *   research-metric extras) are ignored, not just for hashing but so
 *   passing its raw return value here is always safe.
 * @param {string} [modelVersion] - defaults to a fixed literal so existing
 *   callers that don't pass one don't silently produce a different key
 *   than before this parameter existed.
 */
const BEHAVIORAL_THRESHOLD_KEYS = ['strongBuy', 'buy', 'watch', 'neutral', 'sell'];
function candidateKeyFromWeights(weights, thresholds = {}, modelVersion = 'unversioned') {
  const round = v => Math.round(Number(v) * 1000) / 1000;
  const sortedWeights = Object.keys(weights).sort().map(k => [k, round(weights[k])]);
  const behavioralThresholds = BEHAVIORAL_THRESHOLD_KEYS
    .filter(k => thresholds[k] !== undefined)
    .map(k => [k, round(thresholds[k])]);
  const payload = JSON.stringify({ w: sortedWeights, t: behavioralThresholds, v: modelVersion });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/**
 * Score the most recent day's already-saved live signals with a CANDIDATE
 * weight set (not the active live weights) and log a paper trade for every
 * BUY/SELL classification. Idempotent per (candidate, ticker, date) —
 * calling this again the same day for the same candidate is a no-op via
 * INSERT IGNORE, so it's safe to call from every cron run.
 *
 * Deliberately does NOT compute stop-loss/target here (fixed 2026-07-31,
 * external review) — that used to call `computeTradePlan(price_at_signal, ...)`
 * immediately, anchoring the stop/target to the SIGNAL DAY's close, while the
 * actual entry only gets filled in later (T+1 open) by `resolvePaperTrades`.
 * On any real overnight gap, the stored stop/target no longer describes the
 * risk the paper trade would actually be taking from its real entry — on a
 * big enough gap the "target" could even sit on the wrong side of entry for
 * a BUY. `resolvePaperTrades` now computes the plan once the real T+1 entry
 * price is known, exactly like `evaluateCandidateOutcome` in awo_optimizer.js
 * already does.
 *
 * Fixed 2026-07-31 (external review, round 2 — P0-1): this used to
 * RECOMPUTE `candidateKey` internally via `candidateKeyFromWeights(weights,
 * thresholds)` — silently WITHOUT the `modelVersion` argument the challenger
 * was actually frozen with (`server.js` passes `AWO_MODEL_VERSION`). That
 * meant every paper trade was filed under a DIFFERENT key
 * (`...+'unversioned'`) than the challenger's own key
 * (`...+'4.0.0-research'`) — `getPaperTradeSummary(pool, challenger.candidateKey)`
 * would then always find 0 trades, and no challenger could ever accumulate
 * a visible track record or clear promotion. Fixed per the review's own
 * recommendation: the caller passes the FROZEN candidateKey explicitly;
 * this function never recomputes candidate identity itself, so there is no
 * second call site left that can drift from the first.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {Object} weights - the candidate's weight set (NOT the live weights)
 * @param {Object} thresholds - the candidate's thresholds
 * @param {string} candidateKey - the FROZEN challenger's key (from
 *   `getOrFreezeChallenger`) — must be passed in, never recomputed here.
 * @returns {Promise<{generated: number, dateStr: string|null, candidateKey: string}>}
 */
async function generatePaperTrades(pool, weights, thresholds, candidateKey) {
  if (!candidateKey) throw new Error('generatePaperTrades requires an explicit candidateKey (the frozen challenger\'s key) — it no longer recomputes one');
  const [[latest]] = await pool.query(
    `SELECT MAX(data_date) d FROM idx_signal_history WHERE data_source = 'live'`
  );
  if (!latest?.d) return { generated: 0, dateStr: null, candidateKey };
  const dateStr = toDateStr(latest.d);

  const [signals] = await pool.query(
    `SELECT stock_code, f1_concentration f1, f2_trend f2, f3_volume_z f3, f4_momentum f4,
            f5_rel_strength f5, f6_breadth f6, f7_alignment f7, f8_streak f8,
            f9_rsi f9, f10_macd f10, f11_bollinger f11, f12_ema_trend f12,
            f13_support_resistance f13, f14_atr f14, price_at_signal
     FROM idx_signal_history WHERE data_date = ? AND data_source = 'live'`,
    [dateStr]
  );

  let generated = 0;
  for (const s of signals) {
    const f1_13 = {
      f1: s.f1 ?? 50, f2: s.f2 ?? 50, f3: s.f3 ?? 50, f4: s.f4 ?? 50, f5: s.f5 ?? 50,
      f6: s.f6 ?? 50, f7: s.f7 ?? 50, f8: s.f8 ?? 50, f9: s.f9 ?? 50, f10: s.f10 ?? 50,
      f11: s.f11 ?? 50, f12: s.f12 ?? 50, f13: s.f13 ?? 50,
    };
    const { decision } = combineFactorScores(f1_13, s.f14 ?? 50, {}, weights, thresholds);
    // LONG_ONLY (default): SELL/STRONG SELL are exit/avoid warnings, not
    // tradeable short positions — never opened as paper trades. Matches
    // awo_optimizer.js's computeWinRate/optimizeThresholds behavior.
    const tradeableDecisions = TRADE_DIRECTION_MODE === 'LONG_ONLY'
      ? ['STRONG BUY', 'BUY']
      : ['STRONG BUY', 'BUY', 'SELL', 'STRONG SELL'];
    if (!tradeableDecisions.includes(decision)) continue;
    if (!s.price_at_signal || Number(s.price_at_signal) <= 0) continue;

    await pool.query(
      `INSERT IGNORE INTO awo_paper_trades
         (candidate_key, stock_code, signal_date, direction, status)
       VALUES (?, ?, ?, ?, 'PENDING_ENTRY')`,
      [candidateKey, s.stock_code, dateStr, decision]
    );
    generated++;
  }
  return { generated, dateStr, candidateKey };
}

/**
 * Pure walk-forward step: given an already-known entry and the real price
 * bars available SINCE entry, decide whether this paper trade would exit
 * (STOP/TARGET/TIME_EXIT) yet, or is still genuinely open because fewer
 * than MAX_HOLD_DAYS real bars have landed so far. Separated from
 * `resolvePaperTrades` (which does the DB I/O) so this decision logic is
 * unit-testable without a database — same reasoning as
 * `evaluateCandidateOutcome` in awo_optimizer.js.
 *
 * @param {{entryPrice:number, stopLoss:number, target:number, direction:string}} trade
 * @param {Array<{date:string,open:number,high:number,low:number,close:number}>} barsSinceEntry - oldest-first, entry bar included
 * @returns {{result:'WIN'|'LOSS'|null, netR:number|null, exitReason:string|null, exitPrice:number|null, exitDate:string|null}}
 */
function walkForwardResolve({ entryPrice, stopLoss, target, direction }, barsSinceEntry) {
  const isBullish = direction === 'STRONG BUY' || direction === 'BUY';
  const risk = Math.abs(entryPrice - stopLoss);
  if (!(risk > 0)) return { result: null, netR: null, exitReason: null, exitPrice: null, exitDate: null };

  const holdCap = Math.min(barsSinceEntry.length, MAX_HOLD_DAYS);
  let exitPrice = null, exitReason = null, exitDate = null;
  for (let j = 0; j < holdCap; j++) {
    const bar = barsSinceEntry[j];
    const hitStop = isBullish ? bar.low <= stopLoss : bar.high >= stopLoss;
    const hitTarget = isBullish ? bar.high >= target : bar.low <= target;
    // Same-bar ambiguity resolves to STOP (conservative) — same rule as evaluateCandidateOutcome.
    if (hitStop) { exitPrice = stopLoss; exitReason = 'STOP'; exitDate = bar.date; break; }
    if (hitTarget) { exitPrice = target; exitReason = 'TARGET'; exitDate = bar.date; break; }
    if (j === holdCap - 1 && barsSinceEntry.length >= MAX_HOLD_DAYS) {
      exitPrice = bar.close; exitReason = 'TIME_EXIT'; exitDate = bar.date;
    }
  }
  if (exitPrice === null) return { result: null, netR: null, exitReason: null, exitPrice: null, exitDate: null };

  const grossMove = isBullish ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
  const netMove = grossMove - (entryPrice * (ROUND_TRIP_COST_PCT / 100));
  const netR = netMove / risk;
  return { result: netR > 0 ? 'WIN' : 'LOSS', netR, exitReason, exitPrice, exitDate };
}

/**
 * Advance every PENDING_ENTRY/OPEN paper trade using whatever real price
 * data has landed since it was created. Safe to call unconditionally on
 * every cron run — trades with no new data yet are simply left untouched.
 */
async function resolvePaperTrades(pool) {
  const [pending] = await pool.query(
    `SELECT * FROM awo_paper_trades WHERE status IN ('PENDING_ENTRY', 'OPEN')`
  );

  let entriesFilled = 0, resolved = 0, rejected = 0;
  for (const t of pending) {
    const [candleRows] = await pool.query(
      `SELECT date, open_price o, high_price h, low_price l, close_price c
       FROM idx_stock_prices WHERE stock_code = ? AND date > ? ORDER BY date ASC`,
      [t.stock_code, toDateStr(t.signal_date)]
    );
    if (candleRows.length === 0) continue; // no real T+1 data yet — leave PENDING_ENTRY as-is
    const candles = candleRows.map(r => ({
      date: toDateStr(r.date), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c),
    }));

    let entryPrice = t.entry_price !== null ? Number(t.entry_price) : null;
    let stopLoss = t.stop_loss !== null ? Number(t.stop_loss) : null;
    let target = t.target !== null ? Number(t.target) : null;

    if (t.status === 'PENDING_ENTRY') {
      entryPrice = candles[0].open; // T+1 open — the REAL entry, fixed 2026-07-31 (external review)

      // ATR/SR computed as-of the signal date only (no lookahead) — deferred
      // to here so the trade plan is built against the actual entry price,
      // not the stale signal-day close. Same discipline as
      // evaluateCandidateOutcome in awo_optimizer.js.
      const [historyRows] = await pool.query(
        `SELECT date, open_price o, high_price h, low_price l, close_price c
         FROM idx_stock_prices WHERE stock_code = ? AND date <= ? ORDER BY date DESC LIMIT 60`,
        [t.stock_code, toDateStr(t.signal_date)]
      );
      let atr = null, sr = null;
      if (historyRows.length >= 15) {
        const history = historyRows.reverse().map(r => ({
          date: toDateStr(r.date), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c),
        }));
        try {
          const tech = calcTechnicalFactors(history);
          atr = tech.indicators?.atr ?? null;
          sr = tech.indicators?.sr ?? null;
        } catch { /* fall through with null atr/sr — computeTradePlan has its own fallback */ }
      }

      const plan = computeTradePlan(entryPrice, t.direction, atr, sr);
      if (!plan || !Number.isFinite(plan.stopLoss)) {
        await pool.query(`UPDATE awo_paper_trades SET status = 'REJECTED', entry_price = ?, entry_date = ? WHERE id = ?`,
          [entryPrice, candles[0].date, t.id]);
        rejected++;
        continue;
      }
      stopLoss = plan.stopLoss;
      target = plan.target2;

      await pool.query(
        `UPDATE awo_paper_trades SET status = 'OPEN', entry_price = ?, entry_date = ?, stop_loss = ?, target = ? WHERE id = ?`,
        [entryPrice, candles[0].date, stopLoss, target, t.id]
      );
      entriesFilled++;
    }

    const outcome = walkForwardResolve(
      { entryPrice, stopLoss, target, direction: t.direction },
      candles
    );
    if (!outcome.result) continue; // still genuinely open — not enough real days elapsed yet, or bad risk

    await pool.query(
      `UPDATE awo_paper_trades SET status = ?, exit_price = ?, exit_date = ?, net_r = ?, exit_reason = ? WHERE id = ?`,
      [outcome.result, outcome.exitPrice, outcome.exitDate, outcome.netR, outcome.exitReason, t.id]
    );
    resolved++;
  }
  return { entriesFilled, resolved, rejected };
}

/**
 * Pure summary computation over already-fetched rows — separated from
 * `getPaperTradeSummary`'s DB query so this is unit-testable without a
 * database (same reasoning as `walkForwardResolve`).
 *
 * `profitFactor` added 2026-07-31 (external review, round 2 — P0-2): this
 * field was REFERENCED by /api/awo/optimize/promote's gate
 * (`paperSummary.profitFactor < MIN_PAPER_PROFIT_FACTOR`) but never actually
 * computed here — `undefined < 1.10` and `undefined === null` both evaluate
 * to `false` in JS, so that gate silently never rejected anything. Computed
 * the same way as `computeWinRate`'s profitFactor in awo_optimizer.js.
 *
 * @param {Array<{status:string, net_r:number|null, signal_date:string|Date}>} rows
 */
function summarizeTrades(rows) {
  const resolved = rows.filter(r => r.status === 'WIN' || r.status === 'LOSS');
  const wins = resolved.filter(r => r.status === 'WIN');
  const earliestDate = rows.length ? rows.reduce((min, r) => (toDateStr(r.signal_date) < min ? toDateStr(r.signal_date) : min), toDateStr(rows[0].signal_date)) : null;
  const daysElapsed = earliestDate ? Math.floor((Date.now() - new Date(earliestDate).getTime()) / 86400000) : 0;
  const avgNetR = resolved.length ? resolved.reduce((s, r) => s + Number(r.net_r), 0) / resolved.length : null;

  const grossProfit = resolved.filter(r => Number(r.net_r) > 0).reduce((s, r) => s + Number(r.net_r), 0);
  const grossLoss = resolved.filter(r => Number(r.net_r) < 0).reduce((s, r) => s + Math.abs(Number(r.net_r)), 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : null);

  return {
    total: rows.length,
    open: rows.length - resolved.length,
    resolved: resolved.length,
    wins: wins.length,
    losses: resolved.length - wins.length,
    winRate: resolved.length ? Math.round((wins.length / resolved.length) * 1000) / 10 : null,
    avgNetR: avgNetR !== null ? Math.round(avgNetR * 1000) / 1000 : null,
    profitFactor: Number.isFinite(profitFactor) ? Math.round(profitFactor * 100) / 100 : profitFactor, // null or Infinity pass through as-is
    earliestSignalDate: earliestDate,
    calendarDaysElapsed: daysElapsed,
  };
}

/**
 * Summarize the paper-trading track record for one candidate (identified by
 * a stable hash of its weights, so this accumulates across every day the
 * SAME candidate keeps getting found by the daily /run, not reset each
 * time) — used by /api/awo/optimize/promote to decide whether enough real
 * forward evidence exists yet, and by GET /api/awo/paper-trades for human
 * visibility into that decision.
 */
async function getPaperTradeSummary(pool, candidateKey) {
  const [rows] = await pool.query(
    `SELECT status, net_r, signal_date FROM awo_paper_trades WHERE candidate_key = ?`,
    [candidateKey]
  );
  return summarizeTrades(rows);
}

module.exports = { generatePaperTrades, resolvePaperTrades, getPaperTradeSummary, summarizeTrades, candidateKeyFromWeights, walkForwardResolve, MAX_HOLD_DAYS };
