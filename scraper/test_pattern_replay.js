/**
 * Pattern Replay contract tests, against the real database.
 *
 * These assert the three rules that make a trajectory readable at all, and each
 * one exists because it was got wrong first:
 *
 *   - the window spans CANONICAL EXCHANGE SESSIONS, so "6D" is six consecutive
 *     sessions and a hole stays a hole rather than pulling an older session in;
 *   - contaminated rows are EXCLUDED — the 2026-07-19 overfitting incident
 *     traced 885 rows to validation leakage in the original backfill, and the
 *     clean rebuild was relabelled backfill_v2 precisely so the bad generation
 *     could be refused by name;
 *   - the window can be ANCHORED in the past, which is the whole difference
 *     between a current-trajectory viewer and Pattern Replay.
 *
 * SKIPPING IS NOT SUCCESS — without a database this exits 0 only when run
 * WITHOUT --require-db.
 */
'use strict';
require('dotenv').config();

const assert = require('assert');
const mysql = require('mysql2/promise');

const DB = { host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'erp_user',
             password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'erp_manufacturing' };
const BASE = process.env.FT_API_BASE || 'http://127.0.0.1:3100';
const REQUIRE_DB = process.argv.includes('--require-db') || process.env.FT_REQUIRE_DB === '1';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n          ${e.message}`); }
}

const get = async (path) => {
  const r = await fetch(`${BASE}${path}`);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

(async () => {
  const pool = mysql.createPool({ ...DB, connectionLimit: 3 });
  try { await pool.query('SELECT 1'); }
  catch (e) {
    await pool.end().catch(() => {});
    if (REQUIRE_DB) { console.error(`no database, --require-db was passed: ${e.message}`); process.exit(1); }
    console.log('no database reachable — skipping (run with --require-db to make this a failure)');
    process.exit(0);
  }

  // A ticker that actually has history, chosen from the data rather than pinned.
  const [[pick]] = await pool.query(
    `SELECT stock_code FROM idx_signal_history
      WHERE data_source IN ('live','backfill_v2')
      GROUP BY stock_code ORDER BY COUNT(*) DESC LIMIT 1`);
  const TICKER = pick.stock_code;
  console.log(`\nPattern Replay — ticker ${TICKER}\n`);

  await t('range returns exactly N canonical sessions, observed or not', async () => {
    for (const [range, n] of [['6D', 6], ['10D', 10], ['20D', 20]]) {
      const { status, body } = await get(`/api/signal-scanner/ticker/${TICKER}/factor-history?range=${range}`);
      assert.strictEqual(status, 200, `HTTP ${status} for ${range}`);
      assert.strictEqual(body.history.length, n, `${range} returned ${body.history.length} rows`);
      assert.strictEqual(body.window.expectedSessions, n);
    }
  });

  await t('rows are the exchange calendar, not whatever the table happened to have', async () => {
    const { body } = await get(`/api/signal-scanner/ticker/${TICKER}/factor-history?range=10D`);
    const dates = body.history.map(h => h.date).slice().reverse();
    const [cal] = await pool.query(
      'SELECT date FROM idx_ihsg_history WHERE date <= ? ORDER BY date DESC LIMIT 10', [body.endSession]);
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    assert.deepStrictEqual(dates, cal.map(r => iso(r.date)).reverse());
  });

  await t('an unobserved session is present with null factors, never zero', async () => {
    const { body } = await get(`/api/signal-scanner/ticker/${TICKER}/factor-history?range=20D`);
    const gaps = body.history.filter(h => !h.observed);
    for (const g of gaps) {
      assert.strictEqual(g.factors, null, `${g.date} carried factors while unobserved`);
      assert.strictEqual(g.compositeScore, null, `${g.date} carried a score while unobserved`);
    }
    // And they are named, not silently dropped.
    assert.deepStrictEqual(
      body.window.missingSessions.slice().sort(),
      gaps.map(g => g.date).sort());
  });

  await t('CONTAMINATED backfill rows are excluded', async () => {
    const { body } = await get(`/api/signal-scanner/ticker/${TICKER}/factor-history?range=20D`);
    assert.deepStrictEqual(body.allowedSources, ['live', 'backfill_v2']);
    for (const h of body.history) {
      if (!h.observed) continue;
      assert.notStrictEqual(h.dataSource, 'backfill',
        `${h.date} served a row from the contaminated 'backfill' generation`);
    }
  });

  // The rule proven directly against the table: if any legacy 'backfill' row
  // exists for a session in range, the endpoint must NOT report it as observed.
  await t('a session whose only row is contaminated reports as UNOBSERVED', async () => {
    const [[legacy]] = await pool.query(
      `SELECT h.stock_code, h.data_date FROM idx_signal_history h
        WHERE h.data_source = 'backfill'
          AND NOT EXISTS (SELECT 1 FROM idx_signal_history c
                           WHERE c.stock_code = h.stock_code AND c.data_date = h.data_date
                             AND c.data_source IN ('live','backfill_v2'))
        LIMIT 1`);
    if (!legacy) { console.log('          (no contaminated-only rows remain — rule holds vacuously)'); return; }
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const date = iso(legacy.data_date);
    const { body } = await get(
      `/api/signal-scanner/ticker/${legacy.stock_code}/factor-history?range=6D&endSession=${date}`);
    const row = body.history.find(h => h.date === date);
    assert.ok(row, `${date} missing from the window entirely`);
    assert.strictEqual(row.observed, false,
      `${legacy.stock_code} ${date} was served from a contaminated row`);
  });

  await t('endSession anchors the window in the past', async () => {
    const [cal] = await pool.query('SELECT date FROM idx_ihsg_history ORDER BY date DESC LIMIT 8');
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const anchor = iso(cal[5].date);
    const { status, body } = await get(
      `/api/signal-scanner/ticker/${TICKER}/factor-history?range=6D&endSession=${anchor}`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.endSession, anchor);
    assert.strictEqual(body.history[0].date, anchor, 'newest row is not the anchor');
    assert.ok(body.history.every(h => h.date <= anchor), 'window leaked past the anchor');
  });

  await t('a non-session anchor snaps BACK to a real session, never forward', async () => {
    const [cal] = await pool.query('SELECT date FROM idx_ihsg_history ORDER BY date DESC LIMIT 3');
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const session = iso(cal[0].date);
    const sunday = new Date(`${session}T00:00:00Z`);
    sunday.setUTCDate(sunday.getUTCDate() + ((7 - sunday.getUTCDay()) % 7 || 7));  // next Sunday
    const { status, body } = await get(
      `/api/signal-scanner/ticker/${TICKER}/factor-history?range=6D&endSession=${sunday.toISOString().slice(0, 10)}`);
    assert.strictEqual(status, 200);
    assert.ok(body.endSession <= sunday.toISOString().slice(0, 10));
    const [ok] = await pool.query('SELECT 1 FROM idx_ihsg_history WHERE date = ?', [body.endSession]);
    assert.ok(ok.length, `${body.endSession} is not an exchange session`);
  });

  await t('a malformed anchor is refused, not silently ignored', async () => {
    const { status } = await get(`/api/signal-scanner/ticker/${TICKER}/factor-history?range=6D&endSession=last-friday`);
    assert.strictEqual(status, 400);
  });

  await t('an unknown range is refused rather than defaulted', async () => {
    const { status } = await get(`/api/signal-scanner/ticker/${TICKER}/factor-history?range=99D`);
    assert.strictEqual(status, 400);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
