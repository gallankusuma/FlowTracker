'use strict';
/**
 * EXP-049b — is the persistent-volume result just volatility mean-reversion?
 *
 * NOT a registered test. Post-hoc, and it can only undermine EXP-049's headline.
 *
 * ── WHY THIS HAD TO BE RUN BEFORE REPORTING ANYTHING ─────────────────────────
 *
 * EXP-049 returned US persistent-volume IC = -0.1488 at t -30.6 against the
 * 20-session forward range. That is 3.7x the entire F3 effect and an enormous
 * number for a cross-sectional predictor. The correct first reaction to an
 * extraordinary IC is that something mechanical is producing it.
 *
 * The obvious candidate is that the control is incomplete. EXP-049 residualised
 * on the LEVEL of 20-session realised volatility. But:
 *
 *   persistent = ln( mean(volume, t-19..t) / mean(volume, t-59..t) )
 *
 * is a RATIO of recent to longer-run. Its volatility analogue is
 *
 *   VOL_RATIO  = ln( sd(returns, t-19..t) / sd(returns, t-59..t) )
 *
 * and volatility mean-reverts: a stock whose recent vol sits above its own
 * longer-run vol tends to calm down, which shrinks the forward range. Volume
 * tracks volatility, so persistent volume can inherit that entirely. Controlling
 * for the vol LEVEL does not remove a mean-reversion effect that lives in the
 * RATIO -- the level and the ratio are different quantities.
 *
 * If that is what is happening, this is not a volume finding at all. It is one
 * of the oldest facts in the field wearing volume's clothes.
 *
 * Usage: node scraper/research/exp049b_persistent_vol_control.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');

const RESERVED_START = '2024-01-01';
const FORWARD = 20, STEP = 20;
const VOL_WINDOW = 20, LONG_WINDOW = 60;
const MIN_NONZERO = 48, MIN_CROSS = 100, QUINT = 5;

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
const tOf = xs => { const m = mean(xs), s = sd(xs); return s && xs.length > 2 ? m / (s / Math.sqrt(xs.length)) : null; };
/** Residual of y on an arbitrary set of predictors, by Gaussian elimination. */
function residualizeMulti(y, Xs) {
  const n = y.length, k = Xs.length;
  const my = mean(y), mx = Xs.map(mean);
  const A = Array.from({ length: k }, () => new Array(k).fill(0));
  const b = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    const dy = y[i] - my;
    for (let p = 0; p < k; p++) {
      const dp = Xs[p][i] - mx[p];
      b[p] += dp * dy;
      for (let q = 0; q < k; q++) A[p][q] += dp * (Xs[q][i] - mx[q]);
    }
  }
  for (let p = 0; p < k; p++) A[p][p] += 1e-9;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let cc = c; cc <= k; cc++) M[r][cc] -= f * M[c][cc];
    }
  }
  const beta = M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[k] / row[i]));
  return y.map((v, i) => {
    let acc = v - my;
    for (let p = 0; p < k; p++) acc -= beta[p] * (Xs[p][i] - mx[p]);
    return acc;
  });
}
const bucketOf = (i, n, k) => Math.min(k - 1, Math.floor((i * k) / n));
const f4 = v => (v === null || v === undefined ? '    n/a' : (v >= 0 ? '+' : '') + v.toFixed(4));

function build(rows, keyOf) {
  const byDate = new Map();
  let cur = null, bars = [];
  const flush = () => {
    if (bars.length < LONG_WINDOW + FORWARD + 2) return;
    for (let i = LONG_WINDOW - 1; i + FORWARD < bars.length - 1; i++) {
      const w60 = bars.slice(i - LONG_WINDOW + 1, i + 1);
      const w20 = bars.slice(i - VOL_WINDOW + 1, i + 1);
      if (w60.filter(b => b.v > 0).length < MIN_NONZERO) continue;
      const m20 = mean(w20.map(b => b.v)), m60 = mean(w60.map(b => b.v));
      const entry = bars[i].c;
      if (!(m20 > 0) || !(m60 > 0) || !(entry > 0)) continue;
      const ret = w => w.map((b, k) => (k === 0 ? null : (b.c - w[k - 1].c) / w[k - 1].c * 100)).filter(v => v !== null);
      const sd20 = sd(ret(w20)), sd60 = sd(ret(w60));
      if (!sd20 || !sd60 || !(sd20 > 0) || !(sd60 > 0)) continue;
      let hi = -Infinity, lo = Infinity;
      for (let k = i + 1; k <= i + FORWARD; k++) { hi = Math.max(hi, bars[k].h); lo = Math.min(lo, bars[k].l); }
      const d = bars[i].d;
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push({
        persistent: Math.log(m20 / m60),
        volRatio: Math.log(sd20 / sd60),
        pv: sd20,
        range: ((hi - entry) / entry - (lo - entry) / entry) * 100,
      });
    }
  };
  for (const r of rows) {
    const k = keyOf(r);
    if (k !== cur) { flush(); cur = k; bars = []; }
    bars.push({ d: r.date.toISOString().slice(0, 10), h: +r.h, l: +r.l, c: +r.c, v: +r.v });
  }
  flush();
  return byDate;
}

function run(byDate, label) {
  const all = [...byDate.keys()].sort().filter(d => byDate.get(d).length >= MIN_CROSS);
  const anchors = all.filter((_, i) => i % STEP === 0);
  const s = { lvlOnly: [], plusRatio: [], ratioAlone: [], corr: [] };
  const perQ = Array.from({ length: QUINT }, () => []);
  for (const d of anchors) {
    const rows = byDate.get(d);
    const y = rows.map(r => r.range);
    const rPv = ranks(rows.map(r => r.pv));
    const rVr = ranks(rows.map(r => r.volRatio));
    const rPer = ranks(rows.map(r => r.persistent));

    let c = spearman(residualizeMulti(rPer, [rPv]), y);
    if (c !== null && Number.isFinite(c)) s.lvlOnly.push(c);
    c = spearman(residualizeMulti(rPer, [rPv, rVr]), y);
    if (c !== null && Number.isFinite(c)) s.plusRatio.push(c);
    c = spearman(residualizeMulti(rVr, [rPv]), y);
    if (c !== null && Number.isFinite(c)) s.ratioAlone.push(c);
    c = spearman(rows.map(r => r.persistent), rows.map(r => r.volRatio));
    if (c !== null && Number.isFinite(c)) s.corr.push(c);

    // Non-parametric: inside volRatio quintiles, does persistent volume still bite?
    const srt = rows.slice().sort((a, b) => a.volRatio - b.volRatio);
    const n = srt.length;
    for (let q = 0; q < QUINT; q++) {
      const b = srt.filter((_, i) => bucketOf(i, n, QUINT) === q);
      if (b.length < 12) continue;
      const cc = spearman(residualizeMulti(ranks(b.map(r => r.persistent)), [ranks(b.map(r => r.pv))]),
        b.map(r => r.range));
      if (cc !== null && Number.isFinite(cc)) perQ[q].push(cc);
    }
  }
  console.log(`\n${label} — ${anchors.length} anchors`);
  console.log(`  persistent volume, residualised on VOL LEVEL only (what EXP-049 did):`);
  console.log(`    IC ${f4(mean(s.lvlOnly))}   t ${tOf(s.lvlOnly).toFixed(2)}`);
  console.log(`  persistent volume, residualised on VOL LEVEL **and** VOL RATIO:`);
  console.log(`    IC ${f4(mean(s.plusRatio))}   t ${tOf(s.plusRatio).toFixed(2)}   ` +
    `<- ${Math.abs(mean(s.plusRatio)) < Math.abs(mean(s.lvlOnly)) * 0.5 ? 'COLLAPSES' : 'survives'}`);
  console.log(`  VOL RATIO alone (residualised on level) — the mean-reversion effect itself:`);
  console.log(`    IC ${f4(mean(s.ratioAlone))}   t ${tOf(s.ratioAlone).toFixed(2)}`);
  console.log(`  cross-sectional rho(persistent volume, vol ratio) = ${f4(mean(s.corr))}`);
  console.log('  persistent-volume IC inside VOL RATIO quintiles (no functional form assumed):');
  console.log('    ' + perQ.map((a, q) => `Q${q + 1} ${f4(mean(a))}(t${tOf(a) === null ? ' n/a' : tOf(a).toFixed(1)})`).join('  '));
  return { lvl: mean(s.lvlOnly), plus: mean(s.plusRatio), ratio: mean(s.ratioAlone), perQ };
}

(async () => {
  const pool = createPool();
  console.log('EXP-049b — is the persistent-volume result just volatility mean-reversion?');
  console.log('  Post-hoc. Can only undermine EXP-049, never confirm it.');
  console.log('  EXP-049 controlled for the vol LEVEL. Volatility mean-reversion lives in the');
  console.log('  RATIO of recent vol to longer-run vol -- a different quantity, and the exact');
  console.log('  analogue of how persistent volume is built.');

  const [us] = await pool.query(
    `SELECT ticker, date, high_price h, low_price l, close_price c, volume v
       FROM us_stock_prices WHERE date < ? AND close_price > 0 ORDER BY ticker, date ASC`, [RESERVED_START]);
  const rUS = run(build(us, r => r.ticker), 'US');

  const [idx] = await pool.query(
    `SELECT stock_code, date, high_price h, low_price l, close_price c, volume v
       FROM idx_stock_prices WHERE date < ? AND close_price > 0 ORDER BY stock_code, date ASC`, [RESERVED_START]);
  const rIDX = run(build(idx, r => r.stock_code), 'IDX');

  console.log(`\n${'='.repeat(88)}`);
  for (const [lab, r] of [['US', rUS], ['IDX', rIDX]]) {
    const share = 1 - Math.abs(r.plus) / Math.abs(r.lvl);
    console.log(`  ${lab}: adding the vol-ratio control removes ${(share * 100).toFixed(1)}% of the persistent-volume IC ` +
      `(${f4(r.lvl)} -> ${f4(r.plus)}), while the vol ratio itself carries ${f4(r.ratio)}`);
  }
  console.log('\n  If most of it is removed, EXP-049\'s headline is volatility mean-reversion');
  console.log('  wearing volume\'s clothes, and the honest statement is that the decomposition');
  console.log('  found a well-known fact rather than a new one.');
  console.log(`  Reserve ${RESERVED_START}+ untouched by this script.`);
  await pool.end();
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
