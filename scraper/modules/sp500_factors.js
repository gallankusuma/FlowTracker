'use strict';
/**
 * modules/sp500_factors.js — the S&P 500 index factor read, extracted from
 * server.js on 2026-09-05.
 *
 * ── WHY IT MOVED ─────────────────────────────────────────────────────────────
 *
 * `sp500_factor_history` held exactly TWO rows. Not because its writer was
 * broken, but because `GET /api/sp500-factors` was its only caller, so the
 * history only grew when a human opened the page. CRONTAB.md records the
 * identical failure on the IDX side, and this is the second table in this
 * project found in that state.
 *
 * Backfilling it meant computing the read as of every past session, and the
 * function lived inside server.js with no export and a module-level `pool`.
 * Reimplementing it in a script would have been the drift defect
 * modules/score_engine.js and modules/us_score_engine.js both exist to prevent,
 * so it moved instead: one implementation, used by the live snapshot, the
 * nightly cron and the backfill alike.
 *
 * ── NO LOOKAHEAD ─────────────────────────────────────────────────────────────
 *
 * Candles are truncated at `asOf` BEFORE the 60-bar slice, and breadth reads
 * exactly the session being scored rather than the newest one in the table.
 * Passing `asOf = null` keeps the original live behaviour.
 */

const { calcTechnicalFactors } = require('../awo_technical');
const { computeConfidence, computeRiskModifier, combineFinalScore } = require('./awo_factors');

const toDateStr = d => (d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0]);

/**
 * The index factor read, AS OF a given session.
 *
 * Parameterised 2026-09-05 so `sp500_factor_history` could be backfilled through
 * the same function the live snapshot uses, rather than a second copy of the
 * arithmetic. Every ingredient was already as-of-able -- the technicals take the
 * last 60 bars up to the date, and breadth is the share of us_stock_prices rows
 * on that date that closed up -- the function simply had no way to be asked
 * about any date but the newest.
 *
 * NO LOOKAHEAD: candles are truncated at `asOf` before the 60-bar slice, and
 * breadth reads exactly that session. Passing null keeps the original behaviour,
 * which is what every existing caller wants.
 */
async function computeSP500Factors(pool, asOf = null) {
  const [rows] = await pool.query(
    asOf
      ? `SELECT date, open_price o, high_price h, low_price l, close_price c, volume v
           FROM sp500_history WHERE date <= ? ORDER BY date ASC`
      : `SELECT date, open_price o, high_price h, low_price l, close_price c, volume v
           FROM sp500_history ORDER BY date ASC`,
    asOf ? [asOf] : []
  );
  if (rows.length < 30) return null;
  const candles = rows.map(r => ({
    date: toDateStr(r.date), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v),
  }));

  const tech = calcTechnicalFactors(candles.slice(-60));

  // Breadth is read for the SESSION BEING SCORED. Without `asOf` that is the
  // newest price date, which is the live behaviour; with it, the same session
  // the candles end on.
  let asOfDate;
  if (asOf) {
    asOfDate = candles[candles.length - 1].date;
  } else {
    const [[latestPriceDate]] = await pool.query('SELECT MAX(date) d FROM us_stock_prices');
    asOfDate = latestPriceDate?.d ? toDateStr(latestPriceDate.d) : candles[candles.length - 1].date;
  }
  const [changeRows] = await pool.query(`SELECT change_pct FROM us_stock_prices WHERE date = ?`, [asOfDate]);
  const total = changeRows.length;
  const positive = changeRows.filter(r => Number(r.change_pct) > 0).length;
  const breadthPct = total > 0 ? (positive / total) * 100 : 50;
  const f_breadth = Math.round(breadthPct);

  // f14 (ATR) applies as a Risk Modifier, not a 6th vote in the average — no
  // factor-coverage concept here (index-level breadth + tech factors are
  // always full weight), so Confidence is always 1.0. See combineFinalScore.
  const rawComposite6 = (f_breadth + tech.f9 + tech.f10 + tech.f11 + tech.f12 + tech.f13) / 6;
  const composite = combineFinalScore(rawComposite6, computeConfidence(undefined), computeRiskModifier(tech.f14));
  const trend = composite >= 60 ? 'BULLISH' : composite <= 40 ? 'BEARISH' : 'NEUTRAL';

  return {
    date: candles[candles.length - 1].date,
    composite, trend,
    factors: {
      breadth: f_breadth, rsi: tech.f9, macd: tech.f10, bollinger: tech.f11,
      emaTrend: tech.f12, supportResistance: tech.f13, atr: tech.f14,
    },
    breadthPct: Math.round(breadthPct * 100) / 100,
    // How many names the breadth figure rests on. Early sessions carry far
    // fewer tickers than today's 400+, and a breadth read on 30 names is not
    // the same measurement as one on 400 even though the column looks alike.
    breadthSample: total,
    indicators: tech.indicators,
  };
}

async function saveSP500FactorSnapshot(pool, asOf = null) {
  const f = await computeSP500Factors(pool, asOf);
  if (!f) return null;
  await pool.query(
    `INSERT INTO sp500_factor_history
      (date, composite_score, trend, f_breadth, f_rsi, f_macd, f_bollinger, f_ema_trend, f_support_resistance, f_atr, breadth_pct)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE composite_score=VALUES(composite_score), trend=VALUES(trend),
       f_breadth=VALUES(f_breadth), f_rsi=VALUES(f_rsi), f_macd=VALUES(f_macd), f_bollinger=VALUES(f_bollinger),
       f_ema_trend=VALUES(f_ema_trend), f_support_resistance=VALUES(f_support_resistance), f_atr=VALUES(f_atr),
       breadth_pct=VALUES(breadth_pct)`,
    [f.date, f.composite, f.trend, f.factors.breadth, f.factors.rsi, f.factors.macd, f.factors.bollinger,
     f.factors.emaTrend, f.factors.supportResistance, f.factors.atr, f.breadthPct]
  );
  return f;
}

module.exports = { computeSP500Factors, saveSP500FactorSnapshot };
