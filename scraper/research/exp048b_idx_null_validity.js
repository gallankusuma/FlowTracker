'use strict';
/**
 * EXP-048b — is the IDX null trustworthy, or was the measurement incapable?
 *
 * NOT a registered test, and it CANNOT resurrect EXP-048's finding. A null from
 * a broken instrument is worth nothing, so the only question here is whether the
 * instrument worked. Every check below can invalidate the null; none can turn it
 * into a positive.
 *
 * EXP-048 Stage 0 returned gap +0.77pp (t 0.55, p 0.59) on IDX, against
 * +2.98/+4.65/+7.61pp on US. Three reasons that could be a measurement failure
 * rather than a real difference, all cheap to check:
 *
 *   1. NO POSITIVE CONTROL WAS REGISTERED. That was an omission -- EXP-045
 *      established that a control which VOIDS the run is mandatory, and I did
 *      not carry it forward. CHECK 1 supplies it after the fact: inside an ATR
 *      quintile, residual ATR must still push the stop-hit rate. If the
 *      machinery cannot see that, it cannot see anything.
 *
 *   2. WHOLE-RUPIAH TICKS. The eligible universe median price is Rp 368, so one
 *      tick is ~0.27% of price. Pre-registered as weakness 1. CHECK 2 restricts
 *      to higher-priced names where the relative tick is finer.
 *
 *   3. A DEGENERATE F3. f3_volumeZ clamps to [0,100] and IDX volume is lumpy;
 *      if most rows sit at the same value there is nothing to rank. CHECK 3
 *      reports the distribution on both markets.
 *
 * Usage: node scraper/research/exp048b_idx_null_validity.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');
const { f3_volumeZ } = require('../modules/awo_factors');

const RESERVED_START = '2024-01-01';
const ATR_PERIOD = 14, MULT = 2.5, FORWARD = 20, STEP = 20;
const QUINT = 5, F3_WINDOW = 60, MIN_NONZERO = 48, MIN_CROSS = 100;
const PRICE_TIERS = [0, 500, 1000, 2000];

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = a => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const tOf = xs => { const m = mean(xs), s = sd(xs); return s && xs.length > 2 ? m / (s / Math.sqrt(xs.length)) : null; };
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
const pp = v => (v === null || v === undefined ? '   n/a' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + 'pp');

(async () => {
  const pool = createPool();
  console.log('EXP-048b — is the IDX null trustworthy? Post-hoc; can invalidate the null, never reverse it.\n');

  const [px] = await pool.query(
    `SELECT stock_code, date, open_price o, high_price h, low_price l, close_price c, volume v
       FROM idx_stock_prices WHERE date < ? AND close_price > 0 ORDER BY stock_code, date ASC`,
    [RESERVED_START]);

  const byDate = new Map();
  {
    let cur = null, bars = [];
    const flush = () => {
      if (bars.length < F3_WINDOW + FORWARD + 2) return;
      const atr = wilderATR(bars, ATR_PERIOD);
      for (let i = F3_WINDOW - 1; i + FORWARD < bars.length - 1; i++) {
        const a = atr[i];
        if (!a || a <= 0) continue;
        const win = bars.slice(i - F3_WINDOW + 1, i + 1);
        if (win.filter(b => b.v > 0).length < MIN_NONZERO) continue;
        const prev = bars[i - 1];
        const chg = prev && prev.c > 0 ? ((bars[i].c - prev.c) / prev.c) * 100 : 0;
        const f3 = f3_volumeZ(win.map(b => b.v), chg);
        if (!Number.isFinite(f3)) continue;
        const entry = bars[i + 1].o;
        if (!(entry > 0)) continue;
        let lo = Infinity;
        for (let k = i + 1; k <= i + FORWARD; k++) lo = Math.min(lo, bars[k].l);
        const d = bars[i].d;
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d).push({ atr: a, atrPct: a / bars[i].c, f3, entry, minLow: lo, price: bars[i].c });
      }
    };
    for (const r of px) {
      if (r.stock_code !== cur) { flush(); cur = r.stock_code; bars = []; }
      bars.push({ d: r.date.toISOString().slice(0, 10), o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v });
    }
    flush();
  }
  const all = [...byDate.keys()].sort().filter(d => byDate.get(d).length >= MIN_CROSS);
  const anchors = all.filter((_, i) => i % STEP === 0);
  const hit = r => r.minLow <= r.entry - r.atr * MULT;
  console.log(`${anchors.length} anchors, ${all.length} usable sessions\n`);

  /** Bottom-minus-top quintile hit-rate gap on `keyFn`, inside ATR quintiles. */
  function gap(dates, keyFn, filter) {
    const out = [];
    for (const d of dates) {
      let rows = byDate.get(d);
      if (filter) rows = rows.filter(filter);
      if (rows.length < MIN_CROSS) continue;
      rows = rows.slice().sort((a, b) => a.atrPct - b.atrPct);
      const n = rows.length, gs = [];
      for (let q = 0; q < QUINT; q++) {
        const bucket = rows.filter((_, i) => bucketOf(i, n, QUINT) === q);
        if (bucket.length < QUINT * 3) continue;
        const by = bucket.slice().sort((a, b) => keyFn(a) - keyFn(b));
        const m = by.length;
        const lo = by.filter((_, i) => bucketOf(i, m, QUINT) === 0);
        const hi = by.filter((_, i) => bucketOf(i, m, QUINT) === QUINT - 1);
        if (!lo.length || !hi.length) continue;
        gs.push(lo.filter(hit).length / lo.length - hi.filter(hit).length / hi.length);
      }
      if (gs.length) out.push(mean(gs));
    }
    return out;
  }

  /* ── CHECK 1 — the positive control I failed to register ───────────────── */
  console.log('CHECK 1 — POSITIVE CONTROL (omitted from the pre-registration; supplied late)');
  console.log('  Inside an ATR quintile, residual ATR must still move the stop-hit rate. If the');
  console.log('  machinery cannot see that, the null means nothing.');
  const ctrl = gap(anchors, r => -r.atrPct);   // low-ATR bottom quintile minus high-ATR top
  console.log(`  residual-ATR gap ${pp(mean(ctrl))}  t ${tOf(ctrl).toFixed(2)}  n=${ctrl.length}`);
  const ctrlOk = Math.abs(tOf(ctrl)) > 2;
  console.log(`  => ${ctrlOk ? 'CONTROL PASSES — the instrument works, so the F3 null is real'
    : 'CONTROL FAILS — the instrument is blind and the F3 null proves nothing'}\n`);

  /* ── CHECK 2 — tick granularity ────────────────────────────────────────── */
  console.log('CHECK 2 — the F3 gap by price floor (whole-rupiah ticks bite hardest on cheap names)');
  console.log('    floor      n anchors        gap        t     median price');
  for (const floor of PRICE_TIERS) {
    const g = gap(anchors, r => r.f3, r => r.price >= floor);
    if (g.length < 5) { console.log(`    >= ${String(floor).padEnd(6)} too few anchors`); continue; }
    const med = (() => {
      const ps = all.flatMap(d => byDate.get(d).filter(r => r.price >= floor).map(r => r.price)).sort((a, b) => a - b);
      return ps.length ? ps[Math.floor(ps.length / 2)] : null;
    })();
    console.log(`    >= ${String(floor).padEnd(6)} ${String(g.length).padStart(9)}  ${pp(mean(g)).padStart(9)}  ` +
      `${tOf(g).toFixed(2).padStart(7)}     Rp ${med === null ? '?' : med.toFixed(0)}`);
  }
  console.log('  A gap appearing only at a high floor would be a SUBGROUP result after a null and');
  console.log('  could not be claimed without its own registration on fresh data.\n');

  /* ── CHECK 3 — is F3 degenerate on IDX? ────────────────────────────────── */
  console.log('CHECK 3 — F3 distribution on IDX (a clamped or flat factor cannot be ranked)');
  const f3all = all.flatMap(d => byDate.get(d).map(r => r.f3));
  const at = v => (f3all.filter(x => Math.abs(x - v) < 0.5).length / f3all.length * 100).toFixed(1);
  const srt = f3all.slice().sort((a, b) => a - b);
  const q = p => srt[Math.floor(srt.length * p)];
  console.log(`  n ${f3all.length}   mean ${mean(f3all).toFixed(1)}   sd ${sd(f3all).toFixed(1)}`);
  console.log(`  p1 ${q(0.01).toFixed(1)}  p10 ${q(0.10).toFixed(1)}  p50 ${q(0.50).toFixed(1)}  ` +
    `p90 ${q(0.90).toFixed(1)}  p99 ${q(0.99).toFixed(1)}`);
  console.log(`  share at 0: ${at(0)}%   at 50: ${at(50)}%   at 100: ${at(100)}%`);
  const spread = q(0.90) - q(0.10);
  console.log(`  p10-p90 spread ${spread.toFixed(1)} points ` +
    `${spread < 10 ? '<- NARROW, ranking is nearly arbitrary' : '<- wide enough to rank'}`);

  console.log('\n  EXP-048\'s registered null stands regardless of everything above. The reserved');
  console.log(`  period [${RESERVED_START} ..] was not read here either.`);
  await pool.end();
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
