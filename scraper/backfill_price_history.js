/**
 * Backfill script: deep daily OHLCV history from Yahoo Finance into idx_stock_prices.
 *
 * Free, unlimited (no API quota like Index Alpha) — one call per ticker pulls the
 * whole requested range in a single response. Needed so weekly/monthly-timeframe
 * indicators (e.g. top-down trend alignment) have enough underlying daily history
 * to aggregate from (weekly EMA21 needs ~21 weeks / ~5 months minimum).
 *
 * Usage: node backfill_price_history.js [--range 2y] [--tickers BBCA,BBRI] [--dry-run]
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

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Yahoo silently downgrades the candle interval for very long ranges: interval=1d
// with range=max returns MONTHLY bars (verified 2026-08-02: BBCA max = 265 bars
// spanning 2004-2026, dated to month-ends). Those month-end dates are real trading
// days, so they would INSERT into this daily table looking like ordinary daily rows
// and silently corrupt every indicator computed downstream. 10y is the deepest range
// Yahoo still serves as genuine daily bars (BBCA 10y = 2465 daily bars).
const DAILY_SAFE_RANGES = ['1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd'];

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { range: '2y', tickers: null, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--range') out.range = args[++i];
    else if (args[i] === '--tickers') out.tickers = args[++i].split(',').map(s => s.trim());
    else if (args[i] === '--dry-run') out.dryRun = true;
  }
  if (!DAILY_SAFE_RANGES.includes(out.range)) {
    console.error(
      `Refusing range="${out.range}" — not a verified daily-bar range.\n` +
      `Yahoo returns non-daily candles outside ${DAILY_SAFE_RANGES.join('/')}, which would ` +
      `corrupt idx_stock_prices. Use --range 10y for maximum daily depth.`
    );
    process.exit(1);
  }
  return out;
}

/**
 * Guard against the same downgrade happening silently within an allowed range:
 * genuine daily IDX data averages ~245 bars/year, monthly data ~12. Anything
 * below ~60 bars/year for a ticker whose history actually spans the range is a
 * downgraded series and must not be written.
 */
function looksDaily(candles) {
  if (candles.length < 2) return true; // nothing to judge; saveCandles no-ops anyway
  const first = new Date(candles[0].date);
  const last = new Date(candles[candles.length - 1].date);
  const years = (last - first) / (365.25 * 24 * 3600 * 1000);
  if (years < 0.5) return true; // young listing — too short to infer cadence
  return candles.length / years >= 60;
}

async function saveCandles(pool, ticker, candles) {
  if (!candles.length) return 0;
  const values = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prev = i > 0 ? candles[i - 1] : null;
    const prevClose = prev ? prev.close : c.close;
    const changePct = prevClose > 0 ? ((c.close - prevClose) / prevClose) * 100 : 0;
    values.push([
      c.date, ticker, c.open, c.high, c.low, c.close, c.volume,
      c.close * c.volume, // value (approx notional turnover)
      prevClose, Math.round(changePct * 10000) / 10000,
    ]);
  }
  const [result] = await pool.query(
    `INSERT INTO idx_stock_prices
       (date, stock_code, open_price, high_price, low_price, close_price, volume, value, prev_close, change_pct)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       open_price=VALUES(open_price), high_price=VALUES(high_price), low_price=VALUES(low_price),
       close_price=VALUES(close_price), volume=VALUES(volume), value=VALUES(value),
       prev_close=VALUES(prev_close), change_pct=VALUES(change_pct)`,
    [values]
  );
  return result.affectedRows;
}

async function main() {
  const opts = parseArgs();
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  const [tickerRows] = await pool.query('SELECT DISTINCT stock_code FROM idx_broker_summary ORDER BY stock_code');
  const tickers = opts.tickers || tickerRows.map(r => r.stock_code);

  console.log(`Backfill plan: ${tickers.length} tickers x range=${opts.range} (1 API call each, free/no quota)`);
  if (opts.dryRun) { console.log('(dry run — not fetching)'); await pool.end(); return; }

  let saved = 0, errors = 0, done = 0;
  const startTime = Date.now();

  for (const ticker of tickers) {
    try {
      const { candles } = await fetchYahooCandles(ticker, opts.range);
      if (!looksDaily(candles)) {
        errors++;
        console.log(`  ${ticker}: SKIPPED — Yahoo returned non-daily cadence (${candles.length} bars over ${candles[0].date}..${candles[candles.length - 1].date}); refusing to write`);
        await delay(300);
        continue;
      }
      const n = await saveCandles(pool, ticker, candles);
      saved += n;
      done++;
      if (done % 20 === 0 || done === tickers.length) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`[${done}/${tickers.length}] ${ticker}: ${candles.length} candles, ${n} rows saved — total saved=${saved} errors=${errors} elapsed=${elapsed}s`);
      }
    } catch (e) {
      errors++;
      console.log(`  ${ticker}: ERROR ${e.message}`);
    }
    await delay(300); // polite delay — avoid tripping Yahoo's informal rate limits
  }

  console.log(`\nBackfill complete: ${tickers.length} tickers processed, ${saved} rows saved, ${errors} errors`);
  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
