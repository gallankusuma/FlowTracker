'use strict';
/**
 * EXP-042 — are the composite's weights an accident of naming?
 *
 * The single pre-registered hypothesis from
 * PREREGISTRATION_2026-09-02_cluster_weights.md. Read that file first; the
 * decision rule, the horizon problem and the power statement all live there and
 * were fixed before this ran.
 *
 * ── THE ONE-LINE VERSION ─────────────────────────────────────────────────────
 *
 * RAW_F1_13_SHARES hands a share to each factor BY NAME. EXP-040 found the names
 * outnumber the things: five of them describe momentum, five describe broker
 * flow. So those two ideas collect the sum of five shares each, and nobody chose
 * that number. This asks whether weighting by CLUSTER instead of by name ranks
 * stocks better.
 *
 * ── WHY W_flat EXISTS, AND WHY THE ANSWER IS UNREADABLE WITHOUT IT ───────────
 *
 * Cluster weighting cuts the broker cluster from 48.5% to 20%. EXP-016 already
 * showed broker accumulation is INVERTED. So cluster weighting could "win" for a
 * reason that has nothing to do with clustering: it happens to defund a cluster
 * that points the wrong way. Flat 1/13 defunds it too, without any clustering.
 *
 * If both beat the incumbent by about the same amount, the finding is "the
 * current weights are bad", not "clustering is right". That distinction is the
 * entire reason this arm is here.
 *
 * ── NO FREE PARAMETERS ───────────────────────────────────────────────────────
 *
 * Equal-per-cluster is a prior, not a fit. Nothing below is chosen by looking at
 * returns: cluster membership comes from factor-to-factor correlation only. That
 * is what makes a 145-session window survivable at all -- there is no surface to
 * overfit.
 *
 * Usage: node scraper/research/exp042_cluster_weights.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');
const { combineFactorScores, DEFAULT_WEIGHTS } = require('../modules/score_engine');

const MIN_CROSS = 30;             // tickers needed before a date is usable
const LINK = 0.5;                 // registered clustering threshold
const LINK_SENSITIVITY = 0.6;     // registered secondary
const PRIMARY = 'return_3d';      // the only horizon with >= 30 anchors
const HORIZONS = [
  { col: 'return_3d', sessions: 3 },
  { col: 'return_5d', sessions: 5 },
  { col: 'return_10d', sessions: 10 },
];
const S1_MIN_ANCHORS = 30;        // Promotion Contract v1, S1
const FAMILY = 3;                 // m, pre-declared

const KEYS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12', 'f13'];
const COL = {
  f1: 'f1_concentration', f2: 'f2_trend', f3: 'f3_volume_z', f4: 'f4_momentum',
  f5: 'f5_rel_strength', f6: 'f6_breadth', f7: 'f7_alignment', f8: 'f8_streak',
  f9: 'f9_rsi', f10: 'f10_macd', f11: 'f11_bollinger', f12: 'f12_ema_trend',
  f13: 'f13_support_resistance',
};

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = a => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const r = new Array(a.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
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

/* ── Student's t, two-sided. Written out because modules/statistics only has a
   normal CDF, and at n = 48 the normal approximation is not honest enough to
   decide a pre-registered threshold on. ─────────────────────────────────────── */
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
/** Two-sided p for a t statistic on df degrees of freedom. */
const tTwoSided = (t, df) => (df <= 0 ? null : betai(df / 2, 0.5, df / (df + t * t)));
/** Two-sided 95% critical t, by bisection on the CDF -- no table to mistype. */
function tCrit95(df) {
  let lo = 0, hi = 100;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tTwoSided(mid, df) > 0.05) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Benjamini-Hochberg. Returns q in the same order as the input p's. */
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
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(rho[i][j]) >= threshold) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(KEYS[i]);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

/** 1/K per cluster, split equally inside it. */
function clusterWeights(clusters) {
  const w = {};
  for (const c of clusters) for (const k of c) w[k] = 1 / clusters.length / c.length;
  return w;
}

(async () => {
  const pool = createPool();

  console.log('EXP-042 — are the composite weights an accident of naming?');
  console.log('  pre-registered in PREREGISTRATION_2026-09-02_cluster_weights.md — TWO-SIDED');
  console.log('  three schemes: W_current (deployed), W_cluster (1/K per cluster), W_flat (1/13)');
  console.log('  W_flat is the control: it separates "clustering is right" from "current weights are bad"');
  console.log('  scored through the production combineFactorScores(), finalScore — not a re-implementation');
  console.log('');

  const cols = KEYS.map(k => COL[k]).join(', ');
  const [rows] = await pool.query(
    `SELECT data_date, stock_code, ${cols}, f14_atr, ${HORIZONS.map(h => h.col).join(', ')}
       FROM idx_signal_history ORDER BY data_date`);

  const byDate = new Map();
  for (const r of rows) {
    const d = r.data_date.toISOString().slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(r);
  }
  const dates = [...byDate.keys()].sort().filter(d => byDate.get(d).length >= MIN_CROSS);
  console.log(`${rows.length} rows, ${dates.length} usable sessions (>= ${MIN_CROSS} tickers): ${dates[0]} .. ${dates[dates.length - 1]}`);

  /* ── Step 1: the clustering. Factor-to-factor only. ────────────────────── */
  const n = KEYS.length;
  const acc = Array.from({ length: n }, () => Array.from({ length: n }, () => []));
  for (const d of dates) {
    const cross = byDate.get(d);
    const vals = KEYS.map(k => cross.map(r => Number(r[COL[k]])));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const c = spearman(vals[i], vals[j]);
        if (c !== null && Number.isFinite(c)) acc[i][j].push(c);
      }
    }
  }
  const rho = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : mean(acc[Math.min(i, j)][Math.max(i, j)]) ?? 0)));

  const clusters = cluster(rho, LINK);
  const clustersHi = cluster(rho, LINK_SENSITIVITY);
  const W_cluster = clusterWeights(clusters);
  const W_clusterHi = clusterWeights(clustersHi);
  const W_flat = Object.fromEntries(KEYS.map(k => [k, 1 / n]));
  const W_current = DEFAULT_WEIGHTS;

  const curSum = KEYS.reduce((s, k) => s + (W_current[k] || 0), 0);
  console.log(`\nCLUSTERS at |rho| >= ${LINK}:  K = ${clusters.length}`);
  for (const c of clusters) {
    const cur = c.reduce((s, k) => s + (W_current[k] || 0), 0) / curSum;
    const nw = c.reduce((s, k) => s + W_cluster[k], 0);
    console.log(`  [${c.map(x => x.toUpperCase()).join(', ')}]  current ${(cur * 100).toFixed(1)}%  ->  cluster-equal ${(nw * 100).toFixed(1)}%`);
  }
  console.log(`sensitivity at |rho| >= ${LINK_SENSITIVITY}: K = ${clustersHi.length}  ` +
    clustersHi.map(c => `[${c.map(x => x.toUpperCase()).join(',')}]`).join(' '));

  /* ── Step 2: score every row under each scheme, once. ──────────────────── */
  const SCHEMES = [
    ['current', W_current], ['cluster', W_cluster], ['flat', W_flat], ['clusterHi', W_clusterHi],
  ];
  const scored = new Map();   // date -> { scheme -> [score], targets }
  for (const d of dates) {
    const cross = byDate.get(d);
    const per = { row: cross };
    for (const [name, W] of SCHEMES) {
      per[name] = cross.map(r => {
        const f = {}, avail = {};
        for (const k of KEYS) {
          const v = r[COL[k]];
          avail[k] = v !== null && v !== undefined;
          if (avail[k]) f[k] = Number(v);
        }
        const f14 = r.f14_atr === null || r.f14_atr === undefined ? null : Number(r.f14_atr);
        return combineFactorScores(f, f14, avail, W).finalScore;
      });
    }
    scored.set(d, per);
  }

  /* ── Step 3: per-date rank IC, then non-overlapping anchors. ───────────── */
  function icSeries(schemeName, targetCol) {
    const out = new Map();
    for (const d of dates) {
      const per = scored.get(d);
      const xs = [], ys = [];
      for (let i = 0; i < per.row.length; i++) {
        const t = per.row[i][targetCol];
        if (t === null || t === undefined) continue;
        const tv = Number(t);
        if (!Number.isFinite(tv)) continue;
        xs.push(per[schemeName][i]); ys.push(tv);
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
    const t = m / se;
    const df = k - 1;
    const half = tCrit95(df) * se;
    return { mean: m, n: k, t, p: tTwoSided(t, df), lo: m - half, hi: m + half };
  }

  const results = [];
  for (const h of HORIZONS) {
    const ics = Object.fromEntries(SCHEMES.map(([nm]) => [nm, icSeries(nm, h.col)]));
    // Anchors: every h.sessions-th usable session. Gaps in `dates` only ever
    // widen the true spacing, so this stays non-overlapping, never less.
    const usable = dates.filter(d => ics.current.has(d) && ics.cluster.has(d) && ics.flat.has(d));
    const anchors = usable.filter((_, i) => i % h.sessions === 0);
    const per = {};
    for (const [nm] of SCHEMES) per[nm] = anchors.filter(d => ics[nm].has(d)).map(d => ics[nm].get(d));
    const pairs = {
      'cluster - current': anchors.map(d => ics.cluster.get(d) - ics.current.get(d)),
      'flat - current': anchors.map(d => ics.flat.get(d) - ics.current.get(d)),
      'cluster - flat': anchors.map(d => ics.cluster.get(d) - ics.flat.get(d)),
    };
    results.push({
      h, anchors: anchors.length, allDates: usable.length,
      meanIC: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, mean(v)])),
      tests: Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, pairedTest(v)])),
      icFull: Object.fromEntries(SCHEMES.map(([nm]) => [nm, mean(usable.map(d => ics[nm].get(d)))])),
    });
  }

  /* ── Step 4: report. ───────────────────────────────────────────────────── */
  const f4 = v => (v === null || v === undefined ? '   n/a' : (v >= 0 ? '+' : '') + v.toFixed(4));
  for (const r of results) {
    const admissible = r.anchors >= S1_MIN_ANCHORS;
    const tag = r.h.col === PRIMARY ? 'PRIMARY' : 'SECONDARY';
    console.log(`\n${'='.repeat(78)}`);
    console.log(`${tag} — ${r.h.col}   ${r.anchors} non-overlapping anchors  ` +
      `${admissible ? '(clears S1 >= 30)' : `*** INADMISSIBLE: S1 needs >= ${S1_MIN_ANCHORS} ***`}`);
    console.log(`  mean rank IC over anchors:  ` +
      Object.entries(r.meanIC).map(([k, v]) => `${k} ${f4(v)}`).join('   '));
    console.log(`  (all ${r.allDates} sessions, overlapping — descriptive only: ` +
      Object.entries(r.icFull).map(([k, v]) => `${k} ${f4(v)}`).join('  ') + ')');
    const names = Object.keys(r.tests);
    const ps = names.map(k => r.tests[k]?.p ?? 1);
    const qs = r.h.col === PRIMARY ? bh(ps.slice(0, FAMILY)) : null;
    console.log('  ' + 'contrast'.padEnd(20) + 'mean diff'.padStart(11) + '95% CI'.padStart(22) +
      't'.padStart(8) + 'p'.padStart(9) + (qs ? 'q'.padStart(9) : ''));
    names.forEach((k, i) => {
      const t = r.tests[k];
      if (!t) { console.log(`  ${k.padEnd(20)}  insufficient`); return; }
      console.log('  ' + k.padEnd(20) + f4(t.mean).padStart(11) +
        `[${f4(t.lo)}, ${f4(t.hi)}]`.padStart(22) +
        t.t.toFixed(2).padStart(8) + t.p.toFixed(4).padStart(9) +
        (qs ? qs[i].toFixed(4).padStart(9) : ''));
    });
  }

  /* ── Step 5: the registered decision rule, applied mechanically. ───────── */
  const prim = results.find(r => r.h.col === PRIMARY);
  const ps = ['cluster - current', 'flat - current', 'cluster - flat'].map(k => prim.tests[k]?.p ?? 1);
  const qs = bh(ps);
  const cc = prim.tests['cluster - current'], cf = prim.tests['cluster - flat'];
  const icCluster = prim.meanIC.cluster;

  console.log(`\n${'='.repeat(78)}`);
  console.log('DECISION RULE (fixed before the run, applied without interpretation)');
  const c1 = cc && cc.mean > 0 && qs[0] < 0.05;
  const c2 = cf && cf.mean > 0 && qs[2] < 0.05;
  const c3 = icCluster > 0;
  console.log(`  1. cluster beats current, q < 0.05 ......... ${c1 ? 'YES' : 'no'}`);
  console.log(`  2. cluster beats flat,    q < 0.05 ......... ${c2 ? 'YES' : 'no'}   (else the win belongs to flattening)`);
  console.log(`  3. IC_cluster > 0 on its own .............. ${c3 ? 'YES' : 'no'}   (IC ${f4(icCluster)})`);
  let verdict;
  if (c1 && c2 && c3) verdict = 'CLUSTER WEIGHTING BETTER — licenses a sealed S2 candidate, NOT a weight change';
  else if (cc && cc.mean < 0 && qs[0] < 0.05) verdict = 'CURRENT WEIGHTING BETTER';
  else if ((c1 || c2) && !c3) verdict = 'INCONCLUSIVE — the difference is between two LOSING schemes (IC_cluster <= 0)';
  else verdict = 'INCONCLUSIVE — not detectable in 145 sessions; this is not "no difference"';
  console.log(`\n  VERDICT: ${verdict}`);
  console.log('\n  Caveats that hold regardless of the above: one IHSG drawdown, no holdout,');
  console.log('  survivorship-biased universe, and the traded horizon (2-8 weeks) is not');
  console.log('  testable at this sample size — see the pre-registration.');

  await pool.end();
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
