/**
 * EXP-028C — Single-factor context conditionality, and the incremental test.
 *
 * EXP-028B left one question unanswerable by its own design. Hammer is DEFINED
 * to occur after a decline, so measuring its occurrences against the whole
 * universe mixes "this shape appeared" with "this stock had been falling". Its
 * -0.80% 5D excess could be entirely the second thing.
 *
 * Section 13 is what settles it, and the review is emphatic that it is not
 * optional: "Jangan cuma bilang Hammer + strong setup bagus. Strong setup
 * sendiri mungkin memang sudah bagus." So every number below is a DIFFERENCE:
 *
 *     incremental = mean(context AND pattern) - mean(context AND NOT pattern)
 *
 * measured WITHIN each session. Comparing inside a session removes the market
 * day entirely — both sides lived through the same tape — and comparing inside
 * a context bucket removes the situation. What survives is the candle's own
 * contribution, which is the only thing EXP-028 was ever asking about.
 *
 * The control is "same context, no pattern" rather than "same context,
 * everything". Letting the pattern into its own baseline dilutes the very
 * difference being measured, and for a common pattern like Doji at 16% of bars
 * that dilution is not small.
 *
 * ONE FACTOR AT A TIME. Section 11 is explicit: Pattern x Trend, Pattern x
 * Location, Pattern x Volume, Pattern x Volatility — and NOT all of them at
 * once, because "kalau langsung begitu kita akan curve-fit". Buckets are
 * three-way for the same reason; twenty thin cells per pattern is combination
 * research wearing a single-factor label.
 *
 * Statistics follow EXP-028B exactly: session-level units, non-overlapping
 * canonical anchors above 1D, Benjamini-Hochberg across the family, and bearish
 * patterns sign-flipped into intended direction before anything is tested.
 *
 * Usage: node research/candlestick/exp028_context.js [--horizon 5] [--json out.json]
 */
'use strict';
require('dotenv').config();

const fs = require('fs');
const mysql = require('mysql2/promise');
const cs = require('../../modules/cross_sectional');
const { PATTERNS, TAXONOMY_VERSION, taxonomyHash } = require('./pattern_taxonomy_v1');
const { contextAt, bucketise, priorAtrSeries } = require('./context_features');
const { oneSampleP, benjaminiHochberg, evidenceTier, nonOverlappingAnchors } = require('./multiple_testing');

const ANALYSIS_VERSION = 'exp028c-v1';
const FACTORS = ['TREND', 'LOCATION', 'VOLUME', 'VOLATILITY'];
const MIN_SESSIONS = 30;      // below this the cell is not testable at all

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
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  const [ih] = await pool.query('SELECT date FROM idx_ihsg_history ORDER BY date ASC');
  const axis = ih.map(r => iso(r.date));
  const idxOf = new Map(axis.map((d, i) => [d, i]));

  console.log('='.repeat(100));
  console.log(`EXP-028C — Single-factor context conditionality + incremental test   (horizon ${H}D)`);
  console.log('='.repeat(100));
  console.log(`axis ${axis[0]} .. ${axis[axis.length - 1]} (${axis.length} sessions)`);
  console.log(`taxonomy ${TAXONOMY_VERSION} sha256 ${taxonomyHash().slice(0, 16)}…\n`);

  const [srcRows] = await pool.query('SELECT stock_code c, source s FROM idx_candlestick_bars GROUP BY stock_code, source');
  const srcOf = new Map(srcRows.map(r => [r.c, r.s]));
  const codes = [...srcOf.keys()].sort();

  // occurrences as a lookup: code -> sessionIndex -> Set(patternId)
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
  console.log(`occurrences loaded: ${occ.length.toLocaleString()} across ${occOf.size} tickers\n`);

  // ── PASS A: universe mean forward return per session ──────────────────────
  const sum = new Float64Array(axis.length), cnt = new Int32Array(axis.length);
  const cache = new Map();
  const load = async (code) => {
    const [rows] = await pool.query(
      `SELECT date, high_price h, low_price l, close_price c, volume v
         FROM ${srcOf.get(code)} WHERE stock_code = ? AND close_price > 0 ORDER BY date ASC`, [code]);
    const n = axis.length;
    const close = new Float64Array(n).fill(NaN), high = new Float64Array(n).fill(NaN),
      low = new Float64Array(n).fill(NaN), volume = new Float64Array(n).fill(NaN);
    for (const r of rows) {
      const i = idxOf.get(iso(r.date));
      if (i === undefined) continue;
      close[i] = Number(r.c); high[i] = Number(r.h); low[i] = Number(r.l);
      volume[i] = r.v == null ? NaN : Number(r.v);
    }
    return { close, high, low, volume };
  };

  const t0 = Date.now();
  for (let k = 0; k < codes.length; k++) {
    const px = await load(codes[k]);
    cache.set(codes[k], px);
    for (let i = 0; i + H < axis.length; i++) {
      const a = px.close[i], b = px.close[i + H];
      if (a > 0 && b > 0) { sum[i] += (b / a - 1) * 100; cnt[i] += 1; }
    }
    if ((k + 1) % 200 === 0) console.log(`  pass A ${k + 1}/${codes.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  const uni = new Float64Array(axis.length).fill(NaN);
  for (let i = 0; i < axis.length; i++) if (cnt[i] >= 30) uni[i] = sum[i] / cnt[i];

  // ── PASS B: accumulate per cell ───────────────────────────────────────────
  // Bucket totals are shared across patterns; the "without pattern" side is then
  // derived by subtraction, which is exact and avoids a second sweep per pattern.
  const bucketAll = new Map();     // `${factor}|${bucket}|${sess}` -> {s,n}
  const withPat = new Map();       // `${pid}|${factor}|${bucket}|${sess}` -> {s,n}
  const bump = (map, key, v) => { const e = map.get(key) || { s: 0, n: 0 }; e.s += v; e.n += 1; map.set(key, e); };
  const signOf = new Map(PATTERNS.map(p => [p.id, intendedSign(p.direction)]));

  for (let k = 0; k < codes.length; k++) {
    const code = codes[k];
    const px = cache.get(code);
    const atrSeries = priorAtrSeries(px.high, px.low, px.close, 14);
    const hits = occOf.get(code);
    for (let i = 0; i + H < axis.length; i++) {
      const c0 = px.close[i], cH = px.close[i + H];
      if (!(c0 > 0) || !(cH > 0) || !Number.isFinite(uni[i])) continue;
      const raw = (cH / c0 - 1) * 100 - uni[i];
      const ctx = contextAt({ ...px, atrSeries }, i);
      const b = bucketise(ctx);
      const fired = hits ? hits.get(i) : null;

      for (const f of FACTORS) {
        const bk = b[f];
        if (!bk) continue;
        // Bucket totals are direction-agnostic; the sign flip is applied per
        // pattern below, because the same bar can carry a bullish and a bearish
        // pattern and one raw return cannot be flipped two ways at once.
        bump(bucketAll, `${f}|${bk}|${i}`, raw);
        if (!fired) continue;
        for (const pid of fired) bump(withPat, `${pid}|${f}|${bk}|${i}`, raw);
      }
    }
    if ((k + 1) % 200 === 0) console.log(`  pass B ${k + 1}/${codes.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }

  // ── incremental per session, then session-level statistics ────────────────
  const rows = [];
  for (const p of PATTERNS) {
    const sign = signOf.get(p.id);
    for (const f of FACTORS) {
      const buckets = new Set();
      for (const key of withPat.keys()) {
        const [pid, ff, bk] = key.split('|');
        if (pid === p.id && ff === f) buckets.add(bk);
      }
      for (const bk of [...buckets].sort()) {
        const perSession = [];
        for (let i = 0; i < axis.length; i++) {
          const w = withPat.get(`${p.id}|${f}|${bk}|${i}`);
          if (!w) continue;
          const all = bucketAll.get(`${f}|${bk}|${i}`);
          if (!all) continue;
          const nWithout = all.n - w.n;
          if (nWithout < 5) continue;          // no usable control in this session
          const meanWith = w.s / w.n;
          const meanWithout = (all.s - w.s) / nWithout;
          let inc = meanWith - meanWithout;
          if (sign === -1) inc = -inc;         // intended direction
          perSession.push({ sessionIndex: i, v: inc, nWith: w.n, nWithout });
        }
        if (perSession.length < MIN_SESSIONS) continue;
        const used = H === 1 ? perSession : nonOverlappingAnchors(perSession, H);
        const vals = used.map(r => r.v);
        const test = oneSampleP(vals);
        const ci = cs.bootstrapMeanCI(vals, { resamples: 2000, seed: 42 });
        const occN = perSession.reduce((a, r) => a + r.nWith, 0);
        rows.push({
          patternId: p.id, direction: p.direction, factor: f, bucket: bk,
          horizon: H, occurrences: occN, sessions: vals.length,
          incremental: test.mean,
          ci: ci.lower === null ? null : { lower: ci.lower, upper: ci.upper },
          p: test.p, q: null, rejected: false,
          tier: evidenceTier(occN),
          twoSidedOnly: sign === 0,
        });
      }
    }
  }
  const bh = benjaminiHochberg(rows, alpha);

  // ── report ────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(100));
  console.log(`INCREMENTAL EFFECT OF THE CANDLE, WITHIN CONTEXT AND WITHIN SESSION  (${H}D, intended direction)`);
  console.log(`Benjamini-Hochberg over ${bh.m} tests, alpha ${alpha} — ${bh.rejected} rejected`);
  console.log('='.repeat(100));
  console.log('pattern                 factor      bucket        occ    sess    incr%   95% CI             q');
  console.log('-'.repeat(100));
  const survivors = [];
  for (const p of PATTERNS) {
    for (const r of rows.filter(x => x.patternId === p.id)) {
      const ciS = r.ci ? `[${fmt(r.ci.lower)},${fmt(r.ci.upper)}]`.padEnd(18) : ' '.repeat(18);
      const star = r.rejected ? '*' : ' ';
      console.log(`${r.patternId.padEnd(22)} ${r.factor.padEnd(11)} ${r.bucket.padEnd(12)} ` +
        `${String(r.occurrences).padStart(6)} ${String(r.sessions).padStart(6)} ${fmt(r.incremental).padStart(7)} ${ciS} ${fmt(r.q, 4).padStart(7)} ${star}`);
      if (r.rejected) survivors.push(r);
    }
  }

  console.log('\n' + '='.repeat(100));
  console.log('SURVIVES FDR — candidates for combination research, nothing more');
  console.log('='.repeat(100));
  if (!survivors.length) console.log('  (none)');
  for (const r of survivors.sort((a, b) => Math.abs(b.incremental) - Math.abs(a.incremental))) {
    const note = r.twoSidedOnly ? '  [indecision — sign carries no verdict]' : '';
    console.log(`  ${r.patternId.padEnd(22)} ${r.factor}=${r.bucket.padEnd(12)} incremental ${fmt(r.incremental)}%  q=${fmt(r.q, 4)}  n=${r.occurrences}${note}`);
  }

  const jsonOut = {
    analysisVersion: ANALYSIS_VERSION, taxonomyVersion: TAXONOMY_VERSION, taxonomyHash: taxonomyHash(),
    horizon: H, alpha, factors: FACTORS, fdr: bh, rows,
    control: 'same session, same context bucket, pattern absent',
    note: 'Incremental = mean(context AND pattern) - mean(context AND NOT pattern), within session, sign-flipped to intended direction for bearish patterns.',
  };
  if (outFile) { fs.writeFileSync(outFile, JSON.stringify(jsonOut, null, 1)); console.log(`\nJSON -> ${outFile}`); }

  console.log('\n' + '='.repeat(100));
  console.log('READ BEFORE QUOTING');
  console.log('='.repeat(100));
  console.log('  - Every number is a DIFFERENCE against the same session and the same context');
  console.log('    bucket with the pattern absent. It is not the pattern\'s return.');
  console.log('  - A large EXP-028B effect that vanishes here was the CONTEXT, not the candle.');
  console.log('  - Single factor only. Surviving here earns a place in combination research,');
  console.log('    it does not establish an edge.');
  console.log('  - No OOS split yet. This is still a screen.');
  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
