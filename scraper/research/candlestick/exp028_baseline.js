/**
 * EXP-028B — Unconditional Predictive Value.
 *
 * The first experiment that actually answers "does candlestick standalone have
 * an edge?". No context, no FlowTracker join — those are 028C and 028D. If a
 * pattern needs context to show anything, that is a finding, and this stage is
 * what establishes it had nothing on its own.
 *
 * FOUR THINGS THE METHOD REFUSES TO DO
 * ------------------------------------
 * 1. Pool ticker-days. The statistic is computed PER SESSION first. Every stock
 *    in a session shares that session's market, so 722,285 occurrences are
 *    nowhere near 722,285 independent observations — pooling them would shrink
 *    every confidence interval by a factor of roughly sqrt(names per session)
 *    and turn ordinary noise into a wall of significance.
 *
 * 2. Quote a daily CI at 3/5/10D. Overlapping forward windows make consecutive
 *    sessions serially correlated, so those CIs are too narrow by construction.
 *    Anchors are spaced on the EXCHANGE session index, the distinction EXP-026's
 *    P2 turned on.
 *
 * 3. Report a raw p-value from 14 patterns x 4 horizons. Benjamini-Hochberg
 *    across the declared family, with raw p, adjusted q, effect size, CI and n
 *    all shown — never q alone.
 *
 * 4. Mix directional interpretation. A bearish pattern that is followed by a
 *    fall is CORRECT, so its outcome is sign-flipped into "intended direction"
 *    before testing. Indecision patterns have no intended direction at all and
 *    are tested two-sided against zero without a flip, and labelled so nobody
 *    reads their sign as success.
 *
 * THE REPORT IS RUN TWICE, ON PURPOSE
 * -----------------------------------
 * Once on all resolved bars and once on geometry-reliable bars only (>= 5 ticks
 * of range). Measured 2026-08-15, that filter costs the Doji family two thirds
 * of its sample and the Engulfing family almost nothing — because "body under
 * 5% of range" is trivially satisfied on a 2-tick bar while a gap through
 * yesterday's low is not. Reporting only the full sample would let tick
 * resolution masquerade as a finding about doji; reporting only the reliable
 * subset would quietly delete half the data. Both, side by side, is the only
 * honest option, and the gap between them is itself a result.
 *
 * Usage: node research/candlestick/exp028_baseline.js [--json out.json] [--alpha 0.05]
 */
'use strict';
require('dotenv').config();

const fs = require('fs');
const mysql = require('mysql2/promise');
const cs = require('../../modules/cross_sectional');
const breakoutLib = require('../../modules/breakout');
const { PATTERNS, TAXONOMY_VERSION, taxonomyHash } = require('./pattern_taxonomy_v1');
const { oneSampleP, benjaminiHochberg, evidenceTier, nonOverlappingAnchors } = require('./multiple_testing');

const ANALYSIS_VERSION = 'exp028b-v1';
const HORIZONS = [1, 3, 5, 10];

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const iso = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const fmt = (v, dp = 3) => (v === null || v === undefined || !Number.isFinite(v) ? '    n/a' : v.toFixed(dp));

/** Bearish patterns are graded on falls; indecision patterns are not graded on sign at all. */
function intendedSign(direction) {
  if (direction.startsWith('BULLISH')) return 1;
  if (direction.startsWith('BEARISH')) return -1;
  return 0;   // INDECISION — two-sided, no intended direction
}

async function main() {
  const outFile = arg('json', null);
  const alpha = Number(arg('alpha', '0.05'));
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  const [ih] = await pool.query('SELECT date, close_price c FROM idx_ihsg_history ORDER BY date ASC');
  const axis = ih.map(r => iso(r.date));
  const ihsgClose = ih.map(r => Number(r.c));
  const idxOf = new Map(axis.map((d, i) => [d, i]));

  console.log('='.repeat(96));
  console.log(`EXP-028B — Unconditional Predictive Value of Candlestick Patterns`);
  console.log('='.repeat(96));
  console.log(`axis ${axis[0]} .. ${axis[axis.length - 1]} (${axis.length} canonical sessions)`);
  console.log(`taxonomy ${TAXONOMY_VERSION} sha256 ${taxonomyHash().slice(0, 16)}…\n`);

  // Which tickers and which source, taken from what the detector actually used.
  const [srcRows] = await pool.query(
    'SELECT stock_code c, source s, COUNT(*) n FROM idx_candlestick_bars GROUP BY stock_code, source');
  const srcOf = new Map(srcRows.map(r => [r.c, r.s]));
  const codes = [...srcOf.keys()].sort();
  console.log(`universe: ${codes.length} tickers (source recorded per ticker by the detector)`);

  // ── PASS A: universe mean forward return per session, per horizon ─────────
  // The cross-sectional benchmark. Accumulated over every eligible bar, not
  // only pattern bars, so "excess" means excess over the market that day.
  const sum = {}, cnt = {};
  for (const H of HORIZONS) { sum[H] = new Float64Array(axis.length); cnt[H] = new Int32Array(axis.length); }

  const closesFor = async (code) => {
    const table = srcOf.get(code);
    const [rows] = await pool.query(
      `SELECT date, open_price o, high_price h, low_price l, close_price c
         FROM ${table} WHERE stock_code = ? AND close_price > 0 ORDER BY date ASC`, [code]);
    const close = new Float64Array(axis.length).fill(NaN);
    const high = new Float64Array(axis.length).fill(NaN);
    const low = new Float64Array(axis.length).fill(NaN);
    for (const r of rows) {
      const i = idxOf.get(iso(r.date));
      if (i === undefined) continue;
      close[i] = Number(r.c); high[i] = Number(r.h); low[i] = Number(r.l);
    }
    return { close, high, low };
  };

  const t0 = Date.now();
  const priceCache = new Map();
  for (let k = 0; k < codes.length; k++) {
    const code = codes[k];
    const px = await closesFor(code);
    priceCache.set(code, px);
    for (let i = 0; i < axis.length; i++) {
      const c0 = px.close[i];
      if (!(c0 > 0)) continue;
      for (const H of HORIZONS) {
        const j = i + H;
        if (j >= axis.length) continue;
        const cj = px.close[j];
        if (!(cj > 0)) continue;
        sum[H][i] += (cj / c0 - 1) * 100;
        cnt[H][i] += 1;
      }
    }
    if ((k + 1) % 200 === 0) console.log(`  pass A ${k + 1}/${codes.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  const uniMean = {};
  for (const H of HORIZONS) {
    uniMean[H] = new Float64Array(axis.length).fill(NaN);
    for (let i = 0; i < axis.length; i++) if (cnt[H][i] >= 30) uniMean[H][i] = sum[H][i] / cnt[H][i];
  }
  const ihsgRet = {};
  for (const H of HORIZONS) {
    ihsgRet[H] = new Float64Array(axis.length).fill(NaN);
    for (let i = 0; i + H < axis.length; i++) {
      if (ihsgClose[i] > 0 && ihsgClose[i + H] > 0) ihsgRet[H][i] = (ihsgClose[i + H] / ihsgClose[i] - 1) * 100;
    }
  }

  // ── PASS B: occurrence outcomes, bucketed per pattern x horizon x session ──
  const [occ] = await pool.query(
    `SELECT stock_code c, session_date d, pattern_id p, geometry_reliable rel
       FROM idx_candlestick_occurrences ORDER BY stock_code`);
  console.log(`\noccurrences: ${occ.length.toLocaleString()}`);

  // acc[patternId][H][reliableOnly] = Map(sessionIndex -> {sum, n})
  const acc = {};
  const occCount = {}, occCountRel = {};
  const extra = {};    // pattern -> { mfe5, mae5, mfe10, mae10, pos, p3, p5, brkHit, brkN }
  for (const p of PATTERNS) {
    acc[p.id] = {};
    for (const H of HORIZONS) acc[p.id][H] = [new Map(), new Map()];
    occCount[p.id] = 0; occCountRel[p.id] = 0;
    extra[p.id] = { mfe5: [], mae5: [], mfe10: [], mae10: [], pos: 0, posN: 0, p3: 0, p5: 0, brkHit: 0, brkN: 0 };
  }

  const meta = new Map(PATTERNS.map(p => [p.id, p]));
  let lastCode = null, px = null, series = null;
  for (const o of occ) {
    const p = meta.get(o.p);
    if (!p) continue;
    if (o.c !== lastCode) {
      lastCode = o.c;
      px = priceCache.get(o.c);
      series = null;
    }
    if (!px) continue;
    const i = idxOf.get(iso(o.d));
    if (i === undefined) continue;
    const c0 = px.close[i];
    if (!(c0 > 0)) continue;

    const sign = intendedSign(p.direction);
    const rel = Number(o.rel) === 1;
    occCount[p.id]++; if (rel) occCountRel[p.id]++;

    for (const H of HORIZONS) {
      const j = i + H;
      if (j >= axis.length) continue;
      const cj = px.close[j];
      if (!(cj > 0) || !Number.isFinite(uniMean[H][i])) continue;
      const ret = (cj / c0 - 1) * 100;
      let excess = ret - uniMean[H][i];
      // Intended direction: a bearish pattern followed by a fall is a HIT.
      if (sign === -1) excess = -excess;
      for (const which of rel ? [0, 1] : [0]) {
        const m = acc[p.id][H][which];
        const e = m.get(i) || { s: 0, n: 0 };
        e.s += excess; e.n += 1; m.set(i, e);
      }
    }

    // Descriptive extras, 5D-anchored (spec section 7).
    const j5 = i + 5, j10 = i + 10;
    if (j5 < axis.length) {
      let mfe = -Infinity, mae = Infinity;
      for (let k = i + 1; k <= j5; k++) {
        if (Number.isFinite(px.high[k])) mfe = Math.max(mfe, (px.high[k] / c0 - 1) * 100);
        if (Number.isFinite(px.low[k])) mae = Math.min(mae, (px.low[k] / c0 - 1) * 100);
      }
      if (Number.isFinite(mfe)) extra[p.id].mfe5.push(sign === -1 ? -mae : mfe);
      if (Number.isFinite(mae)) extra[p.id].mae5.push(sign === -1 ? -mfe : mae);
      const r5 = (px.close[j5] / c0 - 1) * 100;
      if (Number.isFinite(r5)) {
        const dirRet = sign === -1 ? -r5 : r5;
        extra[p.id].posN++;
        if (dirRet > 0) extra[p.id].pos++;
        if (dirRet >= 3) extra[p.id].p3++;
        if (dirRet >= 5) extra[p.id].p5++;
      }
    }
    if (j10 < axis.length) {
      let mfe = -Infinity, mae = Infinity;
      for (let k = i + 1; k <= j10; k++) {
        if (Number.isFinite(px.high[k])) mfe = Math.max(mfe, (px.high[k] / c0 - 1) * 100);
        if (Number.isFinite(px.low[k])) mae = Math.min(mae, (px.low[k] / c0 - 1) * 100);
      }
      if (Number.isFinite(mfe)) extra[p.id].mfe10.push(sign === -1 ? -mae : mfe);
      if (Number.isFinite(mae)) extra[p.id].mae10.push(sign === -1 ? -mfe : mae);
    }

    // EXP-025 genuine breakout, through the canonical helper — never a fourth
    // re-description of a contract that has already been got wrong twice.
    if (sign >= 0) {
      if (!series) {
        series = new Map();
        for (let k = 0; k < axis.length; k++) if (px.close[k] > 0) series.set(axis[k], { c: px.close[k] });
      }
      const bk = breakoutLib.genuineBreakout(series, axis, i);
      if (bk !== null) { extra[p.id].brkN++; if (bk.winner) extra[p.id].brkHit++; }
    }
  }

  // ── statistics ────────────────────────────────────────────────────────────
  const rows = [];
  for (const p of PATTERNS) {
    for (const H of HORIZONS) {
      for (const which of [0, 1]) {
        const m = acc[p.id][H][which];
        // One value per SESSION: the mean intended-excess of that session's
        // occurrences. This is the unit every CI below rests on.
        const perSession = [...m.entries()]
          .map(([sessionIndex, e]) => ({ sessionIndex, v: e.s / e.n, n: e.n }))
          .sort((a, b) => a.sessionIndex - b.sessionIndex);
        const used = H === 1 ? perSession : nonOverlappingAnchors(perSession, H);
        const vals = used.map(r => r.v);
        const test = oneSampleP(vals);
        const ci = cs.bootstrapMeanCI(vals, { resamples: 2000, seed: 42 });
        rows.push({
          patternId: p.id, family: p.family, direction: p.direction, horizon: H,
          sample: which === 0 ? 'all' : 'reliable',
          occurrences: which === 0 ? occCount[p.id] : occCountRel[p.id],
          sessions: vals.length,
          basis: H === 1 ? 'daily (no overlap at H=1)' : `non-overlapping, >= ${H} canonical sessions apart`,
          meanIntendedExcess: test.mean, ci: ci.lower === null ? null : { lower: ci.lower, upper: ci.upper },
          p: test.p, q: null, rejected: false,
          tier: evidenceTier(which === 0 ? occCount[p.id] : occCountRel[p.id]),
          twoSidedOnly: intendedSign(p.direction) === 0,
        });
      }
    }
  }

  // BH inside each declared family: the two samples are separate screens, and
  // pooling them would test every pattern twice under one denominator.
  const famAll = rows.filter(r => r.sample === 'all');
  const famRel = rows.filter(r => r.sample === 'reliable');
  const bhAll = benjaminiHochberg(famAll, alpha);
  const bhRel = benjaminiHochberg(famRel, alpha);

  // ── report ────────────────────────────────────────────────────────────────
  for (const [label, fam, bh] of [['ALL RESOLVED BARS', famAll, bhAll], ['GEOMETRY-RELIABLE BARS ONLY', famRel, bhRel]]) {
    console.log('\n' + '='.repeat(96));
    console.log(`${label}  —  Benjamini-Hochberg over ${bh.m} tests, alpha ${alpha}, ${bh.rejected} rejected`);
    console.log('='.repeat(96));
    console.log('pattern                  H   occ    sess   mean%   95% CI              raw p     q      tier');
    console.log('-'.repeat(96));
    for (const p of PATTERNS) {
      for (const r of fam.filter(x => x.patternId === p.id)) {
        const ciS = r.ci ? `[${fmt(r.ci.lower)},${fmt(r.ci.upper)}]`.padEnd(19) : ' '.repeat(19);
        console.log(
          `${r.patternId.padEnd(22)} ${String(r.horizon).padStart(2)}D ${String(r.occurrences).padStart(6)} ` +
          `${String(r.sessions).padStart(6)} ${fmt(r.meanIntendedExcess).padStart(7)} ${ciS} ` +
          `${fmt(r.p, 4).padStart(8)} ${fmt(r.q, 4).padStart(7)} ${r.rejected ? '*' : ' '} ${r.tier}`);
      }
    }
  }

  console.log('\n' + '='.repeat(96));
  console.log('DESCRIPTIVE, NOT INFERENTIAL — pooled over occurrences, no CI, do not quote as evidence');
  console.log('='.repeat(96));
  console.log('pattern                  MFE5%    MAE5%   P(dir>0)  P(>=3%)  P(>=5%)  EXP025 breakout');
  for (const p of PATTERNS) {
    const e = extra[p.id];
    const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
    const pc = (a, b) => (b ? (a / b * 100) : null);
    console.log(
      `${p.id.padEnd(22)} ${fmt(mean(e.mfe5), 2).padStart(7)} ${fmt(mean(e.mae5), 2).padStart(8)} ` +
      `${fmt(pc(e.pos, e.posN), 1).padStart(8)}% ${fmt(pc(e.p3, e.posN), 1).padStart(7)}% ` +
      `${fmt(pc(e.p5, e.posN), 1).padStart(7)}% ` +
      `${e.brkN ? `${fmt(pc(e.brkHit, e.brkN), 2)}% of ${e.brkN}` : 'n/a (bearish)'}`);
  }

  const jsonOut = {
    analysisVersion: ANALYSIS_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    taxonomyHash: taxonomyHash(),
    axis: { from: axis[0], to: axis[axis.length - 1], sessions: axis.length },
    universeTickers: codes.length,
    horizons: HORIZONS,
    alpha,
    fdr: { all: bhAll, reliable: bhRel },
    rows,
    breakoutDefinition: `modules/breakout.js: forward ${breakoutLib.HORIZON_SESSIONS}-session return >= +${breakoutLib.WIN_THRESHOLD_PCT}% AND exit close > max close over the ${breakoutLib.HIGH_LOOKBACK} sessions STRICTLY BEFORE entry`,
    generatedNote: 'Session-level statistics; 3/5/10D use non-overlapping canonical anchors; bearish outcomes sign-flipped to intended direction; indecision patterns two-sided.',
  };
  if (outFile) { fs.writeFileSync(outFile, JSON.stringify(jsonOut, null, 1)); console.log(`\nJSON -> ${outFile}`); }

  console.log('\n' + '='.repeat(96));
  console.log('READ BEFORE QUOTING');
  console.log('='.repeat(96));
  console.log('  - N for every CI is SESSIONS, not occurrences. The occurrence count is shown');
  console.log('    because the evidence tier is defined on it, not because it sizes the test.');
  console.log('  - "mean%" is excess over the same session\'s universe mean, sign-flipped into the');
  console.log('    pattern\'s INTENDED direction. A positive number means the textbook was right.');
  console.log('  - INDECISION patterns have no intended direction; their sign carries no verdict.');
  console.log('  - This is UNCONDITIONAL. A pattern flat here may still be conditional (EXP-028C).');
  console.log('  - No OOS split yet. Nothing here is a validated result — it is a screen.');
  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
