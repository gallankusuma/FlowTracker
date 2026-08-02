/**
 * awo_regime.js — Adaptive Weight Optimizer: Market Regime Detection
 * ──────────────────────────────────────────────────────────────────
 * Detects current market regime (TRENDING / RANGING / VOLATILE) and
 * provides regime-specific optimal weights.
 *
 * Exports:
 *   detectRegime(pool, stats)  — detect current market regime
 *   getRegimeWeights(regime)   — get regime-specific weights
 */

'use strict';

const statsMod = require('./modules/statistics');

// Default weights per regime (initial values — will be overridden by optimizer)
const REGIME_WEIGHTS = {
  TRENDING: {
    f1: 0.15, f2: 0.22, f3: 0.10, f4: 0.18,
    f5: 0.12, f6: 0.08, f7: 0.10, f8: 0.05,
  },
  RANGING: {
    f1: 0.25, f2: 0.10, f3: 0.12, f4: 0.08,
    f5: 0.08, f6: 0.12, f7: 0.18, f8: 0.07,
  },
  VOLATILE: {
    f1: 0.18, f2: 0.12, f3: 0.18, f4: 0.10,
    f5: 0.08, f6: 0.15, f7: 0.12, f8: 0.07,
  },
  DEFAULT: {
    f1: 0.20, f2: 0.15, f3: 0.12, f4: 0.12,
    f5: 0.10, f6: 0.12, f7: 0.12, f8: 0.07,
  },
};

/**
 * Detect current market regime from latest market data
 * Uses 3 signals: breadth, volatility, and trend strength
 */
async function detectRegime(pool) {
  try {
    // 1. Get latest date
    const [dateRows] = await pool.query(
      'SELECT DISTINCT date FROM idx_broker_summary ORDER BY date DESC LIMIT 20'
    );
    if (dateRows.length === 0) return { regime: 'DEFAULT', confidence: 0, details: {} };

    const toStr = d => (d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0]);
    const dates = dateRows.map(r => toStr(r.date));
    const latestDate = dates[0];

    // 2. Market breadth: % of stocks with positive net flow today
    const [breadthRows] = await pool.query(`
      SELECT stock_code,
        SUM(buy_val - sell_val) as net_val
      FROM idx_broker_summary WHERE date = ?
      GROUP BY stock_code
      HAVING SUM(buy_val + sell_val) > 0
    `, [latestDate]);

    const totalStocks = breadthRows.length;
    const positiveStocks = breadthRows.filter(r => Number(r.net_val) > 0).length;
    const breadthPct = totalStocks > 0 ? (positiveStocks / totalStocks) * 100 : 50;

    // 3. Volume anomaly: average volume Z-score across stocks
    const [volRows] = await pool.query(`
      SELECT stock_code, volume
      FROM idx_stock_prices
      WHERE date = ? AND volume > 0
    `, [latestDate]);

    // Get historical volumes for z-score calculation (last 20 days)
    const priceDates = dates.slice(0, Math.min(20, dates.length));
    let avgVolZ = 0;
    if (priceDates.length > 5 && volRows.length > 0) {
      const [histVols] = await pool.query(`
        SELECT stock_code, AVG(volume) as avg_vol, STDDEV(volume) as std_vol
        FROM idx_stock_prices
        WHERE date IN (?) AND volume > 0
        GROUP BY stock_code
        HAVING COUNT(*) >= 5
      `, [priceDates]);

      const volMap = {};
      for (const r of histVols) volMap[r.stock_code] = r;

      const zScores = [];
      for (const r of volRows) {
        const hist = volMap[r.stock_code];
        if (hist && Number(hist.std_vol) > 0) {
          const z = (Number(r.volume) - Number(hist.avg_vol)) / Number(hist.std_vol);
          zScores.push(z);
        }
      }
      avgVolZ = zScores.length > 0 ? statsMod.mean(zScores) : 0;
    }

    // 4. Price trend consistency: % of stocks with positive change
    const [changeRows] = await pool.query(`
      SELECT stock_code, change_pct
      FROM idx_stock_prices
      WHERE date = ?
    `, [latestDate]);

    const positiveChanges = changeRows.filter(r => Number(r.change_pct) > 0).length;
    const trendConsistency = changeRows.length > 0 ? (positiveChanges / changeRows.length) * 100 : 50;

    // 5. Average absolute change (volatility proxy)
    const absChanges = changeRows.map(r => Math.abs(Number(r.change_pct || 0)));
    const avgAbsChange = absChanges.length > 0 ? statsMod.mean(absChanges) : 0;

    // 6. Multi-day trend: check if breadth has been consistently directional
    let multiDayTrend = 'MIXED';
    if (dates.length >= 5) {
      const recentDates = dates.slice(0, 5);
      const [multiRows] = await pool.query(`
        SELECT date,
          SUM(CASE WHEN buy_val > sell_val THEN 1 ELSE 0 END) / COUNT(*) * 100 as breadth
        FROM idx_broker_summary
        WHERE date IN (?)
        GROUP BY date
        ORDER BY date DESC
      `, [recentDates]);

      const breadths = multiRows.map(r => Number(r.breadth));
      const allAbove55 = breadths.every(b => b > 55);
      const allBelow45 = breadths.every(b => b < 45);
      if (allAbove55 || allBelow45) multiDayTrend = 'CONSISTENT';
    }

    // ── REGIME CLASSIFICATION ───────────────────────────────────
    let regime = 'DEFAULT';
    let confidence = 50;

    if (avgVolZ > 1.5 || avgAbsChange > 3.0) {
      // High volatility
      regime = 'VOLATILE';
      confidence = Math.min(95, 60 + Math.round(avgVolZ * 10));
    } else if (
      (trendConsistency > 62 || trendConsistency < 38) &&
      multiDayTrend === 'CONSISTENT' &&
      breadthPct > 55
    ) {
      // Strong consistent trend
      regime = 'TRENDING';
      confidence = Math.min(95, 50 + Math.round(Math.abs(trendConsistency - 50)));
    } else if (avgAbsChange < 1.5 && Math.abs(breadthPct - 50) < 15) {
      // Low volatility, balanced breadth
      regime = 'RANGING';
      confidence = Math.min(85, 50 + Math.round((1.5 - avgAbsChange) * 20));
    }

    return {
      regime,
      confidence,
      date: latestDate,
      details: {
        breadthPct: Math.round(breadthPct * 10) / 10,
        trendConsistency: Math.round(trendConsistency * 10) / 10,
        avgVolZ: Math.round(avgVolZ * 100) / 100,
        avgAbsChange: Math.round(avgAbsChange * 100) / 100,
        multiDayTrend,
        totalStocks,
      },
    };
  } catch (err) {
    console.error('Regime detection error:', err.message);
    return { regime: 'DEFAULT', confidence: 0, error: err.message };
  }
}

/**
 * Get weights for a given regime
 * First checks if optimizer has saved optimized weights, otherwise uses defaults
 */
function getRegimeWeights(regime, optimizedWeights = null) {
  if (optimizedWeights && optimizedWeights[regime]) {
    return optimizedWeights[regime];
  }
  return REGIME_WEIGHTS[regime] || REGIME_WEIGHTS.DEFAULT;
}

/**
 * Get regime history from signal history
 */
async function getRegimeHistory(pool) {
  try {
    const [rows] = await pool.query(`
      SELECT
        regime_at_signal as regime,
        COUNT(*) as total,
        SUM(outcome = 'WIN') as wins,
        SUM(outcome = 'LOSS') as losses,
        SUM(outcome = 'NEUTRAL') as neutral,
        ROUND(AVG(CASE WHEN return_5d IS NOT NULL THEN return_5d END), 2) as avg_return_5d
      FROM idx_signal_history
      WHERE outcome IS NOT NULL AND regime_at_signal IS NOT NULL
      GROUP BY regime_at_signal
    `);

    const result = {};
    for (const r of rows) {
      result[r.regime] = {
        total: Number(r.total),
        wins: Number(r.wins || 0),
        losses: Number(r.losses || 0),
        neutral: Number(r.neutral || 0),
        winRate: (Number(r.wins || 0) + Number(r.losses || 0)) > 0
          ? Math.round((Number(r.wins || 0) / (Number(r.wins || 0) + Number(r.losses || 0))) * 100)
          : 0,
        avgReturn5d: r.avg_return_5d,
      };
    }
    return result;
  } catch (err) {
    return {};
  }
}

module.exports = {
  REGIME_WEIGHTS,
  detectRegime,
  getRegimeWeights,
  getRegimeHistory,
};
