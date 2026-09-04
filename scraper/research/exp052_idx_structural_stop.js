'use strict';
/**
 * EXP-052 — a structural stop against the ATR stop, on IDX. Stages 0-1 only.
 *
 * Pre-registered in PREREGISTRATION_2026-09-02_idx_structural_stop.md.
 *
 * ── THE DESIGN DECISION THAT SHAPES EVERYTHING ───────────────────────────────
 *
 * For a single stop below an entry, PLACEMENT AND DISTANCE ARE THE SAME
 * QUANTITY. Match the distance and the stop price is identical; there is no
 * second axis to compare. The two rules differ only in how far out they put the
 * stop, and the claim under test is that the structural distance is better
 * calibrated to where price actually goes.
 *
 * So the ATR arm is RESCALED to match the structural arm's median distance
 * before the two are compared. A rule that is merely wider is hit less often and
 * is not thereby better; without the rescale this test would measure width and
 * call it placement.
 *
 * ── WHAT IS NOT BEING TESTED ─────────────────────────────────────────────────
 *
 * Most of the method. Nill's execution layer is a 15-minute footprint chart and
 * the order book, and this project has neither. He is explicit that the zone
 * says WHERE to look while the order flow says WHETHER to act. Nothing here
 * speaks to that half.
 *
 * And the entry half was already measured on IDX: EXP-037 found buying a close
 * into a support zone returned 1.6% LESS than simply holding. This is about the
 * stop, and the entry is deliberately uninformative.
 *
 * Usage: node scraper/research/exp052_idx_structural_stop.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');
const { structure, zones } = require('../deep_analysis');

/* ── Frozen by the pre-registration ─────────────────────────────────────── */
const FIT_END = '2021-01-01';
const CHECK_END = '2024-01-01';
const RESERVED_START = '2024-01-01';
const ATR_PERIOD = 14;
const MULTS_CONTROL = [1.5, 2.5, 3.5];   // monotonicity control
const BUFFER_ATR = 0.2;                  // structural stop sits this far beyond the level
const FORWARD = 20, STEP = 20;
const STRUCT_WINDOW = 250;               // bars fed to structure(), as the report uses
const ZONE_WINDOW = 500;                 // bars fed to zones(), as the report uses
const MIN_NONZERO = 48, MIN_CROSS = 100, QUINT = 5;
const GAP_FLOOR_PP = 2.0;
const MATCH_TOL = 0.05;                  // median distances must agree within 5% relative

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = a => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const median = a => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
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
const pctd = v => (v === null || v === undefined ? '  n/a' : (v * 100).toFixed(2) + '%');

const LEVELS = [
  ['swingLow', 'last swing low (deployed structure(), what the page shows as invalidation.below)'],
  ['val', 'Value Area Low (deployed zones(), Nill\'s own version)'],
];

(async () => {
  const pool = createPool();
  console.log('EXP-052 — a structural stop against the ATR stop, on IDX. Stages 0-1 only.');
  console.log('  pre-registered in PREREGISTRATION_2026-09-02_idx_structural_stop.md — TWO-SIDED');
  console.log('  placement and distance are the SAME quantity for one stop, so the ATR arm is');
  console.log('  RESCALED to match the structural median distance. Without that this measures width.');
  console.log(`  family m = ${LEVELS.length} (swing low, VAL), BH q < 0.05, floor ${GAP_FLOOR_PP}pp`);
  console.log(`  RESERVED [${RESERVED_START} ..] excluded in SQL; no flag can open it`);
  console.log('  entry-agnostic, no target, no costs. NOT a P&L test. Order flow -- half his');
  console.log('  method -- is absent, and the entry half already failed on IDX (EXP-037).');
  console.log('');

  const [px] = await pool.query(
    `SELECT stock_code, date, open_price o, high_price h, low_price l, close_price c, volume v
       FROM idx_stock_prices WHERE date < ? AND close_price > 0 ORDER BY stock_code, date ASC`,
    [RESERVED_START]);
  console.log(`${px.length} price rows, all strictly before ${RESERVED_START}`);

  const byDate = new Map();
  const missing = { swingLow: 0, val: 0 };
  let considered = 0;
  {
    let cur = null, bars = [];
    const flush = () => {
      if (bars.length < ZONE_WINDOW + FORWARD + 2) return;
      const atr = wilderATR(bars, ATR_PERIOD);
      for (let i = ZONE_WINDOW - 1; i + FORWARD < bars.length - 1; i++) {
        const a = atr[i];
        if (!a || a <= 0) continue;
        const w60 = bars.slice(i - 59, i + 1);
        if (w60.filter(b => b.v > 0).length < MIN_NONZERO) continue;
        const entry = bars[i + 1].o;
        if (!(entry > 0)) continue;
        considered++;

        // Both levels from the DEPLOYED functions, on the windows the report uses.
        let swingLow = null, val = null;
        try {
          const st = structure(bars.slice(i - STRUCT_WINDOW + 1, i + 1), 3);
          swingLow = st.lastSwingLow ? st.lastSwingLow.price : null;
        } catch { /* leave null */ }
        try {
          const z = zones(bars.slice(i - ZONE_WINDOW + 1, i + 1));
          val = z.valueArea ? z.valueArea.lo : null;
        } catch { /* leave null */ }

        // A level that does not exist, or does not sit below the entry, is not an
        // answer. Counted rather than quietly skipped -- a rule that is silent on
        // some fraction of days is a weaker rule and the fraction is the result.
        const useSwing = swingLow !== null && swingLow > 0 && swingLow < entry;
        const useVal = val !== null && val > 0 && val < entry;
        if (!useSwing) missing.swingLow++;
        if (!useVal) missing.val++;
        if (!useSwing && !useVal) continue;

        let lo = Infinity;
        for (let k = i + 1; k <= i + FORWARD; k++) lo = Math.min(lo, bars[k].l);
        const c0 = bars[i].c, cPrev20 = bars[i - 19].c;
        const ret = w => w.map((b, k) => (k === 0 ? null : (b.c - w[k - 1].c) / w[k - 1].c * 100)).filter(x => x !== null);
        const vol20 = sd(ret(bars.slice(i - 19, i + 1)));

        const d = bars[i].d;
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d).push({
          entry, minLow: lo, atr: a,
          swingLow: useSwing ? swingLow - BUFFER_ATR * a : null,
          val: useVal ? val - BUFFER_ATR * a : null,
          recentRet: cPrev20 > 0 ? (c0 - cPrev20) / cPrev20 : 0,
          vol20: vol20 || 0,
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
  console.log(`${all.length} usable sessions, ${anchors.length} anchors: FIT ${fit.length}, CHECK ${check.length}`);
  console.log(`level unavailable or not below entry: swing low ${missing.swingLow}/${considered} ` +
    `(${(missing.swingLow / considered * 100).toFixed(1)}%), VAL ${missing.val}/${considered} ` +
    `(${(missing.val / considered * 100).toFixed(1)}%)\n`);

  const rowsOf = (dates, key) => dates.flatMap(d => byDate.get(d).filter(r => r[key] !== null));
  const distStruct = (r, key) => (r.entry - r[key]) / r.entry;
  const distAtr = (r, k) => (k * r.atr) / r.entry;
  const hitStruct = (r, key) => r.minLow <= r[key];
  const hitAtr = (r, k) => r.minLow <= r.entry - k * r.atr;

  /* ── CONTROL 1 — monotonicity of the ATR arm ───────────────────────────── */
  console.log('='.repeat(90));
  console.log('POSITIVE CONTROLS (registered; both VOID the run on failure)');
  const monoRows = anchors.flatMap(d => byDate.get(d));
  const rates = MULTS_CONTROL.map(k => mean(monoRows.map(r => (hitAtr(r, k) ? 1 : 0))));
  console.log('  1. ATR hit rate must FALL as k rises (mechanical):  ' +
    MULTS_CONTROL.map((k, i) => `k=${k} ${(rates[i] * 100).toFixed(1)}%`).join('  ->  '));
  const mono = rates[0] > rates[1] && rates[1] > rates[2];
  console.log(`     ${mono ? 'PASS' : '*** FAIL — the simulation is wrong ***'}`);
  if (!mono) { console.log('\n  VOID.'); await pool.end(); return; }

  /* ── Per level: fit k on FIT, check the match, then compare ─────────────── */
  const results = {};
  for (const [key, label] of LEVELS) {
    const fitRows = rowsOf(fit, key);
    if (fitRows.length < 200) { console.log(`\n  ${key}: only ${fitRows.length} FIT rows — skipped`); continue; }
    const targetMed = median(fitRows.map(r => distStruct(r, key)));

    // k fitted ONLY to equalise distance, never to improve hit rate.
    let k = 2.5, best = Infinity;
    for (let cand = 0.2; cand <= 8.001; cand += 0.01) {
      const m = median(fitRows.map(r => distAtr(r, cand)));
      const err = Math.abs(m - targetMed);
      if (err < best) { best = err; k = Math.round(cand * 100) / 100; }
    }
    const gotMed = median(fitRows.map(r => distAtr(r, k)));
    const rel = Math.abs(gotMed - targetMed) / targetMed;

    console.log(`\n  2. distance match for ${key}: structural median ${pctd(targetMed)}  ` +
      `ATR at k=${k} median ${pctd(gotMed)}  (rel err ${(rel * 100).toFixed(2)}%)  ` +
      `${rel <= MATCH_TOL ? 'PASS' : '*** FAIL ***'}`);
    if (rel > MATCH_TOL) { results[key] = { voided: true }; continue; }

    console.log(`     structural mean ${pctd(mean(fitRows.map(r => distStruct(r, key))))}, ` +
      `ATR mean ${pctd(mean(fitRows.map(r => distAtr(r, k))))} — means differ by design (skew)`);
    results[key] = { k, label, targetMed, gotMed };
  }

  /** gap = hitRate(ATR) - hitRate(STRUCTURE), per anchor. Positive: structure hit less. */
  function gapSeries(dates, key, k, axis) {
    const out = [];
    for (const d of dates) {
      let groups = [byDate.get(d).filter(r => r[key] !== null)];
      if (axis) {
        const s = groups[0].slice().sort((a, b) => axis(a) - axis(b));
        const n = s.length;
        groups = [];
        for (let q = 0; q < QUINT; q++) groups.push(s.filter((_, i) => bucketOf(i, n, QUINT) === q));
      }
      const gs = [];
      for (const g of groups) {
        if (g.length < 20) continue;
        gs.push(mean(g.map(r => (hitAtr(r, k) ? 1 : 0))) - mean(g.map(r => (hitStruct(r, key) ? 1 : 0))));
      }
      if (gs.length) out.push(mean(gs));
    }
    return out;
  }

  /* ── SECONDARY, printed BEFORE the verdict ─────────────────────────────── */
  console.log(`\n${'='.repeat(90)}`);
  console.log('REGISTERED SECONDARY — what else could a structural distance be? (the EXP-045 lesson)');
  console.log('  A swing low sits close after a steady climb and far after a drop, so the distance');
  console.log('  is entangled with recent return and with volatility.');
  for (const [key] of LEVELS) {
    const r = results[key];
    if (!r || r.voided) continue;
    const plain = oneSample(gapSeries(fit, key, r.k));
    const byRet = oneSample(gapSeries(fit, key, r.k, x => x.recentRet));
    const byVol = oneSample(gapSeries(fit, key, r.k, x => x.vol20));
    console.log(`  ${key}: plain ${pp(plain.mean)} (t ${plain.t.toFixed(2)})  |  ` +
      `inside recent-return buckets ${pp(byRet.mean)} (t ${byRet.t.toFixed(2)})  |  ` +
      `inside volatility buckets ${pp(byVol.mean)} (t ${byVol.t.toFixed(2)})`);
    r.plain = plain;
  }

  /* ── STAGE 0 (FIT) then STAGE 1 (CHECK) ────────────────────────────────── */
  const live = LEVELS.filter(([k]) => results[k] && !results[k].voided).map(([k]) => k);
  const fitStats = live.map(key => results[key].plain);
  const qFit = bh(fitStats.map(s => s?.p ?? 1));

  console.log(`\n${'='.repeat(90)}`);
  console.log('STAGE 0 — FIT.  gap = hitRate(ATR) - hitRate(STRUCTURE) at matched median distance');
  console.log('  positive = the structural level is hit LESS at the same risk budget');
  live.forEach((key, i) => {
    const s = fitStats[i];
    console.log(`  ${key.padEnd(10)} k=${String(results[key].k).padEnd(5)} gap ${pp(s.mean)}  ` +
      `95% CI [${pp(s.lo)}, ${pp(s.hi)}]  t ${s.t.toFixed(2)}  q ${qFit[i].toFixed(4)}  ` +
      `${Math.abs(s.mean) * 100 >= GAP_FLOOR_PP ? 'clears floor' : 'below floor'}`);
    results[key].stage0 = Math.abs(s.mean) * 100 >= GAP_FLOOR_PP && qFit[i] < 0.05;
  });

  const passed0 = live.filter(k => results[k].stage0);
  if (!passed0.length) {
    console.log('\n  STOP. No level beats the volatility multiple at the same risk budget on FIT.');
    console.log('  Nothing sealed, reserve untouched. That closes the location question for IDX:');
    console.log('  a structural stop is not better PLACED, and the deployed rule stays as it is.');
    console.log(`\n  RESERVED [${RESERVED_START} ..] not read. Forward reserve from 2026-09-02 stands.`);
    await pool.end();
    return;
  }

  console.log(`\n${'='.repeat(90)}`);
  console.log('STAGE 1 — CHECK, with k frozen');
  const checkStats = passed0.map(key => oneSample(gapSeries(check, key, results[key].k)));
  const qChk = bh(checkStats.map(s => s?.p ?? 1));
  let anyPass = false;
  passed0.forEach((key, i) => {
    const s = checkStats[i], f = results[key].plain;
    const ok = s && Math.sign(s.mean) === Math.sign(f.mean) && qChk[i] < 0.05 && Math.abs(s.mean) * 100 >= GAP_FLOOR_PP;
    if (ok) anyPass = true;
    console.log(`  ${key.padEnd(10)} gap ${pp(s.mean)}  95% CI [${pp(s.lo)}, ${pp(s.hi)}]  ` +
      `t ${s.t.toFixed(2)}  q ${qChk[i].toFixed(4)}  ${ok ? 'HOLDS' : 'fails'}`);
  });

  console.log(`\n  VERDICT: ${anyPass
    ? 'GATE PASSED — a candidate seal may be written and the IDX reserve opened ONCE'
    : 'GATE FAILED — the reserve is NOT opened and survives for a better candidate'}`);
  console.log('\n  Half the method is untested here: no order flow. And the entry half already');
  console.log('  failed on IDX (EXP-037, -1.6% vs holding). Not a P&L test.');
  console.log(`  RESERVED [${RESERVED_START} ..] not read. Forward reserve from 2026-09-02 stands.`);
  await pool.end();
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
