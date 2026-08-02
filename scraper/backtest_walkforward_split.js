/**
 * Walk-Forward Split Validation — Advance.md §11 / item #10, right-sized to
 * what the actual data supports.
 *
 * The single most important open question after EXP-001/002/003: does "AWO
 * Full underperforms simpler baselines" replicate outside the one ~7.5-month
 * window every prior backtest used, or was it specific to that period?
 *
 * True walk-forward (multi-year rolling train/test per Advance.md's own
 * example) is NOT POSSIBLE right now — `idx_concentration` (dn0-dn4, needed
 * for F1/F2/F7/F8) only exists from 2026-01-19 onward, and EXP-001/002/003
 * already used nearly that entire span. There is no unused calendar period
 * left with full broker-factor data to test against.
 *
 * The best honest alternative: split the ONE window that has concentration
 * coverage into two non-overlapping halves and check independently whether
 * the finding holds in BOTH. Coverage among our 145 backtest-eligible
 * tickers is real (not zero) but thinner in the earlier half (~115/145
 * tickers/day, Jan-Apr) than the later half (~130-144/145, May-Jul) —
 * exactly the kind of gap `weightedComposite`/`factorCoverage` exists to
 * handle gracefully rather than silently distort.
 *
 *   Period 1: 2026-01-19 to 2026-04-19 (thinner broker coverage)
 *   Period 2: 2026-04-20 to 2026-07-29 (denser, and the tail end already
 *             covered by EXP-001-003 — so this period is not fully "new",
 *             Period 1 is the actually novel test)
 *
 * Exit rule: ATR/SR-based via computeTradePlan (same as EXP-001) — the most
 * production-faithful version, since this is validating what the LIVE
 * system's own trade-plan logic would have actually produced.
 *
 * Usage: node backtest_walkforward_split.js
 */

'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const stats = require('./modules/statistics');
const { calcTechnicalFactors, computeTradePlan } = require('./awo_technical');
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
const MAX_HOLD = 15;

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

const PERIODS = [
  { label: 'PERIOD 1 (2026-01-19 to 2026-04-19) — thinner broker coverage, genuinely novel test', start: '2026-01-19', end: '2026-04-19' },
  { label: 'PERIOD 2 (2026-04-20 to 2026-07-29) — denser coverage, tail already seen in EXP-001-003', start: '2026-04-20', end: '2026-07-29' },
];

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function simulateLongTrade(candles, entryIdx, atr, sr) {
  if (entryIdx >= candles.length) return null;
  const entryPrice = candles[entryIdx].open;
  const plan = computeTradePlan(entryPrice, 'BUY', atr, sr);
  if (!plan || !Number.isFinite(plan.stopLoss) || plan.stopLoss >= entryPrice) return null;
  const risk = entryPrice - plan.stopLoss;
  if (risk <= 0) return null;

  let exitPrice = null, exitReason = 'TIME_EXIT', holdDays = 0;
  const lastIdx = Math.min(entryIdx + MAX_HOLD - 1, candles.length - 1);
  for (let j = entryIdx; j <= lastIdx; j++) {
    const bar = candles[j];
    holdDays = j - entryIdx + 1;
    const hitStop = bar.low <= plan.stopLoss;
    const hitTarget = bar.high >= plan.target2;
    if (hitStop) { exitPrice = plan.stopLoss; exitReason = 'STOP'; break; }
    if (hitTarget) { exitPrice = plan.target2; exitReason = 'TARGET'; break; }
    if (j === lastIdx) { exitPrice = bar.close; exitReason = 'TIME_EXIT'; }
  }
  if (exitPrice === null) return null;

  const netR = ((exitPrice * (1 - ROUND_TRIP_COST_PCT / 100)) - (entryPrice * (1 + FEE_BUY_PCT / 100))) / risk;
  return { exitReason, holdDays, netR };
}

function metrics(trades) {
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

  for (const period of PERIODS) {
    console.log('\n' + '='.repeat(95));
    console.log(period.label);
    console.log('='.repeat(95));

    const tradesFull = [], tradesTech = [], tradesEma = [], tradesRandom = [];
    const rng = mulberry32(42);
    let coverageSum = 0, coverageDays = 0;

    for (const ticker of tickers) {
      const candles = ohlcMap.get(ticker);
      if (candles.length < 260) continue;
      const startIdx = candles.findIndex(c => c.date >= period.start);
      let endIdx = candles.length - 1;
      for (let k = candles.length - 1; k >= 0; k--) { if (candles[k].date <= period.end) { endIdx = k; break; } }
      endIdx = Math.min(endIdx, candles.length - MAX_HOLD - 1);
      if (startIdx < 0 || endIdx <= startIdx) continue;

      let prevEma9 = null, prevEma21 = null;

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
        coverageDays++; if (brokerDataAvailable) coverageSum++;

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
        const { f9, f10, f11, f12, f13, f14, indicators } = tech;
        const atr = indicators?.atr ?? null;
        const sr = indicators?.sr ?? null;
        const ema9 = indicators?.ema9 ?? null;
        const ema21 = indicators?.ema21 ?? null;

        const { composite: rawFull, factorCoverage } = weightedComposite(
          { f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13 }, DEFAULT_WEIGHTS,
          { f1: brokerDataAvailable, f2: brokerDataAvailable, f6: breadthDataAvailable, f7: brokerDataAvailable, f8: brokerDataAvailable }
        );
        const compositeFull = combineFinalScore(rawFull, computeConfidence(factorCoverage), computeRiskModifier(f14));
        if (classifySignal(compositeFull) === 'BUY' || classifySignal(compositeFull) === 'STRONG BUY') {
          const t = simulateLongTrade(candles, i + 1, atr, sr);
          if (t) tradesFull.push({ ...t, date });
        }

        const techWeights = { f3: DEFAULT_WEIGHTS.f3, f4: DEFAULT_WEIGHTS.f4, f5: DEFAULT_WEIGHTS.f5,
          f9: DEFAULT_WEIGHTS.f9, f10: DEFAULT_WEIGHTS.f10, f11: DEFAULT_WEIGHTS.f11, f12: DEFAULT_WEIGHTS.f12, f13: DEFAULT_WEIGHTS.f13 };
        const { composite: rawTech } = weightedComposite(
          { f3, f4, f5, f9, f10, f11, f12, f13 }, techWeights,
          { f3: true, f4: true, f5: true, f9: true, f10: true, f11: true, f12: true, f13: true }
        );
        const compositeTech = combineFinalScore(rawTech, 1, computeRiskModifier(f14));
        if (classifySignal(compositeTech) === 'BUY' || classifySignal(compositeTech) === 'STRONG BUY') {
          const t = simulateLongTrade(candles, i + 1, atr, sr);
          if (t) tradesTech.push({ ...t, date });
        }

        if (prevEma9 !== null && prevEma21 !== null && ema9 !== null && ema21 !== null) {
          if (prevEma9 <= prevEma21 && ema9 > ema21) {
            const t = simulateLongTrade(candles, i + 1, atr, sr);
            if (t) tradesEma.push({ ...t, date });
          }
        }
        prevEma9 = ema9; prevEma21 = ema21;

        if (rng() < 0.10) {
          const t = simulateLongTrade(candles, i + 1, atr, sr);
          if (t) tradesRandom.push({ ...t, date });
        }
      }
    }

    console.log(`Avg factor coverage this period: ${(coverageSum / coverageDays * 100).toFixed(0)}% of ticker-days had real broker/concentration data\n`);

    function printRow(label, m) {
      if (!m) { console.log(`${label.padEnd(22)} n=0`); return; }
      console.log(`${label.padEnd(22)} n=${String(m.n).padEnd(6)} winRate=${m.winRate.toFixed(1)}%`.padEnd(46) +
        ` expectancy=${m.expectancy >= 0 ? '+' : ''}${m.expectancy.toFixed(3)}R  profitFactor=${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : 'inf'}`);
    }
    printRow('AWO Full', metrics(tradesFull));
    printRow('AWO Technical-Only', metrics(tradesTech));
    printRow('EMA9/21 Crossover', metrics(tradesEma));
    printRow('Random Entry', metrics(tradesRandom));
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
