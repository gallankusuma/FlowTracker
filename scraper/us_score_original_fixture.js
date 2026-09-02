'use strict';
/**
 * VERBATIM pre-extraction copy of server.js's US scoring block, taken from the
 * commit before modules/us_score_engine.js existed, wrapped in a factory so its
 * dependencies can be injected.
 *
 * It exists for ONE reason: to prove the extraction changed nothing. Moving
 * scoring code is how this project has been bitten before -- the F14
 * directional-weight bug lived in exactly such a duplicate until an external
 * review found it -- so the move is CHECKED, not asserted. Nothing else may
 * import this: it is a frozen artefact, not a second implementation to keep up
 * to date. If modules/us_score_engine.js changes deliberately, this file does
 * not follow; the test that compares them is retired instead.
 *
 * It sits in scraper/ rather than a subdirectory because the body below still
 * contains `require('./awo_technical')` verbatim and that path has to resolve.
 */
module.exports = function makeOriginal(deps) {
  const {
    DEFAULT_WEIGHTS, f3_volumeZ, f4_momentum, f5_relStrength,
    combineFinalScore, computeConfidence, computeRiskModifier,
    classifySignal, computeConvictionTier,
  } = deps;

  // f14 excluded from this renormalized set — it applies as a Risk Modifier
  // (computeRiskModifier), not a direct weighted vote.
  const US_TECH_WEIGHTS = (() => {
    const base = {
      f3: DEFAULT_WEIGHTS.f3, f4: DEFAULT_WEIGHTS.f4, f5: DEFAULT_WEIGHTS.f5,
      f9: DEFAULT_WEIGHTS.f9, f10: DEFAULT_WEIGHTS.f10, f11: DEFAULT_WEIGHTS.f11,
      f12: DEFAULT_WEIGHTS.f12, f13: DEFAULT_WEIGHTS.f13,
    };
    const sum = Object.values(base).reduce((a, b) => a + b, 0);
    return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v / sum]));
  })();

  /**
   * Technical + price-derived composite/signal/tradePlan for one ticker's candle
   * history — shared by the US scanner and deep-dive routes. `marketAvgChangePct`
   * is the cross-sectional mean daily change across all US_TICKERS for the SAME
   * day as the last candle in `candles` — passed in rather than computed here so
   * callers can supply the correct point-in-time value (no lookahead) when this
   * runs inside a historical rolling-window loop.
   */
  function computeUSStockFactors(candles, marketDirection, marketAvgChangePct = 0) {
    if (!candles || candles.length < 15) return null;
    const { calcTechnicalFactors, computeWeeklyTrend, computeTradePlan } = require('./awo_technical');
    const tech = calcTechnicalFactors(candles.slice(-60));

    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume || 0);
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const dailyChangePct = prev && prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : 0;

    const f3 = f3_volumeZ(volumes, dailyChangePct);
    const f4 = f4_momentum(closes);
    const f5 = f5_relStrength(dailyChangePct, marketAvgChangePct);

    const rawComposite8 =
      f3 * US_TECH_WEIGHTS.f3 + f4 * US_TECH_WEIGHTS.f4 + f5 * US_TECH_WEIGHTS.f5 +
      tech.f9 * US_TECH_WEIGHTS.f9 + tech.f10 * US_TECH_WEIGHTS.f10 + tech.f11 * US_TECH_WEIGHTS.f11 +
      tech.f12 * US_TECH_WEIGHTS.f12 + tech.f13 * US_TECH_WEIGHTS.f13;
    const composite = combineFinalScore(rawComposite8, computeConfidence(undefined), computeRiskModifier(tech.f14));
    const signal = classifySignal(composite);

    let weeklyTrend = null;
    try { weeklyTrend = computeWeeklyTrend(candles); } catch {}
    let trendAligned = null;
    if (weeklyTrend && weeklyTrend.trend !== 'NEUTRAL') {
      const isBullishSignal = signal === 'STRONG BUY' || signal === 'BUY';
      const isBearishSignal = signal === 'SELL' || signal === 'STRONG SELL';
      if (isBullishSignal) trendAligned = weeklyTrend.trend === 'BULLISH';
      else if (isBearishSignal) trendAligned = weeklyTrend.trend === 'BEARISH';
    }

    const currentPrice = last.close;
    let tradePlan = null;
    try { tradePlan = computeTradePlan(currentPrice, signal, tech.indicators?.atr ?? null, tech.indicators?.sr ?? null); } catch {}

    const convictionTier = computeConvictionTier({ source: 'awo', trendAligned, signal, marketDirection, market: 'US' });

    return {
      composite, signal,
      factors: {
        volumeZ: Math.round(f3), momentum: Math.round(f4), relStrength: Math.round(f5),
        rsi: Math.round(tech.f9), macd: Math.round(tech.f10), bollinger: Math.round(tech.f11),
        emaTrend: Math.round(tech.f12), supportResistance: Math.round(tech.f13), atr: Math.round(tech.f14),
      },
      indicators: tech.indicators, weeklyTrend: weeklyTrend?.trend ?? null, trendAligned, tradePlan,
      convictionTier: convictionTier.tier, sizeMultiplier: convictionTier.sizeMultiplier, tierReason: convictionTier.reason,
    };
  }
  return { computeUSStockFactors, US_TECH_WEIGHTS };
};
