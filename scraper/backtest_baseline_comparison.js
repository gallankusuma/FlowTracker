/**
 * Baseline Comparison Backtest — "Advance.md" §4 (Baseline A-F) + §7 (Fee/Slippage).
 *
 * The one question that had NEVER been asked this whole session: does AWO's
 * 14-factor composite actually beat something dumb, after transaction costs?
 * Every prior backtest (badges, regime) measured win-rate-by-context, never
 * against a baseline. This script answers that directly.
 *
 * Unlike backtest_signal_scanner_badges.js (which just checks "did price move
 * favorably by close of day+N"), this simulates an ACTUAL TRADE per Advance.md
 * §14 item 7: entry at T+1 open, walked forward day-by-day checking each
 * day's low/high, same-bar stop/target ambiguity resolved conservatively
 * (stop wins — AWO Engine.md §9.5), fee+slippage applied to get a NET (not
 * just gross) result.
 *
 * Exit rule (updated 2026-07-29 per user request): FIXED percentage
 * stop-loss/take-profit (STOP_LOSS_PCT/TAKE_PROFIT_PCT below), NOT the
 * ATR/SR-based computeTradePlan used elsewhere — and NO holding-period cap;
 * a trade runs until stop or target is hit, however long that takes, bounded
 * only by how much forward history actually exists for that ticker. Trades
 * that never resolve before a ticker's data runs out are marked 'DATA_END'
 * and excluded from win-rate/expectancy (they're neither a win nor a loss,
 * just still open) — reported separately as an open-position count.
 *
 * Scope, deliberately narrow per Advance.md §2 ("jangan langsung tiga setup")
 * and its own recommended starting scope: IDX, daily, LONG ONLY. Compares:
 *   Baseline F — AWO Full (current production pipeline, faithfully replayed)
 *   Baseline E — AWO Technical-Only (broker factors f1/f2/f6/f7/f8 excluded
 *                entirely, not just missing — "does broker data even help?")
 *   Baseline C — EMA9/21 golden-cross (simplest trend-following rule)
 *   Baseline D — Random entry, same exit rule, count-matched to AWO Full
 *   Baseline A — Buy & Hold per ticker over the same window (not a "trade",
 *                reported separately — no stop/target/R-multiple applies)
 *   Baseline B — IHSG over the same window (ditto)
 *
 * FEE_BUY_PCT/FEE_SELL_PCT/SLIPPAGE_PCT below are LABELED ASSUMPTIONS (typical
 * IDX retail online-broker order of magnitude), not this user's confirmed real
 * fee schedule — adjust to match your actual broker before trusting the "net"
 * numbers as gospel. Per AWO Engine.md §9.2, these values belong in a config,
 * not as a hardcoded fact.
 *
 * Usage: node backtest_baseline_comparison.js
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

// ── Assumptions — adjust to match reality before trusting "net" numbers ────
const FEE_BUY_PCT = 0.15;      // typical IDX retail buy fee, %
const FEE_SELL_PCT = 0.25;     // typical IDX retail sell fee (incl. 0.1% final tax), %
const SLIPPAGE_PCT = 0.10;     // assumed round-trip slippage, %
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
// Exit rule requested 2026-07-29: fixed-percentage stop/target instead of
// ATR/SR-based (computeTradePlan), holding period NOT capped — walk forward
// until stop or target is hit, however long that takes (bounded only by how
// much forward data actually exists for that ticker).
const STOP_LOSS_PCT = 2;   // fixed stop, % below entry
const TAKE_PROFIT_PCT = 10; // fixed target, % above entry (5:1 reward:risk)

// Deterministic PRNG (mulberry32) — reproducible "random" baseline, not Math.random().
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simulate one long trade: entry at candles[entryIdx].open (T+1 open), FIXED
 * percentage stop-loss/take-profit (STOP_LOSS_PCT/TAKE_PROFIT_PCT above, not
 * ATR/SR-based), walked forward day-by-day with NO holding-period cap — runs
 * until stop or target is hit, or the ticker's data simply runs out. Same-bar
 * stop+target ambiguity resolves to STOP (conservative — AWO Engine.md §9.5).
 * Returns exitReason 'DATA_END' (not STOP/TARGET) when history ran out before
 * either level was reached — an unresolved/still-open trade, not a real win
 * or loss, so callers must exclude these from win-rate/expectancy math.
 */
function simulateLongTrade(candles, entryIdx) {
  if (entryIdx >= candles.length) return null;
  const entryPrice = candles[entryIdx].open;
  const stopLoss = entryPrice * (1 - STOP_LOSS_PCT / 100);
  const target = entryPrice * (1 + TAKE_PROFIT_PCT / 100);
  const risk = entryPrice - stopLoss;

  let exitPrice = null, exitReason = 'DATA_END', holdDays = 0;
  const lastIdx = candles.length - 1;
  for (let j = entryIdx; j <= lastIdx; j++) {
    const bar = candles[j];
    holdDays = j - entryIdx + 1;
    const hitStop = bar.low <= stopLoss;
    const hitTarget = bar.high >= target;
    if (hitStop) { exitPrice = stopLoss; exitReason = 'STOP'; break; }
    if (hitTarget) { exitPrice = target; exitReason = 'TARGET'; break; }
    if (j === lastIdx) { exitPrice = bar.close; exitReason = 'DATA_END'; }
  }
  if (exitPrice === null) return null;

  const grossReturnPct = (exitPrice / entryPrice - 1) * 100;
  const netReturnPct = grossReturnPct - ROUND_TRIP_COST_PCT;
  const grossR = (exitPrice - entryPrice) / risk;
  const netR = ((exitPrice * (1 - ROUND_TRIP_COST_PCT / 100)) - (entryPrice * (1 + FEE_BUY_PCT / 100))) / risk;

  return { entryPrice, exitPrice, exitReason, holdDays, grossReturnPct, netReturnPct, grossR, netR };
}

function metrics(allTrades) {
  if (!allTrades.length) return null;
  // DATA_END = ran out of history before stop/target hit — an unresolved,
  // still-open position, not a genuine win or loss. Excluded from win-rate/
  // expectancy math (counting it as a loss would understate performance;
  // counting it as a win would overstate it), reported as its own count.
  const openCount = allTrades.filter(t => t.exitReason === 'DATA_END').length;
  const trades = allTrades.filter(t => t.exitReason !== 'DATA_END');
  if (!trades.length) return { n: 0, openCount };

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
  const avgHold = stats.mean(trades.map(t => t.holdDays));

  // Simplified equity curve: sort by entry date, sum R sequentially (fixed
  // fractional risk-per-trade assumption — NOT a real portfolio dollar curve,
  // concurrency/capital-allocation across simultaneous positions is out of
  // scope here). Good enough for a directional max-drawdown comparison.
  const sorted = [...trades].sort((a, b) => a.date < b.date ? -1 : 1);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of sorted) {
    cum += t.netR;
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
  }

  return {
    n: trades.length, openCount, winRate: winRate * 100, avgWin, avgLoss,
    expectancy, profitFactor, maxDrawdownR: maxDD, avgHold,
    avgGrossReturnPct: stats.mean(trades.map(t => t.grossReturnPct)),
    avgNetReturnPct: stats.mean(trades.map(t => t.netReturnPct)),
  };
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

  const [dateBoundRows] = await pool.query(`SELECT MIN(date) mn, MAX(date) mx FROM idx_stock_prices`);
  const GAP_END = dateBoundRows[0].mx.toISOString().split('T')[0];
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

  console.log('Simulating trades for each strategy...\n');

  const tradesAwoFull = [], tradesAwoTech = [], tradesEma = [], tradesRandom = [];
  const buyHoldReturns = [];
  const rng = mulberry32(42);

  for (const ticker of tickers) {
    const candles = ohlcMap.get(ticker);
    if (candles.length < 260) continue;

    const startIdx = Math.max(200, candles.length - LOOKBACK_DAYS);
    const endIdx = candles.length - 2; // leave room for at least a T+1 entry
    if (endIdx <= startIdx) continue;

    // Baseline A: Buy & Hold this ticker over the exact test window.
    buyHoldReturns.push((candles[endIdx].close / candles[startIdx].close - 1) * 100);

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
      const ema9 = indicators?.ema9 ?? null;
      const ema21 = indicators?.ema21 ?? null;

      // ── Baseline F: AWO Full ──
      const { composite: rawFull, factorCoverage } = weightedComposite(
        { f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13 }, DEFAULT_WEIGHTS,
        { f1: brokerDataAvailable, f2: brokerDataAvailable, f6: breadthDataAvailable, f7: brokerDataAvailable, f8: brokerDataAvailable }
      );
      const compositeFull = combineFinalScore(rawFull, computeConfidence(factorCoverage), computeRiskModifier(f14));
      if (classifySignal(compositeFull) === 'BUY' || classifySignal(compositeFull) === 'STRONG BUY') {
        const t = simulateLongTrade(candles, i + 1);
        if (t) tradesAwoFull.push({ ...t, date, ticker });
      }

      // ── Baseline E: AWO Technical-Only (broker factors excluded entirely) ──
      const techWeights = { f3: DEFAULT_WEIGHTS.f3, f4: DEFAULT_WEIGHTS.f4, f5: DEFAULT_WEIGHTS.f5,
        f9: DEFAULT_WEIGHTS.f9, f10: DEFAULT_WEIGHTS.f10, f11: DEFAULT_WEIGHTS.f11, f12: DEFAULT_WEIGHTS.f12, f13: DEFAULT_WEIGHTS.f13 };
      const { composite: rawTech } = weightedComposite(
        { f3, f4, f5, f9, f10, f11, f12, f13 }, techWeights,
        { f3: true, f4: true, f5: true, f9: true, f10: true, f11: true, f12: true, f13: true }
      );
      const compositeTech = combineFinalScore(rawTech, 1, computeRiskModifier(f14));
      if (classifySignal(compositeTech) === 'BUY' || classifySignal(compositeTech) === 'STRONG BUY') {
        const t = simulateLongTrade(candles, i + 1);
        if (t) tradesAwoTech.push({ ...t, date, ticker });
      }

      // ── Baseline C: EMA9/21 golden cross ──
      if (prevEma9 !== null && prevEma21 !== null && ema9 !== null && ema21 !== null) {
        if (prevEma9 <= prevEma21 && ema9 > ema21) {
          const t = simulateLongTrade(candles, i + 1);
          if (t) tradesEma.push({ ...t, date, ticker });
        }
      }
      prevEma9 = ema9; prevEma21 = ema21;

      // ── Baseline D: Random entry (rate-matched to AWO Full's ~signal frequency) ──
      if (rng() < 0.10) { // AWO Full fires roughly 1-in-10 days per ticker in practice; see printed rate below
        const t = simulateLongTrade(candles, i + 1);
        if (t) tradesRandom.push({ ...t, date, ticker });
      }
    }
  }

  // ── IHSG (Baseline B) over the same calendar window ──
  const [ihsgRows] = await pool.query(`SELECT date, close_price c FROM idx_ihsg_history ORDER BY date ASC`);
  const ihsgCloses = ihsgRows.map(r => ({ date: r.date.toISOString().split('T')[0], close: Number(r.c) }));
  let ihsgReturn = null;
  if (ihsgCloses.length > 0) {
    const allTestDates = [...changeByDate.keys()].sort();
    const winStart = allTestDates[0], winEnd = allTestDates[allTestDates.length - 1];
    const startRow = ihsgCloses.find(r => r.date >= winStart);
    const endRow = [...ihsgCloses].reverse().find(r => r.date <= winEnd);
    if (startRow && endRow) ihsgReturn = (endRow.close / startRow.close - 1) * 100;
  }

  console.log('='.repeat(90));
  console.log(`SIGNAL-BASED STRATEGIES — fixed ${STOP_LOSS_PCT}% stop / ${TAKE_PROFIT_PCT}% target, T+1 open entry,`);
  console.log('NO holding-period cap (runs until stop/target hit or data runs out), same-bar stop-wins');
  console.log('='.repeat(90));
  console.log(`Round-trip cost assumption: ${ROUND_TRIP_COST_PCT.toFixed(2)}% (fee+slippage — adjust to your real broker)\n`);

  const rateAwoFull = tradesAwoFull.length;
  console.log(`(AWO Full fired ${rateAwoFull} BUY signals — Random Entry rate was calibrated against this expectation, actual random count printed below)\n`);

  function printRow(label, m) {
    if (!m || m.n === 0) { console.log(`${label.padEnd(22)} n=0 (no resolved trades${m?.openCount ? `, ${m.openCount} still open at data end` : ''})`); return; }
    console.log(`${label.padEnd(22)} n=${String(m.n).padEnd(5)} winRate=${m.winRate.toFixed(1)}%`.padEnd(50) +
      ` expectancy=${m.expectancy>=0?'+':''}${m.expectancy.toFixed(3)}R  profitFactor=${Number.isFinite(m.profitFactor)?m.profitFactor.toFixed(2):'inf'}  maxDD=${m.maxDrawdownR.toFixed(2)}R  avgHold=${m.avgHold.toFixed(1)}d  netReturn/trade=${m.avgNetReturnPct>=0?'+':''}${m.avgNetReturnPct.toFixed(2)}% (gross ${m.avgGrossReturnPct>=0?'+':''}${m.avgGrossReturnPct.toFixed(2)}%)  [${m.openCount} still open at data end, excluded]`);
  }

  printRow('AWO Full (F)', metrics(tradesAwoFull));
  printRow('AWO Technical-Only (E)', metrics(tradesAwoTech));
  printRow('EMA9/21 Crossover (C)', metrics(tradesEma));
  printRow('Random Entry (D)', metrics(tradesRandom));

  console.log('\n' + '='.repeat(90));
  console.log('PASSIVE BENCHMARKS — not trades, just holding-period return (no stop/target/R applies)');
  console.log('='.repeat(90));
  console.log(`Buy & Hold, avg across ${buyHoldReturns.length} tickers (A): ${stats.mean(buyHoldReturns) >= 0 ? '+' : ''}${stats.mean(buyHoldReturns).toFixed(2)}% over the test window`);
  console.log(`IHSG index over same window (B): ${ihsgReturn !== null ? (ihsgReturn >= 0 ? '+' : '') + ihsgReturn.toFixed(2) + '%' : 'n/a'}`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
