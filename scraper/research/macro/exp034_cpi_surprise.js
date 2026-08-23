'use strict';
/**
 * EXP-034 — the single pre-registered hypothesis from
 * PREREGISTRATION_2026-08-21_cpi_surprise.md.
 *
 * H1: a US core CPI month-on-month print ABOVE consensus predicts a LOWER IHSG
 *     return in the first Jakarta session after the release.
 *     One-sided; direction fixed in advance.
 *
 * ── WHAT IS NEW, AND WHAT IS NOT ─────────────────────────────────────────────
 *
 * Not another indicator. EXP-030/031/032/033 tested four families of those and
 * none survived correction. What is new is `consensus`: every earlier test used
 * a realised level or change, which says something about the world, whereas a
 * surprise says what was NOT already priced. A 0.3% core print is bullish or
 * bearish depending only on whether 0.2% or 0.4% was expected.
 *
 * ── THE TIMING IS THE WHOLE DESIGN ───────────────────────────────────────────
 *
 * Core CPI is released 08:30 US Eastern = 20:30 Jakarta, AFTER the IDX close. So
 * the release-day close genuinely precedes the information and the first
 * tradeable reaction is the next session. Anchoring one day earlier would
 * measure a return that happened before the news -- which is exactly what the
 * feed's one-day filing offset would have caused if it had not been corrected
 * first.
 *
 * Usage: node scraper/research/macro/exp034_cpi_surprise.js
 */
const env = require('../env');
env.loadEnv();

const { createPool } = require('../../modules/db_config');
const stats = require('../../modules/statistics');

const FROM = '2016-08-01', TO = '2026-08-20';
const H_PRIMARY = 1;             // sessions
const H_SECONDARY = 5;

const iso = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** Spearman IC with a one-sided p toward the PREDICTED negative direction. */
function spearmanOneSided(xs, ys) {
  const n = xs.length;
  if (n < 8) return { ic: null, z: null, p: null, n };
  const rank = arr => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;                    // ties share the mean rank
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const ic = stats.correlation(rank(xs), rank(ys));
  if (!Number.isFinite(ic) || Math.abs(ic) >= 1) return { ic, z: null, p: null, n };
  const z = 0.5 * Math.log((1 + ic) / (1 - ic)) * Math.sqrt(n - 3);
  return { ic, z, p: Math.min(1, Math.max(0, stats.normalCDF(z))), n };
}

/**
 * Drop the earlier of a pair of identical releases on consecutive dates.
 *
 * The feed occasionally lists one release under two consecutive dates with the
 * same actual and consensus. The LATER is the real one: on that date the
 * weekday-fixed companions line up (MBA on a Wednesday, jobless claims on a
 * Thursday), and it is the date consistent with the filing convention the other
 * ~119 releases follow. Five pairs, named in the pre-registration.
 */
function dedupe(releases) {
  const dropped = [];
  const kept = releases.filter((r, i) => {
    const next = releases[i + 1];
    if (!next) return true;
    const gap = (new Date(next.date).getTime() - new Date(r.date).getTime()) / 86400000;
    const same = gap <= 2 && next.actual === r.actual && next.consensus === r.consensus;
    if (same) dropped.push(`${r.date} (superseded by ${next.date})`);
    return !same;
  });
  return { kept, dropped };
}

(async () => {
  const pool = createPool();

  // ── the IHSG session grid ─────────────────────────────────────────────────
  const [ihsg] = await pool.query(
    'SELECT date, close_price FROM idx_ihsg_history WHERE date BETWEEN ? AND ? ORDER BY date ASC',
    [FROM, TO]);
  const sessions = ihsg.map(r => ({ d: iso(r.date), c: Number(r.close_price) })).filter(s => s.c > 0);
  const dateIndex = new Map(sessions.map((s, i) => [s.d, i]));

  /** Index of the last session on or before `date`, or -1. */
  function lastSessionOnOrBefore(date) {
    if (dateIndex.has(date)) return dateIndex.get(date);
    let lo = 0, hi = sessions.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sessions[mid].d <= date) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }

  async function seriesFor(eventName) {
    const [rows] = await pool.query(`
      SELECT release_date, actual, consensus
        FROM ft_econ_calendar
       WHERE country = 'United States' AND event_name = ? AND measure = 'MOM'
         AND actual IS NOT NULL AND consensus IS NOT NULL
         AND release_date BETWEEN ? AND ?
       ORDER BY release_date ASC`, [eventName, FROM, TO]);
    return rows.map(r => ({
      date: iso(r.release_date),
      actual: Number(r.actual),
      consensus: Number(r.consensus),
      surprise: Number(r.actual) - Number(r.consensus),
    }));
  }

  /** Pair each release with the forward return over H sessions after it. */
  function pair(releases, H) {
    const out = [];
    for (const r of releases) {
      const i = lastSessionOnOrBefore(r.date);
      // The release-day close is the PRE-information anchor: 20:30 Jakarta is
      // after the close. i + H is the first (or Hth) session that could react.
      if (i < 0 || i + H >= sessions.length) continue;
      out.push({ ...r, fwd: sessions[i + H].c / sessions[i].c - 1, anchor: sessions[i].d });
    }
    return out;
  }

  console.log('EXP-034 — pre-registered: US core CPI ABOVE consensus  ->  IHSG DOWN next session');
  console.log('  one-sided, direction fixed in PREREGISTRATION_2026-08-21_cpi_surprise.md');
  console.log(`  window ${FROM} .. ${TO};  IHSG sessions ${sessions.length}`);
  console.log('  release 08:30 ET = 20:30 WIB, after the IDX close, so the release-day');
  console.log('  close is genuinely pre-information');
  console.log('  m = 1 hypothesis');
  console.log('');

  const raw = await seriesFor('Core CPI');
  const { kept, dropped } = dedupe(raw);
  console.log(`releases with actual AND consensus : ${raw.length}`);
  console.log(`duplicates dropped                 : ${dropped.length}`);
  dropped.forEach(d => console.log('    ' + d));
  const inLine = kept.filter(r => r.surprise === 0).length;
  console.log(`kept                               : ${kept.length}  (${inLine} came in exactly at consensus, and are KEPT)`);

  const primary = pair(kept, H_PRIMARY);
  const res = spearmanOneSided(primary.map(r => r.surprise), primary.map(r => r.fwd));

  console.log('');
  console.log('PRIMARY TEST');
  console.log(`  releases with both sessions : ${res.n}`);
  console.log(`  rank IC                     : ${res.ic === null ? 'n/a' : res.ic.toFixed(4)}`);
  console.log(`  z                           : ${res.z === null ? 'n/a' : res.z.toFixed(4)}`);
  console.log(`  one-sided p                 : ${res.p === null ? 'n/a' : res.p.toFixed(5)}`);
  const confirmed = res.p !== null && res.p < 0.05 && res.ic < 0;
  console.log(`  VERDICT                     : ${confirmed ? 'CONFIRMED' : 'NOT CONFIRMED'} against the pre-registered rule`);

  console.log('');
  console.log('SECONDARY (descriptive, NOT decisive — will not rescue a failed primary)');

  const h5 = pair(kept, H_SECONDARY);
  const r5 = spearmanOneSided(h5.map(r => r.surprise), h5.map(r => r.fwd));
  console.log(`  5-session horizon    : IC ${r5.ic === null ? 'n/a' : r5.ic.toFixed(4)}  p ${r5.p === null ? 'n/a' : r5.p.toFixed(4)}  n ${r5.n}`);

  const headRaw = await seriesFor('CPI');
  const head = pair(dedupe(headRaw).kept, H_PRIMARY);
  const rh = spearmanOneSided(head.map(r => r.surprise), head.map(r => r.fwd));
  console.log(`  headline CPI, 1 sess : IC ${rh.ic === null ? 'n/a' : rh.ic.toFixed(4)}  p ${rh.p === null ? 'n/a' : rh.p.toFixed(4)}  n ${rh.n}`);

  // The extremes, because an IC can hide a relationship that lives only in the tails.
  const withSurprise = primary.filter(r => r.surprise !== 0).sort((a, b) => a.surprise - b.surprise);
  const k = Math.max(1, Math.round(withSurprise.length / 10));
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  if (withSurprise.length >= 20) {
    const lo = withSurprise.slice(0, k), hi = withSurprise.slice(-k);
    console.log(`  biggest UNDERshoots  : n ${lo.length}, mean next-session ${(mean(lo.map(r => r.fwd)) * 100).toFixed(3)}%`);
    console.log(`  biggest OVERshoots   : n ${hi.length}, mean next-session ${(mean(hi.map(r => r.fwd)) * 100).toFixed(3)}%`);
    console.log(`  all releases         : n ${primary.length}, mean next-session ${(mean(primary.map(r => r.fwd)) * 100).toFixed(3)}%`);
  }

  console.log('');
  console.log('POWER, as registered: at this n the design detects |IC| >= ' +
    (function (n) { const z = 1.6449 / Math.sqrt(n - 3); return ((Math.exp(2 * z) - 1) / (Math.exp(2 * z) + 1)).toFixed(3); })(res.n) +
    ' one-sided.');
  console.log('  A null here means "not detectable at this size", not "absent".');
  console.log('');
  console.log('This sample is now spent.');

  await pool.end();
})().catch(env.fail);
