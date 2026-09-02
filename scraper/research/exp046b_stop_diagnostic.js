'use strict';
/**
 * EXP-046b — post-hoc checks on the EXP-046 primary, plus a correction to my own
 * secondary arm.
 *
 * NOT a registered test. It cannot upgrade EXP-046's verdict. It can undermine
 * the primary, and it can explain why the secondary failed -- nothing else.
 *
 * ── WHAT NEEDS BREAKING ──────────────────────────────────────────────────────
 *
 * EXP-046 found the deployed 2.5x ATR stop is hit 2.98pp more often (discovery,
 * t 4.05) and 4.65pp more often (validation, t 4.44) for low-F3 names than
 * high-F3 names at the same ATR-relative distance.
 *
 * The dangerous alternative explanation was flagged in the pre-registration as
 * weakness 6 and the run confirmed the room for it: the mean ATR spread INSIDE
 * an ATR quintile is 45.8%. If low-F3 names sit systematically at the high end
 * of their own bucket, the whole result is residual volatility wearing F3's
 * name. CHECK 1 measures that gradient directly; CHECK 2 re-runs the primary on
 * ATR DECILES, which roughly halves the room.
 *
 * ── AND A MISTAKE OF MINE ────────────────────────────────────────────────────
 *
 * The registered secondary fitted beta to minimise the max-minus-min hit rate
 * across five F3 quintiles. With ~16 names per cell, a hit-rate estimate carries
 * a standard error near 12pp, so max-minus-min over five of them is ~23pp of
 * almost pure sampling noise -- which is exactly what the run reported (23.58pp,
 * against a real top-to-bottom effect of 3-5pp). Minimising that objective is
 * minimising noise, and it returned beta = -0.020, i.e. nothing.
 *
 * So "the proposed fix does not work" is a statement about MY OBJECTIVE, not
 * about whether the miscalibration is fixable. The registered verdict stands
 * either way; CHECK 3 refits against the signal-bearing statistic so the
 * question is at least answered rather than left mislabelled.
 *
 * Usage: node scraper/research/exp046b_stop_diagnostic.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');

const MIN_CROSS = 100;
const STEP = 20, FORWARD = 20;
const SPLIT = '2019-01-01';
const HOLDOUT_START = '2024-01-01';
const ATR_PERIOD = 14, MULT = 2.5;
const QUINT = 5;

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = a => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const tOf = xs => { const m = mean(xs), s = sd(xs); return s ? m / (s / Math.sqrt(xs.length)) : null; };
const pp = v => (v === null || v === undefined ? '   n/a' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + 'pp');

function wilderATR(bars, period) {
  const out = new Array(bars.length).fill(null);
  let prevATR = null, trSum = 0;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    if (i <= period) { trSum += tr; if (i === period) { prevATR = trSum / period; out[i] = prevATR; } }
    else { prevATR = (prevATR * (period - 1) + tr) / period; out[i] = prevATR; }
  }
  return out;
}
const bucketOf = (i, n, k) => Math.min(k - 1, Math.floor((i * k) / n));

(async () => {
  const pool = createPool();
  console.log('EXP-046b — post-hoc. Cannot upgrade the verdict; can only undermine it or explain the secondary.\n');

  const [sig] = await pool.query(
    'SELECT data_date, ticker, f3_volume_z FROM us_signal_history WHERE data_date < ? ORDER BY data_date',
    [HOLDOUT_START]);
  const f3 = new Map();
  for (const r of sig) f3.set(`${r.ticker}|${r.data_date.toISOString().slice(0, 10)}`, Number(r.f3_volume_z));

  const [px] = await pool.query(
    'SELECT ticker, date, open_price o, high_price h, low_price l, close_price c FROM us_stock_prices ORDER BY ticker, date ASC');

  const byDate = new Map();
  {
    let cur = null, bars = [];
    const flush = () => {
      if (!bars.length) return;
      const atr = wilderATR(bars, ATR_PERIOD);
      for (let i = ATR_PERIOD; i + FORWARD < bars.length; i++) {
        const a = atr[i];
        if (!a || a <= 0) continue;
        const z = f3.get(`${cur}|${bars[i].d}`);
        if (z === undefined || !Number.isFinite(z)) continue;
        const entry = bars[i + 1].o;
        if (!(entry > 0)) continue;
        let lo = Infinity;
        for (let k = i + 1; k <= i + FORWARD; k++) lo = Math.min(lo, bars[k].l);
        if (!byDate.has(bars[i].d)) byDate.set(bars[i].d, []);
        byDate.get(bars[i].d).push({ atrPct: a / bars[i].c, f3: z, entry, minLow: lo, atr: a });
      }
    };
    for (const r of px) {
      if (r.ticker !== cur) { flush(); cur = r.ticker; bars = []; }
      bars.push({ d: r.date.toISOString().slice(0, 10), o: +r.o, h: +r.h, l: +r.l, c: +r.c });
    }
    flush();
  }
  const all = [...byDate.keys()].sort().filter(d => byDate.get(d).length >= MIN_CROSS);
  const anchors = all.filter((_, i) => i % STEP === 0);
  const disc = anchors.filter(d => d < SPLIT), val = anchors.filter(d => d >= SPLIT);
  for (const d of all) {
    const rows = byDate.get(d);
    const m = mean(rows.map(r => r.f3)), s = sd(rows.map(r => r.f3)) || 1;
    for (const r of rows) r._z = (r.f3 - m) / s;
  }
  const hit = (r, adj) => r.minLow <= r.entry - r.atr * MULT * adj;
  console.log(`${anchors.length} anchors: ${disc.length} discovery, ${val.length} validation\n`);

  /* ── CHECK 1 — is F3 just residual ATR inside its own bucket? ──────────── */
  console.log('CHECK 1 — mean ATR% by F3 quintile, INSIDE ATR quintiles');
  console.log('  If low-F3 names sit at the high-ATR end of their own bucket, the result is');
  console.log('  residual volatility wearing F3\'s name.');
  const atrByF3 = Array.from({ length: QUINT }, () => []);
  for (const d of anchors) {
    const rows = byDate.get(d).slice().sort((a, b) => a.atrPct - b.atrPct);
    const n = rows.length;
    for (let q = 0; q < QUINT; q++) {
      const bucket = rows.filter((_, i) => bucketOf(i, n, QUINT) === q);
      if (bucket.length < QUINT * 3) continue;
      const byF3 = bucket.slice().sort((a, b) => a.f3 - b.f3);
      const m = byF3.length;
      for (let g = 0; g < QUINT; g++) {
        const cell = byF3.filter((_, i) => bucketOf(i, m, QUINT) === g);
        if (cell.length) atrByF3[g].push(mean(cell.map(r => r.atrPct)) / mean(bucket.map(r => r.atrPct)));
      }
    }
  }
  console.log('    F3 quintile:  ' + atrByF3.map((_, i) => `Q${i + 1}`.padStart(9)).join(''));
  console.log('    ATR vs bucket:' + atrByF3.map(a => ((mean(a) - 1) * 100).toFixed(2).padStart(8) + '%').join(''));
  const grad = (mean(atrByF3[0]) - mean(atrByF3[QUINT - 1])) * 100;
  console.log(`    low-F3 minus high-F3 ATR: ${grad >= 0 ? '+' : ''}${grad.toFixed(2)}% of bucket mean ` +
    `${Math.abs(grad) > 5 ? '<- LARGE, the primary may be residual ATR' : '<- small'}\n`);

  /* ── CHECK 2 — finer conditioning ──────────────────────────────────────── */
  console.log('CHECK 2 — the primary re-run on ATR DECILES (about half the residual room)');
  function diffAt(dates, k, beta) {
    const out = [];
    for (const d of dates) {
      const rows = byDate.get(d).slice().sort((a, b) => a.atrPct - b.atrPct);
      const n = rows.length, ds = [];
      for (let q = 0; q < k; q++) {
        const bucket = rows.filter((_, i) => bucketOf(i, n, k) === q);
        if (bucket.length < QUINT * 3) continue;
        const byF3 = bucket.slice().sort((a, b) => a.f3 - b.f3);
        const m = byF3.length;
        const lo = byF3.filter((_, i) => bucketOf(i, m, QUINT) === 0);
        const hi = byF3.filter((_, i) => bucketOf(i, m, QUINT) === QUINT - 1);
        if (!lo.length || !hi.length) continue;
        const adj = r => (beta ? Math.max(0.2, 1 + beta * r._z) : 1);
        ds.push(lo.filter(r => hit(r, adj(r))).length / lo.length - hi.filter(r => hit(r, adj(r))).length / hi.length);
      }
      if (ds.length) out.push(mean(ds));
    }
    return out;
  }
  for (const [name, set] of [['DISCOVERY', disc], ['VALIDATION', val]]) {
    const q5 = diffAt(set, 5, 0), q10 = diffAt(set, 10, 0);
    console.log(`  ${name}:  ATR quintiles ${pp(mean(q5))} (t ${tOf(q5).toFixed(2)})   ` +
      `ATR deciles ${pp(mean(q10))} (t ${tOf(q10).toFixed(2)})`);
  }
  console.log('');

  /* ── CHECK 3 — the secondary, refitted against a statistic with signal ─── */
  console.log('CHECK 3 — refit beta against the TOP-MINUS-BOTTOM diff, not max-minus-min spread');
  console.log('  The registered objective was max-minus-min over five ~16-name cells. At a ~35%');
  console.log('  base rate each cell carries SE ~12pp, so that statistic is ~23pp of sampling');
  console.log('  noise against a 3-5pp real effect. Minimising it minimised noise.');
  let best = 0, bestAbs = Infinity;
  for (let b = -0.60; b <= 0.6001; b += 0.02) {
    const m = Math.abs(mean(diffAt(disc, 5, b)));
    if (m < bestAbs) { bestAbs = m; best = Math.round(b * 1000) / 1000; }
  }
  const dv = diffAt(val, 5, best), dd = diffAt(disc, 5, best);
  const d0 = diffAt(disc, 5, 0), v0 = diffAt(val, 5, 0);
  console.log(`  refitted beta (discovery only): ${best >= 0 ? '+' : ''}${best.toFixed(3)}`);
  console.log(`    discovery  incumbent ${pp(mean(d0))} (t ${tOf(d0).toFixed(2)})  ->  candidate ${pp(mean(dd))} (t ${tOf(dd).toFixed(2)})`);
  console.log(`    VALIDATION incumbent ${pp(mean(v0))} (t ${tOf(v0).toFixed(2)})  ->  candidate ${pp(mean(dv))} (t ${tOf(dv).toFixed(2)})  ` +
    `${Math.abs(mean(dv)) < Math.abs(mean(v0)) ? 'REDUCED' : 'not reduced'}`);
  console.log('\n  Whatever this says, EXP-046\'s registered verdict stands: the fix arm was');
  console.log('  specified before the run and it failed on its own terms.');

  await pool.end();
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
