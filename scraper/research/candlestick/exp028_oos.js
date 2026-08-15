/**
 * EXP-028 OOS — chronological split, and an honest account of what it can prove.
 *
 * Section 16: never shuffle a time series, split it by time, and keep a final
 * holdout that is not opened for tuning.
 *
 * WHAT THIS RUN CAN AND CANNOT CLAIM
 * ----------------------------------
 * EXP-028B, C and E were all computed over the WHOLE sample, 2016-2026. Declaring
 * a holdout now and calling it untouched would be false: those sessions have
 * already contributed to results that have been read, discussed and committed.
 * So this is a CONSISTENCY CHECK across time, not a virgin out-of-sample test,
 * and it is labelled that way throughout.
 *
 * One thing does work in its favour, and it is not small. The taxonomy's
 * thresholds came from Nison and Bulkowski and were frozen before any of this
 * data was touched — the review's "threshold final jangan ditentukan dari
 * backtest" was followed. There is therefore no fitted parameter to overfit
 * with. The residual risk is SELECTION: having seen the full-sample table, a
 * report that now says "Dark Cloud Cover survives OOS" is choosing its subject
 * after seeing the answer. That is why every pattern is reported here, not only
 * the ones that looked good.
 *
 * THE HOLDOUT GUARD IS REAL EVEN THOUGH THIS SAMPLE IS SPENT. The final segment
 * refuses to compute unless --open-holdout is passed, and the refusal prints why.
 * The 14 patterns here have already burned it; the 101-pattern taxonomy has not,
 * and by the time it lands the discipline needs to be in the code rather than in
 * someone's memory of a conversation.
 *
 * The split boundaries are frozen by digest, for the reason EXP-026 taught the
 * hard way two days ago: a window that lives only in prose moves without anyone
 * touching the source.
 *
 * Usage: node research/candlestick/exp028_oos.js [--horizon 5] [--json out.json]
 *                                               [--open-holdout]
 */
'use strict';
require('dotenv').config();

const fs = require('fs');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const cs = require('../../modules/cross_sectional');
const { PATTERNS, TAXONOMY_VERSION, taxonomyHash } = require('./pattern_taxonomy_v1');
const { oneSampleP, benjaminiHochberg, evidenceTier, nonOverlappingAnchors } = require('./multiple_testing');

const ANALYSIS_VERSION = 'exp028oos-v1';

/** Fractions of the canonical axis, frozen. Changing these mints a new version. */
const SPLIT_V1 = Object.freeze({ discovery: 0.60, validation: 0.20, holdout: 0.20 });
const SPLIT_VERSION = 'oos-v1/60-20-20-chronological';

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const iso = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const fmt = (v, dp = 3) => (v === null || v === undefined || !Number.isFinite(v) ? '   n/a' : v.toFixed(dp));

function intendedSign(direction) {
  if (direction.startsWith('BULLISH')) return 1;
  if (direction.startsWith('BEARISH')) return -1;
  return 0;
}

async function main() {
  const H = parseInt(arg('horizon', '5'), 10);
  const outFile = arg('json', null);
  const alpha = Number(arg('alpha', '0.05'));
  const openHoldout = process.argv.includes('--open-holdout');
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  const [ih] = await pool.query('SELECT date FROM idx_ihsg_history ORDER BY date ASC');
  const axis = ih.map(r => iso(r.date));
  const idxOf = new Map(axis.map((d, i) => [d, i]));
  const N = axis.length;

  const dEnd = Math.floor(N * SPLIT_V1.discovery);
  const vEnd = Math.floor(N * (SPLIT_V1.discovery + SPLIT_V1.validation));
  const segments = [
    { name: 'DISCOVERY', from: 0, to: dEnd },
    { name: 'VALIDATION', from: dEnd, to: vEnd },
    { name: 'FINAL_HOLDOUT', from: vEnd, to: N },
  ];
  const splitHash = crypto.createHash('sha256')
    .update(`${SPLIT_VERSION}|${axis[0]}|${axis[N - 1]}|${N}|${dEnd}|${vEnd}`).digest('hex');

  console.log('='.repeat(100));
  console.log(`EXP-028 OOS — chronological split   (horizon ${H}D)`);
  console.log('='.repeat(100));
  console.log(`split ${SPLIT_VERSION} sha256 ${splitHash.slice(0, 16)}…`);
  for (const s of segments) {
    console.log(`  ${s.name.padEnd(14)} ${axis[s.from]} .. ${axis[s.to - 1]}  (${s.to - s.from} sessions)` +
      (s.name === 'FINAL_HOLDOUT' && !openHoldout ? '   [SEALED]' : ''));
  }
  console.log(`taxonomy ${TAXONOMY_VERSION} sha256 ${taxonomyHash().slice(0, 16)}…\n`);

  console.log('THIS IS A CONSISTENCY CHECK, NOT A VIRGIN OUT-OF-SAMPLE TEST.');
  console.log('EXP-028B/C/E were computed over the whole 2016-2026 sample, so these sessions have');
  console.log('already informed results that were read and committed. What the split can still show');
  console.log('is whether an effect holds in both halves of the decade or only one. Thresholds were');
  console.log('frozen from reference before any data was seen, so there is no fitted parameter to');
  console.log('overfit — the live risk is SELECTION, which is why every pattern is reported below.\n');

  const [srcRows] = await pool.query('SELECT stock_code c, source s FROM idx_candlestick_bars GROUP BY stock_code, source');
  const srcOf = new Map(srcRows.map(r => [r.c, r.s]));
  const codes = [...srcOf.keys()].sort();

  const [occ] = await pool.query('SELECT stock_code c, session_date d, pattern_id p FROM idx_candlestick_occurrences');
  const occOf = new Map();
  for (const o of occ) {
    const i = idxOf.get(iso(o.d));
    if (i === undefined) continue;
    let m = occOf.get(o.c);
    if (!m) { m = new Map(); occOf.set(o.c, m); }
    let s = m.get(i);
    if (!s) { s = new Set(); m.set(i, s); }
    s.add(o.p);
  }

  // universe mean per session, computed once over the whole axis: the benchmark
  // is the market that day and does not belong to a segment.
  const sum = new Float64Array(N), cnt = new Int32Array(N);
  const cache = new Map();
  for (const code of codes) {
    const [rows] = await pool.query(
      `SELECT date, close_price c FROM ${srcOf.get(code)} WHERE stock_code = ? AND close_price > 0 ORDER BY date ASC`, [code]);
    const close = new Float64Array(N).fill(NaN);
    for (const r of rows) { const i = idxOf.get(iso(r.date)); if (i !== undefined) close[i] = Number(r.c); }
    cache.set(code, close);
    for (let i = 0; i + H < N; i++) {
      const a = close[i], b = close[i + H];
      if (a > 0 && b > 0) { sum[i] += (b / a - 1) * 100; cnt[i] += 1; }
    }
  }
  const uni = new Float64Array(N).fill(NaN);
  for (let i = 0; i < N; i++) if (cnt[i] >= 30) uni[i] = sum[i] / cnt[i];

  // acc[segment][patternId] -> Map(sessIdx -> {s,n})
  const acc = {};
  for (const s of segments) { acc[s.name] = {}; for (const p of PATTERNS) acc[s.name][p.id] = new Map(); }
  const segOf = (i) => (i < dEnd ? 'DISCOVERY' : i < vEnd ? 'VALIDATION' : 'FINAL_HOLDOUT');
  const signOf = new Map(PATTERNS.map(p => [p.id, intendedSign(p.direction)]));

  for (const code of codes) {
    const close = cache.get(code);
    const hits = occOf.get(code);
    if (!hits) continue;
    for (const [i, set] of hits) {
      if (i + H >= N) continue;
      const c0 = close[i], cH = close[i + H];
      if (!(c0 > 0) || !(cH > 0) || !Number.isFinite(uni[i])) continue;
      const raw = (cH / c0 - 1) * 100 - uni[i];
      const seg = segOf(i);
      for (const pid of set) {
        const sign = signOf.get(pid);
        if (sign === undefined) continue;
        const v = sign === -1 ? -raw : raw;
        const m = acc[seg][pid];
        const e = m.get(i) || { s: 0, n: 0 };
        e.s += v; e.n += 1; m.set(i, e);
      }
    }
  }

  const statFor = (map) => {
    const perSession = [...map.entries()].map(([sessionIndex, e]) => ({ sessionIndex, v: e.s / e.n, n: e.n }))
      .sort((a, b) => a.sessionIndex - b.sessionIndex);
    const used = H === 1 ? perSession : nonOverlappingAnchors(perSession, H);
    const vals = used.map(r => r.v);
    const test = oneSampleP(vals);
    const ci = cs.bootstrapMeanCI(vals, { resamples: 2000, seed: 42 });
    return {
      occurrences: perSession.reduce((a, r) => a + r.n, 0), sessions: vals.length,
      mean: test.mean, ci: ci.lower === null ? null : { lower: ci.lower, upper: ci.upper }, p: test.p,
    };
  };

  const results = [];
  for (const p of PATTERNS) {
    const row = { patternId: p.id, direction: p.direction, twoSidedOnly: signOf.get(p.id) === 0 };
    for (const s of segments) {
      if (s.name === 'FINAL_HOLDOUT' && !openHoldout) { row[s.name] = null; continue; }
      row[s.name] = statFor(acc[s.name][p.id]);
    }
    results.push(row);
  }

  // FDR is applied WITHIN the validation segment: that is the family being asked
  // "does this still hold?", and pooling segments would test the same pattern
  // twice under one denominator.
  const valEntries = results.map(r => ({ ref: r, p: r.VALIDATION ? r.VALIDATION.p : null }));
  const bhVal = benjaminiHochberg(valEntries, alpha);
  for (const e of valEntries) { e.ref.validationQ = e.q; e.ref.validationRejected = e.rejected; }

  console.log('='.repeat(100));
  console.log(`PER-PATTERN, BOTH OPEN SEGMENTS (${H}D, intended direction) — every pattern shown, not a shortlist`);
  console.log(`Benjamini-Hochberg within VALIDATION over ${bhVal.m} tests — ${bhVal.rejected} rejected`);
  console.log('='.repeat(100));
  console.log('pattern                 DISCOVERY            VALIDATION           agree?  val q');
  console.log('                          mean    n_sess       mean    n_sess');
  console.log('-'.repeat(100));
  for (const r of results) {
    const d = r.DISCOVERY, v = r.VALIDATION;
    const agree = (d.mean !== null && v.mean !== null && Math.sign(d.mean) === Math.sign(v.mean)) ? 'YES' : 'no ';
    console.log(`${r.patternId.padEnd(22)} ${fmt(d.mean).padStart(8)} ${String(d.sessions).padStart(7)}   ` +
      `${fmt(v.mean).padStart(8)} ${String(v.sessions).padStart(7)}     ${agree}  ${fmt(r.validationQ, 4).padStart(7)} ${r.validationRejected ? '*' : ' '}` +
      `${r.twoSidedOnly ? '  [indecision]' : ''}`);
  }

  const held = results.filter(r => r.validationRejected && Math.sign(r.DISCOVERY.mean) === Math.sign(r.VALIDATION.mean));
  console.log('\n' + '='.repeat(100));
  console.log('SAME SIGN IN BOTH SEGMENTS **AND** SURVIVES FDR IN VALIDATION');
  console.log('='.repeat(100));
  if (!held.length) console.log('  (none)');
  for (const r of held) {
    console.log(`  ${r.patternId.padEnd(22)} discovery ${fmt(r.DISCOVERY.mean)}%  validation ${fmt(r.VALIDATION.mean)}%  q=${fmt(r.validationQ, 4)}` +
      `${r.twoSidedOnly ? '  [indecision — sign carries no verdict]' : ''}`);
  }

  if (!openHoldout) {
    console.log('\n' + '='.repeat(100));
    console.log('FINAL HOLDOUT: NOT COMPUTED');
    console.log('='.repeat(100));
    console.log(`  ${axis[vEnd]} .. ${axis[N - 1]} (${N - vEnd} sessions) was not touched by this run.`);
    console.log('  Section 16: "Final holdout jangan dibuka untuk tuning." Opening it to see how a');
    console.log('  result looks IS tuning, whatever it is called afterwards.');
    console.log('  For the 14 fixture patterns the holdout is already spent — EXP-028B/C/E covered');
    console.log('  the full sample. The guard is here for the 101-pattern taxonomy, whose');
    console.log('  definitions will be frozen before it runs. Pass --open-holdout only when a');
    console.log('  result is being CONFIRMED, once, and never to choose between candidates.');
  }

  const jsonOut = {
    analysisVersion: ANALYSIS_VERSION, taxonomyVersion: TAXONOMY_VERSION, taxonomyHash: taxonomyHash(),
    splitVersion: SPLIT_VERSION, splitHash, holdoutOpened: openHoldout,
    horizon: H, alpha,
    segments: segments.map(s => ({ ...s, fromDate: axis[s.from], toDate: axis[s.to - 1], sessions: s.to - s.from })),
    validationFdr: bhVal, results,
    caveat: 'Consistency check across time, not a virgin OOS test: EXP-028B/C/E were computed over the full sample. Thresholds were frozen from reference before any data was seen, so no parameter was fitted; the residual risk is selection.',
  };
  if (outFile) { fs.writeFileSync(outFile, JSON.stringify(jsonOut, null, 1)); console.log(`\nJSON -> ${outFile}`); }
  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
