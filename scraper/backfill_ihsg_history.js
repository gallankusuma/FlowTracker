/**
 * Backfill script: deep daily history for the IHSG (^JKSE) index into
 * idx_ihsg_history.
 *
 * WHY THIS EXISTS (2026-08-02)
 * ----------------------------
 * idx_ihsg_history is normally maintained by the nightly cron's
 * fetchAndCacheIHSG(), which pulls a rolling `2y` window — plenty for the
 * benchmark comparison and regime detection it was written for. But the
 * cross-sectional backtests (EXP-009/010/011) use this table as the CANONICAL
 * TRADING-DATE AXIS: every ticker's lookback and forward windows are indexed by
 * position on it so a ticker's own data gaps can't shift its windows relative
 * to its peers.
 *
 * That makes the axis a hard ceiling on every such study. After
 * idx_stock_prices was backfilled to 10 years (2026-08-02), EXP-011 still
 * silently ran on 483 dates / 30 weekly ranking points, because the axis was
 * still 2 years long — the stock data was there and simply unreachable. The
 * axis must be at least as deep as the deepest price history.
 *
 * Same daily-cadence guard as backfill_price_history.js: Yahoo downgrades
 * interval=1d to monthly bars for range=max, and month-end dates would insert
 * as ordinary-looking daily rows.
 *
 * Usage: node backfill_ihsg_history.js [--range 10y] [--symbol ^JKSE] [--dry-run]
 */
'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const { fetchYahooCandles } = require('./yahoo-candles');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const DAILY_SAFE_RANGES = ['1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd'];

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { range: '10y', symbol: '^JKSE', dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--range') out.range = args[++i];
    else if (args[i] === '--symbol') out.symbol = args[++i];
    else if (args[i] === '--dry-run') out.dryRun = true;
  }
  if (!DAILY_SAFE_RANGES.includes(out.range)) {
    console.error(`Refusing range="${out.range}" — Yahoo returns non-daily candles outside ${DAILY_SAFE_RANGES.join('/')}.`);
    process.exit(1);
  }
  return out;
}

async function main() {
  const opts = parseArgs();
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 2 });

  const [before] = await pool.query('SELECT COUNT(*) n, MIN(date) lo, MAX(date) hi FROM idx_ihsg_history');
  console.log(`Before: ${before[0].n} bars, ${before[0].lo} .. ${before[0].hi}`);

  const { candles } = await fetchYahooCandles(opts.symbol, opts.range);
  if (!candles.length) { console.error('Yahoo returned no candles'); process.exit(1); }

  const first = candles[0], last = candles[candles.length - 1];
  const years = (new Date(last.date) - new Date(first.date)) / (365.25 * 24 * 3600 * 1000);
  const barsPerYear = candles.length / Math.max(years, 1e-9);
  console.log(`Fetched: ${candles.length} bars, ${first.date} .. ${last.date} (${barsPerYear.toFixed(0)} bars/year)`);
  if (years > 0.5 && barsPerYear < 60) {
    console.error(`Refusing to write: ${barsPerYear.toFixed(0)} bars/year is not a daily series.`);
    process.exit(1);
  }

  if (opts.dryRun) { console.log('(dry run — not writing)'); await pool.end(); return; }

  const values = candles.map((c, i) => {
    const prevClose = i > 0 ? candles[i - 1].close : c.close;
    const changePct = prevClose > 0 ? ((c.close - prevClose) / prevClose) * 100 : 0;
    return [c.date, c.open, c.high, c.low, c.close, c.volume, Math.round(changePct * 10000) / 10000];
  });

  const [res] = await pool.query(
    `INSERT INTO idx_ihsg_history (date, open_price, high_price, low_price, close_price, volume, change_pct)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       open_price=VALUES(open_price), high_price=VALUES(high_price), low_price=VALUES(low_price),
       close_price=VALUES(close_price), volume=VALUES(volume), change_pct=VALUES(change_pct)`,
    [values]
  );

  const [after] = await pool.query('SELECT COUNT(*) n, MIN(date) lo, MAX(date) hi FROM idx_ihsg_history');
  console.log(`After:  ${after[0].n} bars, ${after[0].lo} .. ${after[0].hi} (affectedRows=${res.affectedRows})`);
  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
