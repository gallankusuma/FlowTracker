/**
 * modules/fibonacci.js
 * Auto-Fibonacci Retracement + Extension Module
 * Primary: Pivot point detection (swing high/low)
 * Fallback: Absolute high/low of lookback period
 */

'use strict';

const FIB_RETRACEMENT = [
  { ratio: 0,     label: '0.000', color: '#c9d1d9', dash: false, type: 'retrace' },
  { ratio: 0.236, label: '0.236', color: '#4ec9b0', dash: true,  type: 'retrace' },
  { ratio: 0.382, label: '0.382', color: '#dcdcaa', dash: false, type: 'retrace' },
  { ratio: 0.500, label: '0.500', color: '#ce9178', dash: true,  type: 'retrace' },
  { ratio: 0.618, label: '0.618', color: '#f7c948', dash: false, type: 'retrace' },
  { ratio: 0.786, label: '0.786', color: '#e06c75', dash: true,  type: 'retrace' },
  { ratio: 1.000, label: '1.000', color: '#c9d1d9', dash: false, type: 'retrace' },
];

const FIB_EXTENSION = [
  { ratio: 1.272, label: '1.272', color: '#388bfd', dash: true,  type: 'extend' },
  { ratio: 1.414, label: '1.414', color: '#58a6ff', dash: true,  type: 'extend' },
  { ratio: 1.618, label: '1.618', color: '#bc8cff', dash: false, type: 'extend' }, // golden ext
  { ratio: 2.000, label: '2.000', color: '#d2a8ff', dash: true,  type: 'extend' },
  { ratio: 2.618, label: '2.618', color: '#ff7b72', dash: true,  type: 'extend' },
];

function detectPivots(ohlc, L = 4, R = 2) {
  const highs = [], lows = [];
  for (let i = L; i < ohlc.length - R; i++) {
    const bar = ohlc[i];
    const lH = ohlc.slice(i - L, i);
    const rH = ohlc.slice(i + 1, i + R + 1);
    if (lH.every(c => c.high <= bar.high) && rH.every(c => c.high < bar.high))
      highs.push({ time: bar.time, price: bar.high });
    if (lH.every(c => c.low >= bar.low) && rH.every(c => c.low > bar.low))
      lows.push({ time: bar.time, price: bar.low });
  }
  return { highs, lows };
}

function computeLevels(priceHigh, priceLow, includeExtensions = true) {
  const range = priceHigh - priceLow;
  const retrace = FIB_RETRACEMENT.map(f => ({
    ratio: f.ratio, label: f.label, color: f.color, dash: f.dash, type: f.type,
    price: parseFloat((priceHigh - range * f.ratio).toFixed(2)),
  }));

  if (!includeExtensions) return retrace;

  // Extensions project BELOW swing low (downtrend) or ABOVE swing high (uptrend)
  const extensions = FIB_EXTENSION.map(f => ({
    ratio: f.ratio, label: f.label, color: f.color, dash: f.dash, type: f.type,
    price: parseFloat((priceHigh - range * f.ratio).toFixed(2)),
  }));

  return [...retrace, ...extensions];
}

/**
 * Auto-detect Support & Resistance levels from price clusters
 * Returns top N levels where price visited multiple times
 */
function detectSupportResistance(ohlc, windowSize = 100, numLevels = 6, tolerance = 0.015) {
  if (!ohlc || ohlc.length < 10) return [];
  const bars = ohlc.slice(-Math.min(windowSize, ohlc.length));

  // Collect pivot points
  const { highs, lows } = detectPivots(bars, 3, 2);
  const pivotPrices = [
    ...highs.map(p => ({ price: p.price, type: 'resistance', time: p.time })),
    ...lows.map(p  => ({ price: p.price, type: 'support',    time: p.time })),
  ];

  if (pivotPrices.length < 2) return [];

  // Cluster nearby prices
  const clusters = [];
  const used = new Set();

  for (let i = 0; i < pivotPrices.length; i++) {
    if (used.has(i)) continue;
    const cluster = [pivotPrices[i]];
    used.add(i);
    for (let j = i + 1; j < pivotPrices.length; j++) {
      if (used.has(j)) continue;
      const pct = Math.abs(pivotPrices[i].price - pivotPrices[j].price) / pivotPrices[i].price;
      if (pct <= tolerance) {
        cluster.push(pivotPrices[j]);
        used.add(j);
      }
    }
    const avgPrice = cluster.reduce((s, c) => s + c.price, 0) / cluster.length;
    const dominantType = cluster.filter(c => c.type === 'resistance').length >= cluster.filter(c => c.type === 'support').length
      ? 'resistance' : 'support';
    clusters.push({
      price: parseFloat(avgPrice.toFixed(2)),
      strength: cluster.length,
      type: dominantType,
      color: dominantType === 'resistance' ? '#ff7b72' : '#3fb950',
    });
  }

  // Sort by strength (touches), return top N
  return clusters
    .sort((a, b) => b.strength - a.strength)
    .slice(0, numLevels)
    .sort((a, b) => b.price - a.price);
}

function autoFibonacci(ohlc, lookback = 60, includeExtensions = true) {
  if (!ohlc || ohlc.length < 8) return null;

  const bars = ohlc.slice(-Math.min(lookback, ohlc.length));

  // Try pivot detection first
  const { highs, lows } = detectPivots(bars, 3, 2);

  let swingHigh, swingLow, method;

  if (highs.length > 0 && lows.length > 0) {
    swingHigh = highs.reduce((a, b) => a.price > b.price ? a : b);
    swingLow  = lows.reduce((a, b)  => a.price < b.price ? a : b);
    method    = 'pivot';
  } else {
    let maxH = -Infinity, minL = Infinity, maxBar, minBar;
    for (const bar of bars) {
      if (bar.high > maxH) { maxH = bar.high; maxBar = bar; }
      if (bar.low  < minL) { minL = bar.low;  minBar = bar; }
    }
    swingHigh = { time: maxBar.time, price: maxBar.high };
    swingLow  = { time: minBar.time, price: minBar.low  };
    method    = 'absolute';
  }

  const direction = swingHigh.time > swingLow.time ? 'downtrend' : 'uptrend';
  const levels    = computeLevels(swingHigh.price, swingLow.price, includeExtensions);
  const srLevels  = detectSupportResistance(ohlc, lookback);

  return { swingHigh, swingLow, direction, levels, method,
    srLevels, allPivots: { highs, lows } };
}

module.exports = { autoFibonacci, detectPivots, computeLevels, detectSupportResistance };
