/**
 * Momentum Rank Alpha Diagnostic — EXP-2026-08-02-010.
 *
 * EXP-2026-08-01-009 (Momentum Leadership Breakout, standalone backtest)
 * simulated the FULL strategy — cross-sectional ranking + breakout entry +
 * several timing/quality filters — and found only 2-8 signals fired per
 * variant across the ~2-year price-history window in this DB. Inconclusive:
 * too few trades to say anything, not evidence against the strategy.
 *
 * External review's diagnosis (2026-08-02): implementation/engineering were
 * fine ("kegagalan bukan pada kode strategi, melainkan keterbatasan data") —
 * test whether the RANKING ITSELF has predictive power BEFORE testing (or
 * re-testing) any entry-timing mechanics on top of it. Ranking quality can
 * be measured on every (ticker, date) pair, not just the rare days where
 * every Setup A condition aligns — turning ~223 usable dates x a handful of
 * trades into ~223 dates x ~90 tickers x 4 horizons, tens of thousands of
 * observations, with the SAME data already in hand (no backfill needed
 * first). This is the reviewer's own stated "most important next
 * experiment."
 *
 * Method: for every eligible trading date, rank the universe by the SAME
 * composite momentum score EXP-009 used (30% RS-6m vs IHSG + 25% RS-3m vs
 * IHSG + 20% 52-week-high proximity + 10% EMA50 slope + 10% volume Z-score +
 * 5% MACD-normalized, each percentile-ranked cross-sectionally before
 * weighting — ported verbatim from backtest_momentum_leadership.js, not
 * re-derived), split into 10 deciles, measure FORWARD returns (no stop/
 * target/entry-timing at all) at 5/10/20/60 trading-day horizons. Reports,
 * per horizon: decile table, Spearman Information Coefficient (mean, stdDev,
 * Information Ratio, % positive dates), decile-rank monotonicity, top-decile
 * return (gross and after a flat 0.50% round-trip cost), top-minus-bottom
 * spread, top-decile-vs-IHSG and vs-universe (paired same-date diffs),
 * decile-10 turnover, and a date-block bootstrap 95% CI on mean IC.
 *
 * DELIBERATE DIFFERENCE FROM EXP-009: does NOT apply the IHSG-downtrend
 * skip EXP-009's trade-timing loop used. Every date clearing only the
 * MIN_ELIGIBLE_PER_DAY floor is included — the reviewer's spec says "setiap
 * tanggal," and it's more informative to know whether the ranking's
 * predictive power holds during downtrends too, not just cherry-picked
 * "safe" dates.
 *
 * Reviewer's own decision rule, printed as a mechanical (not authoritative)
 * read at the end of each horizon: monotonic deciles + positive mean IC ->
 * proceed to layer-decomposition/timing-layer follow-ups. Not monotonic +
 * IC<=0 -> the ranking formula itself needs revisiting first.
 *
 * SCOPE: standalone diagnostic only, same discipline as EXP-009 — no live
 * wiring, no new DB tables, no UI. No writes to any table — pure read +
 * console report. Safe to rerun.
 *
 * Usage: node backtest_momentum_rank_diagnostic.js
 */

'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const stats = require('./modules/statistics');
const { emaSeries } = require('./awo_technical');
const { BIG_CAP_100 } = require('./modules/tickers');
const { mulberry32 } = require('./awo_optimizer');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

// ── Ported verbatim from backtest_momentum_leadership.js (same ranking
// formula must not drift between the two scripts) ──────────────────────────
const MIN_HISTORY_BARS = 260;
const RS_6M_BARS = 126;
const RS_3M_BARS = 63;
const HIGH_52W_BARS = 252;
const EMA50_SLOPE_LOOKBACK = 10;
const VOL_Z_WINDOW = 20;
const MIN_ELIGIBLE_PER_DAY = 20;
const WARMUP = 260;

// ── New to this script ──────────────────────────────────────────────────
const HORIZONS = [5, 10, 20, 60]; // trading days forward
const ROUND_TRIP_COST_PCT = 0.50; // same assumption as every backtest script in this project
const BOOTSTRAP_RESAMPLES = 2000;
const BOOTSTRAP_ALPHA = 0.05;
const RANDOM_SEED = 42;

function toDateStr(d) {
  return d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0];
}

/** Mirrors calcATR's Wilder-smoothing loop exactly (ported from
 * backtest_momentum_leadership.js, verified byte-identical to awo_technical.js's
 * calcATR there — not re-verified here since the formula is unchanged). */
function buildAtrSeries(highs, lows, closes, period = 14) {
  const n = highs.length;
  const series = new Array(n).fill(null);
  if (n < period + 1) return series;
  const tr = new Array(n).fill(null);
  for (let k = 1; k < n; k++) {
    tr[k] = Math.max(highs[k] - lows[k], Math.abs(highs[k] - closes[k - 1]), Math.abs(lows[k] - closes[k - 1]));
  }
  let sum = 0;
  for (let k = 1; k <= period; k++) sum += tr[k];
  let atr = sum / period;
  series[period] = atr;
  for (let k = period + 1; k < n; k++) {
    atr = (atr * (period - 1) + tr[k]) / period;
    series[k] = atr;
  }
  return series;
}

/** Mirrors calcMACD's math exactly (ported from backtest_momentum_leadership.js). */
function buildMacdHistogramSeries(closes, fast = 12, slow = 26, sig = 9) {
  const n = closes.length;
  const histogram = new Array(n).fill(null);
  if (n < slow + sig) return histogram;
  const fastSeries = emaSeries(closes, fast);
  const slowSeries = emaSeries(closes, slow);
  const macdCompact = [];
  for (let i = slow - 1; i < n; i++) macdCompact.push(fastSeries[i] - slowSeries[i]);
  const signalCompact = emaSeries(macdCompact, sig);
  for (let k = 0; k < macdCompact.length; k++) {
    if (signalCompact[k] != null) histogram[slow - 1 + k] = macdCompact[k] - signalCompact[k];
  }
  return histogram;
}

function maxOverWindow(arr, i, windowSize) {
  const start = i - windowSize + 1;
  if (start < 0) return null;
  let m = -Infinity;
  for (let k = start; k <= i; k++) if (arr[k] > m) m = arr[k];
  return m;
}

function closeAsOfCanonicalDate(td, tradingDates, dateIdxCanonical, toleranceDays = 5) {
  for (let back = 0; back <= toleranceDays; back++) {
    const idx = dateIdxCanonical - back;
    if (idx < 0) return null;
    const i = td.dateIndex.get(tradingDates[idx]);
    if (i !== undefined) return td.candles[i].close;
  }
  return null;
}

function rsVsIhsg(td, ihsgCandles, tradingDates, dateIdxCanonical, lookbackBars) {
  const anchorIdx = dateIdxCanonical - lookbackBars;
  if (anchorIdx < 0) return null;
  const nowClose = closeAsOfCanonicalDate(td, tradingDates, dateIdxCanonical, 5);
  const thenClose = closeAsOfCanonicalDate(td, tradingDates, anchorIdx, 5);
  if (nowClose == null || thenClose == null || !(thenClose > 0)) return null;
  const ihsgNow = ihsgCandles[dateIdxCanonical].close;
  const ihsgThen = ihsgCandles[anchorIdx].close;
  if (!(ihsgThen > 0)) return null;
  return (nowClose / thenClose - 1) - (ihsgNow / ihsgThen - 1);
}

function pctRankInPlace(arr, field) {
  const sorted = [...arr].sort((a, b) => a[field] - b[field]);
  const n = sorted.length;
  sorted.forEach((c, idx) => { c[`${field}_pct`] = n > 1 ? idx / (n - 1) : 0.5; });
}

// ── New machinery for this script ───────────────────────────────────────

/** Average-rank (tie-aware) transform, 1-based. Tie-aware on BOTH sides of
 * spearmanIC deliberately: composite scores are continuous (ties near-
 * impossible), but forward returns on IDX specifically can tie exactly —
 * ARA/ARB (auto-reject-atas/bawah, IDX's daily price-limit mechanism) means
 * multiple stocks can post identical capped % moves the same day, a real
 * feature of this market's data, not a theoretical edge case. */
function rankTransform(values) {
  const n = values.length;
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(n);
  let k = 0;
  while (k < n) {
    let j = k;
    while (j + 1 < n && indexed[j + 1].v === indexed[k].v) j++;
    const avgRank = (k + 1 + j + 1) / 2; // 1-based positions k+1..j+1, averaged
    for (let m = k; m <= j; m++) ranks[indexed[m].i] = avgRank;
    k = j + 1;
  }
  return ranks;
}

/** Spearman IC = Pearson correlation of ranks. Returns null (not a fake 0)
 * below 3 observations, so a thin date can't silently pull the average
 * toward zero. */
function spearmanIC(scores, returns) {
  if (scores.length < 3) return null;
  return stats.correlation(rankTransform(scores), rankTransform(returns));
}

/** Simpler than awo_optimizer.js's dateBlockBootstrapExpectancyTest — this
 * resamples already-computed scalar IC values (one per date), not raw
 * per-signal rows needing rescoring. Same index-formula shape for
 * project-wide consistency. */
function bootstrapMeanCI(values, { resamples = BOOTSTRAP_RESAMPLES, alpha = BOOTSTRAP_ALPHA, seed = RANDOM_SEED } = {}) {
  if (values.length < 3) return { mean: null, lower: null, upper: null, n: values.length };
  const rng = mulberry32(seed);
  const resampledMeans = new Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let k = 0; k < values.length; k++) sum += values[Math.floor(rng() * values.length)];
    resampledMeans[r] = sum / values.length;
  }
  resampledMeans.sort((a, b) => a - b);
  const lowerIdx = Math.max(0, Math.floor(resamples * (alpha / 2)));
  const upperIdx = Math.min(resamples - 1, Math.ceil(resamples * (1 - alpha / 2)));
  return { mean: stats.mean(values), lower: resampledMeans[lowerIdx], upper: resampledMeans[upperIdx], n: values.length };
}

async function main() {
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  console.log('Loading universe (BIG_CAP_100) + price history...');
  const tickerData = new Map();
  for (const ticker of BIG_CAP_100) {
    const [rows] = await pool.query(
      `SELECT date, open_price o, high_price h, low_price l, close_price c, volume v FROM idx_stock_prices WHERE stock_code=? ORDER BY date ASC`,
      [ticker]
    );
    if (rows.length < MIN_HISTORY_BARS) continue;
    const candles = rows.map(r => ({
      date: toDateStr(r.date), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v),
    }));
    const dateIndex = new Map();
    candles.forEach((c, idx) => dateIndex.set(c.date, idx));
    const highs = candles.map(c => c.high), lows = candles.map(c => c.low), closes = candles.map(c => c.close), volumes = candles.map(c => c.volume);
    tickerData.set(ticker, {
      candles, dateIndex, highs, lows, closes, volumes,
      ema50Series: emaSeries(closes, 50),
      atrSeries: buildAtrSeries(highs, lows, closes, 14),
      macdHistSeries: buildMacdHistogramSeries(closes, 12, 26, 9),
    });
  }
  console.log(`Universe: ${tickerData.size}/${BIG_CAP_100.length} tickers meet the >=${MIN_HISTORY_BARS}-bar history gate.`);

  const [ihsgRows] = await pool.query(`SELECT date, open_price o, high_price h, low_price l, close_price c FROM idx_ihsg_history ORDER BY date ASC`);
  const ihsgCandles = ihsgRows.map(r => ({ date: toDateStr(r.date), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c) }));
  const tradingDates = ihsgCandles.map(c => c.date);
  console.log(`Canonical trading dates (IHSG calendar): ${tradingDates.length}`);

  // ── Per-date ranking pass — identical formula to backtest_momentum_leadership.js's
  // Pass 2, deliberately WITHOUT the IHSG-downtrend skip that script applies for
  // trade timing (see header comment: every date is scientifically informative here).
  const eligibleCountByDate = [];
  let datesSkippedTooFewEligible = 0, datesRanked = 0;
  const rankedDates = []; // [{date, dateIdxCanonical, candidatesToday(sorted desc, decile assigned)}]

  console.log('Running cross-sectional ranking (every date, no IHSG-downtrend skip)...');
  for (let d = WARMUP; d < tradingDates.length; d++) {
    const date = tradingDates[d];
    const candidatesToday = [];
    for (const [ticker, td] of tickerData) {
      const i = td.dateIndex.get(date);
      if (i === undefined || i < MIN_HISTORY_BARS - 1) continue;
      if (td.volumes[i] === 0) continue;

      const rs6m = rsVsIhsg(td, ihsgCandles, tradingDates, d, RS_6M_BARS);
      const rs3m = rsVsIhsg(td, ihsgCandles, tradingDates, d, RS_3M_BARS);
      const high252 = maxOverWindow(td.highs, i, HIGH_52W_BARS);
      const ema50 = td.ema50Series[i], ema50Past = td.ema50Series[i - EMA50_SLOPE_LOOKBACK];
      const ema50Slope = (ema50 != null && ema50Past != null && ema50Past > 0) ? (ema50 - ema50Past) / ema50Past : null;
      const volZ = stats.zScoreFromArray(td.volumes.slice(Math.max(0, i - VOL_Z_WINDOW + 1), i + 1));
      const atrHere = td.atrSeries[i], macdHere = td.macdHistSeries[i];
      const macdNorm = (atrHere != null && atrHere > 0 && macdHere != null) ? macdHere / atrHere : null;

      if (rs6m == null || rs3m == null || high252 == null || !(high252 > 0) || ema50Slope == null || macdNorm == null) continue;

      candidatesToday.push({ ticker, i, rs6m, rs3m, prox52w: td.candles[i].close / high252, ema50Slope, volZ, macdNorm });
    }

    eligibleCountByDate.push(candidatesToday.length);
    if (candidatesToday.length < MIN_ELIGIBLE_PER_DAY) { datesSkippedTooFewEligible++; continue; }
    datesRanked++;

    for (const f of ['rs6m', 'rs3m', 'prox52w', 'ema50Slope', 'volZ', 'macdNorm']) pctRankInPlace(candidatesToday, f);
    for (const c of candidatesToday) {
      c.compositeScore = 0.30 * c.rs6m_pct + 0.25 * c.rs3m_pct + 0.20 * c.prox52w_pct + 0.10 * c.ema50Slope_pct + 0.10 * c.volZ_pct + 0.05 * c.macdNorm_pct;
    }
    candidatesToday.sort((a, b) => b.compositeScore - a.compositeScore);

    const n = candidatesToday.length;
    candidatesToday.forEach((c, idx) => { c.decile = 10 - Math.min(9, Math.floor(idx * 10 / n)); });

    rankedDates.push({ date, dateIdxCanonical: d, candidatesToday });
  }

  console.log(`Dates ranked: ${datesRanked} (skipped: ${datesSkippedTooFewEligible} too few eligible). [Compare against EXP-2026-08-01-009's own datesRanked+datesSkippedIhsgDowntrend — should be >= that, since the only removed gate is the IHSG-downtrend skip.]`);

  // ── Turnover — a property of the ranking series itself, computed once per
  // ranked date (not once per date-per-horizon), reused identically across
  // every horizon's report block below. ──────────────────────────────────
  const turnoverByDateIdx = new Map(); // rankedDates array index -> turnover or null
  let prevDecile10 = null;
  for (let k = 0; k < rankedDates.length; k++) {
    const decile10 = new Set(rankedDates[k].candidatesToday.filter(c => c.decile === 10).map(c => c.ticker));
    if (prevDecile10 === null) {
      turnoverByDateIdx.set(k, null);
    } else {
      let notInPrev = 0;
      for (const t of decile10) if (!prevDecile10.has(t)) notInPrev++;
      turnoverByDateIdx.set(k, decile10.size > 0 ? notInPrev / decile10.size : null);
    }
    prevDecile10 = decile10;
  }
  const turnoverValues = [...turnoverByDateIdx.values()].filter(v => v != null);
  const meanTurnover = turnoverValues.length ? stats.mean(turnoverValues) : null;

  // ── Per-horizon analysis ────────────────────────────────────────────────
  console.log('\n' + '='.repeat(100));
  console.log('MOMENTUM RANK ALPHA DIAGNOSTIC — forward returns by decile, no stop/target/entry-timing');
  console.log(`Universe: ${tickerData.size} tickers (BIG_CAP_100, >=${MIN_HISTORY_BARS} bars). Dates ranked: ${datesRanked}.`);
  console.log('='.repeat(100));

  const horizonVerdicts = [];

  for (const h of HORIZONS) {
    const icValues = [];
    const decileSums = {}; for (let dec = 1; dec <= 10; dec++) decileSums[dec] = { sum: 0, n: 0 };
    const pairedIhsgDiffs = [], pairedUniverseDiffs = [];

    for (const rd of rankedDates) {
      const { candidatesToday, dateIdxCanonical: d } = rd;
      const withFwd = [];
      for (const c of candidatesToday) {
        if (c.i + h >= tickerData.get(c.ticker).candles.length) continue; // excluded, not zero-filled
        const td = tickerData.get(c.ticker);
        const fwd = td.candles[c.i + h].close / td.candles[c.i].close - 1;
        withFwd.push({ ...c, fwd });
        decileSums[c.decile].sum += fwd; decileSums[c.decile].n += 1;
      }
      if (withFwd.length < 3) continue;

      const ic = spearmanIC(withFwd.map(c => c.compositeScore), withFwd.map(c => c.fwd));
      if (ic != null) icValues.push(ic);

      // Paired same-date diffs (decile 10 avg return vs IHSG / vs pooled universe, same window)
      const decile10Fwd = withFwd.filter(c => c.decile === 10).map(c => c.fwd);
      if (decile10Fwd.length > 0 && d + h < ihsgCandles.length) {
        const decile10Avg = stats.mean(decile10Fwd);
        const ihsgFwd = ihsgCandles[d + h].close / ihsgCandles[d].close - 1;
        pairedIhsgDiffs.push(decile10Avg - ihsgFwd);
        const universeFwd = stats.mean(withFwd.map(c => c.fwd));
        pairedUniverseDiffs.push(decile10Avg - universeFwd);
      }
    }

    console.log(`\n--- Horizon: ${h}D ---`);
    console.log('Decile (10=strongest momentum) | avg fwd return | n');
    const decileAvgs = [];
    for (let dec = 10; dec >= 1; dec--) {
      const { sum, n } = decileSums[dec];
      const avg = n > 0 ? sum / n : null;
      decileAvgs.push(avg);
      console.log(`  Decile ${String(dec).padStart(2)}  ${avg != null ? (avg * 100 >= 0 ? '+' : '') + (avg * 100).toFixed(3) + '%' : 'n/a'}`.padEnd(40) + ` n=${n}`);
    }
    // decileAvgs is currently [decile10..decile1]; monotonicity check wants [decile1..decile10] vs rank [1..10]
    const decileAvgsAscending = [...decileAvgs].reverse().filter(v => v != null);
    const decileRanksAscending = Array.from({ length: decileAvgsAscending.length }, (_, k) => k + 1);
    const monotonicityIC = decileAvgsAscending.length >= 3 ? spearmanIC(decileRanksAscending, decileAvgsAscending) : null;

    const meanIC = icValues.length ? stats.mean(icValues) : null;
    const icStdDev = icValues.length ? stats.stdDev(icValues) : null;
    const icIR = (meanIC != null && icStdDev != null && icStdDev > 0) ? meanIC / icStdDev : null;
    const pctPositiveIC = icValues.length ? (icValues.filter(v => v > 0).length / icValues.length) * 100 : null;
    const top10Ret = decileSums[10].n > 0 ? decileSums[10].sum / decileSums[10].n : null;
    const bottom1Ret = decileSums[1].n > 0 ? decileSums[1].sum / decileSums[1].n : null;
    const spread = (top10Ret != null && bottom1Ret != null) ? top10Ret - bottom1Ret : null;
    const afterCost = top10Ret != null ? top10Ret - ROUND_TRIP_COST_PCT / 100 : null;
    const bootCI = bootstrapMeanCI(icValues);

    console.log(`Mean IC: ${meanIC != null ? meanIC.toFixed(4) : 'n/a'}  IC stdDev: ${icStdDev != null ? icStdDev.toFixed(4) : 'n/a'}  IC-IR: ${icIR != null ? icIR.toFixed(3) : 'n/a'}  %dates IC>0: ${pctPositiveIC != null ? pctPositiveIC.toFixed(1) + '%' : 'n/a'}  (n dates=${icValues.length})`);
    console.log(`Decile-10 (top) return: ${top10Ret != null ? (top10Ret * 100).toFixed(3) + '%' : 'n/a'} gross, ${afterCost != null ? (afterCost * 100).toFixed(3) + '%' : 'n/a'} after ${ROUND_TRIP_COST_PCT}% cost`);
    console.log(`Top-minus-bottom decile spread: ${spread != null ? (spread * 100).toFixed(3) + '%' : 'n/a'}`);
    console.log(`Decile-10 vs IHSG (paired same-date diff, mean): ${pairedIhsgDiffs.length ? (stats.mean(pairedIhsgDiffs) * 100).toFixed(3) + '%' : 'n/a'} (n=${pairedIhsgDiffs.length})`);
    console.log(`Decile-10 vs universe average (paired same-date diff, mean): ${pairedUniverseDiffs.length ? (stats.mean(pairedUniverseDiffs) * 100).toFixed(3) + '%' : 'n/a'} (n=${pairedUniverseDiffs.length})`);
    console.log(`Decile-10 turnover (avg fraction of top decile that's new since prior ranked date): ${meanTurnover != null ? (meanTurnover * 100).toFixed(1) + '%' : 'n/a'} (n=${turnoverValues.length})`);
    console.log(`Bootstrap 95% CI on mean IC: ${bootCI.mean != null ? `[${bootCI.lower.toFixed(4)}, ${bootCI.upper.toFixed(4)}], mean=${bootCI.mean.toFixed(4)}` : 'n/a'} (${bootCI.n} dates, ${BOOTSTRAP_RESAMPLES} resamples)`);
    console.log(`Decile-rank monotonicity (Spearman IC of decile-rank vs decile-avg-return): ${monotonicityIC != null ? monotonicityIC.toFixed(4) : 'n/a'}`);

    const isMonotonic = monotonicityIC != null && monotonicityIC > 0.8; // strong, not just positive — see verdict caveat below
    const hasPositiveIC = meanIC != null && meanIC > 0;
    const verdict = (isMonotonic && hasPositiveIC) ? 'PROCEED to layer-decomposition/timing-layer follow-ups' : 'RANKING FORMULA NEEDS REVISITING';
    horizonVerdicts.push({ h, isMonotonic, hasPositiveIC, verdict });
    console.log(`AUTOMATED READ (mechanical gloss on the reviewer's stated rule, NOT a substitute for reading the numbers above): monotonic=${isMonotonic} (decile-rank IC=${monotonicityIC != null ? monotonicityIC.toFixed(3) : 'n/a'}), meanIC>0=${hasPositiveIC} -> ${verdict}`);
  }

  console.log('\n' + '='.repeat(100));
  console.log('COMBINED READ ACROSS ALL HORIZONS (mechanical, see per-horizon caveats above)');
  console.log('='.repeat(100));
  for (const v of horizonVerdicts) console.log(`  ${v.h}D: ${v.verdict}`);

  // ── Audit output — first and last ranked date's decile-10 membership, so
  // the verification steps (cross-check vs EXP-009, forward-return hand-check)
  // need no temporary debug code. ─────────────────────────────────────────
  console.log('\n' + '='.repeat(100));
  console.log('AUDIT — decile-10 membership on the first and last ranked date');
  console.log('='.repeat(100));
  for (const rd of [rankedDates[0], rankedDates[rankedDates.length - 1]]) {
    console.log(`\nDate: ${rd.date} (n eligible=${rd.candidatesToday.length})`);
    for (const c of rd.candidatesToday.filter(c => c.decile === 10)) {
      console.log(`  ${c.ticker.padEnd(6)} compositeScore=${c.compositeScore.toFixed(4)}`);
    }
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
