'use strict';
/**
 * EXP-033 — the single pre-registered hypothesis from
 * PREREGISTRATION_2026-08-20_inflexp_em.md.
 *
 * H1: a rise in US 5-year breakeven inflation over the prior 20 sessions predicts
 *     a LOWER forward 20-session return on emerging-market equities.
 *     One-sided; direction fixed in advance.
 *
 * ── WHY A BASKET AND NOT A PER-MARKET COMBINATION ────────────────────────────
 *
 * EXP-031 combined nine markets with Stouffer, and that was legitimate: each
 * market had its OWN currency, so each was an independent test of a local
 * mechanism.
 *
 * This predictor is GLOBAL. One US series against many co-moving EM markets is
 * not N independent tests — combining per-market z-scores would overstate
 * significance for exactly the reason overlapping windows do. The honest unit of
 * observation is the ANCHOR DATE, so the six markets are averaged into one
 * equal-weighted basket and a single IC is computed. n comes from the number of
 * non-overlapping anchors, never from multiplying by market count.
 *
 * Six USD-denominated ETFs, none previously queried by this project. The nine
 * EXP-031 markets are excluded because their returns have already been read once.
 *
 * Usage: node scraper/research/macro/exp033_inflexp_em.js
 */
const fs = require('fs');
const path = require('path');
const env = require('../env');
env.loadEnv();

const { createPool } = require('../../modules/db_config');
const stats = require('../../modules/statistics');

const H = 20;            // horizon, sessions
const CHG = 20;          // predictor lookback, sessions
const PUB_LAG_DAYS = 1;  // T5YIE is daily and on FRED the next business day
const DATA = path.join(__dirname, 'exp033_data.json');
const MARKETS = ['VNM', 'GXG', 'EPU', 'KSA', 'ECH', 'EPOL'];

const toDateStr = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Spearman IC with a one-sided p toward the PREDICTED negative direction. */
function spearmanOneSided(xs, ys) {
  const n = xs.length;
  if (n < 8) return { ic: null, z: null, p: null, n };
  const rank = arr => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const ic = stats.correlation(rank(xs), rank(ys));
  if (!Number.isFinite(ic) || Math.abs(ic) >= 1) return { ic, z: null, p: null, n };
  const z = 0.5 * Math.log((1 + ic) / (1 - ic)) * Math.sqrt(n - 3);
  return { ic, z, p: Math.min(1, Math.max(0, stats.normalCDF(z))), n };
}

(async () => {
  if (!fs.existsSync(DATA)) {
    console.error('Missing ' + DATA + '\nFetch first: .venv/bin/python3 research/macro/exp033_fetch.py');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const pool = createPool();

  // ── the predictor, publication-lagged exactly as EXP-032 did ───────────────
  const [obs] = await pool.query(
    "SELECT date, value FROM ft_macro_data WHERE indicator='INFL_EXP_5Y' ORDER BY date ASC");
  const visible = obs
    .map(o => ({ at: addDays(toDateStr(o.date), PUB_LAG_DAYS), v: Number(o.value) }))
    .filter(o => Number.isFinite(o.v))
    .sort((a, b) => (a.at < b.at ? -1 : 1));

  // ── the shared calendar: dates where EVERY market has a close ─────────────
  const seriesOf = {};
  for (const m of MARKETS) seriesOf[m] = new Map((raw[m] || []).map(r => [r.d, r.c]));
  const common = (raw[MARKETS[0]] || [])
    .map(r => r.d)
    .filter(d => MARKETS.every(m => seriesOf[m].has(d)))
    .sort();

  // Last PUBLISHED predictor value at each common date.
  const known = [];
  let si = 0, cur = null;
  for (const d of common) {
    while (si < visible.length && visible[si].at <= d) { cur = visible[si].v; si++; }
    known.push(cur);
  }

  console.log('EXP-033 — pre-registered: US 5Y breakeven up 20d  ->  EM equities down over the next 20d');
  console.log('  one-sided, direction fixed in PREREGISTRATION_2026-08-20_inflexp_em.md');
  console.log(`  basket : ${MARKETS.join(', ')}  (USD ETFs, never queried before)`);
  console.log(`  shared trading dates: ${common.length}  (${common[0]} .. ${common[common.length - 1]})`);
  console.log('  m = 1 hypothesis; the unit of observation is the ANCHOR DATE, not market x date');
  console.log('');

  // ── non-overlapping anchors ───────────────────────────────────────────────
  const anchors = [];
  for (let i = CHG; i + H < common.length; i += H) {
    const back = known[i - CHG], now = known[i];
    if (!(back > 0) || !Number.isFinite(now)) continue;
    const chg = now / back - 1;

    const perMarket = MARKETS.map(m =>
      seriesOf[m].get(common[i + H]) / seriesOf[m].get(common[i]) - 1);
    if (perMarket.some(v => !Number.isFinite(v))) continue;

    anchors.push({ d: common[i], chg, basket: stats.mean(perMarket), perMarket });
  }

  const primary = spearmanOneSided(anchors.map(a => a.chg), anchors.map(a => a.basket));

  console.log('PRIMARY TEST — one IC, basket target');
  console.log(`  anchors (n)      : ${primary.n}`);
  console.log(`  rank IC          : ${primary.ic === null ? 'n/a' : primary.ic.toFixed(4)}`);
  console.log(`  z                : ${primary.z === null ? 'n/a' : primary.z.toFixed(4)}`);
  console.log(`  one-sided p      : ${primary.p === null ? 'n/a' : primary.p.toFixed(5)}`);
  const confirmed = primary.p !== null && primary.p < 0.05 && primary.ic < 0;
  console.log(`  VERDICT          : ${confirmed ? 'CONFIRMED' : 'NOT CONFIRMED'} against the pre-registered rule`);

  console.log('');
  console.log('SECONDARY (descriptive, NOT decisive — will not rescue a failed primary)');
  console.log('  market   IC');
  let neg = 0;
  MARKETS.forEach((m, k) => {
    const r = spearmanOneSided(anchors.map(a => a.chg), anchors.map(a => a.perMarket[k]));
    if (Number.isFinite(r.ic) && r.ic < 0) neg++;
    console.log('  ' + m.padEnd(8) + (r.ic === null ? 'n/a' : (r.ic >= 0 ? ' ' : '') + r.ic.toFixed(4)));
  });
  console.log(`  ${neg} of ${MARKETS.length} negative`);

  console.log('');
  console.log('The holdout for this hypothesis is now read.');
  await pool.end();
})().catch(env.fail);
