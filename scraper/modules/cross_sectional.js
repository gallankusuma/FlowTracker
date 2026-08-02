'use strict';

/**
 * Shared cross-sectional statistics for rank/IC style diagnostics.
 *
 * WHY THIS MODULE EXISTS (2026-08-02)
 * -----------------------------------
 * `rankTransform`, `spearmanIC` and the IC bootstrap were written for EXP-010
 * (backtest_momentum_rank_diagnostic.js) and immediately copy-pasted into the
 * next script. BACKTEST_EXPERIMENTS.md flags exactly this pattern as a drift
 * risk, and the copy in the momentum diagnostic is explicitly annotated "not
 * re-verified here". Extracting them once, with tests, kills that class of bug.
 *
 * The EXP-009/EXP-010 scripts are deliberately NOT refactored to import this:
 * they are the record of a published registry entry, and the registry is
 * append-only. New work imports from here.
 *
 * TIE AWARENESS IS NOT OPTIONAL ON IDX
 * ------------------------------------
 * IDX enforces ARA/ARB (auto-reject atas/bawah) daily price limits, so multiple
 * stocks routinely post *identical* capped percentage moves on the same day.
 * Exact ties in forward returns are therefore a real, common feature of this
 * market rather than a theoretical edge case, and a naive ordinal rank would
 * assign them arbitrary distinct ranks and bias the correlation. Both sides of
 * every correlation here use average-rank tie handling.
 */

const stats = require('./statistics');

/** Deterministic PRNG (same generator used by awo_optimizer.js) so every
 *  bootstrap in the project is reproducible from a seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Average-rank (tie-aware) transform, 1-based.
 * @param {number[]} values
 * @returns {number[]} ranks, same order as input
 */
function rankTransform(values) {
  const n = values.length;
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(n);
  let k = 0;
  while (k < n) {
    let j = k;
    while (j + 1 < n && indexed[j + 1].v === indexed[k].v) j++;
    const avgRank = (k + 1 + j + 1) / 2;
    for (let m = k; m <= j; m++) ranks[indexed[m].i] = avgRank;
    k = j + 1;
  }
  return ranks;
}

/**
 * Spearman information coefficient = Pearson correlation of ranks.
 * Returns null (not a fake 0) below `minObs`, so a thin cross-section can't
 * silently drag a mean IC toward zero.
 * @returns {number|null}
 */
function spearmanIC(scores, returns, minObs = 3) {
  if (scores.length < minObs || scores.length !== returns.length) return null;
  return stats.correlation(rankTransform(scores), rankTransform(returns));
}

/**
 * Bootstrap CI for the mean of already-computed per-date scalars (e.g. one IC
 * per date). Resampling whole dates preserves within-date cross-sectional
 * correlation, which is the dependence that matters here.
 *
 * CAVEAT this cannot fix: when forward-return windows overlap across dates
 * (daily sampling with a 20-day horizon), the per-date ICs are themselves
 * serially correlated and this CI is too narrow. Sample dates at least as far
 * apart as the horizon, or read the CI as optimistic.
 */
function bootstrapMeanCI(values, { resamples = 2000, alpha = 0.05, seed = 42 } = {}) {
  const clean = values.filter(v => Number.isFinite(v));
  if (clean.length < 3) return { mean: null, lower: null, upper: null, n: clean.length };
  const rng = mulberry32(seed);
  const means = new Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let k = 0; k < clean.length; k++) sum += clean[Math.floor(rng() * clean.length)];
    means[r] = sum / clean.length;
  }
  means.sort((a, b) => a - b);
  return {
    mean: stats.mean(clean),
    lower: means[Math.max(0, Math.floor(resamples * (alpha / 2)))],
    upper: means[Math.min(resamples - 1, Math.ceil(resamples * (1 - alpha / 2)))],
    n: clean.length,
  };
}

/**
 * Information Ratio of an IC series: mean(IC) / stdDev(IC).
 * The standard "is this signal consistent, not just occasionally lucky" metric.
 * Returns null when the series is too short or degenerate.
 */
function icInformationRatio(icSeries) {
  const clean = icSeries.filter(v => Number.isFinite(v));
  if (clean.length < 3) return null;
  const sd = stats.stdDev(clean);
  // NOT `sd > 0`: stdDev of a constant series returns float-error residue
  // (~1e-17), not exact zero, so a naive positivity check divides by it and
  // reports an information ratio of ~7e15. ICs are bounded in [-1,1], so an
  // absolute floor is the right guard — anything below this is numerically
  // indistinguishable from "this signal never varies".
  if (!(sd > 1e-12)) return null;
  return stats.mean(clean) / sd;
}

/**
 * Split a cross-section into `k` equal-count buckets by score (bucket 0 =
 * lowest score) and return the mean forward return of each.
 *
 * Uses average-rank positions so tied scores are distributed across bucket
 * boundaries rather than all landing in whichever bucket the sort happened to
 * put them in.
 *
 * @returns {{buckets: Array<{n:number, meanReturn:number|null}>, universeMean:number|null}}
 */
function bucketByScore(scores, returns, k = 10) {
  const n = scores.length;
  const buckets = Array.from({ length: k }, () => []);
  if (n < k) return { buckets: buckets.map(b => ({ n: 0, meanReturn: null })), universeMean: n ? stats.mean(returns) : null };

  const ranks = rankTransform(scores);
  for (let i = 0; i < n; i++) {
    // ranks are 1..n (possibly fractional on ties); map to 0..k-1
    let b = Math.floor(((ranks[i] - 1) / n) * k);
    if (b >= k) b = k - 1;
    if (b < 0) b = 0;
    buckets[b].push(returns[i]);
  }
  return {
    buckets: buckets.map(b => ({ n: b.length, meanReturn: b.length ? stats.mean(b) : null })),
    universeMean: stats.mean(returns),
  };
}

module.exports = { mulberry32, rankTransform, spearmanIC, bootstrapMeanCI, icInformationRatio, bucketByScore };
