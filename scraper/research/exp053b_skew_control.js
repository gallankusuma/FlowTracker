'use strict';
/**
 * EXP-053b — is the weekly-VAL result just distribution SKEW?
 *
 * NOT a registered test. Post-hoc, and it can only undermine EXP-053's pass.
 *
 * ── THE CONCERN, WHICH EXP-053'S OWN PRE-REGISTRATION NAMED ──────────────────
 *
 * EXP-053 matched the two arms on MEDIAN distance and found the weekly VAL hit
 * 4.44pp less (FIT) and 4.15pp less (CHECK). But the distributions are not the
 * same shape:
 *
 *     weekly VAL   median 2.88%   mean 4.14%
 *     ATR k=0.77   median 2.86%   mean 3.29%
 *
 * Matched at the median, the VAL arm carries a FATTER RIGHT TAIL. Hit rate is a
 * concave function of distance -- going from 2% to 4% away removes far more hits
 * than going from 10% to 12% -- so an arm with more mass far out is hit less
 * often for a reason that has nothing to do with where the level sits. The
 * pre-registration listed "matched on median, not per trade" as a known
 * weakness; this is that weakness made concrete.
 *
 * Two ways to remove it, both stricter than the registered matching:
 *
 *   1. MEAN-MATCHED. Refit k so the MEANS agree instead of the medians. If the
 *      gap dies, the registered result was the skew.
 *
 *   2. QUANTILE-MATCHED. Give each trade an ATR stop at the distance holding the
 *      SAME RANK in the ATR distribution that its VAL distance holds in the VAL
 *      distribution. That equalises the ENTIRE distribution, not one moment, and
 *      is the strongest matching available short of making the two stops
 *      identical. Whatever survives this is placement and not shape.
 *
 * Usage: node scraper/research/exp053b_skew_control.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');
const { zones } = require('../deep_analysis');

const FIT_END = '2021-01-01';
const CHECK_END = '2024-01-01';
const RESERVED_START = '2024-01-01';
const ATR_PERIOD = 14, WEEK = 5, BUFFER_ATR = 0.2;
const FORWARD = 20, STEP = 20, WARMUP = 60;
const MIN_NONZERO = 48, MIN_CROSS = 100;

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = a => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const tOf = xs => { const m = mean(xs), s = sd(xs); return s && xs.length > 2 ? m / (s / Math.sqrt(xs.length)) : null; };
const pp = v => (v === null || v === undefined ? '   n/a' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + 'pp');
const pctd = v => (v === null || v === undefined ? '  n/a' : (v * 100).toFixed(2) + '%');

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

(async () => {
  const pool = createPool();
  console.log('EXP-053b — is the weekly-VAL result just distribution SKEW?');
  console.log('  Post-hoc. Can only undermine EXP-053, never confirm it.');
  console.log('  Registered matching was on the MEDIAN; the VAL arm has the fatter right tail');
  console.log('  (mean 4.14% vs 3.29%), and hit rate is concave in distance.\n');

  const [px] = await pool.query(
    `SELECT stock_code, date, open_price o, high_price h, low_price l, close_price c, volume v
       FROM idx_stock_prices WHERE date < ? AND close_price > 0 ORDER BY stock_code, date ASC`,
    [RESERVED_START]);

  const byDate = new Map();
  let considered = 0, silent = 0;
  {
    let cur = null, bars = [];
    const flush = () => {
      if (bars.length < WARMUP + FORWARD + 2) return;
      const atr = wilderATR(bars, ATR_PERIOD);
      for (let i = WARMUP - 1; i + FORWARD < bars.length - 1; i++) {
        const a = atr[i];
        if (!a || a <= 0) continue;
        if (bars.slice(i - 59, i + 1).filter(b => b.v > 0).length < MIN_NONZERO) continue;
        const entry = bars[i + 1].o;
        if (!(entry > 0)) continue;
        considered++;
        let val = null;
        try {
          const z = zones(bars.slice(i - WEEK + 1, i + 1));
          val = z.valueArea ? z.valueArea.lo : null;
        } catch { /* leave null */ }
        if (!(val !== null && val > 0 && val < entry)) { silent++; continue; }
        let lo = Infinity;
        for (let k = i + 1; k <= i + FORWARD; k++) lo = Math.min(lo, bars[k].l);
        const d = bars[i].d;
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d).push({ entry, minLow: lo, atr: a, val: val - BUFFER_ATR * a });
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
  console.log(`${anchors.length} anchors: FIT ${fit.length}, CHECK ${check.length}`);
  // EXP-053 failed to print this -- its counter used stale keys and printed NaN.
  console.log(`weekly VAL silent (absent or not below entry) on ${silent}/${considered} ` +
    `ticker-days (${(silent / considered * 100).toFixed(1)}%)\n`);

  const dVal = r => (r.entry - r.val) / r.entry;
  const dAtr = (r, k) => (k * r.atr) / r.entry;
  const hitVal = r => r.minLow <= r.val;
  const hitAtrK = (r, k) => r.minLow <= r.entry - k * r.atr;
  const hitAtrD = (r, dist) => r.minLow <= r.entry * (1 - dist);

  const fitRows = fit.flatMap(d => byDate.get(d));
  const fitDistVal = fitRows.map(dVal);

  function fitK(target, stat) {
    let best = 2.5, err = Infinity;
    for (let c = 0.05; c <= 8.001; c += 0.005) {
      const e = Math.abs(stat(fitRows.map(r => dAtr(r, c))) - target);
      if (e < err) { err = e; best = Math.round(c * 1000) / 1000; }
    }
    return best;
  }
  const kMed = fitK(median(fitDistVal), median);
  const kMean = fitK(mean(fitDistVal), mean);

  const gapK = (dates, k) => dates.map(d => {
    const g = byDate.get(d);
    return mean(g.map(r => (hitAtrK(r, k) ? 1 : 0))) - mean(g.map(r => (hitVal(r) ? 1 : 0)));
  });

  console.log('='.repeat(88));
  console.log('CHECK 1 — MEAN-matched instead of median-matched');
  console.log(`  VAL median ${pctd(median(fitDistVal))} mean ${pctd(mean(fitDistVal))}`);
  console.log(`  k matched on MEDIAN = ${kMed}  (EXP-053 used 0.77)`);
  console.log(`  k matched on MEAN   = ${kMean}`);
  for (const [name, set] of [['FIT', fit], ['CHECK', check]]) {
    const gm = gapK(set, kMed), ga = gapK(set, kMean);
    console.log(`  ${name.padEnd(6)} median-matched ${pp(mean(gm))} (t ${tOf(gm).toFixed(2)})   ` +
      `mean-matched ${pp(mean(ga))} (t ${tOf(ga).toFixed(2)})`);
  }

  /* ── CHECK 2 — quantile matching: equalise the WHOLE distribution ───────── */
  console.log(`\n${'='.repeat(88)}`);
  console.log('CHECK 2 — QUANTILE-matched: each trade gets the ATR distance holding the SAME RANK');
  console.log('  in the ATR distribution that its VAL distance holds in the VAL distribution.');
  console.log('  This equalises the entire distribution, not one moment. Whatever survives is');
  console.log('  placement and not shape.');
  const sortedVal = fitDistVal.slice().sort((a, b) => a - b);
  const sortedAtr = fitRows.map(r => dAtr(r, 1)).sort((a, b) => a - b);   // ATR% itself
  const rankOf = (sorted, x) => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m; }
    return Math.min(sorted.length - 1, lo);
  };
  const qDist = r => sortedAtr[rankOf(sortedVal, dVal(r))];

  for (const [name, set] of [['FIT', fit], ['CHECK', check]]) {
    const g = set.map(d => {
      const rows = byDate.get(d);
      return mean(rows.map(r => (hitAtrD(r, qDist(r)) ? 1 : 0))) - mean(rows.map(r => (hitVal(r) ? 1 : 0)));
    });
    const dq = set.flatMap(d => byDate.get(d).map(qDist));
    const dv = set.flatMap(d => byDate.get(d).map(dVal));
    console.log(`  ${name.padEnd(6)} gap ${pp(mean(g))} (t ${tOf(g).toFixed(2)})   ` +
      `distances: VAL med ${pctd(median(dv))} mean ${pctd(mean(dv))} | ` +
      `ATR med ${pctd(median(dq))} mean ${pctd(mean(dq))}`);
  }

  console.log('\n  If the gap survives BOTH, the weekly VAL is genuinely better placed.');
  console.log('  If it dies under either, EXP-053 measured the shape of the distance');
  console.log('  distribution and called it placement — the same class of error as EXP-045.');
  console.log(`  RESERVED [${RESERVED_START} ..] not read.`);
  await pool.end();
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
