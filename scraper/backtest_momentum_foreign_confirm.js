/**
 * Backtest: the user's own manual Flow Analyzer workflow —
 *   1. Screen for stocks green (close > prior close) for the last 2 trading days
 *   2. Open the detail view, check whether FOREIGN investors are net buyers
 *      during that same window
 *   3. Foreign confirmation = higher-conviction signal
 *
 * This is exactly the mechanism behind the already-researched OJK finding
 * (foreign investors trade WITH momentum / are more informed, domestic retail
 * trades anti-momentum / FOMO-driven) — see project_foreign_domestic_factor
 * memory. This backtest tests the user's own rule directly, not an abstraction
 * of it.
 *
 * Data: idx_broker_flow_detail (real investor-type, 2026-01-19 to 2026-07-20,
 * ~6 months, 145 tickers) joined with idx_stock_prices.
 *
 * Buckets:
 *   BOTH      = 2-day green AND cumulative foreign net (T-1,T) > 0
 *   MOM_ONLY  = 2-day green AND foreign net <= 0 (momentum without foreign confirm)
 *   NEITHER   = not 2-day green (baseline / no signal)
 *
 * Usage: node backtest_momentum_foreign_confirm.js
 */

'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const { twoProportionZTest, mean } = require('./modules/statistics');

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
    `SELECT DISTINCT stock_code FROM idx_broker_flow_detail ORDER BY stock_code`
  );
  const tickers = tickerRows.map(r => r.stock_code);
  console.log(`Tickers with foreign/domestic flow detail: ${tickers.length}`);

  // Foreign net value per (stock, date), combining RG+NG
  const [flowRows] = await pool.query(
    `SELECT date, stock_code, SUM(buy_val) - SUM(sell_val) net_foreign
     FROM idx_broker_flow_detail WHERE investor_type = 'foreign'
     GROUP BY date, stock_code`
  );
  const foreignMap = new Map(); // "date|stock" -> net_foreign
  for (const r of flowRows) {
    foreignMap.set(`${r.date.toISOString().split('T')[0]}|${r.stock_code}`, Number(r.net_foreign));
  }
  console.log(`Foreign net-flow data points: ${flowRows.length}\n`);

  const buckets = { BOTH: { 3: [], 5: [], 10: [] }, MOM_ONLY: { 3: [], 5: [], 10: [] }, NEITHER: { 3: [], 5: [], 10: [] } };
  let momentumEvents = 0, foreignConfirmedEvents = 0;

  for (const ticker of tickers) {
    const [prows] = await pool.query(
      `SELECT date, close_price c FROM idx_stock_prices WHERE stock_code = ? AND date >= '2026-01-01' ORDER BY date ASC`,
      [ticker]
    );
    const candles = prows.map(r => ({ date: r.date.toISOString().split('T')[0], close: Number(r.c) }));
    if (candles.length < 15) continue;

    for (let i = 2; i < candles.length - 10; i++) {
      const green2 = candles[i].close > candles[i - 1].close && candles[i - 1].close > candles[i - 2].close;

      let bucketKey = 'NEITHER';
      if (green2) {
        momentumEvents++;
        const netT = foreignMap.get(`${candles[i].date}|${ticker}`) || 0;
        const netT1 = foreignMap.get(`${candles[i - 1].date}|${ticker}`) || 0;
        const foreignConfirm = (netT + netT1) > 0;
        if (foreignConfirm) { foreignConfirmedEvents++; bucketKey = 'BOTH'; }
        else bucketKey = 'MOM_ONLY';
      }

      for (const h of [3, 5, 10]) {
        const fut = candles[i + h];
        if (!fut) continue;
        buckets[bucketKey][h].push((fut.close / candles[i].close - 1) * 100);
      }
    }
  }

  console.log(`2-day-green momentum events: ${momentumEvents}, of which foreign-confirmed: ${foreignConfirmedEvents} (${(foreignConfirmedEvents/momentumEvents*100).toFixed(1)}%)\n`);

  console.log('='.repeat(90));
  console.log('BUCKET RESULTS (forward return by horizon)');
  console.log('='.repeat(90));
  for (const key of ['BOTH', 'MOM_ONLY', 'NEITHER']) {
    console.log(`\n[${key}]`);
    for (const h of [3, 5, 10]) {
      const arr = buckets[key][h];
      if (arr.length === 0) { console.log(`  +${h}d: n=0`); continue; }
      const wins = arr.filter(r => r > 0).length;
      console.log(`  +${h}d: n=${arr.length}, avgReturn=${fmtPct(mean(arr))}, winRate=${(wins/arr.length*100).toFixed(1)}%`);
    }
  }

  console.log('\n' + '='.repeat(90));
  console.log('SIGNIFICANCE: BOTH (momentum+foreign) vs MOM_ONLY (momentum, no foreign confirm)');
  console.log('='.repeat(90));
  for (const h of [3, 5, 10]) {
    const both = buckets.BOTH[h], momOnly = buckets.MOM_ONLY[h];
    const winsB = both.filter(r => r > 0).length, winsM = momOnly.filter(r => r > 0).length;
    const { z, pValue } = twoProportionZTest(winsB, both.length, winsM, momOnly.length);
    console.log(`+${h}d: BOTH winRate=${(winsB/both.length*100).toFixed(1)}% (n=${both.length}) vs MOM_ONLY=${(winsM/momOnly.length*100).toFixed(1)}% (n=${momOnly.length}) | z=${z.toFixed(2)} p=${pValue.toFixed(5)} -> ${pValue < 0.05 ? 'SIGNIFICANT' : 'not significant'}`);
  }

  console.log('\n' + '='.repeat(90));
  console.log('SIGNIFICANCE: BOTH (momentum+foreign) vs NEITHER (no signal, baseline)');
  console.log('='.repeat(90));
  for (const h of [3, 5, 10]) {
    const both = buckets.BOTH[h], neither = buckets.NEITHER[h];
    const winsB = both.filter(r => r > 0).length, winsN = neither.filter(r => r > 0).length;
    const { z, pValue } = twoProportionZTest(winsB, both.length, winsN, neither.length);
    console.log(`+${h}d: BOTH winRate=${(winsB/both.length*100).toFixed(1)}% (n=${both.length}) vs NEITHER=${(winsN/neither.length*100).toFixed(1)}% (n=${neither.length}) | z=${z.toFixed(2)} p=${pValue.toFixed(5)} -> ${pValue < 0.05 ? 'SIGNIFICANT' : 'not significant'}`);
  }

  console.log('\nBonferroni note: 6 comparisons above (3 horizons x 2 baselines) -> corrected alpha ~= 0.0083');

  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
