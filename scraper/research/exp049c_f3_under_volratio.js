'use strict';
/**
 * EXP-049c — does the F3 finding itself survive a volatility-RATIO control?
 *
 * NOT a registered test. Post-hoc, and it exists to attack EXP-045 and EXP-046,
 * not to support them.
 *
 * ── WHY THIS BECAME NECESSARY ────────────────────────────────────────────────
 *
 * EXP-049b found that volatility MEAN-REVERSION -- ln(sd20/sd60), the ratio of
 * recent realised vol to its own longer-run level -- carries IC -0.2553 against
 * the 20-session forward range on US, and -0.1698 on IDX. It is the largest
 * effect anywhere in this arc, it is textbook, and it is present in both markets.
 *
 * EXP-045 controlled for the vol LEVEL (PRIOR_VOL and F14). It never controlled
 * for the RATIO. EXP-045b's kill attempts conditioned non-parametrically on vol
 * LEVEL quintiles, so they had the same blind spot -- four checks that all
 * looked in the same wrong place.
 *
 * F3 is a volume z-score and volume tracks volatility, so F3 can inherit the
 * mean-reversion effect the same way persistent volume did (where 63.7% of the
 * IC vanished under this control). If it does, then EXP-045's carrier and
 * EXP-046's stop miscalibration are largely a VOLATILITY story that has been
 * described as a VOLUME story all day.
 *
 * Two checks:
 *   1. F3 -> range, residualised on {PRIOR_VOL, VOL_RATIO} instead of just level.
 *   2. The EXP-046 stop-hit gap, measured inside VOL_RATIO buckets as well as
 *      ATR buckets. That is the practical claim, and it is the one that matters.
 *
 * Usage: node scraper/research/exp049c_f3_under_volratio.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');
const { f3_volumeZ } = require('../modules/awo_factors');

const RESERVED_START = '2024-01-01';
const FORWARD = 20, STEP = 20;
const VOL_WINDOW = 20, LONG_WINDOW = 60;
const ATR_PERIOD = 14, MULT = 2.5;
const MIN_CROSS = 100, QUINT = 5;

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
function wilderATR(bars, period) {
  const out = new Array(bars.length).fill(null);
  let prev = null, trSum = 0;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    if (i <= period) { trSum += tr; if (i === period) { prev = trSum / period; out[i] = prev; } }
    else { prev = (prev * (period - 1) + tr) / period; out[i] = prev; }
  }
  return out;
}
const bucketOf = (i, n, k) => Math.min(k - 1, Math.floor((i * k) / n));
const f4 = v => (v === null || v === undefined ? '    n/a' : (v >= 0 ? '+' : '') + v.toFixed(4));
const pp = v => (v === null || v === undefined ? '   n/a' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + 'pp');

(async () => {
  const pool = createPool();
  console.log('EXP-049c — does the F3 finding survive a volatility-RATIO control?');
  console.log('  Post-hoc. Exists to ATTACK EXP-045/046, not to support them.');
  console.log('  EXP-045 controlled the vol LEVEL and never the RATIO; EXP-045b\'s four checks');
  console.log('  all conditioned on level too, so they shared one blind spot.\n');

  const [px] = await pool.query(
    `SELECT ticker, date, open_price o, high_price h, low_price l, close_price c, volume v
       FROM us_stock_prices WHERE date < ? AND close_price > 0 ORDER BY ticker, date ASC`, [RESERVED_START]);

  const byDate = new Map();
  {
    let cur = null, bars = [];
    const flush = () => {
      if (bars.length < LONG_WINDOW + FORWARD + 2) return;
      const atr = wilderATR(bars, ATR_PERIOD);
      for (let i = LONG_WINDOW - 1; i + FORWARD < bars.length - 1; i++) {
        const a = atr[i];
        if (!a || a <= 0) continue;
        const w60 = bars.slice(i - LONG_WINDOW + 1, i + 1);
        const w20 = bars.slice(i - VOL_WINDOW + 1, i + 1);
        const ret = w => w.map((b, k) => (k === 0 ? null : (b.c - w[k - 1].c) / w[k - 1].c * 100)).filter(v => v !== null);
        const sd20 = sd(ret(w20)), sd60 = sd(ret(w60));
        if (!sd20 || !sd60 || !(sd20 > 0) || !(sd60 > 0)) continue;
        const prev = bars[i - 1];
        const chg = prev && prev.c > 0 ? ((bars[i].c - prev.c) / prev.c) * 100 : 0;
        const f3 = f3_volumeZ(w60.map(b => b.v), chg);
        if (!Number.isFinite(f3)) continue;
        const entry = bars[i + 1].o;
        if (!(entry > 0)) continue;
        let hi = -Infinity, lo = Infinity;
        for (let k = i + 1; k <= i + FORWARD; k++) { hi = Math.max(hi, bars[k].h); lo = Math.min(lo, bars[k].l); }
        const d = bars[i].d;
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d).push({
          f3, pv: sd20, volRatio: Math.log(sd20 / sd60),
          atr: a, atrPct: a / bars[i].c, entry, minLow: lo,
          range: ((hi - bars[i].c) / bars[i].c - (lo - bars[i].c) / bars[i].c) * 100,
        });
      }
    };
    for (const r of px) {
      if (r.ticker !== cur) { flush(); cur = r.ticker; bars = []; }
      bars.push({ d: r.date.toISOString().slice(0, 10), o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v });
    }
    flush();
  }
  const all = [...byDate.keys()].sort().filter(d => byDate.get(d).length >= MIN_CROSS);
  const anchors = all.filter((_, i) => i % STEP === 0);
  console.log(`${anchors.length} anchors, ${all[0]} .. ${all[all.length - 1]}\n`);

  /* ── CHECK 1 — the EXP-045 statistic, with the ratio added ─────────────── */
  console.log('CHECK 1 — F3 -> range. EXP-045 residualised on the LEVEL; this adds the RATIO.');
  const a1 = [], a2 = [], a3 = [];
  for (const d of anchors) {
    const rows = byDate.get(d);
    const y = rows.map(r => r.range);
    const rF3 = ranks(rows.map(r => r.f3));
    const rPv = ranks(rows.map(r => r.pv));
    const rVr = ranks(rows.map(r => r.volRatio));
    let c = spearman(residualizeMulti(rF3, [rPv]), y); if (c !== null) a1.push(c);
    c = spearman(residualizeMulti(rF3, [rPv, rVr]), y); if (c !== null) a2.push(c);
    c = spearman(rows.map(r => r.f3), rows.map(r => r.volRatio)); if (c !== null) a3.push(c);
  }
  console.log(`  level only            IC ${f4(mean(a1))}  t ${tOf(a1).toFixed(2)}   (EXP-045 reported -0.0417)`);
  console.log(`  level + VOL RATIO     IC ${f4(mean(a2))}  t ${tOf(a2).toFixed(2)}`);
  const removed = 1 - Math.abs(mean(a2)) / Math.abs(mean(a1));
  console.log(`  rho(F3, vol ratio) = ${f4(mean(a3))}`);
  console.log(`  => the ratio control removes ${(removed * 100).toFixed(1)}% of it` +
    `${Math.sign(mean(a2)) !== Math.sign(mean(a1)) ? ' AND FLIPS THE SIGN' : ''}\n`);

  /* ── CHECK 2 — the practical claim: the stop-hit gap ───────────────────── */
  console.log('CHECK 2 — the EXP-046 stop-hit gap, now bucketed on VOL RATIO as well as ATR.');
  console.log('  This is the claim that mattered: does low volume still predict more stop-outs');
  console.log('  once volatility mean-reversion is held fixed?');
  const hit = r => r.minLow <= r.entry - r.atr * MULT;
  function gap(dates, bucketKeys) {
    const out = [];
    for (const d of dates) {
      let groups = [byDate.get(d)];
      for (const key of bucketKeys) {
        const next = [];
        for (const g of groups) {
          const s = g.slice().sort((a, b) => key(a) - key(b));
          const n = s.length;
          for (let q = 0; q < QUINT; q++) next.push(s.filter((_, i) => bucketOf(i, n, QUINT) === q));
        }
        groups = next;
      }
      const gs = [];
      for (const g of groups) {
        if (g.length < QUINT * 3) continue;
        const s = g.slice().sort((a, b) => a.f3 - b.f3);
        const m = s.length;
        const lo = s.filter((_, i) => bucketOf(i, m, QUINT) === 0);
        const hi = s.filter((_, i) => bucketOf(i, m, QUINT) === QUINT - 1);
        if (!lo.length || !hi.length) continue;
        gs.push(lo.filter(hit).length / lo.length - hi.filter(hit).length / hi.length);
      }
      if (gs.length) out.push(mean(gs));
    }
    return out;
  }
  const gAtr = gap(anchors, [r => r.atrPct]);
  const gBoth = gap(anchors, [r => r.atrPct, r => r.volRatio]);
  console.log(`  ATR quintiles only            gap ${pp(mean(gAtr))}  t ${tOf(gAtr).toFixed(2)}   (EXP-046 reported +2.98/+4.65pp)`);
  console.log(`  ATR x VOL RATIO (25 cells)    gap ${pp(mean(gBoth))}  t ${tOf(gBoth).toFixed(2)}   ` +
    `<- ${Math.abs(mean(gBoth)) < Math.abs(mean(gAtr)) * 0.5 ? 'COLLAPSES' : 'largely survives'}`);
  const rem2 = 1 - Math.abs(mean(gBoth)) / Math.abs(mean(gAtr));
  console.log(`  => ${(rem2 * 100).toFixed(1)}% removed by holding volatility mean-reversion fixed`);

  console.log('\n  If CHECK 2 collapses, the practical finding of this arc is that the deployed');
  console.log('  stop is mis-set with respect to VOLATILITY MEAN-REVERSION, not volume, and');
  console.log('  every description of it as a volume effect today was wrong.');
  await pool.end();
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
