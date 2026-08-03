/**
 * harmonicEngine.js
 * ─────────────────────────────────────────────────────────────
 * Harmonic pattern detection, Wyckoff phase, Smart Money
 * Concepts (SMC), Volume Profile, and Master Scoring engine.
 *
 * Exports:
 *   detectHarmonicPatterns(ohlc, ticker)
 *   detectWyckoffPhase(ohlc)
 *   detectOrderBlocks(ohlc)
 *   detectFairValueGaps(ohlc)
 *   detectLiquiditySweeps(ohlc)
 *   buildVolumeProfile(ohlc)
 *   calcUltraConviction(pattern, structureData, wyckoffData, smcData, volProfileData, brokerData, weights?)
 */

'use strict';

// ─── Harmonic Pattern Fibonacci Ratios ──────────────────────
const PATTERNS = {
  GARTLEY:   { XB:[0.618,0.618], AC:[0.382,0.886], BD:[1.272,1.618], XD:[0.786,0.786] },
  BAT:       { XB:[0.382,0.500], AC:[0.382,0.886], BD:[1.618,2.618], XD:[0.886,0.886] },
  CRAB:      { XB:[0.382,0.618], AC:[0.382,0.886], BD:[2.240,3.618], XD:[1.618,1.618] },
  BUTTERFLY: { XB:[0.786,0.786], AC:[0.382,0.886], BD:[1.618,2.618], XD:[1.272,1.618] },
  SHARK:     { XB:[0.446,0.618], AC:[1.130,1.618], BD:[1.618,2.236], XD:[0.886,1.130] },
  CYPHER:    { XB:[0.382,0.618], AC:[1.130,1.414], BD:[1.272,2.000], XD:[0.786,0.786] },
  ABCD:      { AB_CD: [0.618, 1.618] },
};

const TOLERANCE = 0.10;  // 10% tolerance on fib ratio matching

function between(val, lo, hi) {
  return val >= lo * (1 - TOLERANCE) && val <= hi * (1 + TOLERANCE);
}

// ─── Swing Point Detection ──────────────────────────────────
function findSwings(ohlc, leftBars = 5, rightBars = 3) {
  const swings = [];
  for (let i = leftBars; i < ohlc.length - rightBars; i++) {
    const bar = ohlc[i];
    const leftSlice  = ohlc.slice(i - leftBars, i);
    const rightSlice = ohlc.slice(i + 1, i + rightBars + 1);

    const isHigh = leftSlice.every(c => c.high <= bar.high) &&
                   rightSlice.every(c => c.high < bar.high);
    const isLow  = leftSlice.every(c => c.low >= bar.low) &&
                   rightSlice.every(c => c.low > bar.low);

    if (isHigh) swings.push({ type: 'high', index: i, price: bar.high, date: bar.date });
    if (isLow)  swings.push({ type: 'low',  index: i, price: bar.low,  date: bar.date });
  }
  return swings;
}

// ─── Fibonacci Score ────────────────────────────────────────
function fibAccuracy(actual, target, tol = TOLERANCE) {
  const diff = Math.abs(actual - target);
  if (diff <= tol * target) return Math.round(100 * (1 - diff / (tol * target || 1)));
  return 0;
}

// ─── Detect Harmonic Patterns (XABCD) ──────────────────────
function detectHarmonicPatterns(ohlc, ticker, options = {}) {
  const maxPatternSpan = options.maxPatternSpan || 60;   // max candles from X to D
  const maxDAge        = options.maxDAge || 5;            // D must be within N recent candles
  const maxPrzGap      = options.maxPrzGap || 0.08;       // price vs D max 8%
  const swingLeft      = options.swingLeft || 5;
  const swingRight     = options.swingRight || 3;
  if (!ohlc || ohlc.length < 30) return [];

  const swings = findSwings(ohlc, swingLeft, swingRight);
  if (swings.length < 5) return [];

  const results = [];

  // Try all combinations of 5 consecutive swing points
  for (let s = 0; s <= swings.length - 5; s++) {
    const pts = swings.slice(s, s + 5);
    const [X, A, B, C, D] = pts;

    const XA = Math.abs(A.price - X.price);
    if (XA === 0) continue;

    const AB = Math.abs(B.price - A.price);
    const BC = Math.abs(C.price - B.price);
    const CD = Math.abs(D.price - C.price);
    const XD_range = Math.abs(D.price - X.price);

    const XB_ratio = AB / XA;
    const AC_ratio = BC / AB || 0;
    const BD_ratio = CD / BC || 0;
    const XD_ratio = XD_range / XA;

    // Determine direction
    const isBullish = X.type === 'low' && A.type === 'high';
    const isBearish = X.type === 'high' && A.type === 'low';
    if (!isBullish && !isBearish) continue;

    const direction = isBullish ? 'BULLISH' : 'BEARISH';

    // ── INVALIDATION RULES (from Harmonic Basic Concept) ──

    // Rule: B must NOT cross X
    if (isBullish && B.price < X.price) continue;
    if (isBearish && B.price > X.price) continue;

    // Rule: C should NOT cross A (for standard patterns)
    if (isBullish && C.price > A.price) continue;
    if (isBearish && C.price < A.price) continue;

    // Rule: XA must be a significant impulse (min 2% move)
    const xaPercent = (XA / Math.min(X.price, A.price)) * 100;
    if (xaPercent < 2) continue;

    // Rule: Pattern span limit (X to D must be within maxPatternSpan candles)
    const patternSpan = D.index - X.index;
    if (patternSpan > maxPatternSpan) continue;

    // Rule: D must be FRESH (within maxDAge candles from end)
    const candlesAfterD = ohlc.length - 1 - D.index;
    if (candlesAfterD > maxDAge) continue;

    // Rule: Current price must be near PRZ
    const lastClose = ohlc[ohlc.length - 1].close;
    const dPriceGap = Math.abs(lastClose - D.price) / D.price;
    if (dPriceGap > maxPrzGap) continue;

    // Try matching against known patterns
    for (const [patName, ratios] of Object.entries(PATTERNS)) {
      if (patName === 'ABCD') continue; // handled separately

      let totalFib = 0, matches = 0;

      if (between(XB_ratio, ratios.XB[0], ratios.XB[1])) {
        matches++;
        totalFib += fibAccuracy(XB_ratio, (ratios.XB[0] + ratios.XB[1]) / 2);
      }
      if (between(AC_ratio, ratios.AC[0], ratios.AC[1])) {
        matches++;
        totalFib += fibAccuracy(AC_ratio, (ratios.AC[0] + ratios.AC[1]) / 2);
      }
      if (between(BD_ratio, ratios.BD[0], ratios.BD[1])) {
        matches++;
        totalFib += fibAccuracy(BD_ratio, (ratios.BD[0] + ratios.BD[1]) / 2);
      }
      if (between(XD_ratio, ratios.XD[0], ratios.XD[1])) {
        matches++;
        totalFib += fibAccuracy(XD_ratio, (ratios.XD[0] + ratios.XD[1]) / 2);
      }

      if (matches < 3) continue;  // need at least 3 of 4 ratios to match

      // AB=CD confluence bonus
      const abcdRatio = CD / (AB || 1);
      const abcdBonus = (abcdRatio > 0.85 && abcdRatio < 1.15) ? 12 : 0;
      const fib_score = Math.min(100, Math.round(totalFib / 4) + abcdBonus);

      // Entry zone: around D point
      const entry_price = D.price;
      const entrySpread = XA * 0.05;
      const entry_min = direction === 'BULLISH'
        ? Math.round(entry_price - entrySpread)
        : Math.round(entry_price + entrySpread);
      const entry_max = entry_price;

      // Stop loss: Bullish = below lowest of X,D; Bearish = above highest of X,D
      const stop_loss = direction === 'BULLISH'
        ? Math.round(Math.min(X.price, D.price) * 0.97)
        : Math.round(Math.max(X.price, D.price) * 1.03);

      // Targets: T1 = 0.382 retracement of AD, T2 = 0.618
      const AD = Math.abs(A.price - D.price);
      const target_1 = direction === 'BULLISH'
        ? Math.round(D.price + AD * 0.382)
        : Math.round(D.price - AD * 0.382);
      const target_2 = direction === 'BULLISH'
        ? Math.round(D.price + AD * 0.618)
        : Math.round(D.price - AD * 0.618);

      // Risk:Reward (always positive ratio)
      const risk = Math.abs(entry_price - stop_loss) || 1;
      const reward = Math.abs(target_1 - entry_price);
      const risk_reward = Math.round((reward / risk) * 10) / 10;

      // Sanity check: for bearish, SL must be > entry; for bullish, SL must be < entry
      if (direction === 'BULLISH' && stop_loss >= entry_price) continue;
      if (direction === 'BEARISH' && stop_loss <= entry_price) continue;

      results.push({
        ticker,
        pattern_type: patName,
        direction,
        action: direction === 'BULLISH' ? 'BUY' : 'SELL/AVOID',
        fib_score,
        risk_reward,
        entry_price: Math.round(entry_price),
        entry_min: Math.round(Math.min(entry_min, entry_max)),
        entry_max: Math.round(Math.max(entry_min, entry_max)),
        stop_loss,
        target_1,
        target_2,
        pattern_data: {
          X: { price: X.price, date: X.date, index: X.index },
          A: { price: A.price, date: A.date, index: A.index },
          B: { price: B.price, date: B.date, index: B.index },
          C: { price: C.price, date: C.date, index: C.index },
          D: { price: D.price, date: D.date, index: D.index },
        },
        ratios: { XB: XB_ratio, AC: AC_ratio, BD: BD_ratio, XD: XD_ratio },
      });
    }
  }

  // ABCD detection (simpler: 3 swings)
  for (let s = 0; s <= swings.length - 4; s++) {
    const [sA, sB, sC, sD] = swings.slice(s, s + 4);
    const AB_len = Math.abs(sB.price - sA.price);
    const CD_len = Math.abs(sD.price - sC.price);
    if (AB_len === 0) continue;
    const ratio = CD_len / AB_len;
    if (!between(ratio, PATTERNS.ABCD.AB_CD[0], PATTERNS.ABCD.AB_CD[1])) continue;

    const isBull = sA.type === 'high' && sD.type === 'low';
    const isBear = sA.type === 'low'  && sD.type === 'high';
    if (!isBull && !isBear) continue;

    const direction = isBull ? 'BULLISH' : 'BEARISH';

    // ABCD recency: D must be fresh
    const abcdCandlesAfterD = ohlc.length - 1 - sD.index;
    if (abcdCandlesAfterD > maxDAge) continue;

    // ABCD: pattern span limit
    const abcdSpan = sD.index - sA.index;
    if (abcdSpan > maxPatternSpan) continue;

    // ABCD: current price near D
    const abcdLastClose = ohlc[ohlc.length - 1].close;
    const abcdGap = Math.abs(abcdLastClose - sD.price) / sD.price;
    if (abcdGap > maxPrzGap) continue;

    const entry_price = sD.price;
    const stop_loss = direction === 'BULLISH'
      ? Math.round(Math.min(sA.price, sD.price) * 0.97)
      : Math.round(Math.max(sA.price, sD.price) * 1.03);
    const reward_range = AB_len * 0.618;
    const target_1 = direction === 'BULLISH'
      ? Math.round(sD.price + reward_range)
      : Math.round(sD.price - reward_range);
    const target_2 = direction === 'BULLISH'
      ? Math.round(sD.price + AB_len)
      : Math.round(sD.price - AB_len);
    const risk = Math.abs(entry_price - stop_loss) || 1;
    const risk_reward = Math.round((Math.abs(target_1 - entry_price) / risk) * 10) / 10;

    results.push({
      ticker,
      pattern_type: 'ABCD',
      direction,
      fib_score: Math.round(fibAccuracy(ratio, 1.0) * 0.7),
      risk_reward,
      entry_price: Math.round(entry_price),
      entry_min: Math.round(entry_price * (direction === 'BULLISH' ? 0.98 : 1.0)),
      entry_max: Math.round(entry_price * (direction === 'BULLISH' ? 1.0  : 1.02)),
      stop_loss,
      target_1,
      target_2,
      pattern_data: {
        X: { price: sA.price, date: sA.date, index: sA.index },
        A: { price: sA.price, date: sA.date, index: sA.index },
        B: { price: sB.price, date: sB.date, index: sB.index },
        C: { price: sC.price, date: sC.date, index: sC.index },
        D: { price: sD.price, date: sD.date, index: sD.index },
      },
      ratios: { AB_CD: ratio },
    });
  }

  // Deduplicate: keep highest fib_score per ticker+pattern_type+direction
  const best = {};
  for (const r of results) {
    const key = `${r.ticker}-${r.pattern_type}-${r.direction}`;
    if (!best[key] || r.fib_score > best[key].fib_score) best[key] = r;
  }
  return Object.values(best);
}

// ─── Wyckoff Phase Detection ────────────────────────────────
function detectWyckoffPhase(ohlc) {
  if (!ohlc || ohlc.length < 30) return { phase: 'UNKNOWN' };

  const last30 = ohlc.slice(-30);
  const closes = last30.map(c => c.close);
  const volumes = last30.map(c => c.volume || 0);
  const highs = last30.map(c => c.high);
  const lows = last30.map(c => c.low);

  const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length || 1;
  const recentVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const volRatio = recentVol / avgVol;

  const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const lastClose = closes[closes.length - 1];
  const priceChange = (lastClose - closes[0]) / closes[0];

  const highest = Math.max(...highs);
  const lowest  = Math.min(...lows);
  const range   = highest - lowest || 1;
  const rangePercent = range / lowest;

  // Spring detection: price dips below support then recovers
  const support = Math.min(...lows.slice(0, 20));
  const recentLow = Math.min(...lows.slice(-5));
  const spring = recentLow < support && lastClose > support;

  // Upthrust: price spikes above resistance then drops
  const resistance = Math.max(...highs.slice(0, 20));
  const recentHigh = Math.max(...highs.slice(-5));
  const upthrust = recentHigh > resistance && lastClose < resistance;

  // Sign of Strength: volume spike + price breakout above range
  const sign_of_strength = volRatio > 1.5 && lastClose > ma20 && priceChange > 0.05;

  // Buying climax: extreme volume spike at top
  const buying_climax = volRatio > 2.0 && lastClose > resistance * 0.98;

  // Phase classification
  let phase = 'UNKNOWN';
  if (spring && volRatio > 1.3) {
    phase = 'SPRING';
  } else if (sign_of_strength) {
    phase = priceChange > 0.08 ? 'SIGN_OF_STRENGTH' : 'SOS';
  } else if (upthrust && volRatio > 1.3) {
    phase = 'UPTHRUST';
  } else if (buying_climax) {
    phase = 'DISTRIBUTION';
  } else if (rangePercent < 0.10 && volRatio < 0.8) {
    phase = priceChange > 0 ? 'ACCUMULATION' : 'RANGING';
  } else if (priceChange > 0.08) {
    phase = 'MARKUP';
  } else if (priceChange < -0.08) {
    phase = 'MARKDOWN';
  } else if (priceChange < -0.03 && volRatio > 1.2) {
    phase = 'DISTRIBUTION';
  } else if (priceChange > 0.03 && recentLow > support) {
    phase = 'LPS';
  } else {
    phase = 'RANGING';
  }

  return { phase, spring, upthrust, sign_of_strength, buying_climax };
}

// ─── Order Block Detection ──────────────────────────────────
function detectOrderBlocks(ohlc, lookback = 50) {
  if (!ohlc || ohlc.length < 10) return [];

  const bars = ohlc.slice(-Math.min(lookback, ohlc.length));
  const blocks = [];

  for (let i = 1; i < bars.length - 1; i++) {
    const prev = bars[i - 1];
    const curr = bars[i];
    const next = bars[i + 1];

    // Bullish OB: bearish candle followed by strong bullish move
    if (curr.close < curr.open && next.close > next.open) {
      const move = (next.close - curr.low) / curr.low;
      if (move > 0.02) {
        blocks.push({
          type: 'bullish',
          high: curr.high,
          low: curr.low,
          index: ohlc.length - bars.length + i,
          date: curr.date,
        });
      }
    }
    // Bearish OB: bullish candle followed by strong bearish move
    if (curr.close > curr.open && next.close < next.open) {
      const move = (curr.high - next.close) / curr.high;
      if (move > 0.02) {
        blocks.push({
          type: 'bearish',
          high: curr.high,
          low: curr.low,
          index: ohlc.length - bars.length + i,
          date: curr.date,
        });
      }
    }
  }

  // Keep only the 5 most recent blocks
  return blocks.slice(-5);
}

// ─── Fair Value Gap (FVG) Detection ─────────────────────────
function detectFairValueGaps(ohlc, lookback = 50) {
  if (!ohlc || ohlc.length < 5) return [];

  const bars = ohlc.slice(-Math.min(lookback, ohlc.length));
  const gaps = [];

  for (let i = 2; i < bars.length; i++) {
    const c1 = bars[i - 2];
    const c3 = bars[i];

    // Bullish FVG: gap between candle 1 high and candle 3 low
    if (c3.low > c1.high) {
      gaps.push({
        type: 'bullish',
        top: c3.low,
        bot: c1.high,
        high: c3.low,
        low: c1.high,
        index: ohlc.length - bars.length + i,
        date: bars[i - 1].date,
      });
    }
    // Bearish FVG: gap between candle 3 high and candle 1 low
    if (c3.high < c1.low) {
      gaps.push({
        type: 'bearish',
        top: c1.low,
        bot: c3.high,
        high: c1.low,
        low: c3.high,
        index: ohlc.length - bars.length + i,
        date: bars[i - 1].date,
      });
    }
  }

  // Filter: only keep unfilled gaps (where price hasn't returned)
  const lastClose = ohlc[ohlc.length - 1].close;
  return gaps.filter(g => {
    if (g.type === 'bullish') return lastClose >= g.low;
    return lastClose <= g.high;
  }).slice(-5);
}

// ─── Liquidity Sweep Detection ──────────────────────────────
function detectLiquiditySweeps(ohlc, lookback = 30) {
  if (!ohlc || ohlc.length < 15) return {};

  const bars = ohlc.slice(-Math.min(lookback, ohlc.length));
  const recent = bars.slice(-5);
  const prior  = bars.slice(0, -5);

  if (prior.length < 5) return {};

  const priorLow  = Math.min(...prior.map(c => c.low));
  const priorHigh = Math.max(...prior.map(c => c.high));

  const recentLow  = Math.min(...recent.map(c => c.low));
  const recentHigh = Math.max(...recent.map(c => c.high));
  const lastClose  = recent[recent.length - 1].close;

  // Swept low: price went below prior low but closed back above
  const swept_low = recentLow < priorLow && lastClose > priorLow;

  // Swept high: price went above prior high but closed back below
  const swept_high = recentHigh > priorHigh && lastClose < priorHigh;

  return { swept_low, swept_high };
}

// ─── Volume Profile ─────────────────────────────────────────
function buildVolumeProfile(ohlc, bins = 20) {
  if (!ohlc || ohlc.length < 10) return {};

  const last60 = ohlc.slice(-60);
  const allHigh = Math.max(...last60.map(c => c.high));
  const allLow  = Math.min(...last60.map(c => c.low));
  const range   = allHigh - allLow || 1;
  const binSize = range / bins;

  const profile = new Array(bins).fill(0);
  for (const bar of last60) {
    const midPrice = (bar.high + bar.low) / 2;
    const bin = Math.min(bins - 1, Math.floor((midPrice - allLow) / binSize));
    profile[bin] += bar.volume || 0;
  }

  const maxVol = Math.max(...profile);
  const pocBin = profile.indexOf(maxVol);
  const poc = allLow + (pocBin + 0.5) * binSize;

  // Value Area: 70% of total volume around POC
  const totalVol = profile.reduce((a, b) => a + b, 0);
  let vaVol = profile[pocBin];
  let vaLo = pocBin, vaHi = pocBin;
  while (vaVol < totalVol * 0.7 && (vaLo > 0 || vaHi < bins - 1)) {
    const addLo = vaLo > 0 ? profile[vaLo - 1] : 0;
    const addHi = vaHi < bins - 1 ? profile[vaHi + 1] : 0;
    if (addLo >= addHi && vaLo > 0) { vaLo--; vaVol += profile[vaLo]; }
    else if (vaHi < bins - 1) { vaHi++; vaVol += profile[vaHi]; }
    else if (vaLo > 0) { vaLo--; vaVol += profile[vaLo]; }
    else break;
  }

  const value_area_low  = allLow + vaLo * binSize;
  const value_area_high = allLow + (vaHi + 1) * binSize;

  return { poc, value_area_low, value_area_high, bins: profile, binSize, allLow, allHigh };
}

// ─── DEFAULT WEIGHTS ────────────────────────────────────────
const DEFAULT_WEIGHTS = {
  harmonic: 20,       // max pts for category A
  wyckoff: 15,        // max pts for category B
  smc: 20,            // max pts for category C
  volume_profile: 15, // max pts for category D
  // Category E was the HEAVIEST at 30 points until 2026-08-02. EXP-018 found
  // that removing it improves the score's information coefficient in every year
  // where broker data exists (2024 +0.032->+0.074, 2025 -0.005->+0.063,
  // 2026 +0.040->+0.050 at 40D). The cause is in the E1 block below: it awards
  // +10 when the last three dn0 readings are all positive for a bullish setup,
  // and EXP-016 measured exactly that persistence as predicting UNDERperformance
  // (POSFRAC_60 IC -0.105, IR -0.83, sign stable across all three years).
  // Set to 0 rather than inverted: inverting scored marginally better still, but
  // building on a component whose only virtue is being backwards is not a design.
  // The E1..E3 code is left in place so a redesign has something to start from.
  broker_flow: 0,
};

// ─── Master Scoring (with Custom Weights) ───────────────────

/**
 * Calculate rolling VWAP with bands.
 * @param {Array} ohlc - [{high, low, close, volume}]
 * @param {number} period - lookback period (default 20)
 * @returns {{vwap, upper_1, lower_1, upper_2, lower_2, above_vwap, vwap_dist_pct}}
 */
function calcVWAP(ohlc, period = 20) {
  if (!ohlc || ohlc.length < period) return { vwap: 0, above_vwap: null, vwap_dist_pct: 0 };
  
  const recent = ohlc.slice(-period);
  let tpVolSum = 0, volSum = 0;
  const tps = [];
  
  for (const c of recent) {
    const tp = (c.high + c.low + c.close) / 3;
    const vol = c.volume > 0 ? c.volume : 1;
    tpVolSum += tp * vol;
    volSum += vol;
    tps.push(tp);
  }
  
  const vwap = volSum > 0 ? tpVolSum / volSum : 0;
  
  let std = 0;
  if (tps.length > 1 && vwap > 0) {
    const variance = tps.reduce((sum, tp) => sum + (tp - vwap) ** 2, 0) / tps.length;
    std = Math.sqrt(variance);
  }
  
  const lastClose = ohlc[ohlc.length - 1].close;
  const above_vwap = vwap > 0 ? lastClose > vwap : null;
  const vwap_dist_pct = vwap > 0 ? Math.round(((lastClose - vwap) / vwap) * 10000) / 100 : 0;
  
  return {
    vwap: Math.round(vwap * 100) / 100,
    upper_1: Math.round((vwap + std) * 100) / 100,
    lower_1: Math.round((vwap - std) * 100) / 100,
    upper_2: Math.round((vwap + 2 * std) * 100) / 100,
    lower_2: Math.round((vwap - 2 * std) * 100) / 100,
    above_vwap,
    vwap_dist_pct,
    std: Math.round(std * 100) / 100,
  };
}

function calcUltraConviction(pattern, structureData, wyckoffData, smcData, volProfileData, brokerData, customWeights) {
  const w = { ...DEFAULT_WEIGHTS, ...(customWeights || {}) };
  // Normalize weights so they sum to 100
  const wSum = w.harmonic + w.wyckoff + w.smc + w.volume_profile + w.broker_flow;
  const norm = wSum > 0 ? 100 / wSum : 1;

  const direction = pattern.direction || 'BULLISH';

  // ── A) Harmonic Pattern (raw 0–20) ──────────────────────────
  const PAT_BASE = { CRAB:20, SHARK:19, BAT:18, GARTLEY:16, BUTTERFLY:15, CYPHER:14, ABCD:10 };
  const patBase  = PAT_BASE[pattern.pattern_type] || 8;
  const rawA     = Math.min(20, patBase + Math.round((pattern.fib_score || 0) * 0.04));
  const scoreA   = (rawA / 20) * w.harmonic * norm;

  // ── B) Wyckoff Phase (raw 0–15) ─────────────────────────────
  const WYCKOFF_PTS = {
    BULLISH:  { SPRING:15, SIGN_OF_STRENGTH:14, SOS:14, LPS:12, ACCUMULATION:8, MARKUP:6, RANGING:3, UPTHRUST:-5, DISTRIBUTION:-8, MARKDOWN:-10, UNKNOWN:0 },
    BEARISH:  { UPTHRUST:15, DISTRIBUTION:14, MARKDOWN:12, RANGING:3, MARKUP:-5, SPRING:-8, ACCUMULATION:-6, SIGN_OF_STRENGTH:-10, SOS:-10, LPS:-6, UNKNOWN:0 },
  };
  const wy_map = WYCKOFF_PTS[direction] || WYCKOFF_PTS.BULLISH;
  const phase  = wyckoffData?.phase || 'UNKNOWN';
  const rawB   = wy_map[phase] ?? 0;
  const scoreB = (Math.max(0, rawB) / 15) * w.wyckoff * norm;

  // ── C) SMC Setup (raw 0–20) ─────────────────────────────────
  const obs = smcData?.order_blocks || [];
  const fvgs = smcData?.fair_value_gaps || [];
  const sw  = smcData?.liquidity_sweeps || {};
  const lastClose = structureData?.lastClose || 0;

  let rawC = 0;
  const in_ob = Array.isArray(obs) && obs.some(o => lastClose >= Math.min(o.high,o.low) && lastClose <= Math.max(o.high,o.low));
  const in_fvg = Array.isArray(fvgs) && fvgs.some(f => {
    const top = f.top||f.high, bot = f.bot||f.low;
    return lastClose >= Math.min(top,bot) && lastClose <= Math.max(top,bot);
  });
  const liq_sweep = !!(sw?.swept_low || sw?.swept_high);

  if (in_ob)      rawC += 8;
  if (in_fvg)     rawC += 7;
  if (liq_sweep)  rawC += 5;
  if (in_ob && in_fvg && liq_sweep) rawC += 5;
  rawC = Math.min(20, rawC);
  const scoreC = (rawC / 20) * w.smc * norm;

  // ── D) Volume Profile (raw 0–15) ────────────────────────────
  let rawD = 0;
  const vol_spike   = structureData?.vol_spike || false;
  const above_vwap  = structureData?.above_vwap ?? null;
  const vp = volProfileData || {};

  if (vol_spike) rawD += 6;
  if (vp.poc && lastClose && Math.abs(lastClose - vp.poc) / vp.poc < 0.02) rawD += 5;
  if (vp.value_area_low && vp.value_area_high) {
    if (lastClose >= vp.value_area_low && lastClose <= vp.value_area_high) rawD += 4;
  }
  if (above_vwap !== null) {
    if (direction === 'BULLISH' && above_vwap)   rawD += 3;
    if (direction === 'BEARISH' && !above_vwap)  rawD += 3;
  }
  rawD = Math.min(15, rawD);
  const scoreD = (rawD / 15) * w.volume_profile * norm;

  // ── E) Broker Flow (raw 0–30) ───────────────────────────────
  let rawE = 0;
  const bd = brokerData || {};
  const dn0 = Number(bd.dn0 || 0);
  const dn1 = Number(bd.dn1 || 0);
  const dn2 = Number(bd.dn2 || 0);
  const foreignNet  = Number(bd.foreignNet  || 0);
  const bigMoneyNet = Number(bd.bigMoneyNet || 0);

  // E1: Concentration trend (0–10)
  const posConc = [dn2, dn1, dn0].filter(v => v > 0).length;
  const negConc = [dn2, dn1, dn0].filter(v => v < 0).length;
  if (direction === 'BULLISH') {
    if (posConc === 3) rawE += 10; else if (posConc === 2) rawE += 5; else if (negConc >= 2) rawE -= 5;
  } else {
    if (negConc === 3) rawE += 10; else if (negConc === 2) rawE += 5; else if (posConc >= 2) rawE -= 5;
  }

  // E2: Smart money alignment (0–15)
  const bmDir  = bigMoneyNet >= 0 ? 1 : -1;
  const fDir   = foreignNet  >= 0 ? 1 : -1;
  const expDir = direction === 'BULLISH' ? 1 : -1;
  if (Math.abs(bigMoneyNet) > 1e9) { rawE += bmDir === expDir ? 8 : -5; }
  if (Math.abs(foreignNet)  > 1e9) { rawE += fDir  === expDir ? 7 : -4; }

  // E3: Divergence bonus (0–5)
  if (Math.abs(bigMoneyNet) > 1e9 && Math.abs(foreignNet) > 1e9 && bmDir === fDir && bmDir === expDir) rawE += 5;
  rawE = Math.max(-15, Math.min(30, rawE));
  const scoreE = (Math.max(0, rawE) / 30) * w.broker_flow * norm;

  // ── TOTAL ───────────────────────────────────────────────────
  const raw   = scoreA + scoreB + scoreC + scoreD + scoreE;
  const total = Math.max(0, Math.min(100, Math.round(raw)));

  const signal = total >= 78 ? 'STRONG BUY'
               : total >= 62 ? 'BUY'
               : total >= 50 ? 'WATCH'
               : total >= 38 ? 'NEUTRAL'
               : total >= 25 ? 'SELL'
               : 'STRONG SELL';

  return {
    master_score: total,
    score: total,
    signal,
    breakdown: {
      harmonic:       Math.round(scoreA * 10) / 10,
      wyckoff:        Math.round(scoreB * 10) / 10,
      smc:            Math.round(scoreC * 10) / 10,
      volume_profile: Math.round(scoreD * 10) / 10,
      broker_flow:    Math.round(scoreE * 10) / 10,
    },
    weights_used: w,
  };
}

// ─── Exports ────────────────────────────────────────────────
module.exports = {
  detectHarmonicPatterns,
  detectWyckoffPhase,
  detectOrderBlocks,
  detectFairValueGaps,
  detectLiquiditySweeps,
  buildVolumeProfile,
  calcUltraConviction,
  calcVWAP,
  DEFAULT_WEIGHTS,
};
