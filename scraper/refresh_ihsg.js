/**
 * Refresh idx_ihsg_history on a schedule, independently of the web server.
 *
 * Before this existed the index series updated only when someone opened a page
 * that happened to call fetchAndCacheIHSG(). None of the 18 cron entries hits an
 * HTTP endpoint, so "is the regime filter looking at current data" depended on
 * whether a human had visited the dashboard. It was found two trading days stale
 * while idx_stock_prices was current.
 *
 * A SEPARATE PROCESS ON PURPOSE. The nightly job inside server.js could carry
 * this, and it would work right up until the PM2 process is unhealthy — which is
 * precisely when a stale regime filter is most dangerous. A standalone script
 * fails visibly and on its own, and can be re-run by hand.
 *
 * Usage:
 *   node refresh_ihsg.js            # skip if already current through the last close
 *   node refresh_ihsg.js --force    # refetch regardless
 */
'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const { fetchYahooCandles } = require('./yahoo-candles');
const { refreshIHSG, toDateStr } = require('./modules/ihsg');

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'erp_user',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'erp_manufacturing',
    waitForConnections: true, connectionLimit: 3,
  });
  try {
    const r = await refreshIHSG(pool, fetchYahooCandles, { force: process.argv.includes('--force') });
    if (r.skipped) {
      console.log(`IHSG  skipped — ${r.reason}   latest ${r.latest}`);
    } else {
      const moved = r.previousLatest !== r.latest ? `${r.previousLatest} -> ${r.latest}` : `${r.latest} (unchanged)`;
      console.log(`IHSG  ${r.candles} candle(s) written, ${r.dropped} dropped as an unclosed session   ${moved}`);
    }
    // Say plainly when the series is behind the price data, rather than leaving
    // it to be noticed later. This is the condition that went unseen before.
    const [[px]] = await pool.query('SELECT MAX(date) d FROM idx_stock_prices');
    const priceLatest = toDateStr(px?.d);
    if (priceLatest && r.latest && r.latest < priceLatest) {
      console.log(`      ** still behind idx_stock_prices (${r.latest} vs ${priceLatest}) — the regime filter is reading stale data`);
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(`IHSG  FAILED: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
