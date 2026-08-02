/**
 * awo_analyzer.js — Adaptive Weight Optimizer: Factor Analyzer
 * ─────────────────────────────────────────────────────────────
 * Analyzes historical signal outcomes to determine which factors
 * actually predict winning trades vs which are noise.
 *
 * Exports:
 *   analyzeFactorContributions(pool)  — full factor analysis report
 *   getFactorStats(pool)              — summary statistics per factor
 */

'use strict';

const stats = require('./modules/statistics');

// Factor names matching idx_signal_history columns
const FACTORS = [
  { key: 'f1_concentration', label: 'Smart Money',       short: 'f1' },
  { key: 'f2_trend',         label: 'Trend Consistency', short: 'f2' },
  { key: 'f3_volume_z',      label: 'Volume Z-Score',    short: 'f3' },
  { key: 'f4_momentum',      label: 'Price Momentum',    short: 'f4' },
  { key: 'f5_rel_strength',  label: 'Rel. Strength',     short: 'f5' },
  { key: 'f6_breadth',       label: 'Buyer Breadth',     short: 'f6' },
  { key: 'f7_alignment',     label: 'Price-Broker Align',short: 'f7' },
  { key: 'f8_streak',        label: 'Accum. Streak',     short: 'f8' },
  // Technical Analysis factors
  { key: 'f9_rsi',                label: 'RSI Zone',         short: 'f9' },
  { key: 'f10_macd',              label: 'MACD Signal',      short: 'f10' },
  { key: 'f11_bollinger',         label: 'Bollinger Pos.',   short: 'f11' },
  { key: 'f12_ema_trend',         label: 'EMA Trend',        short: 'f12' },
  { key: 'f13_support_resistance',label: 'S/R Proximity',    short: 'f13' },
  { key: 'f14_atr',               label: 'ATR Volatility',   short: 'f14' },
];

/**
 * Compute Information Coefficient for a factor
 * IC = correlation between factor score and subsequent return
 * Higher IC = more predictive factor
 */
function informationCoefficient(factorValues, returns) {
  if (factorValues.length < 10 || returns.length < 10) return 0;
  const n = Math.min(factorValues.length, returns.length);
  return stats.correlation(factorValues.slice(0, n), returns.slice(0, n));
}

/**
 * Split signals into HIGH/LOW groups for a factor and compute win rates
 * Uses median split (above median = HIGH, below = LOW)
 */
function splitAnalysis(signals, factorKey) {
  const values = signals.map(s => Number(s[factorKey] || 50)).filter(v => !isNaN(v));
  if (values.length < 10) return { winRateHigh: 0, winRateLow: 0, sampleHigh: 0, sampleLow: 0, lift: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  const high = signals.filter(s => Number(s[factorKey] || 50) >= median);
  const low  = signals.filter(s => Number(s[factorKey] || 50) < median);

  const winHigh = high.filter(s => s.outcome === 'WIN').length;
  const winLow  = low.filter(s => s.outcome === 'WIN').length;

  const wrHigh = high.length > 0 ? Math.round((winHigh / high.length) * 100) : 0;
  const wrLow  = low.length > 0 ? Math.round((winLow / low.length) * 100) : 0;

  return {
    winRateHigh: wrHigh,
    winRateLow: wrLow,
    sampleHigh: high.length,
    sampleLow: low.length,
    lift: wrHigh - wrLow, // positive lift = factor is predictive
    median: Math.round(median),
  };
}

/**
 * Compute quintile analysis for a factor (5 buckets for granular view)
 */
function quintileAnalysis(signals, factorKey) {
  const sorted = signals
    .filter(s => s[factorKey] != null && s.outcome != null)
    .sort((a, b) => Number(a[factorKey]) - Number(b[factorKey]));

  if (sorted.length < 20) return [];

  const bucketSize = Math.floor(sorted.length / 5);
  const quintiles = [];

  for (let q = 0; q < 5; q++) {
    const start = q * bucketSize;
    const end = q === 4 ? sorted.length : start + bucketSize;
    const bucket = sorted.slice(start, end);
    const wins = bucket.filter(s => s.outcome === 'WIN').length;
    const losses = bucket.filter(s => s.outcome === 'LOSS').length;

    quintiles.push({
      quintile: q + 1,
      label: ['Bottom 20%', 'Q2', 'Q3', 'Q4', 'Top 20%'][q],
      count: bucket.length,
      wins,
      losses,
      winRate: bucket.length > 0 ? Math.round((wins / bucket.length) * 100) : 0,
      avgScore: Math.round(stats.mean(bucket.map(s => Number(s[factorKey])))),
      avgReturn: bucket.filter(s => s.return_5d != null).length > 0
        ? Math.round(stats.mean(bucket.filter(s => s.return_5d != null).map(s => Number(s.return_5d))) * 100) / 100
        : null,
    });
  }

  return quintiles;
}

/**
 * Main analysis: per-factor contribution to win rate
 */
async function analyzeFactorContributions(pool) {
  // Load all signals with outcomes
  const [signals] = await pool.query(`
    SELECT data_date, stock_code, composite_score, signal_type, confidence, outcome,
           f1_concentration, f2_trend, f3_volume_z, f4_momentum,
           f5_rel_strength, f6_breadth, f7_alignment, f8_streak,
           f9_rsi, f10_macd, f11_bollinger, f12_ema_trend,
           f13_support_resistance, f14_atr,
           price_at_signal, price_5d_later,
           return_1d, return_3d, return_5d, return_10d,
           max_drawdown, max_profit, regime_at_signal
    FROM idx_signal_history
    WHERE outcome IS NOT NULL
    ORDER BY data_date DESC
  `);

  if (signals.length < 20) {
    return {
      error: 'Insufficient data',
      message: `Only ${signals.length} signals with outcomes. Need at least 20 for meaningful analysis.`,
      totalSignals: signals.length,
    };
  }

  // Overall stats
  const totalWins = signals.filter(s => s.outcome === 'WIN').length;
  const totalLosses = signals.filter(s => s.outcome === 'LOSS').length;
  const totalNeutral = signals.filter(s => s.outcome === 'NEUTRAL').length;
  const overallWinRate = (totalWins + totalLosses) > 0
    ? Math.round((totalWins / (totalWins + totalLosses)) * 100) : 0;

  // Per-factor analysis
  const factorAnalysis = {};
  for (const f of FACTORS) {
    const split = splitAnalysis(signals, f.key);
    const quintiles = quintileAnalysis(signals, f.key);

    // Information Coefficient (correlation with returns)
    const validSignals = signals.filter(s => s[f.key] != null && s.return_5d != null);
    const fVals = validSignals.map(s => Number(s[f.key]));
    const retVals = validSignals.map(s => Number(s.return_5d));
    const ic = informationCoefficient(fVals, retVals);

    // Monotonicity check: do quintile win rates increase monotonically?
    const qRates = quintiles.map(q => q.winRate);
    let monotonic = true;
    for (let i = 1; i < qRates.length; i++) {
      if (qRates[i] < qRates[i - 1] - 5) { monotonic = false; break; }
    }

    factorAnalysis[f.key] = {
      label: f.label,
      short: f.short,
      ...split,
      informationCoeff: Math.round(ic * 1000) / 1000,
      isMonotonic: monotonic,
      isPredictive: split.lift > 5 && Math.abs(ic) > 0.05,
      quintiles,
    };
  }

  // Rank factors by predictive power (lift * IC)
  const factorRanking = Object.entries(factorAnalysis)
    .map(([key, data]) => ({
      key,
      label: data.label,
      score: Math.round(data.lift * Math.max(Math.abs(data.informationCoeff), 0.01) * 10),
      lift: data.lift,
      ic: data.informationCoeff,
      isPredictive: data.isPredictive,
    }))
    .sort((a, b) => b.score - a.score);

  // Signal type breakdown
  const bySignalType = {};
  for (const s of signals) {
    if (!bySignalType[s.signal_type]) {
      bySignalType[s.signal_type] = { total: 0, wins: 0, losses: 0, neutral: 0 };
    }
    bySignalType[s.signal_type].total++;
    if (s.outcome === 'WIN') bySignalType[s.signal_type].wins++;
    if (s.outcome === 'LOSS') bySignalType[s.signal_type].losses++;
    if (s.outcome === 'NEUTRAL') bySignalType[s.signal_type].neutral++;
  }
  for (const st of Object.values(bySignalType)) {
    st.winRate = (st.wins + st.losses) > 0 ? Math.round((st.wins / (st.wins + st.losses)) * 100) : 0;
  }

  // Regime breakdown (if regime data exists)
  const byRegime = {};
  for (const s of signals) {
    const regime = s.regime_at_signal || 'UNKNOWN';
    if (!byRegime[regime]) byRegime[regime] = { total: 0, wins: 0, losses: 0 };
    byRegime[regime].total++;
    if (s.outcome === 'WIN') byRegime[regime].wins++;
    if (s.outcome === 'LOSS') byRegime[regime].losses++;
  }
  for (const r of Object.values(byRegime)) {
    r.winRate = (r.wins + r.losses) > 0 ? Math.round((r.wins / (r.wins + r.losses)) * 100) : 0;
  }

  return {
    summary: {
      totalSignals: signals.length,
      totalWins,
      totalLosses,
      totalNeutral,
      overallWinRate,
      dateRange: {
        from: signals.length > 0 ? signals[signals.length - 1].data_date : null,
        to: signals.length > 0 ? signals[0].data_date : null,
      },
    },
    factorAnalysis,
    factorRanking,
    bySignalType,
    byRegime,
    recommendations: generateRecommendations(factorAnalysis, factorRanking, overallWinRate),
  };
}

/**
 * Generate human-readable recommendations based on analysis
 */
function generateRecommendations(factorAnalysis, ranking, currentWinRate) {
  const recs = [];

  const noisyFactors = ranking.filter(f => !f.isPredictive);
  if (noisyFactors.length > 0) {
    recs.push({
      type: 'REDUCE_WEIGHT',
      priority: 'HIGH',
      message: `Factors with low predictive power: ${noisyFactors.map(f => f.label).join(', ')}. Reducing their weights should improve signal quality.`,
      factors: noisyFactors.map(f => f.key),
    });
  }

  const strongFactors = ranking.filter(f => f.isPredictive && f.lift > 10);
  if (strongFactors.length > 0) {
    recs.push({
      type: 'INCREASE_WEIGHT',
      priority: 'HIGH',
      message: `Strongest predictive factors: ${strongFactors.map(f => `${f.label} (lift: +${f.lift}%)`).join(', ')}. These should carry more weight.`,
      factors: strongFactors.map(f => f.key),
    });
  }

  if (currentWinRate < 55) {
    recs.push({
      type: 'RAISE_THRESHOLD',
      priority: 'MEDIUM',
      message: `Current overall win rate (${currentWinRate}%) is below 55%. Consider raising STRONG BUY threshold to only emit the highest-quality signals.`,
    });
  }

  return recs;
}

/**
 * Quick factor stats summary (lightweight endpoint)
 */
async function getFactorStats(pool) {
  const [rows] = await pool.query(`
    SELECT
      COUNT(*) as total,
      SUM(outcome = 'WIN') as wins,
      SUM(outcome = 'LOSS') as losses,
      SUM(outcome = 'NEUTRAL') as neutral,
      ROUND(AVG(f1_concentration), 1) as avg_f1,
      ROUND(AVG(f2_trend), 1) as avg_f2,
      ROUND(AVG(f3_volume_z), 1) as avg_f3,
      ROUND(AVG(f4_momentum), 1) as avg_f4,
      ROUND(AVG(f5_rel_strength), 1) as avg_f5,
      ROUND(AVG(f6_breadth), 1) as avg_f6,
      ROUND(AVG(f7_alignment), 1) as avg_f7,
      ROUND(AVG(f8_streak), 1) as avg_f8,
      ROUND(AVG(f9_rsi), 1) as avg_f9,
      ROUND(AVG(f10_macd), 1) as avg_f10,
      ROUND(AVG(f11_bollinger), 1) as avg_f11,
      ROUND(AVG(f12_ema_trend), 1) as avg_f12,
      ROUND(AVG(f13_support_resistance), 1) as avg_f13,
      ROUND(AVG(f14_atr), 1) as avg_f14
    FROM idx_signal_history
    WHERE outcome IS NOT NULL
  `);

  return rows[0] || {};
}

module.exports = {
  FACTORS,
  analyzeFactorContributions,
  getFactorStats,
  informationCoefficient,
  splitAnalysis,
  quintileAnalysis,
};
