'use strict';
/**
 * Fill `sp500_factor_history`, which held TWO rows.
 *
 * ── WHY IT WAS EMPTY ─────────────────────────────────────────────────────────
 *
 * Not because its writer was broken. `GET /api/sp500-factors` was its ONLY
 * caller, so the table only grew when a human opened the page. CRONTAB.md
 * records the identical failure on the IDX side -- "the snapshot used to be a
 * side effect of GET /api/signal-scanner. History only grew when a human opened
 * the page" -- which is why 2026-08-03..06 have no snapshots at all.
 *
 * A snapshot table whose sole writer is a page view is not a history. It is a
 * cache of whenever somebody last looked.
 *
 * ── NO LOOKAHEAD ─────────────────────────────────────────────────────────────
 *
 * Scored through `modules/sp500_factors.js`, the same function the live endpoint
 * and the nightly cron call, with an as-of date. Candles are truncated at that
 * date before the 60-bar slice, and breadth reads exactly that session's
 * us_stock_prices rows rather than the newest ones.
 *
 * ── THE CAVEAT THAT TRAVELS WITH EVERY EARLY ROW ─────────────────────────────
 *
 * Breadth is the share of tracked tickers that closed up. `us_tickers.js` is a
 * present-day S&P 500 snapshot, so early sessions carry far fewer names AND only
 * the companies that survived to be in today's index. A 2008 breadth reading is
 * computed over survivors; it is not what an observer would have seen. The row
 * count behind each figure is reported so a thin session is visible rather than
 * indistinguishable from a full one.
 *
 * Usage:
 *   node scraper/backfill_sp500_factor_history.js
 *   node scraper/backfill_sp500_factor_history.js --from 2020-01-01
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { createPool } = require('./modules/db_config');
const { saveSP500FactorSnapshot } = require('./modules/sp500_factors');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FROM = arg('--from', null);

(async () => {
  const pool = createPool();
  const t0 = Date.now();

  const [[before]] = await pool.query('SELECT COUNT(*) n, MIN(date) mn, MAX(date) mx FROM sp500_factor_history');
  console.log(`before: ${before.n} rows` +
    (before.n ? `, ${String(before.mn).slice(0, 10)} .. ${String(before.mx).slice(0, 10)}` : ''));

  // The index needs 30 bars before the first scoreable session, and breadth
  // needs the ticker cross-section to exist for that date at all.
  const [dates] = await pool.query(
    `SELECT DISTINCT s.date d FROM sp500_history s
      WHERE s.date >= COALESCE(?, '1900-01-01')
        AND s.date >= (SELECT MIN(date) FROM us_stock_prices)
      ORDER BY s.date ASC`, [FROM]);
  console.log(`${dates.length} candidate sessions` + (FROM ? ` from ${FROM}` : ''));

  let written = 0, skipped = 0, thin = 0;
  const sampleSizes = [];
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i].d instanceof Date ? dates[i].d.toISOString().slice(0, 10) : String(dates[i].d).slice(0, 10);
    let f;
    try { f = await saveSP500FactorSnapshot(pool, d); }
    catch (e) { console.log(`  ${d} failed: ${e.message}`); skipped++; continue; }
    // Under 30 index bars the function refuses rather than guessing, which is
    // the correct answer for the first weeks of the range.
    if (!f) { skipped++; continue; }
    written++;
    sampleSizes.push(f.breadthSample ?? 0);
    if ((f.breadthSample ?? 0) < 100) thin++;
    if (written % 500 === 0) {
      console.log(`  ${String(i + 1).padStart(5)}/${dates.length}  ${d}  composite ${f.composite}  ` +
        `breadth ${f.factors.breadth} on ${f.breadthSample} names  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }

  const [[after]] = await pool.query('SELECT COUNT(*) n, MIN(date) mn, MAX(date) mx FROM sp500_factor_history');
  const sorted = sampleSizes.slice().sort((a, b) => a - b);
  console.log(`\n${'='.repeat(70)}`);
  console.log(`written ${written}, skipped ${skipped} (under 30 index bars or no cross-section)`);
  console.log(`after: ${after.n} rows, ${String(after.mn).slice(0, 10)} .. ${String(after.mx).slice(0, 10)}`);
  if (sorted.length) {
    console.log(`breadth sample size: p10 ${sorted[Math.floor(sorted.length * 0.1)]}, ` +
      `median ${sorted[Math.floor(sorted.length / 2)]}, p90 ${sorted[Math.floor(sorted.length * 0.9)]}`);
    console.log(`${thin} of ${written} sessions computed breadth on FEWER THAN 100 names — those figures` +
      ' are not comparable to a 400-name session and are survivorship-filtered besides.');
  }
  console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await pool.end();
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
