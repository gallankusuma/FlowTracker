/**
 * The Float Cost Map model, on its own, with no database and no clock.
 *
 * Extracted so it can be tested as pure arithmetic and so the nightly generator
 * and the IC experiment cannot drift apart — they were separate copies of the
 * same loop, which is exactly how a production number and aresearch number quietly
 * stop meaning the same thing.
 *
 * See MODEL.md for what it estimates and where it is known to be wrong.
 */
'use strict';

const MODEL_VERSION = 'FLOAT_MAP_V1';
const LOOKBACK = 250;
const BUCKETS = 40;
const TURNOVER_K = 0.75;

/** A >35% single-session move is treated as a corporate action. */
const CORPORATE_ACTION_MOVE = 0.35;

const typicalPrice = b => (b.h + b.l + b.c) / 3;

/**
 * @param {Array<{h,l,c,v}>} bars ascending, already truncated to the as-of date
 * @param {number} floatShares
 * @returns {object} metrics, or { error } — never a partial map
 */
function costMap(bars, floatShares, opts = {}) {
  const k = opts.turnoverK ?? TURNOVER_K;
  const nb = opts.buckets ?? BUCKETS;

  if (!Number.isFinite(floatShares) || floatShares <= 0) return { error: 'NO_FLOAT' };
  if (!Array.isArray(bars) || bars.length < 60) return { error: 'SHORT_HISTORY' };
  for (const b of bars) {
    if (![b.h, b.l, b.c, b.v].every(Number.isFinite)) return { error: 'BAD_BAR' };
    if (b.h < b.l || b.c <= 0) return { error: 'BAD_BAR' };
  }
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1].c, b = bars[i].c;
    if (a > 0 && b > 0 && Math.abs(b / a - 1) > CORPORATE_ACTION_MOVE) {
      return { error: 'CORPORATE_ACTION' };
    }
  }

  const lo = Math.min(...bars.map(b => b.l));
  const hi = Math.max(...bars.map(b => b.h));
  if (!(hi > lo)) return { error: 'FLAT_RANGE' };
  const step = (hi - lo) / nb;
  const mid = i => lo + step * (i + 0.5);

  const dist = new Array(nb).fill(0);
  const seedIndex = Math.max(0, Math.min(nb - 1, Math.floor((typicalPrice(bars[0]) - lo) / step)));
  dist[seedIndex] = floatShares;

  /**
   * How much of the arbitrary day-one assumption is still in the answer.
   *
   * The model seeds 100% of the float at the first session's typical price and
   * lets turnover erode it. For a heavily traded name that seed is gone within
   * days; for a quiet one it can still be a third of the distribution 250
   * sessions later, and then the "estimated cost basis" is largely a statement
   * about a date somebody picked. Reported so the reader can tell which they
   * are looking at.
   */
  let seedRemaining = 1;

  const turns = [];
  for (const b of bars) {
    const raw = b.v / floatShares;
    turns.push(raw);
    const t = Math.min(1, raw * k);
    seedRemaining *= (1 - t);
    for (let i = 0; i < nb; i++) dist[i] *= (1 - t);

    const iLo = Math.max(0, Math.min(nb - 1, Math.floor((b.l - lo) / step)));
    const iHi = Math.max(0, Math.min(nb - 1, Math.floor((b.h - lo) / step)));
    const centre = typicalPrice(b);
    const span = Math.max(step, (b.h - b.l) / 2);
    const w = []; let wsum = 0;
    for (let i = iLo; i <= iHi; i++) {
      const wi = Math.max(0.05, 1 - Math.abs(mid(i) - centre) / span);
      w.push(wi); wsum += wi;
    }
    const moved = floatShares * t;
    for (let i = iLo, j = 0; i <= iHi; i++, j++) dist[i] += moved * (w[j] / wsum);
  }

  const total = dist.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total) || total <= 0) return { error: 'DEGENERATE' };

  const price = bars[bars.length - 1].c;
  const avgCost = dist.reduce((a, x, i) => a + x * mid(i), 0) / total;
  const peakI = dist.indexOf(Math.max(...dist));
  const sum = n => turns.slice(-n).reduce((a, b) => a + b, 0);

  const out = {
    price, avgCost,
    avgCostGap: price / avgCost - 1,
    profitSupply: dist.reduce((a, x, i) => a + (mid(i) < price ? x : 0), 0) / total,
    distToPeak: (price - mid(peakI)) / price,
    peakLow: mid(peakI) - step / 2,
    peakHigh: mid(peakI) + step / 2,
    rotation20: sum(20), rotation60: sum(60),
    roc20: price / bars[bars.length - 20].c - 1,
    roc60: price / bars[bars.length - 60].c - 1,
    seedRemaining,
    totalShares: total,
    dist, step, lo,
  };
  // A NaN anywhere means the map is wrong in a way no reader could detect, so
  // it is refused rather than published.
  for (const [key, v] of Object.entries(out)) {
    if (typeof v === 'number' && !Number.isFinite(v)) return { error: `NON_FINITE_${key}` };
  }
  return out;
}

/** Coarse buckets for a chart. The full 40 is noise on screen. */
function chartBuckets(m, everyN = 2, minShare = 0.005) {
  const out = [];
  for (let i = 0; i < m.dist.length; i += everyN) {
    const s = (m.dist[i] + (m.dist[i + 1] || 0)) / m.totalShares;
    if (s >= minShare) out.push({ price: Math.round(m.lo + m.step * (i + 0.5)), share: +(s * 100).toFixed(1) });
  }
  return out.reverse();
}

/** Cross-sectional OLS residual of y on the given columns, or null if singular. */
function residualise(y, cols) {
  const n = y.length, p = cols.length + 1;
  if (n < p + 2) return null;
  const X = y.map((_, i) => [1, ...cols.map(c => c[i])]);
  const A = Array.from({ length: p }, () => new Array(p + 1).fill(0));
  for (let i = 0; i < n; i++)
    for (let a = 0; a < p; a++) {
      A[a][p] += X[i][a] * y[i];
      for (let b = 0; b < p; b++) A[a][b] += X[i][a] * X[i][b];
    }
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let j = c; j <= p; j++) A[r][j] -= f * A[c][j];
    }
  }
  const beta = A.map((row, i) => row[p] / row[i]);
  return y.map((v, i) => v - X[i].reduce((s, xv, a) => s + xv * beta[a], 0));
}

/**
 * Per-ticker confidence.
 *
 * The old global 100-or-80 said nothing about the individual name: a quiet
 * stock whose distribution is still mostly the day-one seed scored identically
 * to one whose float has rotated forty times. Split into DATA (are the inputs
 * trustworthy) and CONVERGENCE (has the model outgrown its own initialisation).
 */
function confidenceFor({ seedRemaining, bars, floatStatus, floatAgeDays, brokerLagSessions }) {
  const data = [
    { k: 'free float fresh', ok: floatStatus === 'VALID' && floatAgeDays <= 10, w: 30,
      note: `${floatStatus}, ${floatAgeDays}d old` },
    { k: 'price history depth', ok: bars >= LOOKBACK, w: 25, note: `${bars} sessions` },
    { k: 'broker flow fresh', ok: brokerLagSessions <= 1, w: 20, note: `${brokerLagSessions} session(s) behind` },
    { k: 'no corporate action', ok: true, w: 25, note: 'none detected in window (not the same as adjusted)' },
  ];
  const dataScore = data.reduce((a, c) => a + (c.ok ? c.w : 0), 0);
  // Seed at 2% means the answer is the market's; at 38% it is largely the
  // arbitrary starting assumption.
  const convergence = Math.round(Math.max(0, Math.min(1, 1 - seedRemaining / 0.20)) * 100);
  return {
    data: dataScore,
    convergence,
    overall: Math.round(dataScore * 0.6 + convergence * 0.4),
    checks: data,
    seedRemainingPct: +(seedRemaining * 100).toFixed(2),
  };
}

module.exports = {
  MODEL_VERSION, LOOKBACK, BUCKETS, TURNOVER_K, CORPORATE_ACTION_MOVE,
  typicalPrice, costMap, chartBuckets, residualise, confidenceFor,
};
