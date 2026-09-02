'use strict';
/**
 * EXP-049 — where does the volume->range effect live, and why is it US-only?
 *
 * Pre-registered in PREREGISTRATION_2026-09-02_volume_decomposition.md.
 *
 * ── THE HARD LIMIT, STATED IN THE CODE SO IT TRAVELS WITH IT ─────────────────
 *
 * This CANNOT strengthen the F3 finding. The evidence for the effect remains
 * EXP-045 and EXP-046 and nothing here adds to it. A mechanism that "makes
 * sense" is a story fitted to a result that already exists, and stories are
 * cheap. It licenses no production change on either market.
 *
 * ── WHAT IS BEING SEPARATED ──────────────────────────────────────────────────
 *
 * H-EVENT: a volume spike in a US large cap is usually an event that RESOLVES
 * uncertainty -- earnings above all, followed by a well-documented collapse in
 * realised volatility. Then the effect must live in the TRANSIENT component:
 * today unusual against its own recent past.
 *
 * H-ACTIVITY: volume proxies for something continuous about the stock's state,
 * so the PERSISTENT component carries it and the split shows no asymmetry.
 *
 * Opposite predictions, one test.
 *
 * ── AND THE POSSIBILITY THAT KILLS THE WHOLE FRAMING ─────────────────────────
 *
 * The US universe is the S&P 500. The IDX eligible universe has a median price
 * of Rp 368. If IDX's most liquid quintile sits below US's least liquid one,
 * "US-only" is really "liquid-only" and the cross-market difference is not about
 * the market at all. That is checked and reported first, before any mechanism
 * talk, precisely so it cannot be presented later as a discovery.
 *
 * Usage: node scraper/research/exp049_volume_decomposition.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');

const RESERVED_START = '2024-01-01';   // both markets stop here; IDX reserve unreadable
const FORWARD = 20, STEP = 20;
const VOL_WINDOW = 20;                 // PRIOR_VOL and the transient denominator
const LONG_WINDOW = 60;                // persistent denominator
const MIN_NONZERO = 48;
const MIN_CROSS = 100;
const IC_FLOOR = 0.02;
const CONTROL_MIN_IC = 0.10, CONTROL_MAX_P = 0.01;
const QUINT = 5;
const IDR_PER_USD = 16000;             // flat, for one shared axis only

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
function residualize(y, x) {
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
function bh(ps) {
  const m = ps.length;
  const order = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const q = new Array(m);
  let run = 1;
  for (let k = m; k >= 1; k--) { const [p, i] = order[k - 1]; run = Math.min(run, (p * m) / k); q[i] = run; }
  return q;
}
const bucketOf = (i, n, k) => Math.min(k - 1, Math.floor((i * k) / n));
const f4 = v => (v === null || v === undefined ? '    n/a' : (v >= 0 ? '+' : '') + v.toFixed(4));

/** Build per-date rows for one market from an ordered price stream. */
function buildMarket(rows, keyOf, fx) {
  const byDate = new Map();
  let cur = null, bars = [];
  const flush = () => {
    if (bars.length < LONG_WINDOW + FORWARD + 2) return;
    for (let i = LONG_WINDOW - 1; i + FORWARD < bars.length - 1; i++) {
      const win60 = bars.slice(i - LONG_WINDOW + 1, i + 1);
      const win20 = bars.slice(i - VOL_WINDOW + 1, i + 1);
      if (win60.filter(b => b.v > 0).length < MIN_NONZERO) continue;
      const m20 = mean(win20.map(b => b.v)), m60 = mean(win60.map(b => b.v));
      const vt = bars[i].v, entry = bars[i].c;
      if (!(vt > 0) || !(m20 > 0) || !(m60 > 0) || !(entry > 0)) continue;
      const chg = win20.map((b, k) => (k === 0 ? null : (b.c - win20[k - 1].c) / win20[k - 1].c * 100))
        .filter(v => v !== null);
      const pv = sd(chg);
      if (!pv || !Number.isFinite(pv)) continue;
      let hi = -Infinity, lo = Infinity;
      for (let k = i + 1; k <= i + FORWARD; k++) { hi = Math.max(hi, bars[k].h); lo = Math.min(lo, bars[k].l); }
      const range = ((hi - entry) / entry - (lo - entry) / entry) * 100;
      const d = bars[i].d;
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push({
        transient: Math.log(vt / m20),
        persistent: Math.log(m20 / m60),
        pv, range,
        dollarVol: (m20 * entry) / fx,   // 20-session average traded value, USD
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

function analyse(byDate, label) {
  const all = [...byDate.keys()].sort().filter(d => byDate.get(d).length >= MIN_CROSS);
  const anchors = all.filter((_, i) => i % STEP === 0);
  const out = { label, anchors: anchors.length, ic: {}, control: null, corr: null, byLiq: [] };

  const ctrl = [], corr = [];
  const series = { transient: [], persistent: [] };
  for (const d of anchors) {
    const rows = byDate.get(d);
    const y = rows.map(r => r.range);
    const rpv = ranks(rows.map(r => r.pv));
    const c = spearman(rows.map(r => r.pv), y);
    if (c !== null && Number.isFinite(c)) ctrl.push(c);
    const cc = spearman(rows.map(r => r.transient), rows.map(r => r.persistent));
    if (cc !== null && Number.isFinite(cc)) corr.push(cc);
    for (const k of ['transient', 'persistent']) {
      const res = residualize(ranks(rows.map(r => r[k])), rpv);
      const ic = spearman(res, y);
      if (ic !== null && Number.isFinite(ic)) series[k].push(ic);
    }
  }
  out.control = oneSample(ctrl);
  out.corr = mean(corr);
  for (const k of ['transient', 'persistent']) out.ic[k] = oneSample(series[k]);

  // Descriptive: transient IC by dollar-volume quintile.
  const perQ = Array.from({ length: QUINT }, () => []);
  const liqEdges = Array.from({ length: QUINT }, () => []);
  for (const d of anchors) {
    const rows = byDate.get(d).slice().sort((a, b) => a.dollarVol - b.dollarVol);
    const n = rows.length;
    for (let q = 0; q < QUINT; q++) {
      const b = rows.filter((_, i) => bucketOf(i, n, QUINT) === q);
      if (b.length < 12) continue;
      const res = residualize(ranks(b.map(r => r.transient)), ranks(b.map(r => r.pv)));
      const ic = spearman(res, b.map(r => r.range));
      if (ic !== null && Number.isFinite(ic)) perQ[q].push(ic);
      liqEdges[q].push(mean(b.map(r => r.dollarVol)));
    }
  }
  out.byLiq = perQ.map((a, q) => ({ ic: oneSample(a), medianDollarVol: mean(liqEdges[q]) }));
  const dv = anchors.flatMap(d => byDate.get(d).map(r => r.dollarVol)).sort((a, b) => a - b);
  out.dollarVol = { p10: dv[Math.floor(dv.length * 0.10)], p50: dv[Math.floor(dv.length * 0.5)], p90: dv[Math.floor(dv.length * 0.9)] };
  return out;
}

const usd = v => (v === null || v === undefined ? 'n/a'
  : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e3).toFixed(0)}k`);

(async () => {
  const pool = createPool();
  console.log('EXP-049 — where does the volume->range effect live, and why is it US-only?');
  console.log('  pre-registered in PREREGISTRATION_2026-09-02_volume_decomposition.md — TWO-SIDED');
  console.log('  CANNOT strengthen the F3 finding. Mechanism only. Licenses no production change.');
  console.log(`  family m = 4 (transient/persistent x US/IDX), BH q < 0.05, floor |IC| >= ${IC_FLOOR}`);
  console.log(`  both markets stop before ${RESERVED_START}; the IDX reserve is unreadable here`);
  console.log('');

  const [usPx] = await pool.query(
    `SELECT ticker, date, high_price h, low_price l, close_price c, volume v
       FROM us_stock_prices WHERE date < ? AND close_price > 0 ORDER BY ticker, date ASC`, [RESERVED_START]);
  const us = analyse(buildMarket(usPx, r => r.ticker, 1), 'US');

  const [idxPx] = await pool.query(
    `SELECT stock_code, date, high_price h, low_price l, close_price c, volume v
       FROM idx_stock_prices WHERE date < ? AND close_price > 0 ORDER BY stock_code, date ASC`, [RESERVED_START]);
  const idx = analyse(buildMarket(idxPx, r => r.stock_code, IDR_PER_USD), 'IDX');

  /* ── The comparability question, FIRST ─────────────────────────────────── */
  console.log('='.repeat(92));
  console.log('ARE THESE THE SAME KIND OF UNIVERSE? (asked first, on purpose)');
  console.log(`  20-session average traded value, converted at a flat ${IDR_PER_USD} IDR/USD`);
  console.log('    market       p10          median        p90');
  for (const m of [us, idx]) {
    console.log(`    ${m.label.padEnd(6)} ${usd(m.dollarVol.p10).padStart(12)} ${usd(m.dollarVol.p50).padStart(14)} ${usd(m.dollarVol.p90).padStart(12)}`);
  }
  const overlap = idx.dollarVol.p90 < us.dollarVol.p10;
  console.log(`  IDX p90 ${usd(idx.dollarVol.p90)} vs US p10 ${usd(us.dollarVol.p10)}: ` +
    `${overlap ? 'NO OVERLAP — "US-only" is more honestly "liquid-only"' : 'the distributions overlap'}`);

  /* ── Positive controls ─────────────────────────────────────────────────── */
  console.log(`\n${'='.repeat(92)}`);
  console.log('POSITIVE CONTROL — PRIOR_VOL vs range, per market. A failure VOIDS that market.');
  let voided = [];
  for (const m of [us, idx]) {
    const ok = m.control.mean >= CONTROL_MIN_IC && m.control.p < CONTROL_MAX_P;
    if (!ok) voided.push(m.label);
    console.log(`  ${m.label.padEnd(5)} IC ${f4(m.control.mean)}  t ${m.control.t.toFixed(2)}  ` +
      `anchors ${m.anchors}  ${ok ? 'PASS' : '*** FAIL — this market is VOID ***'}`);
  }

  /* ── The registered family ─────────────────────────────────────────────── */
  console.log(`\n${'='.repeat(92)}`);
  console.log('DECOMPOSITION — residualised on PRIOR_VOL, same machinery as EXP-045');
  const cells = [];
  for (const m of [us, idx]) for (const k of ['transient', 'persistent']) cells.push({ m, k, s: m.ic[k] });
  const qs = bh(cells.map(c => c.s?.p ?? 1));
  console.log('    market  component        IC       sd            95% CI       t        q   floor');
  cells.forEach((c, i) => {
    const s = c.s;
    if (!s) { console.log(`    ${c.m.label} ${c.k} insufficient`); return; }
    console.log(`    ${c.m.label.padEnd(7)} ${c.k.padEnd(11)} ${f4(s.mean).padStart(9)} ${s.sd.toFixed(4).padStart(8)} ` +
      `${`[${f4(s.lo)},${f4(s.hi)}]`.padStart(20)} ${s.t.toFixed(2).padStart(7)} ${qs[i].toFixed(4).padStart(8)}   ` +
      (Math.abs(s.mean) >= IC_FLOOR ? 'PASS' : 'below'));
  });
  for (const m of [us, idx]) {
    console.log(`    ${m.label}: transient/persistent cross-sectional rho = ${f4(m.corr)} ` +
      '(near-orthogonal by construction; this is how near)');
  }

  /* ── Descriptive liquidity gradient ────────────────────────────────────── */
  console.log(`\n${'='.repeat(92)}`);
  console.log('DESCRIPTIVE ONLY — transient IC by dollar-volume quintile. A five-bucket gradient');
  console.log('after the fact is a subgroup analysis and decides nothing.');
  for (const m of [us, idx]) {
    console.log(`  ${m.label}:`);
    m.byLiq.forEach((b, q) => {
      if (!b.ic) { console.log(`    Q${q + 1} insufficient`); return; }
      console.log(`    Q${q + 1} (${usd(b.medianDollarVol).padStart(8)})  IC ${f4(b.ic.mean)}  t ${b.ic.t.toFixed(2).padStart(6)}`);
    });
  }

  /* ── Mechanical verdict ────────────────────────────────────────────────── */
  console.log(`\n${'='.repeat(92)}`);
  console.log('DECISION RULE (fixed before the run, applied without interpretation)');
  const carries = {};
  cells.forEach((c, i) => {
    carries[`${c.m.label}_${c.k}`] = !!c.s && Math.abs(c.s.mean) >= IC_FLOOR && qs[i] < 0.05
      && !voided.includes(c.m.label);
  });
  for (const k of Object.keys(carries)) console.log(`  ${k.padEnd(18)} ${carries[k] ? 'CARRIES' : 'does not carry'}`);
  let mech;
  if (carries.US_transient && !carries.US_persistent) mech = 'H-EVENT SUPPORTED — the effect lives in the TRANSIENT component on US';
  else if (carries.US_persistent && !carries.US_transient) mech = 'H-ACTIVITY SUPPORTED — the effect lives in the PERSISTENT component on US';
  else if (carries.US_transient && carries.US_persistent) mech = 'BOTH components carry — the split does not separate the hypotheses';
  else mech = 'NEITHER component carries on US — the decomposition destroyed the signal rather than locating it';
  console.log(`\n  ${mech}`);
  console.log(`  IDX: transient ${carries.IDX_transient ? 'carries' : 'does not carry'}, ` +
    `persistent ${carries.IDX_persistent ? 'carries' : 'does not carry'}`);
  if (overlap) {
    console.log('\n  AND the universes do not overlap in traded value, so any cross-market claim');
    console.log('  here is confounded with liquidity by construction. Stated before the run.');
  }
  console.log('\n  A transient result is CONSISTENT WITH the earnings story and does not');
  console.log('  demonstrate it — no earnings dates were used. Nothing here is confirmation of');
  console.log(`  the F3 effect itself, and nothing licenses a change. Reserve ${RESERVED_START}+ untouched.`);

  await pool.end();
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
