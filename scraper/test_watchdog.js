/**
 * Watchdog tests, against real MySQL.
 *
 * The central one punches a real hole in a real series and proves two separate
 * things: that the hole is DETECTED (every existing freshness check reads
 * MAX(date) and cannot see it), and that the "already current" guard in
 * refreshIHSG no longer refuses to look — because that guard is what made the
 * 2026-08-03 hole permanent rather than temporary.
 *
 * A detector that has never been seen firing is not a detector, so each check
 * here is run against a healthy series first and a broken one second. If the
 * healthy case does not come back clean, the broken case proves nothing.
 *
 * ISOLATION. The hole is punched in a throwaway table, never in
 * idx_ihsg_history: a test that damages the live regime series to prove a point
 * about repairs would be its own outage.
 *
 * SKIPPING IS NOT SUCCESS — without a database this exits 0 only when run
 * WITHOUT --require-db.
 */
'use strict';
require('dotenv').config();

const assert = require('assert');
const mysql = require('mysql2/promise');
const sh = require('./modules/system_health');
const ihsgModule = require('./modules/ihsg');

const T_SERIES = 'zz_test_series';
const T_CAL = 'zz_test_calendar';
const REQUIRE_DB = process.argv.includes('--require-db') || process.env.FT_REQUIRE_DB === '1';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n          ${e.message}`); }
}

const DATES = [
  '2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31',
  '2026-08-03', '2026-08-04',
];

async function build(pool, seriesDates) {
  await pool.query(`DROP TABLE IF EXISTS ${T_SERIES}`);
  await pool.query(`DROP TABLE IF EXISTS ${T_CAL}`);
  await pool.query(`CREATE TABLE ${T_CAL} (date DATE PRIMARY KEY)`);
  await pool.query(`CREATE TABLE ${T_SERIES} (date DATE PRIMARY KEY, close_price DECIMAL(12,2))`);
  await pool.query(`INSERT INTO ${T_CAL} (date) VALUES ?`, [DATES.map(d => [d])]);
  await pool.query(`INSERT INTO ${T_SERIES} (date, close_price) VALUES ?`,
    [seriesDates.map((d, i) => [d, 1000 + i])]);
}

(async () => {
  let pool;
  try {
    pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'erp_user',
      password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'erp_manufacturing',
      waitForConnections: true, connectionLimit: 4,
    });
    await pool.query('SELECT 1');
  } catch (e) {
    if (REQUIRE_DB) {
      console.log('\nwatchdog — FAILED: --require-db was passed but no database is reachable');
      console.log(`  ${e.message}`);
      process.exit(1);
    }
    console.log('\nwatchdog — skipped (no database; pass --require-db to make this a failure)');
    process.exit(0);
  }

  try {
    console.log('\nwatchdog — gap detection');

    await t('a complete series reports no holes', async () => {
      await build(pool, DATES);
      const g = await sh.missingSessions(pool, { table: T_SERIES, col: 'date', reference: T_CAL });
      assert.deepStrictEqual(g.missing, [], `unexpected holes: ${g.missing.join(', ')}`);
      assert.strictEqual(g.checked, DATES.length);
    });

    await t('A HOLE IN THE MIDDLE IS FOUND — the exact 2026-08-03 failure', async () => {
      // The series holds 2026-08-04 but not 2026-08-03. MAX(date) is perfectly
      // fresh, which is why every existing check stayed green for it.
      await build(pool, DATES.filter(d => d !== '2026-08-03'));
      const g = await sh.missingSessions(pool, { table: T_SERIES, col: 'date', reference: T_CAL });
      assert.deepStrictEqual(g.missing, ['2026-08-03']);
    });

    await t('MAX(date) alone genuinely cannot see that hole — the control', async () => {
      // Without this the test above proves only that a query works, not that it
      // catches something the old checks missed.
      const [[m]] = await pool.query(`SELECT MAX(date) d FROM ${T_SERIES}`);
      const latest = String(m.d).slice(0, 10) === '2026-08-04' ||
        new Date(m.d).toISOString().slice(0, 10) === '2026-08-04';
      assert.strictEqual(latest, true, 'the series still ends on the freshest session, so it looks current');
    });

    await t('several holes are all reported, in order', async () => {
      await build(pool, DATES.filter(d => d !== '2026-07-29' && d !== '2026-08-03'));
      const g = await sh.missingSessions(pool, { table: T_SERIES, col: 'date', reference: T_CAL });
      assert.deepStrictEqual(g.missing, ['2026-07-29', '2026-08-03']);
    });

    await t('a series that simply starts later is not "full of holes"', async () => {
      // Otherwise every newly added feed would scream on its first night.
      await build(pool, DATES.slice(3));
      const g = await sh.missingSessions(pool, { table: T_SERIES, col: 'date', reference: T_CAL });
      assert.deepStrictEqual(g.missing, [], `dates before the series began were reported: ${g.missing.join(', ')}`);
    });

    await t('a day missing from BOTH is treated as a non-trading day, not a hole', async () => {
      await pool.query(`DELETE FROM ${T_CAL} WHERE date='2026-07-30'`);
      await pool.query(`DELETE FROM ${T_SERIES} WHERE date='2026-07-30'`);
      const g = await sh.missingSessions(pool, { table: T_SERIES, col: 'date', reference: T_CAL });
      assert.deepStrictEqual(g.missing, [], 'it must report holes it can prove, not holes it guesses at');
    });

    console.log('\nwatchdog — the guard that made the hole permanent');

    // A fake Yahoo, so this tests the guard rather than the network.
    const candlesFor = dates => ({
      candles: dates.map((d, i) => ({ date: d, open: 1000 + i, high: 1010 + i, low: 990 + i, close: 1000 + i, volume: 1000 })),
    });
    const AFTER_CLOSE = new Date('2026-08-04T13:00:00Z');   // 20:00 WIB, session over

    await t('with no holes, a current series is still skipped — the guard still works', async () => {
      let fetched = false;
      const res = await ihsgModule.refreshIHSG(pool, async () => { fetched = true; return candlesFor(DATES); },
        { now: AFTER_CLOSE, skipGapCheck: true });
      assert.strictEqual(res.skipped, true, 'a current series must not be refetched every run');
      assert.strictEqual(fetched, false);
    });

    await t('A HOLE DEFEATS THE SKIP — this is what made 2026-08-03 permanent', async () => {
      // Before the fix: MAX(date) had reached the last closed session, so the
      // guard returned `skipped: true` forever and no scheduled run would ever
      // look at the hole behind it again.
      const real = sh.missingSessions;
      sh.missingSessions = async () => ({ missing: ['2026-08-03'], checked: 7, window: null });
      try {
        let fetched = false;
        const res = await ihsgModule.refreshIHSG(pool, async () => {
          fetched = true;
          throw new Error('STOP_AFTER_GUARD');
        }, { now: AFTER_CLOSE });
        assert.fail(`the guard skipped despite a known hole: ${JSON.stringify(res)}`);
      } catch (e) {
        assert.strictEqual(e.message, 'STOP_AFTER_GUARD',
          'it must get past the guard and actually try to refetch');
      } finally {
        sh.missingSessions = real;
      }
    });

    await t('the refresh reports which holes it CLOSED and which it could not', async () => {
      // refreshIHSG writes to the REAL idx_ihsg_history, so this feeds back the
      // rows that are ALREADY there, unchanged. The upsert then writes each
      // session its own existing values — a genuine no-op. Inventing candles
      // here would inject fake closes into the live regime series to make a
      // point about repairing it, which is its own outage.
      const [real3] = await pool.query(
        `SELECT date, open_price o, high_price h, low_price l, close_price c, volume v
           FROM idx_ihsg_history ORDER BY date DESC LIMIT 3`);
      assert.ok(real3.length === 3, 'need real rows to echo back');
      const echo = real3.reverse().map(r => ({
        date: String(r.date).slice(0, 10).length === 10 && String(r.date).includes('-')
          ? String(r.date).slice(0, 10)
          : new Date(r.date).toISOString().slice(0, 10),
        open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v),
      }));
      const before = await pool.query(
        'SELECT COUNT(*) n, SUM(close_price) s FROM idx_ihsg_history').then(([r]) => r[0]);

      const realFn = sh.missingSessions;
      let call = 0;
      // before -> two holes; after the write -> one still missing, because the
      // source genuinely does not have that session.
      sh.missingSessions = async () => (++call === 1
        ? { missing: ['2026-07-29', '2026-08-03'], checked: 7, window: null }
        : { missing: ['2026-07-29'], checked: 7, window: null });
      try {
        const res = await ihsgModule.refreshIHSG(pool, async () => ({ candles: echo }), { now: AFTER_CLOSE });
        assert.deepStrictEqual(res.gapsFilled, ['2026-08-03']);
        assert.deepStrictEqual(res.gapsRemaining, ['2026-07-29'],
          'an unfillable hole must be reported, never quietly interpolated');
      } finally {
        sh.missingSessions = realFn;
      }

      const after = await pool.query(
        'SELECT COUNT(*) n, SUM(close_price) s FROM idx_ihsg_history').then(([r]) => r[0]);
      assert.strictEqual(Number(after.n), Number(before.n), 'the live series gained or lost rows');
      assert.ok(Math.abs(Number(after.s) - Number(before.s)) < 0.01,
        'the live series closes changed — this test must be a no-op against production data');
    });

    console.log('\nwatchdog — the circular classification');

    await t('A REAL INDEX GAP IS NOT EXCUSED AS "never a session"', async () => {
      // The circularity: a date missing from idx_ihsg_history gets the
      // NO_INDEX_BAR signature, is therefore treated as a phantom, is excluded
      // from the gap detector, and so is never repaired. The evidence for the
      // exclusion IS the fault. Hard signatures only when computing exclusions.
      const [[latest]] = await pool.query('SELECT MAX(date) d FROM idx_ihsg_history');
      const victim = (() => {
        const d = new Date(latest.d);
        // A weekday well inside the series, with prices present and an index bar.
        d.setUTCDate(d.getUTCDate() - 3);
        while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0, 10);
      })();
      const [[row]] = await pool.query(
        'SELECT * FROM idx_ihsg_history WHERE date=?', [victim]);
      if (!row) { console.log(`      (no index bar on ${victim}; nothing to remove)`); return; }
      const [[px]] = await pool.query(
        'SELECT COUNT(*) n FROM idx_stock_prices WHERE date=?', [victim]);
      assert.ok(Number(px.n) > 0, `need prices on ${victim} for this to be a real session`);

      // INSIDE A TRANSACTION THAT IS ALWAYS ROLLED BACK, on its own connection.
      // The first version did DELETE ... then re-INSERT in `finally`, which is
      // fine right up until the process is killed between the two — and then the
      // production index series has permanently lost a real session to a test.
      // A transaction cannot leave that state behind: if this process dies, the
      // uncommitted delete dies with it.
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM idx_ihsg_history WHERE date=?', [victim]);

        // The checks must run on the SAME connection to see the uncommitted
        // delete, so they take `conn` rather than the pool.
        const hard = await sh.phantomSessions(conn, { useIndexCalendar: false });
        const soft = await sh.phantomSessions(conn);

        assert.ok(!hard.some(p => p.date === victim),
          `${victim} was called a phantom by a HARD signature; the exclusion list would hide it`);
        assert.ok(soft.some(p => p.date === victim && p.signatures.includes('NO_INDEX_BAR')),
          'sanity: with the index calendar on, it IS labelled NO_INDEX_BAR');

        // And with the hard-only exclusion, the gap detector still sees it.
        const gaps = await sh.missingSessions(conn, {
          table: 'idx_ihsg_history', col: 'date', exclude: hard.map(p => p.date) });
        assert.ok(gaps.missing.includes(victim),
          'the real gap must remain visible to the repair path');
      } finally {
        // ALWAYS. There is no committing path out of this block.
        await conn.rollback();
        conn.release();
      }
      const [[back]] = await pool.query('SELECT COUNT(*) n FROM idx_ihsg_history WHERE date=?', [victim]);
      assert.strictEqual(Number(back.n), 1, `the index bar for ${victim} did not survive the rollback`);
    });

    console.log('\nwatchdog — a failure cannot be retried away');

    const burnin = require('./modules/burnin');
    const vp = require('./virtual_portfolio');
    const ID = 'zztestidentity01';

    await t('A SESSION THAT FAILED IS NEVER PROMOTED BY A LATER CLEAN RUN', async () => {
      // The verdict row was upserted, so a second watchdog run on a repaired
      // system rewrote passed=0 to passed=1 and the session joined the streak.
      // The burn-in's own rule is that any failure in a session breaks it.
      const [[s]] = await pool.query('SELECT MAX(date) d FROM idx_ihsg_history');
      const day = burnin.iso(s.d);
      await pool.query('DELETE FROM virtual_burnin_attempt WHERE identity_hash=?', [ID]).catch(() => {});
      await pool.query('DELETE FROM virtual_burnin WHERE identity_hash=?', [ID]);
      try {
        const first = await burnin.recordAttempt(pool, {
          sessionDate: day, identityHash: ID, engineVersion: 9,
          passed: false, checks: { x: false }, failures: ['x'],
        });
        assert.strictEqual(first.verdict, false);

        const second = await burnin.recordAttempt(pool, {
          sessionDate: day, identityHash: ID, engineVersion: 9,
          passed: true, checks: { x: true }, failures: [],
        });
        assert.strictEqual(second.verdict, false,
          'a repaired re-run promoted a failed session to clean');
        assert.strictEqual(second.attempts, 2, 'both attempts must be kept');

        const [[row]] = await pool.query(
          'SELECT passed, failures_json FROM virtual_burnin WHERE identity_hash=? AND session_date=?', [ID, day]);
        assert.strictEqual(Number(row.passed), 0, 'the stored verdict was upgraded');
        assert.ok(row.failures_json && row.failures_json.includes('x'),
          'the original failure must still be readable');
      } finally {
        await pool.query('DELETE FROM virtual_burnin_attempt WHERE identity_hash=?', [ID]);
        await pool.query('DELETE FROM virtual_burnin WHERE identity_hash=?', [ID]);
      }
    });

    await t('A MISSING SESSION STOPS THE STREAK — silence is not evidence', async () => {
      // Monday clean, Tuesday's watchdog never ran, Wednesday and Thursday
      // clean. Counting the rows that exist gives three. The honest answer is
      // two: nothing at all is known about Tuesday.
      const [sess] = await pool.query(
        'SELECT date FROM idx_ihsg_history ORDER BY date DESC LIMIT 4');
      assert.strictEqual(sess.length, 4, 'need four sessions to build the gap');
      const [d0, d1, d2, d3] = sess.map(r => burnin.iso(r.date));   // newest first

      await burnin.ensureTables(pool);
      await pool.query('DELETE FROM virtual_burnin_attempt WHERE identity_hash=?', [ID]);
      await pool.query('DELETE FROM virtual_burnin WHERE identity_hash=?', [ID]);
      try {
        // Written as ATTEMPTS, because that is what computeStreak reads. The
        // summary is a cache; seeding it would test the cache, not the rule.
        for (const d of [d0, d1, d3]) {          // d2 deliberately has no row
          await pool.query(
            `INSERT INTO virtual_burnin_attempt (session_date, identity_hash, engine_version, passed)
             VALUES (?,?,?,1)`, [d, ID, 9]);
        }
        const r = await burnin.computeStreak(pool, ID, d0);
        assert.strictEqual(r.streak, 2, `expected 2 (${d0}, ${d1}), got ${r.streak}`);
        assert.ok(r.stoppedBy.includes(d2), `must stop at the unobserved session: ${r.stoppedBy}`);
      } finally {
        await pool.query('DELETE FROM virtual_burnin_attempt WHERE identity_hash=?', [ID]);
        await pool.query('DELETE FROM virtual_burnin WHERE identity_hash=?', [ID]);
      }
    });

    await t('A LAGGING SUMMARY CANNOT HIDE A FAILED ATTEMPT', async () => {
      // The crash window: the attempt INSERT commits, the process dies before
      // the summary UPSERT. If the streak read the summary it would count a
      // session clean whose failure is sitting in the attempt table.
      const [[s]] = await pool.query('SELECT MAX(date) d FROM idx_ihsg_history');
      const day = burnin.iso(s.d);
      await burnin.ensureTables(pool);
      await pool.query('DELETE FROM virtual_burnin_attempt WHERE identity_hash=?', [ID]);
      await pool.query('DELETE FROM virtual_burnin WHERE identity_hash=?', [ID]);
      try {
        // A summary deliberately left saying CLEAN...
        await pool.query(
          `INSERT INTO virtual_burnin (session_date, identity_hash, engine_version, passed)
           VALUES (?,?,?,1)`, [day, ID, 9]);
        // ...while the append-only source records a failure.
        await pool.query(
          `INSERT INTO virtual_burnin_attempt (session_date, identity_hash, engine_version, passed, failures_json)
           VALUES (?,?,?,0,?)`, [day, ID, 9, JSON.stringify(['crash window'])]);

        const r = await burnin.computeStreak(pool, ID, day);
        assert.strictEqual(r.streak, 0, 'the streak trusted the stale summary over the attempt');
        assert.ok(r.stoppedBy.includes(day), r.stoppedBy);
      } finally {
        await pool.query('DELETE FROM virtual_burnin_attempt WHERE identity_hash=?', [ID]);
        await pool.query('DELETE FROM virtual_burnin WHERE identity_hash=?', [ID]);
      }
    });

    await t('CHANGING THE BURN-IN PROTOCOL RESTARTS THE OFFICIAL COUNT', async () => {
      // The rules used to judge a session are part of what its verdict MEANS.
      // Five sessions marked clean under the loose protocol must not count
      // toward a streak the strict one defines.
      const experiment = 'zzexperiment0001';
      const v2key = burnin.burninIdentity(experiment);
      // What the v1 key would have been: the experiment identity used directly.
      const v1key = experiment;
      assert.notStrictEqual(v2key, v1key, 'the protocol must change the key');

      const [sess] = await pool.query('SELECT date FROM idx_ihsg_history ORDER BY date DESC LIMIT 5');
      await burnin.ensureTables(pool);
      await pool.query('DELETE FROM virtual_burnin_attempt WHERE identity_hash IN (?,?)', [v1key, v2key]);
      try {
        for (const row of sess) {
          await pool.query(
            `INSERT INTO virtual_burnin_attempt (session_date, identity_hash, engine_version, passed)
             VALUES (?,?,?,1)`, [burnin.iso(row.date), v1key, 9]);
        }
        const old = await burnin.computeStreak(pool, v1key);
        assert.strictEqual(old.streak, 5, 'sanity: the old protocol really does have five clean sessions');

        const now = await burnin.computeStreak(pool, v2key);
        assert.strictEqual(now.streak, 0,
          'the official count must start at 0 when the protocol changes, not inherit v1 rows');
      } finally {
        await pool.query('DELETE FROM virtual_burnin_attempt WHERE identity_hash IN (?,?)', [v1key, v2key]);
      }
    });

    await t('a FRESH database can build the whole burn-in schema from the shared helper', async () => {
      // burnin.ensureTables created only the attempt table while the summary was
      // created inside watchdog.recordBurnIn — so recordAttempt on a new
      // environment wrote to a table that did not exist.
      const db = `zz_burnin_${Date.now().toString(36)}`;
      await pool.query(`CREATE DATABASE \`${db}\``);
      const fresh = mysql.createPool({
        host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'erp_user',
        password: process.env.DB_PASSWORD, database: db, waitForConnections: true, connectionLimit: 2,
      });
      try {
        await fresh.query('CREATE TABLE idx_ihsg_history (date DATE PRIMARY KEY, close_price DECIMAL(12,2))');
        await fresh.query(`INSERT INTO idx_ihsg_history VALUES ('2026-08-06', 6300)`);
        await burnin.ensureTables(fresh);   // the ONLY schema call
        const rec = await burnin.recordAttempt(fresh, {
          sessionDate: '2026-08-06', identityHash: 'zzfresh000000001', engineVersion: 2,
          passed: true, checks: { ok: true }, failures: [],
        });
        assert.strictEqual(rec.verdict, true);
        const r = await burnin.computeStreak(fresh, 'zzfresh000000001');
        assert.strictEqual(r.streak, 1);
      } finally {
        await fresh.end();
        await pool.query(`DROP DATABASE \`${db}\``);
      }
    });

    await t('the dashboard and the watchdog cannot disagree — one helper, one number', async () => {
      // They each had their own loop. Two implementations of the same claim
      // drift, and then two panels tell the operator different stories.
      const identity = await vp.experimentIdentity(pool, vp.SOURCE_STRATEGY);
      const a = await burnin.computeStreak(pool, identity);
      const b = await burnin.computeStreak(pool, identity);
      assert.strictEqual(a.streak, b.streak);
      const src = require('fs').readFileSync(`${__dirname}/server.js`, 'utf8');
      assert.ok(/burninMod\.computeStreak|burnin.*computeStreak/.test(src),
        'server.js must call the shared helper rather than re-deriving the streak');
      const wd = require('fs').readFileSync(`${__dirname}/watchdog.js`, 'utf8');
      assert.ok(/burnin\.computeStreak/.test(wd),
        'watchdog.js must call the shared helper too');
    });

    await t('A STAGE THAT FAILED THEN SUCCEEDED KEEPS ever_failed=1', async () => {
      // The pipeline may recover and continue; the SESSION may not become clean.
      const day = burnin.iso((await pool.query('SELECT MAX(date) d FROM idx_ihsg_history'))[0][0].d);
      const strategy = 'ZZ_STAGE_STICKY_TEST';
      await vp.ensureStageTable(pool);
      const identity = await vp.cycleIdentity(pool, strategy);
      await pool.query('DELETE FROM virtual_cycle_stage WHERE identity_hash=?', [identity]);
      try {
        await vp.recordStage(pool, day, 'schedule', 'FAILED', 'rolled back', strategy);
        await vp.recordStage(pool, day, 'schedule', 'OK', null, strategy);

        const gate = await vp.stageOk(pool, day, 'schedule', strategy);
        assert.strictEqual(gate.ok, true, 'a recovered pipeline must be allowed to continue');
        assert.strictEqual(gate.everFailed, true, 'but the failure must remain on the record');
        assert.strictEqual(gate.attempts, 2);
        assert.strictEqual(gate.firstFailure, 'rolled back',
          'the FIRST failure reason is kept, not overwritten by the retry');
      } finally {
        await pool.query('DELETE FROM virtual_cycle_stage WHERE identity_hash=?', [identity]);
      }
    });

  } catch (e) {
    fail++;
    console.log(`\n  FAIL  the run itself threw\n          ${e.stack}`);
  } finally {
    if (pool) {
      try {
        await pool.query(`DROP TABLE IF EXISTS ${T_SERIES}`);
        await pool.query(`DROP TABLE IF EXISTS ${T_CAL}`);
      } catch (e) { fail++; console.log(`  FAIL  cleanup: ${e.message}`); }
      await pool.end();
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
