/**
 * Momentum Leadership + Breakout (Setup A) — Standalone Backtest.
 *
 * External review (2026-08-01, on top of this project's own
 * BACKTEST_EXPERIMENTS.md registry): AWO Full's 14-factor composite is
 * consistently negative-expectancy, underperforming technical-only, EMA9/21
 * crossover, and even random entry, on two separate periods. Recommendation
 * (approved by the project owner): stop optimizing AWO Full's weights and
 * instead test a new, evidence-backed strategy — cross-sectional Momentum
 * Leadership with a Breakout entry — directly supported by this project's
 * own per-factor ablation (F4 Momentum most valuable; F12/F3/F5/F10 also
 * helpful; F9/F11/F6/F7 drags; HIGH_VOLATILITY periods -0.633R / PF 0.16,
 * see EXP-2026-07-30-008) plus momentum/trend-following literature the
 * reviewer cited.
 *
 * SCOPE (explicitly agreed): standalone backtest script only. No live
 * scoring wiring, no new DB tables, no API/UI changes — prove whether this
 * has real out-of-sample edge before touching anything live, matching this
 * project's own established discipline (AWO Full itself has never been
 * promoted precisely because it never cleared that bar). Setup B (Pullback)
 * is an explicit future follow-up, not built here.
 *
 * Universe: BIG_CAP_100 (already turnover-ranked — matches the reviewer's
 * "top 50-100 most liquid" guidance), filtered per-date to >=260 trailing
 * bars. Sector/suspension/corporate-action data does not exist anywhere in
 * this schema — accepted, honestly-documented gap for this pass.
 *
 * Cross-sectional ranking, computed per canonical trading date (IHSG's own
 * calendar): 30% RS-6m vs IHSG + 25% RS-3m vs IHSG + 20% 52-week-high
 * proximity + 10% EMA50 slope + 10% volume Z-score + 5% MACD histogram
 * normalized by ATR — each percentile-ranked within that date's eligible
 * set before weighting (reviewer's own baseline hypothesis, deliberately
 * not optimized). Top 10% AND top 15% cutoffs both tested.
 *
 * Setup A trigger (both N=20 and N=55 day breakout lookback tested):
 * close > EMA50 > EMA200, positive EMA50 slope, near 52w high, close breaks
 * above the N-day high (strictly prior bars), volume-Z confirmation, strong
 * close-in-range, no excessive gap. Rejects: extreme ATR percentile, large
 * upper wick, over-extension from EMA21, risk:reward < 1.5 (via
 * computeTradePlan), and — reusing EXP-2026-07-30-008's own finding on an
 * apples-to-apples basis (same stock-level `detectPriceRegime` input that
 * experiment used) — HIGH_VOLATILITY regime. IHSG in a confirmed downtrend
 * skips the whole date (reviewer's "market condition" gate).
 *
 * Trade simulation via awo_optimizer.js's `evaluateCandidateOutcome`
 * (exported for this reuse) — same T+1 entry, ATR/SR-based stop/target,
 * 15-bar max hold, 0.50% round-trip cost as every other simulation in this
 * project. Baselines: seeded Random Entry (exact-count rate-matched via
 * mulberry32, also imported), EMA9/21 crossover (simple, no strategy
 * filters applied — its entire point as a baseline is being the dumbest
 * plausible trend rule). Buy & Hold reported separately (no stop/exit
 * concept, would be misleading mixed into the same R-multiple table).
 *
 * No writes to any table — pure read + console report. Safe to rerun.
 * Usage: node backtest_momentum_leadership.js
 */

'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const stats = require('./modules/statistics');
const { emaSeries, calcSupportResistance, computeTradePlan } = require('./awo_technical');
const { detectPriceRegime, computeATRPercentile } = require('./modules/regime_engine');
const { BIG_CAP_100 } = require('./modules/tickers');
const { evaluateCandidateOutcome, mulberry32 } = require('./awo_optimizer');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

// ── Strategy constants — first-pass judgment calls per the reviewer's own
// "start with a small range, don't optimize everything at once" guidance.
// Single values, not a grid; the whole point of this backtest is to produce
// real evidence to revisit these with, not to tune them blind. ──────────────
const MIN_HISTORY_BARS = 260;        // existing project-wide "enough history" convention
const RS_6M_BARS = 126;              // ~6 trading months
const RS_3M_BARS = 63;               // ~3 trading months
const HIGH_52W_BARS = 252;           // ~1 trading year, includes today
const EMA50_SLOPE_LOOKBACK = 10;     // bars
const VOL_Z_WINDOW = 20;             // bars, includes today
const MIN_ELIGIBLE_PER_DAY = 20;     // degenerate-day floor for cross-sectional ranking
const RANK_CUTOFFS = [0.10, 0.15];   // reviewer's "10% or 15%?" — test both
const BREAKOUT_LOOKBACKS = [20, 55]; // reviewer's "20D or 55D?" — test both
const PROX_52W_MIN = 0.90;           // candidate filter: close >= 90% of trailing 252d high
const VOL_Z_MIN = 1.5;               // trigger: breakout-day volume Z-score floor
const CLOSE_POS_MIN = 0.6;           // trigger: (close-low)/(high-low) floor
const MAX_GAP_PCT = 0.03;            // trigger: open vs resistance level, max gap
const MAX_UPPER_WICK_PCT = 0.4;      // reject: upper wick as fraction of day range
const ATR_PCTILE_MAX = 90;           // reject: ATR percentile ceiling (matches regime_engine's own default)
const MAX_EXTENSION_PCT = 0.08;      // reject: close vs EMA21, max extension
const MIN_RR = 1.5;                  // reject: computeTradePlan's own riskReward floor
const SIGNAL_COOLDOWN_DAYS = 15;     // matches awo_optimizer.js's OUTCOME_MAX_HOLD — avoid
                                      // pyramiding a new signal into an already-open position
const RANDOM_SEED = 42;              // same convention as backtest_baseline_comparison.js

function toDateStr(d) {
  return d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0];
}

// ── Pure series-builders, mirroring awo_technical.js's calcATR/calcMACD math
// exactly but returning a full indexed array instead of one final value —
// needed so Pass 2 can read "ATR/MACD as of day i" for every ticker/day in
// O(1) instead of recomputing from scratch (O(n)) at every (ticker,date)
// pair, which would be O(n^2) per ticker across ~100 tickers x ~2 years. ──

/** Mirrors calcATR's Wilder-smoothing loop exactly; series[k] === what
 * calcATR(highs.slice(0,k+1), lows.slice(0,k+1), closes.slice(0,k+1)) would
 * return, for every valid k, in one O(n) pass. */
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

/** Mirrors calcMACD's fastSeries/slowSeries/signal-of-compacted-history math
 * exactly, as a full histogram series instead of one final value. */
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

/** Walk backward from `dateIdxCanonical` through the canonical date axis (up
 * to `toleranceDays` steps) to find this ticker's nearest available close —
 * date-anchored, not raw-array-offset-anchored, so a single stock's own data
 * gaps can't silently misalign it against IHSG's calendar. */
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

/** Percentile-rank (0..1) each candidate's `field` value within `arr` —
 * cross-sectional normalization for the composite ranking. Bounded and
 * outlier-robust, deliberately simpler than z-score for a first-pass
 * baseline (reviewer: "hanya baseline hipotesis, jangan langsung dioptimalkan"). */
function pctRankInPlace(arr, field) {
  const sorted = [...arr].sort((a, b) => a[field] - b[field]);
  const n = sorted.length;
  sorted.forEach((c, idx) => { c[`${field}_pct`] = n > 1 ? idx / (n - 1) : 0.5; });
}

/**
 * Setup A trigger/reject evaluation for one (ticker, day) candidate.
 * All windows either strictly precede bar `i` or, where they legitimately
 * include bar `i` itself (the breakout bar's own close/high/low/volume —
 * the actual event being detected), that inclusion is intentional.
 */
function evaluateSetupATrigger(td, i, N) {
  const c = td.candles[i];
  const ema50 = td.ema50Series[i], ema200 = td.ema200Series[i], ema21 = td.ema21Series[i];
  if (ema50 == null || ema200 == null || ema21 == null) return { fire: false, reason: 'MISSING_EMA' };
  if (!(c.close > ema50 && ema50 > ema200)) return { fire: false, reason: 'TREND_STACK' };

  const ema50Past = td.ema50Series[i - EMA50_SLOPE_LOOKBACK];
  if (ema50Past == null || !(ema50Past > 0)) return { fire: false, reason: 'MISSING_EMA_SLOPE' };
  if (!((ema50 - ema50Past) / ema50Past > 0)) return { fire: false, reason: 'EMA50_SLOPE_FLAT_OR_DOWN' };

  const high252 = maxOverWindow(td.highs, i, HIGH_52W_BARS);
  if (high252 == null || !(high252 > 0)) return { fire: false, reason: 'MISSING_52W_HIGH' };
  if (!(c.close / high252 >= PROX_52W_MIN)) return { fire: false, reason: 'NOT_NEAR_52W_HIGH' };

  if (i - N < 0) return { fire: false, reason: 'INSUFFICIENT_BREAKOUT_WINDOW' };
  const resistance = maxOverWindow(td.highs, i - 1, N); // strictly prior N bars, excludes i
  if (resistance == null || !(c.close > resistance)) return { fire: false, reason: 'NO_BREAKOUT' };

  const volWindow = td.volumes.slice(Math.max(0, i - VOL_Z_WINDOW + 1), i + 1);
  if (!(stats.zScoreFromArray(volWindow) >= VOL_Z_MIN)) return { fire: false, reason: 'NO_VOLUME_CONFIRMATION' };

  const range = c.high - c.low;
  const closePos = range > 0 ? (c.close - c.low) / range : 0.5;
  if (!(closePos >= CLOSE_POS_MIN)) return { fire: false, reason: 'WEAK_CLOSE_IN_RANGE' };

  const gapPct = resistance > 0 ? (c.open - resistance) / resistance : 0;
  if (gapPct > MAX_GAP_PCT) return { fire: false, reason: 'EXCESSIVE_GAP' };

  const upperWickPct = range > 0 ? (c.high - Math.max(c.open, c.close)) / range : 0;
  if (upperWickPct > MAX_UPPER_WICK_PCT) return { fire: false, reason: 'LARGE_UPPER_WICK' };

  const extendedPct = ema21 > 0 ? (c.close - ema21) / ema21 : 0;
  if (extendedPct > MAX_EXTENSION_PCT) return { fire: false, reason: 'TOO_EXTENDED_FROM_EMA21' };

  const highsUpTo = td.highs.slice(0, i + 1), lowsUpTo = td.lows.slice(0, i + 1), closesUpTo = td.closes.slice(0, i + 1);
  const atrPctile = computeATRPercentile(highsUpTo, lowsUpTo, closesUpTo, 14, 252);
  if (atrPctile != null && atrPctile > ATR_PCTILE_MAX) return { fire: false, reason: 'EXTREME_VOLATILITY_ATR' };

  const srNow = calcSupportResistance(highsUpTo, lowsUpTo, closesUpTo, 20);
  const plan = computeTradePlan(c.close, 'BUY', td.atrSeries[i], srNow);
  if (!plan || !(plan.riskReward >= MIN_RR)) return { fire: false, reason: 'POOR_RISK_REWARD' };

  // Reuses EXP-2026-07-30-008's own finding (HIGH_VOLATILITY -> -0.633R,
  // PF 0.16) on an apples-to-apples basis — same stock-level candles input
  // (`windowCandles.slice(-280)`) that experiment used, confirmed via
  // backtest_regime_gate_shadow.js:190.
  const regime = detectPriceRegime(td.candles.slice(0, i + 1).slice(-280));
  if (regime.regime === 'HIGH_VOLATILITY') return { fire: false, reason: 'HIGH_VOLATILITY_REGIME' };

  return { fire: true, reason: null };
}

function metrics(rawOutcomes) {
  const unresolved = rawOutcomes.filter(t => t.result === null).length;
  const trades = rawOutcomes.filter(t => t.result !== null);
  if (!trades.length) return { n: 0, unresolved };
  const netRs = trades.map(t => t.netR);
  const wins = netRs.filter(r => r > 0);
  const losses = netRs.filter(r => r <= 0);
  const winRate = wins.length / trades.length;
  const avgWin = wins.length ? stats.mean(wins) : 0;
  const avgLoss = losses.length ? Math.abs(stats.mean(losses)) : 0;
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;
  const grossProfit = wins.reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  const avgHold = stats.mean(trades.map(t => t.holdDays).filter(h => h != null));
  const sorted = [...trades].sort((a, b) => (a.date < b.date ? -1 : 1));
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of sorted) { cum += t.netR; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
  return { n: trades.length, unresolved, winRate: winRate * 100, avgWin, avgLoss, expectancy, profitFactor, maxDrawdownR: maxDD, avgHold };
}

function printRow(label, m) {
  if (!m || m.n === 0) { console.log(`${label.padEnd(20)} n=0 (no resolved trades${m?.unresolved ? `, ${m.unresolved} unresolved` : ''})`); return; }
  console.log(
    `${label.padEnd(20)} n=${String(m.n).padEnd(5)} winRate=${m.winRate.toFixed(1)}%`.padEnd(44) +
    ` expectancy=${m.expectancy >= 0 ? '+' : ''}${m.expectancy.toFixed(3)}R  profitFactor=${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : 'inf'}  maxDD=${m.maxDrawdownR.toFixed(2)}R  avgHold=${m.avgHold.toFixed(1)}d  [${m.unresolved} unresolved, excluded]`
  );
}

async function main() {
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  console.log('Loading universe (BIG_CAP_100) + price history...');
  const tickerData = new Map(); // ticker -> { candles, dateIndex, highs, lows, closes, volumes, ema9/21/50/200Series, atrSeries, macdHistSeries }
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
      ema9Series: emaSeries(closes, 9),
      ema21Series: emaSeries(closes, 21),
      ema50Series: emaSeries(closes, 50),
      ema200Series: emaSeries(closes, 200),
      atrSeries: buildAtrSeries(highs, lows, closes, 14),
      macdHistSeries: buildMacdHistogramSeries(closes, 12, 26, 9),
    });
  }
  console.log(`Universe: ${tickerData.size}/${BIG_CAP_100.length} tickers meet the >=${MIN_HISTORY_BARS}-bar history gate.`);

  const [ihsgRows] = await pool.query(`SELECT date, open_price o, high_price h, low_price l, close_price c FROM idx_ihsg_history ORDER BY date ASC`);
  const ihsgCandles = ihsgRows.map(r => ({ date: toDateStr(r.date), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c) }));
  const tradingDates = ihsgCandles.map(c => c.date); // canonical axis — dateIdxCanonical === index into ihsgCandles
  console.log(`Canonical trading dates (IHSG calendar): ${tradingDates.length}`);

  const WARMUP = 260; // covers 260-bar per-ticker gate, 252-bar 52w-high, 126-bar RS6m, 210-bar regime minCandles
  const signalEvents = {}; // variantKey -> [{ticker, date, i}]
  for (const cutoff of RANK_CUTOFFS) for (const N of BREAKOUT_LOOKBACKS) signalEvents[`M${N}_top${Math.round(cutoff * 100)}`] = [];
  const emaCrossEvents = [];
  const allEligiblePairs = []; // for Random Entry rate-matching
  const rejectTally = {};
  const eligibleCountByDate = [];
  let datesSkippedIhsgDowntrend = 0, datesSkippedTooFewEligible = 0, datesRanked = 0;
  const lastSignalCanonicalIdx = new Map(); // `${ticker}|${variantKey}` -> dateIdxCanonical

  console.log('Running cross-sectional ranking + Setup A signal generation (this can take a minute)...');
  for (let d = WARMUP; d < tradingDates.length; d++) {
    const date = tradingDates[d];

    const ihsgRegime = detectPriceRegime(ihsgCandles.slice(0, d + 1).slice(-280));
    if (ihsgRegime.regime === 'TREND_DOWN') { datesSkippedIhsgDowntrend++; continue; }

    const candidatesToday = [];
    for (const [ticker, td] of tickerData) {
      const i = td.dateIndex.get(date);
      if (i === undefined || i < MIN_HISTORY_BARS - 1) continue;
      if (td.volumes[i] === 0) continue; // defensive halted/zombie-row skip — confirmed real in production data

      const rs6m = rsVsIhsg(td, ihsgCandles, tradingDates, d, RS_6M_BARS);
      const rs3m = rsVsIhsg(td, ihsgCandles, tradingDates, d, RS_3M_BARS);
      const high252 = maxOverWindow(td.highs, i, HIGH_52W_BARS);
      const ema50 = td.ema50Series[i], ema50Past = td.ema50Series[i - EMA50_SLOPE_LOOKBACK];
      const ema50Slope = (ema50 != null && ema50Past != null && ema50Past > 0) ? (ema50 - ema50Past) / ema50Past : null;
      const volZ = stats.zScoreFromArray(td.volumes.slice(Math.max(0, i - VOL_Z_WINDOW + 1), i + 1));
      const atrHere = td.atrSeries[i], macdHere = td.macdHistSeries[i];
      const macdNorm = (atrHere != null && atrHere > 0 && macdHere != null) ? macdHere / atrHere : null;

      if (rs6m == null || rs3m == null || high252 == null || !(high252 > 0) || ema50Slope == null || macdNorm == null) continue;

      allEligiblePairs.push({ ticker, i, date });
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

    for (const cutoff of RANK_CUTOFFS) {
      const topN = candidatesToday.slice(0, Math.max(1, Math.ceil(candidatesToday.length * cutoff)));
      for (const N of BREAKOUT_LOOKBACKS) {
        const variantKey = `M${N}_top${Math.round(cutoff * 100)}`;
        for (const cand of topN) {
          const td = tickerData.get(cand.ticker);
          const cooldownKey = `${cand.ticker}|${variantKey}`;
          const lastD = lastSignalCanonicalIdx.get(cooldownKey);
          if (lastD !== undefined && d - lastD < SIGNAL_COOLDOWN_DAYS) {
            rejectTally.COOLDOWN_ACTIVE = (rejectTally.COOLDOWN_ACTIVE || 0) + 1;
            continue;
          }
          const verdict = evaluateSetupATrigger(td, cand.i, N);
          if (verdict.fire) {
            signalEvents[variantKey].push({ ticker: cand.ticker, date, i: cand.i });
            lastSignalCanonicalIdx.set(cooldownKey, d);
          } else {
            rejectTally[verdict.reason] = (rejectTally[verdict.reason] || 0) + 1;
          }
        }
      }
    }
  }

  // ── EMA9/21 crossover baseline — deliberately no strategy filters applied;
  // its entire point as a baseline is being the simplest plausible trend
  // rule, same convention as backtest_baseline_comparison.js's Baseline C. ──
  for (const [ticker, td] of tickerData) {
    let prevEma9 = null, prevEma21 = null;
    for (let i = MIN_HISTORY_BARS - 1; i < td.candles.length; i++) {
      const ema9 = td.ema9Series[i], ema21 = td.ema21Series[i];
      if (prevEma9 !== null && prevEma21 !== null && ema9 != null && ema21 != null) {
        if (prevEma9 <= prevEma21 && ema9 > ema21) {
          const cooldownKey = `${ticker}|EMA9_21`;
          const lastI = lastSignalCanonicalIdx.get(cooldownKey);
          if (lastI === undefined || i - lastI >= SIGNAL_COOLDOWN_DAYS) {
            emaCrossEvents.push({ ticker, date: td.candles[i].date, i });
            lastSignalCanonicalIdx.set(cooldownKey, i);
          }
        }
      }
      prevEma9 = ema9; prevEma21 = ema21;
    }
  }

  // ── Random Entry baseline — exact-count rate-matched (not probabilistic
  // threshold): seeded Fisher-Yates partial shuffle over every eligible
  // (ticker,day) pair the momentum strategy actually had available, sampling
  // exactly as many as the largest momentum variant fired. More precisely
  // matched than a probability-threshold approach, still fully reproducible
  // via the same seeded PRNG convention used elsewhere in this project. ────
  const maxVariantCount = Math.max(1, ...Object.values(signalEvents).map(arr => arr.length));
  const rng = mulberry32(RANDOM_SEED);
  const shuffled = [...allEligiblePairs];
  const sampleSize = Math.min(maxVariantCount, shuffled.length);
  for (let i = shuffled.length - 1; i > shuffled.length - 1 - sampleSize && i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const randomEvents = shuffled.slice(shuffled.length - sampleSize);

  // ── Resolve every signal (momentum variants + EMA9/21 + Random) via the
  // SAME evaluateCandidateOutcome every other simulation in this project
  // uses — T+1 entry, ATR/SR stop/target, 15-bar hold, 0.50% cost. ────────
  function resolveAll(events) {
    return events.map(e => {
      const td = tickerData.get(e.ticker);
      const outcome = evaluateCandidateOutcome({ signalType: 'BUY', candles: td.candles, signalIdx: e.i });
      return { ...outcome, date: e.date, ticker: e.ticker };
    });
  }

  console.log('\n' + '='.repeat(100));
  console.log('MOMENTUM LEADERSHIP + BREAKOUT (Setup A) vs. baselines');
  console.log(`Universe: ${tickerData.size} tickers (BIG_CAP_100, >=${MIN_HISTORY_BARS} bars). Dates ranked: ${datesRanked} (skipped: ${datesSkippedIhsgDowntrend} IHSG downtrend, ${datesSkippedTooFewEligible} too few eligible).`);
  console.log('='.repeat(100));

  for (const cutoff of RANK_CUTOFFS) {
    for (const N of BREAKOUT_LOOKBACKS) {
      const key = `M${N}_top${Math.round(cutoff * 100)}`;
      printRow(`Momentum ${N}D top${Math.round(cutoff * 100)}%`, metrics(resolveAll(signalEvents[key])));
    }
  }
  printRow('Random Entry', metrics(resolveAll(randomEvents)));
  printRow('EMA9/21 Crossover', metrics(resolveAll(emaCrossEvents)));

  console.log('\n' + '='.repeat(100));
  console.log('PASSIVE BENCHMARK — Buy & Hold (no stop/target/R-multiple concept, reported separately)');
  console.log('='.repeat(100));
  const buyHoldReturns = [];
  for (const [, td] of tickerData) {
    const startI = MIN_HISTORY_BARS - 1;
    const endI = td.candles.length - 1;
    if (endI > startI) buyHoldReturns.push((td.candles[endI].close / td.candles[startI].close - 1) * 100);
  }
  console.log(`Buy & Hold, avg across ${buyHoldReturns.length} tickers, from each ticker's ${MIN_HISTORY_BARS}th bar to its last available bar: ${stats.mean(buyHoldReturns) >= 0 ? '+' : ''}${stats.mean(buyHoldReturns).toFixed(2)}%`);

  console.log('\n' + '='.repeat(100));
  console.log('DIAGNOSTICS — sanity-check the filter/trigger isn\'t silently collapsing or never firing');
  console.log('='.repeat(100));
  const sortedCounts = [...eligibleCountByDate].sort((a, b) => a - b);
  console.log(`Eligible-tickers-per-date: min=${sortedCounts[0]}, median=${sortedCounts[Math.floor(sortedCounts.length / 2)]}, max=${sortedCounts[sortedCounts.length - 1]}`);
  console.log('Reject-reason tally (Setup A candidate evaluations that did NOT fire):');
  const totalRejects = Object.values(rejectTally).reduce((a, b) => a + b, 0);
  for (const [reason, count] of Object.entries(rejectTally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(28)} ${String(count).padStart(6)}  (${((count / totalRejects) * 100).toFixed(1)}%)`);
  }
  const variantCounts = Object.fromEntries(Object.entries(signalEvents).map(([k, v]) => [k, v.length]));
  console.log(`Total fired signals — Momentum variants: ${JSON.stringify(variantCounts)}`);
  console.log(`Random Entry: ${randomEvents.length}, EMA9/21: ${emaCrossEvents.length}`);

  console.log('\nIndividual momentum signals (for manual audit — sample sizes are small enough to eyeball every one):');
  for (const [key, events] of Object.entries(signalEvents)) {
    for (const e of events) console.log(`  ${key.padEnd(12)} ${e.ticker.padEnd(6)} ${e.date}`);
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
