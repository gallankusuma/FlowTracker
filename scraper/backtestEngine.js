/**
 * backtestEngine.js — Historical Harmonic Pattern Backtest Engine
 * 
 * Scans each trading day in a date range, detects harmonic patterns
 * "as of" that day (no future data), then simulates forward to check
 * if price hits T1, T2, or SL.
 * 
 * Trade Rules:
 * - Entry: price must enter the entry zone (entry_min – entry_max) within 5 days of detection
 * - Exit priority per candle (conservative): SL first, then T2, then T1
 * - Max hold: 30 trading days after entry
 * - If no entry within 5 days → NO_ENTRY
 * - If no exit within 30 days → EXPIRED
 */

'use strict';

const { detectHarmonicPatterns } = require('./harmonicEngine');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════
const MAX_ENTRY_WAIT_DAYS = 5;   // days to wait for price to enter zone
const MAX_HOLD_DAYS = 30;        // max holding period after entry
const MIN_OHLC_BARS = 60;        // minimum bars needed for pattern detection

// ═══════════════════════════════════════════════════════════════
// MAIN BACKTEST FUNCTION
// ═══════════════════════════════════════════════════════════════

/**
 * Run historical backtest over a date range.
 * @param {Object} pool - MySQL pool
 * @param {string} startDate - 'YYYY-MM-DD'
 * @param {string} endDate   - 'YYYY-MM-DD'
 * @param {string[]} tickers - list of tickers to scan
 * @param {Function} onProgress - callback(processed, total, currentTicker, currentDate)
 * @returns {Object} { run_id, trades, stats }
 */
async function runHistoricalBacktest(pool, startDate, endDate, tickers, onProgress) {
  const run_id = crypto.randomUUID();
  const trades = [];
  const errors = [];

  console.log(`\n🔬 [BACKTEST] Starting run ${run_id}`);
  console.log(`   📅 Range: ${startDate} → ${endDate}`);
  console.log(`   📊 Tickers: ${tickers.length}`);

  // ── 1. Load ALL OHLC data for all tickers (ONE BULK QUERY) ──────
  const allOHLC = {};
  console.log(`   ⏳ Loading OHLC data for ${tickers.length} tickers...`);
  
  // Single bulk query for all tickers at once — much faster than N sequential queries
  const tickerPlaceholders = tickers.map(() => '?').join(',');
  const [allRows] = await pool.query(
    `SELECT ticker, date, open_price AS \`open\`, high_price AS high, 
            low_price AS low, close_price AS \`close\`, volume
     FROM ft_price_ohlc 
     WHERE ticker IN (${tickerPlaceholders}) AND date <= ? 
     ORDER BY ticker, date ASC`,
    [...tickers, endDate]
  );
  
  // Group rows by ticker
  for (const ticker of tickers) allOHLC[ticker] = [];
  for (const r of allRows) {
    const ticker = r.ticker;
    if (!allOHLC[ticker]) allOHLC[ticker] = [];
    allOHLC[ticker].push({
      date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume || 0),
    });
  }
  console.log(`   ✅ Loaded ${allRows.length} OHLC rows for ${tickers.length} tickers`);

  // ── 2. Get all trading days in range ───────────────────────────
  const tradingDays = getTradingDays(startDate, endDate, allOHLC);
  console.log(`   📆 Trading days found: ${tradingDays.length}`);

  // Track which patterns we've already detected (dedup key)
  const seenPatterns = new Set();
  let processed = 0;

  // ── 3. Loop each trading day ───────────────────────────────────
  for (const scanDate of tradingDays) {
    processed++;
    
    for (const ticker of tickers) {
      try {
        // Get OHLC up to (and including) scanDate only — no future peeking
        const fullOHLC = allOHLC[ticker];
        if (!fullOHLC || fullOHLC.length < MIN_OHLC_BARS) continue;

        const cutoffIdx = fullOHLC.findIndex(c => c.date > scanDate);
        const truncatedOHLC = cutoffIdx === -1 ? [...fullOHLC] : fullOHLC.slice(0, cutoffIdx);
        if (truncatedOHLC.length < MIN_OHLC_BARS) continue;

        // Run harmonic detection on truncated data
        const patterns = detectHarmonicPatterns(truncatedOHLC, ticker, { maxPatternSpan: 60, maxDAge: 5, maxPrzGap: 0.08, swingLeft: 5, swingRight: 3 });
        if (!patterns || patterns.length === 0) continue;

        for (const p of patterns) {
          // Dedup: skip if we already have this pattern (same ticker+type+direction+D_date)
          const dedupKey = `${ticker}-${p.pattern_type}-${p.direction}-${p.D_date || scanDate}`;
          if (seenPatterns.has(dedupKey)) continue;
          seenPatterns.add(dedupKey);

          // Get future OHLC for simulation
          const futureStartIdx = cutoffIdx === -1 ? fullOHLC.length : cutoffIdx;
          // Also load future data beyond endDate for simulation
          const futureOHLC = allOHLC[ticker].slice(futureStartIdx, futureStartIdx + MAX_HOLD_DAYS + MAX_ENTRY_WAIT_DAYS);

          // Simulate the trade
          const result = simulateTrade(p, futureOHLC, scanDate);
          
          const trade = {
            run_id,
            ticker,
            pattern_type: p.pattern_type,
            direction: p.direction,
            detected_date: scanDate,
            entry_price: result.entry_price,
            entry_date: result.entry_date,
            stop_loss: Math.round(p.stop_loss),
            target_1: Math.round(p.target_1),
            target_2: Math.round(p.target_2),
            risk_reward: p.risk_reward || 0,
            conviction_score: p.conviction_score || 0,
            fib_score: p.fib_score || 0,
            status: result.status,
            result_pct: result.result_pct,
            exit_price: result.exit_price,
            exit_date: result.exit_date,
            hold_days: result.hold_days,
            pattern_data: JSON.stringify(p.pattern_data || {}),
          };
          trades.push(trade);
        }
      } catch (err) {
        errors.push({ ticker, date: scanDate, error: err.message });
      }
    }

    if (onProgress && processed % 2 === 0) {
      onProgress(processed, tradingDays.length, '', scanDate);
    }
  }

  // ── 4. Batch insert results ────────────────────────────────────
  if (trades.length > 0) {
    const BATCH_SIZE = 100;
    for (let i = 0; i < trades.length; i += BATCH_SIZE) {
      const batch = trades.slice(i, i + BATCH_SIZE);
      const values = batch.map(t => [
        t.run_id, t.ticker, t.pattern_type, t.direction, t.detected_date,
        t.entry_price, t.entry_date, t.stop_loss, t.target_1, t.target_2,
        t.risk_reward, t.conviction_score, t.fib_score,
        t.status, t.result_pct, t.exit_price, t.exit_date, t.hold_days,
        t.pattern_data
      ]);
      await pool.query(
        `INSERT INTO ft_backtest_results 
         (run_id, ticker, pattern_type, direction, detected_date,
          entry_price, entry_date, stop_loss, target_1, target_2,
          risk_reward, conviction_score, fib_score,
          status, result_pct, exit_price, exit_date, hold_days,
          pattern_data)
         VALUES ?`,
        [values]
      );
    }
  }

  // ── 5. Calculate stats ─────────────────────────────────────────
  const stats = calculateStats(trades);

  console.log(`\n✅ [BACKTEST] Run ${run_id} complete!`);
  console.log(`   📊 Total patterns detected: ${trades.length}`);
  console.log(`   ✅ Entered trades: ${stats.entered}`);
  console.log(`   🎯 Win rate: ${stats.win_rate}%`);
  console.log(`   📈 Avg return: ${stats.avg_return}%`);
  if (errors.length > 0) console.log(`   ⚠️  Errors: ${errors.length}`);

  return { run_id, total_trades: trades.length, stats, errors: errors.length };
}

// ═══════════════════════════════════════════════════════════════
// TRADE SIMULATION
// ═══════════════════════════════════════════════════════════════

/**
 * Simulate a single trade given a detected pattern and future OHLC bars.
 * 
 * Rules:
 * 1. Wait up to MAX_ENTRY_WAIT_DAYS for price to enter the entry zone
 * 2. Once entered, check each subsequent bar for exit conditions
 * 3. Exit priority (conservative): SL → T2 → T1
 * 4. Max hold: MAX_HOLD_DAYS after entry
 */
function simulateTrade(pattern, futureOHLC, detectedDate) {
  const direction = pattern.direction; // 'BULLISH' or 'BEARISH'
  const entryMin = Number(pattern.entry_min || pattern.entry_price * 0.99);
  const entryMax = Number(pattern.entry_max || pattern.entry_price * 1.01);
  const entryMid = (entryMin + entryMax) / 2;
  const sl = Number(pattern.stop_loss);
  const t1 = Number(pattern.target_1);
  const t2 = Number(pattern.target_2);

  // ── Phase 1: Wait for entry ──────────────────────────────────
  let entryPrice = null;
  let entryDate = null;
  let entryBarIdx = -1;

  for (let i = 0; i < Math.min(futureOHLC.length, MAX_ENTRY_WAIT_DAYS); i++) {
    const bar = futureOHLC[i];
    
    if (direction === 'BULLISH') {
      // For bullish: price should come DOWN into our buy zone
      if (bar.low <= entryMax && bar.high >= entryMin) {
        // Price entered the zone — use the midpoint or actual close if in range
        entryPrice = Math.max(entryMin, Math.min(entryMax, bar.close));
        entryDate = bar.date;
        entryBarIdx = i;
        break;
      }
    } else {
      // For bearish (short): price should come UP into our sell zone
      if (bar.high >= entryMin && bar.low <= entryMax) {
        entryPrice = Math.max(entryMin, Math.min(entryMax, bar.close));
        entryDate = bar.date;
        entryBarIdx = i;
        break;
      }
    }
  }

  // No entry triggered
  if (entryBarIdx === -1) {
    return {
      status: 'NO_ENTRY',
      entry_price: null,
      entry_date: null,
      exit_price: null,
      exit_date: null,
      result_pct: null,
      hold_days: null,
    };
  }

  // ── Phase 2: Simulate hold period ────────────────────────────
  const holdBars = futureOHLC.slice(entryBarIdx + 1, entryBarIdx + 1 + MAX_HOLD_DAYS);

  for (let i = 0; i < holdBars.length; i++) {
    const bar = holdBars[i];
    const holdDays = i + 1;

    if (direction === 'BULLISH') {
      // SL check first (conservative)
      if (bar.low <= sl) {
        const exitPrice = sl;
        return {
          status: 'STOPPED',
          entry_price: Math.round(entryPrice),
          entry_date: entryDate,
          exit_price: Math.round(exitPrice),
          exit_date: bar.date,
          result_pct: round2(((exitPrice - entryPrice) / entryPrice) * 100),
          hold_days: holdDays,
        };
      }
      // T2 check
      if (bar.high >= t2) {
        const exitPrice = t2;
        return {
          status: 'HIT_T2',
          entry_price: Math.round(entryPrice),
          entry_date: entryDate,
          exit_price: Math.round(exitPrice),
          exit_date: bar.date,
          result_pct: round2(((exitPrice - entryPrice) / entryPrice) * 100),
          hold_days: holdDays,
        };
      }
      // T1 check
      if (bar.high >= t1) {
        const exitPrice = t1;
        return {
          status: 'HIT_T1',
          entry_price: Math.round(entryPrice),
          entry_date: entryDate,
          exit_price: Math.round(exitPrice),
          exit_date: bar.date,
          result_pct: round2(((exitPrice - entryPrice) / entryPrice) * 100),
          hold_days: holdDays,
        };
      }
    } else {
      // BEARISH — short trade
      // SL check first (conservative) — SL is ABOVE entry for shorts
      if (bar.high >= sl) {
        const exitPrice = sl;
        return {
          status: 'STOPPED',
          entry_price: Math.round(entryPrice),
          entry_date: entryDate,
          exit_price: Math.round(exitPrice),
          exit_date: bar.date,
          result_pct: round2(((entryPrice - exitPrice) / entryPrice) * 100),
          hold_days: holdDays,
        };
      }
      // T2 check — T2 is BELOW T1 for shorts
      if (bar.low <= t2) {
        const exitPrice = t2;
        return {
          status: 'HIT_T2',
          entry_price: Math.round(entryPrice),
          entry_date: entryDate,
          exit_price: Math.round(exitPrice),
          exit_date: bar.date,
          result_pct: round2(((entryPrice - exitPrice) / entryPrice) * 100),
          hold_days: holdDays,
        };
      }
      // T1 check
      if (bar.low <= t1) {
        const exitPrice = t1;
        return {
          status: 'HIT_T1',
          entry_price: Math.round(entryPrice),
          entry_date: entryDate,
          exit_price: Math.round(exitPrice),
          exit_date: bar.date,
          result_pct: round2(((entryPrice - exitPrice) / entryPrice) * 100),
          hold_days: holdDays,
        };
      }
    }
  }

  // Expired — max hold exceeded, close at last available price
  const lastBar = holdBars.length > 0 ? holdBars[holdBars.length - 1] : futureOHLC[entryBarIdx];
  const exitPrice = lastBar.close;
  const resultPct = direction === 'BULLISH'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;

  return {
    status: 'EXPIRED',
    entry_price: Math.round(entryPrice),
    entry_date: entryDate,
    exit_price: Math.round(exitPrice),
    exit_date: lastBar.date,
    result_pct: round2(resultPct),
    hold_days: holdBars.length,
  };
}

// ═══════════════════════════════════════════════════════════════
// STATS CALCULATION
// ═══════════════════════════════════════════════════════════════
function calculateStats(trades) {
  const entered = trades.filter(t => t.status !== 'NO_ENTRY');
  const closed = entered.filter(t => ['HIT_T1', 'HIT_T2', 'STOPPED', 'EXPIRED'].includes(t.status));
  const wins = closed.filter(t => ['HIT_T1', 'HIT_T2'].includes(t.status));
  const losses = closed.filter(t => t.status === 'STOPPED');
  const expired = closed.filter(t => t.status === 'EXPIRED');

  const totalReturn = closed.reduce((s, t) => s + (Number(t.result_pct) || 0), 0);
  const avgReturn = closed.length > 0 ? totalReturn / closed.length : 0;
  const avgHold = closed.reduce((s, t) => s + (t.hold_days || 0), 0) / Math.max(closed.length, 1);

  // By pattern
  const byPattern = {};
  for (const t of closed) {
    if (!byPattern[t.pattern_type]) {
      byPattern[t.pattern_type] = { wins: 0, losses: 0, expired: 0, total: 0, total_return: 0 };
    }
    const p = byPattern[t.pattern_type];
    p.total++;
    p.total_return += Number(t.result_pct) || 0;
    if (['HIT_T1', 'HIT_T2'].includes(t.status)) p.wins++;
    else if (t.status === 'STOPPED') p.losses++;
    else p.expired++;
  }

  const patternStats = Object.entries(byPattern).map(([name, p]) => ({
    pattern: name,
    total: p.total,
    wins: p.wins,
    losses: p.losses,
    expired: p.expired,
    win_rate: p.total > 0 ? round2((p.wins / p.total) * 100) : 0,
    avg_return: p.total > 0 ? round2(p.total_return / p.total) : 0,
  })).sort((a, b) => b.win_rate - a.win_rate);

  // By direction
  const byDirection = {};
  for (const t of closed) {
    if (!byDirection[t.direction]) {
      byDirection[t.direction] = { wins: 0, total: 0, total_return: 0 };
    }
    const d = byDirection[t.direction];
    d.total++;
    d.total_return += Number(t.result_pct) || 0;
    if (['HIT_T1', 'HIT_T2'].includes(t.status)) d.wins++;
  }
  const directionStats = Object.entries(byDirection).map(([dir, d]) => ({
    direction: dir,
    total: d.total,
    wins: d.wins,
    win_rate: d.total > 0 ? round2((d.wins / d.total) * 100) : 0,
    avg_return: d.total > 0 ? round2(d.total_return / d.total) : 0,
  }));

  return {
    total_patterns: trades.length,
    entered: entered.length,
    no_entry: trades.length - entered.length,
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    expired: expired.length,
    win_rate: closed.length > 0 ? round2((wins.length / closed.length) * 100) : 0,
    total_return: round2(totalReturn),
    avg_return: round2(avgReturn),
    avg_hold_days: round2(avgHold),
    by_pattern: patternStats,
    by_direction: directionStats,
  };
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Get unique trading days from OHLC data within a date range.
 */
function getTradingDays(startDate, endDate, allOHLC) {
  const daySet = new Set();
  for (const ticker of Object.keys(allOHLC)) {
    for (const bar of allOHLC[ticker]) {
      if (bar.date >= startDate && bar.date <= endDate) {
        daySet.add(bar.date);
      }
    }
  }
  return [...daySet].sort();
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { runHistoricalBacktest };
