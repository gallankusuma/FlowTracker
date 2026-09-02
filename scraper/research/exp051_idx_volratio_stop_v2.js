'use strict';
/**
 * EXP-051 — a volatility-ratio-adjusted stop on IDX. Stages 0-2 only.
 *
 * Pre-registered in PREREGISTRATION_2026-09-02_idx_volratio_stop_v2.md, which
 * supersedes v1 after EXP-050 voided itself.
 *
 * ── WHAT CHANGED FROM EXP-050, AND ONLY THIS ─────────────────────────────────
 *
 * v1's positive control demanded EXP-049b's -0.1698 but computed the RAW
 * correlation; EXP-049b had measured it RESIDUALISED ON THE VOLATILITY LEVEL.
 * The band came from one statistic and the code computed another, so the run
 * voided before Stage 0. The control below computes the residualised statistic
 * its band was always written for. Nothing else moved.
 *
 * ── AND THE WARNING THAT CAME OUT OF THAT ────────────────────────────────────
 *
 * Raw VOL_RATIO -> range is +0.0773; residualised on the level it is -0.1698.
 * THE SIGN FLIPS. That is the same suppression structure that killed the F3
 * finding in EXP-049c. It does not make mean-reversion wrong -- EXP-049b's
 * non-parametric checks held inside level quintiles -- but v1's claim that the
 * Stage 0 prediction is "near-mechanical" was OVERSTATED, and is withdrawn.
 * Which sign appears in stop-hit rates depends on how completely ATR-quintile
 * conditioning strips the level, which is empirical, not arithmetic.
 *
 * THE INTERESTING QUESTION IS STAGE 2 -- whether one frozen parameter actually
 * repairs it out of sample. EXP-047 showed that is a far harder bar than being
 * right about the direction: a candidate that promised 42% delivered 8.8%.
 *
 * ── WHAT THIS SCRIPT CANNOT DO ───────────────────────────────────────────────
 *
 * It cannot open the IDX reserve. 2024-01-01 onward is excluded in SQL and there
 * is no flag. Opening it needs a separate sealed script, and only if the gate
 * below passes.
 *
 * ── THE LESSON FROM EXP-045, APPLIED ─────────────────────────────────────────
 *
 * That finding died because four kill attempts all conditioned on the same
 * variable. So a second control axis is REGISTERED here rather than added later:
 * a high volatility ratio usually belongs to a stock that recently moved a lot,
 * so the gap is also measured inside recent-return buckets. If it collapses
 * there, that is the finding, and it is printed BEFORE the verdict.
 *
 * Usage: node scraper/research/exp050_idx_volratio_stop.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');

/* ── Frozen by the pre-registration ─────────────────────────────────────── */
const FIT_END = '2021-01-01';
const CHECK_END = '2024-01-01';
const RESERVED_START = '2024-01-01';
const ATR_PERIOD = 14, MULT = 2.5;
const FORWARD = 20, STEP = 20;
const VOL_WINDOW = 20, LONG_WINDOW = 60;
const QUINT = 5, MIN_NONZERO = 48, MIN_CROSS = 100;
const GAP_FLOOR_PP = 2.0;
const GATE_REDUCTION = 0.40;
const ADJ_FLOOR = 0.2;
const CONTROL_IC_BAND = [-0.22, -0.12];   // must reproduce EXP-049b's IDX -0.1698
const CONTROL_MAX_P = 0.01;

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
/** Residual of y on a single predictor x. */
function residualizeOne(y, x) {
  const my = mean(y), mx = mean(x);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < y.length; i++) { const a = x[i] - mx; sxx += a * a; sxy += a * (y[i] - my); }
  const b = sxx > 0 ? sxy / sxx : 0;
  return y.map((v, i) => (v - my) - b * (x[i] - mx));
}
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
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (tTwoSided(m, df) > 0.05) lo = m; else hi = m; }
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
const f4 = v => (v === null || v === undefined ? '    n/a' : (v >= 0 ? '+' : '') + v.toFixed(4));

(async () => {
  const pool = createPool();
  console.log('EXP-051 — a volatility-ratio-adjusted stop on IDX. Stages 0-2 only.');
  console.log('  pre-registered in PREREGISTRATION_2026-09-02_idx_volratio_stop_v2.md — TWO-SIDED');
  console.log('  supersedes EXP-050, which voided on a control I had mis-specified');
  console.log('  the "near-mechanical" claim from v1 is WITHDRAWN: raw and residualised');
  console.log('  VOL_RATIO have opposite signs, so Stage 0 is genuinely uncertain in direction.');
  console.log(`  FIT [.. ${FIT_END})  CHECK [${FIT_END} .. ${CHECK_END})  RESERVED [${RESERVED_START} ..] unreadable`);
  console.log(`  gate: >= ${GATE_REDUCTION * 100}% reduction AND paired improvement p < 0.05`);
  console.log('');

  const [px] = await pool.query(
    `SELECT stock_code, date, open_price o, high_price h, low_price l, close_price c, volume v
       FROM idx_stock_prices WHERE date < ? AND close_price > 0 ORDER BY stock_code, date ASC`,
    [RESERVED_START]);
  console.log(`${px.length} price rows, all strictly before ${RESERVED_START}`);

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
        if (w60.filter(b => b.v > 0).length < MIN_NONZERO) continue;
        const ret = w => w.map((b, k) => (k === 0 ? null : (b.c - w[k - 1].c) / w[k - 1].c * 100)).filter(v => v !== null);
        const sd20 = sd(ret(w20)), sd60 = sd(ret(w60));
        if (!sd20 || !sd60 || !(sd20 > 0) || !(sd60 > 0)) continue;
        const entry = bars[i + 1].o;
        if (!(entry > 0)) continue;
        let hi = -Infinity, lo = Infinity;
        for (let k = i + 1; k <= i + FORWARD; k++) { hi = Math.max(hi, bars[k].h); lo = Math.min(lo, bars[k].l); }
        const c0 = bars[i].c, cPrev20 = w20[0].c;
        const d = bars[i].d;
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d).push({
          atr: a, atrPct: a / c0, pv: sd20,
          volRatio: Math.log(sd20 / sd60),
          recentRet: cPrev20 > 0 ? (c0 - cPrev20) / cPrev20 : 0,
          entry, minLow: lo,
          range: ((hi - c0) / c0 - (lo - c0) / c0) * 100,
        });
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
  console.log(`${all.length} usable sessions, ${anchors.length} anchors: FIT ${fit.length}, CHECK ${check.length}\n`);

  for (const d of all) {
    const rows = byDate.get(d);
    const m = mean(rows.map(r => r.volRatio)), s = sd(rows.map(r => r.volRatio)) || 1;
    for (const r of rows) r._z = (r.volRatio - m) / s;
  }
  const hit = (r, beta) => r.minLow <= r.entry - r.atr * MULT * Math.max(ADJ_FLOOR, 1 + beta * r._z);

  /* ── POSITIVE CONTROLS — a failure voids everything ─────────────────────── */
  console.log('='.repeat(88));
  console.log('POSITIVE CONTROLS (registered; EXP-048 omitted these and had to add them late)');
  // RESIDUALISED on the volatility level -- the correction that defines v2.
  // The raw version is computed too, printed, and is NOT a criterion.
  const icRes = [], icRaw = [];
  for (const d of anchors) {
    const rows = byDate.get(d);
    const y = rows.map(r => r.range);
    const rVr = ranks(rows.map(r => r.volRatio));
    const rPv = ranks(rows.map(r => r.pv));
    const a = spearman(residualizeOne(rVr, rPv), y);
    if (a !== null && Number.isFinite(a)) icRes.push(a);
    const b = spearman(rows.map(r => r.volRatio), y);
    if (b !== null && Number.isFinite(b)) icRaw.push(b);
  }
  const c1 = oneSample(icRes);
  const c1raw = oneSample(icRaw);
  const c1ok = c1.mean >= CONTROL_IC_BAND[0] && c1.mean <= CONTROL_IC_BAND[1] && c1.p < CONTROL_MAX_P;
  console.log(`  1. VOL_RATIO vs range, RESIDUALISED on the vol level: IC ${f4(c1.mean)}  t ${c1.t.toFixed(2)}`);
  console.log(`     must land in [${CONTROL_IC_BAND[0]}, ${CONTROL_IC_BAND[1]}] to match EXP-049b's -0.1698 ... ${c1ok ? 'PASS' : 'FAIL'}`);
  console.log(`     (raw, for reference only, NOT a criterion: ${f4(c1raw.mean)} — the sign flip that`);
  console.log(`      voided EXP-050 and downgraded the Stage 0 prior)`);

  /** gap = hitRate(bottom quintile of keyFn) - hitRate(top), inside ATR quintiles. */
  function gapOn(dates, keyFn, beta, secondAxis) {
    const out = [];
    for (const d of dates) {
      let groups = [byDate.get(d)];
      const axes = secondAxis ? [r => r.atrPct, secondAxis] : [r => r.atrPct];
      for (const ax of axes) {
        const next = [];
        for (const g of groups) {
          const s = g.slice().sort((a, b) => ax(a) - ax(b));
          const n = s.length;
          for (let q = 0; q < QUINT; q++) next.push(s.filter((_, i) => bucketOf(i, n, QUINT) === q));
        }
        groups = next;
      }
      const gs = [];
      for (const g of groups) {
        if (g.length < QUINT * 3) continue;
        const s = g.slice().sort((a, b) => keyFn(a) - keyFn(b));
        const m = s.length;
        const lo = s.filter((_, i) => bucketOf(i, m, QUINT) === 0);
        const hi = s.filter((_, i) => bucketOf(i, m, QUINT) === QUINT - 1);
        if (!lo.length || !hi.length) continue;
        gs.push(lo.filter(r => hit(r, beta)).length / lo.length - hi.filter(r => hit(r, beta)).length / hi.length);
      }
      if (gs.length) out.push(mean(gs));
    }
    return out;
  }
  const ctrl2 = oneSample(gapOn(anchors, r => -r.atrPct, 0));
  const c2ok = Math.abs(ctrl2.t) > 2;
  console.log(`  2. residual ATR inside ATR quintiles: gap ${pp(ctrl2.mean)}  t ${ctrl2.t.toFixed(2)} ... ${c2ok ? 'PASS' : 'FAIL'}`);
  if (!c1ok || !c2ok) {
    console.log('\n  *** VOID. A positive control failed; nothing else in this run may be read. ***');
    await pool.end();
    return;
  }

  /* ── STAGE 0 ───────────────────────────────────────────────────────────── */
  console.log(`\n${'='.repeat(88)}`);
  console.log('STAGE 0 — is the ATR stop miscalibrated w.r.t. VOL_RATIO?  (FIT)');
  const s0series = gapOn(fit, r => r.volRatio, 0);
  const s0 = oneSample(s0series);
  const baseHit = mean(fit.flatMap(d => byDate.get(d).map(r => (hit(r, 0) ? 1 : 0))));
  console.log(`  anchors ${s0.n}   base stop-hit rate ${(baseHit * 100).toFixed(1)}%`);
  console.log(`  gap ${pp(s0.mean)}   95% CI [${pp(s0.lo)}, ${pp(s0.hi)}]   t ${s0.t.toFixed(2)}   p ${s0.p.toFixed(4)}`);
  const stage0 = Math.abs(s0.mean) * 100 >= GAP_FLOOR_PP && s0.p < 0.05;
  console.log(`  |gap| >= ${GAP_FLOOR_PP}pp and p < 0.05 ... ${stage0 ? 'YES' : 'NO'}`);
  if (!stage0) {
    console.log('\n  STOP. ATR(14) apparently already absorbs the mean-reversion. Nothing fitted,');
    console.log('  nothing sealed, reserve shut. That would be the surprising outcome, and it is');
    console.log('  informative about how ATR(14) relates to 20-session realised volatility.');
    await pool.end();
    return;
  }

  /* ── REGISTERED SECONDARY — printed BEFORE the verdict ─────────────────── */
  console.log(`\n${'='.repeat(88)}`);
  console.log('REGISTERED SECONDARY — what else could VOL_RATIO be? (the EXP-045 lesson)');
  console.log('  A high volatility ratio usually belongs to a stock that recently moved a lot.');
  const byRet = oneSample(gapOn(fit, r => r.volRatio, 0, r => r.recentRet));
  console.log(`  gap inside ATR quintiles only ............ ${pp(s0.mean)}  t ${s0.t.toFixed(2)}`);
  console.log(`  gap inside ATR x RECENT-RETURN (25 cells)  ${pp(byRet.mean)}  t ${byRet.t.toFixed(2)}`);
  const survivesRet = Math.abs(byRet.mean) >= Math.abs(s0.mean) * 0.5;
  console.log(`  => ${((1 - Math.abs(byRet.mean) / Math.abs(s0.mean)) * 100).toFixed(1)}% removed by holding recent return fixed ` +
    `${survivesRet ? '(largely survives)' : '(COLLAPSES — this is reversal, not mean-reversion)'}`);

  /* ── STAGE 1 ───────────────────────────────────────────────────────────── */
  console.log(`\n${'='.repeat(88)}`);
  console.log('STAGE 1 — fit beta on FIT ONLY, minimising |gap|');
  let best = 0, bestAbs = Infinity;
  for (let b = -0.60; b <= 0.6001; b += 0.01) {
    const g = Math.abs(mean(gapOn(fit, r => r.volRatio, Math.round(b * 1000) / 1000)) ?? 1);
    if (g < bestAbs) { bestAbs = g; best = Math.round(b * 1000) / 1000; }
  }
  console.log(`  fitted beta: ${best >= 0 ? '+' : ''}${best.toFixed(3)}`);
  console.log(`  FIT gap: ${pp(s0.mean)} -> ${pp(bestAbs * Math.sign(s0.mean))} in-sample. Not evidence; the gate is.`);

  /* ── STAGE 2 — THE GATE ────────────────────────────────────────────────── */
  console.log(`\n${'='.repeat(88)}`);
  console.log('STAGE 2 — THE GATE, on CHECK, with beta frozen');
  const gInc = oneSample(gapOn(check, r => r.volRatio, 0));
  const gCan = oneSample(gapOn(check, r => r.volRatio, best));
  const incS = gapOn(check, r => r.volRatio, 0), canS = gapOn(check, r => r.volRatio, best);
  const paired = oneSample(incS.map((v, i) => Math.abs(v) - Math.abs(canS[i])));
  const reduction = 1 - Math.abs(gCan.mean) / Math.abs(gInc.mean);
  console.log(`  anchors ${gInc.n}`);
  console.log(`  incumbent gap ${pp(gInc.mean)}  95% CI [${pp(gInc.lo)}, ${pp(gInc.hi)}]  t ${gInc.t.toFixed(2)}`);
  console.log(`  candidate gap ${pp(gCan.mean)}  95% CI [${pp(gCan.lo)}, ${pp(gCan.hi)}]  t ${gCan.t.toFixed(2)}`);
  console.log(`  reduction ${(reduction * 100).toFixed(1)}%   (bar ${GATE_REDUCTION * 100}%)`);
  console.log(`  paired improvement ${pp(paired.mean)}  95% CI [${pp(paired.lo)}, ${pp(paired.hi)}]  t ${paired.t.toFixed(2)}  p ${paired.p.toFixed(4)}`);
  const g1 = reduction >= GATE_REDUCTION, g2 = paired.mean > 0 && paired.p < 0.05;
  console.log(`\n  gate 1: reduction >= ${GATE_REDUCTION * 100}% ......... ${g1 ? 'YES' : 'no'}`);
  console.log(`  gate 2: paired improvement p < 0.05 .. ${g2 ? 'YES' : 'no'}`);
  console.log(`\n  VERDICT: ${g1 && g2
    ? 'GATE PASSED — a candidate seal may be written and the IDX reserve opened ONCE'
    : 'GATE FAILED — the reserve is NOT opened and survives for a better candidate'}`);
  if (!survivesRet) {
    console.log('\n  NOTE: the secondary showed the gap largely disappears under recent-return');
    console.log('  conditioning, so whatever the gate says, the variable may be mislabelled again.');
  }
  console.log(`\n  Not a P&L test. Whole-rupiah ticks, survivorship and gap risk all bias hit rates.`);
  console.log(`  RESERVED [${RESERVED_START} ..] not read. Forward reserve from 2026-09-02 stands.`);
  await pool.end();
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
