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
  // As-of replacements for the whole-sample screens the loaders used to apply
  // (review P0.2). `placed >= 400 lifetime bars` becomes "enough real bars
  // INSIDE the trailing hiBars window", and `nConc >= 200 lifetime broker
  // observations` becomes "POSFRAC_60 is computable at this bar" — which is
  // what the strategy actually needs and already tests via posfracMinReal.
  minHiWindowBars: 200,
  requirePosfrac: true,
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
    if (s.close[i] === null || s.close[i] === undefined) continue;
    const adv = rollingMedian(s.value, i, p.advWindow);
    if (adv === null || adv < p.minAdv) continue;

    // One pass for the 52-week high and the depth check. `realBars` counts only
    // bars inside [i-hiBars+1, i], so it is causal by construction: nothing
    // after `i` can change it.
    //
    // This replaces `if (i < p.hiBars) continue`, which tested a position on the
    // shared IHSG date axis rather than the ticker's own history — wrong for any
    // name that listed after the axis began, and unable to say anything at all
    // about coverage gaps. It also replaces the loaders' `placed >= 400`
    // lifetime screen, which asked whether a ticker would EVENTUALLY accumulate
    // 400 bars by the end of the sample (review P0.2).
    let hi = -Infinity, realBars = 0;
    for (let j = Math.max(0, i - p.hiBars + 1); j <= i; j++) {
      const c = s.close[j];
      if (c !== null && c !== undefined) realBars++;
      const h = s.high[j];
      if (h !== null && h !== undefined && h > hi) hi = h;
    }
    if (realBars < p.minHiWindowBars) continue;
    if (!(hi > 0)) continue;

    // POSFRAC_60 needs posfracMinReal real dn0 readings inside the trailing
    // window. Requiring it here is the as-of form of the loaders' lifetime
    // `nConc >= 200`, and it matches this module's own documented universe
    // ("enough concentration history for POSFRAC_60"). Without it a name with
    // no broker data at all was eligible AND unvetoable — it could only ever
    // be selected, never excluded.
    const pf = posfrac(s.dn0, i, p);
    if (p.requirePosfrac && pf === null) continue;

    rows.push({ ticker, hi52w: (s.close[i] / hi) * 100, posfrac: pf, vetoed: false });
  }
  rows.sort((a, b) => b.hi52w - a.hi52w);
  rows.forEach((r, k) => { r.rank = k; });

  // Veto the most persistently accumulated. Names with no POSFRAC reading are
  // never vetoed: absence of data is not evidence of accumulation.
  //
  // `vetoSelector` exists so an experiment can swap the SELECTION RULE (reverse
  // control, random control, a different dose) without reimplementing
  // eligibility, ranking, POSFRAC or buffering. Before this hook, EXP-017 had
  // its own copy of all of that, and the copy had a look-ahead the live module
  // did not — which is exactly the drift a "single source of truth" module is
  // supposed to make impossible. One implementation, one injected decision.
  if (typeof p.vetoSelector === 'function') {
    const banned = p.vetoSelector(rows, p);
    if (banned && typeof banned.has === 'function') {
      for (const r of rows) if (banned.has(r.ticker)) r.vetoed = true;
    }
  } else if (p.vetoFrac > 0) {
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

  // The regime is computed BEFORE the universe check, and deliberately so. It
  // depends only on IHSG, so a failure to build a cross-section says nothing
  // about it. This used to return `exposure: 1` on an insufficient universe
  // without ever reading ihsgSma — meaning a broker-data outage would hold the
  // book at full exposure through a bear market, with the one signal that did
  // not need the missing data never consulted. Reachable in production: a stale
  // idx_concentration nulls POSFRAC for every ticker at once.
  const belowSma = ihsgSma[i] !== null && ihsgSma[i] !== undefined && ihsgClose[i] < ihsgSma[i];
  const exposure = belowSma ? 0 : 1;

  if (xs.length < p.minEligible) {
    // Can't rank, so don't churn — but standing aside IS computable, so honour it.
    return {
      target: exposure === 0 ? [] : held.slice(),
      exposure,
      reason: exposure === 0
        ? `INSUFFICIENT_UNIVERSE (${xs.length} < ${p.minEligible}) + REGIME_FLAT — stand aside`
        : `INSUFFICIENT_UNIVERSE (${xs.length} < ${p.minEligible}) — book unchanged`,
      vetoedCount: 0, eligible: xs.length,
      kept: exposure === 0 ? [] : held.slice(),
      added: [],
      dropped: exposure === 0 ? held.slice() : [],
    };
  }

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

/**
 * Market regime at bar i, as a LABEL for the record — never as a decision input.
 *
 * The promotion gate asks whether a track record has been tested in more than
 * one market. Before this existed it derived the label from the first token of
 * the strategy's `reason` string, whose only values are INVESTED, REGIME_FLAT
 * and INSUFFICIENT_UNIVERSE. Two of those share a first token, so the maximum
 * achievable count was exactly 3 — and only if a DATA OUTAGE was present. A
 * gate requiring three regimes therefore required something to be broken
 * (review P1.1).
 *
 * Three states, from the index only, using the same SMA the strategy already
 * trusts: where price sits relative to it, and which way the average itself is
 * going. SIDEWAYS is the honest label for the mixed cases rather than forcing
 * everything into up or down.
 *
 * Returns null before there is enough history to say anything.
 */
function marketRegime(closes, sma, i, slopeBars = 60) {
  if (!Array.isArray(closes) || !Array.isArray(sma)) return null;
  const c = closes[i], m = sma[i], mPrev = sma[i - slopeBars];
  if (!(c > 0) || !(m > 0) || !(mPrev > 0)) return null;
  const above = c > m;
  const rising = m > mPrev;
  if (above && rising) return 'BULL';
  if (!above && !rising) return 'BEAR';
  return 'SIDEWAYS';
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

module.exports = {
  marketRegime, DEFAULTS, crossSection, targetBook, smaSeries, rollingMedian, posfrac, clipDn };
