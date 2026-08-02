/**
 * EXP-012 — Factor Independence, Combination, Turnover and Liquidity-Tier
 *           Robustness for the EXP-011 survivors
 *
 * QUESTION
 * --------
 * EXP-011 found three lookbacks with significant positive IC at 40-60D:
 * HI52W (proximity to the 252-day high), ROC252_sk21 and ROC120_sk21 (12-1 and
 * 6-1 momentum). Before building anything on them:
 *
 *   1. Are they three signals or one? Highly rank-correlated factors are one
 *      bet wearing three hats, and blending them adds risk concentration while
 *      looking like diversification.
 *   2. Does any combination beat the best single factor?
 *   3. Is the signal monotone across deciles, or concentrated in the extreme
 *      bucket (which would make it a thin, fragile, hard-to-trade effect)?
 *   4. What is the turnover? A position-horizon factor that reshuffles weekly
 *      pays the 0.50% round trip far more often than its holding period implies.
 *   5. Does it survive inside liquidity tiers? An effect that lives only in
 *      thin names is not tradeable at size, and IDX's liquidity distribution is
 *      steep.
 *
 * Still ranking-only: no entry timing, no stop, no target, no fees. Costs and
 * ARA/ARB execution realism are the NEXT experiment; this one decides what
 * factor is worth taking there.
 *
 * SURVIVORSHIP: universe is today's tracked list applied backwards.
 * SURVIVORSHIP-BIASED RESEARCH RESULT (Review.md item 4b).
 *
 * Usage: node backtest_factor_combination_ic.js [--min-adv 5e9] [--json out.json]
 */
'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const stats = require('./modules/statistics');
const cs = require('./modules/cross_sectional');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const HORIZONS = [20, 40, 60];
const WARMUP = 273;
const MIN_ELIGIBLE_PER_DAY = 25;
const ADV_WINDOW = 20;
const DEFAULT_MIN_ADV = 5e9;
const SAMPLE_STEP = 5;              // weekly — the independent sampling from EXP-011
const TOP_DECILE_FRAC = 0.10;
const BOOTSTRAP_RESAMPLES = 2000;
const RANDOM_SEED = 42;

/** Base factors carried forward from EXP-011 (the significant survivors). */
const BASE = [
  { key: 'HI52W', kind: 'hi52w', bars: 252, skip: 0 },
  { key: 'MOM12_1', kind: 'roc', bars: 252, skip: 21 },
  { key: 'MOM6_1', kind: 'roc', bars: 120, skip: 21 },
];

/** Combinations tested, as weights over percentile-ranked base factors. */
const COMBOS = [
  { key: 'HI52W_only',        w: { HI52W: 1 } },
  { key: 'MOM12_1_only',      w: { MOM12_1: 1 } },
  { key: 'MOM6_1_only',       w: { MOM6_1: 1 } },
  { key: 'HI+MOM12 (50/50)',  w: { HI52W: 0.5, MOM12_1: 0.5 } },
  { key: 'HI+MOM12 (70/30)',  w: { HI52W: 0.7, MOM12_1: 0.3 } },
  { key: 'HI+MOM6  (50/50)',  w: { HI52W: 0.5, MOM6_1: 0.5 } },
  { key: 'all three (equal)', w: { HI52W: 1 / 3, MOM12_1: 1 / 3, MOM6_1: 1 / 3 } },
];

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { minAdv: DEFAULT_MIN_ADV, json: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--min-adv') out.minAdv = Number(a[++i]);
    else if (a[i] === '--json') out.json = a[++i];
  }
  return out;
}

const toDateStr = d => d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d).split('T')[0];

function rollingMedian(arr, i, w) {
  if (i + 1 < w) return null;
  const s = arr.slice(i - w + 1, i + 1).filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function baseScore(series, i, f) {
  const { closes, highs } = series;
  if (f.kind === 'hi52w') {
    if (i < f.bars) return null;
    let hi = -Infinity;
    for (let j = i - f.bars + 1; j <= i; j++) if (highs[j] > hi) hi = highs[j];
    return hi > 0 ? (closes[i] / hi) * 100 : null;
  }
  const e = i - f.skip, s = e - f.bars;
  if (s < 0) return null;
  const a = closes[e], b = closes[s];
  return (a > 0 && b > 0) ? ((a - b) / b) * 100 : null;
}

/** Cross-sectional percentile rank in [0,1], tie-aware, so factors on different
 *  units (a % of high vs a % return) can be blended without one dominating. */
function pctRank(values) {
  const r = cs.rankTransform(values);
  const n = values.length;
  return r.map(x => n > 1 ? (x - 1) / (n - 1) : 0.5);
}

const fmt = (v, d = 4) => (v === null || v === undefined || !Number.isFinite(v)) ? '   n/a' : v.toFixed(d).padStart(7);

async function main() {
  const opts = parseArgs();
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  console.log('='.repeat(104));
  console.log('EXP-012 — Factor Independence, Combination, Turnover, Liquidity Tiers');
  console.log('*** SURVIVORSHIP-BIASED RESEARCH RESULT ***');
  console.log('='.repeat(104));

  const [ihsg] = await pool.query('SELECT date FROM idx_ihsg_history ORDER BY date ASC');
  const tradingDates = ihsg.map(r => toDateStr(r.date));
  const dateIdx = new Map(tradingDates.map((d, i) => [d, i]));

  const [priceRows] = await pool.query(
    `SELECT stock_code, date, close_price, high_price, volume, value
       FROM idx_stock_prices WHERE close_price > 0 ORDER BY stock_code, date ASC`
  );
  const byTicker = new Map();
  for (const r of priceRows) {
    if (!byTicker.has(r.stock_code)) byTicker.set(r.stock_code, []);
    byTicker.get(r.stock_code).push({
      date: toDateStr(r.date),
      close: Number(r.close_price),
      high: Number(r.high_price) || Number(r.close_price),
      value: Number(r.value) || Number(r.close_price) * Number(r.volume || 0),
    });
  }

  const maxH = Math.max(...HORIZONS);
  const series = new Map();
  for (const [ticker, candles] of byTicker) {
    const n = tradingDates.length;
    const closes = new Array(n).fill(null), highs = new Array(n).fill(null), values = new Array(n).fill(null);
    let placed = 0;
    for (const c of candles) {
      const i = dateIdx.get(c.date);
      if (i === undefined) continue;
      closes[i] = c.close; highs[i] = c.high; values[i] = c.value; placed++;
    }
    if (placed >= WARMUP + maxH + 10) series.set(ticker, { closes, highs, values });
  }
  console.log(`\nAxis: ${tradingDates.length} dates ${tradingDates[0]}..${tradingDates[tradingDates.length - 1]}   eligible tickers: ${series.size}`);
  console.log(`Liquidity floor: median ${ADV_WINDOW}d value >= Rp ${(opts.minAdv / 1e9).toFixed(1)}bn   sampling: every ${SAMPLE_STEP} trading days\n`);

  // ── Accumulators ──────────────────────────────────────────────────────────
  const pairCorr = { 'HI52W~MOM12_1': [], 'HI52W~MOM6_1': [], 'MOM12_1~MOM6_1': [] };
  const comboAcc = new Map(COMBOS.map(c => [c.key, {
    ics: new Map(HORIZONS.map(h => [h, []])),
    byYear: new Map(HORIZONS.map(h => [h, new Map()])),
    deciles: new Map(HORIZONS.map(h => [h, Array.from({ length: 10 }, () => ({ sum: 0, n: 0 }))])),
    universe: new Map(HORIZONS.map(h => [h, { sum: 0, n: 0 }])),
    prevTop: null, turnover: [],
    tierIC: { large: new Map(HORIZONS.map(h => [h, []])), small: new Map(HORIZONS.map(h => [h, []])) },
  }]));

  let datesUsed = 0, eligibleCounts = [];

  for (let i = WARMUP; i < tradingDates.length - maxH; i += SAMPLE_STEP) {
    const year = tradingDates[i].slice(0, 4);

    // Screen + gather base factor values and forward returns for this date.
    const rows = [];
    for (const [ticker, s] of series) {
      if (s.closes[i] === null) continue;
      const adv = rollingMedian(s.values, i, ADV_WINDOW);
      if (adv === null || adv < opts.minAdv) continue;
      const p0 = s.closes[i];
      const fwd = HORIZONS.map(h => s.closes[i + h]);
      if (!(p0 > 0) || fwd.some(p => p === null || !(p > 0))) continue;
      const bases = {};
      let ok = true;
      for (const f of BASE) {
        const v = baseScore(s, i, f);
        if (v === null || !Number.isFinite(v)) { ok = false; break; }
        bases[f.key] = v;
      }
      if (!ok) continue;
      rows.push({
        ticker, adv, bases,
        rets: Object.fromEntries(HORIZONS.map((h, hi) => [h, ((fwd[hi] - p0) / p0) * 100])),
      });
    }
    if (rows.length < MIN_ELIGIBLE_PER_DAY) continue;
    datesUsed++;
    eligibleCounts.push(rows.length);

    // Percentile-rank each base factor across this date's cross-section.
    const ranked = {};
    for (const f of BASE) ranked[f.key] = pctRank(rows.map(r => r.bases[f.key]));

    // (1) Pairwise rank correlation — are these the same bet?
    pairCorr['HI52W~MOM12_1'].push(stats.correlation(ranked.HI52W, ranked.MOM12_1));
    pairCorr['HI52W~MOM6_1'].push(stats.correlation(ranked.HI52W, ranked.MOM6_1));
    pairCorr['MOM12_1~MOM6_1'].push(stats.correlation(ranked.MOM12_1, ranked.MOM6_1));

    // Liquidity tiers: split this date's cross-section at the ADV median.
    const advSorted = [...rows].map(r => r.adv).sort((a, b) => a - b);
    const advMedian = advSorted[advSorted.length >> 1];

    for (const combo of COMBOS) {
      const acc = comboAcc.get(combo.key);
      const scores = rows.map((_, idx) =>
        Object.entries(combo.w).reduce((s, [k, w]) => s + w * ranked[k][idx], 0));

      for (const h of HORIZONS) {
        const rets = rows.map(r => r.rets[h]);
        const ic = cs.spearmanIC(scores, rets);
        if (ic !== null && Number.isFinite(ic)) {
          acc.ics.get(h).push(ic);
          const ym = acc.byYear.get(h);
          if (!ym.has(year)) ym.set(year, []);
          ym.get(year).push(ic);
        }
        const { buckets, universeMean } = cs.bucketByScore(scores, rets, 10);
        buckets.forEach((b, bi) => {
          if (b.meanReturn !== null) { const d = acc.deciles.get(h)[bi]; d.sum += b.meanReturn * b.n; d.n += b.n; }
        });
        if (universeMean !== null) { const u = acc.universe.get(h); u.sum += universeMean * rets.length; u.n += rets.length; }

        // Tier ICs — same factor, restricted cross-section.
        for (const tier of ['large', 'small']) {
          const keep = rows.map((r, idx) => ({ idx, keep: tier === 'large' ? r.adv >= advMedian : r.adv < advMedian }))
            .filter(x => x.keep).map(x => x.idx);
          if (keep.length >= MIN_ELIGIBLE_PER_DAY) {
            const tIC = cs.spearmanIC(keep.map(k => scores[k]), keep.map(k => rets[k]));
            if (tIC !== null && Number.isFinite(tIC)) acc.tierIC[tier].get(h).push(tIC);
          }
        }
      }

      // (4) Turnover of the top decile between consecutive ranking dates.
      const k = Math.max(1, Math.round(rows.length * TOP_DECILE_FRAC));
      const top = new Set(rows.map((r, idx) => ({ t: r.ticker, s: scores[idx] }))
        .sort((a, b) => b.s - a.s).slice(0, k).map(x => x.t));
      if (acc.prevTop) {
        let kept = 0;
        for (const t of top) if (acc.prevTop.has(t)) kept++;
        acc.turnover.push(1 - kept / top.size);
      }
      acc.prevTop = top;
    }
  }

  console.log(`Ranking dates used: ${datesUsed}   median cross-section size: ${Math.round(stats.mean(eligibleCounts))}\n`);

  // ── (1) Independence ──────────────────────────────────────────────────────
  console.log('='.repeat(104));
  console.log('1. FACTOR INDEPENDENCE — mean cross-sectional rank correlation');
  console.log('='.repeat(104));
  for (const [pair, vals] of Object.entries(pairCorr)) {
    const m = stats.mean(vals);
    const verdict = Math.abs(m) > 0.8 ? 'REDUNDANT — one bet, not two'
      : Math.abs(m) > 0.6 ? 'heavily overlapping'
      : Math.abs(m) > 0.35 ? 'related but distinct'
      : 'largely independent';
    console.log(`  ${pair.padEnd(18)} r = ${m.toFixed(3)}   ${verdict}`);
  }

  // ── (2) Combination ICs ───────────────────────────────────────────────────
  console.log('\n' + '='.repeat(104));
  console.log('2. COMBINATION IC  (* = bootstrap 95% CI excludes zero)');
  console.log('='.repeat(104));
  console.log('  combo                  horizon   meanIC     IR    %pos    CI_low   CI_high');
  const comboOut = {};
  for (const combo of COMBOS) {
    const acc = comboAcc.get(combo.key);
    comboOut[combo.key] = {};
    for (const h of HORIZONS) {
      const ics = acc.ics.get(h);
      const ci = cs.bootstrapMeanCI(ics, { resamples: BOOTSTRAP_RESAMPLES, seed: RANDOM_SEED });
      const ir = cs.icInformationRatio(ics);
      const pct = ics.length ? (ics.filter(v => v > 0).length / ics.length) * 100 : null;
      const sig = ci.lower !== null && (ci.lower > 0 || ci.upper < 0) ? ' *' : '';
      console.log(`  ${combo.key.padEnd(22)} ${String(h).padStart(3)}D   ${fmt(ci.mean)}  ${fmt(ir, 2)}  ${fmt(pct, 1)}   ${fmt(ci.lower)}   ${fmt(ci.upper)}${sig}`);
      comboOut[combo.key][h] = { meanIC: ci.mean, ir, pctPositive: pct, ciLower: ci.lower, ciUpper: ci.upper, significant: !!sig };
    }
  }

  // ── (3) Decile shape for the best combo at 60D ────────────────────────────
  let best = null;
  for (const combo of COMBOS) {
    const ci = cs.bootstrapMeanCI(comboAcc.get(combo.key).ics.get(60), { seed: RANDOM_SEED });
    if (ci.mean !== null && (!best || ci.mean > best.ic)) best = { key: combo.key, ic: ci.mean };
  }
  console.log('\n' + '='.repeat(104));
  console.log(`3. DECILE SHAPE — best 60D combo: ${best.key}  (is the signal monotone, or only in the extreme bucket?)`);
  console.log('='.repeat(104));
  for (const h of HORIZONS) {
    const acc = comboAcc.get(best.key);
    const u = acc.universe.get(h);
    const univ = u.n ? u.sum / u.n : null;
    const ds = acc.deciles.get(h).map(d => d.n ? d.sum / d.n : null);
    console.log(`\n  ${h}D forward return by decile (D1 = lowest score, D10 = highest). Universe mean ${fmt(univ, 2)}%`);
    process.stdout.write('   ');
    ds.forEach((v, i) => process.stdout.write(`D${i + 1}:${fmt(v, 1)}% `));
    console.log('');
    const mono = ds.every((v, i) => i === 0 || v === null || ds[i - 1] === null || v >= ds[i - 1]);
    const upperHalfMono = ds.slice(5).every((v, i) => i === 0 || v >= ds[5 + i - 1]);
    console.log(`    strictly monotone across all 10: ${mono ? 'YES' : 'no'}   monotone across D6-D10: ${upperHalfMono ? 'YES' : 'no'}`);
  }

  // ── (4) Turnover ──────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(104));
  console.log('4. TOP-DECILE TURNOVER per rebalance (weekly ranking)');
  console.log('='.repeat(104));
  for (const combo of COMBOS) {
    const t = comboAcc.get(combo.key).turnover;
    const m = t.length ? stats.mean(t) : null;
    const impliedHoldWeeks = m && m > 0 ? 1 / m : null;
    console.log(`  ${combo.key.padEnd(22)} ${fmt(m * 100, 1)}% replaced/week   implied avg membership ${impliedHoldWeeks ? impliedHoldWeeks.toFixed(1) + ' weeks' : 'n/a'}`);
  }
  console.log('\n  Read: turnover above ~25%/week means the "position" factor is actually reshuffling');
  console.log('  faster than the 2-8 week holding period, and would pay the 0.50% round trip that often.');

  // ── (5) Liquidity tiers ───────────────────────────────────────────────────
  console.log('\n' + '='.repeat(104));
  console.log(`5. LIQUIDITY-TIER ROBUSTNESS — ${best.key}, IC within each half of the cross-section`);
  console.log('='.repeat(104));
  console.log('  horizon    large-cap half    small-cap half');
  for (const h of HORIZONS) {
    const acc = comboAcc.get(best.key);
    const L = acc.tierIC.large.get(h), S = acc.tierIC.small.get(h);
    console.log(`   ${String(h).padStart(3)}D    ${fmt(L.length ? stats.mean(L) : null)}           ${fmt(S.length ? stats.mean(S) : null)}`);
  }
  console.log('\n  If the effect lives only in the small-cap half it is not tradeable at size on IDX.');

  // ── (6) Per-year stability of the best combo at 40D ───────────────────────
  console.log('\n' + '='.repeat(104));
  console.log(`6. PER-YEAR mean IC at 40D — ${best.key}`);
  console.log('='.repeat(104));
  const ym = comboAcc.get(best.key).byYear.get(40);
  const years = [...ym.keys()].sort();
  process.stdout.write('  ');
  years.forEach(y => process.stdout.write(y.slice(2).padStart(7)));
  console.log('');
  process.stdout.write('  ');
  years.forEach(y => { const v = ym.get(y); process.stdout.write((v.length >= 3 ? stats.mean(v).toFixed(3) : '  -').padStart(7)); });
  console.log('');
  const yearMeans = years.map(y => ym.get(y)).filter(v => v.length >= 3).map(v => stats.mean(v));
  console.log(`\n  positive years: ${yearMeans.filter(v => v > 0).length}/${yearMeans.length}`);

  if (opts.json) {
    require('fs').writeFileSync(opts.json, JSON.stringify({
      datesUsed, pairCorr: Object.fromEntries(Object.entries(pairCorr).map(([k, v]) => [k, stats.mean(v)])),
      combos: comboOut, best: best.key,
    }, null, 2));
    console.log(`\nJSON written to ${opts.json}`);
  }

  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
