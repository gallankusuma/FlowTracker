'use strict';
/**
 * Invariant checks on `idx_intraday_1m`.
 *
 * A recorder that runs unattended for years is worth exactly what its data is
 * worth, and nobody will be reading the rows. Every check below is one that
 * would otherwise be discovered in two years' time by an experiment producing a
 * confident wrong answer.
 *
 * The one that matters most is CHECK 5: aggregating the minute bars up to a
 * daily bar and comparing against `idx_stock_prices`, which comes from a
 * DIFFERENT Yahoo endpoint on a different schedule. Two independent paths to the
 * same quantity is the only check here that can catch a systematic fault rather
 * than a malformed row -- and it is the check that would have caught the
 * whole-dollar rounding that corrupted us_stock_prices for a month.
 *
 * Usage: node scraper/verify_intraday_1m.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { createPool } = require('./modules/db_config');

let failures = 0;
const fail = m => { failures++; console.log(`  FAIL  ${m}`); };
const ok = m => console.log(`  ok    ${m}`);

(async () => {
  const pool = createPool();
  console.log('Verifying idx_intraday_1m\n');

  const [[c]] = await pool.query(
    `SELECT COUNT(*) n, COUNT(DISTINCT stock_code) tk, COUNT(DISTINCT DATE(ts)) sessions,
            MIN(ts) mn, MAX(ts) mx FROM idx_intraday_1m`);
  if (!c.n) { console.log('table is empty — nothing to verify'); await pool.end(); return; }
  console.log(`${c.n} rows, ${c.tk} tickers, ${c.sessions} sessions, ` +
    `${c.mn.toISOString().slice(0, 16).replace('T', ' ')} .. ${c.mx.toISOString().slice(0, 16).replace('T', ' ')} UTC\n`);

  console.log('1. every bar inside IDX session hours (02:00–09:15 UTC = 09:00–16:15 WIB)');
  const [[hrs]] = await pool.query(
    `SELECT SUM(TIME(ts) < '02:00:00' OR TIME(ts) > '09:15:00') outside, COUNT(*) n FROM idx_intraday_1m`);
  if (Number(hrs.outside)) fail(`${hrs.outside} bars outside session hours`);
  else ok(`0 of ${hrs.n} bars outside session hours`);

  console.log('\n2. no weekend bars');
  const [[wk]] = await pool.query(
    "SELECT SUM(DAYOFWEEK(ts) IN (1,7)) weekend FROM idx_intraday_1m");
  if (Number(wk.weekend)) fail(`${wk.weekend} bars on a Saturday or Sunday`);
  else ok('0 weekend bars');

  console.log('\n3. OHLC is internally consistent');
  const [[oh]] = await pool.query(`
    SELECT SUM(high_price < GREATEST(open_price, close_price)) hi,
           SUM(low_price  > LEAST(open_price, close_price))    lo,
           SUM(high_price < low_price)                          inv,
           SUM(close_price IS NULL OR close_price <= 0)         bad
      FROM idx_intraday_1m WHERE open_price IS NOT NULL AND high_price IS NOT NULL AND low_price IS NOT NULL`);
  if (Number(oh.hi)) fail(`${oh.hi} bars where high < max(open, close)`);
  if (Number(oh.lo)) fail(`${oh.lo} bars where low > min(open, close)`);
  if (Number(oh.inv)) fail(`${oh.inv} bars where high < low`);
  if (Number(oh.bad)) fail(`${oh.bad} bars with a null or non-positive close`);
  if (!Number(oh.hi) && !Number(oh.lo) && !Number(oh.inv) && !Number(oh.bad)) ok('OHLC consistent, no null closes');

  console.log('\n4. nothing from the future');
  const [[fut]] = await pool.query('SELECT SUM(ts > UTC_TIMESTAMP()) f FROM idx_intraday_1m');
  if (Number(fut.f)) fail(`${fut.f} bars timestamped in the future`);
  else ok('0 future bars');

  /* ── the check that can catch a SYSTEMATIC fault ────────────────────────── */
  console.log('\n5. minute bars aggregate to the daily bar from idx_stock_prices');
  console.log('   (a different Yahoo endpoint on a different schedule — two independent');
  console.log('    paths to the same quantity, which is what makes this check worth having)');
  const [rows] = await pool.query(`
    SELECT m.stock_code, DATE(m.ts) d,
           MAX(m.high_price) hi, MIN(m.low_price) lo, SUM(m.volume) vol,
           p.high_price phi, p.low_price plo, p.volume pvol
      FROM idx_intraday_1m m
      JOIN idx_stock_prices p ON p.stock_code = m.stock_code AND p.date = DATE(m.ts)
     GROUP BY m.stock_code, DATE(m.ts), p.high_price, p.low_price, p.volume`);
  if (!rows.length) {
    console.log('  (no overlapping ticker-days yet — the daily table may lag by a session)');
  } else {
    let hiBad = 0, loBad = 0, volBad = 0;
    let worstHi = 0, worstLo = 0, worstVol = 0;
    for (const r of rows) {
      const dh = Math.abs(Number(r.hi) - Number(r.phi)) / Number(r.phi);
      const dl = Math.abs(Number(r.lo) - Number(r.plo)) / Number(r.plo);
      worstHi = Math.max(worstHi, dh); worstLo = Math.max(worstLo, dl);
      if (dh > 0.005) hiBad++;
      if (dl > 0.005) loBad++;
      if (Number(r.pvol) > 0) {
        // Minute volume rarely sums exactly to the daily figure: the closing
        // auction is reported outside the minute grid on many venues. A wide
        // tolerance still catches an order-of-magnitude fault, which is the
        // class of error worth catching here.
        const dv = Math.abs(Number(r.vol) - Number(r.pvol)) / Number(r.pvol);
        worstVol = Math.max(worstVol, dv);
        if (dv > 0.25) volBad++;
      }
    }
    const pctHi = (hiBad / rows.length * 100).toFixed(1);
    const pctLo = (loBad / rows.length * 100).toFixed(1);
    const pctV = (volBad / rows.length * 100).toFixed(1);
    console.log(`  ${rows.length} overlapping ticker-days`);
    if (hiBad / rows.length > 0.05) fail(`high disagrees by >0.5% on ${pctHi}% of days (worst ${(worstHi * 100).toFixed(2)}%)`);
    else ok(`high agrees within 0.5% on ${(100 - pctHi).toFixed(1)}% of days (worst ${(worstHi * 100).toFixed(2)}%)`);
    if (loBad / rows.length > 0.05) fail(`low disagrees by >0.5% on ${pctLo}% of days (worst ${(worstLo * 100).toFixed(2)}%)`);
    else ok(`low agrees within 0.5% on ${(100 - pctLo).toFixed(1)}% of days (worst ${(worstLo * 100).toFixed(2)}%)`);
    console.log(`  volume: ${pctV}% of days differ by >25% (worst ${(worstVol * 100).toFixed(0)}%) ` +
      '— reported, not asserted; the closing auction sits outside the minute grid');
  }

  console.log('\n6. coverage per session — a thin day means a failed run, not a quiet market');
  const [cov] = await pool.query(`
    SELECT DATE(ts) d, COUNT(DISTINCT stock_code) tk, COUNT(*) n
      FROM idx_intraday_1m GROUP BY DATE(ts) ORDER BY d`);
  for (const r of cov) {
    console.log(`  ${r.d.toISOString().slice(0, 10)}  ${String(r.tk).padStart(4)} tickers  ${String(r.n).padStart(7)} bars`);
  }
  const med = cov.map(r => r.tk).sort((a, b) => a - b)[Math.floor(cov.length / 2)];
  const thin = cov.filter(r => r.tk < med * 0.5);
  if (thin.length) fail(`${thin.length} session(s) with under half the median ticker count (${med})`);
  else ok(`no session below half the median ticker count (${med})`);

  console.log('\n7. progress toward a testable sample');
  const need = 600;
  console.log(`  ${c.sessions} of ~${need} sessions for 30 non-overlapping 20-session anchors`);
  console.log(`  about ${Math.max(0, (need - c.sessions) / 21).toFixed(1)} more months at ~21 sessions/month`);

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nall checks passed');
  await pool.end();
  if (failures) process.exit(1);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
