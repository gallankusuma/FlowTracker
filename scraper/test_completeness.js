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

  // THE DATES COME FROM THE CALENDAR, NOT FROM A LITERAL (fixed 2026-08-11).
  //
  // These two asserted '2026-08-07' and '2026-08-06' against the LIVE calendar,
  // which was correct on the day they were written and wrong the moment the
  // exchange traded again: expectedBrokerSession only ever returns one of the
  // two NEWEST calendar rows, so once 2026-08-10 landed the intraday case
  // returned 2026-08-07 and the assertion failed. It had nothing to do with the
  // behaviour under test — the same class of expiring fixture as the pinned
  // clock in test_watchdog.js, found in the same run.
  //
  // A test against live data must derive its expectations from that data. What
  // is actually being asserted is a RELATIONSHIP, and that holds on any day.
  console.log('\nexpectedBrokerSession — against the REAL calendar');
  const [calRows] = await pool.query(
    'SELECT date FROM idx_ihsg_history ORDER BY date DESC LIMIT 2');
  const iso = d => new Date(d).toISOString().slice(0, 10);
  const newest = iso(calRows[0].date);
  const previous = iso(calRows[1].date);
  console.log(`         calendar: newest=${newest} previous=${previous}`);

  await t('post-cutoff, the newest session is expected', async () => {
    // 13:50 UTC on the newest session — after its 13:00 deadline.
    const v = await sh.expectedBrokerSession(pool, new Date(`${newest}T13:50:00Z`));
    console.log('         expected =', v);
    assert.strictEqual(v, newest);
  });
  await t('intraday on the newest session, the PREVIOUS one is expected', async () => {
    // 03:00 UTC = 10:00 WIB, still trading, that day's EOD pull hours away.
    const v = await sh.expectedBrokerSession(pool, new Date(`${newest}T03:00:00Z`));
    console.log('         expected =', v);
    assert.strictEqual(v, previous);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
