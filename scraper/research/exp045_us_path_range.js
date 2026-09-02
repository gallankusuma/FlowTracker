'use strict';
/**
 * EXP-045 — can anything predict how far a stock will MOVE, beyond volatility?
 *
 * The single pre-registered hypothesis from
 * PREREGISTRATION_2026-09-02_us_path_range.md. Read that first; the controls,
 * the family, the floor and the void condition were fixed before this ran.
 *
 * ── WHY THE TARGET CHANGES AND THE SEARCH DOES NOT ───────────────────────────
 *
 * EXP-042/043/044 all asked "which stock will go up" and all returned nothing.
 * After three nulls the tempting move is to hunt for a subset that survives --
 * which is exactly what EXP-044 showed is dangerous, when F5 looked like a
 * carrier at q = 0.029 on a secondary horizon and inverted in validation.
 *
 * So this changes the TARGET. Not direction, magnitude: not which stock rises,
 * but which stock will travel far. Direction has been null in every test here;
 * magnitude has a strong prior in the literature, because volatility clusters
 * and returns do not. And it is actionable through a different mechanism --
 * computeTradePlan already places stops off ATR and that placement has never
 * been validated on this data.
 *
 * ── WHY ONLY THE INCREMENTAL FORM IS INTERESTING ─────────────────────────────
 *
 * "Volatility predicts volatility" would pass a raw test and teach nothing. So
 * volatility is controlled for and the hypothesis is about what remains. The
 * control is a CONTINUOUS prior-20-session realised vol, not just F14: scoreATR
 * is a six-level step function (80/70/55/40/25/...), and residualising against
 * that alone would leave most of the volatility information in the residual and
 * manufacture a "beyond ATR" pass.
 *
 * Usage: node scraper/research/exp045_us_path_range.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');

const MIN_CROSS = 30;
const HORIZON_SESSIONS = 20;       // the path columns are 20-session by construction
const SPLIT = '2019-01-01';
const HOLDOUT_START = '2024-01-01';
const IC_FLOOR = 0.02;
const BLOCKS = 4;
const MIN_BLOCKS_AGREE = 3;
const VOL_WINDOW = 20;             // prior sessions for PRIOR_VOL, inclusive of t
const CONTROL_MIN_IC = 0.10;       // positive control bar, fixed before the run
const CONTROL_MAX_Q = 0.01;
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

/**
 * Residual of y on [x1, x2] by two-predictor OLS. Used on WITHIN-DATE RANKS, so
 * the "regression" is on uniform-ish variables and the residual keeps the part
 * of a factor's cross-sectional ordering that the two volatility controls do not
 * already account for.
 */
function residualize(y, x1, x2) {
  const n = y.length;
  const my = mean(y), m1 = mean(x1), m2 = mean(x2);
  let s11 = 0, s22 = 0, s12 = 0, s1y = 0, s2y = 0;
  for (let i = 0; i < n; i++) {
    const a = x1[i] - m1, b = x2[i] - m2, c = y[i] - my;
    s11 += a * a; s22 += b * b; s12 += a * b; s1y += a * c; s2y += b * c;
  }
  const det = s11 * s22 - s12 * s12;
  // Near-singular controls (e.g. a date where F14 is a single constant) fall
  // back to the one-predictor fit rather than producing a garbage coefficient.
  let b1, b2;
  if (Math.abs(det) < 1e-9) {
    b1 = s11 > 0 ? s1y / s11 : 0;
    b2 = 0;
  } else {
    b1 = (s22 * s1y - s12 * s2y) / det;
    b2 = (s11 * s2y - s12 * s1y) / det;
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = (y[i] - my) - b1 * (x1[i] - m1) - b2 * (x2[i] - m2);
  return out;
}

/* Student's t, two-sided. */
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

  console.log('EXP-045 — can anything predict how far a stock will MOVE, beyond volatility?');
  console.log('  pre-registered in PREREGISTRATION_2026-09-02_us_path_range.md — TWO-SIDED');
  console.log('  target: range_20d = max_profit_20d - max_drawdown_20d, sign-free by construction');
  console.log(`  family m = ${FACTORS.length} (F14 is a CONTROL here, not a candidate), BH q < 0.05 per segment`);
  console.log(`  residualised on PRIOR_VOL (${VOL_WINDOW}-session realised vol, continuous) AND F14`);
  console.log(`  economic floor |IC| >= ${IC_FLOOR} — reused from EXP-041/044 and flagged under-justified for a risk target`);
  console.log(`  POSITIVE CONTROL: PRIOR_VOL vs range must be >= +${CONTROL_MIN_IC} at q < ${CONTROL_MAX_Q}, else the run is VOID`);
  console.log(`  HOLDOUT ${HOLDOUT_START} onward: ${OPEN_HOLDOUT ? '*** BURNED BY THIS RUN ***' : 'SEALED, excluded in SQL'}`);
  console.log('  SURVIVORSHIP: companies that blew up are ABSENT, and blow-ups are exactly the');
  console.log('  large-range events this target measures. Worse here than for a return test.');
  console.log('');

  const cols = FACTORS.map(f => f[0]).join(', ');
  const [rows] = await pool.query(
    `SELECT data_date, ticker, ${cols}, f14_atr, max_profit_20d, max_drawdown_20d
       FROM us_signal_history
      WHERE max_profit_20d IS NOT NULL AND max_drawdown_20d IS NOT NULL
        ${OPEN_HOLDOUT ? '' : 'AND data_date < ?'}
      ORDER BY data_date`, OPEN_HOLDOUT ? [] : [HOLDOUT_START]);
  console.log(`${rows.length} rows with a complete 20-session path`);

  /* PRIOR_VOL — computed from prices, every bar at or before the as-of date. */
  const [px] = await pool.query(
    `SELECT ticker, date, change_pct FROM us_stock_prices ORDER BY ticker, date ASC`);
  const priorVol = new Map();   // `${ticker}|${date}` -> stdev of the prior VOL_WINDOW changes
  {
    let cur = null, buf = [];
    for (const r of px) {
      if (r.ticker !== cur) { cur = r.ticker; buf = []; }
      buf.push(Number(r.change_pct));
      if (buf.length > VOL_WINDOW) buf.shift();
      if (buf.length === VOL_WINDOW) {
        priorVol.set(`${r.ticker}|${r.date.toISOString().slice(0, 10)}`, sd(buf));
      }
    }
  }
  console.log(`PRIOR_VOL computed for ${priorVol.size} ticker-days (${VOL_WINDOW}-session window ending at t)`);

  const byDate = new Map();
  let noVol = 0;
  for (const r of rows) {
    const d = r.data_date.toISOString().slice(0, 10);
    const pv = priorVol.get(`${r.ticker}|${d}`);
    if (pv === undefined || !Number.isFinite(pv)) { noVol++; continue; }
    r._pv = pv;
    r._range = Number(r.max_profit_20d) - Number(r.max_drawdown_20d);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(r);
  }
  const dates = [...byDate.keys()].sort().filter(d => byDate.get(d).length >= MIN_CROSS);
  console.log(`${noVol} rows dropped for no PRIOR_VOL; ${dates.length} usable sessions: ${dates[0]} .. ${dates[dates.length - 1]}`);

  /* Per-date ICs: raw and residualised, plus the two controls. */
  const icRaw = {}, icRes = {};
  for (const f of FACTORS) { icRaw[f[1]] = new Map(); icRes[f[1]] = new Map(); }
  const icPV = new Map(), icF14 = new Map();

  for (const d of dates) {
    const cross = byDate.get(d);
    const y = cross.map(r => r._range);
    const rPV = ranks(cross.map(r => r._pv));
    const rF14 = ranks(cross.map(r => Number(r.f14_atr)));

    let c = spearman(cross.map(r => r._pv), y);
    if (c !== null && Number.isFinite(c)) icPV.set(d, c);
    c = spearman(cross.map(r => Number(r.f14_atr)), y);
    if (c !== null && Number.isFinite(c)) icF14.set(d, c);

    for (const f of FACTORS) {
      const raw = cross.map(r => Number(r[f[0]]));
      if (raw.some(v => !Number.isFinite(v))) continue;
      const cr = spearman(raw, y);
      if (cr !== null && Number.isFinite(cr)) icRaw[f[1]].set(d, cr);
      const res = residualize(ranks(raw), rPV, rF14);
      const cs = spearman(res, y);
      if (cs !== null && Number.isFinite(cs)) icRes[f[1]].set(d, cs);
    }
  }

  const SEGMENTS = [['DISCOVERY (S1)', d => d < SPLIT], ['VALIDATION (S2)', d => d >= SPLIT]];
  const anchorsFor = pred => {
    const usable = dates.filter(d => pred(d) && icPV.has(d) && FACTORS.every(f => icRes[f[1]].has(d)));
    return usable.filter((_, i) => i % HORIZON_SESSIONS === 0);
  };

  /* ── Positive control, read BEFORE anything else ───────────────────────── */
  const discAnchors = anchorsFor(SEGMENTS[0][1]);
  const valAnchors = anchorsFor(SEGMENTS[1][1]);
  const pvDisc = oneSample(discAnchors.map(d => icPV.get(d)));
  const f14Disc = oneSample(discAnchors.map(d => icF14.get(d)));

  console.log(`\n${'='.repeat(92)}`);
  console.log('POSITIVE CONTROL — validity check, cannot produce a finding');
  console.log(`  PRIOR_VOL vs range_20d, discovery (${discAnchors.length} anchors): ` +
    `IC ${f4(pvDisc.mean)}  t ${pvDisc.t.toFixed(2)}  p ${pvDisc.p.toExponential(2)}`);
  console.log(`  F14 vs range_20d,       discovery: IC ${f4(f14Disc.mean)}  t ${f14Disc.t.toFixed(2)}` +
    '   (must be NEGATIVE: scoreATR gives 80 to a tight ATR and 25 to a wild one)');
  const controlOk = pvDisc.mean >= CONTROL_MIN_IC && pvDisc.p < CONTROL_MAX_Q;
  const f14Ok = f14Disc.mean < 0;
  console.log(`  control: ${controlOk ? 'PASS' : 'FAIL'}    F14 sign: ${f14Ok ? 'as expected' : 'WRONG SIGN'}`);
  if (!controlOk) {
    console.log('\n  *** VOID. The pipeline cannot see that volatility clusters, so it cannot see');
    console.log('  *** anything. No other number from this run may be reported.');
    await pool.end();
    return;
  }
  if (!f14Ok) {
    console.log('\n  *** F14 has the wrong sign against future range. The column does not hold what');
    console.log('  *** scoreATR says it holds. Reported as a data finding; the hypothesis is not read.');
    await pool.end();
    return;
  }

  /* ── The registered family ─────────────────────────────────────────────── */
  const table = {};
  for (const [segName, pred] of SEGMENTS) {
    const anchors = pred === SEGMENTS[0][1] ? discAnchors : valAnchors;
    const res = {}, raw = {};
    for (const f of FACTORS) {
      res[f[1]] = oneSample(anchors.map(d => icRes[f[1]].get(d)));
      raw[f[1]] = oneSample(anchors.map(d => icRaw[f[1]].get(d)).filter(v => v !== undefined));
    }
    const qs = bh(FACTORS.map(f => res[f[1]]?.p ?? 1));
    FACTORS.forEach((f, i) => { if (res[f[1]]) res[f[1]].q = qs[i]; });
    const qr = bh(FACTORS.map(f => raw[f[1]]?.p ?? 1));
    FACTORS.forEach((f, i) => { if (raw[f[1]]) raw[f[1]].q = qr[i]; });
    table[segName] = { anchors: anchors.length, res, raw, dates: anchors };
  }

  for (const [segName] of SEGMENTS) {
    const t = table[segName];
    console.log(`\n${'='.repeat(92)}`);
    console.log(`${segName} — ${t.anchors} non-overlapping anchors`);
    console.log('    ' + 'factor'.padEnd(6) + 'RESIDUAL IC'.padStart(12) + 'sd'.padStart(8) +
      '95% CI'.padStart(21) + 't'.padStart(8) + 'q'.padStart(9) + '  floor' + 'raw IC'.padStart(11) + 'raw q'.padStart(9));
    for (const f of FACTORS) {
      const s = t.res[f[1]], r = t.raw[f[1]];
      if (!s) { console.log(`    ${f[1].padEnd(6)}  insufficient`); continue; }
      console.log('    ' + f[1].padEnd(6) + f4(s.mean).padStart(12) + s.sd.toFixed(4).padStart(8) +
        `[${f4(s.lo)},${f4(s.hi)}]`.padStart(21) + s.t.toFixed(2).padStart(8) + s.q.toFixed(4).padStart(9) +
        (Math.abs(s.mean) >= IC_FLOOR ? '  PASS' : '  below') +
        (r ? f4(r.mean).padStart(11) + r.q.toFixed(4).padStart(9) : ''));
    }
  }

  /* Stability screen, discovery blocks. */
  const per = Math.ceil(discAnchors.length / BLOCKS);
  const blockIC = {};
  for (const f of FACTORS) {
    blockIC[f[1]] = [];
    for (let b = 0; b < BLOCKS; b++) {
      const blk = discAnchors.slice(b * per, (b + 1) * per);
      blockIC[f[1]].push(blk.length >= 3 ? mean(blk.map(d => icRes[f[1]].get(d))) : null);
    }
  }
  console.log(`\n${'='.repeat(92)}`);
  console.log('STABILITY SCREEN — residual IC per discovery block');
  const ranges = [];
  for (let b = 0; b < BLOCKS; b++) {
    const blk = discAnchors.slice(b * per, (b + 1) * per);
    if (blk.length) ranges.push(`${blk[0]}..${blk[blk.length - 1]} (n=${blk.length})`);
  }
  console.log('  blocks: ' + ranges.join('  |  '));
  console.log('    ' + 'factor'.padEnd(6) + ranges.map((_, i) => `blk${i + 1}`.padStart(10)).join('') + '   agree');
  for (const f of FACTORS) {
    const o = table['DISCOVERY (S1)'].res[f[1]];
    const agree = o ? blockIC[f[1]].filter(v => v !== null && Math.sign(v) === Math.sign(o.mean)).length : 0;
    console.log('    ' + f[1].padEnd(6) + blockIC[f[1]].map(v => f4(v).padStart(10)).join('') +
      `   ${agree}/${BLOCKS}` + (agree >= MIN_BLOCKS_AGREE ? ' PASS' : ' fail'));
  }

  /* ── Decision rule ─────────────────────────────────────────────────────── */
  console.log(`\n${'='.repeat(92)}`);
  console.log('DECISION RULE (fixed before the run, applied without interpretation)');
  console.log('    ' + 'factor'.padEnd(6) + '1:|IC|>=floor'.padStart(14) + '2:disc q<.05'.padStart(14) +
    '3:stability'.padStart(13) + '4:val same sign+q'.padStart(19) + '   VERDICT');
  const carriers = [], volOnly = [];
  for (const f of FACTORS) {
    const d = table['DISCOVERY (S1)'].res[f[1]];
    const v = table['VALIDATION (S2)'].res[f[1]];
    const dr = table['DISCOVERY (S1)'].raw[f[1]];
    const c1 = !!d && Math.abs(d.mean) >= IC_FLOOR;
    const c2 = !!d && d.q < 0.05;
    const agree = d ? blockIC[f[1]].filter(x => x !== null && Math.sign(x) === Math.sign(d.mean)).length : 0;
    const c3 = agree >= MIN_BLOCKS_AGREE;
    const c4 = !!d && !!v && Math.sign(v.mean) === Math.sign(d.mean) && v.q < 0.05;
    let verdict;
    if (c1 && c2 && c3 && c4) { verdict = 'CARRIER'; carriers.push(f[1]); }
    else if (c2 && c3 && c4 && !c1) verdict = 'REAL BUT NEGLIGIBLE';
    else if (dr && dr.q < 0.05 && Math.abs(dr.mean) >= IC_FLOOR && !c2) {
      verdict = 'BELONGS TO VOLATILITY (raw passes, residual does not)';
      volOnly.push(f[1]);
    } else verdict = 'NOT A CARRIER';
    console.log('    ' + f[1].padEnd(6) + (c1 ? 'YES' : 'no').padStart(14) + (c2 ? 'YES' : 'no').padStart(14) +
      `${agree}/${BLOCKS}`.padStart(13) + (c4 ? 'YES' : 'no').padStart(19) + `   ${verdict}`);
  }

  console.log(`\n  carriers: ${carriers.length ? carriers.join(', ') : 'NONE'}`);
  console.log(`  belongs to volatility: ${volOnly.length ? volOnly.join(', ') : 'none'}`);
  console.log('\n  Range is not tradeable on its own — a wider forecast widens BOTH tails. A carrier');
  console.log('  here is an input to stop distance and position size, never a reason to buy.');
  console.log(`  ${OPEN_HOLDOUT ? '*** HOLDOUT BURNED ***' : `Holdout ${HOLDOUT_START} onward remains sealed and unread.`}`);

  await pool.end();
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
