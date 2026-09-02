'use strict';
/**
 * EXP-044 — which US factors carry anything, one at a time.
 *
 * The single pre-registered hypothesis from
 * PREREGISTRATION_2026-09-02_us_per_factor_ic.md. Read that first; the family,
 * the floor, the stability screen and the sealed holdout were all fixed before
 * this ran.
 *
 * ── WHY THIS AND NOT ANOTHER WEIGHTING TEST ──────────────────────────────────
 *
 * EXP-043 answered something more useful than its own hypothesis: the US
 * composite does not rank, and after 2019 it ranks BACKWARDS -- at 40 days
 * +0.0169 in 2007-2018 against -0.0393 in 2019-2026, under every weighting
 * scheme tried. When every reallocation of a set fails the same way, the problem
 * is not the allocation. It is the set.
 *
 * Nobody has ever measured these nine columns individually on US. They have been
 * scored, weighted, displayed and traded against; not one has been tested alone.
 *
 * ── THE SEALED HOLDOUT ───────────────────────────────────────────────────────
 *
 * 2024-01-01 onward is RESERVED and this script does not read it. The exclusion
 * is in the SQL, not in a filter downstream, so there is no arrangement of the
 * later code that can see those rows. `--open-holdout` exists only so that a
 * future S3 run has a deliberate door; using it burns the period permanently,
 * per Promotion Contract v1 S3, and the script says so before it does anything.
 *
 * The Promotion Contract has recorded since it was frozen that nothing has
 * reached S3, and the reason is that no period was ever reserved. Sealing this
 * one costs validation power -- 62 anchors instead of 96 -- and that price was
 * paid before knowing whether anything would pass.
 *
 * Usage: node scraper/research/exp044_us_per_factor_ic.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');

const MIN_CROSS = 30;
const PRIMARY = 'return_20d';
const HORIZONS = [
  { col: 'return_10d', sessions: 10 },
  { col: 'return_20d', sessions: 20 },
  { col: 'return_40d', sessions: 40 },
];
const SPLIT = '2019-01-01';          // discovery | validation
const HOLDOUT_START = '2024-01-01';  // sealed
const IC_FLOOR = 0.02;               // economic floor, same as EXP-041
const BLOCKS = 4;                    // stability screen, discovery only
const MIN_BLOCKS_AGREE = 3;
const OPEN_HOLDOUT = process.argv.includes('--open-holdout');

const FACTORS = [
  ['f3_volume_z', 'F3', 'Volume z-score'],
  ['f4_momentum', 'F4', 'Momentum'],
  ['f5_rel_strength', 'F5', 'Relative strength'],
  ['f9_rsi', 'F9', 'RSI'],
  ['f10_macd', 'F10', 'MACD'],
  ['f11_bollinger', 'F11', 'Bollinger %B'],
  ['f12_ema_trend', 'F12', 'EMA trend'],
  ['f13_support_resistance', 'F13', 'Support/resistance'],
  ['f14_atr', 'F14', 'ATR (risk modifier, tested anyway)'],
];

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

/* Student's t, two-sided. modules/statistics carries only a normal CDF, and at
   n = 62 the normal approximation is not honest enough to decide a threshold. */
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
function oneSample(xs) {
  const m = mean(xs), s = sd(xs), n = xs.length;
  if (!s || n < 3) return null;
  const se = s / Math.sqrt(n);
  const t = m / se, df = n - 1;
  const half = tCrit95(df) * se;
  return { mean: m, sd: s, n, t, p: tTwoSided(t, df), lo: m - half, hi: m + half };
}

const f4 = v => (v === null || v === undefined ? '    n/a' : (v >= 0 ? '+' : '') + v.toFixed(4));

(async () => {
  const pool = createPool();

  console.log('EXP-044 — which US factors carry anything, one at a time');
  console.log('  pre-registered in PREREGISTRATION_2026-09-02_us_per_factor_ic.md — TWO-SIDED');
  console.log(`  family m = ${FACTORS.length}, Benjamini-Hochberg q < 0.05, within each segment, primary horizon only`);
  console.log(`  economic floor |IC| >= ${IC_FLOOR} (same as EXP-041, fixed before this run)`);
  console.log(`  stability screen: sign agrees in >= ${MIN_BLOCKS_AGREE} of ${BLOCKS} discovery blocks`);
  if (OPEN_HOLDOUT) {
    console.log(`\n  *** --open-holdout GIVEN. Reading ${HOLDOUT_START} onward BURNS the reserved`);
    console.log('  *** period permanently (Promotion Contract v1 S3). It cannot be un-burned.\n');
  } else {
    console.log(`  HOLDOUT ${HOLDOUT_START} onward is SEALED and excluded in SQL — not read, not reported`);
  }
  console.log('  SURVIVORSHIP: today\'s S&P 500 members, twenty years back. Every number is biased upward.');
  console.log('');

  const cols = FACTORS.map(f => f[0]).join(', ');
  // The seal lives HERE. No arrangement of the code below can see those rows.
  const [rows] = await pool.query(
    `SELECT data_date, ${cols}, ${HORIZONS.map(h => h.col).join(', ')}
       FROM us_signal_history
      ${OPEN_HOLDOUT ? '' : 'WHERE data_date < ?'}
      ORDER BY data_date`, OPEN_HOLDOUT ? [] : [HOLDOUT_START]);

  const byDate = new Map();
  for (const r of rows) {
    const d = r.data_date.toISOString().slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(r);
  }
  const dates = [...byDate.keys()].sort().filter(d => byDate.get(d).length >= MIN_CROSS);
  console.log(`${rows.length} rows read, ${dates.length} usable sessions: ${dates[0]} .. ${dates[dates.length - 1]}`);

  /* Per-date IC per factor per horizon, computed once. */
  const ic = {};   // horizon -> factor -> Map(date -> ic)
  for (const h of HORIZONS) {
    ic[h.col] = {};
    for (const f of FACTORS) ic[h.col][f[1]] = new Map();
    for (const d of dates) {
      const cross = byDate.get(d);
      const tgt = cross.map(r => (r[h.col] === null || r[h.col] === undefined ? null : Number(r[h.col])));
      const okIdx = [];
      for (let i = 0; i < tgt.length; i++) if (tgt[i] !== null && Number.isFinite(tgt[i])) okIdx.push(i);
      if (okIdx.length < MIN_CROSS) continue;
      const ys = okIdx.map(i => tgt[i]);
      for (const f of FACTORS) {
        const xs = okIdx.map(i => Number(cross[i][f[0]]));
        if (xs.some(v => !Number.isFinite(v))) continue;
        const c = spearman(xs, ys);
        if (c !== null && Number.isFinite(c)) ic[h.col][f[1]].set(d, c);
      }
    }
  }

  const SEGMENTS = [
    ['DISCOVERY (S1)', d => d < SPLIT],
    ['VALIDATION (S2)', d => d >= SPLIT],
  ];

  function anchorsFor(h, pred) {
    const usable = dates.filter(d => pred(d) && FACTORS.every(f => ic[h.col][f[1]].has(d)));
    return usable.filter((_, i) => i % h.sessions === 0);
  }

  const table = {};   // horizon -> segment -> factor -> stat (+q)
  for (const h of HORIZONS) {
    table[h.col] = {};
    for (const [segName, pred] of SEGMENTS) {
      const anchors = anchorsFor(h, pred);
      const stats = {};
      for (const f of FACTORS) stats[f[1]] = oneSample(anchors.map(d => ic[h.col][f[1]].get(d)));
      const qs = bh(FACTORS.map(f => stats[f[1]]?.p ?? 1));
      FACTORS.forEach((f, i) => { if (stats[f[1]]) stats[f[1]].q = qs[i]; });
      table[h.col][segName] = { anchors: anchors.length, stats, dates: anchors };
    }
  }

  /* Stability screen — discovery blocks at the PRIMARY horizon only. */
  const discAnchors = table[PRIMARY]['DISCOVERY (S1)'].dates;
  const per = Math.ceil(discAnchors.length / BLOCKS);
  const blockIC = {};
  for (const f of FACTORS) blockIC[f[1]] = [];
  for (let b = 0; b < BLOCKS; b++) {
    const blk = discAnchors.slice(b * per, (b + 1) * per);
    for (const f of FACTORS) blockIC[f[1]].push(blk.length >= 3 ? mean(blk.map(d => ic[PRIMARY][f[1]].get(d))) : null);
  }
  const blockRanges = [];
  for (let b = 0; b < BLOCKS; b++) {
    const blk = discAnchors.slice(b * per, (b + 1) * per);
    if (blk.length) blockRanges.push(`${blk[0]}..${blk[blk.length - 1]} (n=${blk.length})`);
  }

  /* ── Report ────────────────────────────────────────────────────────────── */
  for (const h of HORIZONS) {
    const tag = h.col === PRIMARY ? 'PRIMARY' : 'SECONDARY — descriptive, cannot decide anything';
    console.log(`\n${'='.repeat(92)}`);
    console.log(`${tag}: ${h.col}`);
    for (const [segName] of SEGMENTS) {
      const t = table[h.col][segName];
      console.log(`\n  ${segName} — ${t.anchors} non-overlapping anchors`);
      console.log('    ' + 'factor'.padEnd(6) + 'mean IC'.padStart(9) + 'sd(IC)'.padStart(9) +
        '95% CI'.padStart(21) + 't'.padStart(8) + 'p'.padStart(9) + 'q'.padStart(9) + '   floor');
      for (const f of FACTORS) {
        const s = t.stats[f[1]];
        if (!s) { console.log(`    ${f[1].padEnd(6)}  insufficient`); continue; }
        console.log('    ' + f[1].padEnd(6) + f4(s.mean).padStart(9) + s.sd.toFixed(4).padStart(9) +
          `[${f4(s.lo)},${f4(s.hi)}]`.padStart(21) + s.t.toFixed(2).padStart(8) +
          s.p.toFixed(4).padStart(9) + s.q.toFixed(4).padStart(9) +
          (Math.abs(s.mean) >= IC_FLOOR ? '   PASS' : '   below'));
      }
    }
  }

  console.log(`\n${'='.repeat(92)}`);
  console.log(`STABILITY SCREEN — mean IC per discovery block, ${PRIMARY} (descriptive input to rule 3)`);
  console.log('  blocks: ' + blockRanges.join('  |  '));
  console.log('    ' + 'factor'.padEnd(6) + blockRanges.map((_, i) => `blk${i + 1}`.padStart(10)).join('') + '   agree');
  for (const f of FACTORS) {
    const overall = table[PRIMARY]['DISCOVERY (S1)'].stats[f[1]];
    const agree = overall ? blockIC[f[1]].filter(v => v !== null && Math.sign(v) === Math.sign(overall.mean)).length : 0;
    console.log('    ' + f[1].padEnd(6) + blockIC[f[1]].map(v => f4(v).padStart(10)).join('') +
      `   ${agree}/${BLOCKS}` + (agree >= MIN_BLOCKS_AGREE ? ' PASS' : ' fail'));
  }

  /* Cross-factor correlation, so "several carriers" cannot be read as several ideas. */
  console.log(`\n${'='.repeat(92)}`);
  console.log('CROSS-FACTOR rho (descriptive) — several carriers may be one carrier with several names');
  const N = FACTORS.length;
  const acc = Array.from({ length: N }, () => Array.from({ length: N }, () => []));
  for (const d of dates) {
    const cross = byDate.get(d);
    const vals = FACTORS.map(f => cross.map(r => Number(r[f[0]])));
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      const c = spearman(vals[i], vals[j]);
      if (c !== null && Number.isFinite(c)) acc[i][j].push(c);
    }
  }
  console.log('      ' + FACTORS.map(f => f[1].padStart(7)).join(''));
  for (let i = 0; i < N; i++) {
    let line = FACTORS[i][1].padEnd(6);
    for (let j = 0; j < N; j++) {
      line += i === j ? '   1.00' : (mean(acc[Math.min(i, j)][Math.max(i, j)]) ?? 0).toFixed(2).padStart(7);
    }
    console.log(line);
  }

  /* ── The registered decision rule, applied mechanically ─────────────────── */
  console.log(`\n${'='.repeat(92)}`);
  console.log('DECISION RULE (fixed before the run, applied without interpretation)');
  console.log('    ' + 'factor'.padEnd(6) + '1:|IC|>=floor'.padStart(14) + '2:disc q<.05'.padStart(14) +
    '3:stability'.padStart(13) + '4:val same sign+q'.padStart(19) + '   VERDICT');
  const verdicts = {};
  for (const f of FACTORS) {
    const d = table[PRIMARY]['DISCOVERY (S1)'].stats[f[1]];
    const v = table[PRIMARY]['VALIDATION (S2)'].stats[f[1]];
    const c1 = !!d && Math.abs(d.mean) >= IC_FLOOR;
    const c2 = !!d && d.q < 0.05;
    const agree = d ? blockIC[f[1]].filter(x => x !== null && Math.sign(x) === Math.sign(d.mean)).length : 0;
    const c3 = agree >= MIN_BLOCKS_AGREE;
    const c4 = !!d && !!v && Math.sign(v.mean) === Math.sign(d.mean) && v.q < 0.05;
    let verdict;
    if (c2 && c3 && c4 && c1) verdict = d.mean > 0 ? 'CARRIER' : 'INVERTED CARRIER (licenses nothing)';
    else if (c2 && c3 && c4 && !c1) verdict = 'REAL BUT NEGLIGIBLE';
    else verdict = 'NOT A CARRIER';
    verdicts[f[1]] = verdict;
    console.log('    ' + f[1].padEnd(6) + (c1 ? 'YES' : 'no').padStart(14) + (c2 ? 'YES' : 'no').padStart(14) +
      `${agree}/${BLOCKS}`.padStart(13) + (c4 ? 'YES' : 'no').padStart(19) + `   ${verdict}`);
  }

  const carriers = FACTORS.filter(f => verdicts[f[1]].startsWith('CARRIER')).map(f => f[1]);
  const inverted = FACTORS.filter(f => verdicts[f[1]].startsWith('INVERTED')).map(f => f[1]);
  console.log(`\n  carriers: ${carriers.length ? carriers.join(', ') : 'NONE'}`);
  console.log(`  inverted: ${inverted.length ? inverted.join(', ') : 'none'}`);
  if (!carriers.length && !inverted.length) {
    console.log('\n  A clean null across nine factors on this many sessions is a substantive answer:');
    console.log('  the US factor set carries no usable cross-sectional information at the traded');
    console.log('  horizon. It is also what EXP-043 predicted, which is a reason to believe it and');
    console.log('  NOT a reason to go looking for a subset that survives.');
  }
  console.log(`\n  ${OPEN_HOLDOUT ? '*** HOLDOUT WAS BURNED BY THIS RUN ***' : `HOLDOUT ${HOLDOUT_START} onward remains sealed and unread.`}`);
  console.log('  Rank IC is ordering, not profit: nothing here bears the 0.50% round-trip cost.');

  await pool.end();
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
