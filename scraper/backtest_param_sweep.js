/**
 * Stop-Loss × Holding-Time parameter sweep, per Advance.md §9 (Sensitivity
 * Test) — "jangan cuma mencari kombinasi parameter terbaik... tim juga harus
 * menguji area sekitarnya. Strategi sehat seharusnya memiliki plateau, bukan
 * satu titik parameter ajaib."
 *
 * Two FREE variables: Stop Loss % and Max Holding Days.
 * One FIXED variable: Take Profit = 10% (per user's explicit request).
 *
 * Signal generation (which day AWO Full says BUY) is independent of
 * stop-loss/holding-time — those only affect what happens AFTER entry. So
 * signals are generated ONCE, then replayed through the trade simulator once
 * per (stopPct, maxHold) grid cell — cheap, since only the exit walk changes.
 *
 * Random Entry is swept through the same grid as a reference: if AWO Full's
 * "best" cell doesn't also beat Random Entry at that SAME cell, the best
 * parameter isn't AWO's edge, it's just what this market window rewarded.
 *
 * Usage: node backtest_param_sweep.js
 */

'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const stats = require('./modules/statistics');
const { calcTechnicalFactors } = require('./awo_technical');
const {
  f1_concentration, f2_trend, f3_volumeZ, f4_momentum, f5_relStrength,
  f6_breadth, f7_alignment, f8_streak,
  weightedComposite, computeConfidence, computeRiskModifier, combineFinalScore,
} = require('./modules/awo_factors');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const FEE_BUY_PCT = 0.15, FEE_SELL_PCT = 0.25, SLIPPAGE_PCT = 0.10;
const ROUND_TRIP_COST_PCT = FEE_BUY_PCT + FEE_SELL_PCT + SLIPPAGE_PCT;

const DEFAULT_WEIGHTS = {
  f1: 0.14, f2: 0.10, f3: 0.08, f4: 0.10,
  f5: 0.07, f6: 0.10, f7: 0.08, f8: 0.05,
  f9: 0.06, f10: 0.06, f11: 0.05, f12: 0.05,
  f13: 0.03, f14: 0.03,
};
const THRESHOLDS = { strongBuy: 78, buy: 63, watch: 53, neutral: 40, sell: 25 };
function classifySignal(score) {
  const t = THRESHOLDS;
  if (score >= t.strongBuy) return 'STRONG BUY';
  if (score >= t.buy) return 'BUY';
  if (score >= t.watch) return 'WATCH';
  if (score >= t.neutral) return 'NEUTRAL';
  if (score >= t.sell) return 'SELL';
  return 'STRONG SELL';
}

const LOOKBACK_DAYS = 160;
const TAKE_PROFIT_PCT = 10; // FIXED per user request

// The two FREE variables being swept.
const STOP_LOSS_GRID = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
const MAX_HOLD_GRID = [5, 10, 15, 20, 30, 45, 60];

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Replay one stored entry point through fixed-% stop/target with a given max hold. */
function simulateLongTrade(candles, entryIdx, stopPct, tpPct, maxHold) {
  if (entryIdx >= candles.length) return null;
  const entryPrice = candles[entryIdx].open;
  const stopLoss = entryPrice * (1 - stopPct / 100);
  const target = entryPrice * (1 + tpPct / 100);
  const risk = entryPrice - stopLoss;

  let exitPrice = null, exitReason = 'DATA_END', holdDays = 0;
  const lastIdx = Math.min(entryIdx + maxHold - 1, candles.length - 1);
  for (let j = entryIdx; j <= lastIdx; j++) {
    const bar = candles[j];
    holdDays = j - entryIdx + 1;
    if (bar.low <= stopLoss) { exitPrice = stopLoss; exitReason = 'STOP'; break; }
    if (bar.high >= target) { exitPrice = target; exitReason = 'TARGET'; break; }
    if (j === lastIdx) { exitPrice = bar.close; exitReason = 'TIME_EXIT'; }
  }
  if (exitPrice === null) return null;

  const netR = ((exitPrice * (1 - ROUND_TRIP_COST_PCT / 100)) - (entryPrice * (1 + FEE_BUY_PCT / 100))) / risk;
  return { exitReason, holdDays, netR };
}

function metrics(allTrades) {
  const trades = allTrades.filter(t => t.exitReason !== 'DATA_END');
  if (!trades.length) return null;
  const netRs = trades.map(t => t.netR);
  const wins = netRs.filter(r => r > 0);
  const losses = netRs.filter(r => r <= 0);
  const winRate = wins.length / trades.length;
  const avgWin = wins.length ? stats.mean(wins) : 0;
  const avgLoss = losses.length ? Math.abs(stats.mean(losses)) : 0;
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;
  const grossProfit = wins.reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  return { n: trades.length, winRate: winRate * 100, expectancy, profitFactor };
}

async function main() {
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  const [tickerRows] = await pool.query(
    `SELECT stock_code, COUNT(*) n FROM idx_stock_prices GROUP BY stock_code HAVING n >= 260 ORDER BY stock_code`
  );
  const tickers = tickerRows.map(r => r.stock_code);
  console.log(`Tickers: ${tickers.length}`);

  const ohlcMap = new Map();
  for (const t of tickers) {
    const [rows] = await pool.query(
      `SELECT date, open_price o, high_price h, low_price l, close_price c, volume v FROM idx_stock_prices WHERE stock_code=? ORDER BY date ASC`, [t]
    );
    ohlcMap.set(t, rows.map(r => ({
      date: r.date.toISOString().split('T')[0], open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v),
    })));
  }

  const [concRows] = await pool.query(`SELECT data_date, stock_code, dn0, dn1, dn2, dn3, dn4 FROM idx_concentration`);
  const concMap = new Map();
  for (const r of concRows) concMap.set(`${r.stock_code}|${r.data_date.toISOString().split('T')[0]}`, r);

  const [brokerRows] = await pool.query(`SELECT date, stock_code, broker_code, buy_val - sell_val net_val FROM idx_broker_summary`);
  const breadthMap = new Map();
  for (const r of brokerRows) {
    const key = `${r.stock_code}|${r.date.toISOString().split('T')[0]}`;
    if (!breadthMap.has(key)) breadthMap.set(key, { buyers: 0, sellers: 0 });
    const e = breadthMap.get(key);
    if (Number(r.net_val) > 0) e.buyers++; else if (Number(r.net_val) < 0) e.sellers++;
  }

  const changeByDate = new Map();
  for (const t of tickers) {
    const c = ohlcMap.get(t);
    for (let i = 1; i < c.length; i++) {
      const chg = (c[i].close / c[i - 1].close - 1) * 100;
      if (!changeByDate.has(c[i].date)) changeByDate.set(c[i].date, []);
      changeByDate.get(c[i].date).push(chg);
    }
  }
  const marketAvgByDate = new Map();
  for (const [date, arr] of changeByDate) marketAvgByDate.set(date, stats.mean(arr));

  console.log('Generating signals (once) ...\n');

  // Store just {ticker, entryIdx} — exit simulation happens per grid cell.
  const awoFullEntries = [];
  const randomEntries = [];
  const rng = mulberry32(42);

  for (const ticker of tickers) {
    const candles = ohlcMap.get(ticker);
    if (candles.length < 260) continue;
    const startIdx = Math.max(200, candles.length - LOOKBACK_DAYS);
    const endIdx = candles.length - 2;
    if (endIdx <= startIdx) continue;

    for (let i = startIdx; i <= endIdx; i++) {
      const date = candles[i].date;
      const closes = candles.slice(0, i + 1).map(c => c.close);
      const volumes = candles.slice(Math.max(0, i - 29), i + 1).map(c => c.volume);
      const dailyChange = (candles[i].close / candles[i - 1].close - 1) * 100;
      const priceDirection = dailyChange > 0 ? 1 : dailyChange < 0 ? -1 : 0;

      const conc = concMap.get(`${ticker}|${date}`);
      const dn0 = conc ? Number(conc.dn0 ?? 0) : null;
      const dnValues = conc ? [conc.dn4, conc.dn3, conc.dn2, conc.dn1, conc.dn0].map(v => v !== null && v !== undefined ? Number(v) : null) : [];
      const breadthKey = `${ticker}|${date}`;
      const breadth = breadthMap.get(breadthKey) || { buyers: 0, sellers: 0 };
      const brokerDataAvailable = !!conc;
      const breadthDataAvailable = breadthMap.has(breadthKey);
      const marketAvgChange = marketAvgByDate.get(date) || 0;

      const f1 = f1_concentration(dn0);
      const f2 = f2_trend(dnValues);
      const f3 = f3_volumeZ(volumes, priceDirection);
      const f4 = f4_momentum(closes);
      const f5 = f5_relStrength(dailyChange, marketAvgChange);
      const f6 = f6_breadth(breadth.buyers, breadth.sellers);
      const f7 = f7_alignment(dailyChange, dn0);
      const f8 = f8_streak(dnValues);

      const windowCandles = candles.slice(0, i + 1);
      const tech = calcTechnicalFactors(windowCandles.slice(-60));
      const { f9, f10, f11, f12, f13, f14 } = tech;

      const { composite: rawFull, factorCoverage } = weightedComposite(
        { f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13 }, DEFAULT_WEIGHTS,
        { f1: brokerDataAvailable, f2: brokerDataAvailable, f6: breadthDataAvailable, f7: brokerDataAvailable, f8: brokerDataAvailable }
      );
      const compositeFull = combineFinalScore(rawFull, computeConfidence(factorCoverage), computeRiskModifier(f14));
      if (classifySignal(compositeFull) === 'BUY' || classifySignal(compositeFull) === 'STRONG BUY') {
        awoFullEntries.push({ ticker, entryIdx: i + 1 });
      }

      if (rng() < 0.10) randomEntries.push({ ticker, entryIdx: i + 1 });
    }
  }

  console.log(`AWO Full signals: ${awoFullEntries.length}, Random Entry signals: ${randomEntries.length}\n`);
  console.log(`Take Profit fixed at ${TAKE_PROFIT_PCT}% for every cell below.\n`);

  function sweep(entries) {
    const grid = {};
    for (const stopPct of STOP_LOSS_GRID) {
      grid[stopPct] = {};
      for (const maxHold of MAX_HOLD_GRID) {
        const trades = entries.map(e => simulateLongTrade(ohlcMap.get(e.ticker), e.entryIdx, stopPct, TAKE_PROFIT_PCT, maxHold)).filter(Boolean);
        grid[stopPct][maxHold] = metrics(trades);
      }
    }
    return grid;
  }

  const gridFull = sweep(awoFullEntries);
  const gridRandom = sweep(randomEntries);

  function printGrid(title, grid, field, fmt) {
    console.log('='.repeat(100));
    console.log(title);
    console.log('='.repeat(100));
    console.log('StopLoss\\Hold'.padEnd(14) + MAX_HOLD_GRID.map(h => `${h}d`.padStart(10)).join(''));
    for (const stopPct of STOP_LOSS_GRID) {
      let row = `${stopPct}%`.padEnd(14);
      for (const maxHold of MAX_HOLD_GRID) {
        const m = grid[stopPct][maxHold];
        row += (m ? fmt(m[field]) : 'n/a').padStart(10);
      }
      console.log(row);
    }
    console.log('');
  }

  printGrid('AWO FULL — Expectancy (R) by Stop Loss % (rows) x Max Hold Days (cols), TP=10% fixed',
    gridFull, 'expectancy', v => (v >= 0 ? '+' : '') + v.toFixed(2));
  printGrid('AWO FULL — Profit Factor', gridFull, 'profitFactor', v => Number.isFinite(v) ? v.toFixed(2) : 'inf');
  printGrid('AWO FULL — n trades', gridFull, 'n', v => String(v));

  printGrid('RANDOM ENTRY (reference) — Expectancy (R)', gridRandom, 'expectancy', v => (v >= 0 ? '+' : '') + v.toFixed(2));

  // Best cell by expectancy
  let best = null;
  for (const stopPct of STOP_LOSS_GRID) {
    for (const maxHold of MAX_HOLD_GRID) {
      const m = gridFull[stopPct][maxHold];
      if (m && m.n >= 15 && (!best || m.expectancy > best.m.expectancy)) best = { stopPct, maxHold, m };
    }
  }
  if (best) {
    console.log(`Best AWO Full cell (n>=15): stop=${best.stopPct}% hold=${best.maxHold}d → expectancy=${best.m.expectancy.toFixed(2)}R, profitFactor=${Number.isFinite(best.m.profitFactor)?best.m.profitFactor.toFixed(2):'inf'}, winRate=${best.m.winRate.toFixed(1)}%, n=${best.m.n}`);
    const rndAtBest = gridRandom[best.stopPct][best.maxHold];
    console.log(`Random Entry at that SAME cell: ${rndAtBest ? `expectancy=${rndAtBest.expectancy.toFixed(2)}R, n=${rndAtBest.n}` : 'n/a'}`);
  } else {
    console.log('No cell reached n>=15 trades.');
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
