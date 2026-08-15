/**
 * Multiple-testing control for EXP-028.
 *
 * WHY THIS EXISTS. The review put it plainly: "Ini wajib supaya 101 pattern
 * tidak menghasilkan false winner." With 101 patterns x 4 horizons x several
 * outcomes, testing at p < 0.05 and reporting whatever clears is a machine for
 * manufacturing discoveries. At 400 independent tests of pure noise, roughly 20
 * come back "significant" — and they are exactly the ones a leaderboard sorted
 * by effect size puts at the top.
 *
 * Benjamini-Hochberg controls the expected proportion of false discoveries
 * among the rejections, which is the right guarantee here: this is a screen
 * meant to surface candidates, not a confirmatory test of one hypothesis, so
 * Bonferroni's family-wise error rate would be needlessly brutal and would bury
 * genuine weak effects the research explicitly wants to see.
 *
 * The reporting rule is equally load-bearing: "Jangan report p-value saja."
 * Every row carries raw p, adjusted q, effect size, CI and n, because a q-value
 * on its own says a result is unlikely to be noise, not that it is worth
 * anything.
 */
'use strict';

const stats = require('../../modules/statistics');

/**
 * Two-sided one-sample test that a mean differs from zero.
 *
 * NORMAL APPROXIMATION, deliberately, and stated rather than hidden: the units
 * here are SESSIONS, and EXP-028's window carries ~2,400 of them, so even the
 * 10-session non-overlapping subsample leaves ~240 anchors. The t and normal
 * distributions are indistinguishable long before that. Below n = 30 the
 * approximation starts to matter, and at that size the evidence tier is already
 * INSUFFICIENT_DATA or EXPLORATORY, so the p-value is not what is carrying the
 * conclusion anyway.
 *
 * @returns {{n:number, mean:number|null, sd:number|null, se:number|null, t:number|null, p:number|null}}
 */
function oneSampleP(values) {
  const clean = (values || []).filter(Number.isFinite);
  const n = clean.length;
  if (n < 3) return { n, mean: n ? stats.mean(clean) : null, sd: null, se: null, t: null, p: null };
  const mean = stats.mean(clean);
  // Sample standard deviation (n-1), not population: these sessions are a
  // sample of the process, not the whole of it.
  let ss = 0;
  for (const v of clean) ss += (v - mean) ** 2;
  const sd = Math.sqrt(ss / (n - 1));
  const se = sd / Math.sqrt(n);
  if (!(se > 0)) return { n, mean, sd, se, t: null, p: null };
  const t = mean / se;
  const p = 2 * (1 - stats.normalCDF(Math.abs(t)));
  return { n, mean, sd, se, t, p: Math.min(1, Math.max(0, p)) };
}

/**
 * Benjamini-Hochberg step-up FDR.
 *
 * The subtle part is the monotonicity enforcement. The naive adjustment
 * m*p(i)/i is NOT monotone in i, so a smaller p-value can end up with a larger
 * q-value than a bigger one — nonsense on its face, and it changes which
 * hypotheses are rejected. The correct procedure sweeps from the LARGEST
 * p-value down, carrying a running minimum.
 *
 * Entries whose p is null (test not computable) are passed through with
 * q = null and rejected = false. They do NOT count towards m, because inflating
 * the denominator with tests that were never run would make every other q-value
 * artificially harsh.
 *
 * @param {Array<{p:number|null}>} entries  annotated in place with q and rejected
 * @param {number} alpha
 * @returns {{m:number, rejected:number, alpha:number, threshold:number|null}}
 */
function benjaminiHochberg(entries, alpha = 0.05) {
  const testable = entries.filter(e => Number.isFinite(e.p));
  for (const e of entries) { e.q = null; e.rejected = false; }
  const m = testable.length;
  if (m === 0) return { m: 0, rejected: 0, alpha, threshold: null };

  const order = [...testable].sort((a, b) => a.p - b.p);
  let running = Infinity;
  for (let i = order.length - 1; i >= 0; i--) {
    const rank = i + 1;
    const raw = (m * order[i].p) / rank;
    running = Math.min(running, raw);
    order[i].q = Math.min(1, running);
  }
  // Largest p meeting p(i) <= (i/m)*alpha; everything at or below it is rejected.
  let cutIdx = -1;
  for (let i = 0; i < order.length; i++) {
    if (order[i].p <= ((i + 1) / m) * alpha) cutIdx = i;
  }
  for (let i = 0; i <= cutIdx; i++) order[i].rejected = true;
  return {
    m,
    rejected: cutIdx + 1,
    alpha,
    threshold: cutIdx >= 0 ? order[cutIdx].p : null,
  };
}

/**
 * Evidence tier from sample size (spec section 9). Deliberately a function of n
 * ALONE — it says how much can be claimed, never whether the result is good.
 */
function evidenceTier(n) {
  if (!Number.isFinite(n) || n < 30) return 'INSUFFICIENT_DATA';
  if (n < 100) return 'EXPLORATORY';
  return 'BASELINE_ELIGIBLE';
}

/**
 * Anchors spaced at least H canonical sessions apart, so forward windows of
 * length H cannot overlap.
 *
 * Spacing is measured on the EXCHANGE session index, never on position within an
 * already-filtered array — the distinction EXP-026's P2 was about. Filtering
 * first and then taking every Hth element can leave two picks fewer than H
 * canonical sessions apart, which is precisely the overlap the subsample exists
 * to remove.
 *
 * @param {Array<{sessionIndex:number}>} rows ascending by sessionIndex
 */
function nonOverlappingAnchors(rows, H) {
  const out = [];
  let nextEligible = -Infinity;
  for (const r of rows) {
    if (r.sessionIndex >= nextEligible) { out.push(r); nextEligible = r.sessionIndex + H; }
  }
  return out;
}

module.exports = { oneSampleP, benjaminiHochberg, evidenceTier, nonOverlappingAnchors };
