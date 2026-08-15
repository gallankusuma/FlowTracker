/**
 * EXP-028E — Pattern overlap, and family-level aggregation.
 *
 * The review's concern, section 14: "Kalau dua pattern 95% occurrence-nya sama,
 * jangan diperlakukan sebagai independent discoveries." With 101 definitions
 * drawn from a literature that names variations of the same shape separately,
 * a leaderboard of individually-significant patterns can be one finding wearing
 * six names.
 *
 * WHY THIS ALSO BOUNDS THE FDR ALREADY REPORTED. Benjamini-Hochberg controls the
 * false discovery rate under independence or positive dependence. Overlapping
 * patterns are positively dependent, so BH stays valid — but the EFFECTIVE
 * number of independent tests is smaller than the m it was given, which makes
 * the earlier q-values conservative in one direction and the count of
 * "discoveries" misleading in another: six names for one shape reads as six
 * results. Measuring the overlap is what turns that from a worry into a number.
 *
 * TWO MEASURES, BECAUSE THEY ANSWER DIFFERENT QUESTIONS.
 *   Jaccard        |A n B| / |A u B|   symmetric: are these the same event?
 *   Conditional    P(B|A) = |A n B|/|A| asymmetric: is A a SUBSET of B?
 *
 * The asymmetric one is the one that matters here. Dragonfly Doji is a Doji with
 * extra conditions, so P(Doji | Dragonfly) must be exactly 1.000 while
 * P(Dragonfly | Doji) is small. Jaccard alone would report that pair as barely
 * related and hide a strict containment. If the subset relation does NOT come
 * back as 1.000, the taxonomy has a bug — which makes this script a test of the
 * definitions as much as a measurement of them.
 *
 * SECTION 15: families are then tested in their own right, because "bisa jadi
 * nama individual pattern noisy tetapi familinya robust". A family's occurrence
 * set is the UNION of its members, deduplicated per bar — a bar satisfying three
 * doji variants counts once, or the family would simply be re-weighting the
 * narrowest member.
 *
 * Usage: node research/candlestick/exp028_overlap.js [--horizon 5] [--json out.json]
 */
'use strict';
require('dotenv').config();

const fs = require('fs');
const mysql = require('mysql2/promise');
const cs = require('../../modules/cross_sectional');
const { PATTERNS, TAXONOMY_VERSION, taxonomyHash } = require('./pattern_taxonomy_v1');
const { oneSampleP, benjaminiHochberg, evidenceTier, nonOverlappingAnchors } = require('./multiple_testing');

const ANALYSIS_VERSION = 'exp028e-v1';

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const iso = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const fmt = (v, dp = 3) => (v === null || v === undefined || !Number.isFinite(v) ? '   n/a' : v.toFixed(dp));

/**
 * Families, per section 15. A pattern may belong to several — "bullish reversal"
 * and "long wick rejection" are different cuts of the same population and both
 * are worth testing.
 */
function familiesOf(p) {
  const f = [p.family];
  if (p.direction.startsWith('BULLISH')) f.push('BULLISH_ALL');
  if (p.direction.startsWith('BEARISH')) f.push('BEARISH_ALL');
  if (p.direction.endsWith('REVERSAL')) f.push(p.candleCount === 1 ? 'SINGLE_REVERSAL' : 'DOUBLE_REVERSAL');
  if (p.direction.endsWith('CONTINUATION')) f.push('CONTINUATION');
  if (p.direction === 'INDECISION') f.push('INDECISION_ALL');
  return f;
}

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
  console.log(`EXP-028E — Pattern overlap and family aggregation   (horizon ${H}D)`);
  console.log('='.repeat(100));
  console.log(`taxonomy ${TAXONOMY_VERSION} sha256 ${taxonomyHash().slice(0, 16)}…\n`);

  const ids = PATTERNS.map(p => p.id);
  const pos = new Map(ids.map((id, k) => [id, k]));
  const N = ids.length;

  const [occ] = await pool.query('SELECT stock_code c, session_date d, pattern_id p FROM idx_candlestick_occurrences');
  const perBar = new Map();          // `${code}|${sessIdx}` -> Set(patternIdx)
  const count = new Int32Array(N);
  for (const o of occ) {
    const i = idxOf.get(iso(o.d));
    const k = pos.get(o.p);
    if (i === undefined || k === undefined) continue;
    const key = `${o.c}|${i}`;
    let s = perBar.get(key);
    if (!s) { s = new Set(); perBar.set(key, s); }
    s.add(k);
    count[k]++;
  }
  console.log(`occurrences ${occ.length.toLocaleString()} over ${perBar.size.toLocaleString()} distinct bars\n`);

  // ── pairwise co-occurrence ────────────────────────────────────────────────
  const inter = Array.from({ length: N }, () => new Int32Array(N));
  for (const s of perBar.values()) {
    const arr = [...s];
    for (let a = 0; a < arr.length; a++) {
      for (let b = a + 1; b < arr.length; b++) { inter[arr[a]][arr[b]]++; inter[arr[b]][arr[a]]++; }
    }
  }

  const pairs = [];
  for (let a = 0; a < N; a++) {
    for (let b = a + 1; b < N; b++) {
      const I = inter[a][b];
      if (!I) continue;
      const union = count[a] + count[b] - I;
      pairs.push({
        a: ids[a], b: ids[b], intersection: I,
        jaccard: I / union,
        pBgivenA: I / count[a],
        pAgivenB: I / count[b],
      });
    }
  }
  pairs.sort((x, y) => y.jaccard - x.jaccard);

  console.log('PAIRWISE OVERLAP (pairs that co-occur at all, top 20 by Jaccard)');
  console.log('-'.repeat(100));
  console.log('A                       B                        inter   Jaccard   P(B|A)   P(A|B)');
  for (const p of pairs.slice(0, 20)) {
    console.log(`${p.a.padEnd(23)} ${p.b.padEnd(24)} ${String(p.intersection).padStart(7)}   ` +
      `${fmt(p.jaccard).padStart(7)}  ${fmt(p.pBgivenA).padStart(7)}  ${fmt(p.pAgivenB).padStart(7)}`);
  }

  // Containment is the finding that matters, and a definitional check besides.
  const contained = pairs.filter(p => p.pBgivenA >= 0.99 || p.pAgivenB >= 0.99);
  console.log('\nSTRICT CONTAINMENT (one pattern is a special case of the other)');
  console.log('-'.repeat(100));
  if (!contained.length) console.log('  (none)');
  for (const p of contained) {
    const [sub, sup, cond] = p.pBgivenA >= 0.99 ? [p.a, p.b, p.pBgivenA] : [p.b, p.a, p.pAgivenB];
    console.log(`  ${sub.padEnd(23)} is a subset of ${sup.padEnd(23)} P=${fmt(cond)}  (${p.intersection} bars)`);
  }
  const redundant = pairs.filter(p => p.jaccard >= 0.95);
  console.log('\nNEAR-DUPLICATE PAIRS (Jaccard >= 0.95 — must not be counted as separate discoveries)');
  console.log('-'.repeat(100));
  console.log(redundant.length ? redundant.map(p => `  ${p.a} ~ ${p.b}  J=${fmt(p.jaccard)}`).join('\n') : '  (none)');

  // ── family aggregation ────────────────────────────────────────────────────
  const famMembers = new Map();
  for (const p of PATTERNS) for (const f of familiesOf(p)) {
    if (!famMembers.has(f)) famMembers.set(f, []);
    famMembers.get(f).push(p);
  }
  // A family is only meaningful as an aggregate if its members agree on
  // direction; a family mixing bullish and bearish members has no intended
  // direction to test and is reported for composition only.
  const famSign = new Map();
  for (const [f, ms] of famMembers) {
    const signs = new Set(ms.map(m => intendedSign(m.direction)));
    famSign.set(f, signs.size === 1 ? [...signs][0] : null);
  }

  console.log('\nFAMILIES');
  console.log('-'.repeat(100));
  for (const [f, ms] of [...famMembers].sort()) {
    console.log(`  ${f.padEnd(22)} ${String(ms.length).padStart(2)} members  ${famSign.get(f) === null ? '[mixed direction — not directionally testable]' : ''}  ${ms.map(m => m.id.replace('_V1', '')).join(', ')}`);
  }

  // ── family-level unconditional test ───────────────────────────────────────
  const [srcRows] = await pool.query('SELECT stock_code c, source s FROM idx_candlestick_bars GROUP BY stock_code, source');
  const srcOf = new Map(srcRows.map(r => [r.c, r.s]));
  const codes = [...srcOf.keys()].sort();

  const sum = new Float64Array(axis.length), cnt = new Int32Array(axis.length);
  const cache = new Map();
  for (const code of codes) {
    const [rows] = await pool.query(
      `SELECT date, close_price c FROM ${srcOf.get(code)} WHERE stock_code = ? AND close_price > 0 ORDER BY date ASC`, [code]);
    const close = new Float64Array(axis.length).fill(NaN);
    for (const r of rows) { const i = idxOf.get(iso(r.date)); if (i !== undefined) close[i] = Number(r.c); }
    cache.set(code, close);
    for (let i = 0; i + H < axis.length; i++) {
      const a = close[i], b = close[i + H];
      if (a > 0 && b > 0) { sum[i] += (b / a - 1) * 100; cnt[i] += 1; }
    }
  }
  const uni = new Float64Array(axis.length).fill(NaN);
  for (let i = 0; i < axis.length; i++) if (cnt[i] >= 30) uni[i] = sum[i] / cnt[i];

  // Union per bar, deduplicated: a bar satisfying three doji variants counts ONCE.
  const famAcc = new Map();          // family -> Map(sessIdx -> {s,n})
  for (const [key, set] of perBar) {
    const [code, sIdx] = key.split('|');
    const i = Number(sIdx);
    const close = cache.get(code);
    if (!close) continue;
    const c0 = close[i], cH = close[i + H];
    if (!(c0 > 0) || !(cH > 0) || !Number.isFinite(uni[i])) continue;
    const raw = (cH / c0 - 1) * 100 - uni[i];

    const fams = new Set();
    for (const k of set) for (const f of familiesOf(PATTERNS[k])) fams.add(f);
    for (const f of fams) {
      const sign = famSign.get(f);
      if (sign === null) continue;                 // mixed family: composition only
      const v = sign === -1 ? -raw : raw;
      let m = famAcc.get(f);
      if (!m) { m = new Map(); famAcc.set(f, m); }
      const e = m.get(i) || { s: 0, n: 0 };
      e.s += v; e.n += 1; m.set(i, e);
    }
  }

  const famRows = [];
  for (const [f, m] of famAcc) {
    const perSession = [...m.entries()].map(([sessionIndex, e]) => ({ sessionIndex, v: e.s / e.n, n: e.n }))
      .sort((a, b) => a.sessionIndex - b.sessionIndex);
    const used = H === 1 ? perSession : nonOverlappingAnchors(perSession, H);
    const vals = used.map(r => r.v);
    const test = oneSampleP(vals);
    const ci = cs.bootstrapMeanCI(vals, { resamples: 2000, seed: 42 });
    const occN = perSession.reduce((a, r) => a + r.n, 0);
    famRows.push({
      family: f, members: famMembers.get(f).length, sign: famSign.get(f),
      horizon: H, occurrences: occN, sessions: vals.length,
      meanIntendedExcess: test.mean, ci: ci.lower === null ? null : { lower: ci.lower, upper: ci.upper },
      p: test.p, q: null, rejected: false, tier: evidenceTier(occN),
      twoSidedOnly: famSign.get(f) === 0,
    });
  }
  const bh = benjaminiHochberg(famRows, alpha);

  console.log('\n' + '='.repeat(100));
  console.log(`FAMILY-LEVEL UNCONDITIONAL EFFECT (${H}D, intended direction, occurrences deduplicated per bar)`);
  console.log(`Benjamini-Hochberg over ${bh.m} tests — ${bh.rejected} rejected`);
  console.log('='.repeat(100));
  console.log('family                 mem     occ   sess    mean%   95% CI              q');
  for (const r of famRows.sort((a, b) => (b.meanIntendedExcess ?? 0) - (a.meanIntendedExcess ?? 0))) {
    const ciS = r.ci ? `[${fmt(r.ci.lower)},${fmt(r.ci.upper)}]`.padEnd(19) : ' '.repeat(19);
    console.log(`${r.family.padEnd(22)} ${String(r.members).padStart(3)} ${String(r.occurrences).padStart(7)} ${String(r.sessions).padStart(6)} ` +
      `${fmt(r.meanIntendedExcess).padStart(7)} ${ciS} ${fmt(r.q, 4).padStart(7)} ${r.rejected ? '*' : ' '}` +
      `${r.twoSidedOnly ? '  [indecision]' : ''}`);
  }

  const jsonOut = {
    analysisVersion: ANALYSIS_VERSION, taxonomyVersion: TAXONOMY_VERSION, taxonomyHash: taxonomyHash(),
    horizon: H, alpha,
    patternCounts: Object.fromEntries(ids.map((id, k) => [id, count[k]])),
    pairs, containment: contained, nearDuplicates: redundant,
    families: [...famMembers].map(([f, ms]) => ({ family: f, members: ms.map(m => m.id), sign: famSign.get(f) })),
    familyRows: famRows, familyFdr: bh,
  };
  if (outFile) { fs.writeFileSync(outFile, JSON.stringify(jsonOut, null, 1)); console.log(`\nJSON -> ${outFile}`); }

  console.log('\n' + '='.repeat(100));
  console.log('READ BEFORE QUOTING');
  console.log('='.repeat(100));
  console.log('  - Containment at P=1.000 is a DEFINITIONAL fact, not a discovery: the narrower');
  console.log('    pattern adds conditions to the wider one. It is checked because a value below');
  console.log('    1.000 would mean the taxonomy is inconsistent with itself.');
  console.log('  - Overlapping patterns are positively dependent, so BH remains valid, but the');
  console.log('    EFFECTIVE number of independent tests is below the m used earlier. Counting');
  console.log('    six names for one shape as six discoveries is the error this guards against.');
  console.log('  - Family membership overlaps by construction; families are separate cuts of the');
  console.log('    same population, not a partition.');
  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
