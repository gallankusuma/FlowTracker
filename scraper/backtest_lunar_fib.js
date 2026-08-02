/**
 * Backtest: does "Lunar x Fib Confluence" (the Antigravity Chart flag in Flow Analyzer)
 * actually predict forward returns, or is it a coincidence-flagging gimmick?
 *
 * Methodology (mirrors the AWO factor-validity gate — see awo_optimizer.js):
 *   - Recompute the SAME logic the frontend uses (60-bar rolling Auto-Fib, 2.2% tolerance,
 *     new/full moon dates from modules/astro.js) at every historical bar, using only data
 *     available up to that bar (no lookahead).
 *   - Bucket every trading day into: BOTH (confluence), FIB_ONLY, LUNAR_ONLY, NEITHER.
 *   - Measure forward return at +3d/+5d/+10d for each bucket.
 *   - Two-proportion z-test: is BOTH's "positive forward return" rate significantly
 *     different from NEITHER's (the no-signal baseline)? Same test used to validate
 *     AWO's 14 factors — same bar for evidence.
 *
 * Usage: node backtest_lunar_fib.js [--tickers BBCA,BBRI] [--tol 0.022] [--lookback 60]
 */

'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const { autoFibonacci } = require('./modules/fibonacci');
const { getLunarEvents } = require('./modules/astro');
const { twoProportionZTest } = require('./modules/statistics');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { tickers: null, tol: 0.022, lookback: 60 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tickers') out.tickers = args[++i].split(',').map(s => s.trim());
    else if (args[i] === '--tol') out.tol = parseFloat(args[++i]);
    else if (args[i] === '--lookback') out.lookback = parseInt(args[++i], 10);
  }
  return out;
}

const HORIZONS = [3, 5, 10];

function bucketStats() {
  const s = {};
  for (const h of HORIZONS) s[h] = { n: 0, wins: 0, sumRet: 0 };
  return s;
}

async function main() {
  const opts = parseArgs();
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  const [tickerRows] = await pool.query(
    `SELECT stock_code, COUNT(*) n FROM idx_stock_prices GROUP BY stock_code HAVING n >= 120 ORDER BY stock_code`
  );
  const tickers = opts.tickers || tickerRows.map(r => r.stock_code);
  console.log(`Backtesting ${tickers.length} tickers | tol=${opts.tol} lookback=${opts.lookback}`);

  const buckets = { BOTH: bucketStats(), FIB_ONLY: bucketStats(), LUNAR_ONLY: bucketStats(), NEITHER: bucketStats() };
  // Directional check: for confluence events, does price move AWAY from the touched
  // level in the direction a mean-reversion trader would expect (bounce off support/resistance)?
  let confluenceEvents = [];

  let tickersDone = 0, tickersSkipped = 0;

  for (const ticker of tickers) {
    const [rows] = await pool.query(
      `SELECT date, open_price o, high_price h, low_price l, close_price c
       FROM idx_stock_prices WHERE stock_code = ? ORDER BY date ASC`,
      [ticker]
    );
    if (rows.length < opts.lookback + HORIZONS[HORIZONS.length - 1] + 5) { tickersSkipped++; continue; }

    const candles = rows.map(r => ({
      date: r.date.toISOString().split('T')[0],
      time: new Date(r.date).getTime(),
      open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c),
    }));

    const fromDate = new Date(candles[0].date);
    const toDate = new Date(candles[candles.length - 1].date);
    const lunarEvents = getLunarEvents(fromDate, toDate);
    const lunarDateSet = new Map(); // dateStr -> event
    for (const ev of lunarEvents) lunarDateSet.set(ev.dateStr, ev);

    const maxH = HORIZONS[HORIZONS.length - 1];

    for (let i = opts.lookback; i < candles.length - maxH; i++) {
      const windowBars = candles.slice(0, i + 1); // no lookahead: only up to and including today
      const fib = autoFibonacci(windowBars, opts.lookback);
      if (!fib) continue;

      const today = candles[i];
      let nearFib = false, touchedLevel = null;
      for (const lv of fib.levels) {
        if (!lv.price) continue;
        const pct = Math.abs(today.close - lv.price) / lv.price;
        if (pct <= opts.tol) { nearFib = true; touchedLevel = lv; break; }
      }
      const lunarEv = lunarDateSet.get(today.date) || null;
      // allow ±1 calendar day match for lunar (exact-phase day might be a non-trading day)
      let lunarNear = !!lunarEv;
      if (!lunarNear) {
        const d = new Date(today.date);
        const dm1 = new Date(d); dm1.setUTCDate(d.getUTCDate() - 1);
        const dp1 = new Date(d); dp1.setUTCDate(d.getUTCDate() + 1);
        const km1 = dm1.toISOString().split('T')[0], kp1 = dp1.toISOString().split('T')[0];
        if (lunarDateSet.has(km1)) lunarNear = true;
        else if (lunarDateSet.has(kp1)) lunarNear = true;
      }

      const bucketKey = nearFib && lunarNear ? 'BOTH' : nearFib ? 'FIB_ONLY' : lunarNear ? 'LUNAR_ONLY' : 'NEITHER';
      const b = buckets[bucketKey];

      for (const h of HORIZONS) {
        const future = candles[i + h];
        if (!future) continue;
        const ret = (future.close / today.close - 1) * 100;
        b[h].n++;
        b[h].sumRet += ret;
        if (ret > 0) b[h].wins++;
      }

      if (bucketKey === 'BOTH') {
        const future5 = candles[i + 5];
        confluenceEvents.push({
          ticker, date: today.date, level: touchedLevel?.label, direction: fib.direction,
          ret5: future5 ? (future5.close / today.close - 1) * 100 : null,
        });
      }
    }
    tickersDone++;
  }

  console.log(`\nTickers used: ${tickersDone}, skipped (insufficient history): ${tickersSkipped}\n`);
  console.log('='.repeat(78));
  console.log('BUCKET RESULTS (forward return by horizon)');
  console.log('='.repeat(78));

  for (const key of ['BOTH', 'FIB_ONLY', 'LUNAR_ONLY', 'NEITHER']) {
    console.log(`\n[${key}]`);
    for (const h of HORIZONS) {
      const b = buckets[key][h];
      if (b.n === 0) { console.log(`  +${h}d: n=0`); continue; }
      const winRate = (b.wins / b.n * 100).toFixed(1);
      const avgRet = (b.sumRet / b.n).toFixed(3);
      console.log(`  +${h}d: n=${b.n}, winRate=${winRate}%, avgReturn=${avgRet}%`);
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log('SIGNIFICANCE TEST: BOTH (confluence) vs NEITHER (baseline), one-tailed');
  console.log('='.repeat(78));
  for (const h of HORIZONS) {
    const both = buckets.BOTH[h], neither = buckets.NEITHER[h];
    if (both.n === 0 || neither.n === 0) { console.log(`+${h}d: insufficient data`); continue; }
    const { z, pValue } = twoProportionZTest(both.wins, both.n, neither.wins, neither.n);
    const sig = pValue < 0.05 ? 'SIGNIFICANT (p<0.05)' : 'not significant';
    console.log(`+${h}d: confluence winRate=${(both.wins/both.n*100).toFixed(1)}% (n=${both.n}) vs baseline=${(neither.wins/neither.n*100).toFixed(1)}% (n=${neither.n}) | z=${z.toFixed(2)} p=${pValue.toFixed(4)} -> ${sig}`);
  }

  console.log('\n' + '='.repeat(78));
  console.log(`Total confluence events found: ${confluenceEvents.length}`);
  console.log('='.repeat(78));

  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
