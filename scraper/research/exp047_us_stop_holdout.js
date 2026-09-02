'use strict';
/**
 * EXP-047 — S3 HOLDOUT READ. Opening this BURNS the reserved period.
 *
 * Sealed in CANDIDATE_SEAL_2026-09-02_stop_f3adj.md. Nothing in this file may
 * change between the seal and the run; the seal records this file's SHA-256 and
 * the run prints it back so a reader can verify the two match.
 *
 * ── WHAT IS BEING TESTED ─────────────────────────────────────────────────────
 *
 * EXP-046 established that the deployed stop is miscalibrated: at the same
 * ATR-relative distance, low-F3 names are stopped out 2.98pp more often
 * (discovery) and 4.65pp more (validation). A post-hoc refit found
 * beta = -0.020 roughly halves that. beta is FROZEN at that value here and is
 * not re-estimated.
 *
 * EXP-046 was deliberately entry-agnostic and had no targets, no costs and no
 * S/R snap. This run has all of them: the full deployed computeTradePlan, on the
 * signals production would actually journal.
 *
 * ── HOW THE CANDIDATE IS APPLIED ─────────────────────────────────────────────
 *
 * riskUnit = ATR x riskAtrMult inside computeTradePlan, so an F3-adjusted ATR is
 * exactly an F3-adjusted risk unit -- no fork of the production function is
 * needed, and the S/R snap band (0.5x-3x riskUnit) scales with it the way it
 * would in production. That is the point of running the full path.
 *
 * ── WHY THE ENTRY RULE DOES NOT NEED TO BE GOOD ──────────────────────────────
 *
 * EXP-044 showed the composite has no directional edge. Both arms see the
 * IDENTICAL entries on identical dates, so whatever edge the entry has or lacks
 * cancels in the paired difference. The entry has to be FIXED, not good.
 *
 * Usage: node scraper/research/exp047_us_stop_holdout.js --open-holdout
 */
const env = require('./env');
env.loadEnv();

const fs = require('fs');
const crypto = require('crypto');
const { createPool } = require('../modules/db_config');
const { calcTechnicalFactors, computeTradePlan } = require('../awo_technical');

/* ── FROZEN CONFIGURATION. Sealed; do not edit. ─────────────────────────── */
const CONFIG = {
  candidateId: 'US_STOP_F3ADJ_V1',
  holdoutStart: '2024-01-01',
  holdoutEnd: '2026-09-01',
  beta: -0.020,                 // frozen from the EXP-046b refit; NOT re-estimated
  adjFloor: 0.2,                // same clamp EXP-046 used
  atrPeriod: 14,
  riskAtrMult: 2.5,             // POSITION profile, unchanged in both arms
  target1R: 1.5,                // POSITION profile
  target2R: 2.5,
  maxHoldSessions: 20,          // the horizon the F3 range evidence was measured at
  roundTripCostPct: 0.50,       // project constant
  bullishSignals: ['STRONG BUY', 'BUY', 'WATCH'],
  anchorStep: 20,               // non-overlapping
  minCross: 100,
  quintiles: 5,
  sameBarAmbiguity: 'STOP',     // project convention, conservative
  nonInferiorityMarginPct: 0.10,
};

const OPEN = process.argv.includes('--open-holdout');

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
  const se = s / Math.sqrt(n);
  const t = m / se, df = n - 1, half = tCrit95(df) * se;
  return { mean: m, sd: s, n, t, p: tTwoSided(t, df), lo: m - half, hi: m + half };
}
function wilderATR(bars, period) {
  const out = new Array(bars.length).fill(null);
  let prev = null, trSum = 0;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
    if (i <= period) { trSum += tr; if (i === period) { prev = trSum / period; out[i] = prev; } }
    else { prev = (prev * (period - 1) + tr) / period; out[i] = prev; }
  }
  return out;
}
const bucketOf = (i, n, k) => Math.min(k - 1, Math.floor((i * k) / n));
const pct = v => (v === null || v === undefined ? '   n/a' : (v >= 0 ? '+' : '') + v.toFixed(3) + '%');
const pp = v => (v === null || v === undefined ? '   n/a' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + 'pp');

/**
 * Simulate one position through the deployed plan.
 * Exit precedence inside a bar: STOP before TARGET, per CONFIG.sameBarAmbiguity
 * -- a daily bar cannot say which came first, and the project's convention is to
 * resolve the ambiguity against the trade.
 */
function simulate(bars, i, plan) {
  const entry = plan.entry;
  for (let k = i + 1; k <= Math.min(i + CONFIG.maxHoldSessions, bars.length - 1); k++) {
    if (bars[k].low <= plan.stopLoss) return { exit: plan.stopLoss, reason: 'STOP', bars: k - i };
    if (bars[k].high >= plan.target1) return { exit: plan.target1, reason: 'TARGET', bars: k - i };
  }
  const last = bars[Math.min(i + CONFIG.maxHoldSessions, bars.length - 1)];
  return { exit: last.close, reason: 'TIME', bars: CONFIG.maxHoldSessions };
}
const netPct = (entry, exit) => ((exit - entry) / entry) * 100 - CONFIG.roundTripCostPct;

(async () => {
  const selfHash = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');

  console.log('EXP-047 — S3 HOLDOUT READ');
  console.log(`  script SHA-256: ${selfHash}`);
  console.log(`  candidate: ${CONFIG.candidateId}   beta ${CONFIG.beta} (FROZEN, not re-estimated)`);
  console.log(`  holdout: ${CONFIG.holdoutStart} .. ${CONFIG.holdoutEnd}`);
  console.log('  full deployed computeTradePlan: S/R snap ON, targets ON, costs ON');
  console.log(`  same-bar stop/target ambiguity resolves to ${CONFIG.sameBarAmbiguity} (conservative)`);
  console.log('');

  if (!OPEN) {
    console.log('  REFUSED. This is a reserved period and reading it burns it permanently.');
    console.log('  Re-run with --open-holdout only after the seal is committed.');
    process.exit(2);
  }
  console.log('  *** --open-holdout GIVEN. The reserved period is being consumed. ***');
  console.log('  *** Whatever this prints is the result and is recorded as such.  ***\n');

  const pool = createPool();
  const [sig] = await pool.query(
    `SELECT data_date, ticker, f3_volume_z, signal_type FROM us_signal_history
      WHERE data_date >= ? AND data_date <= ? ORDER BY data_date`,
    [CONFIG.holdoutStart, CONFIG.holdoutEnd]);

  // z(F3) within date across the WHOLE cross-section, exactly as EXP-046 did.
  const byDateSig = new Map();
  for (const r of sig) {
    const d = r.data_date.toISOString().slice(0, 10);
    if (!byDateSig.has(d)) byDateSig.set(d, []);
    byDateSig.get(d).push(r);
  }
  const zOf = new Map(), bullish = new Set();
  for (const [d, rows] of byDateSig) {
    const vals = rows.map(r => Number(r.f3_volume_z));
    const m = mean(vals), s = sd(vals) || 1;
    for (const r of rows) {
      zOf.set(`${r.ticker}|${d}`, (Number(r.f3_volume_z) - m) / s);
      if (CONFIG.bullishSignals.includes(r.signal_type)) bullish.add(`${r.ticker}|${d}`);
    }
  }
  const dates = [...byDateSig.keys()].sort().filter(d => byDateSig.get(d).length >= CONFIG.minCross);
  const anchors = dates.filter((_, i) => i % CONFIG.anchorStep === 0);
  console.log(`${sig.length} holdout signal rows, ${dates.length} sessions, ${anchors.length} non-overlapping anchors`);
  console.log(`bullish (${CONFIG.bullishSignals.join('/')}) rows: ${bullish.size}\n`);

  const anchorSet = new Set(anchors);
  const [px] = await pool.query(
    `SELECT ticker, date, open_price o, high_price h, low_price l, close_price c, volume v
       FROM us_stock_prices ORDER BY ticker, date ASC`);

  // ticker -> trades. Both arms built in the same pass so entries are identical.
  const trades = [];
  {
    let cur = null, bars = [];
    const flush = () => {
      if (bars.length < 80) { return; }
      const atr = wilderATR(bars, CONFIG.atrPeriod);
      for (let i = 60; i + CONFIG.maxHoldSessions < bars.length; i++) {
        const d = bars[i].date;
        if (!anchorSet.has(d)) continue;
        const key = `${cur}|${d}`;
        if (!bullish.has(key)) continue;
        const z = zOf.get(key);
        const a = atr[i];
        if (z === undefined || !a || a <= 0) continue;
        const sr = (() => {
          try { return calcTechnicalFactors(bars.slice(Math.max(0, i - 59), i + 1)).indicators?.sr ?? null; }
          catch { return null; }
        })();
        const entryPrice = bars[i + 1].open;
        if (!(entryPrice > 0)) continue;

        const adj = Math.max(CONFIG.adjFloor, 1 + CONFIG.beta * z);
        const arms = {};
        let ok = true;
        for (const [name, atrUsed] of [['incumbent', a], ['candidate', a * adj]]) {
          const plan = computeTradePlan(entryPrice, 'BUY', atrUsed, sr,
            { riskAtrMult: CONFIG.riskAtrMult, target1R: CONFIG.target1R, target2R: CONFIG.target2R });
          if (!plan || !(plan.stopLoss > 0) || plan.stopLoss >= entryPrice) { ok = false; break; }
          const res = simulate(bars, i, { ...plan, entry: entryPrice });
          arms[name] = { plan, res, net: netPct(entryPrice, res.exit) };
        }
        if (!ok) continue;
        trades.push({ date: d, ticker: cur, z, f3: Number(byDateSig.get(d).find(r => r.ticker === cur).f3_volume_z), arms });
      }
    };
    for (const r of px) {
      if (r.ticker !== cur) { flush(); cur = r.ticker; bars = []; }
      bars.push({ date: r.date.toISOString().slice(0, 10), open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v });
    }
    flush();
  }
  console.log(`${trades.length} paired trades across ${new Set(trades.map(t => t.date)).size} anchors\n`);

  const byAnchor = new Map();
  for (const t of trades) {
    if (!byAnchor.has(t.date)) byAnchor.set(t.date, []);
    byAnchor.get(t.date).push(t);
  }
  const usable = [...byAnchor.keys()].sort().filter(d => byAnchor.get(d).length >= CONFIG.quintiles * 3);

  /* ── Descriptive: what each arm did ────────────────────────────────────── */
  console.log('='.repeat(88));
  console.log('WHAT EACH ARM DID');
  for (const arm of ['incumbent', 'candidate']) {
    const all = trades.map(t => t.arms[arm]);
    const stops = all.filter(x => x.res.reason === 'STOP').length;
    const tgts = all.filter(x => x.res.reason === 'TARGET').length;
    const nets = all.map(x => x.net);
    const wins = nets.filter(v => v > 0);
    const losses = nets.filter(v => v <= 0);
    const pf = losses.length ? wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0)) : null;
    console.log(`  ${arm.padEnd(10)} stop ${(stops / all.length * 100).toFixed(1)}%  ` +
      `target ${(tgts / all.length * 100).toFixed(1)}%  time ${((all.length - stops - tgts) / all.length * 100).toFixed(1)}%  ` +
      `net/trade ${pct(mean(nets))}  win ${(wins.length / all.length * 100).toFixed(1)}%  ` +
      `PF ${pf === null ? 'n/a' : pf.toFixed(3)}`);
  }

  /* ── PRIMARY A — does the candidate equalise stop-out rates across F3? ─── */
  console.log(`\n${'='.repeat(88)}`);
  console.log('PRIMARY A (efficacy) — stop-out rate, F3 bottom quintile minus top quintile');
  const diffs = { incumbent: [], candidate: [] };
  for (const d of usable) {
    const rows = byAnchor.get(d).slice().sort((a, b) => a.f3 - b.f3);
    const n = rows.length;
    const lo = rows.filter((_, i) => bucketOf(i, n, CONFIG.quintiles) === 0);
    const hi = rows.filter((_, i) => bucketOf(i, n, CONFIG.quintiles) === CONFIG.quintiles - 1);
    if (!lo.length || !hi.length) continue;
    for (const arm of ['incumbent', 'candidate']) {
      const r = x => x.filter(t => t.arms[arm].res.reason === 'STOP').length / x.length;
      diffs[arm].push(r(lo) - r(hi));
    }
  }
  const dInc = oneSample(diffs.incumbent), dCan = oneSample(diffs.candidate);
  console.log(`  anchors used: ${diffs.incumbent.length}`);
  console.log(`  incumbent  diff ${pp(dInc.mean)}  95% CI [${pp(dInc.lo)}, ${pp(dInc.hi)}]  t ${dInc.t.toFixed(2)}  p ${dInc.p.toFixed(4)}`);
  console.log(`  candidate  diff ${pp(dCan.mean)}  95% CI [${pp(dCan.lo)}, ${pp(dCan.hi)}]  t ${dCan.t.toFixed(2)}  p ${dCan.p.toFixed(4)}`);
  const shrank = Math.abs(dCan.mean) < Math.abs(dInc.mean);
  console.log(`  |diff| ${shrank ? 'SHRANK' : 'did NOT shrink'}: ${(Math.abs(dInc.mean) * 100).toFixed(2)}pp -> ${(Math.abs(dCan.mean) * 100).toFixed(2)}pp`);

  /* ── PRIMARY B — non-inferiority on net return ─────────────────────────── */
  console.log(`\n${'='.repeat(88)}`);
  console.log('PRIMARY B (no harm) — paired net return per trade, candidate minus incumbent');
  const perAnchor = usable.map(d => {
    const rows = byAnchor.get(d);
    return mean(rows.map(t => t.arms.candidate.net)) - mean(rows.map(t => t.arms.incumbent.net));
  });
  const nb = oneSample(perAnchor);
  console.log(`  anchors: ${nb.n}   mean ${pct(nb.mean)}   95% CI [${pct(nb.lo)}, ${pct(nb.hi)}]   t ${nb.t.toFixed(2)}   p ${nb.p.toFixed(4)}`);
  const nonInferior = nb.lo > -CONFIG.nonInferiorityMarginPct;
  console.log(`  non-inferiority margin -${CONFIG.nonInferiorityMarginPct}%: lower bound ${pct(nb.lo)} ` +
    `${nonInferior ? 'CLEARS' : 'does NOT clear'}`);

  /* ── DECISION ──────────────────────────────────────────────────────────── */
  console.log(`\n${'='.repeat(88)}`);
  console.log('SEALED DECISION RULE');
  console.log(`  A. candidate shrinks |stop-out diff| ............ ${shrank ? 'YES' : 'no'}`);
  console.log(`  B. net return non-inferior (LB > -${CONFIG.nonInferiorityMarginPct}%) ..... ${nonInferior ? 'YES' : 'no'}`);
  const verdict = shrank && nonInferior
    ? 'CANDIDATE HOLDS ON THE HOLDOUT — eligible for S4 forward shadow, no capital'
    : (!shrank && !nonInferior ? 'CANDIDATE FAILS ON BOTH ARMS'
      : (!shrank ? 'CANDIDATE FAILS — it did not equalise stop-out rates'
        : 'CANDIDATE FAILS — it equalised stop-out rates but cost return'));
  console.log(`\n  VERDICT: ${verdict}`);
  console.log('\n  THE HOLDOUT IS NOW BURNED. It cannot be un-burned, and this candidate cannot');
  console.log('  reach S4 on a re-read. Any further change to the definition needs a fresh period.');
  console.log(`  Survivorship: today's S&P 500 projected back; blow-ups absent. Biased upward.`);
  console.log(`  Gap risk ignored (fills at the stop price), shared by both arms.`);

  await pool.end();
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
