'use strict';
/**
 * EXP-053 — the WEEKLY value-area low as a stop, on IDX. Stages 0-1 only.
 *
 * Pre-registered in PREREGISTRATION_2026-09-05_idx_weekly_val_stop.md.
 *
 * ── WHY THIS EXISTS: EXP-052 TESTED THE WRONG OBJECT ─────────────────────────
 *
 * EXP-052 found a Value-Area-Low stop 9pp WORSE than ATR, replicated. But its
 * VAL came from the deployed zones(), which profiles 500 sessions -- about two
 * years -- while the source prescribes a WEEKLY profile. The tell was the median
 * VAL distance: 18.11%. A weekly value-area low sits a few percent from price,
 * not eighteen. That arm measured our two-year value area, which merely shares a
 * name with the thing under discussion.
 *
 * ── AND A CORRECTION TO MY OWN DECISION CODE ─────────────────────────────────
 *
 * EXP-052's gate printed "GATE PASSED" on a result that REJECTED the hypothesis.
 * It checked sign consistency across segments plus significance and the floor,
 * and never checked the sign AGAINST the hypothesis. Here the direction check is
 * the FIRST condition and is asserted explicitly. That was the fifth
 * specification error of this arc, all five the same family: careful hypothesis,
 * careless success criterion.
 *
 * ── THE HONEST LIMITATION, BEFORE ANYTHING ELSE ──────────────────────────────
 *
 * A real weekly Market Profile is built from INTRADAY data. This project has
 * daily bars only, so a five-bar profile is a coarse proxy whose "value area" is
 * close to the middle of last week's range. Legitimate and simple, but NOT the
 * object he uses -- a null here is weak evidence against his rule, not strong.
 * Intraday history for 580 tickers across ten years is not obtainable from Yahoo.
 *
 * Usage: node scraper/research/exp053_idx_weekly_val_stop.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');
const { zones } = require('../deep_analysis');

/* ── Frozen by the pre-registration ─────────────────────────────────────── */
const FIT_END = '2021-01-01';
const CHECK_END = '2024-01-01';
const RESERVED_START = '2024-01-01';
const ATR_PERIOD = 14;
const MULTS_CONTROL = [1.5, 2.5, 3.5];   // monotonicity control
const BUFFER_ATR = 0.2;                  // structural stop sits this far beyond the level
const FORWARD = 20, STEP = 20;
const WEEK = 5;                          // sessions in the PRIMARY weekly profile
const SENS_WINDOWS = [10, 20];           // descriptive only; 500 is EXP-052's -9.26pp
const WARMUP = 60;                       // ATR + liquidity screen only; no 500-bar window now
const MAX_VAL_DIST = 0.12;               // VOID above this -- the guard against repeating EXP-052
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

// PRIMARY is the 5-session profile. The others are printed for the window curve
// and decide nothing -- "the window was wrong" is this experiment's own premise,
// so it should be visible rather than asserted.
const LEVELS = [['val5', 'WEEKLY value-area low (5-session profile) — PRIMARY', WEEK]]
  .concat(SENS_WINDOWS.map(w => [`val${w}`, `${w}-session profile — descriptive only`, w]));
const PRIMARY_KEY = 'val5';

(async () => {
  const pool = createPool();
  console.log('EXP-053 — the WEEKLY value-area low as a stop, on IDX. Stages 0-1 only.');
  console.log('  pre-registered in PREREGISTRATION_2026-09-05_idx_weekly_val_stop.md — TWO-SIDED');
  console.log('  DIRECTION is condition 1 -- EXP-052 printed PASSED on a rejection because it');
  console.log('  checked sign consistency and never sign direction. A negative gap cannot pass.');
  console.log(`  PRIMARY is the ${WEEK}-session profile; ${SENS_WINDOWS.join('/')} are descriptive. Floor ${GAP_FLOOR_PP}pp`);
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
  const missing = Object.fromEntries(LEVELS.map(([k]) => [k, 0]));
  let considered = 0;
  {
    let cur = null, bars = [];
    const flush = () => {
      if (bars.length < WARMUP + FORWARD + 2) return;
      const atr = wilderATR(bars, ATR_PERIOD);
      for (let i = WARMUP - 1; i + FORWARD < bars.length - 1; i++) {
        const a = atr[i];
        if (!a || a <= 0) continue;
        const w60 = bars.slice(i - 59, i + 1);
        if (w60.filter(b => b.v > 0).length < MIN_NONZERO) continue;
        const entry = bars[i + 1].o;
        if (!(entry > 0)) continue;
        considered++;

        // Every window from the DEPLOYED zones(), so the only thing that varies
        // between arms is how many sessions the profile sees.
        const lv = {};
        let anyBelow = false;
        for (const [key, , win] of LEVELS) {
          let v = null;
          try {
            const z = zones(bars.slice(i - win + 1, i + 1));
            v = z.valueArea ? z.valueArea.lo : null;
          } catch { /* leave null */ }
          // A level that does not exist, or does not sit below the entry, is not
          // an answer. Counted rather than quietly skipped -- a rule silent on a
          // large share of days is a weaker rule, and the share is the result.
          const ok = v !== null && v > 0 && v < entry;
          if (!ok) missing[key]++;
          lv[key] = ok ? v - BUFFER_ATR * a : null;
          if (ok) anyBelow = true;
        }
        if (!anyBelow) continue;

        let lo = Infinity;
        for (let k = i + 1; k <= i + FORWARD; k++) lo = Math.min(lo, bars[k].l);
        const c0 = bars[i].c, cPrev20 = bars[i - 19].c;
        const ret = w => w.map((b, k) => (k === 0 ? null : (b.c - w[k - 1].c) / w[k - 1].c * 100)).filter(x => x !== null);
        const vol20 = sd(ret(bars.slice(i - 19, i + 1)));

        const d = bars[i].d;
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d).push({
          entry, minLow: lo, atr: a, ...lv,
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
  // A rule with no answer on a share of days is a weaker rule, and the share is
  // part of the result. EXP-053's first run printed NaN here: this loop still used
  // EXP-052's key names after the levels were replaced, and the number the
  // pre-registration asked for went unreported until exp053b recovered it (26.4%).
  console.log('level unavailable or not below entry:');
  for (const [key, label] of LEVELS) {
    console.log(`  ${key.padEnd(7)} ${missing[key]}/${considered} ` +
      `(${(missing[key] / considered * 100).toFixed(1)}%)   ${label}`);
  }

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
    if (key === PRIMARY_KEY && targetMed > MAX_VAL_DIST) {
      console.log(`
  *** VOID. The PRIMARY weekly VAL sits ${pctd(targetMed)} from price, above the`);
      console.log(`  *** ${pctd(MAX_VAL_DIST)} guard. At that distance the object is not a weekly value`);
      console.log("  *** area, whatever the code is called, and reading it as one would repeat");
      console.log("  *** EXP-052's exact error. Nothing else in this run may be read.");
      await pool.end();
      return;
    }
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

  /* ── STAGE 0 (FIT) — DIRECTION FIRST ───────────────────────────────────
     EXP-052's gate printed "PASSED" on a rejection because it checked sign
     CONSISTENCY and never sign DIRECTION. Here direction is condition 1 and
     nothing later can rescue a negative gap. */
  const live = LEVELS.filter(([k]) => results[k] && !results[k].voided).map(([k]) => k);
  console.log(`\n${'='.repeat(90)}`);
  console.log('WINDOW CURVE — gap = hitRate(ATR) - hitRate(VAL) at matched median distance');
  console.log('  POSITIVE means the VAL is hit LESS, which is the direction H1 requires.');
  console.log('  Only the 5-session arm decides anything. EXP-052 measured -9.26pp at 500 sessions.');
  for (const key of live) {
    const r = results[key];
    console.log(`  ${key.padEnd(7)} k=${String(r.k).padEnd(5)} median dist ${pctd(r.targetMed)}  ` +
      `gap ${pp(r.plain.mean)}  t ${r.plain.t.toFixed(2)}` +
      (key === PRIMARY_KEY ? '   <- PRIMARY' : '   (descriptive)'));
  }

  const pr = results[PRIMARY_KEY];
  if (!pr || pr.voided || !pr.plain) {
    console.log('\n  The primary arm did not survive its controls. Nothing sealed.');
    await pool.end();
    return;
  }
  const f = pr.plain;
  const dirOK = f.mean > 0;
  const sizeOK = Math.abs(f.mean) * 100 >= GAP_FLOOR_PP;
  const sigOK = f.p < 0.05;

  console.log(`\n${'='.repeat(90)}`);
  console.log(`STAGE 0 — FIT, ${PRIMARY_KEY} only.  ${f.n} anchors`);
  console.log(`  gap ${pp(f.mean)}  95% CI [${pp(f.lo)}, ${pp(f.hi)}]  t ${f.t.toFixed(2)}  p ${f.p.toFixed(4)}`);
  console.log(`  1. DIRECTION gap > 0 (H1 requires the VAL be hit LESS) ... ${dirOK ? 'YES' : 'NO'}`);
  console.log(`  2. |gap| >= ${GAP_FLOOR_PP}pp .................................. ${sizeOK ? 'YES' : 'no'}`);
  console.log(`  3. p < 0.05 ......................................... ${sigOK ? 'YES' : 'no'}`);

  if (!dirOK) {
    const verdict = sizeOK && sigOK
      ? 'WEEKLY VAL IS WORSE — the hypothesis is REJECTED, significantly and by a material margin'
      : 'WEEKLY VAL IS NOT BETTER — the gap runs against H1; nothing to seal';
    console.log(`\n  VERDICT: ${verdict}`);
    console.log('  Condition 1 is DIRECTION. A negative gap cannot pass on significance, which is');
    console.log('  exactly the mistake EXP-052 made and this rule exists to prevent.');
    console.log(`\n  RESERVED [${RESERVED_START} ..] not read. Forward reserve from 2026-09-02 stands.`);
    await pool.end();
    return;
  }
  if (!sizeOK || !sigOK) {
    console.log('\n  VERDICT: NOT DETECTABLE — the direction is right but the effect does not clear');
    console.log('  the floor or significance at this sample size. Nothing sealed.');
    console.log(`\n  RESERVED [${RESERVED_START} ..] not read.`);
    await pool.end();
    return;
  }

  /* ── STAGE 1 — CHECK, k frozen, direction checked again ─────────────────── */
  const c = oneSample(gapSeries(check, PRIMARY_KEY, pr.k));
  const cOK = !!c && c.mean > 0 && Math.abs(c.mean) * 100 >= GAP_FLOOR_PP && c.p < 0.05;
  console.log(`\n${'='.repeat(90)}`);
  console.log(`STAGE 1 — CHECK, k frozen at ${pr.k}.  ${c ? c.n : 0} anchors`);
  console.log(`  gap ${pp(c && c.mean)}  95% CI [${pp(c && c.lo)}, ${pp(c && c.hi)}]  ` +
    `t ${c ? c.t.toFixed(2) : 'n/a'}  p ${c ? c.p.toFixed(4) : 'n/a'}`);
  console.log(`  still positive, clears floor, p < 0.05 ... ${cOK ? 'YES' : 'no'}`);
  console.log(`\n  VERDICT: ${cOK
    ? 'GATE PASSED — a candidate seal may be written and the IDX reserve opened ONCE'
    : 'GATE FAILED — the reserve is NOT opened and survives for a better candidate'}`);
  console.log('\n  Daily bars, not intraday: this is a coarse proxy for a weekly Market Profile,');
  console.log('  so a null is weak evidence against the source rule rather than strong.');
  console.log('  Still only the location half — no order flow, and the entry half already failed');
  console.log('  on IDX (EXP-037, -1.6% vs holding). Not a P&L test.');
  console.log(`  RESERVED [${RESERVED_START} ..] not read. Forward reserve from 2026-09-02 stands.`);
  await pool.end();
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
