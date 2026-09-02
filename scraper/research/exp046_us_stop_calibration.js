'use strict';
/**
 * EXP-046 — is the deployed ATR stop miscalibrated, and can F3 fix it?
 *
 * The single pre-registered hypothesis from
 * PREREGISTRATION_2026-09-02_us_stop_calibration.md. Read that first.
 *
 * ── WHY THIS IS A DIFFERENT KIND OF TEST ─────────────────────────────────────
 *
 * EXP-042 through EXP-045 measured rank IC. This measures whether a DECISION
 * changes. An IC of 0.04 on a continuous target can easily produce no
 * measurable difference in a binary threshold event, and a null here is a likely
 * and informative outcome -- it would say F3's range effect is real, measurable
 * and too small to move a stop.
 *
 * ── ENTRY-AGNOSTIC, THE CENTRAL DESIGN DECISION ──────────────────────────────
 *
 * EXP-044 established there is no directional signal in this factor set. Any
 * entry rule would import a known-null edge and bury the stop comparison in
 * noise from the entry. So every (ticker, anchor) opens a hypothetical long at
 * the NEXT session's open, carrying no information by construction. That is what
 * makes the stop the only thing being measured -- and it is also why nothing
 * here may be called profitable.
 *
 * ── WHY DAILY BARS SUFFICE ───────────────────────────────────────────────────
 *
 * EXP-037 refused to simulate a stop because a daily bar does not record whether
 * the low came before or after the high, which matters when a target competes
 * with a stop. This test has NO TARGET. "Did any of the next 20 lows reach the
 * stop" is answerable from daily bars without inventing intrabar path.
 *
 * Usage: node scraper/research/exp046_us_stop_calibration.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');

const MIN_CROSS = 100;             // need 5x5 cells; 100 gives ~4 per cell at worst
const STEP = 20;                   // non-overlapping anchors
const FORWARD = 20;                // sessions the stop is live
const SPLIT = '2019-01-01';
const HOLDOUT_START = '2024-01-01';
const ATR_PERIOD = 14;
const DEPLOYED_MULT = 2.5;         // POSITION profile riskAtrMult
const MULTS = [1.5, 2.5, 3.5];     // 2.5 decides; the others are sensitivity
const QUINT = 5;
const FLOOR_PP = 2.0;              // economic floor, percentage points
const OPEN_HOLDOUT = process.argv.includes('--open-holdout');

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = a => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

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
function oneSample(xs) {
  const m = mean(xs), s = sd(xs), n = xs.length;
  if (!s || n < 3) return null;
  const t = m / (s / Math.sqrt(n));
  return { mean: m, sd: s, n, t, p: tTwoSided(t, n - 1) };
}
const pp = v => (v === null || v === undefined ? '   n/a' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + 'pp');

/** Wilder ATR(14). Uses bars up to and including t; nothing after. */
function wilderATR(bars, period) {
  const out = new Array(bars.length).fill(null);
  let prevATR = null, trSum = 0;
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    if (i <= period) { trSum += tr; if (i === period) { prevATR = trSum / period; out[i] = prevATR; } }
    else { prevATR = (prevATR * (period - 1) + tr) / period; out[i] = prevATR; }
  }
  return out;
}

/** Quintile index 0..QUINT-1 by position in a sorted array of length n. */
const quintOf = (rank, n) => Math.min(QUINT - 1, Math.floor((rank * QUINT) / n));

(async () => {
  const pool = createPool();

  console.log('EXP-046 — is the deployed ATR stop miscalibrated, and can F3 fix it?');
  console.log('  pre-registered in PREREGISTRATION_2026-09-02_us_stop_calibration.md — TWO-SIDED');
  console.log(`  incumbent: stop = entry - ATR(${ATR_PERIOD}) x ${DEPLOYED_MULT} (POSITION profile), S/R snap DISABLED`);
  console.log('  ENTRY-AGNOSTIC: every ticker-anchor opens a long at the NEXT open. Not a P&L test.');
  console.log('  no target, so "did any of the next 20 lows reach the stop" needs no intrabar ordering');
  console.log(`  economic floor: |diff| >= ${FLOOR_PP}pp, fixed before the run`);
  console.log(`  HOLDOUT ${HOLDOUT_START} onward: ${OPEN_HOLDOUT ? '*** BURNED ***' : 'SEALED, excluded in SQL'}`);
  console.log('  SURVIVORSHIP: blow-ups are absent, and blowing up is the archetypal stop-hitting');
  console.log('  event. Hit rates below are UNDERSTATED and the revealing names are the missing ones.');
  console.log('');

  const [sig] = await pool.query(
    `SELECT data_date, ticker, f3_volume_z FROM us_signal_history
      ${OPEN_HOLDOUT ? '' : 'WHERE data_date < ?'} ORDER BY data_date`,
    OPEN_HOLDOUT ? [] : [HOLDOUT_START]);
  const f3 = new Map();
  for (const r of sig) f3.set(`${r.ticker}|${r.data_date.toISOString().slice(0, 10)}`, Number(r.f3_volume_z));
  console.log(`${sig.length} signal rows`);

  const [px] = await pool.query(
    'SELECT ticker, date, open_price o, high_price h, low_price l, close_price c FROM us_stock_prices ORDER BY ticker, date ASC');

  // Per ticker: ATR at t, entry at t+1 open, and whether any low in
  // [t+1, t+FORWARD] reached each candidate stop.
  const byDate = new Map();
  {
    let cur = null, bars = [];
    const flush = () => {
      if (!bars.length) return;
      const atr = wilderATR(bars, ATR_PERIOD);
      for (let i = ATR_PERIOD; i + FORWARD < bars.length; i++) {
        const a = atr[i];
        if (!a || a <= 0) continue;
        const key = `${cur}|${bars[i].d}`;
        const z = f3.get(key);
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
  const disc = anchors.filter(d => d < SPLIT);
  const val = anchors.filter(d => d >= SPLIT);
  console.log(`${all.length} usable sessions (>= ${MIN_CROSS} names), ${anchors.length} anchors: ` +
    `${disc.length} discovery, ${val.length} validation\n`);

  const hit = (row, mult, adj) => row.minLow <= row.entry - row.atr * mult * adj;

  /**
   * One number per date: hitRate(F3 bottom quintile) - hitRate(F3 top quintile),
   * measured INSIDE ATR quintiles so stop width in ATR units is constant by
   * construction, then averaged across those quintiles.
   */
  function dateDiff(d, mult, beta) {
    const rows = byDate.get(d);
    const byAtr = rows.slice().sort((a, b) => a.atrPct - b.atrPct);
    const n = byAtr.length;
    const diffs = [], spreads = [], atrSpread = [];
    for (let q = 0; q < QUINT; q++) {
      const bucket = byAtr.filter((_, i) => quintOf(i, n) === q);
      if (bucket.length < QUINT * 3) continue;
      const byF3 = bucket.slice().sort((a, b) => a.f3 - b.f3);
      const m = byF3.length;
      const rates = [];
      // z(F3) for the candidate arm is standardised within the whole date, as
      // the pre-registration states -- not within the bucket.
      for (let g = 0; g < QUINT; g++) {
        const cell = byF3.filter((_, i) => quintOf(i, m) === g);
        if (!cell.length) { rates.push(null); continue; }
        const adjOf = r => (beta ? Math.max(0.2, 1 + beta * r._z) : 1);
        rates.push(cell.filter(r => hit(r, mult, adjOf(r))).length / cell.length);
      }
      if (rates[0] === null || rates[QUINT - 1] === null) continue;
      diffs.push(rates[0] - rates[QUINT - 1]);
      const ok = rates.filter(r => r !== null);
      spreads.push(Math.max(...ok) - Math.min(...ok));
      atrSpread.push((byAtr[Math.min(n - 1, (q + 1) * Math.floor(n / QUINT) - 1)].atrPct - bucket[0].atrPct) / bucket[0].atrPct);
    }
    if (!diffs.length) return null;
    return { diff: mean(diffs), spread: mean(spreads), atrSpread: mean(atrSpread) };
  }

  // z(F3) within date, computed once.
  for (const d of all) {
    const rows = byDate.get(d);
    const m = mean(rows.map(r => r.f3)), s = sd(rows.map(r => r.f3)) || 1;
    for (const r of rows) r._z = (r.f3 - m) / s;
  }

  /* ── PRIMARY — no fitted parameter anywhere ────────────────────────────── */
  console.log('='.repeat(88));
  console.log(`PRIMARY — hitRate(F3 bottom quintile) - hitRate(F3 top quintile), inside ATR quintiles`);
  console.log(`  at the deployed multiple ${DEPLOYED_MULT}x ATR. Positive = low-volume names hit stops MORE often.`);
  const primary = {};
  for (const [name, set] of [['DISCOVERY', disc], ['VALIDATION', val]]) {
    const series = set.map(d => dateDiff(d, DEPLOYED_MULT, 0)).filter(Boolean);
    const st = oneSample(series.map(x => x.diff));
    primary[name] = st;
    const baseHit = mean(set.flatMap(d => byDate.get(d).map(r => (hit(r, DEPLOYED_MULT, 1) ? 1 : 0))));
    console.log(`\n  ${name} — ${series.length} anchors`);
    console.log(`    base stop-hit rate: ${(baseHit * 100).toFixed(1)}%`);
    console.log(`    diff ${pp(st.mean)}   sd ${pp(st.sd)}   t ${st.t.toFixed(2)}   p ${st.p.toFixed(4)}   ` +
      `${Math.abs(st.mean) * 100 >= FLOOR_PP ? 'CLEARS FLOOR' : 'below floor'}`);
    console.log(`    mean within-ATR-quintile ATR spread: ${(mean(series.map(x => x.atrSpread)) * 100).toFixed(1)}% ` +
      '(how much room a residual ATR gradient has to leak in)');
  }

  /* ── SENSITIVITY across stop widths ────────────────────────────────────── */
  console.log(`\n${'='.repeat(88)}`);
  console.log('SENSITIVITY — descriptive, only 2.5x decides anything');
  console.log('    mult' + 'DISCOVERY diff'.padStart(18) + 't'.padStart(8) + 'VALIDATION diff'.padStart(18) + 't'.padStart(8));
  for (const m of MULTS) {
    const a = oneSample(disc.map(d => dateDiff(d, m, 0)).filter(Boolean).map(x => x.diff));
    const b = oneSample(val.map(d => dateDiff(d, m, 0)).filter(Boolean).map(x => x.diff));
    console.log(`    ${String(m).padEnd(4)}` + pp(a.mean).padStart(18) + a.t.toFixed(2).padStart(8) +
      pp(b.mean).padStart(18) + b.t.toFixed(2).padStart(8) + (m === DEPLOYED_MULT ? '   <- deployed' : ''));
  }

  /* ── SECONDARY — one parameter, fit on discovery, frozen ───────────────── */
  console.log(`\n${'='.repeat(88)}`);
  console.log('SECONDARY — can it be fixed? riskUnit = ATR x 2.5 x (1 + beta*z(F3))');
  console.log('  beta fitted on DISCOVERY ONLY to minimise the hit-rate spread across F3 quintiles,');
  console.log('  then FROZEN and applied unchanged to validation. Cannot produce a pass on its own.');
  let bestBeta = 0, bestSpread = Infinity;
  for (let b = -0.40; b <= 0.4001; b += 0.02) {
    const s = mean(disc.map(d => dateDiff(d, DEPLOYED_MULT, b)).filter(Boolean).map(x => x.spread));
    if (s !== null && s < bestSpread) { bestSpread = s; bestBeta = Math.round(b * 1000) / 1000; }
  }
  const spread0d = mean(disc.map(d => dateDiff(d, DEPLOYED_MULT, 0)).filter(Boolean).map(x => x.spread));
  const spread0v = mean(val.map(d => dateDiff(d, DEPLOYED_MULT, 0)).filter(Boolean).map(x => x.spread));
  const spreadBv = mean(val.map(d => dateDiff(d, DEPLOYED_MULT, bestBeta)).filter(Boolean).map(x => x.spread));
  const diffBv = oneSample(val.map(d => dateDiff(d, DEPLOYED_MULT, bestBeta)).filter(Boolean).map(x => x.diff));
  console.log(`  fitted beta (discovery): ${bestBeta >= 0 ? '+' : ''}${bestBeta.toFixed(3)}`);
  console.log(`  hit-rate spread across F3 quintiles:`);
  console.log(`    discovery  incumbent ${pp(spread0d)}   ->  candidate ${pp(bestSpread)}`);
  console.log(`    VALIDATION incumbent ${pp(spread0v)}   ->  candidate ${pp(spreadBv)}   ` +
    `${spreadBv < spread0v ? 'REDUCED' : 'NOT reduced'}`);
  console.log(`    validation residual diff under the candidate: ${pp(diffBv.mean)} (t ${diffBv.t.toFixed(2)})`);

  /* ── DECISION RULE ─────────────────────────────────────────────────────── */
  const d1 = primary.DISCOVERY, v1 = primary.VALIDATION;
  const c1 = Math.abs(d1.mean) * 100 >= FLOOR_PP && d1.p < 0.05;
  const c2 = Math.sign(v1.mean) === Math.sign(d1.mean) && v1.p < 0.05;
  const c3 = spreadBv < spread0v;
  console.log(`\n${'='.repeat(88)}`);
  console.log('DECISION RULE (fixed before the run, applied without interpretation)');
  console.log(`  1. DISCOVERY  |diff| >= ${FLOOR_PP}pp and p < 0.05 ......... ${c1 ? 'YES' : 'no'}   (${pp(d1.mean)}, p ${d1.p.toFixed(4)})`);
  console.log(`  2. VALIDATION same sign, p < 0.05 ................. ${c2 ? 'YES' : 'no'}   (${pp(v1.mean)}, p ${v1.p.toFixed(4)})`);
  console.log(`  3. candidate reduces validation spread ............ ${c3 ? 'YES' : 'no'}`);
  let verdict;
  if (c1 && c2 && c3) verdict = 'MISCALIBRATED AND WORTH FIXING';
  else if ((d1.p < 0.05 && c2) && (Math.abs(d1.mean) * 100 < FLOOR_PP || !c3)) {
    verdict = Math.abs(d1.mean) * 100 < FLOOR_PP
      ? 'MISCALIBRATED BUT NOT WORTH FIXING — real and below the 2pp floor'
      : 'MISCALIBRATED BUT NOT WORTH FIXING — real, and the proposed fix does not work';
  } else verdict = 'NOT MISCALIBRATED';
  console.log(`\n  VERDICT: ${verdict}`);
  console.log('\n  Entry-agnostic by design, so NOTHING here is a P&L or profitability claim.');
  console.log('  Gap risk ignored (stops filled at the stop price) — shared by both arms, but the');
  console.log('  absolute cost of being stopped is understated.');
  console.log(`  ${OPEN_HOLDOUT ? '*** HOLDOUT BURNED ***' : `Holdout ${HOLDOUT_START} onward remains sealed and unread.`}`);

  await pool.end();
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
