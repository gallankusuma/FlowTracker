'use strict';
/**
 * EXP-048 — does the stop miscalibration exist on IDX, and can a properly
 * fitted beta fix it? Stages 0-2 only.
 *
 * Pre-registered in PREREGISTRATION_2026-09-02_idx_stop_reserve.md.
 *
 * ── THIS SCRIPT CANNOT OPEN THE RESERVED PERIOD ──────────────────────────────
 *
 * 2024-01-01 onward is excluded IN SQL and there is no flag to override it. That
 * is deliberate: EXP-047 spent the only US holdout on a candidate whose fit had
 * never been checked, and got 8.8% of a promised 42%. The gate below is the step
 * that was missing. Opening the IDX reserve requires a separate sealed script.
 *
 * ── THE TWO ERRORS BEING CORRECTED ───────────────────────────────────────────
 *
 *   1. EXP-046's fit minimised the max-minus-min hit rate across five ~16-name
 *      cells -- about 23pp of sampling noise against a 3-5pp effect. Here beta
 *      is fitted against |gap|, the statistic that actually carries signal.
 *
 *   2. EXP-047's seal asked only whether the gap got SMALLER, with no magnitude
 *      bar and no significance test on the improvement. Here the gate requires a
 *      >= 40% reduction AND a paired test at p < 0.05.
 *
 * Usage: node scraper/research/exp048_idx_stop_reserve.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');
const { f3_volumeZ } = require('../modules/awo_factors');

/* ── Frozen by the pre-registration ─────────────────────────────────────── */
const FIT_END = '2021-01-01';        // FIT is [start, FIT_END)
const CHECK_END = '2024-01-01';      // CHECK is [FIT_END, CHECK_END)
const RESERVED_START = '2024-01-01'; // never read here
const ATR_PERIOD = 14;
const MULT = 2.5;
const FORWARD = 20;
const STEP = 20;
const QUINT = 5;
const F3_WINDOW = 60;
const MIN_NONZERO = 48;              // of the last 60 sessions
const MIN_CROSS = 100;
const GAP_FLOOR_PP = 2.0;            // Stage 0 stop condition
const GATE_REDUCTION = 0.40;         // Stage 2: >= 40%
const ADJ_FLOOR = 0.2;

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = a => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
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
function oneSample(xs) {
  const m = mean(xs), s = sd(xs), n = xs.length;
  if (!s || n < 3) return null;
  const se = s / Math.sqrt(n), t = m / se, df = n - 1, half = tCrit95(df) * se;
  return { mean: m, sd: s, n, t, p: tTwoSided(t, df), lo: m - half, hi: m + half };
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
const pp = v => (v === null || v === undefined ? '   n/a' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + 'pp');

(async () => {
  const pool = createPool();

  console.log('EXP-048 — the stop miscalibration on IDX. Stages 0-2 only.');
  console.log('  pre-registered in PREREGISTRATION_2026-09-02_idx_stop_reserve.md — TWO-SIDED');
  console.log(`  FIT [.. ${FIT_END})   CHECK [${FIT_END} .. ${CHECK_END})   RESERVED [${RESERVED_START} ..] NOT READ`);
  console.log('  this script has NO flag to open the reserve; the exclusion is in SQL');
  console.log(`  gate: candidate must cut |gap| by >= ${GATE_REDUCTION * 100}% AND the paired improvement must clear p < 0.05`);
  console.log('  entry-agnostic, no target, no costs — Stage 3 is where the full trade plan applies');
  console.log('  IDX prices are whole rupiah: cheap names have coarse ticks and their hit rates are');
  console.log('  biased upward. Not corrected; the eligible universe median price is reported.');
  console.log('');

  const [px] = await pool.query(
    `SELECT stock_code, date, open_price o, high_price h, low_price l, close_price c, volume v
       FROM idx_stock_prices WHERE date < ? AND close_price > 0 ORDER BY stock_code, date ASC`,
    [RESERVED_START]);
  console.log(`${px.length} price rows read, all strictly before ${RESERVED_START}`);

  const byDate = new Map();
  let tickers = 0, skippedIlliquid = 0;
  {
    let cur = null, bars = [];
    const flush = () => {
      if (bars.length < F3_WINDOW + FORWARD + 2) return;
      tickers++;
      const atr = wilderATR(bars, ATR_PERIOD);
      for (let i = F3_WINDOW - 1; i + FORWARD < bars.length - 1; i++) {
        const a = atr[i];
        if (!a || a <= 0) continue;
        const win = bars.slice(i - F3_WINDOW + 1, i + 1);
        const nonzero = win.filter(b => b.v > 0).length;
        if (nonzero < MIN_NONZERO) { skippedIlliquid++; continue; }
        const prev = bars[i - 1];
        const dailyChangePct = prev && prev.c > 0 ? ((bars[i].c - prev.c) / prev.c) * 100 : 0;
        // The production function and the production window -- not a re-derivation.
        const f3 = f3_volumeZ(win.map(b => b.v), dailyChangePct);
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
  const fit = anchors.filter(d => d < FIT_END);
  const check = anchors.filter(d => d >= FIT_END && d < CHECK_END);
  const prices = all.flatMap(d => byDate.get(d).map(r => r.price)).sort((a, b) => a - b);
  console.log(`${tickers} tickers, ${skippedIlliquid} ticker-days dropped as illiquid`);
  console.log(`${all.length} usable sessions (>= ${MIN_CROSS} names), ${anchors.length} anchors: ` +
    `FIT ${fit.length}, CHECK ${check.length}`);
  console.log(`eligible universe median price: Rp ${prices[Math.floor(prices.length / 2)].toFixed(0)}\n`);

  // z(F3) within date across the eligible cross-section.
  for (const d of all) {
    const rows = byDate.get(d);
    const m = mean(rows.map(r => r.f3)), s = sd(rows.map(r => r.f3)) || 1;
    for (const r of rows) r._z = (r.f3 - m) / s;
  }
  const hit = (r, beta) =>
    r.minLow <= r.entry - r.atr * MULT * Math.max(ADJ_FLOOR, 1 + beta * r._z);

  /** gap = hitRate(F3 bottom quintile) - hitRate(F3 top quintile), inside ATR quintiles. */
  function gapAt(d, beta) {
    const rows = byDate.get(d).slice().sort((a, b) => a.atrPct - b.atrPct);
    const n = rows.length, gs = [];
    for (let q = 0; q < QUINT; q++) {
      const bucket = rows.filter((_, i) => bucketOf(i, n, QUINT) === q);
      if (bucket.length < QUINT * 3) continue;
      const byF3 = bucket.slice().sort((a, b) => a.f3 - b.f3);
      const m = byF3.length;
      const lo = byF3.filter((_, i) => bucketOf(i, m, QUINT) === 0);
      const hi = byF3.filter((_, i) => bucketOf(i, m, QUINT) === QUINT - 1);
      if (!lo.length || !hi.length) continue;
      gs.push(lo.filter(r => hit(r, beta)).length / lo.length - hi.filter(r => hit(r, beta)).length / hi.length);
    }
    return gs.length ? mean(gs) : null;
  }
  const series = (set, beta) => set.map(d => gapAt(d, beta)).filter(v => v !== null);

  /* ── STAGE 0 — does it replicate on IDX at all? ────────────────────────── */
  console.log('='.repeat(88));
  console.log('STAGE 0 — does the miscalibration replicate on IDX?  (FIT segment)');
  const s0 = oneSample(series(fit, 0));
  const baseHit = mean(fit.flatMap(d => byDate.get(d).map(r => (hit(r, 0) ? 1 : 0))));
  console.log(`  anchors ${s0.n}   base stop-hit rate ${(baseHit * 100).toFixed(1)}%`);
  console.log(`  gap ${pp(s0.mean)}   95% CI [${pp(s0.lo)}, ${pp(s0.hi)}]   t ${s0.t.toFixed(2)}   p ${s0.p.toFixed(4)}`);
  const stage0 = Math.abs(s0.mean) * 100 >= GAP_FLOOR_PP && s0.p < 0.05;
  console.log(`  |gap| >= ${GAP_FLOOR_PP}pp and p < 0.05 ... ${stage0 ? 'YES' : 'NO'}`);
  if (!stage0) {
    console.log('\n  STOP. The US finding did not travel to IDX. Nothing is fitted, nothing is');
    console.log('  sealed, and the reserved period stays shut. Recorded as such.');
    console.log(`\n  RESERVED [${RESERVED_START} ..] untouched. Forward reserve from 2026-09-02 stands.`);
    await pool.end();
    return;
  }

  /* ── STAGE 1 — fit beta against the signal-bearing statistic ───────────── */
  console.log(`\n${'='.repeat(88)}`);
  console.log('STAGE 1 — fit beta on FIT ONLY, minimising |gap| (NOT max-minus-min, which failed in EXP-046)');
  let best = 0, bestAbs = Infinity;
  for (let b = -0.60; b <= 0.6001; b += 0.01) {
    const g = Math.abs(mean(series(fit, Math.round(b * 1000) / 1000)) ?? 1);
    if (g < bestAbs) { bestAbs = g; best = Math.round(b * 1000) / 1000; }
  }
  const fitCand = oneSample(series(fit, best));
  console.log(`  fitted beta: ${best >= 0 ? '+' : ''}${best.toFixed(3)}`);
  console.log(`  FIT gap: incumbent ${pp(s0.mean)} -> candidate ${pp(fitCand.mean)} ` +
    `(${((1 - Math.abs(fitCand.mean) / Math.abs(s0.mean)) * 100).toFixed(1)}% reduction, in-sample)`);
  console.log('  In-sample reduction is not evidence. The gate below is.');

  /* ── STAGE 2 — the gate ────────────────────────────────────────────────── */
  console.log(`\n${'='.repeat(88)}`);
  console.log('STAGE 2 — THE GATE, on CHECK, with beta frozen');
  const cInc = series(check, 0), cCan = series(check, best);
  const gInc = oneSample(cInc), gCan = oneSample(cCan);
  const paired = oneSample(check.map(d => {
    const a = gapAt(d, 0), b = gapAt(d, best);
    return a === null || b === null ? null : Math.abs(a) - Math.abs(b);
  }).filter(v => v !== null));
  const reduction = 1 - Math.abs(gCan.mean) / Math.abs(gInc.mean);
  console.log(`  anchors ${gInc.n}`);
  console.log(`  incumbent gap ${pp(gInc.mean)}  95% CI [${pp(gInc.lo)}, ${pp(gInc.hi)}]  t ${gInc.t.toFixed(2)}  p ${gInc.p.toFixed(4)}`);
  console.log(`  candidate gap ${pp(gCan.mean)}  95% CI [${pp(gCan.lo)}, ${pp(gCan.hi)}]  t ${gCan.t.toFixed(2)}  p ${gCan.p.toFixed(4)}`);
  console.log(`  reduction ${(reduction * 100).toFixed(1)}%   (bar: ${GATE_REDUCTION * 100}%)`);
  console.log(`  paired improvement ${pp(paired.mean)}  95% CI [${pp(paired.lo)}, ${pp(paired.hi)}]  ` +
    `t ${paired.t.toFixed(2)}  p ${paired.p.toFixed(4)}`);
  const g1 = reduction >= GATE_REDUCTION;
  const g2 = paired.mean > 0 && paired.p < 0.05;
  console.log(`\n  gate 1: reduction >= ${GATE_REDUCTION * 100}% ............. ${g1 ? 'YES' : 'no'}`);
  console.log(`  gate 2: paired improvement p < 0.05 ...... ${g2 ? 'YES' : 'no'}`);
  const passed = g1 && g2;
  console.log(`\n  VERDICT: ${passed
    ? 'GATE PASSED — a candidate seal may now be written and the IDX reserve opened ONCE'
    : 'GATE FAILED — the reserved period is NOT opened and survives for a better candidate'}`);
  if (!passed) {
    console.log('  The effect may still be real on IDX (Stage 0 said so); this one-parameter');
    console.log('  remedy is what failed. That is the distinction EXP-047 could not make.');
  }
  console.log(`\n  RESERVED [${RESERVED_START} ..] not read by this script. Forward reserve from 2026-09-02 stands.`);
  console.log('  Whole-rupiah ticks, survivorship and gap risk all bias hit rates; both arms share them.');

  await pool.end();
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
