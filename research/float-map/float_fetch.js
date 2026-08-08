/**
 * Fetch and store free float for the top-N traded IDX tickers.
 *
 * IDX publishes TradebleShares on its own Stock Summary endpoint, but that is
 * behind Cloudflare and currently refuses even a real browser — the same reason
 * the broker feed has been stale since 2026-07-31. Yahoo carries floatShares
 * and sharesOutstanding for .JK tickers and answers with a cookie+crumb.
 *
 * A VALUE THAT CANNOT BE TRUE IS NOT STORED. Yahoo returns BBNI at 2556% of
 * shares outstanding, which is not a small error — it is a different quantity
 * wearing the right field name. Writing it would silently corrupt every metric
 * downstream, and the Float Map's whole claim is that it does not pretend to
 * know things. So implausible values are rejected, recorded as rejected, and
 * the ticker simply has no float rather than a wrong one.
 *
 * Creates its own table. Additive only: the IDX engine is frozen for its
 * burn-in and nothing it runs reads this.
 */
'use strict';

// Credentials come from the scraper's own .env — never inlined here.
require('/var/www/flowtracker-scraper/node_modules/dotenv').config({ path: '/var/www/flowtracker-scraper/.env' });

const mysql = require('/var/www/flowtracker-scraper/node_modules/mysql2/promise');
const S = require('./schema');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TOP_N = Number(process.argv[2] || 100);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Plausible free float as a share of shares outstanding. Outside this, we do not know. */
const MIN_PCT = 0.5, MAX_PCT = 100;

const DDL = `
CREATE TABLE IF NOT EXISTS idx_free_float (
  stock_code VARCHAR(12) NOT NULL PRIMARY KEY,
  float_shares BIGINT NOT NULL,
  shares_outstanding BIGINT NOT NULL,
  float_pct DECIMAL(8,4) NOT NULL,
  source VARCHAR(24) NOT NULL,
  -- PER-TICKER FRESHNESS. A single MAX(fetched_at) across the table reported
  -- CURRENT when one ticker refreshed and ninety-eight still carried
  -- month-old numbers. A failed refresh must not silently inherit the
  -- credibility of a successful one.
  fetch_status ENUM('VALID','STALE','REJECTED','FETCH_FAILED') NOT NULL DEFAULT 'VALID',
  last_attempt_at TIMESTAMP NULL,
  last_success_at TIMESTAMP NULL,
  last_error VARCHAR(160) NULL,
  fetched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_pct (float_pct)
)`;

const REJECT_DDL = `
CREATE TABLE IF NOT EXISTS idx_free_float_rejected (
  id INT AUTO_INCREMENT PRIMARY KEY,
  stock_code VARCHAR(12) NOT NULL,
  reason VARCHAR(120) NOT NULL,
  raw_float BIGINT NULL,
  raw_shares BIGINT NULL,
  seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_code (stock_code, seen_at)
)`;

async function yahooSession() {
  const jar = [];
  const collect = res => {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    for (const c of raw) jar.push(c.split(';')[0]);
  };
  const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } }).catch(() => null);
  if (r1) collect(r1);
  const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, Cookie: jar.join('; ') },
  });
  collect(r2);
  return { crumb: (await r2.text()).trim(), cookie: jar.join('; ') };
}

async function floatFor(ticker, s) {
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}.JK`
    + `?modules=defaultKeyStatistics&crumb=${encodeURIComponent(s.crumb)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Cookie: s.cookie } });
  if (!r.ok) return { ok: false, why: `HTTP ${r.status}` };
  const d = (await r.json())?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
  if (!d) return { ok: false, why: 'no defaultKeyStatistics' };
  const fl = d.floatShares?.raw ?? null, so = d.sharesOutstanding?.raw ?? null;
  if (!fl || !so) return { ok: false, why: `float=${fl} shares=${so}`, fl, so };
  const pct = (fl / so) * 100;
  if (pct < MIN_PCT || pct > MAX_PCT) {
    return { ok: false, why: `implausible float ${pct.toFixed(1)}% of shares outstanding`, fl, so };
  }
  return { ok: true, fl, so, pct };
}

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'erp_manufacturing',
    waitForConnections: true, connectionLimit: 2,
  });
  await pool.query(DDL);
  await pool.query(REJECT_DDL);

  // R1 CREATED THIS TABLE WITHOUT THE STATUS COLUMNS, and CREATE TABLE IF NOT
  // EXISTS does nothing to a table that is already there — so on the live
  // database the INSERT below would have gone straight to
  // "Unknown column 'fetch_status'". Each ALTER is read back before use.
  const db = process.env.DB_NAME || 'erp_manufacturing';
  const applied = [];
  await S.ensureColumn(pool, db, 'idx_free_float', 'fetch_status',
    "ADD COLUMN fetch_status ENUM('VALID','STALE','REJECTED','FETCH_FAILED') NOT NULL DEFAULT 'VALID' AFTER source", applied);
  await S.ensureColumn(pool, db, 'idx_free_float', 'last_attempt_at',
    'ADD COLUMN last_attempt_at TIMESTAMP NULL AFTER fetch_status', applied);
  await S.ensureColumn(pool, db, 'idx_free_float', 'last_success_at',
    'ADD COLUMN last_success_at TIMESTAMP NULL AFTER last_attempt_at', applied);
  await S.ensureColumn(pool, db, 'idx_free_float', 'last_error',
    'ADD COLUMN last_error VARCHAR(160) NULL AFTER last_success_at', applied);
  // Rows written before the columns existed have no success timestamp; the
  // generator's age check would read them as 999 days old and drop the whole
  // universe, so seed them from the value that did exist.
  await pool.query('UPDATE idx_free_float SET last_success_at = fetched_at, last_attempt_at = fetched_at WHERE last_success_at IS NULL');
  await S.assertColumns(pool, db, 'idx_free_float',
    ['fetch_status', 'last_attempt_at', 'last_success_at', 'last_error']);
  if (applied.length) console.log('migrated: ' + applied.join(', '));

  // TRADED NOTIONAL FROM close_price x volume, NOT idx_stock_prices.value.
  //
  // That column has been 0 for every row since 2026-08-03 (245/245 tickers,
  // five consecutive sessions and counting). `HAVING AVG(value) > 0` only still
  // returned anything because the 20-day window had not yet closed over the
  // outage; around 2026-08-31 it would have selected NOTHING, the universe
  // would have silently collapsed to zero, and the rows already sitting in
  // idx_free_float would have carried on looking perfectly valid.
  //
  // Even before the outage the column was useless here: value/volume came back
  // exactly equal to the close, so it was volume x close all along.
  const [rows] = await pool.query(`
    SELECT stock_code, AVG(close_price * volume) v FROM idx_stock_prices
     WHERE date >= DATE_SUB((SELECT MAX(date) FROM idx_stock_prices), INTERVAL 20 DAY)
       AND volume > 0 AND close_price > 0
     GROUP BY stock_code HAVING v > 0 ORDER BY v DESC LIMIT ?`, [TOP_N]);
  console.log(`top ${rows.length} by 20d turnover`);

  const s = await yahooSession();
  if (!s.crumb || s.crumb.length > 40) { console.error('no Yahoo crumb'); process.exit(1); }

  let stored = 0, rejected = 0;
  for (const r of rows) {
    let res;
    try { res = await floatFor(r.stock_code, s); }
    catch (e) { res = { ok: false, why: e.message }; }

    if (res.ok) {
      await pool.query(
        `INSERT INTO idx_free_float
           (stock_code, float_shares, shares_outstanding, float_pct, source,
            fetch_status, last_attempt_at, last_success_at, last_error)
         VALUES (?,?,?,?, 'YAHOO', 'VALID', NOW(), NOW(), NULL)
         ON DUPLICATE KEY UPDATE float_shares=VALUES(float_shares),
           shares_outstanding=VALUES(shares_outstanding), float_pct=VALUES(float_pct),
           source=VALUES(source), fetch_status='VALID',
           last_attempt_at=NOW(), last_success_at=NOW(), last_error=NULL`,
        [r.stock_code, Math.round(res.fl), Math.round(res.so), res.pct.toFixed(4)]);
      stored++;
    } else {
      // KEEP THE OLD VALUE, MARK IT. Deleting would lose history and leaving it
      // untouched would let a month-old number keep the credibility of a
      // successful fetch. The generator refuses anything not VALID and fresh.
      const [upd] = await pool.query(
        `UPDATE idx_free_float
            SET fetch_status = ?, last_attempt_at = NOW(), last_error = ?
          WHERE stock_code = ?`,
        [/implausible/.test(res.why) ? 'REJECTED' : 'FETCH_FAILED', res.why.slice(0, 160), r.stock_code]);
      if (!upd.affectedRows) {
        // Never seen before and the first attempt failed: record the attempt so
        // its absence from the map is explainable rather than mysterious.
        await pool.query(
          `INSERT INTO idx_free_float
             (stock_code, float_shares, shares_outstanding, float_pct, source,
              fetch_status, last_attempt_at, last_success_at, last_error)
           VALUES (?,0,0,0,'YAHOO',?,NOW(),NULL,?)`,
          [r.stock_code, /implausible/.test(res.why) ? 'REJECTED' : 'FETCH_FAILED', res.why.slice(0, 160)]);
      }
      await pool.query(
        `INSERT INTO idx_free_float_rejected (stock_code, reason, raw_float, raw_shares) VALUES (?,?,?,?)`,
        [r.stock_code, res.why.slice(0, 120), res.fl ? Math.round(res.fl) : null, res.so ? Math.round(res.so) : null]);
      console.log(`  reject ${r.stock_code.padEnd(6)} ${res.why}`);
      rejected++;
    }
    await sleep(320);
  }

  const [[agg]] = await pool.query(
    `SELECT COUNT(*) n, MIN(float_pct) mn, MAX(float_pct) mx, AVG(float_pct) av FROM idx_free_float`);
  console.log(`\nstored ${stored}, rejected ${rejected}`);
  console.log(`table now holds ${agg.n} tickers · float ${Number(agg.mn).toFixed(1)}%–${Number(agg.mx).toFixed(1)}% (mean ${Number(agg.av).toFixed(1)}%)`);
  await pool.end();
})().catch(e => { console.error('FETCH FAILED:', e.message); process.exit(1); });
