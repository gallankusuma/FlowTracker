'use strict';

/**
 * Target-book construction for the EXP-017 strategy — the SINGLE code path used
 * by both the backtest and the live forward test.
 *
 * WHY A SHARED MODULE, NOT TWO IMPLEMENTATIONS
 * --------------------------------------------
 * The project has already been burned by this exact shape. `awo_paper_trades`
 * was a separate simulation from the optimizer that selected its candidates, and
 * because it was separate it broke silently: the candidateKey mismatch meant
 * paper trades were invisible to their own challenger, and the profitFactor gate
 * was inert for weeks with nobody noticing. A forward test that does not run the
 * same code as the backtest is not testing the backtested strategy.
 *
 * So: this module is the authority. `strategy_forward.js` calls it to produce
 * today's book, and `verify_strategy_book.js` replays history through it and
 * checks the result reproduces EXP-017's published numbers. If those ever
 * diverge, the verification fails loudly rather than the live book drifting.
 *
 * THE STRATEGY (EXP-017, frozen 2026-08-02)
 *   universe   liquid names (median 20d value >= minAdv) with 252d of price
 *              history and enough concentration history for POSFRAC_60
 *   rank       HI52W = close / max(high, 252d) x 100   (higher = nearer its high)
 *   regime     IHSG below its own 200d SMA -> exposure 0 (stand aside entirely)
 *   veto       exclude the top vetoFrac by POSFRAC_60 (share of the last 60
 *              days with dn0 > 0). EXP-016: persistent broker accumulation
 *              predicts UNDERperformance, so this excludes rather than selects.
 *              exitOnVeto also drops an existing holding that becomes vetoed.
 *   book       top N by rank after veto, equal cash weight at entry
 *   buffer     an existing holding is kept while it stays inside the top
 *              (N x bufferMult) by rank — turnover control, not alpha
 *
 * ALL INPUTS ARE AS-OF. Callers pass series already sliced to the decision bar;
 * this module never looks beyond index `i`.
 */

const DEFAULTS = {
  positions: 8,
  bufferMult: 2,
  vetoFrac: 0.20,
  exitOnVeto: true,
  minAdv: 5e9,
  advWindow: 20,
  hiBars: 252,
  posfracWindow: 60,
  posfracMinReal: 35,
  regimeSma: 200,
  minEligible: 20,
  dnBound: 100,
};

/** Median of the trailing `w` values ending at i, ignoring gaps. */
function rollingMedian(arr, i, w) {
  if (i + 1 < w) return null;
  const s = [];
  for (let j = i - w + 1; j <= i; j++) if (Number.isFinite(arr[j])) s.push(arr[j]);
  if (!s.length) return null;
  s.sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Share of the last `posfracWindow` days with dn0 > 0. Null if too few reals. */
function posfrac(dn0, i, p) {
  let pos = 0, cnt = 0;
  for (let j = Math.max(0, i - p.posfracWindow + 1); j <= i; j++) {
    if (dn0[j] === null || dn0[j] === undefined) continue;
    if (dn0[j] > 0) pos++;
    cnt++;
  }
  return cnt >= p.posfracMinReal ? pos / cnt : null;
}

/** Clip dn0 to its documented bound — 84 FT.id rows breach it (see EXP-016). */
function clipDn(v, bound) {
  if (v === null || v === undefined) return null;
  const x = Number(v);
  if (!Number.isFinite(x)) return null;
  return Math.abs(x) > bound ? Math.sign(x) * bound : x;
}

/**
 * Eligible cross-section at bar i, ranked best-first, with the veto flag set.
 *
 * @param {Map<string, {close:number[], high:number[], value:number[], dn0:number[]}>} series
 * @param {number} i
 * @param {object} [opts]
 * @returns {Array<{ticker:string, rank:number, hi52w:number, posfrac:number|null, vetoed:boolean}>}
 */
function crossSection(series, i, opts) {
  const p = { ...DEFAULTS, ...(opts || {}) };
  const rows = [];
  for (const [ticker, s] of series) {
    if (i < p.hiBars) continue;
    if (s.close[i] === null || s.close[i] === undefined) continue;
    const adv = rollingMedian(s.value, i, p.advWindow);
    if (adv === null || adv < p.minAdv) continue;
    let hi = -Infinity;
    for (let j = i - p.hiBars + 1; j <= i; j++) {
      const h = s.high[j];
      if (h !== null && h !== undefined && h > hi) hi = h;
    }
    if (!(hi > 0)) continue;
    rows.push({ ticker, hi52w: (s.close[i] / hi) * 100, posfrac: posfrac(s.dn0, i, p), vetoed: false });
  }
  rows.sort((a, b) => b.hi52w - a.hi52w);
  rows.forEach((r, k) => { r.rank = k; });

  // Veto the most persistently accumulated. Names with no POSFRAC reading are
  // never vetoed: absence of data is not evidence of accumulation.
  if (p.vetoFrac > 0) {
    const withPf = rows.filter(r => r.posfrac !== null).sort((a, b) => b.posfrac - a.posfrac);
    const k = Math.floor(withPf.length * p.vetoFrac);
    for (let z = 0; z < k; z++) withPf[z].vetoed = true;
  }
  return rows;
}

/**
 * Target book at bar i given what is currently held.
 *
 * @param {object} args
 * @param {Map} args.series
 * @param {number} args.i                      decision bar
 * @param {number[]} args.ihsgClose
 * @param {number[]} args.ihsgSma               precomputed 200d SMA, null before warmup
 * @param {string[]} args.currentHoldings
 * @param {object} [args.opts]
 * @returns {{target:string[], exposure:number, reason:string, vetoedCount:number,
 *            eligible:number, kept:string[], added:string[], dropped:string[]}}
 */
function targetBook({ series, i, ihsgClose, ihsgSma, currentHoldings, opts }) {
  const p = { ...DEFAULTS, ...(opts || {}) };
  const held = currentHoldings || [];
  const xs = crossSection(series, i, p);

  if (xs.length < p.minEligible) {
    return { target: held.slice(), exposure: 1, reason: `INSUFFICIENT_UNIVERSE (${xs.length} < ${p.minEligible}) — book unchanged`,
             vetoedCount: 0, eligible: xs.length, kept: held.slice(), added: [], dropped: [] };
  }

  const belowSma = ihsgSma[i] !== null && ihsgSma[i] !== undefined && ihsgClose[i] < ihsgSma[i];
  const exposure = belowSma ? 0 : 1;

  const rank = new Map(xs.map(r => [r.ticker, r.rank]));
  const vetoed = new Set(xs.filter(r => r.vetoed).map(r => r.ticker));

  let target = [];
  if (exposure > 0) {
    let keep = held.filter(t => rank.has(t) && rank.get(t) < p.positions * p.bufferMult);
    if (p.exitOnVeto) keep = keep.filter(t => !vetoed.has(t));
    keep = keep.sort((a, b) => rank.get(a) - rank.get(b)).slice(0, p.positions);
    const keepSet = new Set(keep);
    target = keep.slice();
    for (const r of xs) {
      if (target.length >= p.positions) break;
      if (keepSet.has(r.ticker) || target.includes(r.ticker)) continue;
      if (vetoed.has(r.ticker)) continue;
      target.push(r.ticker);
    }
  }

  const tset = new Set(target), hset = new Set(held);
  return {
    target,
    exposure,
    reason: exposure === 0 ? 'REGIME_FLAT — IHSG below its own 200d SMA, stand aside' : 'INVESTED',
    vetoedCount: vetoed.size,
    eligible: xs.length,
    kept: target.filter(t => hset.has(t)),
    added: target.filter(t => !hset.has(t)),
    dropped: held.filter(t => !tset.has(t)),
  };
}

/** IHSG 200d SMA series from close prices. Backward-only by construction. */
function smaSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  let run = 0;
  for (let i = 0; i < closes.length; i++) {
    run += closes[i];
    if (i >= period) run -= closes[i - period];
    if (i >= period - 1) out[i] = run / period;
  }
  return out;
}

module.exports = { DEFAULTS, crossSection, targetBook, smaSeries, rollingMedian, posfrac, clipDn };
