'use strict';
/**
 * EXP-043 — cluster weighting on US, where the test can have power.
 *
 * The single pre-registered hypothesis from
 * PREREGISTRATION_2026-09-02_us_cluster_weights.md. Read that first; the
 * decision rule, the frozen split and the power statement were all fixed before
 * this ran.
 *
 * ── WHAT IS DIFFERENT FROM EXP-042 ───────────────────────────────────────────
 *
 * EXP-042 asked this on IDX and came back UNRESOLVABLE -- 12 non-overlapping
 * anchors at the traded horizon against a bar of 30. Nothing was wrong with the
 * design; there was simply not enough data for any design to work.
 *
 * us_signal_history holds 4,909 sessions, so this run gets 149 discovery anchors
 * and 96 validation anchors at 20 days, and the chronological validation segment
 * that IDX could never afford. A null here means something; a null there did not.
 *
 * ── THE US CASE IS SHARPER ───────────────────────────────────────────────────
 *
 * US_TECH_WEIGHTS renormalizes the eight surviving factors to 1.0, which
 * redistributes the 48.4% the broker factors held on IDX proportionally across
 * the survivors -- and five of the eight describe momentum. That one idea ends
 * up with 64.1% of the directional vote, against 33.1% on IDX. Dropping the
 * broker factors made the naming accident WORSE, not better.
 *
 * Usage: node scraper/research/exp043_us_cluster_weights.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');
const { US_TECH_WEIGHTS } = require('../modules/us_score_engine');
const { computeConfidence, computeRiskModifier, combineFinalScore } = require('../modules/awo_factors');

const MIN_CROSS = 30;
const LINK = 0.5;                       // registered clustering threshold
const SENSITIVITIES = [0.4, 0.7];       // registered secondaries; 0.6 is identical to 0.5 here
const PRIMARY = 'return_20d';
const HORIZONS = [
  { col: 'return_10d', sessions: 10 },
  { col: 'return_20d', sessions: 20 },
  { col: 'return_40d', sessions: 40 },
];
const SPLIT = '2019-01-01';             // frozen before the run
const S1_MIN_ANCHORS = 30;
const FAMILY = 3;
const BLOCKS = 4;                       // descriptive stability blocks

const KEYS = ['f3', 'f4', 'f5', 'f9', 'f10', 'f11', 'f12', 'f13'];
const COL = {
  f3: 'f3_volume_z', f4: 'f4_momentum', f5: 'f5_rel_strength', f9: 'f9_rsi',
  f10: 'f10_macd', f11: 'f11_bollinger', f12: 'f12_ema_trend', f13: 'f13_support_resistance',
};
const LABEL = {
  f3: 'F3', f4: 'F4', f5: 'F5', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12', f13: 'F13',
};

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = a => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const r = new Array(a.length); let i = 0;
  while (i < idx.length) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const av = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = av;
    i = j + 1;
  }
  return r;
}
function pearson(a, b) {
  if (a.length < 3) return null;
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; n += x * y; da += x * x; db += y * y; }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : null;
}
const spearman = (a, b) => pearson(ranks(a), ranks(b));

/* Student's t, two-sided — modules/statistics only carries a normal CDF, and at
   n = 96 the normal approximation is not honest enough to decide a threshold. */
function logGamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, t = x + 5.5;
  t -= (x + 0.5) * Math.log(t);
  let s = 1.000000000190015;
  for (let j = 0; j < 6; j++) s += c[j] / ++y;
  return -t + Math.log(2.5066282746310005 * s / x);
}
function betacf(a, b, x) {
  const FPMIN = 1e-300, EPS = 3e-12;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}
const tTwoSided = (t, df) => (df <= 0 ? null : betai(df / 2, 0.5, df / (df + t * t)));
function tCrit95(df) {
  let lo = 0, hi = 100;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tTwoSided(mid, df) > 0.05) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
function bh(ps) {
  const m = ps.length;
  const order = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const q = new Array(m);
  let running = 1;
  for (let k = m; k >= 1; k--) {
    const [p, i] = order[k - 1];
    running = Math.min(running, (p * m) / k);
    q[i] = running;
  }
  return q;
}

/** Single-linkage over |rho| >= threshold. No forward return reaches this. */
function cluster(rho, threshold) {
  const n = KEYS.length;
  const parent = [...Array(n).keys()];
  const find = x => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) if (Math.abs(rho[i][j]) >= threshold) parent[find(i)] = find(j);
  }
  const g = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!g.has(r)) g.set(r, []); g.get(r).push(KEYS[i]); }
  return [...g.values()].sort((a, b) => b.length - a.length);
}
function clusterWeights(clusters) {
  const w = {};
  for (const c of clusters) for (const k of c) w[k] = 1 / clusters.length / c.length;
  return w;
}

/**
 * The deployed US composite, re-weighted. Same arithmetic as
 * modules/us_score_engine.js: a weighted average of the eight directional
 * factors, then combineFinalScore with full confidence and the F14 risk
 * modifier. Available-weight normalization mirrors weightedComposite, so a null
 * factor drops out of both numerator and denominator instead of being read as
 * 50.
 */
function score(row, W) {
  let num = 0, wsum = 0;
  for (const k of KEYS) {
    const v = row[COL[k]];
    if (v === null || v === undefined) continue;
    num += Number(v) * W[k];
    wsum += W[k];
  }
  if (wsum <= 0) return null;
  const f14 = row.f14_atr === null || row.f14_atr === undefined ? null : Number(row.f14_atr);
  return combineFinalScore(num / wsum, computeConfidence(undefined), computeRiskModifier(f14));
}

const f4 = v => (v === null || v === undefined ? '   n/a' : (v >= 0 ? '+' : '') + v.toFixed(4));

(async () => {
  const pool = createPool();

  console.log('EXP-043 — cluster weighting on US, where the test can have power');
  console.log('  pre-registered in PREREGISTRATION_2026-09-02_us_cluster_weights.md — TWO-SIDED');
  console.log(`  frozen chronological split at ${SPLIT}: DISCOVERY then VALIDATION`);
  console.log('  W_flat is the control that separates "clustering is right" from "current weights are bad"');
  console.log('  SURVIVORSHIP: today\'s S&P 500 members, twenty years back. Every number is biased upward.');
  console.log('');

  const cols = KEYS.map(k => COL[k]).join(', ');
  const [rows] = await pool.query(
    `SELECT data_date, ${cols}, f14_atr, ${HORIZONS.map(h => h.col).join(', ')}
       FROM us_signal_history ORDER BY data_date`);

  const byDate = new Map();
  for (const r of rows) {
    const d = r.data_date.toISOString().slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(r);
  }
  const dates = [...byDate.keys()].sort().filter(d => byDate.get(d).length >= MIN_CROSS);
  console.log(`${rows.length} rows, ${dates.length} usable sessions: ${dates[0]} .. ${dates[dates.length - 1]}`);

  /* ── Step 1: clustering, factor-to-factor only ─────────────────────────── */
  const N = KEYS.length;
  const acc = Array.from({ length: N }, () => Array.from({ length: N }, () => []));
  for (const d of dates) {
    const cross = byDate.get(d);
    const vals = KEYS.map(k => cross.map(r => Number(r[COL[k]])));
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const c = spearman(vals[i], vals[j]);
        if (c !== null && Number.isFinite(c)) acc[i][j].push(c);
      }
    }
  }
  const rho = Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => (i === j ? 1 : mean(acc[Math.min(i, j)][Math.max(i, j)]) ?? 0)));

  const clusters = cluster(rho, LINK);
  const W_current = US_TECH_WEIGHTS;
  const W_cluster = clusterWeights(clusters);
  const W_flat = Object.fromEntries(KEYS.map(k => [k, 1 / N]));

  console.log(`\nCLUSTERS at |rho| >= ${LINK}:  K = ${clusters.length}`);
  for (const c of clusters) {
    const cur = c.reduce((s, k) => s + W_current[k], 0);
    console.log(`  [${c.map(k => LABEL[k]).join(', ')}]  current ${(cur * 100).toFixed(1)}%  ->  ` +
      `cluster-equal ${(c.reduce((s, k) => s + W_cluster[k], 0) * 100).toFixed(1)}%`);
  }
  const SCHEMES = [['current', W_current], ['cluster', W_cluster], ['flat', W_flat]];
  for (const th of SENSITIVITIES) {
    const cl = cluster(rho, th);
    SCHEMES.push([`cl${th}`, clusterWeights(cl)]);
    console.log(`  sensitivity |rho| >= ${th}: K = ${cl.length}  ` +
      cl.map(c => `[${c.map(k => LABEL[k]).join(',')}]`).join(' '));
  }

  /* ── Step 2: score every row once under each scheme ────────────────────── */
  const scored = new Map();
  for (const d of dates) {
    const cross = byDate.get(d);
    const per = { row: cross };
    for (const [nm, W] of SCHEMES) per[nm] = cross.map(r => score(r, W));
    scored.set(d, per);
  }

  /* ── Step 3: per-date rank IC ──────────────────────────────────────────── */
  function icSeries(nm, targetCol) {
    const out = new Map();
    for (const d of dates) {
      const per = scored.get(d);
      const xs = [], ys = [];
      for (let i = 0; i < per.row.length; i++) {
        const t = per.row[i][targetCol];
        const s = per[nm][i];
        if (t === null || t === undefined || s === null) continue;
        const tv = Number(t);
        if (!Number.isFinite(tv)) continue;
        xs.push(s); ys.push(tv);
      }
      if (xs.length < MIN_CROSS) continue;
      const ic = spearman(xs, ys);
      if (ic !== null && Number.isFinite(ic)) out.set(d, ic);
    }
    return out;
  }
  function pairedTest(diffs) {
    const m = mean(diffs), s = sd(diffs), k = diffs.length;
    if (!s || k < 3) return null;
    const se = s / Math.sqrt(k);
    const t = m / se, df = k - 1;
    const half = tCrit95(df) * se;
    return { mean: m, n: k, t, p: tTwoSided(t, df), lo: m - half, hi: m + half };
  }

  const CONTRASTS = ['cluster - current', 'flat - current', 'cluster - flat'];
  const SEGMENTS = [
    ['DISCOVERY (S1)', d => d < SPLIT],
    ['VALIDATION (S2)', d => d >= SPLIT],
    ['FULL SPAN (descriptive)', () => true],
  ];

  const results = {};
  for (const h of HORIZONS) {
    const ics = Object.fromEntries(SCHEMES.map(([nm]) => [nm, icSeries(nm, h.col)]));
    results[h.col] = {};
    for (const [segName, pred] of SEGMENTS) {
      const usable = dates.filter(d => pred(d) && SCHEMES.every(([nm]) => ics[nm].has(d)));
      const anchors = usable.filter((_, i) => i % h.sessions === 0);
      const meanIC = {};
      for (const [nm] of SCHEMES) meanIC[nm] = mean(anchors.map(d => ics[nm].get(d)));
      const tests = {};
      for (const c of CONTRASTS) {
        const [a, b] = c.split(' - ');
        tests[c] = pairedTest(anchors.map(d => ics[a].get(d) - ics[b].get(d)));
      }
      results[h.col][segName] = { anchors: anchors.length, sessions: usable.length, meanIC, tests, ics, dates: anchors };
    }
  }

  /* ── Step 4: report ────────────────────────────────────────────────────── */
  for (const h of HORIZONS) {
    const tag = h.col === PRIMARY ? 'PRIMARY' : 'SECONDARY';
    console.log(`\n${'='.repeat(84)}`);
    console.log(`${tag} — ${h.col}`);
    for (const [segName] of SEGMENTS) {
      const r = results[h.col][segName];
      const adm = r.anchors >= S1_MIN_ANCHORS;
      console.log(`\n  ${segName}: ${r.sessions} sessions, ${r.anchors} non-overlapping anchors ` +
        `${adm ? '(clears >= 30)' : `*** BELOW THE ${S1_MIN_ANCHORS}-ANCHOR BAR ***`}`);
      console.log('    mean rank IC:  ' + SCHEMES.map(([nm]) => `${nm} ${f4(r.meanIC[nm])}`).join('   '));
      const ps = CONTRASTS.map(c => r.tests[c]?.p ?? 1);
      const qs = bh(ps.slice(0, FAMILY));
      console.log('    ' + 'contrast'.padEnd(20) + 'mean diff'.padStart(11) + '95% CI'.padStart(22) +
        't'.padStart(8) + 'p'.padStart(9) + 'q'.padStart(9));
      CONTRASTS.forEach((c, i) => {
        const t = r.tests[c];
        if (!t) { console.log(`    ${c.padEnd(20)}  insufficient`); return; }
        console.log('    ' + c.padEnd(20) + f4(t.mean).padStart(11) +
          `[${f4(t.lo)}, ${f4(t.hi)}]`.padStart(22) +
          t.t.toFixed(2).padStart(8) + t.p.toFixed(4).padStart(9) + qs[i].toFixed(4).padStart(9));
      });
    }
  }

  /* Sensitivities and block stability — descriptive, on the primary only. */
  const prim = results[PRIMARY];
  console.log(`\n${'='.repeat(84)}`);
  console.log(`SECONDARY, DESCRIPTIVE ONLY — ${PRIMARY}`);
  console.log('\n  alternative clustering thresholds (mean IC over FULL SPAN anchors):');
  const full = prim['FULL SPAN (descriptive)'];
  for (const [nm] of SCHEMES) console.log(`    ${nm.padEnd(10)} ${f4(full.meanIC[nm])}`);

  console.log(`\n  stability across ${BLOCKS} equal chronological blocks (cluster - current):`);
  const allAnchors = full.dates;
  const per = Math.ceil(allAnchors.length / BLOCKS);
  for (let b = 0; b < BLOCKS; b++) {
    const blk = allAnchors.slice(b * per, (b + 1) * per);
    if (blk.length < 3) continue;
    const diffs = blk.map(d => full.ics.cluster.get(d) - full.ics.current.get(d));
    const t = pairedTest(diffs);
    console.log(`    ${blk[0]} .. ${blk[blk.length - 1]}  n=${String(blk.length).padStart(3)}  ` +
      `mean ${f4(t.mean)}  t ${t.t.toFixed(2).padStart(6)}  ` +
      `IC_cluster ${f4(mean(blk.map(d => full.ics.cluster.get(d))))}`);
  }

  /* ── Step 5: the registered decision rule, applied mechanically ─────────── */
  const disc = prim['DISCOVERY (S1)'], val = prim['VALIDATION (S2)'];
  const qd = bh(CONTRASTS.map(c => disc.tests[c]?.p ?? 1));
  const qv = bh(CONTRASTS.map(c => val.tests[c]?.p ?? 1));
  const dcc = disc.tests['cluster - current'], dcf = disc.tests['cluster - flat'];
  const vcc = val.tests['cluster - current'], vcf = val.tests['cluster - flat'];

  const c1 = !!dcc && dcc.mean > 0 && qd[0] < 0.05;
  const c2 = !!dcf && dcf.mean > 0 && qd[2] < 0.05;
  const sameSign = !!dcc && !!vcc && Math.sign(dcc.mean) === Math.sign(vcc.mean);
  const c3 = sameSign && qv[0] < 0.05 && !!vcf && Math.sign(dcf.mean) === Math.sign(vcf.mean) && qv[2] < 0.05;
  const c4 = disc.meanIC.cluster > 0 && val.meanIC.cluster > 0;

  console.log(`\n${'='.repeat(84)}`);
  console.log('DECISION RULE (fixed before the run, applied without interpretation)');
  console.log(`  1. DISCOVERY  cluster > current, q < 0.05 ......... ${c1 ? 'YES' : 'no'}`);
  console.log(`  2. DISCOVERY  cluster > flat,    q < 0.05 ......... ${c2 ? 'YES' : 'no'}   (else the win belongs to flattening)`);
  console.log(`  3. VALIDATION same sign, survives BH .............. ${c3 ? 'YES' : 'no'}   (may shrink, may not vanish or invert)`);
  console.log(`  4. IC_cluster > 0 in BOTH segments ................ ${c4 ? 'YES' : 'no'}   ` +
    `(disc ${f4(disc.meanIC.cluster)}, val ${f4(val.meanIC.cluster)})`);

  const signsAgree = CONTRASTS.every(c =>
    disc.tests[c] && val.tests[c] && Math.sign(disc.tests[c].mean) === Math.sign(val.tests[c].mean));
  const anythingSignificant = qd.some(q => q < 0.05) || qv.some(q => q < 0.05);

  let verdict;
  if (c1 && c2 && c3 && c4) verdict = 'CLUSTER WEIGHTING BETTER — licenses a sealed US candidate at S3 with a FRESH reserved period, not a weight change';
  else if (dcc && dcc.mean < 0 && qd[0] < 0.05) verdict = 'CURRENT WEIGHTING BETTER';
  else if ((c1 || c2) && !c4) verdict = 'INCONCLUSIVE — the difference is between two LOSING schemes (IC_cluster <= 0)';
  else if (signsAgree && !anythingSignificant) verdict = 'UNRESOLVABLE — signs agree across segments, nothing clears significance. The EXP-028 signature: the window cannot resolve an effect of this size. NOT "directionally promising".';
  else verdict = 'INCONCLUSIVE';
  console.log(`\n  VERDICT: ${verdict}`);
  console.log('\n  Holds regardless: survivorship-biased universe (today\'s S&P 500 members projected');
  console.log('  back twenty years), and this is evidence about US only — the IDX factor set,');
  console.log('  weights and cluster structure are all different.');

  await pool.end();
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
