'use strict';
/**
 * Independent checks on `us_signal_history`.
 *
 * The backfill computes forward returns by walking an in-memory array. This
 * recomputes them straight from `us_stock_prices` with SQL that shares no code
 * with the backfill, because a self-consistent off-by-one is exactly the kind
 * of error that survives re-reading the loop that produced it. `LIMIT 1 OFFSET
 * h-1` over the ticker's own later sessions is the same definition arrived at
 * by a different route.
 *
 * Usage: node scraper/verify_us_signal_history.js [--samples 400]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { createPool } = require('./modules/db_config');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SAMPLES = Number(arg('--samples', 400));
const HORIZONS = [1, 5, 10, 20, 60];

let failures = 0;
const fail = m => { failures++; console.log(`  FAIL  ${m}`); };
const ok = m => console.log(`  ok    ${m}`);

(async () => {
  const pool = createPool();
  console.log('Verifying us_signal_history\n');

  const [[c]] = await pool.query(
    `SELECT COUNT(*) n, COUNT(DISTINCT ticker) tk, COUNT(DISTINCT data_date) sessions,
            MIN(data_date) mn, MAX(data_date) mx FROM us_signal_history`);
  console.log(`${c.n} rows, ${c.tk} tickers, ${c.sessions} sessions, ` +
    `${c.mn && c.mn.toISOString().slice(0, 10)} .. ${c.mx && c.mx.toISOString().slice(0, 10)}\n`);

  console.log('1. forward returns, recomputed from us_stock_prices by a different route');
  for (const h of HORIZONS) {
    const [rows] = await pool.query(
      `SELECT h.ticker, h.data_date, h.price_at_signal, h.return_${h} stored,
              (SELECT q.close_price FROM us_stock_prices q
                WHERE q.ticker = h.ticker AND q.date > h.data_date
                ORDER BY q.date ASC LIMIT 1 OFFSET ?) fwd
         FROM us_signal_history h
        WHERE h.return_${h} IS NOT NULL
        ORDER BY RAND() LIMIT ?`, [h - 1, SAMPLES]);
    let bad = 0, worst = 0;
    for (const r of rows) {
      if (r.fwd === null) { bad++; continue; }
      const exp = ((Number(r.fwd) - Number(r.price_at_signal)) / Number(r.price_at_signal)) * 100;
      const d = Math.abs(exp - Number(r.stored));
      worst = Math.max(worst, d);
      if (d > 0.0002) bad++;
    }
    if (bad) fail(`return_${h}d: ${bad}/${rows.length} mismatched (worst |diff| ${worst.toFixed(6)})`);
    else ok(`return_${h}d: ${rows.length}/${rows.length} match (worst |diff| ${worst.toFixed(6)})`);
  }

  console.log('\n2. no lookahead — price_at_signal must be that date\'s close');
  const [px] = await pool.query(
    `SELECT COUNT(*) n FROM us_signal_history h JOIN us_stock_prices p
       ON p.ticker = h.ticker AND p.date = h.data_date
      WHERE ABS(p.close_price - h.price_at_signal) > 0.0001`);
  if (px[0].n) fail(`${px[0].n} rows whose price_at_signal is not the as-of close`);
  else ok('every price_at_signal equals that ticker/date close');

  console.log('\n3. the newest rows must have UNRESOLVED long horizons');
  // If the most recent session already carried a 60-day outcome, the backfill
  // would be reading the future. This is the cheapest test that catches it.
  const [tail] = await pool.query(
    `SELECT SUM(return_1d IS NOT NULL) r1, SUM(return_10d IS NOT NULL) r10,
            SUM(return_60d IS NOT NULL) r60, COUNT(*) n
       FROM us_signal_history WHERE data_date = (SELECT MAX(data_date) FROM us_signal_history)`);
  const t = tail[0];
  if (Number(t.r60) > 0) fail(`${t.r60} rows on the latest session already have return_60d`);
  else ok(`latest session: ${t.n} rows, return_60d resolved on 0 of them`);
  if (Number(t.r1) > 0) fail(`${t.r1} rows on the latest session already have return_1d`);
  else ok('latest session: return_1d resolved on 0 of them');

  console.log('\n4. market average is point-in-time, not one number reused');
  const [ma] = await pool.query(
    `SELECT COUNT(DISTINCT market_avg_change_pct) d, COUNT(DISTINCT data_date) s FROM us_signal_history`);
  if (Number(ma[0].d) < Number(ma[0].s) * 0.5) fail(`only ${ma[0].d} distinct market averages across ${ma[0].s} sessions`);
  else ok(`${ma[0].d} distinct market averages across ${ma[0].s} sessions`);
  const [maj] = await pool.query(
    `SELECT COUNT(*) n FROM us_signal_history h
       JOIN (SELECT date, AVG(change_pct) a FROM us_stock_prices GROUP BY date) m ON m.date = h.data_date
      WHERE ABS(m.a - h.market_avg_change_pct) > 0.0001`);
  if (maj[0].n) fail(`${maj[0].n} rows whose market_avg_change_pct is not that date's cross-sectional mean`);
  else ok('every market_avg_change_pct equals that date\'s cross-sectional mean');

  console.log('\n5. factor and score ranges');
  const [[r]] = await pool.query(
    `SELECT MIN(composite_score) cmn, MAX(composite_score) cmx,
            MIN(f3_volume_z) f3mn, MAX(f3_volume_z) f3mx,
            MIN(f9_rsi) f9mn, MAX(f9_rsi) f9mx,
            SUM(composite_score IS NULL) nullc FROM us_signal_history`);
  if (r.cmn < 0 || r.cmx > 100) fail(`composite outside 0-100: ${r.cmn} .. ${r.cmx}`);
  else ok(`composite ${Number(r.cmn).toFixed(2)} .. ${Number(r.cmx).toFixed(2)}`);
  if (r.f3mn < 0 || r.f3mx > 100) fail(`f3 outside 0-100: ${r.f3mn} .. ${r.f3mx}`);
  else ok(`f3 ${r.f3mn} .. ${r.f3mx},  f9 ${r.f9mn} .. ${r.f9mx}`);
  if (Number(r.nullc)) fail(`${r.nullc} rows with a null composite`);

  console.log('\n6. anchors available, against Promotion Contract v1 S1 (>= 30)');
  for (const h of [3, 5, 10, 20, 40, 60]) {
    const a = Math.floor(c.sessions / h);
    console.log(`  ${String(h).padStart(2)}d: ${String(a).padStart(5)} anchors  ${a >= 30 ? 'OK' : 'BELOW BAR'}`);
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nall checks passed');
  await pool.end();
  if (failures) process.exit(1);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
