/**
 * Remove dates from idx_stock_prices that were never trading sessions.
 *
 * WHAT THESE ARE. Found 2026-08-04 by watchdog.js: 72 dates carrying weekend
 * bars, IDX public-holiday placeholders (open=high=low=close, zero volume), and
 * carried-forward duplicates of the previous date. `modules/system_health.js`
 * -> `phantomSessions()` is the single definition; this script does not carry
 * its own copy of the rule, so the thing that detects and the thing that deletes
 * can never disagree about what counts as phantom.
 *
 * WHY DELETING MATTERS AND IS NOT COSMETIC. Every rolling window in this system
 * counts BARS, not calendar days: ADV20, ATR14, the 252-day high behind the
 * HI52W ranking, the 200-day SMA behind the regime gate. A phantom bar shifts
 * all of them, and the return measured across one is 0% by construction.
 *
 * THIS CHANGES HISTORY. Every backtest number in the experiment registry was
 * computed over a series containing these bars and will not reproduce exactly
 * afterwards. verify_strategy_book.js's golden fixture WILL fail, which is the
 * fixture doing its job — regenerate it deliberately and the diff is the record
 * of how much the phantoms were distorting the strategy.
 *
 * NOTHING IS DELETED WITHOUT A BACKUP. Every affected row is written to
 * /root/backups/ as replayable INSERT statements first, and the file is verified
 * to contain the expected row count before a single DELETE runs.
 *
 * Usage:
 *   node purge_phantom_sessions.js              plan only, changes nothing
 *   node purge_phantom_sessions.js --confirm    back up, then delete
 */
'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const sh = require('./modules/system_health');

const CONFIRM = process.argv.includes('--confirm');
const BACKUP_DIR = process.env.FT_BACKUP_DIR || '/root/backups';

const sqlStr = v => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'erp_user',
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'erp_manufacturing',
    waitForConnections: true, connectionLimit: 4,
  });

  try {
    const phantom = await sh.phantomSessions(pool);
    if (!phantom.length) { console.log('No phantom dates. Nothing to do.'); return; }

    const dates = phantom.map(p => p.date);
    const totalRows = phantom.reduce((a, p) => a + p.rows, 0);

    const bySig = {};
    for (const p of phantom) {
      const k = p.signatures.join('+');
      (bySig[k] ||= { dates: 0, rows: 0 });
      bySig[k].dates++; bySig[k].rows += p.rows;
    }

    console.log('='.repeat(70));
    console.log(`PHANTOM SESSIONS  ${phantom.length} dates, ${totalRows} rows`);
    console.log('='.repeat(70));
    for (const [sig, v] of Object.entries(bySig)) {
      console.log(`  ${sig.padEnd(38)} ${String(v.dates).padStart(3)} dates  ${String(v.rows).padStart(6)} rows`);
    }
    console.log(`  range ${dates[0]} .. ${dates[dates.length - 1]}`);

    // Everything else that keys off a date, so the caller knows what is NOT
    // being touched. Deleting prices while broker rows keep the same date would
    // leave a join that silently returns nothing.
    for (const [label, table, col] of [
      ['idx_broker_summary', 'idx_broker_summary', 'date'],
      ['idx_concentration', 'idx_concentration', 'data_date'],
      ['idx_ihsg_history', 'idx_ihsg_history', 'date'],
    ]) {
      try {
        const [[r]] = await pool.query(
          `SELECT COUNT(*) n, COUNT(DISTINCT ${col}) d FROM ${table} WHERE ${col} IN (?)`, [dates]);
        console.log(`  also present in ${label.padEnd(20)} ${r.n} row(s) across ${r.d} of these dates  (NOT deleted)`);
      } catch (e) { console.log(`  ${label}: could not check (${e.message})`); }
    }

    if (!CONFIRM) {
      console.log('\nPLAN ONLY — nothing was changed. Re-run with --confirm to back up and delete.');
      return;
    }

    // ── backup ───────────────────────────────────────────────────────────
    const stamp = (await pool.query('SELECT DATE_FORMAT(NOW(), "%Y-%m-%d-%H%i") s'))[0][0].s;
    const file = path.join(BACKUP_DIR, `phantom-prices-${stamp}.sql`);
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const [rows] = await pool.query(
      `SELECT * FROM idx_stock_prices WHERE date IN (?) ORDER BY date, stock_code`, [dates]);
    if (rows.length !== totalRows) {
      throw new Error(`backup read ${rows.length} rows but the scan counted ${totalRows} — refusing to delete`);
    }
    const cols = Object.keys(rows[0]);
    const out = [
      `-- idx_stock_prices rows for ${phantom.length} phantom dates, taken before deletion`,
      `-- ${phantom.map(p => `${p.date}[${p.signatures.join('+')}]`).join(', ')}`,
      '',
    ];
    for (const r of rows) {
      out.push(`INSERT INTO idx_stock_prices (${cols.join(', ')}) VALUES (${
        cols.map(c => (r[c] instanceof Date
          ? sqlStr(`${r[c].getFullYear()}-${String(r[c].getMonth() + 1).padStart(2, '0')}-${String(r[c].getDate()).padStart(2, '0')}`)
          : typeof r[c] === 'number' ? r[c] : sqlStr(r[c]))).join(', ')});`);
    }
    fs.writeFileSync(file, out.join('\n') + '\n');

    // Verify the file before touching anything. A backup nobody checked is a
    // backup nobody has.
    const written = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.startsWith('INSERT')).length;
    if (written !== rows.length) {
      throw new Error(`backup file holds ${written} INSERTs for ${rows.length} rows — refusing to delete`);
    }
    console.log(`\nBACKUP  ${file}`);
    console.log(`        ${written} INSERT statements, ${(fs.statSync(file).size / 1024).toFixed(0)} KB, verified`);

    // ── delete ───────────────────────────────────────────────────────────
    const conn = await pool.getConnection();
    let deleted = 0;
    try {
      await conn.beginTransaction();
      const [res] = await conn.query('DELETE FROM idx_stock_prices WHERE date IN (?)', [dates]);
      deleted = res.affectedRows;
      if (deleted !== totalRows) {
        throw new Error(`DELETE removed ${deleted} rows, expected ${totalRows} — rolled back`);
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally { conn.release(); }

    console.log(`DELETED ${deleted} rows across ${phantom.length} dates`);

    const after = await sh.phantomSessions(pool);
    console.log(`VERIFY  ${after.length} phantom date(s) remain${after.length ? ': ' + after.map(p => p.date).join(', ') : ''}`);
    console.log('\nEvery backtest number computed before this was measured over a series');
    console.log('containing these bars and will not reproduce exactly. Re-run');
    console.log('verify_strategy_book.js — its golden fixture SHOULD fail, and the diff');
    console.log('is the record of how much the phantoms were moving the strategy.');
    console.log(`\nTo undo:  mysql -u root ${process.env.DB_NAME || 'erp_manufacturing'} < ${file}`);
  } finally {
    await pool.end();
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
