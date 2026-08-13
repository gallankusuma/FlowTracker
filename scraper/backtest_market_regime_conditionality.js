/**
 * EXP-026 — MARKET REGIME CONDITIONALITY
 *
 * THE QUESTION, from the 2026-08-11 review round:
 *
 *     "How much does Signal Scanner performance depend on the state of IHSG?"
 *
 * and explicitly NOT "which regime rule is good". The review is clear that
 * picking `IHSG < MA20 = RISK_OFF` up front would be deciding the answer before
 * measuring it, so nothing here proposes a gate. This script measures how the
 * EXISTING scanner behaves conditional on market state, and stops there.
 *
 * WHY THIS COMES BEFORE THE OOS PRECURSOR TEST. EXP-025 described a
 * pre-breakout signature (Momentum/RS/Trend high, Buyer Breadth LOW) in-sample.
 * The review's argument is that any such signature still lives inside some
 * market environment, and that the scanner today answers "which stock is
 * relatively strong?" while the thing being asked of it is "is a long worth
 * taking?". Those are different questions and this experiment is built to keep
 * them apart.
 *
 * THE MEASUREMENT THAT SEPARATES THEM, and it is the point of the whole script:
 *
 *   ABSOLUTE       mean forward return of BUY signals in a regime.
 *                  Answers "would a long have made money here".
 *   BUY - UNIVERSE the same, minus the mean forward return of every scored stock
 *                  in that same session. Answers "did the scanner PICK well
 *                  here" against an EQUAL-WEIGHT basket of what it could have
 *                  picked from.
 *   BUY - IHSG     the same, minus the index's own forward return.
 *
 * The middle one is NOT alpha and is deliberately no longer described as "the
 * market's move removed" (review P2, fair catch): IHSG is capitalisation-
 * weighted and this is equal-weight, no beta is estimated, and in a window where
 * large caps and the average name diverge the two disagree. Both are reported so
 * the difference is visible rather than assumed away.
 *
 * If BUY - UNIVERSE stays positive across regimes while ABSOLUTE goes negative in the
 * bad ones, the review's hypothesis is confirmed in the precise form it was
 * stated: the stock engine is not broken, the market-permission layer is
 * missing. If EXCESS collapses too, that is a different and more serious
 * finding about the engine, and it must not be reported as the first one.
 *
 * DATE-BLOCKING IS NOT OPTIONAL HERE. Every stock in a session shares that
 * session's regime, so 27,719 scored rows are not 27,719 independent
 * observations of a regime effect — they are 121. Every statistic below is
 * computed per session first and aggregated across sessions, and every CI comes
 * from resampling whole sessions (`bootstrapMeanCI`). This is the same
 * correction EXP-025 needed when its "1,236 winner observations" turned out to
 * be 100 sessions.
 *
 * Usage:  node backtest_market_regime_conditionality.js [--horizon 5] [--json out.json]
 */
'use strict';
require('dotenv').config();
const mysql = require('mysql2/promise');
const cs = require('./modules/cross_sectional');
const { BENCHMARK_TICKERS, BENCHMARK_UNIVERSE_VERSION } = require('./modules/benchmark_universe');
const breakoutLib = require('./modules/breakout');

/**
 * THE MARKET-BREADTH UNIVERSE — known and versioned, not "whatever is in the
 * price table" (review round 2, P1).
 *
 * R1 computed breadth by iterating `priceByTicker.values()`, i.e. every ticker
 * that happened to have rows in `idx_stock_prices`. On today's data that gives
 * 253 − 8 incomplete = 245, which is exactly the scored universe — and that
 * coincidence is the whole problem. It is right by accident of what the table
 * contains today, not by construction. A new listing, a historical backfill, a
 * restored delisting or one more fully-populated series and breadth silently
 * becomes 246 or 247 with no model or version change to show for it.
 *
 * This is the F5 lesson exactly, and modules/benchmark_universe.js was written
 * because of it: "the answer only means anything if 'the market' means the same
 * thing every time it is asked." Breadth is a market-wide measurement and needs
 * the same guarantee.
 *
 * DELIBERATELY DERIVED FROM THE SAME FROZEN LIST rather than a second copy of
 * 245 names. Two hand-maintained lists of one universe is a drift risk of its
 * own, and the F5 benchmark already IS "the deployed universe, frozen
 * 2026-08-10". What makes that safe is that this file pins the MEMBERSHIP with
 * its own digest below and carries its own version string, so a re-freeze done
 * for F5's reasons fails this run loudly instead of quietly moving the market
 * breadth is measured over.
 *
 * NOT aliased to IDX_TICKERS, for the reason benchmark_universe.js states: that
 * list is already 600 in the working tree and held back from deploy.
 */
const MARKET_BREADTH_UNIVERSE_V1 = Object.freeze([...BENCHMARK_TICKERS].sort());
const MARKET_BREADTH_UNIVERSE_VERSION = `mbu-v1/${BENCHMARK_UNIVERSE_VERSION}`;
const MARKET_BREADTH_EXPECTED_SIZE = 245;

/**
 * MEMBERSHIP IS WHAT IS FROZEN, NOT THE COUNT (review round 3, and the first
 * attempt at this P1 got it wrong by asserting only `length === 245`).
 *
 * A size check cannot see a SWAP. Drop one ticker, add another, and the count is
 * still 245 while "the market" breadth is measured over is a different set of
 * companies — which is precisely the silent change this guard exists to stop.
 * The digest is over the sorted membership, so any substitution, addition or
 * removal fails the run.
 *
 * FAIL CLOSED. Not a warning: a breadth series computed over a different
 * universe is not a degraded version of this one, it is a different measurement
 * wearing the same name.
 */
const MARKET_BREADTH_UNIVERSE_SHA256 =
  '21686059a872d887f712b9c957f6813fa42559d8d67f981e29ca98a68122e975';

(function assertFrozenBreadthUniverse() {
  const digest = require('crypto').createHash('sha256')
    .update(MARKET_BREADTH_UNIVERSE_V1.join(',')).digest('hex');
  const problems = [];
  if (MARKET_BREADTH_UNIVERSE_V1.length !== MARKET_BREADTH_EXPECTED_SIZE) {
    problems.push(`size ${MARKET_BREADTH_UNIVERSE_V1.length} != ${MARKET_BREADTH_EXPECTED_SIZE}`);
  }
  if (new Set(MARKET_BREADTH_UNIVERSE_V1).size !== MARKET_BREADTH_UNIVERSE_V1.length) {
    problems.push('the universe contains duplicate tickers');
  }
  if (digest !== MARKET_BREADTH_UNIVERSE_SHA256) {
    problems.push(`membership digest ${digest} != pinned ${MARKET_BREADTH_UNIVERSE_SHA256}`);
  }
  if (problems.length) {
    throw new Error(
      `MARKET_BREADTH_UNIVERSE_V1 is not the frozen universe: ${problems.join('; ')}.\n` +
      'Breadth is not comparable across universes. If this change is intended, mint a NEW ' +
      'version (MARKET_BREADTH_UNIVERSE_V2) with its own digest and re-run the whole ' +
      'experiment under it — never re-point v1, because published EXP-026 numbers are ' +
      'stated against v1 membership.');
  }
})();

// ── provenance ──────────────────────────────────────────────────────────────
// One source only. `idx_signal_history` also holds 4,131 rows tagged `live`,
// which carry no f5_benchmark_version stamp at all, while the backfill is
// uniformly v1-idx245-2026-08-10. Mixing them would put two different F5
// benchmark definitions inside one cross-section, and F5 (relative strength) is
// precisely the factor this experiment is asking about. The 14 sessions that
// carry rows from both sources are the reason this is a filter and not an
// assumption: there are no duplicate ticker-days, so the two sources SPLIT
// those sessions rather than overlapping, and taking both would compare
// differently-benchmarked stocks inside a single session's ranking.
const SOURCE = 'backfill_v3_f5v1';

/**
 * CANONICALITY (review round 2026-08-11, P1).
 *
 * The first version of this script read `return_1d/3d/5d/10d`, `max_profit` and
 * `max_drawdown` straight out of `idx_signal_history`. Those columns are built
 * by `regenerate_signal_history.js` with `candles.slice(i + 1, i + 11)` — the
 * next N ROWS of `idx_stock_prices`, not the next N sessions of the exchange
 * calendar. `idx_stock_prices` has carried weekend and holiday phantom rows
 * before (75 purged 2026-08-04, one more 2026-08-08), and any of those inside a
 * window silently makes "5D" span something other than five sessions.
 *
 * MEASURED BEFORE CHANGING ANYTHING, and the honest result is that on THIS
 * window it made no difference: inside 2026-01-19 .. 2026-08-06 the price table
 * holds exactly the 129 canonical sessions, no phantoms and no absences, and all
 * 26,739 stored return_1d/5d/10d reproduce the canonical recomputation to within
 * the stored columns' own 2-decimal rounding. Zero rows differ.
 *
 * The recomputation is kept anyway, and not out of ceremony: the stored columns
 * are correct here by a property of the data that no code enforces, and the
 * purge that made them correct happened four days before this window was read.
 * Computing the axis here means the experiment states its own definition and
 * REFUSES a window it cannot complete, instead of inheriting whatever an
 * upstream job happened to write.
 */

/**
 * BREAKOUT, EXACTLY AS EXP-025 FREEZES IT — and the first version of this file
 * did NOT do this while claiming it did (review P1, correct catch).
 *
 * It said "defined exactly as EXP-025" and then tested `max_profit >= 5`, which
 * is an INTRADAY HIGH touching +5% at any point in the window. EXP-025's frozen
 * definition is a different and much stricter thing:
 *
 *     forward 5-session return >= +5%
 *     AND the EXIT CLOSE clears the highest CLOSE of the 20 sessions ending at
 *         entry
 *
 * (see backtest_precursor_trajectory.js, HIGH_LOOKBACK = 20). Close, not high;
 * the exit bar, not any bar. So the two experiments were not comparing the same
 * event and the "19.6% vs 45.7%" figure was not apples to apples.
 *
 * Both are now reported, under names that say what they are.
 */
const WIN_THRESHOLD = 5;      // percent, same as EXP-025
const HORIZON_BREAKOUT = 5;   // forward sessions, same as EXP-025
const HIGH_LOOKBACK = 20;     // the range a breakout must clear, same as EXP-025

const iso = d => new Date(d).toISOString().slice(0, 10);
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const smaAt = (arr, i, n) => (i + 1 < n ? null : mean(arr.slice(i - n + 1, i + 1)));
const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '  -  ' : v.toFixed(d));

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

/* ── 1. MARKET STATE FEATURES ───────────────────────────────────────────────
   Every feature the review listed, computed from the exchange's own index
   series. Deliberately raw and unweighted: this step describes the market, it
   does not score it. No feature here is combined into a "state" — that is
   EXP-027's job, and doing it now would be the shortcut the review warned
   against. */
function marketFeatures(close, i) {
  const ret = n => (i - n >= 0 ? (close[i] / close[i - n] - 1) * 100 : null);
  const ma20 = smaAt(close, i, 20), ma60 = smaAt(close, i, 60);
  const ma20prev = smaAt(close, i - 5, 20), ma60prev = smaAt(close, i - 5, 60);
  const hi20 = i >= 19 ? Math.max(...close.slice(i - 19, i + 1)) : null;
  const hi60 = i >= 59 ? Math.max(...close.slice(i - 59, i + 1)) : null;

  let vol20 = null;
  if (i >= 20) {
    const r = [];
    for (let k = i - 19; k <= i; k++) r.push((close[k] / close[k - 1] - 1) * 100);
    const m = mean(r);
    vol20 = Math.sqrt(mean(r.map(x => (x - m) ** 2)));
  }
  return {
    ihsgRet1d: ret(1), ihsgRet5d: ret(5), ihsgRet20d: ret(20),
    vsMa20: ma20 ? (close[i] / ma20 - 1) * 100 : null,
    vsMa60: ma60 ? (close[i] / ma60 - 1) * 100 : null,
    ma20Slope: (ma20 && ma20prev) ? (ma20 / ma20prev - 1) * 100 : null,
    ma60Slope: (ma60 && ma60prev) ? (ma60 / ma60prev - 1) * 100 : null,
    ddFrom20dHigh: hi20 ? (close[i] / hi20 - 1) * 100 : null,
    ddFrom60dHigh: hi60 ? (close[i] / hi60 - 1) * 100 : null,
    realizedVol20: vol20,
  };
}

/* ── 2. BREADTH, ON THE CANONICAL AXIS (review P1) ──────────────────────────
   % of tracked stocks above their own 20-SESSION MA, and % closing up against
   the previous SESSION. Computed from the price table rather than read from any
   factor, so it stays an independent description of the market and not a
   restatement of F6.

   THE BUG THIS REPLACES. The first version walked each ticker's rows in table
   order and took "the last 20 rows" as MA20, and "the previous row" as
   yesterday. On a clean axis those coincide; on a ticker whose series has holes
   they do not, and this window contains exactly that case. 245 of the 253
   tickers in `idx_stock_prices` cover all 129 canonical sessions — and the 8
   that do not (BOSS, FASW, SCPI, SMCB, SRIL, TELE, WIKA, WSKT, holding 20 to 33
   rows each) are suspended names outside the 245-ticker scored universe. Their
   "20 rows back" reached across months of halted trading, and they were being
   counted in the breadth denominator on every session.

   A ticker is now included on session D only if the 20 canonical sessions
   ending at D are ALL present for it. Missing is not zero and it is not
   "reach further back": it is excluded, and the exclusion is counted. */
function breadthByDate(priceByTicker, sessions, sessIdx) {
  const out = new Map();
  const excluded = new Map();
  for (let i = HIGH_LOOKBACK - 1; i < sessions.length; i++) {
    const d = sessions[i];
    let above = 0, up = 0, n = 0, skipped = 0;
    // The FROZEN universe, not the table's contents. A name in the universe with
    // no series at all counts as excluded, exactly like one with a short series:
    // missing is missing, and it is reported rather than silently shrinking the
    // denominator.
    for (const tk of MARKET_BREADTH_UNIVERSE_V1) {
      const series = priceByTicker.get(tk);
      if (!series) { skipped++; continue; }
      const bar = series.get(d);
      const prev = series.get(sessions[i - 1]);
      if (!bar || !prev) { skipped++; continue; }
      // the 20 canonical sessions ending at D, all of them or none
      let sum = 0, ok = true;
      for (let k = i - (HIGH_LOOKBACK - 1); k <= i; k++) {
        const b = series.get(sessions[k]);
        if (!b) { ok = false; break; }
        sum += b.c;
      }
      if (!ok) { skipped++; continue; }
      n++;
      if (bar.c > sum / HIGH_LOOKBACK) above++;
      if (bar.c > prev.c) up++;
    }
    if (n > 0) {
      out.set(d, { pctAboveMa20: above / n * 100, pctUp: up / n * 100, breadthN: n });
      excluded.set(d, skipped);
    }
  }
  return { breadth: out, excluded };
}

/* ── 2b. CANONICAL FORWARD OUTCOMES (review P1) ─────────────────────────────
   Every outcome the experiment uses, computed here from prices on the exchange
   calendar, so the horizon words mean sessions. A window that cannot be
   completed is REFUSED rather than shortened — the same rule EXP-025 applies,
   and the reason `assertCompleteSessions` exists in modules/system_health.js. */
function canonicalOutcomes(series, sessions, sessIdx, date) {
  const i = sessIdx.get(date);
  if (i === undefined) return null;
  const entry = series.get(date);
  if (!entry) return null;

  const fwd = H => {
    const t = sessions[i + H];
    if (!t) return null;
    const b = series.get(t);
    return b ? (b.c / entry.c - 1) * 100 : null;
  };

  // path over the next 5 canonical sessions — all present or the path is unknown
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

  // EXP-025 parity: exit close must clear the highest CLOSE of the 20 sessions
  // ENDING AT ENTRY. Fewer than 20 prior sessions means we cannot say whether
  // this is new ground, so the name is excluded rather than assumed either way.
  // THE WINDOW IS `i-20 .. i-1`, STRICTLY BEFORE ENTRY, byte-for-byte the bounds
  // backtest_precursor_trajectory.js uses (`for k = i - HIGH_LOOKBACK; k < i`).
  // R1 used `i-19 .. i`, which includes the entry bar itself — 20 sessions
  // ENDING AT entry rather than 20 sessions BEFORE it (review round 2, P2).
  // The reviewer judged it unlikely to flip any classification, and that is
  // probably right: with forward return >= +5% the exit close exceeds entry, so
  // an entry bar that was itself the window high is cleared anyway. "Probably
  // right" is not the contract though — two definitions of "EXP-025 parity" is
  // exactly the drift this project keeps paying for, so the bounds now match and
  // the difference is MEASURED rather than argued (see parityFlips below).
  // ONE DEFINITION, IMPORTED (review round 3). EXP-026 has now twice written its
  // own version of EXP-025's frozen contract and twice got it wrong, so it no
  // longer holds a copy at all — modules/breakout.js is the single definition and
  // test_breakout_parity.js proves it equals EXP-025's implementation on 7,200
  // generated cases, in CI, without a database.
  const bk = breakoutLib.genuineBreakout(series, sessions, i);
  const breakoutExp025 = bk === null ? null : bk.winner;

  // The superseded R1 bounds (i-19..i, entry bar included), computed ONLY to
  // count how many classifications the parity fix actually moved. Reported as a
  // measured number rather than the assumption that it "probably changes nothing".
  let breakoutR1Bounds = null;
  if (bk !== null) {
    const withEntry = Math.max(bk.priorHigh, entry.c);
    breakoutR1Bounds = bk.forwardReturnPct >= WIN_THRESHOLD && bk.exitClose > withEntry;
  }

  return {
    return_1d: fwd(1), return_3d: fwd(3), return_5d: fwd(5), return_10d: fwd(10),
    max_profit: maxProfit, max_drawdown: maxDrawdown,
    breakoutExp025, breakoutR1Bounds,
    hit5pct: maxProfit === null ? null : maxProfit >= WIN_THRESHOLD,
  };
}

/* ── 3. PER-SESSION SCANNER STATISTICS ──────────────────────────────────────
   One row per session. This is the unit of observation for everything after
   it — see the date-blocking note in the header. */
function sessionStats(rows, horizonCol, ihsgFwd) {
  const scored = rows.filter(r => r.composite_score !== null && r.out && r.out[horizonCol] !== null);
  if (scored.length < 10) return null;

  const scores = scored.map(r => Number(r.composite_score));
  const rets = scored.map(r => r.out[horizonCol]);
  const universeMean = mean(rets);

  const buys = scored.filter(r => r.signal_type === 'BUY' || r.signal_type === 'STRONG BUY');
  const buyRets = buys.map(r => r.out[horizonCol]);
  const buyMean = buyRets.length ? mean(buyRets) : null;

  const rate = (list, key) => {
    const w = list.filter(r => r.out[key] !== null && r.out[key] !== undefined);
    return w.length ? w.filter(r => r.out[key]).length / w.length * 100 : null;
  };

  return {
    n: scored.length,
    ic: cs.spearmanIC(scores, rets),
    universeMean,
    ihsgFwd,
    buyN: buys.length,
    buyMean,
    /* TWO BENCHMARKS, NAMED FOR WHAT THEY ARE (review P2).
       The first version called `buyMean - universeMean` "the market's own move
       removed", which overstates it: it is an EQUAL-WEIGHT, UNIVERSE-RELATIVE
       return, not a beta- or index-adjusted alpha. IHSG is capitalisation-
       weighted, so the two answer different questions and can disagree —
       especially in a window where large caps and the average name moved
       differently. Both are reported; neither is called alpha. */
    buyVsUniverse: buyMean === null ? null : buyMean - universeMean,
    buyVsIhsg: (buyMean === null || ihsgFwd === null) ? null : buyMean - ihsgFwd,
    universeVsIhsg: ihsgFwd === null ? null : universeMean - ihsgFwd,
    buyWinRate: buyRets.length ? buyRets.filter(x => x > 0).length / buyRets.length * 100 : null,
    buyMaxDD: (() => {
      const w = buys.filter(r => r.out.max_drawdown !== null);
      return w.length ? mean(w.map(r => r.out.max_drawdown)) : null;
    })(),
    // EXP-025's frozen definition, and the looser intrawindow touch, kept apart.
    buyBreakoutExp025: rate(buys, 'breakoutExp025'),
    universeBreakoutExp025: rate(scored, 'breakoutExp025'),
    buyHit5pct: rate(buys, 'hit5pct'),
    universeHit5pct: rate(scored, 'hit5pct'),
  };
}

/* ── 4. BUCKETING ───────────────────────────────────────────────────────────
   Terciles of a continuous feature, not a hand-picked threshold. A threshold is
   a rule, and choosing one here would answer EXP-027's question with EXP-026's
   data. Terciles also keep the cells balanced, which matters a great deal in
   this particular window — see the CONTRAST section of the output. */
function terciles(sessions, key) {
  const withVal = sessions.filter(s => s.market[key] !== null && s.market[key] !== undefined);
  if (withVal.length < 12) return null;
  const sorted = [...withVal].sort((a, b) => a.market[key] - b.market[key]);
  const t = Math.floor(sorted.length / 3);
  return [
    { label: 'LOW ', rows: sorted.slice(0, t) },
    { label: 'MID ', rows: sorted.slice(t, 2 * t) },
    { label: 'HIGH', rows: sorted.slice(2 * t) },
  ].map(g => ({
    ...g,
    range: [g.rows[0].market[key], g.rows[g.rows.length - 1].market[key]],
  }));
}

function agg(rows, field) {
  const v = rows.map(r => r.stats[field]).filter(x => x !== null && x !== undefined && !Number.isNaN(x));
  if (!v.length) return { mean: null, ci: null, n: 0 };
  const ci = v.length >= 8 ? cs.bootstrapMeanCI(v, { resamples: 2000, seed: 26 }) : null;
  return { mean: mean(v), ci, n: v.length };
}

(async () => {
  const horizonDays = String(arg('horizon', '5'));
  const horizonCol = `return_${horizonDays}d`;
  if (!['return_1d', 'return_3d', 'return_5d', 'return_10d'].includes(horizonCol)) {
    throw new Error(`--horizon must be 1, 3, 5 or 10 (got ${horizonDays})`);
  }

  const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    waitForConnections: true, connectionLimit: 5,
  });

  console.log('='.repeat(94));
  console.log('EXP-026 — MARKET REGIME CONDITIONALITY');
  console.log(`horizon ${horizonDays}D (${horizonCol})   source '${SOURCE}'   outcomes recomputed on the canonical IDX calendar`);
  console.log(`breakout = EXP-025 parity: forward ${HORIZON_BREAKOUT}-session return >= +${WIN_THRESHOLD}% AND exit close clears the prior ${HIGH_LOOKBACK}-session high close`);
  console.log('='.repeat(94));

  // index series
  const [ih] = await pool.query('SELECT date, close_price c FROM idx_ihsg_history ORDER BY date ASC');
  const idates = ih.map(r => iso(r.date));
  const iclose = ih.map(r => Number(r.c));
  const idxOf = new Map(idates.map((d, i) => [d, i]));

  // SCORES AND CLASSIFICATIONS come from the snapshot; every OUTCOME is
  // recomputed here from prices on the canonical axis (review P1).
  const [sig] = await pool.query(
    `SELECT data_date, stock_code, composite_score, signal_type
       FROM idx_signal_history WHERE data_source = ? ORDER BY data_date ASC`, [SOURCE]);
  const byDate = new Map();
  for (const r of sig) {
    const d = iso(r.data_date);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(r);
  }
  const firstDate = [...byDate.keys()].sort()[0];

  // price series keyed by canonical date, per ticker
  const [px] = await pool.query(
    `SELECT stock_code, date, close_price c, high_price h, low_price l
       FROM idx_stock_prices WHERE date >= DATE_SUB(?, INTERVAL 120 DAY) ORDER BY stock_code, date`,
    [firstDate]);
  const priceByTicker = new Map();
  for (const r of px) {
    if (!priceByTicker.has(r.stock_code)) priceByTicker.set(r.stock_code, new Map());
    priceByTicker.get(r.stock_code).set(iso(r.date), { c: Number(r.c), h: Number(r.h), l: Number(r.l) });
  }

  const { breadth, excluded: breadthExcluded } = breadthByDate(priceByTicker, idates, idxOf);

  // attach canonical outcomes to every scored row
  let refusedOutcome = 0, attached = 0;
  for (const [d, rows] of byDate) {
    for (const r of rows) {
      const series = priceByTicker.get(r.stock_code);
      r.out = series ? canonicalOutcomes(series, idates, idxOf, d) : null;
      if (!r.out) { refusedOutcome++; r.out = null; } else attached++;
    }
  }

  // How many classifications the i-20..i-1 parity fix actually moved, per the
  // comment above canonicalOutcomes's breakoutR1Bounds field: measured, not
  // assumed "probably right". Compared only where BOTH definitions could be
  // evaluated (excludes rows canonicalOutcomes already refused for missing
  // window/exit data) — a name absent from R1's classification for a data
  // reason is not evidence either way about what the bounds fix changed.
  let parityCompared = 0, parityFlips = 0;
  for (const rows of byDate.values()) {
    for (const r of rows) {
      if (!r.out) continue;
      const { breakoutExp025, breakoutR1Bounds } = r.out;
      if (breakoutExp025 === null || breakoutR1Bounds === null) continue;
      parityCompared++;
      if (breakoutExp025 !== breakoutR1Bounds) parityFlips++;
    }
  }

  // IHSG's own forward return over the same canonical horizon, for the
  // index-relative benchmark the review asked for (P2).
  const ihsgFwdAt = (d, H) => {
    const i = idxOf.get(d);
    if (i === undefined || !idates[i + H]) return null;
    return (iclose[i + H] / iclose[i] - 1) * 100;
  };

  // one row per session
  const sessions = [];
  let skippedNoIndex = 0, skippedThin = 0;
  for (const [d, rows] of [...byDate.entries()].sort()) {
    const i = idxOf.get(d);
    if (i === undefined) { skippedNoIndex++; continue; }
    const stats = sessionStats(rows, horizonCol, ihsgFwdAt(d, Number(horizonDays)));
    if (!stats) { skippedThin++; continue; }
    sessions.push({
      date: d, sessionIndex: i,
      market: { ...marketFeatures(iclose, i), ...(breadth.get(d) || { pctAboveMa20: null, pctUp: null }) },
      stats,
    });
  }
  console.log(`\ncanonical outcomes attached: ${attached}   refused (incomplete window): ${refusedOutcome}`);
  const exVals = [...breadthExcluded.values()];
  if (exVals.length) {
    console.log(`breadth: ${fmt(mean([...breadth.values()].map(b => b.breadthN)), 1)} tickers/session included, ` +
      `${fmt(mean(exVals), 1)} excluded for an incomplete 20-session window`);
  }

  console.log(`\nsessions used: ${sessions.length}` +
    (skippedNoIndex ? `   (${skippedNoIndex} had no index bar)` : '') +
    (skippedThin ? `   (${skippedThin} too thin)` : ''));
  console.log(`window: ${sessions[0].date} .. ${sessions[sessions.length - 1].date}`);
  const totalBuy = sessions.reduce((s, x) => s + x.stats.buyN, 0);
  const totalObs = sessions.reduce((s, x) => s + x.stats.n, 0);
  console.log(`scored ticker-sessions: ${totalObs}   BUY/STRONG BUY: ${totalBuy}` +
    `   sessions with >=1 BUY: ${sessions.filter(s => s.stats.buyN > 0).length}`);

  // ── the unconditional picture, so every conditional number has a baseline ──
  const allIC = agg(sessions, 'ic');
  const allExcess = agg(sessions.filter(s => s.stats.buyN > 0), 'buyVsUniverse');
  const allVsIhsg = agg(sessions.filter(s => s.stats.buyN > 0), 'buyVsIhsg');
  const allUniVsIhsg = agg(sessions, 'universeVsIhsg');
  const allAbs = agg(sessions.filter(s => s.stats.buyN > 0), 'buyMean');
  const allUni = agg(sessions, 'universeMean');
  const icSeries = sessions.map(s => s.stats.ic).filter(x => x !== null);
  console.log('\nUNCONDITIONAL (all sessions pooled — the baseline the tables below move against)');
  console.log('-'.repeat(94));
  console.log(`  rank IC of composite_score vs ${horizonDays}D return : ${fmt(allIC.mean, 4)}` +
    (allIC.ci ? `  95% CI [${fmt(allIC.ci.lower, 4)}, ${fmt(allIC.ci.upper, 4)}]` : '') +
    `   IR ${fmt(cs.icInformationRatio(icSeries), 3)}   n=${allIC.n} sessions`);
  console.log(`  universe mean ${horizonDays}D return                  : ${fmt(allUni.mean)}%   <- what the market did`);
  console.log(`  BUY mean ${horizonDays}D return   (ABSOLUTE)          : ${fmt(allAbs.mean)}%` +
    (allAbs.ci ? `  95% CI [${fmt(allAbs.ci.lower)}, ${fmt(allAbs.ci.upper)}]` : ''));
  console.log(`  BUY minus EQUAL-WEIGHT universe, same session   : ${fmt(allExcess.mean)}%` +
    (allExcess.ci ? `  95% CI [${fmt(allExcess.ci.lower)}, ${fmt(allExcess.ci.upper)}]` : ''));
  console.log(`  BUY minus IHSG (cap-weighted index), same session: ${fmt(allVsIhsg.mean)}%` +
    (allVsIhsg.ci ? `  95% CI [${fmt(allVsIhsg.ci.lower)}, ${fmt(allVsIhsg.ci.upper)}]` : ''));
  console.log(`  universe minus IHSG                             : ${fmt(allUniVsIhsg.mean)}%   <- the two benchmarks are not the same thing`);

  // ── conditional tables ──
  const FEATURES = [
    ['ihsgRet20d', 'IHSG return 20D'],
    ['ihsgRet5d', 'IHSG return 5D'],
    ['vsMa20', 'IHSG vs MA20 (%)'],
    ['vsMa60', 'IHSG vs MA60 (%)'],
    ['ma20Slope', 'MA20 slope (5d, %)'],
    ['ma60Slope', 'MA60 slope (5d, %)'],
    ['ddFrom60dHigh', 'drawdown from 60D high'],
    ['realizedVol20', 'realized vol 20D'],
    ['pctAboveMa20', 'breadth: % > own MA20'],
    ['pctUp', 'breadth: % closing up'],
  ];

  const jsonOut = { horizon: horizonDays, source: SOURCE, sessions: sessions.length, unconditional: {
    ic: allIC, buyAbsolute: allAbs, buyVsUniverse: allExcess, buyVsIhsg: allVsIhsg, universe: allUni }, features: {} };

  for (const [key, label] of FEATURES) {
    const groups = terciles(sessions, key);
    if (!groups) { console.log(`\n${label}: not enough sessions with this feature`); continue; }
    console.log(`\n${label}`);
    console.log('-'.repeat(94));
    console.log('        range                sess  BUYs |  market   BUY abs  BUY-univ [95% CI]        IC    brkout B/U');
    const rec = [];
    for (const g of groups) {
      const withBuys = g.rows.filter(r => r.stats.buyN > 0);
      const ic = agg(g.rows, 'ic');
      const uni = agg(g.rows, 'universeMean');
      const abs = agg(withBuys, 'buyMean');
      const exc = agg(withBuys, 'buyVsUniverse');
      const excI = agg(withBuys, 'buyVsIhsg');
      const brk = agg(withBuys, 'buyBreakoutExp025');
      const ubrk = agg(g.rows, 'universeBreakoutExp025');
      const nBuys = g.rows.reduce((s, r) => s + r.stats.buyN, 0);
      console.log(
        `  ${g.label}  ${String(fmt(g.range[0]) + '..' + fmt(g.range[1])).padEnd(18)} ` +
        `${String(g.rows.length).padStart(4)} ${String(nBuys).padStart(5)} | ` +
        `${fmt(uni.mean).padStart(7)}% ${fmt(abs.mean).padStart(8)}% ` +
        `${fmt(exc.mean).padStart(9)}%` +
        `${exc.ci ? ` [${fmt(exc.ci.lower)},${fmt(exc.ci.upper)}]`.padEnd(16) : ' '.repeat(16)} ` +
        `${fmt(ic.mean, 4).padStart(7)} ` +
        `${fmt(brk.mean, 1).padStart(5)}%/${fmt(ubrk.mean, 1)}%`);
      rec.push({ bucket: g.label.trim(), range: g.range, sessions: g.rows.length, buys: nBuys,
                 universeMean: uni.mean, buyAbsolute: abs, buyVsUniverse: exc, buyVsIhsg: excI, ic, breakoutExp025: brk.mean, universeBreakoutExp025: ubrk.mean });
    }
    jsonOut.features[key] = rec;
  }

  /* ── DECILES: is the score INVERTED, or is the BUY threshold miscalibrated? ──
     Two different faults produce a negative IC and they need different answers.
     If forward return falls monotonically as the score rises, the score itself
     carries inverted information. If instead only the top decile is bad, the
     ranking is fine and the BUY cutoff is sitting in the wrong place.

     EXP-010 is the precedent for asking: it found a ranking whose deciles were
     NON-monotonic, which meant the headline IC was hiding the real shape.
     Computed per session and averaged over sessions, for the same date-blocking
     reason as everything else here. */
  const decilesBySession = [];
  for (const [d, rows] of [...byDate.entries()].sort()) {
    const scored = rows.filter(r => r.composite_score !== null && r.out && r.out[horizonCol] !== null);
    if (scored.length < 30) continue;
    const b = cs.bucketByScore(scored.map(r => Number(r.composite_score)),
                              scored.map(r => r.out[horizonCol]), 10);
    // EXCESS per decile, so a falling market cannot make every decile look bad.
    decilesBySession.push(b.buckets.map(x => (x.meanReturn === null ? null : x.meanReturn - b.universeMean)));
  }
  console.log(`\n\nSCORE DECILES — mean ${horizonDays}D return MINUS the session's own universe mean`);
  console.log(`(averaged over ${decilesBySession.length} sessions; D1 = lowest composite_score, D10 = highest)`);
  console.log('-'.repeat(94));
  const decileMeans = [];
  for (let k = 0; k < 10; k++) {
    const v = decilesBySession.map(row => row[k]).filter(x => x !== null);
    const m = mean(v);
    decileMeans.push(m);
    const ci = cs.bootstrapMeanCI(v, { resamples: 2000, seed: 26 });
    const bar = m === null ? '' : (m < 0 ? ' '.repeat(Math.max(0, 12 - Math.round(-m * 6))) + '#'.repeat(Math.min(12, Math.round(-m * 6))) + '|'
                                        : ' '.repeat(12) + '|' + '#'.repeat(Math.min(12, Math.round(m * 6))));
    console.log(`  D${String(k + 1).padStart(2)}  ${fmt(m).padStart(7)}%  [${fmt(ci.lower)},${fmt(ci.upper)}]  ${bar}`);
  }
  const topBottom = decileMeans[9] - decileMeans[0];
  console.log(`\n  D10 - D1 = ${fmt(topBottom)} percentage points` +
    `   (a working ranking is POSITIVE here; this is the spread the score is supposed to create)`);
  jsonOut.deciles = { excessByDecile: decileMeans, topMinusBottom: topBottom, sessions: decilesBySession.length };

  /* ── THE BUY RETURN DISTRIBUTION ────────────────────────────────────────────
     The review's reading of the two results that look contradictory — BUY hits
     the EXP-025 breakout 3.4x more often than base rate, yet BUY mean return is
     negative — is that they are not contradictory at all, and that the shape is
     probably a few large winners against many small losers.

     That is a claim about the DISTRIBUTION, so it is checkable rather than
     interpretive, and the difference matters: "breaks out more often" and
     "better expected return" are different statements and this experiment
     should stop letting one stand in for the other. Pooled over signals, since
     it describes the shape of one signal's outcome rather than a regime effect. */
  const allBuys = [];
  for (const rows of byDate.values()) {
    for (const r of rows) {
      if ((r.signal_type !== 'BUY' && r.signal_type !== 'STRONG BUY') || !r.out) continue;
      if (r.out[horizonCol] === null) continue;
      allBuys.push({ ret: r.out[horizonCol], brk: r.out.breakoutExp025 });
    }
  }
  if (allBuys.length) {
    const sorted = [...allBuys].map(x => x.ret).sort((a, b) => a - b);
    const q = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    const brk = allBuys.filter(x => x.brk === true);
    const non = allBuys.filter(x => x.brk === false);
    console.log(`\n\nBUY RETURN DISTRIBUTION at ${horizonDays}D (pooled over ${allBuys.length} signals)`);
    console.log('-'.repeat(94));
    console.log(`  p10 ${fmt(q(0.10)).padStart(7)}%   p25 ${fmt(q(0.25)).padStart(7)}%   median ${fmt(q(0.50)).padStart(7)}%` +
      `   p75 ${fmt(q(0.75)).padStart(7)}%   p90 ${fmt(q(0.90)).padStart(7)}%`);
    console.log(`  mean ${fmt(mean(sorted))}%   share positive ${fmt(sorted.filter(x => x > 0).length / sorted.length * 100, 1)}%`);
    if (brk.length && non.length) {
      console.log(`\n  EXP-025 breakout   n=${String(brk.length).padStart(4)}  mean ${fmt(mean(brk.map(x => x.ret))).padStart(7)}%   median ${fmt([...brk.map(x => x.ret)].sort((a, b) => a - b)[Math.floor(brk.length / 2)]).padStart(7)}%`);
      console.log(`  everything else    n=${String(non.length).padStart(4)}  mean ${fmt(mean(non.map(x => x.ret))).padStart(7)}%   median ${fmt([...non.map(x => x.ret)].sort((a, b) => a - b)[Math.floor(non.length / 2)]).padStart(7)}%`);
      console.log('\n  "breaks out more often" and "better expected return" are different claims;');
      console.log('  this is where they come apart, and neither may be quoted as the other.');
    }
    jsonOut.buyDistribution = {
      n: allBuys.length, mean: mean(sorted), p10: q(0.10), p25: q(0.25), median: q(0.50), p75: q(0.75), p90: q(0.90),
      breakout: brk.length ? { n: brk.length, mean: mean(brk.map(x => x.ret)) } : null,
      nonBreakout: non.length ? { n: non.length, mean: mean(non.map(x => x.ret)) } : null,
    };
  }

  // ── ROBUSTNESS: overlapping forward windows ────────────────────────────────
  // modules/cross_sectional.js states the limit its own bootstrap cannot fix:
  // daily sampling with an H-day forward return makes consecutive sessions'
  // statistics serially correlated, so the CIs above are too NARROW. Re-run the
  // headline numbers on a subsample spaced H sessions apart, where the forward
  // windows do not overlap at all.
  // ANCHORS ARE PICKED ON THE EXCHANGE'S OWN INDEX, not on this array's (P2).
  // `sessions.filter((_, i) => i % H === 0)` counts positions in a list that has
  // already had sessions dropped (no index bar, too thin), so two consecutive
  // picks could be fewer than H canonical sessions apart — which is exactly the
  // overlap the subsample exists to remove.
  const H = Number(horizonDays);
  const spaced = [];
  let nextEligible = -Infinity;
  for (const s of sessions) {
    if (s.sessionIndex >= nextEligible) { spaced.push(s); nextEligible = s.sessionIndex + H; }
  }
  const sIC = agg(spaced, 'ic');
  const sExc = agg(spaced.filter(s => s.stats.buyN > 0), 'buyVsUniverse');
  const sAbs = agg(spaced.filter(s => s.stats.buyN > 0), 'buyMean');
  console.log('\n\nROBUSTNESS — non-overlapping subsample (every ' + H + 'th session, windows cannot overlap)');
  console.log('-'.repeat(94));
  console.log(`  sessions: ${spaced.length} of ${sessions.length}`);
  console.log(`  rank IC        ${fmt(sIC.mean, 4)}` + (sIC.ci ? `  95% CI [${fmt(sIC.ci.lower, 4)}, ${fmt(sIC.ci.upper, 4)}]` : ''));
  console.log(`  BUY absolute   ${fmt(sAbs.mean)}%` + (sAbs.ci ? `  95% CI [${fmt(sAbs.ci.lower)}, ${fmt(sAbs.ci.upper)}]` : ''));
  console.log(`  BUY - universe ${fmt(sExc.mean)}%` + (sExc.ci ? `  95% CI [${fmt(sExc.ci.lower)}, ${fmt(sExc.ci.upper)}]` : ''));
  jsonOut.robustness = { spacedSessions: spaced.length, ic: sIC, buyAbsolute: sAbs, buyVsUniverse: sExc };

  /* ── THE SIGNIFICANCE VERDICT, COMPUTED RATHER THAN WRITTEN ────────────────
     Review round 3: for H > 1 the daily-sampled CI must not carry the word
     "significant", because overlapping forward windows make it too narrow by
     construction. R1's prose said "significantly negative at every horizon"
     while R1's own non-overlapping 5D CI crossed zero — the exact mistake.

     So the label is DERIVED here, from whichever CI is admissible for this
     horizon, and printed. Prose cannot drift from the data if the data states
     the verdict itself. */
  const admissible = H === 1
    ? { ci: allIC.ci, basis: 'daily-sampled (H=1: consecutive windows do not overlap)', n: allIC.n }
    : { ci: sIC.ci, basis: `non-overlapping subsample, anchors >= ${H} canonical sessions apart`, n: sIC.n };
  const verdict = !admissible.ci ? 'INSUFFICIENT DATA'
    : (admissible.ci.upper < 0 ? 'SIGNIFICANTLY NEGATIVE'
      : admissible.ci.lower > 0 ? 'SIGNIFICANTLY POSITIVE'
        : 'DIRECTIONALLY NEGATIVE (CI spans zero — NOT significant)');
  console.log(`\nSIGNIFICANCE VERDICT for the ${horizonDays}D rank IC`);
  console.log('-'.repeat(94));
  console.log(`  admissible evidence : ${admissible.basis}, n=${admissible.n} sessions`);
  console.log(`  CI used             : [${fmt(admissible.ci?.lower, 4)}, ${fmt(admissible.ci?.upper, 4)}]`);
  console.log(`  VERDICT             : ${verdict}`);
  if (H > 1) {
    console.log(`  (the daily-sampled CI [${fmt(allIC.ci?.lower, 4)}, ${fmt(allIC.ci?.upper, 4)}] is reported above as a`);
    console.log('   DESCRIPTIVE effect estimate only, and must not be quoted as significance)');
  }
  jsonOut.significance = { horizon: H, basis: admissible.basis, n: admissible.n,
                           ci: admissible.ci, verdict, dailySampledCI: allIC.ci };

  // PROVENANCE — what this run measured, so a rerun can be shown to be the same
  // measurement rather than assumed to be (review round 3, P1 acceptance).
  jsonOut.provenance = {
    signalSource: SOURCE,
    breadthUniverse: MARKET_BREADTH_UNIVERSE_VERSION,
    breadthUniverseSha256: MARKET_BREADTH_UNIVERSE_SHA256,
    breadthUniverseExpectedN: MARKET_BREADTH_EXPECTED_SIZE,
    breakoutDefinition: `modules/breakout.js: forward ${breakoutLib.HORIZON_SESSIONS}-session return >= ` +
      `+${breakoutLib.WIN_THRESHOLD_PCT}% AND exit close > max close over the ${breakoutLib.HIGH_LOOKBACK} ` +
      'sessions STRICTLY BEFORE entry',
    breakoutParityFlips: parityFlips,
    breakoutParityCompared: parityCompared,
    outcomeAxis: 'idx_ihsg_history canonical sessions; incomplete windows refused',
  };
  console.log(`\nprovenance: breadth universe ${MARKET_BREADTH_UNIVERSE_VERSION} ` +
    `(n=${MARKET_BREADTH_EXPECTED_SIZE}, sha256 ${MARKET_BREADTH_UNIVERSE_SHA256.slice(0, 12)}…)`);
  console.log(`breakout parity fix (i-20..i-1 vs superseded i-19..i): ${parityFlips} of ${parityCompared} classifications moved` +
    (parityCompared > 0 ? ` (${fmt(parityFlips / parityCompared * 100, 2)}%)` : ''));

  const outFile = arg('json', null);
  if (outFile) {
    require('fs').writeFileSync(outFile, JSON.stringify(jsonOut, null, 1));
    console.log(`\nJSON -> ${outFile}`);
  }

  console.log('\n' + '='.repeat(94));
  console.log('READ THIS BEFORE QUOTING ANY NUMBER ABOVE');
  console.log('='.repeat(94));
  console.log(`  - N is ${sessions.length} SESSIONS, not ${totalObs} rows. Every stock in a session shares its`);
  console.log('    regime, so the rows are not independent observations of a regime effect.');
  console.log('  - ONE window, 2026-01-19 .. 2026-08-06, ~7 months, and a predominantly falling');
  console.log('    one. This is in-sample and describes this period, not IDX in general.');
  console.log('  - No rule is proposed here. Terciles are a way of reading the data, not a gate.');
  console.log('  - SIGNIFICANCE IS NOT UNIFORM ACROSS HORIZONS, and the daily-sampled CI above');
  console.log('    must not be quoted as if it were. Daily sampling at horizon H > 1 overlaps,');
  console.log('    so those bootstrap CIs are too narrow by construction:');
  console.log('       1D  -> no overlap at all. The daily-sampled CI stands as it is.');
  console.log('       3/5/10D -> read significance from the NON-OVERLAPPING sample above,');
  console.log('                  not from the daily-sampled CI.');
  console.log('  - BUY counts per bucket are small; treat ABSOLUTE/EXCESS cells with <30 BUYs as');
  console.log('    directional at best. The IC column uses every scored name and is the stronger');
  console.log('    statistic of the two.');

  await pool.end();
})().catch(e => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
