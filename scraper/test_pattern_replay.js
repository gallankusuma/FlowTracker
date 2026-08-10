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
      WHERE data_source IN ('live','backfill_v2','backfill_v3_f5v1')
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
    assert.deepStrictEqual(body.allowedSources, ['live', 'backfill_v2', 'backfill_v3_f5v1']);
    assert.ok(!body.allowedSources.includes('backfill'), 'the contaminated generation is readable');
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
                             AND c.data_source IN ('live','backfill_v2','backfill_v3_f5v1'))
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

  // The weekend must sit INSIDE the known calendar. Picking one after the newest
  // session used to work and now correctly returns 400 FUTURE_ANCHOR — the suite
  // caught the collision between snap-back and the new future-anchor rule, and
  // the rule is the one that is right: a Sunday past the last known session is
  // not a weekend to snap over, it is a date we have no calendar for.
  await t('a non-session anchor snaps BACK to a real session, never forward', async () => {
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const [cal] = await pool.query('SELECT date FROM idx_ihsg_history ORDER BY date DESC LIMIT 40');
    const dates = cal.map(r => iso(r.date));               // newest first
    // A Saturday strictly between two real sessions, well inside the calendar.
    let saturday = null, expected = null;
    for (let i = 1; i < dates.length; i++) {
      const d = new Date(`${dates[i]}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      if (d.getUTCDay() === 6 && iso(d) < dates[0]) { saturday = iso(d); expected = dates[i]; break; }
    }
    assert.ok(saturday, 'no in-range weekend found to test with');
    const { status, body } = await get(
      `/api/signal-scanner/ticker/${TICKER}/factor-history?range=6D&endSession=${saturday}`);
    assert.strictEqual(status, 200, `HTTP ${status} for in-range weekend ${saturday}`);
    assert.strictEqual(body.endSession, expected,
      `${saturday} should snap back to ${expected}, got ${body.endSession}`);
  });

  await t('a FUTURE anchor is refused rather than snapped back to today', async () => {
    const { status, body } = await get(
      `/api/signal-scanner/ticker/${TICKER}/factor-history?range=6D&endSession=2099-01-01`);
    assert.strictEqual(status, 400, `HTTP ${status}`);
    assert.strictEqual(body.error, 'FUTURE_ANCHOR');
    assert.ok(body.latestKnownSession, 'refusal did not name the latest known session');
  });

  await t('a malformed anchor is refused, not silently ignored', async () => {
    const { status } = await get(`/api/signal-scanner/ticker/${TICKER}/factor-history?range=6D&endSession=last-friday`);
    assert.strictEqual(status, 400);
  });

  await t('an unknown range is refused rather than defaulted', async () => {
    const { status } = await get(`/api/signal-scanner/ticker/${TICKER}/factor-history?range=99D`);
    assert.strictEqual(status, 400);
  });

  // ── F5 DATA CONTRACT ─────────────────────────────────────────────────────
  console.log('\nF5 benchmark contract\n');
  const bench = require('./modules/benchmark_universe');

  await t('the benchmark is exactly 245 unique names', async () => {
    assert.strictEqual(bench.BENCHMARK_TICKERS.length, 245);
    assert.strictEqual(new Set(bench.BENCHMARK_TICKERS).size, 245, 'duplicate names in the benchmark');
  });

  await t('the benchmark is NOT an alias for the tracked universe', async () => {
    // IDX_TICKERS is already 600 in the working tree. If these ever become the
    // same array, F5's denominator silently follows the scan universe again.
    const { IDX_TICKERS } = require('./modules/tickers');
    assert.notStrictEqual(bench.BENCHMARK_TICKERS, IDX_TICKERS, 'benchmark is the same array object as IDX_TICKERS');
  });

  await t('coverage fails CLOSED, and an empty benchmark is never a flat market', async () => {
    assert.strictEqual(bench.benchmarkCoverage(0).ok, false);
    assert.strictEqual(bench.benchmarkCoverage(29).ok, false, 'below the absolute name floor');
    assert.strictEqual(bench.benchmarkCoverage(245).ok, true);
    // The floor came from the measured distribution: legitimate historical
    // thinness bottoms at 68.6%, and the one real anomaly sits at 41.6%.
    assert.strictEqual(bench.benchmarkCoverage(Math.round(245 * 0.686)).ok, true);
    assert.strictEqual(bench.benchmarkCoverage(Math.round(245 * 0.416)).ok, false);
  });

  await t('every regenerated snapshot carries its benchmark version', async () => {
    const [rows] = await pool.query(
      "SELECT COUNT(*) n FROM idx_signal_history WHERE data_source = 'backfill_v3_f5v1' AND f5_benchmark_version IS NULL");
    assert.strictEqual(Number(rows[0].n), 0, 'clean-generation rows exist with no benchmark version');
  });

  await t('an F5 value never coexists with an unusable benchmark', async () => {
    const [rows] = await pool.query(
      'SELECT COUNT(*) n FROM idx_signal_history WHERE f5_benchmark_observed IS NOT NULL AND f5_benchmark_observed < ? AND f5_rel_strength IS NOT NULL',
      [bench.F5_MIN_BENCHMARK_NAMES]);
    assert.strictEqual(Number(rows[0].n), 0, 'F5 was scored against a benchmark below the floor');
  });

  await t('factor-history reports whether a window shares one benchmark', async () => {
    const { body } = await get(`/api/signal-scanner/ticker/${TICKER}/factor-history?range=10D`);
    assert.ok(['CONSISTENT', 'MIXED', 'UNKNOWN'].includes(body.f5BenchmarkConsistency),
      `unexpected consistency verdict: ${body.f5BenchmarkConsistency}`);
    for (const h of body.history.filter(x => x.observed)) {
      assert.ok(Object.prototype.hasOwnProperty.call(h, 'f5BenchmarkVersion'),
        `${h.date} carries no benchmark provenance`);
    }
  });

  await t('an all-unlabelled window reports UNKNOWN, never CONSISTENT', async () => {
    // 'live' rows predate the contract and carry no benchmark version. A window
    // made only of them must not claim they share one.
    const [rows] = await pool.query(
      `SELECT data_date FROM idx_signal_history
        WHERE data_source = 'live' AND f5_benchmark_version IS NULL
        ORDER BY data_date DESC LIMIT 1`);
    if (!rows.length) { console.log('          (no unlabelled rows left — holds vacuously)'); return; }
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const { body } = await get(
      `/api/signal-scanner/ticker/${TICKER}/factor-history?range=6D&endSession=${iso(rows[0].data_date)}`);
    const observed = body.history.filter(h => h.observed);
    if (observed.length && observed.every(h => h.f5BenchmarkVersion === null)) {
      assert.strictEqual(body.f5BenchmarkConsistency, 'UNKNOWN');
    }
  });

  await t('the clean generation REPLACED the old backfills rather than joining them', async () => {
    const [rows] = await pool.query(
      "SELECT data_source, COUNT(*) n FROM idx_signal_history WHERE data_source IN ('backfill','backfill_v2') GROUP BY data_source");
    assert.strictEqual(rows.length, 0, `prior backfill generations still present: ${JSON.stringify(rows)}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
