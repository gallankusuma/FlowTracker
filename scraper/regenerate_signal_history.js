/**
 * Regenerates idx_signal_history for the gap between 2026-01-19 (earliest
 * date idx_concentration has data, needed for f1/f2/f7/f8) and 2026-06-12
 * (where the clean 'live' data_source record starts) — so the /idx/[code]
 * deep-dive page's factor-history table has more than ~6 weeks to show.
 *
 * Deliberately NOT a rerun of the old awo_backfill.js, which is what produced
 * the 885 contaminated rows flagged during the 2026-07-19 overfitting
 * incident (validation leakage). This script instead reuses the exact same
 * f1-f14/composite/classifySignal logic already copied verbatim from
 * server.js into backtest_signal_scanner_badges.js earlier — no lookahead
 * (each day's factors use only data up to and including that day), fixed
 * DEFAULT_WEIGHTS (confirmed unchanged for this whole period via
 * /api/awo/status — isOptimized:false), and the SAME outcome-evaluation
 * logic the live system uses (copied from server.js's outcome-backfill
 * endpoint) so results are comparable to genuine 'live' rows.
 *
 * Tagged data_source='backfill_v2' — distinct from both 'live' (genuinely
 * computed same-day) and the old contaminated 'backfill' — and only inserts
 * where a (data_date, stock_code) row doesn't already exist (INSERT IGNORE
 * on the table's unique key), so it can never overwrite real 'live' rows.
 *
 * Usage: node regenerate_signal_history.js [--dry-run]
 */

'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const stats = require('./modules/statistics');
const { calcTechnicalFactors, computeWeeklyTrend } = require('./awo_technical');
const { BENCHMARK_UNIVERSE_VERSION, BENCHMARK_TICKERS } = require('./modules/benchmark_universe');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const DEFAULT_WEIGHTS = {
  f1: 0.14, f2: 0.10, f3: 0.08, f4: 0.10,
  f5: 0.07, f6: 0.10, f7: 0.08, f8: 0.05,
  f9: 0.06, f10: 0.06, f11: 0.05, f12: 0.05,
  f13: 0.03, f14: 0.03,
};
const THRESHOLDS = { strongBuy: 78, buy: 63, watch: 53, neutral: 40, sell: 25 };
// Defaults preserve the original run's window. Override with --from/--to to
// repair a later hole; --to is EXCLUSIVE.
const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const GAP_START = argOf('--from', '2026-01-19');
const GAP_END = argOf('--to', '2026-06-12'); // exclusive — 'live' data_source takes over from here

function classifySignal(score) {
  const t = THRESHOLDS;
  if (score >= t.strongBuy) return 'STRONG BUY';
  if (score >= t.buy) return 'BUY';
  if (score >= t.watch) return 'WATCH';
  if (score >= t.neutral) return 'NEUTRAL';
  if (score >= t.sell) return 'SELL';
  return 'STRONG SELL';
}
// F1-F8 now imported from modules/awo_factors.js instead of a hand-copied
// local version — this file's f8_streak in particular had silently drifted
// to a completely different formula shape than server.js's, exactly the
// live/backfill divergence risk flagged in the 2026-07-19 overfitting
// incident memory. Sharing one module means this script and live scoring
// can never diverge again.
const {
  f1_concentration, f2_trend, f3_volumeZ, f4_momentum,
  f5_relStrength, f6_breadth, f7_alignment, f8_streak,
  weightedComposite, computeConfidence, computeRiskModifier, combineFinalScore,
} = require('./modules/awo_factors');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  const [tickerRows] = await pool.query(
    `SELECT stock_code, COUNT(*) n FROM idx_stock_prices GROUP BY stock_code HAVING n >= 250 ORDER BY stock_code`
  );
  const tickers = tickerRows.map(r => r.stock_code);
  console.log(`Tickers: ${tickers.length}`);

  console.log('Loading OHLC, concentration, broker summary...');
  const ohlcMap = new Map();
  for (const t of tickers) {
    const [rows] = await pool.query(
      `SELECT date, open_price o, high_price h, low_price l, close_price c, volume v FROM idx_stock_prices WHERE stock_code=? ORDER BY date ASC`, [t]
    );
    ohlcMap.set(t, rows.map(r => ({
      date: r.date.toISOString().split('T')[0], open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v),
    })));
  }

  const [concRows] = await pool.query(`SELECT data_date, stock_code, dn0, dn1, dn2, dn3, dn4 FROM idx_concentration`);
  const concMap = new Map();
  for (const r of concRows) concMap.set(`${r.stock_code}|${r.data_date.toISOString().split('T')[0]}`, r);

  const [brokerRows] = await pool.query(`SELECT date, stock_code, broker_code, buy_val - sell_val net_val FROM idx_broker_summary WHERE date >= ? AND date < ?`, [GAP_START, GAP_END]);
  const breadthMap = new Map();
  for (const r of brokerRows) {
    const key = `${r.stock_code}|${r.date.toISOString().split('T')[0]}`;
    if (!breadthMap.has(key)) breadthMap.set(key, { buyers: 0, sellers: 0 });
    const e = breadthMap.get(key);
    if (Number(r.net_val) > 0) e.buyers++; else if (Number(r.net_val) < 0) e.sellers++;
  }

  // F5 IS MEASURED AGAINST THE FROZEN BENCHMARK UNIVERSE, same as the live path.
  //
  // This used to average `changeByDate`, which was built from every ticker with
  // >= 250 price bars — a different cross-section from the one the live scanner
  // uses, so the historical F5 series and the live one were not comparable. The
  // research this feeds is precisely about F5 trajectories, so an incomparable
  // benchmark would have invalidated the result before it was measured.
  const benchSet = new Set(BENCHMARK_TICKERS);
  const benchChangeByDate = new Map();
  for (const t of tickers) {
    if (!benchSet.has(t)) continue;
    const c = ohlcMap.get(t);
    if (!c) continue;
    for (let i = 1; i < c.length; i++) {
      const chg = (c[i].close / c[i - 1].close - 1) * 100;
      if (!Number.isFinite(chg)) continue;
      if (!benchChangeByDate.has(c[i].date)) benchChangeByDate.set(c[i].date, []);
      benchChangeByDate.get(c[i].date).push(chg);
    }
  }
  const marketAvgByDate = new Map();
  for (const [date, arr] of benchChangeByDate) marketAvgByDate.set(date, stats.mean(arr));
  console.log(`F5 benchmark: ${BENCHMARK_UNIVERSE_VERSION} (${BENCHMARK_TICKERS.length} tickers, ` +
              `${[...benchSet].filter(t => ohlcMap.has(t)).length} with price history)`);

  console.log('Computing factor scores + outcomes for the gap window...\n');
  let rowsToInsert = [];
  let processed = 0;

  for (const ticker of tickers) {
    const candles = ohlcMap.get(ticker);
    if (candles.length < 30) continue;

    for (let i = 20; i < candles.length; i++) {
      const date = candles[i].date;
      if (date < GAP_START || date >= GAP_END) continue;
      // THE FACTOR SNAPSHOT AND THE OUTCOME ARE DIFFERENT CLAIMS.
      //
      // This used to skip any date without ten forward sessions, because the
      // outcome could not be evaluated. That is right for the outcome and wrong
      // for the snapshot: the factor scores for a session are complete the
      // moment that session closes and do not depend on anything after it.
      // Skipping meant the most RECENT sessions — exactly the ones a trajectory
      // view needs — could never be written until ten more had passed.
      //
      // So the snapshot is always written; the outcome is written only when the
      // forward window genuinely exists, and left NULL otherwise for the
      // existing outcome-backfill to fill in later. A partial forward window is
      // not a small outcome, it is an unfinished one.
      const futureIdx10 = i + 10;
      const hasFullForward = futureIdx10 < candles.length;

      const closes = candles.slice(0, i + 1).map(c => c.close);
      const volumes = candles.slice(Math.max(0, i - 29), i + 1).map(c => c.volume);
      const dailyChange = (candles[i].close / candles[i - 1].close - 1) * 100;
      const priceDirection = dailyChange > 0 ? 1 : dailyChange < 0 ? -1 : 0;

      const conc = concMap.get(`${ticker}|${date}`);
      const dn0 = conc ? Number(conc.dn0 ?? 0) : null;
      const dnValues = conc ? [conc.dn4, conc.dn3, conc.dn2, conc.dn1, conc.dn0].map(v => v !== null && v !== undefined ? Number(v) : null) : [];

      const breadthKey = `${ticker}|${date}`;
      const breadth = breadthMap.get(breadthKey) || { buyers: 0, sellers: 0 };
      const brokerDataAvailable = !!conc;
      const breadthDataAvailable = breadthMap.has(breadthKey);
      const marketAvgChange = marketAvgByDate.get(date) || 0;

      const f1 = f1_concentration(dn0);
      const f2 = f2_trend(dnValues);
      const f3 = f3_volumeZ(volumes, priceDirection);
      const f4 = f4_momentum(closes);
      const f5 = f5_relStrength(dailyChange, marketAvgChange);
      const f6 = f6_breadth(breadth.buyers, breadth.sellers);
      const f7 = f7_alignment(dailyChange, dn0);
      const f8 = f8_streak(dnValues);

      const windowCandles = candles.slice(0, i + 1);
      let f9 = 50, f10 = 50, f11 = 50, f12 = 50, f13 = 50, f14 = 50;
      try {
        const tech = calcTechnicalFactors(windowCandles.slice(-60));
        f9 = tech.f9; f10 = tech.f10; f11 = tech.f11; f12 = tech.f12; f13 = tech.f13; f14 = tech.f14;
      } catch {}

      // F1-F13 combine via weightedComposite (excludes factors lacking real
      // broker/breadth data from both numerator and weight sum — see its doc
      // comment). Final score = Directional × Confidence × RiskModifier per
      // AWO Engine.md §3.4, matching the same shape used in server.js.
      const { composite: rawComposite13, factorCoverage } = weightedComposite(
        { f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13 },
        { f1: DEFAULT_WEIGHTS.f1, f2: DEFAULT_WEIGHTS.f2, f3: DEFAULT_WEIGHTS.f3, f4: DEFAULT_WEIGHTS.f4,
          f5: DEFAULT_WEIGHTS.f5, f6: DEFAULT_WEIGHTS.f6, f7: DEFAULT_WEIGHTS.f7, f8: DEFAULT_WEIGHTS.f8,
          f9: DEFAULT_WEIGHTS.f9, f10: DEFAULT_WEIGHTS.f10, f11: DEFAULT_WEIGHTS.f11, f12: DEFAULT_WEIGHTS.f12, f13: DEFAULT_WEIGHTS.f13 },
        { f1: brokerDataAvailable, f2: brokerDataAvailable, f6: breadthDataAvailable, f7: brokerDataAvailable, f8: brokerDataAvailable }
      );
      const composite = combineFinalScore(rawComposite13, computeConfidence(factorCoverage), computeRiskModifier(f14));
      const signal = classifySignal(composite);
      const confidence = Math.round(Math.abs(composite - 50) * 2);

      // ── Outcome evaluation — same logic as the live outcome-backfill endpoint ──
      const entry = candles[i].close;
      const future = hasFullForward ? candles.slice(i + 1, i + 11) : [];
      const getReturn = (idx) => idx >= 0 && idx < future.length ? Math.round(((future[idx].close - entry) / entry) * 10000) / 100 : null;
      const return_1d = getReturn(0), return_3d = getReturn(Math.min(2, future.length - 1)),
            return_5d = getReturn(Math.min(4, future.length - 1)), return_10d = getReturn(Math.min(9, future.length - 1));
      const highs5 = future.slice(0, 5).map(c => c.high), lows5 = future.slice(0, 5).map(c => c.low);
      const max_profit = highs5.length ? Math.round(((Math.max(...highs5) - entry) / entry) * 10000) / 100 : null;
      const max_drawdown = lows5.length ? Math.round(((Math.min(...lows5) - entry) / entry) * 10000) / 100 : null;
      const price_5d_later = return_5d !== null ? future[Math.min(4, future.length - 1)].close : null;

      // NULL, not 'NEUTRAL'. An unevaluated outcome is unknown; recording it as
      // neutral would put a verdict in the win-rate statistics for a trade whose
      // result has not happened yet.
      let outcome = hasFullForward ? 'NEUTRAL' : null;
      const isBullish = signal === 'STRONG BUY' || signal === 'BUY';
      const isBearish = signal === 'STRONG SELL' || signal === 'SELL';
      // Guarded explicitly rather than relying on every null comparison below
      // happening to be false. It does work out that way today, but a verdict
      // that depends on `null >= 3` staying falsy is one refactor from becoming
      // a WIN nobody earned.
      if (hasFullForward) {
        if (isBullish) {
          if (max_profit >= 3 && max_drawdown > -2) outcome = 'WIN';
          else if (max_drawdown <= -2) outcome = 'LOSS';
          else if (return_5d !== null && return_5d > 1) outcome = 'WIN';
          else if (return_5d !== null && return_5d < -1) outcome = 'LOSS';
        } else if (isBearish) {
          if (max_drawdown <= -3 && max_profit < 2) outcome = 'WIN';
          else if (max_profit >= 2) outcome = 'LOSS';
          else if (return_5d !== null && return_5d < -1) outcome = 'WIN';
          else if (return_5d !== null && return_5d > 1) outcome = 'LOSS';
        } else {
          if (return_5d !== null && return_5d > 2) outcome = 'WIN';
          else if (return_5d !== null && return_5d < -2) outcome = 'LOSS';
        }
      }

      rowsToInsert.push([
        date, ticker, composite, signal, confidence,
        Math.round(f1), Math.round(f2), Math.round(f3), Math.round(f4), Math.round(f5), Math.round(f6), Math.round(f7), Math.round(f8),
        Math.round(f9), Math.round(f10), Math.round(f11), Math.round(f12), Math.round(f13), Math.round(f14),
        entry, price_5d_later, outcome, return_1d, return_3d, return_5d, return_10d, max_drawdown, max_profit,
        'backfill_v2',
      ]);
      processed++;
    }
  }

  console.log(`Rows to insert: ${rowsToInsert.length}`);
  if (dryRun) { console.log('(dry run — not writing)'); await pool.end(); return; }

  let inserted = 0;
  const BATCH = 500;
  for (let i = 0; i < rowsToInsert.length; i += BATCH) {
    const batch = rowsToInsert.slice(i, i + BATCH);
    const [result] = await pool.query(
      `INSERT IGNORE INTO idx_signal_history
        (data_date, stock_code, composite_score, signal_type, confidence,
         f1_concentration, f2_trend, f3_volume_z, f4_momentum, f5_rel_strength, f6_breadth, f7_alignment, f8_streak,
         f9_rsi, f10_macd, f11_bollinger, f12_ema_trend, f13_support_resistance, f14_atr,
         price_at_signal, price_5d_later, outcome, return_1d, return_3d, return_5d, return_10d, max_drawdown, max_profit,
         data_source)
       VALUES ?`,
      [batch]
    );
    inserted += result.affectedRows;
    console.log(`  [${Math.min(i + BATCH, rowsToInsert.length)}/${rowsToInsert.length}] inserted so far: ${inserted}`);
  }

  console.log(`\nDone. ${inserted} rows inserted (data_source='backfill_v2'), ${rowsToInsert.length - inserted} skipped (already existed).`);
  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
