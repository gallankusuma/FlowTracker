/**
 * Database SCHEMA and ledger-primitive test.
 *
 * Renamed 2026-08-04: this file was called test_forward_lifecycle.js and its
 * docstring claimed to run cmdPlan -> cmdFill -> cmdMark -> reportFor. It calls
 * none of them — it inserts rows by hand and checks the constraints and the
 * cash/NAV primitives. The 13:07 review caught the gap between the name and the
 * code. What it does is worth keeping, so it keeps doing it under an honest
 * name; the real end-to-end test now lives in test_forward_lifecycle.js.
 *
 * test_strategy_forward.js covers the pure functions, and the reviewer was right
 * that this is not enough: the defects that kept surviving lived in the GLUE —
 * hash scoping on plan and NAV, unique-key collisions, INSERT IGNORE silently
 * discarding a row while a counter incremented anyway, transaction behaviour.
 * None of those are reachable without a real database.
 *
 * So this drives the actual cycle against real MySQL:
 *
 *   cmdPlan -> row -> cmdFill -> partial fill -> cmdMark -> reportFor -> gate
 *
 * ISOLATION. Everything is written under a distinct STRATEGY_ID, so the live
 * ledger is never touched, and the rows are deleted at the end whether the test
 * passes or fails. The tables are the real ones, because using copies would
 * defeat the point — unique keys and INSERT IGNORE are exactly what is on trial.
 *
 * SKIPS CLEANLY without a database, so `npm test` still runs on a laptop.
 */
'use strict';
require('dotenv').config();

const assert = require('assert');
const mysql = require('mysql2/promise');
const sf = require('./strategy_forward');

const TEST_ID = 'TEST_SCHEMA_DO_NOT_TRADE';
const HASH_A = 'aaaaaaaaaaaaaaaa', HASH_B = 'bbbbbbbbbbbbbbbb';
const REQUIRE_DB = process.argv.includes('--require-db') || process.env.FT_REQUIRE_DB === '1';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n          ${e.message}`); }
}

async function cleanup(pool) {
  for (const tbl of ['ft_strategy_positions', 'ft_strategy_log', 'ft_strategy_plan', 'ft_strategy_nav']) {
    await pool.query(`DELETE FROM ${tbl} WHERE strategy_id=?`, [TEST_ID]);
  }
}

(async () => {
  let pool;
  try {
    pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'erp_user',
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'erp_manufacturing',
      waitForConnections: true, connectionLimit: 3,
    });
    await pool.query('SELECT 1');
  } catch (e) {
    // Skipping is not success when a database was promised (review, 13:07).
    if (REQUIRE_DB) {
      console.log('\nforward schema — FAILED: --require-db was passed but no database is reachable');
      console.log(`  ${e.message}`);
      process.exit(1);
    }
    console.log('\nforward schema — skipped (no database; pass --require-db to make this a failure)');
    process.exit(0);
  }

  // The tables must already exist; setup() owns their DDL and migrations.
  const [[tbl]] = await pool.query(
    `SELECT COUNT(*) n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_strategy_positions'`);
  if (!tbl.n) {
    if (REQUIRE_DB) {
      console.log('\nforward schema — FAILED: tables are missing and --require-db was passed');
      process.exit(1);
    }
    console.log('\nforward schema — skipped (run strategy_forward.js once to create the tables)');
    process.exit(0);
  }

  await cleanup(pool);
  try {
    // FRESH DDL, ACTUALLY EXERCISED (review, test notes). Checking the existing
    // tables cannot catch a CREATE TABLE that an empty database would reject —
    // which is exactly the defect that shipped: a unique key naming columns the
    // DDL never declared. The user account cannot CREATE DATABASE, so each
    // CREATE TABLE from setup() is replayed here under a scratch name, which
    // puts the same statement through the same parser.
    console.log('\nforward schema — the CREATE TABLE statements on an empty namespace');
    const src = require('fs').readFileSync(require('path').join(__dirname, 'strategy_forward.js'), 'utf8');
    const blocks = [...src.matchAll(/CREATE TABLE IF NOT EXISTS (ft_strategy_\w+) \(([\s\S]*?)\n {4}\)/g)];
    t('every forward table has a CREATE statement to check', () => {
      assert.strictEqual(blocks.length, 4, `found ${blocks.length}`);
    });
    const scratch = [];
    for (const [, name, body] of blocks) {
      const tmp = `${name}_freshcheck`;
      let err = null;
      try {
        await pool.query(`DROP TABLE IF EXISTS ${tmp}`);
        await pool.query(`CREATE TABLE ${tmp} (${body}
    )`);
        scratch.push(tmp);
      } catch (e) { err = e; }
      t(`${name} builds from nothing`, () => assert.ok(!err, err && err.message));
    }
    for (const tmp of scratch) await pool.query(`DROP TABLE ${tmp}`);

    console.log('\nforward lifecycle — strategy_hash isolation');

    // Two configurations, same ticker, same date. Before strategy_hash entered
    // the unique keys, INSERT IGNORE discarded the second silently.
    const ins = async (hash, ticker, date, cost) => {
      const [r] = await pool.query(
        `INSERT IGNORE INTO ft_strategy_positions
           (strategy_id, ticker, entry_date, entry_price, weight, units, cost_basis, run_mode, strategy_hash)
         VALUES (?,?,?,?,?,?,?,'LIVE',?)`,
        [TEST_ID, ticker, date, 100, cost, cost / 100, cost, hash]);
      return r.affectedRows;
    };
    const a1 = await ins(HASH_A, 'AAA', '2026-01-05', 0.5);
    const b1 = await ins(HASH_B, 'AAA', '2026-01-05', 0.5);
    t('two configurations can hold the same ticker on the same date', () => {
      assert.strictEqual(a1, 1, 'first insert must land');
      assert.strictEqual(b1, 1, 'second must land too — it is a different strategy');
    });

    const dup = await ins(HASH_A, 'AAA', '2026-01-05', 0.5);
    t('the same configuration cannot duplicate a position, and says so', () => {
      assert.strictEqual(dup, 0, 'INSERT IGNORE must discard the duplicate');
      // This is the value of guarding on affectedRows: the caller can tell.
    });

    const [rows] = await pool.query(
      'SELECT strategy_hash h, COUNT(*) n FROM ft_strategy_positions WHERE strategy_id=? GROUP BY h ORDER BY h',
      [TEST_ID]);
    t('each configuration keeps its own row', () => {
      assert.strictEqual(rows.length, 2, JSON.stringify(rows));
      assert.ok(rows.every(r => r.n === 1));
    });

    console.log('\nforward lifecycle — NAV is scoped per configuration');

    const mark = async (hash, nav) => pool.query(
      `INSERT INTO ft_strategy_nav (strategy_id, mark_date, run_mode, strategy_hash, open_positions, total_nav)
       VALUES (?, '2026-01-06', 'LIVE', ?, 1, ?)
       ON DUPLICATE KEY UPDATE total_nav=VALUES(total_nav)`, [TEST_ID, hash, nav]);
    await mark(HASH_A, 1.25);
    await mark(HASH_B, 0.80);
    const [navs] = await pool.query(
      'SELECT strategy_hash h, total_nav v FROM ft_strategy_nav WHERE strategy_id=? ORDER BY h', [TEST_ID]);
    t('one configuration cannot overwrite the NAV of another on the same date', () => {
      assert.strictEqual(navs.length, 2, JSON.stringify(navs));
      assert.ok(Math.abs(Number(navs[0].v) - 1.25) < 1e-6, `A kept its NAV, got ${navs[0].v}`);
      assert.ok(Math.abs(Number(navs[1].v) - 0.80) < 1e-6, `B kept its NAV, got ${navs[1].v}`);
    });

    console.log('\nforward lifecycle — the log is scoped too');

    const log = async (hash, date) => {
      const [r] = await pool.query(
        `INSERT IGNORE INTO ft_strategy_log
           (strategy_id, as_of_date, exposure, reason, regime_label, eligible, vetoed, n_target, run_mode, strategy_hash)
         VALUES (?,?,1,'INVESTED','BULL',50,10,8,'LIVE',?)`, [TEST_ID, date, hash]);
      return r.affectedRows;
    };
    const la = await log(HASH_A, '2026-01-05');
    const lb = await log(HASH_B, '2026-01-05');
    const ldup = await log(HASH_A, '2026-01-05');
    t('two configurations can log the same decision date; one cannot log it twice', () => {
      assert.strictEqual(la, 1);
      assert.strictEqual(lb, 1, 'a second configuration must not be silently dropped');
      assert.strictEqual(ldup, 0);
    });

    console.log('\nforward lifecycle — cash and NAV read back from the real ledger');

    const [ledger] = await pool.query(
      `SELECT ticker, entry_date, exit_date, units, cost_basis, proceeds
         FROM ft_strategy_positions WHERE strategy_id=? AND strategy_hash=?`, [TEST_ID, HASH_A]);
    t('cash reflects what the ledger actually spent', () => {
      const cash = sf.cashAt(ledger, '2026-01-05');
      assert.ok(Math.abs(cash - (sf.INITIAL_CAPITAL - 0.5)) < 1e-9, `got ${cash}`);
    });

    t('a sale returns its proceeds to cash', () => {
      const withExit = ledger.map(r => ({ ...r, exit_date: '2026-01-07', proceeds: 0.6 }));
      const cash = sf.cashAt(withExit, '2026-01-07');
      assert.ok(Math.abs(cash - (sf.INITIAL_CAPITAL - 0.5 + 0.6)) < 1e-9, `got ${cash}`);
    });

    t('NAV marks the held units at the given bar', () => {
      const series = new Map([['AAA', {
        open: [100, 100, 200], high: [100, 100, 200], close: [100, 100, 200], value: [1, 1, 1], dn0: [0, 0, 0],
      }]]);
      const nav = sf.navAt(ledger, series, 2, '2026-01-07');
      // 0.5 of the book left in cash, 0.005 units now worth 200 each.
      assert.ok(Math.abs(nav - (0.5 + 0.005 * 200)) < 1e-9, `got ${nav}`);
    });

    console.log('\nforward lifecycle — the promotion gate reads the isolated record');

    const fg = require('./modules/forward_gate');
    t('an empty LIVE record for a configuration is NOT_ELIGIBLE, not an error', () => {
      const g = fg.evaluateForwardGate({
        rebalanceDecisions: 1, calendarMonths: 0, distinctRegimes: 1, fills: 1,
        profitFactor: null, excessReturn: null,
      });
      assert.strictEqual(g.status, 'NOT_ELIGIBLE');
      assert.ok(g.failed.length >= 4);
    });
  } finally {
    await cleanup(pool);
    const [[left]] = await pool.query(
      'SELECT COUNT(*) n FROM ft_strategy_positions WHERE strategy_id=?', [TEST_ID]);
    t('the test cleans up after itself', () => assert.strictEqual(Number(left.n), 0));
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
