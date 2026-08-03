/**
 * The promotion gate for the forward test, and the statistics it needs —
 * separated from strategy_forward.js's database I/O so every rule here is
 * unit-testable without a database (same reasoning as walkForwardResolve in
 * paper_trading.js).
 *
 * Two things the 2026-08-03 review found, both fixed here:
 *
 * P0.6 — strategy_forward.js --status PRINTED "profit factor >= 1.10" as a
 * requirement and never computed profit factor anywhere. A requirement that is
 * displayed but not evaluated is not a gate.
 *
 * P0.7 — the gate counted closed POSITIONS (>=30). The strategy holds 8 names
 * at once, so 30 positions can come from as few as 4 rebalance decisions. Eight
 * positions opened on the same date share one IHSG regime, one liquidity
 * condition, one sector rotation; they are one observation wearing eight hats.
 * The gate now counts independent rebalance DECISIONS, calendar duration, and
 * how many distinct market regimes the record spans.
 */
'use strict';

/** Trading days per year on IDX, used to annualise the information ratio. */
const TRADING_DAYS_YEAR = 245;

/**
 * The bar a candidate must clear before it may be considered for real money.
 * Deliberately expressed in decisions and calendar time, not trade count.
 */
const GATE = {
  minRebalanceDecisions: 24,   // ~1 year at a 10-bar cadence
  minCalendarMonths: 12,
  minDistinctRegimes: 3,       // must have been tested in more than one market
  minFills: 50,                // execution realism, NOT a statistical sample size
  minProfitFactor: 1.10,
  minExcessReturn: 0,          // must beat buy-and-hold IHSG after costs
};

/**
 * Profit factor over closed positions: gross profit / gross loss, on NET
 * percentages (after the cost model). Returns null when there is nothing to
 * divide — never a number that a `<` comparison would silently pass.
 *
 * `Infinity` (wins, zero losses) is returned as-is rather than coerced: it is a
 * real state, and callers comparing `Infinity >= 1.10` get the right answer,
 * whereas coercing it to null would make a flawless record look like no record.
 */
function profitFactor(closedNetPcts) {
  const vals = closedNetPcts.map(Number).filter(Number.isFinite);
  if (!vals.length) return null;
  const gp = vals.filter(v => v > 0).reduce((s, v) => s + v, 0);
  const gl = vals.filter(v => v < 0).reduce((s, v) => s + Math.abs(v), 0);
  if (gl > 0) return gp / gl;
  return gp > 0 ? Infinity : null;
}

/**
 * Annualised information ratio of the strategy's period returns against a
 * benchmark's over the SAME periods. Returns null rather than a huge number
 * when the excess series has no dispersion — the same trap that produced a
 * 7.2e15 "information ratio" in the IC code before it was guarded.
 *
 * @param {number[]} port - per-period portfolio returns (fractional, e.g. 0.013)
 * @param {number[]} bench - per-period benchmark returns, same length/order
 * @param {number} barsPerPeriod - trading days per rebalance period
 */
function informationRatio(port, bench, barsPerPeriod) {
  const n = Math.min(port.length, bench.length);
  if (n < 2) return null;
  const ex = [];
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(port[i]) || !Number.isFinite(bench[i])) continue;
    ex.push(port[i] - bench[i]);
  }
  if (ex.length < 2) return null;
  const mean = ex.reduce((s, v) => s + v, 0) / ex.length;
  const varr = ex.reduce((s, v) => s + (v - mean) ** 2, 0) / (ex.length - 1);
  const sd = Math.sqrt(varr);
  if (!(sd > 1e-12)) return null;
  const periodsPerYear = TRADING_DAYS_YEAR / barsPerPeriod;
  return (mean / sd) * Math.sqrt(periodsPerYear);
}

/** Max drawdown of a cumulative equity curve, as a positive fraction. */
function maxDrawdown(equity) {
  let peak = -Infinity, mdd = 0;
  for (const v of equity) {
    if (!Number.isFinite(v)) continue;
    if (v > peak) peak = v;
    if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak);
  }
  return mdd;
}

/** Compound a series of fractional period returns into an equity curve starting at 1. */
function compound(returns) {
  const eq = [];
  let v = 1;
  for (const r of returns) { v *= (1 + (Number.isFinite(r) ? r : 0)); eq.push(v); }
  return eq;
}

/**
 * How many distinct market conditions the record actually spans. A track
 * record built entirely inside one bull run has not been tested; counting the
 * regimes the decisions were made under is the cheapest available check on
 * that. `regimes` is one label per decision (e.g. 'BULL'/'BEAR' from the
 * exposure reason recorded at decision time).
 */
function distinctRegimes(regimes) {
  return new Set(regimes.filter(Boolean)).size;
}

/**
 * Evaluate the gate. Every criterion is reported with its own pass/fail and the
 * actual value, so a rejection says WHICH bar was missed rather than just "no".
 *
 * @param {Object} m
 * @param {number} m.rebalanceDecisions - independent LIVE decision dates
 * @param {number} m.calendarMonths
 * @param {number} m.distinctRegimes
 * @param {number} m.fills
 * @param {number|null} m.profitFactor
 * @param {number|null} m.excessReturn - portfolio minus benchmark, fractional
 * @param {number} [m.replayDecisions] - reported for transparency; never counted
 * @param {Object} [gate]
 */
function evaluateForwardGate(m, gate = GATE) {
  const criteria = [
    { name: 'independent rebalance decisions (LIVE)', actual: m.rebalanceDecisions, required: gate.minRebalanceDecisions,
      pass: m.rebalanceDecisions >= gate.minRebalanceDecisions },
    { name: 'calendar months of LIVE record', actual: m.calendarMonths, required: gate.minCalendarMonths,
      pass: m.calendarMonths >= gate.minCalendarMonths },
    { name: 'distinct market regimes covered', actual: m.distinctRegimes, required: gate.minDistinctRegimes,
      pass: m.distinctRegimes >= gate.minDistinctRegimes },
    { name: 'fills observed', actual: m.fills, required: gate.minFills,
      pass: m.fills >= gate.minFills },
    // Explicit null checks. `null >= 1.10` is false in JS, but `undefined >= 1.10`
    // is also false while `undefined < 1.10` is false TOO — the asymmetry that let
    // the old promote gate pass an uncomputed profit factor. Never rely on it.
    { name: 'profit factor', actual: m.profitFactor, required: gate.minProfitFactor,
      pass: m.profitFactor !== null && m.profitFactor !== undefined && m.profitFactor >= gate.minProfitFactor },
    { name: 'excess return over IHSG, net of costs', actual: m.excessReturn, required: gate.minExcessReturn,
      pass: m.excessReturn !== null && m.excessReturn !== undefined && m.excessReturn > gate.minExcessReturn },
  ];
  const failed = criteria.filter(c => !c.pass);
  return {
    status: failed.length === 0 ? 'ELIGIBLE_FOR_REVIEW' : 'NOT_ELIGIBLE',
    criteria,
    failed: failed.map(c => c.name),
    // Stated separately and loudly: clearing this bar is permission to be
    // reviewed by a human, not permission to trade.
    note: 'ELIGIBLE_FOR_REVIEW means the record is long enough to be worth a human decision. It is not an instruction to deploy capital.',
    replayDecisionsExcluded: m.replayDecisions ?? 0,
  };
}

module.exports = {
  GATE, TRADING_DAYS_YEAR,
  profitFactor, informationRatio, maxDrawdown, compound, distinctRegimes,
  evaluateForwardGate,
};
