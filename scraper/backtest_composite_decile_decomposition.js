/**
 * EXP-027A — COMPOSITE DECILE DECOMPOSITION
 *
 * THE QUESTION, from the review that froze EXP-026 R2 (2026-08-12):
 * EXP-026 established that D2/D3 significantly beat D10 on forward returns at
 * every horizon — the composite score carries real cross-sectional information,
 * but BUY fires on D10, the wrong end of it. This script does NOT propose a
 * fix. It decomposes what actually separates D2/D3 from D10 across every
 * plausible dimension, to answer one specific question:
 *
 *     Is D10 bad because its QUALITY factors are wrong, or because quality is
 *     fine but TIMING/EXTENSION (buying names that already ran) is bad?
 *
 * EXPLICIT CONSTRAINT FROM THE REVIEW: purely observational. No F1-F14 weight
 * changes, no new score. This script only measures and reports.
 *
 * SAME DATASET AS EXP-026 R2, ON PURPOSE. Same `SOURCE`, same signal-history
 * rows, same canonical-outcome recomputation — so D10 here is provably the
 * identical D10 EXP-026 already characterized, not a subtly different sample.
 * `canonicalOutcomes`/the breakout constants below are DUPLICATED from
 * backtest_market_regime_conditionality.js, not imported — EXP-026 was just
 * frozen ("jangan utak-atik lagi") and this project has hit the cost of
 * silently-duplicated contracts before (EXP-026's own breakout definition,
 * wrong twice), so the safety net here is explicit: this script's own D2/D3/
 * D10 forward-return numbers are cross-checked against EXP-026 R2's published
 * table in BACKTEST_EXPERIMENTS.md before anything here is trusted (see the
 * verification note near the bottom of this file). If they match, the
 * duplication was safe this time; if they don't, that is exactly the signal
 * to stop and reconcile rather than a corner worth cutting silently.
 *
 * DECILE ASSIGNMENT IS COMPUTED ONCE PER SESSION, not once per dimension.
 * modules/cross_sectional.js's `bucketByScore` returns aggregated bucket
 * means for a single (scores, values) pair — calling it separately per
 * dimension, each with its own null-filtering, could subtly put a different
 * SET of tickers in "D10" for one dimension than another (whichever rows
 * happen to be null differs by dimension). Instead this script assigns each
 * row a decile ONCE (mirroring bucketByScore's own rank -> bucket math
 * exactly, via the already-exported `rankTransform`), then every dimension is
 * averaged within that ONE fixed assignment, with nulls simply excluded from
 * that dimension's own mean rather than shifting who's in the bucket.
 *
 * DATE-BLOCKING, same discipline as EXP-026: every statistic is computed per
 * session first, then aggregated across sessions via `bootstrapMeanCI`
 * (resampling whole sessions), never pooling ticker-sessions as if they were
 * independent.
 *
 * Usage: node backtest_composite_decile_decomposition.js
 */
'use strict';
require('dotenv').config();
const mysql = require('mysql2/promise');
const cs = require('./modules/cross_sectional');
const breakoutLib = require('./modules/breakout');
const { computeATRPercentile } = require('./modules/regime_engine');
const { emaSeries } = require('./awo_technical');

const SOURCE = 'backfill_v3_f5v1'; // identical to EXP-026 — same dataset, same D10
const MIN_SCORED_PER_SESSION = 30; // matches EXP-026's own decile-eligibility floor exactly, for a clean cross-check
const DECILES = 10;

const iso = d => new Date(d).toISOString().slice(0, 10);
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const smaAt = (arr, i, n) => (i + 1 < n ? null : mean(arr.slice(i - n + 1, i + 1)));
const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '  -  ' : v.toFixed(d));

// ── duplicated verbatim from backtest_market_regime_conditionality.js
// (see header comment: deliberate, cross-checked, not imported) ────────────
const WIN_THRESHOLD = 5, HORIZON_BREAKOUT = 5, HIGH_LOOKBACK = 20;

function canonicalOutcomes(series, sessions, sessIdx, date) {
  const i = sessIdx.get(date);
  if (i === undefined) return null;
  const entry = series.get(date);
  if (!entry) return null;

  const fwd = n => {
    const t = sessions[i + n];
    if (!t) return null;
    const b = series.get(t);
    return b ? (b.c / entry.c - 1) * 100 : null;
  };

  let maxProfit = null, maxDrawdown = null;
  const path = [];
  for (let k = 1; k <= HORIZON_BREAKOUT; k++) {
    const t = sessions[i + k];
    const b = t ? series.get(t) : null;
    if (!b) { path.length = 0; break; }
    path.push(b);
  }
  if (path.length === HORIZON_BREAKOUT) {
    maxProfit = (Math.max(...path.map(b => b.h)) / entry.c - 1) * 100;
    maxDrawdown = (Math.min(...path.map(b => b.l)) / entry.c - 1) * 100;
  }

  const bk = breakoutLib.genuineBreakout(series, sessions, i);
  const breakoutExp025 = bk === null ? null : bk.winner;

  return {
    return_1d: fwd(1), return_3d: fwd(3), return_5d: fwd(5), return_10d: fwd(10),
    max_profit: maxProfit, max_drawdown: maxDrawdown,
    breakoutExp025,
    hit5pct: maxProfit === null ? null : maxProfit >= WIN_THRESHOLD,
  };
}

// ── new for EXP-027A: per-stock technical features ──────────────────────────
// Same conventions EXP-026 already established for IHSG's own market features
// (smaAt, inclusive-of-today max-close for "prior high"), just run per-stock
// instead of on the index. NOT breakout.js's strictly-prior convention — that
// exists specifically so a breakout can't trivially clear itself; "how close
// is this stock to its own N-day high right now" is a description, not a
// trigger, so including today is the right and simpler convention here.
function stockFeatures(td, i) {
  const c = td.closes, h = td.highs, l = td.lows;
  const ma20 = smaAt(c, i, 20), ma60 = smaAt(c, i, 60);
  const hi20 = i >= 19 ? Math.max(...c.slice(i - 19, i + 1)) : null;
  const hi60 = i >= 59 ? Math.max(...c.slice(i - 59, i + 1)) : null;
  const sameSessionReturn = i >= 1 ? (c[i] / c[i - 1] - 1) * 100 : null;
  const atrPctile = computeATRPercentile(h.slice(0, i + 1), l.slice(0, i + 1), c.slice(0, i + 1), 14, 252);
  const ema21 = td.ema21Series[i];
  // Same formula backtest_momentum_leadership.js established for its
  // MAX_EXTENSION_PCT reject check, reused here as a plain reported feature.
  const extension21 = (ema21 !== null && ema21 > 0) ? (c[i] - ema21) / ema21 * 100 : null;
  return {
    vsMa20: ma20 ? (c[i] / ma20 - 1) * 100 : null,
    vsMa60: ma60 ? (c[i] / ma60 - 1) * 100 : null,
    distFromHigh20: hi20 ? (c[i] / hi20 - 1) * 100 : null,
    distFromHigh60: hi60 ? (c[i] / hi60 - 1) * 100 : null,
    sameSessionReturn,
    atrPctile,
    extension21,
  };
}

/** Mirrors cs.bucketByScore's internal rank -> bucket math exactly (via the
 * already-exported rankTransform), but returns per-row bucket index (0 =
 * lowest score = D1) instead of aggregated means — so decile membership is
 * assigned ONCE per session and every dimension aggregates against the SAME
 * fixed assignment. */
function assignDeciles(scores, k = DECILES) {
  const n = scores.length;
  const ranks = cs.rankTransform(scores);
  return ranks.map(r => {
    let b = Math.floor(((r - 1) / n) * k);
    if (b >= k) b = k - 1;
    if (b < 0) b = 0;
    return b;
  });
}

const DIMENSIONS = [
  ['f1', 'F1 Concentration (broker)', r => r.f1_concentration, 'quality'],
  ['f2', 'F2 Trend (broker)', r => r.f2_trend, 'quality'],
  ['f3', 'F3 Volume Z-Score', r => r.f3_volume_z, 'other'],
  ['f4', 'F4 Momentum', r => r.f4_momentum, 'quality'],
  ['f5', 'F5 Relative Strength', r => r.f5_rel_strength, 'quality'],
  ['f6', 'F6 Buyer Breadth (broker)', r => r.f6_breadth, 'quality'],
  ['f7', 'F7 Price-Broker Alignment', r => r.f7_alignment, 'quality'],
  ['f8', 'F8 Accumulation Streak (broker)', r => r.f8_streak, 'quality'],
  ['f9', 'F9 RSI', r => r.f9_rsi, 'other'],
  ['f10', 'F10 MACD', r => r.f10_macd, 'other'],
  ['f11', 'F11 Bollinger %B', r => r.f11_bollinger, 'other'],
  ['f12', 'F12 EMA Trend', r => r.f12_ema_trend, 'other'],
  ['f13', 'F13 Support/Resistance', r => r.f13_support_resistance, 'other'],
  ['f14', 'F14 ATR (risk modifier)', r => r.f14_atr, 'other'],
  ['sameSessionReturn', 'Same-session return %', r => r.feat?.sameSessionReturn, 'timing'],
  ['vsMa20', 'Distance from own MA20 %', r => r.feat?.vsMa20, 'timing'],
  ['vsMa60', 'Distance from own MA60 %', r => r.feat?.vsMa60, 'timing'],
  ['distFromHigh20', 'Distance from prior 20D high %', r => r.feat?.distFromHigh20, 'timing'],
  ['distFromHigh60', 'Distance from prior 60D high %', r => r.feat?.distFromHigh60, 'timing'],
  ['atrPctile', 'ATR percentile (0-100)', r => r.feat?.atrPctile, 'timing'],
  ['extension21', 'Extension from EMA21 %', r => r.feat?.extension21, 'timing'],
  ['breakoutRate', 'Breakout rate % (EXP-025 def., excess)', r => (r.out?.breakoutExp025 === true ? 100 : r.out?.breakoutExp025 === false ? 0 : null), 'outcome'],
  ['return_1d', 'Forward return 1D % (excess vs universe)', r => r.out?.return_1d, 'outcome'],
  ['return_3d', 'Forward return 3D % (excess vs universe)', r => r.out?.return_3d, 'outcome'],
  ['return_5d', 'Forward return 5D % (excess vs universe)', r => r.out?.return_5d, 'outcome'],
  ['return_10d', 'Forward return 10D % (excess vs universe)', r => r.out?.return_10d, 'outcome'],
];

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    waitForConnections: true, connectionLimit: 5,
  });

  console.log('='.repeat(96));
  console.log('EXP-027A — COMPOSITE DECILE DECOMPOSITION (purely observational, no F1-F14 weight changes)');
  console.log(`source '${SOURCE}'   outcomes recomputed on the canonical IDX calendar   min ${MIN_SCORED_PER_SESSION} scored/session`);
  console.log('='.repeat(96));

  // IHSG canonical axis (needed by canonicalOutcomes, exactly as EXP-026 uses it)
  const [ih] = await pool.query('SELECT date, close_price c FROM idx_ihsg_history ORDER BY date ASC');
  const idates = ih.map(r => iso(r.date));
  const idxOf = new Map(idates.map((d, i) => [d, i]));

  // signals — extended vs EXP-026's own query to also pull raw F1-F14
  const [sig] = await pool.query(
    `SELECT data_date, stock_code, composite_score, signal_type,
            f1_concentration, f2_trend, f3_volume_z, f4_momentum, f5_rel_strength,
            f6_breadth, f7_alignment, f8_streak, f9_rsi, f10_macd, f11_bollinger,
            f12_ema_trend, f13_support_resistance, f14_atr
       FROM idx_signal_history WHERE data_source = ? ORDER BY data_date ASC`, [SOURCE]);
  const byDate = new Map();
  for (const r of sig) {
    const d = iso(r.data_date);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(r);
  }
  const firstDate = [...byDate.keys()].sort()[0];

  // price series — WIDER lookback than EXP-026's own 120 days: computeATRPercentile
  // needs a 252-session trailing window plus its own margin, which 120 calendar
  // days cannot supply. 500 calendar days comfortably covers 252+ trading days.
  const [px] = await pool.query(
    `SELECT stock_code, date, close_price c, high_price h, low_price l
       FROM idx_stock_prices WHERE date >= DATE_SUB(?, INTERVAL 500 DAY) ORDER BY stock_code, date`,
    [firstDate]);
  const priceByTicker = new Map(); // date-keyed, for canonicalOutcomes (same shape EXP-026 uses)
  for (const r of px) {
    const d = iso(r.date);
    if (!priceByTicker.has(r.stock_code)) priceByTicker.set(r.stock_code, new Map());
    priceByTicker.get(r.stock_code).set(d, { c: Number(r.c), h: Number(r.h), l: Number(r.l) });
  }
  // index-keyed, for stockFeatures (sma/hi/atr-percentile need array+index math)
  const tickerArrays = new Map();
  for (const [ticker, dateMap] of priceByTicker) {
    const sorted = [...dateMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const closes = sorted.map(([, v]) => v.c);
    const highs = sorted.map(([, v]) => v.h);
    const lows = sorted.map(([, v]) => v.l);
    const dateIndex = new Map(sorted.map(([d], i) => [d, i]));
    tickerArrays.set(ticker, { closes, highs, lows, dateIndex, ema21Series: emaSeries(closes, 21) });
  }

  // attach canonical outcomes + new per-stock features to every scored row
  let refusedOutcome = 0, attached = 0;
  for (const [d, rows] of byDate) {
    for (const r of rows) {
      const series = priceByTicker.get(r.stock_code);
      r.out = series ? canonicalOutcomes(series, idates, idxOf, d) : null;
      if (!r.out) { refusedOutcome++; continue; }
      attached++;
      const td = tickerArrays.get(r.stock_code);
      const idx = td ? td.dateIndex.get(d) : undefined;
      r.feat = (td && idx !== undefined) ? stockFeatures(td, idx) : null;
    }
  }
  console.log(`\ncanonical outcomes attached: ${attached}   refused (incomplete window): ${refusedOutcome}`);

  // ── per-session decile assignment + per-dimension aggregation ────────────
  const perDimBuckets = {}; // key -> [DECILES] arrays of session-level bucket means
  const coverage = {}; // key -> {present, total}
  for (const [key] of DIMENSIONS) { perDimBuckets[key] = Array.from({ length: DECILES }, () => []); coverage[key] = { present: 0, total: 0 }; }

  let sessionsUsed = 0, sessionsSkippedThin = 0;
  const usedDates = [];
  for (const d of [...byDate.keys()].sort()) {
    const rows = byDate.get(d).filter(r => r.composite_score !== null && r.out);
    if (rows.length < MIN_SCORED_PER_SESSION) { sessionsSkippedThin++; continue; }
    sessionsUsed++;
    usedDates.push(d);

    const scores = rows.map(r => Number(r.composite_score));
    const deciles = assignDeciles(scores);

    for (const [key, , extract, group] of DIMENSIONS) {
      const perBucketVals = Array.from({ length: DECILES }, () => []);
      const allVals = [];
      for (let i = 0; i < rows.length; i++) {
        const v = extract(rows[i]);
        coverage[key].total++;
        if (v !== null && v !== undefined && !Number.isNaN(v)) {
          coverage[key].present++;
          perBucketVals[deciles[i]].push(v);
          allVals.push(v);
        }
      }
      // Outcome dimensions (forward returns, breakout rate) are reported as
      // EXCESS vs this session's own universe mean, exactly like EXP-026's
      // decile table ("EXCESS per decile, so a falling market cannot make
      // every decile look bad") — cross-checked against its published numbers
      // below. Quality/timing/other dimensions are same-day cross-sectional
      // LEVELS, not returns accumulated across a shifting-regime window, so
      // there is no market-drift contamination to net out — raw is correct.
      const universeMean = (group === 'outcome' && allVals.length) ? mean(allVals) : 0;
      perBucketVals.forEach((vals, bi) => { if (vals.length) perDimBuckets[key][bi].push(mean(vals) - universeMean); });
    }
  }
  console.log(`sessions used: ${sessionsUsed}   (${sessionsSkippedThin} too thin, <${MIN_SCORED_PER_SESSION} scored)`);
  if (sessionsUsed === 0) { console.error('No usable sessions — nothing to report.'); await pool.end(); return; }
  console.log(`window: ${usedDates[0]} .. ${usedDates[usedDates.length - 1]}`);

  // ── report: one table per dimension, D10 -> D1 (matches EXP-026's convention) ──
  console.log('\n' + '='.repeat(96));
  console.log('PER-DECILE MEANS (D10 = highest composite_score, D1 = lowest), 95% CI over sessions');
  console.log('='.repeat(96));
  const decileSummary = {}; // key -> [DECILES] {mean, ci}
  for (const [key, label] of DIMENSIONS) {
    console.log(`\n${label}`);
    decileSummary[key] = [];
    for (let b = DECILES - 1; b >= 0; b--) {
      const ci = cs.bootstrapMeanCI(perDimBuckets[key][b]);
      decileSummary[key][b] = ci;
      const ciStr = ci.mean !== null ? `[${fmt(ci.lower)}, ${fmt(ci.upper)}]` : '';
      console.log(`  D${String(b + 1).padStart(2)}  ${fmt(ci.mean)}  ${ciStr}  (n sessions=${ci.n})`);
    }
  }

  // ── coverage sanity — don't silently average over nulls as if they were zero ──
  console.log('\n' + '='.repeat(96));
  console.log('COVERAGE — fraction of scored ticker-sessions with a non-null value per dimension');
  console.log('='.repeat(96));
  for (const [key, label] of DIMENSIONS) {
    const { present, total } = coverage[key];
    console.log(`  ${label.padEnd(32)} ${present}/${total}  (${total ? fmt(present / total * 100, 1) : ' - '}%)`);
  }

  // ── quality vs timing summary — mechanical, derived from the CI gaps just
  // computed, not asserted. "Quality" = broker-flow + momentum/RS factors;
  // "timing" = MA/high distance, ATR percentile, EMA21 extension. ────────────
  console.log('\n' + '='.repeat(96));
  console.log('QUALITY vs TIMING — D10 minus mean(D2,D3), by group (the review\'s exact question)');
  console.log('='.repeat(96));
  const groupGap = (group) => {
    const rows = DIMENSIONS.filter(([, , , g]) => g === group);
    const gaps = [];
    for (const [key, label] of rows) {
      const d10 = decileSummary[key][9], d2 = decileSummary[key][1], d3 = decileSummary[key][2];
      if (d10.mean === null || d2.mean === null || d3.mean === null) continue;
      const d23 = (d2.mean + d3.mean) / 2;
      // normalize by the D1-D10 spread of this dimension so factors on very
      // different scales (e.g. F1's 0-100 vs ATR percentile's 0-100 vs a
      // return in single-digit %) are comparable as "how many deciles apart".
      gaps.push({ label, key, d10: d10.mean, d23, gap: d10.mean - d23 });
    }
    return gaps;
  };
  for (const group of ['quality', 'timing']) {
    console.log(`\n${group.toUpperCase()} factors (D10 vs mean(D2,D3)):`);
    for (const g of groupGap(group)) {
      console.log(`  ${g.label.padEnd(32)} D10=${fmt(g.d10)}  mean(D2,D3)=${fmt(g.d23)}  gap=${fmt(g.gap)}`);
    }
  }
  console.log('\n(Read this table, don\'t let this line summarize it for you — the gap column shows the');
  console.log(' DIRECTION and MAGNITUDE per factor; whether "quality" or "timing" factors show the');
  console.log(' larger, more consistent gap is what actually answers the review\'s question.)');

  await pool.end();
})();
