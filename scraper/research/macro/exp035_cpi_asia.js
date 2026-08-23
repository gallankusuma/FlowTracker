'use strict';
/**
 * EXP-035 — the single pre-registered hypothesis from
 * PREREGISTRATION_2026-08-21_cpi_asia.md.
 *
 * H1: a US core CPI month-on-month print ABOVE consensus predicts a LOWER return
 *     on a basket of Asian indices in the first session each trades after the
 *     release. One-sided; direction fixed in advance.
 *
 * ── WHY THIS RUNS AT ALL ─────────────────────────────────────────────────────
 *
 * EXP-034 confirmed the same mechanism on IHSG, and cleared narrowly: IC -0.1658,
 * p 0.0358, n 119, against a registered power floor of 0.152. One one-sided test
 * at p = 0.036 is a result, not an edge.
 *
 * EXP-031 established the cure and it is the most useful method in this project:
 * waiting for fresh Indonesian data needs a decade to double n, while moving
 * ACROSS MARKETS costs nothing and asks the sharper question. An effect that
 * exists only where it was discovered was never there -- which is precisely how
 * the USDIDR hint from EXP-030 was falsified.
 *
 * ── THE STATISTIC, AND WHY IT IS NOT STOUFFER ────────────────────────────────
 *
 * This is the EXP-033 problem, not the EXP-031 one. EXP-031 could combine nine
 * markets with Stouffer because each had its OWN currency and so was an
 * independent test of a LOCAL mechanism. This predictor is GLOBAL: one US release
 * against several co-moving Asian markets is not N independent tests, and
 * combining per-market z-scores would overstate significance for exactly the
 * reason overlapping windows do.
 *
 * So the unit of observation is the RELEASE DATE. The markets are averaged into
 * one equal-weighted basket, one IC is computed, and n is the number of releases.
 * Averaging is also what gives the test power: idiosyncratic local noise cancels
 * while a common reaction does not.
 *
 * Usage: node scraper/research/macro/exp035_cpi_asia.js
 */
const fs = require('fs');
const path = require('path');
const env = require('../env');
env.loadEnv();

const { createPool } = require('../../modules/db_config');
const stats = require('../../modules/statistics');

const FROM = '2016-08-01', TO = '2026-08-20';
const DATA = path.join(__dirname, 'exp035_data.json');
const MARKETS = ['^TWII', '^STI', '^HSI', '000001.SS', '^N225'];
const MAX_GAP_DAYS = 5;      // a next session further out than this is a holiday hole
const MIN_MARKETS = 3;       // a release needs most of the basket to count

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

/** The same five duplicate pairs EXP-034 dropped, by the same rule: keep the later. */
function dedupe(releases) {
  return releases.filter((r, i) => {
    const next = releases[i + 1];
    if (!next) return true;
    const gap = (new Date(next.date).getTime() - new Date(r.date).getTime()) / 86400000;
    return !(gap <= 2 && next.actual === r.actual && next.consensus === r.consensus);
  });
}

(async () => {
  if (!fs.existsSync(DATA)) {
    console.error('Missing ' + DATA + '\nFetch first: .venv/bin/python3 research/macro/exp035_fetch.py');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const pool = createPool();

  // ── the predictor: the IDENTICAL series EXP-034 used, not a re-derivation ──
  const [rows] = await pool.query(`
    SELECT release_date, actual, consensus
      FROM ft_econ_calendar
     WHERE country = 'United States' AND event_name = 'Core CPI' AND measure = 'MOM'
       AND actual IS NOT NULL AND consensus IS NOT NULL
       AND release_date BETWEEN ? AND ?
     ORDER BY release_date ASC`, [FROM, TO]);
  const releases = dedupe(rows.map(r => ({
    date: iso(r.release_date),
    actual: Number(r.actual),
    consensus: Number(r.consensus),
    surprise: Number(r.actual) - Number(r.consensus),
  })));

  // ── each market's own session grid ────────────────────────────────────────
  const grid = {};
  for (const m of MARKETS) {
    const s = (raw[m] || []).filter(r => r.d >= '2016-07-01').sort((a, b) => (a.d < b.d ? -1 : 1));
    grid[m] = s;
  }

  /**
   * The return of one market over the first session it trades AFTER `date`.
   *
   * The release is 08:30 US Eastern, which is evening across Asia, so the last
   * session on or before the release date has already closed with the news still
   * unpublished -- it is the pre-information anchor. Its successor is the first
   * session that can react.
   */
  function nextSessionReturn(sessions, date) {
    let lo = 0, hi = sessions.length - 1, at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sessions[mid].d <= date) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (at < 0 || at + 1 >= sessions.length) return null;
    const a = sessions[at], b = sessions[at + 1];
    // A next session further out than MAX_GAP_DAYS is a holiday hole, not a
    // reaction. Carrying it forward would attribute a week of unrelated news to
    // one release.
    const gap = (new Date(b.d).getTime() - new Date(date + 'T00:00:00Z').getTime()) / 86400000;
    if (gap > MAX_GAP_DAYS) return null;
    return b.c / a.c - 1;
  }

  console.log('EXP-035 — pre-registered: does the EXP-034 effect exist outside Indonesia?');
  console.log('  US core CPI ABOVE consensus  ->  Asian basket DOWN in its next session');
  console.log('  one-sided, direction fixed in PREREGISTRATION_2026-08-21_cpi_asia.md');
  console.log(`  basket : ${MARKETS.join(', ')}  (never read by this project)`);
  console.log('  m = 1; the unit of observation is the RELEASE DATE, not market x date');
  console.log('');
  for (const m of MARKETS) {
    const s = grid[m];
    console.log(`  ${m.padEnd(11)} ${String(s.length).padStart(5)} sessions  ${s.length ? s[0].d + ' .. ' + s[s.length - 1].d : '(none)'}`);
  }
  console.log('');
  console.log(`core CPI releases after dedup : ${releases.length}`);

  // ── the basket, one row per release ───────────────────────────────────────
  const anchors = [];
  let droppedThin = 0;
  for (const r of releases) {
    const per = MARKETS.map(m => nextSessionReturn(grid[m], r.date));
    const have = per.filter(v => v !== null);
    if (have.length < MIN_MARKETS) { droppedThin++; continue; }
    anchors.push({ ...r, basket: stats.mean(have), per, available: have.length });
  }
  console.log(`releases with >= ${MIN_MARKETS} markets  : ${anchors.length}  (${droppedThin} dropped as too thin)`);
  const inLine = anchors.filter(a => a.surprise === 0).length;
  console.log(`  of those, exactly at consensus: ${inLine}  (KEPT — they are real "no surprise" observations)`);

  const primary = spearmanOneSided(anchors.map(a => a.surprise), anchors.map(a => a.basket));

  console.log('');
  console.log('PRIMARY TEST — one IC, equal-weighted Asian basket');
  console.log(`  releases (n)     : ${primary.n}`);
  console.log(`  rank IC          : ${primary.ic === null ? 'n/a' : primary.ic.toFixed(4)}`);
  console.log(`  z                : ${primary.z === null ? 'n/a' : primary.z.toFixed(4)}`);
  console.log(`  one-sided p      : ${primary.p === null ? 'n/a' : primary.p.toFixed(5)}`);
  const replicated = primary.p !== null && primary.p < 0.05 && primary.ic < 0;
  console.log(`  VERDICT          : ${replicated ? 'REPLICATED' : 'NOT REPLICATED'} against the pre-registered rule`);
  console.log(`  (EXP-034 on IHSG was IC -0.1658, p 0.0358, n 119)`);

  console.log('');
  console.log('SECONDARY (descriptive, NOT decisive — will not rescue a failed primary)');
  console.log('  market        n     IC');
  let neg = 0;
  MARKETS.forEach((m, k) => {
    const pairs = anchors.filter(a => a.per[k] !== null);
    const r = spearmanOneSided(pairs.map(a => a.surprise), pairs.map(a => a.per[k]));
    if (Number.isFinite(r.ic) && r.ic < 0) neg++;
    console.log('  ' + m.padEnd(12) + String(r.n).padStart(4) + '   ' +
      (r.ic === null ? 'n/a' : (r.ic >= 0 ? ' ' : '') + r.ic.toFixed(4)));
  });
  console.log(`  ${neg} of ${MARKETS.length} negative`);

  // The tails, for the same reason EXP-034 reported them: an IC can hide a
  // relationship that lives only in the extremes.
  const withSurprise = anchors.filter(a => a.surprise !== 0).sort((a, b) => a.surprise - b.surprise);
  if (withSurprise.length >= 20) {
    const k = Math.max(1, Math.round(withSurprise.length / 10));
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    console.log(`  biggest UNDERshoots : n ${k}, mean basket ${(mean(withSurprise.slice(0, k).map(a => a.basket)) * 100).toFixed(3)}%`);
    console.log(`  biggest OVERshoots  : n ${k}, mean basket ${(mean(withSurprise.slice(-k).map(a => a.basket)) * 100).toFixed(3)}%`);
    console.log(`  all releases        : n ${anchors.length}, mean basket ${(mean(anchors.map(a => a.basket)) * 100).toFixed(3)}%`);
  }

  console.log('');
  const floor = (function (n) { const z = 1.6449 / Math.sqrt(n - 3); return ((Math.exp(2 * z) - 1) / (Math.exp(2 * z) + 1)); })(primary.n);
  console.log(`POWER, as registered: detects |IC| >= ${floor.toFixed(3)} one-sided.`);
  console.log('  A null with a NEGATIVE IC falsifies nothing — at this n the test would');
  console.log('  clear 0.05 only about half the time even if the effect were exactly');
  console.log('  EXP-034\'s size. Only a POSITIVE basket IC is real counter-evidence.');
  console.log('');
  console.log('This sample is now spent.');

  await pool.end();
})().catch(env.fail);
