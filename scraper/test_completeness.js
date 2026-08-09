/**
 * The completeness contract, tested against the REAL series.
 *
 * WHY AGAINST REAL DATA. The holes these assertions rely on are not invented:
 * `idx_broker_summary` is genuinely missing 2026-06-15, 06-22 and 06-29 — three
 * consecutive Mondays that the exchange traded, with prices and an index bar for
 * all three. A fixture could only prove the function does what I wrote it to do.
 * Running it over the actual defect proves it catches the thing that was
 * silently corrupting windows before anyone had looked.
 *
 * The control matters as much as the finding: prices over the SAME window are
 * complete, so this discriminates rather than reporting holes everywhere.
 *
 * SKIPPING IS NOT SUCCESS — without a database this exits 0 only when run
 * WITHOUT --require-db.
 */
'use strict';
require('dotenv').config();
const mysql = require('mysql2/promise');
const sh = require('./modules/system_health');
const DB = { host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'erp_user',
             password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'erp_manufacturing' };
const REQUIRE_DB = process.argv.includes('--require-db') || process.env.FT_REQUIRE_DB === '1';

let pass = 0, fail = 0;
const assert = require('assert');
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n          ${e.message}`); }
}

(async () => {
  const pool = mysql.createPool({ ...DB, connectionLimit: 3 });
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    await pool.end().catch(() => {});
    if (REQUIRE_DB) { console.error(`no database, and --require-db was passed: ${e.message}`); process.exit(1); }
    console.log('no database reachable — skipping (run with --require-db to make this a failure)');
    process.exit(0);
  }

  console.log('\nassertCompleteSessions — against the REAL holes this sweep found');
  console.log('(idx_broker_summary is missing 2026-06-15, 06-22, 06-29 — all real sessions)\n');

  // A window that straddles 2026-06-22. This is the §5.2 failure mode verbatim:
  // it must report INCOMPLETE, not quietly return four observations.
  await t('a window crossing a hole is INCOMPLETE, and names the missing session', async () => {
    const r = await sh.assertCompleteSessions(pool, {
      table: 'idx_broker_summary', col: 'date',
      startSession: '2026-06-18', endSession: '2026-06-24',
    });
    console.log('        ', JSON.stringify(r));
    assert.strictEqual(r.complete, false);
    assert.ok(r.missingSessions.includes('2026-06-22'), 'did not name 2026-06-22');
    assert.ok(r.observedSessions < r.expectedSessions, 'observed should be short of expected');
  });

  await t('a clean window IS complete', async () => {
    const r = await sh.assertCompleteSessions(pool, {
      table: 'idx_broker_summary', col: 'date',
      startSession: '2026-07-06', endSession: '2026-07-10',
    });
    console.log('        ', JSON.stringify(r));
    assert.strictEqual(r.complete, true);
    assert.strictEqual(r.missingSessions.length, 0);
    assert.strictEqual(r.observedSessions, r.expectedSessions);
  });

  // The Pattern Replay shape: "the last 5 sessions before X".
  await t('count-based window walks the CANONICAL calendar, not available rows', async () => {
    const r = await sh.assertCompleteSessions(pool, {
      table: 'idx_broker_summary', col: 'date', endSession: '2026-06-26', count: 5,
    });
    console.log('        ', JSON.stringify(r));
    assert.strictEqual(r.expectedSessions, 5);
    assert.ok(r.missingSessions.includes('2026-06-22'), 'a 5-session window ending 06-26 must span 06-22');
    assert.strictEqual(r.observedSessions, 4, 'exactly four of the five sessions have data');
    assert.strictEqual(r.complete, false);
  });

  await t('prices over the same broken window ARE complete (the hole is broker-only)', async () => {
    const r = await sh.assertCompleteSessions(pool, {
      table: 'idx_stock_prices', col: 'date', endSession: '2026-06-26', count: 5,
    });
    console.log('        ', JSON.stringify(r));
    assert.strictEqual(r.complete, true);
  });

  await t('a window longer than the calendar reports CALENDAR_SHORTER_THAN_WINDOW', async () => {
    const r = await sh.assertCompleteSessions(pool, {
      table: 'idx_stock_prices', col: 'date', endSession: '2016-08-03', count: 50,
    });
    console.log('        ', JSON.stringify(r));
    assert.strictEqual(r.complete, false);
    assert.strictEqual(r.reason, 'CALENDAR_SHORTER_THAN_WINDOW');
  });

  await t('requiredFields rejects sessions whose rows are null in those columns', async () => {
    const r = await sh.assertCompleteSessions(pool, {
      table: 'idx_concentration', col: 'data_date', endSession: '2026-07-31', count: 5,
      requiredFields: ['dn0'],
    });
    console.log('        ', JSON.stringify(r));
    assert.strictEqual(r.expectedSessions, 5);
  });

  console.log('\nexpectedBrokerSession — against the REAL calendar');
  await t('post-cutoff, the newest session is expected', async () => {
    const v = await sh.expectedBrokerSession(pool, new Date('2026-08-07T13:50:00Z'));
    console.log('         expected =', v);
    assert.strictEqual(v, '2026-08-07');
  });
  await t('intraday on the newest session, the PREVIOUS one is expected', async () => {
    const v = await sh.expectedBrokerSession(pool, new Date('2026-08-07T03:00:00Z'));
    console.log('         expected =', v);
    assert.strictEqual(v, '2026-08-06');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
