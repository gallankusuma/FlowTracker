/**
 * Backtest: documented academic anomalies for IDX, tested against our own 2-year
 * price history (idx_stock_prices, 145 tickers). Candidates researched via literature
 * search (see project memory) — testable ones without needing new data sources:
 *   1. Turn-of-month effect (last 2 + first 4 trading days of month)
 *   2. Day-of-week / Monday effect
 *   3. January / month-of-year seasonality
 *   4. Momentum (12-1 month formation, quintile spread, 21d holding)
 *
 * Same rigor as backtest_lunar_fib.js: win-rate + two-proportion z-test vs baseline,
 * no lookahead (momentum formation window always ends before the holding period starts).
 *
 * Usage: node backtest_calendar_momentum.js
 */

'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const { twoProportionZTest, mean, stdDev } = require('./modules/statistics');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

function fmtPct(x) { return (x >= 0 ? '+' : '') + x.toFixed(3) + '%'; }

async function main() {
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  const [tickerRows] = await pool.query(
    `SELECT stock_code, COUNT(*) n FROM idx_stock_prices GROUP BY stock_code HAVING n >= 280 ORDER BY stock_code`
  );
  const tickers = tickerRows.map(r => r.stock_code);
  console.log(`Loaded ${tickers.length} tickers with >=280 trading days\n`);

  // ─── Data buckets ────────────────────────────────────────────────────────
  const tomBucket = { turn: [], other: [] };          // turn-of-month daily returns
  const dowBucket = { 0: [], 1: [], 2: [], 3: [], 4: [] }; // Mon=0..Fri=4 daily returns
  const monthBucket = {}; for (let m = 1; m <= 12; m++) monthBucket[m] = [];
  const momentumPairs = []; // { formationRet, holdRet } per ticker per rebalance point

  for (const ticker of tickers) {
    const [rows] = await pool.query(
      `SELECT date, close_price c FROM idx_stock_prices WHERE stock_code = ? ORDER BY date ASC`,
      [ticker]
    );
    const candles = rows.map(r => ({ date: new Date(r.date), close: Number(r.c) }));
    if (candles.length < 280) continue;

    // Daily returns with calendar tags
    // Build per-ticker list of trading-day indices grouped by (year, month) to find turn-of-month bars
    const byYM = new Map();
    for (let i = 0; i < candles.length; i++) {
      const d = candles[i].date;
      const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
      if (!byYM.has(key)) byYM.set(key, []);
      byYM.get(key).push(i);
    }
    const ymKeys = [...byYM.keys()];
    const turnIdx = new Set();
    for (let k = 0; k < ymKeys.length; k++) {
      const idxs = byYM.get(ymKeys[k]);
      // last 2 trading days of this month
      idxs.slice(-2).forEach(i => turnIdx.add(i));
      // first 4 trading days of NEXT month
      const nextIdxs = byYM.get(ymKeys[k + 1]);
      if (nextIdxs) nextIdxs.slice(0, 4).forEach(i => turnIdx.add(i));
    }

    for (let i = 1; i < candles.length; i++) {
      const ret = (candles[i].close / candles[i - 1].close - 1) * 100;
      const d = candles[i].date;
      const dow = d.getUTCDay(); // 0=Sun..6=Sat
      if (dow >= 1 && dow <= 5) dowBucket[dow - 1].push(ret);
      monthBucket[d.getUTCMonth() + 1].push(ret);
      if (turnIdx.has(i)) tomBucket.turn.push(ret); else tomBucket.other.push(ret);
    }

    // Momentum: formation = trailing ~231 trading days ending 21 days before rebalance
    // (approximates "12 month return skipping most recent month"), holding = next 21 trading days.
    // Step every 21 trading days to avoid overlapping-window pseudo-replication inflating n.
    const FORM = 231, SKIP = 21, HOLD = 21;
    for (let i = FORM + SKIP; i + HOLD < candles.length; i += HOLD) {
      const formStart = candles[i - SKIP - FORM].close;
      const formEnd = candles[i - SKIP].close;
      const formationRet = (formEnd / formStart - 1) * 100;
      const holdRet = (candles[i + HOLD].close / candles[i].close - 1) * 100;
      momentumPairs.push({ ticker, date: candles[i].date.toISOString().split('T')[0], formationRet, holdRet });
    }
  }

  // ─── 1. Turn-of-month effect ────────────────────────────────────────────
  console.log('='.repeat(78));
  console.log('1. TURN-OF-MONTH EFFECT (last 2 + first 4 trading days of month)');
  console.log('='.repeat(78));
  {
    const t = tomBucket.turn, o = tomBucket.other;
    const winsT = t.filter(r => r > 0).length, winsO = o.filter(r => r > 0).length;
    console.log(`Turn-window days: n=${t.length}, avgReturn=${fmtPct(mean(t))}, winRate=${(winsT/t.length*100).toFixed(1)}%`);
    console.log(`Other days:       n=${o.length}, avgReturn=${fmtPct(mean(o))}, winRate=${(winsO/o.length*100).toFixed(1)}%`);
    const { z, pValue } = twoProportionZTest(winsT, t.length, winsO, o.length);
    console.log(`z=${z.toFixed(2)} p=${pValue.toFixed(5)} -> ${pValue < 0.05 ? 'SIGNIFICANT (p<0.05)' : 'not significant'}`);
  }

  // ─── 2. Day-of-week effect ──────────────────────────────────────────────
  console.log('\n' + '='.repeat(78));
  console.log('2. DAY-OF-WEEK EFFECT');
  console.log('='.repeat(78));
  const dowNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const allDowReturns = [].concat(...Object.values(dowBucket));
  for (let d = 0; d < 5; d++) {
    const arr = dowBucket[d];
    const wins = arr.filter(r => r > 0).length;
    console.log(`${dowNames[d].padEnd(10)}: n=${arr.length}, avgReturn=${fmtPct(mean(arr))}, winRate=${(wins/arr.length*100).toFixed(1)}%`);
  }
  {
    const mon = dowBucket[0];
    const restDays = [].concat(dowBucket[1], dowBucket[2], dowBucket[3], dowBucket[4]);
    const winsMon = mon.filter(r => r > 0).length, winsRest = restDays.filter(r => r > 0).length;
    const { z, pValue } = twoProportionZTest(winsMon, mon.length, winsRest, restDays.length);
    console.log(`Monday vs rest-of-week: z=${z.toFixed(2)} p=${pValue.toFixed(5)} -> ${pValue < 0.05 ? 'SIGNIFICANT (p<0.05)' : 'not significant'}`);
  }

  // ─── 3. Month-of-year / January effect ──────────────────────────────────
  console.log('\n' + '='.repeat(78));
  console.log('3. MONTH-OF-YEAR SEASONALITY');
  console.log('='.repeat(78));
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  for (let m = 1; m <= 12; m++) {
    const arr = monthBucket[m];
    if (arr.length === 0) { console.log(`${monthNames[m-1]}: n=0`); continue; }
    const wins = arr.filter(r => r > 0).length;
    console.log(`${monthNames[m-1].padEnd(5)}: n=${arr.length}, avgReturn=${fmtPct(mean(arr))}, winRate=${(wins/arr.length*100).toFixed(1)}%`);
  }
  {
    const jan = monthBucket[1];
    const restMonths = [].concat(...[2,3,4,5,6,7,8,9,10,11,12].map(m => monthBucket[m]));
    if (jan.length > 0) {
      const winsJan = jan.filter(r => r > 0).length, winsRest = restMonths.filter(r => r > 0).length;
      const { z, pValue } = twoProportionZTest(winsJan, jan.length, winsRest, restMonths.length);
      console.log(`January vs rest-of-year: z=${z.toFixed(2)} p=${pValue.toFixed(5)} -> ${pValue < 0.05 ? 'SIGNIFICANT (p<0.05)' : 'not significant'}`);
    }
  }

  // ─── 4. Momentum (12-1 formation, 21d holding, quintile spread) ────────
  console.log('\n' + '='.repeat(78));
  console.log('4. MOMENTUM (12mo-1mo formation -> 21-trading-day holding, quintile sort)');
  console.log('='.repeat(78));
  console.log(`Total formation/holding observations: ${momentumPairs.length}`);
  // Group by rebalance date so we rank cross-sectionally (proper momentum methodology,
  // not pooling all tickers' formation returns globally which mixes different time periods)
  const byDate = new Map();
  for (const p of momentumPairs) {
    if (!byDate.has(p.date)) byDate.set(p.date, []);
    byDate.get(p.date).push(p);
  }
  const winnerHold = [], loserHold = [];
  let rebalancesUsed = 0;
  for (const [date, group] of byDate) {
    if (group.length < 10) continue; // need enough stocks to form quintiles meaningfully
    group.sort((a, b) => b.formationRet - a.formationRet);
    const q = Math.floor(group.length / 5);
    winnerHold.push(...group.slice(0, q).map(g => g.holdRet));
    loserHold.push(...group.slice(-q).map(g => g.holdRet));
    rebalancesUsed++;
  }
  console.log(`Rebalance dates used (>=10 stocks): ${rebalancesUsed}`);
  if (winnerHold.length > 0 && loserHold.length > 0) {
    const winsW = winnerHold.filter(r => r > 0).length, winsL = loserHold.filter(r => r > 0).length;
    console.log(`Winners (top quintile formation): n=${winnerHold.length}, avgHoldReturn=${fmtPct(mean(winnerHold))}, winRate=${(winsW/winnerHold.length*100).toFixed(1)}%`);
    console.log(`Losers  (bottom quintile formation): n=${loserHold.length}, avgHoldReturn=${fmtPct(mean(loserHold))}, winRate=${(winsL/loserHold.length*100).toFixed(1)}%`);
    console.log(`Winner-minus-Loser spread: ${fmtPct(mean(winnerHold) - mean(loserHold))}`);
    const { z, pValue } = twoProportionZTest(winsW, winnerHold.length, winsL, loserHold.length);
    console.log(`z=${z.toFixed(2)} p=${pValue.toFixed(5)} -> ${pValue < 0.05 ? 'SIGNIFICANT (p<0.05)' : 'not significant'}`);
  } else {
    console.log('Insufficient data for momentum quintile test.');
  }

  console.log('\n' + '='.repeat(78));
  console.log(`Bonferroni note: 4 independent hypotheses tested above -> corrected alpha = 0.0125`);
  console.log('='.repeat(78));

  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
