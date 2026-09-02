'use strict';
/**
 * Build and populate `us_signal_history` — the US equivalent of
 * idx_signal_history, and the thing that makes US worth having.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 *
 * EXP-042 could not answer its own question. Not because the design was weak,
 * but because `idx_signal_history` holds 145 sessions, which at a 10-session
 * horizon is 12 non-overlapping anchors against Promotion Contract v1's bar of
 * 30. Every IDX experiment at the horizon this project actually trades runs
 * into the same wall, and waiting it out means ~April 2027.
 *
 * `us_stock_prices` now holds twenty years. At 10 sessions that is ~500
 * anchors. The point of a US layer is not that US signals are better -- nothing
 * says they are -- it is that US is the only place where these tests can have
 * power. This table is what converts that depth into something testable.
 *
 * ── NO LOOKAHEAD, AND WHERE IT COULD HAVE CREPT IN ───────────────────────────
 *
 * Each row is scored from `candles[0..i]` only. Two places would have leaked
 * the future if written the obvious way:
 *
 *   1. The market average for F5. Computing it once from today's table and
 *      applying it to every historical row would hand 2008 a number from 2026.
 *      It is read per date from a GROUP BY, and the row is SKIPPED when that
 *      date has no average rather than defaulting to 0 -- a default would be a
 *      silent claim that the market was flat.
 *
 *   2. Forward returns. They walk the TICKER'S OWN session index, so `return_10d`
 *      is ten of that ticker's trading days, not ten calendar days, and it is
 *      NULL when the bar does not exist yet. Never 0.
 *
 * ── WHAT THIS TABLE INHERITS AND CANNOT FIX ──────────────────────────────────
 *
 * SURVIVORSHIP, and it is worse here than on IDX. `modules/us_tickers.js` is a
 * present-day S&P 500 snapshot, so twenty years of history for today's members
 * silently excludes every company that failed, shrank out of the index, or was
 * acquired. Backfilling 2008 for the banks that SURVIVED 2008 is close to a
 * definition of the bias. Every result off this table is biased upward and says
 * so.
 *
 * Usage:
 *   node scraper/backfill_us_signal_history.js --create      # table only
 *   node scraper/backfill_us_signal_history.js               # full backfill
 *   node scraper/backfill_us_signal_history.js --from 2010-01-01
 *   node scraper/backfill_us_signal_history.js --only AAPL,MSFT --truncate
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { createPool } = require('./modules/db_config');
const { computeUSStockFactors } = require('./modules/us_score_engine');
const { DEFAULT_THRESHOLDS } = require('./modules/score_engine');
const { US_TICKERS } = require('./modules/us_tickers');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FROM = arg('--from', null);
const ONLY = arg('--only', null);
const CREATE_ONLY = argv.includes('--create');
const TRUNCATE = argv.includes('--truncate');

// Enough bars behind each row for every factor to be defined: the price/volume
// factors take 60, and computeWeeklyTrend needs 21 weekly bars (~105 sessions)
// before it stops returning NEUTRAL. Starting at 120 means the weekly trend is
// a real reading from the first row rather than a NEUTRAL that only reflects
// missing history.
const WARMUP = 120;
// Enough history behind the as-of bar for every factor, without carrying the
// whole series through each call.
const LOOKBACK = 400;
const HORIZONS = [1, 3, 5, 10, 20, 40, 60];
const CHUNK = 500;

const DDL = `
CREATE TABLE IF NOT EXISTS us_signal_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  data_date DATE NOT NULL,
  ticker VARCHAR(10) NOT NULL,
  composite_score DECIMAL(6,2) NULL,
  signal_type VARCHAR(16) NULL,
  f3_volume_z SMALLINT NULL,
  f4_momentum SMALLINT NULL,
  f5_rel_strength SMALLINT NULL,
  f9_rsi SMALLINT NULL,
  f10_macd SMALLINT NULL,
  f11_bollinger SMALLINT NULL,
  f12_ema_trend SMALLINT NULL,
  f13_support_resistance SMALLINT NULL,
  f14_atr SMALLINT NULL,
  price_at_signal DECIMAL(12,4) NULL,
  market_avg_change_pct DECIMAL(8,4) NULL,
  weekly_trend VARCHAR(10) NULL,
  trend_aligned TINYINT NULL,
  return_1d DECIMAL(10,4) NULL,
  return_3d DECIMAL(10,4) NULL,
  return_5d DECIMAL(10,4) NULL,
  return_10d DECIMAL(10,4) NULL,
  return_20d DECIMAL(10,4) NULL,
  return_40d DECIMAL(10,4) NULL,
  return_60d DECIMAL(10,4) NULL,
  max_drawdown_20d DECIMAL(10,4) NULL,
  max_profit_20d DECIMAL(10,4) NULL,
  thresholds_version VARCHAR(24) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_ticker_date (ticker, data_date),
  KEY idx_date (data_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const COLS = [
  'data_date', 'ticker', 'composite_score', 'signal_type',
  'f3_volume_z', 'f4_momentum', 'f5_rel_strength', 'f9_rsi', 'f10_macd',
  'f11_bollinger', 'f12_ema_trend', 'f13_support_resistance', 'f14_atr',
  'price_at_signal', 'market_avg_change_pct', 'weekly_trend', 'trend_aligned',
  'return_1d', 'return_3d', 'return_5d', 'return_10d', 'return_20d', 'return_40d', 'return_60d',
  'max_drawdown_20d', 'max_profit_20d', 'thresholds_version',
];

const r4 = v => (v === null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);

(async () => {
  const pool = createPool();
  await pool.query(DDL);
  console.log('us_signal_history ready');
  if (CREATE_ONLY) { await pool.end(); return; }
  if (TRUNCATE) { await pool.query('TRUNCATE TABLE us_signal_history'); console.log('truncated'); }

  // Point-in-time cross-sectional mean daily change, one row per date.
  // Early dates average over fewer tickers because fewer had listed --
  // that is the honest as-of value, and it is exactly why this is read per
  // date rather than computed once.
  const [avgRows] = await pool.query(
    'SELECT date, AVG(change_pct) avg_chg, COUNT(*) n FROM us_stock_prices GROUP BY date');
  const marketAvg = new Map();
  const marketN = new Map();
  for (const r of avgRows) {
    const d = r.date.toISOString().slice(0, 10);
    marketAvg.set(d, Number(r.avg_chg));
    marketN.set(d, r.n);
  }
  console.log(`market averages for ${marketAvg.size} sessions ` +
    `(${avgRows.length ? avgRows[0].date.toISOString().slice(0, 10) : '?'} onward)`);

  const tickers = ONLY ? ONLY.split(',').map(s => s.trim().toUpperCase()) : US_TICKERS;
  console.log(`tickers: ${tickers.length}   warmup ${WARMUP} bars   horizons ${HORIZONS.join('/')}d`);
  console.log('scored through modules/us_score_engine.js — the same function the live scanner calls');
  console.log('SURVIVORSHIP: today\'s S&P 500 members, twenty years back. Biased upward. Stated, not fixed.\n');

  const t0 = Date.now();
  let rowsWritten = 0, tickersDone = 0, tickersEmpty = 0, skippedNoAvg = 0, skippedNoScore = 0;

  for (const ticker of tickers) {
    const [px] = await pool.query(
      `SELECT date, open_price, high_price, low_price, close_price, volume
         FROM us_stock_prices WHERE ticker = ? ORDER BY date ASC`, [ticker]);
    if (px.length < WARMUP + 2) { tickersEmpty++; continue; }

    const candles = px.map(r => ({
      date: r.date.toISOString().slice(0, 10),
      open: Number(r.open_price), high: Number(r.high_price),
      low: Number(r.low_price), close: Number(r.close_price), volume: Number(r.volume),
    }));

    const batch = [];
    for (let i = WARMUP; i < candles.length; i++) {
      const asOf = candles[i].date;
      if (FROM && asOf < FROM) continue;

      const avg = marketAvg.get(asOf);
      // Missing is not zero. A date with no cross-sectional average cannot
      // produce an honest F5, so the row is dropped rather than invented.
      if (avg === undefined || !Number.isFinite(avg)) { skippedNoAvg++; continue; }

      // Strictly prior + the as-of bar. Nothing after index i is visible.
      const window = candles.slice(Math.max(0, i - LOOKBACK + 1), i + 1);
      const s = computeUSStockFactors(window, 'NEUTRAL', avg, { thresholds: DEFAULT_THRESHOLDS });
      if (!s) { skippedNoScore++; continue; }

      const entry = candles[i].close;
      const fwd = {};
      for (const h of HORIZONS) {
        const b = candles[i + h];
        fwd[h] = b && entry > 0 ? r4(((b.close - entry) / entry) * 100) : null;
      }

      // Path stats over the next 20 of THIS ticker's sessions. Null when the
      // path is not complete, so a truncated window never reads as a calm one.
      let dd = null, mp = null;
      if (candles[i + 20] && entry > 0) {
        let lo = Infinity, hi = -Infinity;
        for (let k = i + 1; k <= i + 20; k++) {
          lo = Math.min(lo, candles[k].low);
          hi = Math.max(hi, candles[k].high);
        }
        dd = r4(((lo - entry) / entry) * 100);
        mp = r4(((hi - entry) / entry) * 100);
      }

      batch.push([
        asOf, ticker, r4(s.composite), s.signal,
        s.factors.volumeZ, s.factors.momentum, s.factors.relStrength, s.factors.rsi,
        s.factors.macd, s.factors.bollinger, s.factors.emaTrend, s.factors.supportResistance, s.factors.atr,
        r4(entry), r4(avg), s.weeklyTrend, s.trendAligned === null ? null : (s.trendAligned ? 1 : 0),
        fwd[1], fwd[3], fwd[5], fwd[10], fwd[20], fwd[40], fwd[60],
        dd, mp, 'DEFAULT_THRESHOLDS',
      ]);
    }

    for (let i = 0; i < batch.length; i += CHUNK) {
      await pool.query(
        `INSERT INTO us_signal_history (${COLS.join(', ')}) VALUES ?
         ON DUPLICATE KEY UPDATE composite_score=VALUES(composite_score), signal_type=VALUES(signal_type),
           f3_volume_z=VALUES(f3_volume_z), f4_momentum=VALUES(f4_momentum), f5_rel_strength=VALUES(f5_rel_strength),
           f9_rsi=VALUES(f9_rsi), f10_macd=VALUES(f10_macd), f11_bollinger=VALUES(f11_bollinger),
           f12_ema_trend=VALUES(f12_ema_trend), f13_support_resistance=VALUES(f13_support_resistance),
           f14_atr=VALUES(f14_atr), price_at_signal=VALUES(price_at_signal),
           market_avg_change_pct=VALUES(market_avg_change_pct), weekly_trend=VALUES(weekly_trend),
           trend_aligned=VALUES(trend_aligned), return_1d=VALUES(return_1d), return_3d=VALUES(return_3d),
           return_5d=VALUES(return_5d), return_10d=VALUES(return_10d), return_20d=VALUES(return_20d),
           return_40d=VALUES(return_40d), return_60d=VALUES(return_60d),
           max_drawdown_20d=VALUES(max_drawdown_20d), max_profit_20d=VALUES(max_profit_20d),
           thresholds_version=VALUES(thresholds_version)`,
        [batch.slice(i, i + CHUNK)]);
    }
    rowsWritten += batch.length;
    tickersDone++;
    if (tickersDone % 25 === 0) {
      const el = (Date.now() - t0) / 1000;
      console.log(`  ${String(tickersDone).padStart(3)}/${tickers.length} ${ticker.padEnd(6)} ` +
        `+${String(batch.length).padStart(5)} rows   total ${rowsWritten}   ${el.toFixed(0)}s`);
    }
  }

  const [[sum]] = await pool.query(
    `SELECT COUNT(*) n, COUNT(DISTINCT ticker) tk, COUNT(DISTINCT data_date) sessions,
            MIN(data_date) mn, MAX(data_date) mx,
            SUM(return_10d IS NOT NULL) has10, SUM(return_60d IS NOT NULL) has60
       FROM us_signal_history`);

  console.log(`\n${'='.repeat(72)}`);
  console.log(`tickers scored ${tickersDone}, too short ${tickersEmpty}, rows written ${rowsWritten}`);
  console.log(`skipped: ${skippedNoAvg} no market average, ${skippedNoScore} unscoreable`);
  console.log(`table: ${sum.n} rows, ${sum.tk} tickers, ${sum.sessions} sessions, ` +
    `${sum.mn && sum.mn.toISOString().slice(0, 10)} .. ${sum.mx && sum.mx.toISOString().slice(0, 10)}`);
  console.log(`resolved outcomes: ${sum.has10} rows with return_10d, ${sum.has60} with return_60d`);
  console.log(`\nnon-overlapping anchors, the number that gated EXP-042 (S1 needs >= 30):`);
  for (const h of HORIZONS) {
    const a = Math.floor(sum.sessions / h);
    console.log(`  ${String(h).padStart(2)}d horizon: ${String(a).padStart(5)} anchors  ${a >= 30 ? 'OK' : 'BELOW BAR'}`);
  }
  console.log(`\nelapsed ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await pool.end();
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
