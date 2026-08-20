/**
 * Does a not-applicable concentration survive the DATABASE?
 *
 * Asked for by name in the 2026-08-18 11:05 review: "No database integration
 * fixture proves null survives the actual INSERT/UPDATE and subsequent API read,
 * and the submitted evidence does not explicitly exercise f2/f8 over missing
 * intermediate sessions."
 *
 * WHY A UNIT TEST CANNOT ANSWER THIS. `signedTop3Concentration` returning null is
 * one thing; that null reaching a reader intact is four more, and every one of
 * them has a silent way to fail:
 *
 *   1. the COLUMN may be NOT NULL, in which case MySQL stores 0 and says nothing
 *      in a non-strict mode
 *   2. the INSERT may coerce (`?? 0` was exactly this defect, for weeks)
 *   3. the ON DUPLICATE KEY UPDATE path is a SECOND writer, and a null that
 *      inserts correctly can still fail to overwrite an existing number --
 *      `COALESCE(VALUES(dn1), dn1)` is the classic form of this and it would
 *      leave yesterday's reading standing in place of today's gap
 *   4. the API serializer may turn it back into a number on the way out
 *
 * A measured zero and an unmeasured session look identical after any of those,
 * and the whole point of the null is that they are not the same fact.
 *
 * ISOLATION. Everything is written under a stock_code that cannot exist
 * (`__NULTEST`, 9 chars, not a valid IDX ticker) on dates in 1999, decades
 * before this table's first real row. The rows are deleted at the end whether
 * the test passes or fails.
 *
 * SKIPS CLEANLY without a database, so `npm test` still runs on a laptop; pass
 * --require-db to make an unreachable database a failure instead.
 */
'use strict';
require('dotenv').config();

const assert = require('assert');
const mysql = require('mysql2/promise');
const { f2_trend, f8_streak } = require('./modules/awo_factors');

const TEST_CODE = '__NULTEST';
const D1 = '1999-01-04', D2 = '1999-01-05';
const REQUIRE_DB = process.argv.includes('--require-db') || process.env.FT_REQUIRE_DB === '1';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n          ${e.message}`); }
}

/** The exact expression every reader uses to turn a row into a 5-session history. */
function historyFromRow(c) {
  return [c.dn4, c.dn3, c.dn2, c.dn1, c.dn0]
    .map(v => (v === null || v === undefined ? null : Number(v)));
}

async function cleanup(pool) {
  await pool.query('DELETE FROM idx_concentration WHERE stock_code = ?', [TEST_CODE]);
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
    if (REQUIRE_DB) {
      console.log('\nconcentration nullability — FAILED: --require-db was passed but no database is reachable');
      console.log(`  ${e.message}`);
      process.exit(1);
    }
    console.log('\nconcentration nullability — skipped (no database; pass --require-db to make this a failure)');
    process.exit(0);
  }

  try {
    await cleanup(pool);
    console.log('\nthe column itself');

    const [cols] = await pool.query(
      `SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'idx_concentration'
          AND COLUMN_NAME IN ('dn0','dn1','dn2','dn3','dn4')`);

    t('all five dn columns exist and accept NULL', () => {
      assert.strictEqual(cols.length, 5, `expected 5 dn columns, found ${cols.length}`);
      for (const c of cols) {
        assert.strictEqual(c.IS_NULLABLE, 'YES',
          `${c.COLUMN_NAME} is NOT NULL — a gap would be stored as a number`);
        assert.strictEqual(c.COLUMN_DEFAULT, null,
          `${c.COLUMN_NAME} defaults to ${c.COLUMN_DEFAULT}, so an omitted value becomes a reading`);
      }
    });

    console.log('');
    console.log('the INSERT path');

    // An interior gap: four measured sessions with one unobserved day between
    // them. dn2 is a REAL zero on purpose — a balanced market — sitting next to
    // a null, because the pair is what the whole distinction is about.
    await pool.query(
      `INSERT INTO idx_concentration (data_date, stock_code, dn0, dn1, dn2, dn3, dn4, price, change_pct)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [D1, TEST_CODE, 12.5, null, 0, -7.25, 3.5, 1000, 0.5]);

    const [[inserted]] = await pool.query(
      'SELECT dn0, dn1, dn2, dn3, dn4 FROM idx_concentration WHERE stock_code = ? AND data_date = ?',
      [TEST_CODE, D1]);

    t('a not-applicable session reads back as null, not 0', () => {
      assert.strictEqual(inserted.dn1, null, `dn1 came back as ${JSON.stringify(inserted.dn1)}`);
    });

    t('a measured zero reads back as 0, not null — the other half of the contract', () => {
      assert.strictEqual(Number(inserted.dn2), 0);
      assert.notStrictEqual(inserted.dn2, null,
        'a balanced market must stay distinguishable from an unobserved one');
    });

    t('the measured sessions survive unchanged', () => {
      assert.strictEqual(Number(inserted.dn0), 12.5);
      assert.strictEqual(Number(inserted.dn3), -7.25);
      assert.strictEqual(Number(inserted.dn4), 3.5);
    });

    console.log('');
    console.log('the ON DUPLICATE KEY UPDATE path — the second writer');

    // The writer upserts, so most rows are written by THIS branch rather than by
    // the INSERT above. A null that inserts correctly can still fail to
    // overwrite: with COALESCE(VALUES(dn1), dn1) yesterday's number would stay
    // and today's gap would never be recorded.
    await pool.query(
      `INSERT INTO idx_concentration (data_date, stock_code, dn0, dn1, dn2, dn3, dn4, price, change_pct)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE dn0=VALUES(dn0),dn1=VALUES(dn1),dn2=VALUES(dn2),
         dn3=VALUES(dn3),dn4=VALUES(dn4),price=VALUES(price),change_pct=VALUES(change_pct)`,
      [D1, TEST_CODE, null, null, 0, -7.25, 3.5, 1000, 0.5]);

    const [[updated]] = await pool.query(
      'SELECT dn0, dn1, dn2, dn3, dn4 FROM idx_concentration WHERE stock_code = ? AND data_date = ?',
      [TEST_CODE, D1]);

    t('a null OVERWRITES a previously stored number', () => {
      assert.strictEqual(updated.dn0, null,
        `dn0 kept the old 12.5 (${JSON.stringify(updated.dn0)}) — the update path is coalescing`);
    });

    t('the update did not disturb the other columns', () => {
      assert.strictEqual(Number(updated.dn2), 0);
      assert.strictEqual(Number(updated.dn3), -7.25);
      assert.strictEqual(updated.dn1, null);
    });

    // Queried outside t() on purpose: the helper is synchronous, so a promise
    // returned from inside it would never be awaited and the assertion would be
    // silently discarded — a test that always passes.
    const [[rowCount]] = await pool.query(
      'SELECT COUNT(*) n FROM idx_concentration WHERE stock_code = ? AND data_date = ?', [TEST_CODE, D1]);

    t('exactly one row exists — the unique key held', () => {
      // Without uk_date_stock the "update" would have been a second insert and
      // every read would then depend on ordering.
      assert.strictEqual(Number(rowCount.n), 1);
    });

    console.log('');
    console.log('the read path out to the API');

    await pool.query(
      `INSERT INTO idx_concentration (data_date, stock_code, dn0, dn1, dn2, dn3, dn4, price, change_pct)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      // The values are chosen, not arbitrary. A flat [5,5,5,null,5] is
      // degenerate -- positional and compacted weights give the same mean, so f2
      // really is unchanged by the gap there. An all-positive series saturates
      // f2's direction term at 100 and the clamp hides the difference. Mixed
      // signs with a positive run at the near end make BOTH factors sensitive to
      // the hole, which is the point of the fixture.
      [D2, TEST_CODE, 6, null, 3, -9, -4, 1000, 0.5]);

    // The literal serializer /api/ft-concentration uses: SELECT then res.json.
    const [apiRows] = await pool.query(
      'SELECT stock_code, dn0, dn1, dn2, dn3, dn4, price, change_pct FROM idx_concentration WHERE data_date = ?',
      [D2]);
    const serialized = JSON.parse(JSON.stringify({ date: D2, count: apiRows.length, data: apiRows }));

    t('null survives JSON serialization as null', () => {
      assert.strictEqual(serialized.data[0].dn1, null,
        'the API turned an unobserved session back into a number');
      assert.strictEqual(Number(serialized.data[0].dn2), 3);
    });

    t('the 5-session history built from the row keeps the hole in place', () => {
      const hist = historyFromRow(apiRows[0]);
      assert.deepStrictEqual(hist, [-4, -9, 3, null, 6]);
      assert.strictEqual(hist.length, 5, 'the history must stay positional');
    });

    console.log('');
    console.log('f2 / f8 over a missing intermediate session');

    t('f8 does not report a streak through the unobserved day', () => {
      const hist = historyFromRow(apiRows[0]);              // [-4, -9, 3, null, 6]
      const throughTheHole = f8_streak([-4, -9, 3, 6]);     // what compaction produced
      const actual = f8_streak(hist);
      assert.ok(actual < throughTheHole,
        `f8 read ${actual} where the compacted history reads ${throughTheHole}`);
      assert.strictEqual(actual, f8_streak([6]),
        'only the sessions on this side of the hole may be counted');
    });

    t('f2 weights the day that held the value, not the one the gap promoted it to', () => {
      const hist = historyFromRow(apiRows[0]);
      // Compacting slides the value from three sessions ago into yesterday's
      // recency slot. With unequal values that changes the answer; if these two
      // agree, something on the path is still filtering the nulls out.
      assert.notStrictEqual(f2_trend(hist), f2_trend(hist.filter(v => v !== null)),
        'the gap made no difference, so it is still being filtered away somewhere');
    });

    t('neither factor throws or returns NaN on a holed history', () => {
      for (const h of [[null, 5, null, 5, null], [null, null, null, null, 5], [5, null, null, null, null]]) {
        assert.ok(Number.isFinite(f2_trend(h)), `f2 returned ${f2_trend(h)} for ${JSON.stringify(h)}`);
        assert.ok(Number.isFinite(f8_streak(h)), `f8 returned ${f8_streak(h)} for ${JSON.stringify(h)}`);
      }
    });

    t('a fully unobserved window is neutral, not an opinion', () => {
      assert.strictEqual(f2_trend([null, null, null, null, null]), 50);
      assert.strictEqual(f8_streak([null, null, null, null, null]), 50);
    });

    console.log('');
    console.log('what the live table actually holds');

    const [[live]] = await pool.query(`
      SELECT COUNT(*) total,
             SUM(CASE WHEN dn0 IS NULL OR dn1 IS NULL OR dn2 IS NULL
                       OR dn3 IS NULL OR dn4 IS NULL THEN 1 ELSE 0 END) withNull
        FROM idx_concentration WHERE data_date >= '2026-08-01' AND stock_code <> ?`, [TEST_CODE]);

    t('nulls are actually being written in production, not just accepted in theory', () => {
      // If this ever reads 0 again, the writer has gone back to `?? 0` and every
      // test above would still pass while production published measured zeros.
      assert.ok(Number(live.total) > 0, 'no recent rows to judge');
      assert.ok(Number(live.withNull) > 0,
        `${live.total} rows since 2026-08-01 and not one null — the writer is coercing again`);
      console.log(`          ${live.withNull} of ${live.total} rows since 2026-08-01 carry at least one null`);
    });

  } finally {
    await cleanup(pool);
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
