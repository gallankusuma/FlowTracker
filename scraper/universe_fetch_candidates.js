/**
 * Stage daily OHLCV for CANDIDATE IDX tickers — the ones we do NOT currently
 * track — so their liquidity can be measured before any of them is promoted
 * into the daily Index Alpha pull.
 *
 * WHY A SEPARATE TABLE
 * --------------------
 * These are candidates, not universe members. Writing them straight into
 * idx_stock_prices would make ~620 untracked codes indistinguishable from the
 * tracked ones for every downstream query that enumerates that table, and
 * un-picking that later means guessing which rows were staged. So they land in
 * idx_price_candidates, which can be dropped wholesale with no side effects.
 *
 * Fetch path is deliberately the same one backfill_price_history.js uses
 * (yahoo-candles.fetchYahooCandles) — free, no Index Alpha quota, one call
 * pulls the whole range. Fetching prices costs nothing against the daily
 * budget; only promotion into modules/tickers.js does.
 *
 * Usage: node universe_fetch_candidates.js [--range 10y] [--limit N] [--resume]
 */

'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const { fetchYahooCandles } = require('./yahoo-candles');
const { IDX_TICKERS } = require('./modules/tickers');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

// Same guard as backfill_price_history.js: Yahoo silently downgrades interval=1d
// to monthly bars outside these ranges, which would look like ordinary daily
// rows and corrupt every liquidity number computed from them.
const DAILY_SAFE_RANGES = ['1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd'];

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { range: '10y', limit: 0, resume: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--range') out.range = args[++i];
    else if (args[i] === '--limit') out.limit = parseInt(args[++i], 10);
    else if (args[i] === '--resume') out.resume = true;
  }
  if (!DAILY_SAFE_RANGES.includes(out.range)) {
    console.error(`Refusing range="${out.range}" — not a verified daily-bar range (${DAILY_SAFE_RANGES.join('/')}).`);
    process.exit(1);
  }
  return out;
}

/** Genuine daily IDX data averages ~245 bars/year; monthly ~12. Same test as the backfill. */
function looksDaily(candles) {
  if (candles.length < 2) return true;
  const first = new Date(candles[0].date);
  const last = new Date(candles[candles.length - 1].date);
  const years = (last - first) / (365.25 * 24 * 3600 * 1000);
  if (years < 0.5) return true;
  return candles.length / years >= 60;
}

async function ensureTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS idx_price_candidates (
      stock_code  VARCHAR(10) NOT NULL,
      date        DATE        NOT NULL,
      close_price DECIMAL(15,2) NULL,
      high_price  DECIMAL(15,2) NULL,
      volume      BIGINT      NULL,
      value       BIGINT      NULL,
      PRIMARY KEY (stock_code, date),
      KEY idx_cand_date (date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // Fetch outcomes are data too: "Yahoo has no symbol for this code" is itself a
  // finding (delisted / renamed), and must not be silently indistinguishable
  // from "we forgot to fetch it".
  await pool.query(`
    CREATE TABLE IF NOT EXISTS idx_price_candidate_fetch_log (
      stock_code VARCHAR(10) NOT NULL PRIMARY KEY,
      status     VARCHAR(24) NOT NULL,
      bars       INT         NOT NULL DEFAULT 0,
      first_date DATE        NULL,
      last_date  DATE        NULL,
      note       VARCHAR(255) NULL,
      fetched_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

async function logFetch(pool, code, status, bars, d0, d1, note) {
  await pool.query(
    `INSERT INTO idx_price_candidate_fetch_log (stock_code, status, bars, first_date, last_date, note)
     VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE status=VALUES(status), bars=VALUES(bars),
       first_date=VALUES(first_date), last_date=VALUES(last_date), note=VALUES(note)`,
    [code, status, bars, d0 || null, d1 || null, (note || '').slice(0, 255)]
  );
}

async function saveCandles(pool, code, candles) {
  if (!candles.length) return 0;
  const values = candles.map(c => [
    code, c.date, c.close, c.high, c.volume, c.close * c.volume,
  ]);
  const [result] = await pool.query(
    `INSERT INTO idx_price_candidates (stock_code, date, close_price, high_price, volume, value)
     VALUES ?
     ON DUPLICATE KEY UPDATE close_price=VALUES(close_price), high_price=VALUES(high_price),
       volume=VALUES(volume), value=VALUES(value)`,
    [values]
  );
  return result.affectedRows;
}

async function main() {
  const opts = parseArgs();
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });
  await ensureTables(pool);

  // Candidate roster = every IDX code the dead FT.id scrape left behind in
  // idx_concentration, minus the ones we already track. The concentration rows
  // themselves are far too thin to use as data (~15 days for most of them), but
  // the CODE LIST is a valid roster of real IDX tickers.
  const [roster] = await pool.query('SELECT DISTINCT stock_code FROM idx_concentration ORDER BY stock_code');
  const tracked = new Set(IDX_TICKERS);
  let candidates = roster.map(r => r.stock_code).filter(c => !tracked.has(c));

  if (opts.resume) {
    const [done] = await pool.query('SELECT stock_code FROM idx_price_candidate_fetch_log');
    const doneSet = new Set(done.map(r => r.stock_code));
    candidates = candidates.filter(c => !doneSet.has(c));
  }
  if (opts.limit > 0) candidates = candidates.slice(0, opts.limit);

  console.log(`Staging ${candidates.length} candidate tickers x range=${opts.range} (Yahoo, 1 free call each)`);

  let ok = 0, empty = 0, errors = 0, savedRows = 0;
  const startTime = Date.now();

  for (let i = 0; i < candidates.length; i++) {
    const code = candidates[i];
    try {
      const { candles } = await fetchYahooCandles(code, opts.range);
      if (!candles.length) {
        empty++;
        await logFetch(pool, code, 'NO_DATA', 0, null, null, 'Yahoo returned no candles');
      } else if (!looksDaily(candles)) {
        errors++;
        await logFetch(pool, code, 'NON_DAILY', candles.length, candles[0].date,
          candles[candles.length - 1].date, 'non-daily cadence; refused');
      } else {
        savedRows += await saveCandles(pool, code, candles);
        ok++;
        await logFetch(pool, code, 'OK', candles.length, candles[0].date, candles[candles.length - 1].date, null);
      }
    } catch (e) {
      errors++;
      await logFetch(pool, code, 'ERROR', 0, null, null, e.message);
    }
    if ((i + 1) % 25 === 0 || i === candidates.length - 1) {
      const el = Math.round((Date.now() - startTime) / 1000);
      console.log(`[${i + 1}/${candidates.length}] ok=${ok} empty=${empty} err=${errors} rows=${savedRows} ${el}s`);
    }
    await delay(300); // polite — same pacing as backfill_price_history.js
  }

  console.log(`\nStaging complete: ok=${ok} no-data=${empty} errors=${errors} rows=${savedRows}`);
  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
