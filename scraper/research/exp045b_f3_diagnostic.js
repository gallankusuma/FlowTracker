'use strict';
/**
 * EXP-045b — a post-hoc attempt to KILL the F3 result.
 *
 * NOT a registered test. It can only undermine EXP-045's finding, never
 * strengthen it. If every check below passes, the honest statement is still
 * "the obvious ways to break it did not work", which is weaker than a
 * pre-registered pass and must never be quoted as confirmation.
 *
 * ── WHAT NEEDS BREAKING ──────────────────────────────────────────────────────
 *
 * EXP-045 found F3 (volume z-score) is a CARRIER against 20-session range after
 * residualising on volatility: discovery IC -0.0417 (t -7.55), validation
 * -0.0402 (t -5.19), 4/4 stability blocks.
 *
 * The reason to distrust it is the shape of the result. F3's RAW IC against
 * range is -0.0046 -- indistinguishable from zero. The entire effect appears
 * only after the controls are removed. That is a classic SUPPRESSION pattern,
 * and suppression is exactly what a mis-specified control manufactures:
 *
 *   1. Residualisation is a LINEAR fit on ranks. If F3's relationship to
 *      volatility is curved, the linear fit leaves structured residual that can
 *      correlate with range for no real reason. Check 1 conditions
 *      NON-PARAMETRICALLY instead -- inside volatility quintiles, where no
 *      functional form is assumed at all. If the sign only survives in the
 *      extreme buckets, the effect is a linearity artefact.
 *
 *   2. f3_volumeZ is not a pure volume measure. It adds +/-10 for price
 *      DIRECTION and clamps to [0,100], so it piles mass at the bounds. Check 2
 *      re-runs the conditioning on the raw volume z-score itself, rebuilt from
 *      prices with no direction term and no clamp. If the effect lives in the
 *      scoring wrapper rather than in volume, it dies here.
 *
 *   3. An effect of |IC| 0.04 could be carried by a handful of extreme dates or
 *      a few tickers. Check 3 reports the per-date distribution and the result
 *      with the most extreme dates removed.
 *
 * Usage: node scraper/research/exp045b_f3_diagnostic.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');

const MIN_CROSS = 30;
const STEP = 20;
const HOLDOUT_START = '2024-01-01';
const VOL_WINDOW = 20;
const QUINTILES = 5;
const Z_WINDOW = 60;          // matches what computeUSStockFactors feeds f3_volumeZ

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
const tStat = xs => {
  const m = mean(xs), s = sd(xs);
  return s ? m / (s / Math.sqrt(xs.length)) : null;
};
const f4 = v => (v === null || v === undefined ? '   n/a' : (v >= 0 ? '+' : '') + v.toFixed(4));

(async () => {
  const pool = createPool();
  console.log('EXP-045b — post-hoc attempt to KILL the F3 result. Can only undermine, never confirm.\n');

  const [rows] = await pool.query(
    `SELECT data_date, ticker, f3_volume_z, f14_atr, max_profit_20d, max_drawdown_20d
       FROM us_signal_history
      WHERE max_profit_20d IS NOT NULL AND max_drawdown_20d IS NOT NULL AND data_date < ?
      ORDER BY data_date`, [HOLDOUT_START]);

  // PRIOR_VOL and a CLEAN volume z-score, both from prices, both strictly as-of.
  const [px] = await pool.query(
    'SELECT ticker, date, change_pct, volume FROM us_stock_prices ORDER BY ticker, date ASC');
  const pv = new Map(), zclean = new Map();
  {
    let cur = null, chg = [], vol = [];
    for (const r of px) {
      if (r.ticker !== cur) { cur = r.ticker; chg = []; vol = []; }
      chg.push(Number(r.change_pct)); vol.push(Number(r.volume));
      if (chg.length > VOL_WINDOW) chg.shift();
      if (vol.length > Z_WINDOW) vol.shift();
      const d = r.date.toISOString().slice(0, 10);
      if (chg.length === VOL_WINDOW) pv.set(`${r.ticker}|${d}`, sd(chg));
      if (vol.length === Z_WINDOW) {
        // Raw z of today's volume against the last 60 sessions. No direction
        // term, no clamp -- the thing f3_volumeZ wraps.
        const m = mean(vol), s = sd(vol);
        if (s > 0) zclean.set(`${r.ticker}|${d}`, (vol[vol.length - 1] - m) / s);
      }
    }
  }

  const byDate = new Map();
  for (const r of rows) {
    const d = r.data_date.toISOString().slice(0, 10);
    const k = `${r.ticker}|${d}`;
    const v = pv.get(k), z = zclean.get(k);
    if (v === undefined || !Number.isFinite(v)) continue;
    r._pv = v;
    r._z = z !== undefined && Number.isFinite(z) ? z : null;
    r._range = Number(r.max_profit_20d) - Number(r.max_drawdown_20d);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(r);
  }
  const all = [...byDate.keys()].sort().filter(d => byDate.get(d).length >= MIN_CROSS);
  const anchors = all.filter((_, i) => i % STEP === 0);
  console.log(`${anchors.length} non-overlapping anchors, ${all[0]} .. ${all[all.length - 1]}`);
  console.log(`clean volume z available on ${[...byDate.values()].flat().filter(r => r._z !== null).length} of ${rows.length} rows\n`);

  /* ── CHECK 1 — non-parametric conditioning, no functional form assumed ─── */
  console.log('CHECK 1 — F3 vs range INSIDE volatility quintiles (no linear fit anywhere)');
  console.log('  If the sign survives only in extreme buckets, the residual result is a linearity artefact.');
  const perQ = Array.from({ length: QUINTILES }, () => []);
  for (const d of anchors) {
    const cross = byDate.get(d).slice().sort((a, b) => a._pv - b._pv);
    const size = Math.floor(cross.length / QUINTILES);
    if (size < 8) continue;
    for (let q = 0; q < QUINTILES; q++) {
      const bucket = cross.slice(q * size, q === QUINTILES - 1 ? cross.length : (q + 1) * size);
      const c = spearman(bucket.map(r => Number(r.f3_volume_z)), bucket.map(r => r._range));
      if (c !== null && Number.isFinite(c)) perQ[q].push(c);
    }
  }
  let survived = 0;
  for (let q = 0; q < QUINTILES; q++) {
    const t = tStat(perQ[q]);
    const m = mean(perQ[q]);
    const neg = m < 0 && t < -2;
    if (neg) survived++;
    console.log(`  vol quintile ${q + 1} (${q === 0 ? 'calmest' : q === QUINTILES - 1 ? 'wildest' : '       '})  ` +
      `IC ${f4(m)}  t ${t === null ? 'n/a' : t.toFixed(2).padStart(6)}  n=${perQ[q].length}` +
      (neg ? '   negative & significant' : ''));
  }
  console.log(`  => ${survived}/${QUINTILES} quintiles negative at |t| > 2 ` +
    `${survived >= 4 ? '(holds without any linearity assumption)' : '(DOES NOT hold across buckets — the residual result is suspect)'}\n`);

  /* ── CHECK 2 — is it volume, or is it the scoring wrapper? ─────────────── */
  console.log('CHECK 2 — same conditioning on the RAW volume z-score (no direction term, no clamp)');
  console.log('  f3_volumeZ adds +/-10 for price direction and clamps to [0,100]. If the effect');
  console.log('  lives in that wrapper rather than in volume, it dies here.');
  const perQ2 = Array.from({ length: QUINTILES }, () => []);
  for (const d of anchors) {
    const cross = byDate.get(d).filter(r => r._z !== null).sort((a, b) => a._pv - b._pv);
    const size = Math.floor(cross.length / QUINTILES);
    if (size < 8) continue;
    for (let q = 0; q < QUINTILES; q++) {
      const bucket = cross.slice(q * size, q === QUINTILES - 1 ? cross.length : (q + 1) * size);
      const c = spearman(bucket.map(r => r._z), bucket.map(r => r._range));
      if (c !== null && Number.isFinite(c)) perQ2[q].push(c);
    }
  }
  let survived2 = 0;
  for (let q = 0; q < QUINTILES; q++) {
    const t = tStat(perQ2[q]), m = mean(perQ2[q]);
    const neg = m < 0 && t < -2;
    if (neg) survived2++;
    console.log(`  vol quintile ${q + 1}  IC ${f4(m)}  t ${t === null ? 'n/a' : t.toFixed(2).padStart(6)}  n=${perQ2[q].length}`);
  }
  console.log(`  => ${survived2}/${QUINTILES} negative at |t| > 2. ` +
    `${survived2 >= 4 ? 'The effect is in VOLUME, not in the wrapper.' : 'The raw z does NOT reproduce it — the effect is in the SCORING, not the data.'}\n`);

  /* ── CHECK 3 — is it a few dates? ──────────────────────────────────────── */
  console.log('CHECK 3 — is the whole thing a handful of dates?');
  const series = [];
  for (const d of anchors) {
    const cross = byDate.get(d);
    const c = spearman(cross.map(r => Number(r.f3_volume_z)), cross.map(r => r._range));
    if (c !== null && Number.isFinite(c)) series.push([d, c]);
  }
  const vals = series.map(s => s[1]);
  const negShare = vals.filter(v => v < 0).length / vals.length;
  const sorted = series.slice().sort((a, b) => a[1] - b[1]);
  const trimmed = sorted.slice(5, sorted.length - 5).map(s => s[1]);
  console.log(`  raw per-date IC (unconditioned): mean ${f4(mean(vals))}, ${(negShare * 100).toFixed(0)}% of dates negative`);
  console.log(`  most negative dates: ${sorted.slice(0, 3).map(s => `${s[0]} ${f4(s[1])}`).join(', ')}`);
  console.log(`  most positive dates: ${sorted.slice(-3).map(s => `${s[0]} ${f4(s[1])}`).join(', ')}`);
  console.log(`  trimming the 5 most extreme dates each way: mean ${f4(mean(trimmed))}  t ${tStat(trimmed).toFixed(2)}\n`);

  /* ── CHECK 3b — the check CHECK 3 should have been ─────────────────────
     CHECK 3 trims the UNCONDITIONED series, and there is no unconditioned
     effect to trim, so it answers a question nobody asked. The conditioned
     effect is the one that has to survive losing its best dates. */
  console.log('CHECK 3b — trimming the conditioned series (CHECK 3 trimmed the wrong one)');
  const cond = [];
  for (const d of anchors) {
    const cross = byDate.get(d).slice().sort((a, b) => a._pv - b._pv);
    const size = Math.floor(cross.length / QUINTILES);
    if (size < 8) continue;
    const qs = [];
    for (let q = 0; q < QUINTILES; q++) {
      const bucket = cross.slice(q * size, q === QUINTILES - 1 ? cross.length : (q + 1) * size);
      const c = spearman(bucket.map(r => Number(r.f3_volume_z)), bucket.map(r => r._range));
      if (c !== null && Number.isFinite(c)) qs.push(c);
    }
    if (qs.length === QUINTILES) cond.push([d, mean(qs)]);
  }
  const cv = cond.map(x => x[1]);
  const cs = cond.slice().sort((a, b) => a[1] - b[1]);
  const cTrim = cs.slice(10, cs.length - 10).map(x => x[1]);
  console.log(`  conditioned per-date IC: mean ${f4(mean(cv))}  t ${tStat(cv).toFixed(2)}  ` +
    `${(cv.filter(v => v < 0).length / cv.length * 100).toFixed(0)}% of dates negative`);
  console.log(`  after removing the 10 most extreme dates EACH WAY: mean ${f4(mean(cTrim))}  ` +
    `t ${tStat(cTrim).toFixed(2)}  n=${cTrim.length}`);
  const half1 = cv.slice(0, Math.floor(cv.length / 2)), half2 = cv.slice(Math.floor(cv.length / 2));
  console.log(`  first half ${f4(mean(half1))} (t ${tStat(half1).toFixed(2)})   ` +
    `second half ${f4(mean(half2))} (t ${tStat(half2).toFixed(2)})
`);

  /* ── CHECK 4 — how curved IS the F3/volatility relationship? ───────────── */
  console.log('CHECK 4 — how curved is the F3 vs PRIOR_VOL relationship? (the thing residualisation assumed straight)');
  const dec = Array.from({ length: 10 }, () => []);
  for (const d of anchors) {
    const cross = byDate.get(d).slice().sort((a, b) => a._pv - b._pv);
    const size = Math.floor(cross.length / 10);
    if (size < 4) continue;
    for (let q = 0; q < 10; q++) {
      const bucket = cross.slice(q * size, q === 9 ? cross.length : (q + 1) * size);
      dec[q].push(mean(bucket.map(r => Number(r.f3_volume_z))));
    }
  }
  console.log('  mean F3 by volatility decile (calmest -> wildest):');
  console.log('    ' + dec.map(a => (mean(a) ?? 0).toFixed(1).padStart(6)).join(''));

  await pool.end();
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
