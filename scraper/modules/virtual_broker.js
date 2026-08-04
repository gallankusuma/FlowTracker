/**
 * Virtual broker — the decision logic for a simulated Rp100 juta account.
 *
 * Pure by design: no database, no clock, no I/O. Everything that decides how
 * many lots to buy, whether a stop or a target was hit, and what an exit is
 * worth lives here, so the fifteen mandatory tests can drive it directly. The
 * orchestration and the ledger live in virtual_portfolio.js.
 *
 * WHY THIS IS NOT paper_trading.js. That module validates model CANDIDATES: each
 * recommendation stands alone, measured in units of R, with no shared cash, no
 * lots, no buying power and no account ceiling. A portfolio is a different
 * object — positions compete for one pot of money, and a trade you cannot fund
 * is a trade that did not happen.
 *
 * TWO ACCOUNTS, DELIBERATELY SEPARATE. The recommendation source is shared; the
 * exit policy is not.
 *
 *   POSITION       stop, target, or 40 bars   — the horizon this engine was built for
 *   INTRADAY_EOD   stop, target, or that day's close
 *
 * They must never share a track record. EXP-019 already measured the intraday
 * rule at -0.951% per trade on this system's own BUY days (n=2,204, t=-18.5),
 * worse than the -0.673% unconditional base rate, so INTRADAY_EOD is expected
 * to lose. It is run to confirm that forward, not in hope of a different answer,
 * and it must not be tuned until it stops.
 *
 * WHAT THIS IS NOT. Daily OHLC tells us a level was touched, never in what
 * order. Both levels touched resolves to STOP, the conservative reading already
 * used by the paper-trading engine. Nothing here pretends an order was sent
 * before the close; that needs an intraday feed.
 */
'use strict';

const crypto = require('crypto');

/** IDX board lot. Position sizes are always a whole multiple of this. */
const LOT = 100;

/**
 * The execution contract. Versioned as one object rather than scattered
 * constants, because it is hashed: change a fee, the slippage, or an exit rule
 * and the resulting record is a different experiment that must not be pooled
 * with the old one.
 */
const DEFAULT_CONFIG = {
  version: 1,
  startingCash: 100_000_000,
  riskPerTrade: 0.005,          // 0.50% of NAV at risk per position
  maxPositionNotional: 0.125,   // 12.5% of NAV in any one name
  maxPositions: 8,
  maxGrossExposure: 0.90,       // never more than 90% invested
  feeBuy: 0.0015,
  feeSell: 0.0025,
  slippage: 0.0010,
  lot: LOT,
  // The RISK LAYER, taken from modules/trade_policy.js rather than invented
  // here. Risk-based sizing is only as meaningful as its stop, so a made-up
  // stop distance would make every position size arbitrary. These are hashed
  // with the rest: changing the stop or the target starts a new record.
  maxHoldBars: 40,              // POSITION only
  riskAtrMult: 2.5,             // stop = entry - 2.5 x ATR14
  fallbackRiskPct: 5,           // when ATR is not computable
  targetR: 2,                   // take profit at 2R (target1R); 4R is the runner the policy allows
};

/**
 * Stop and target for an entry, from the active trade policy.
 *
 * ATR must be computed from bars up to and INCLUDING the signal date and no
 * further — the entry happens the next morning, and an ATR that peeked at that
 * bar would be sizing the position with tomorrow's information.
 */
function tradeLevels(entryPrice, atr, config = DEFAULT_CONFIG) {
  const c = { ...DEFAULT_CONFIG, ...config };
  const risk = atr > 0 ? c.riskAtrMult * atr : entryPrice * (c.fallbackRiskPct / 100);
  const stopPrice = entryPrice - risk;
  return {
    stopPrice,
    targetPrice: entryPrice + c.targetR * risk,
    riskPerShare: risk,
    usedFallback: !(atr > 0),
  };
}

/** Wilder ATR over the trailing `period` bars ending at the last element. */
function atrFrom(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    if (!(b.high > 0) || !(b.low > 0) || !(p.close > 0)) continue;
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  if (tr.length < period) return null;
  const window = tr.slice(-period);
  return window.reduce((a, b) => a + b, 0) / period;
};

const EXIT_POLICIES = { POSITION: 'POSITION', INTRADAY_EOD: 'INTRADAY_EOD' };

/**
 * Identity of the execution contract. Two accounts differing only in exit
 * policy get different hashes, which is the point: their results are answers to
 * different questions.
 */
function executionPolicyHash(config, exitPolicy) {
  const c = { ...DEFAULT_CONFIG, ...config };
  const payload = Object.keys(c).sort().map(k => [k, c[k]]);
  return crypto.createHash('sha256')
    .update(JSON.stringify({ exitPolicy, config: payload }))
    .digest('hex').slice(0, 16);
}

/** Round DOWN to a whole board lot. Never round up — that would spend money the sizing did not authorise. */
function floorToLot(qty, lot = LOT) {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  return Math.floor(qty / lot) * lot;
}

/** What buying `qty` at `price` actually costs, fees and slippage included. */
function buyCost(qty, price, config = DEFAULT_CONFIG) {
  const fillPrice = price * (1 + config.slippage);
  const gross = qty * fillPrice;
  return { fillPrice, gross, fee: gross * config.feeBuy, total: gross * (1 + config.feeBuy) };
}

/** What selling `qty` at `price` actually returns. */
function sellProceeds(qty, price, config = DEFAULT_CONFIG) {
  const fillPrice = price * (1 - config.slippage);
  const gross = qty * fillPrice;
  return { fillPrice, gross, fee: gross * config.feeSell, net: gross * (1 - config.feeSell) };
}

/**
 * How many lots to buy, or why none.
 *
 * Risk-based, then capped three ways. The caps are not decoration: a position
 * sized purely on risk can be enormous when the stop is tight, and an account
 * that cannot fund it has not made that trade.
 *
 * @returns {{quantity:number, notional:number, riskBudget:number, rejectReason:string|null, cappedBy:string|null}}
 */
function sizeOrder({ nav, cash, entryPrice, stopPrice, fillPrice = null, grossExposure = 0, openPositions = 0, config = DEFAULT_CONFIG }) {
  const c = { ...DEFAULT_CONFIG, ...config };
  const no = (reason) => ({ quantity: 0, notional: 0, riskBudget: 0, rejectReason: reason, cappedBy: null });

  // `fillPrice`, when given, is the price actually paid — slippage already in
  // it. Pass it and the whole calculation runs on one basis, so the recorded
  // entry, the stop distance and the cost all reconcile. Omit it and the
  // quoted price is used, with slippage applied here.
  const basis = fillPrice > 0 ? fillPrice : entryPrice;
  if (!(basis > 0)) return no('NO_ENTRY_PRICE');
  if (!(stopPrice > 0) || stopPrice >= basis) return no('INVALID_STOP');
  if (openPositions >= c.maxPositions) return no('MAX_POSITIONS');
  if (!(nav > 0) || !(cash > 0)) return no('NO_CAPITAL');

  const riskBudget = nav * c.riskPerTrade;
  const riskPerShare = basis - stopPrice;

  // Every cap expressed as a quantity, so the binding one is visible.
  const perUnitCost = (fillPrice > 0 ? fillPrice : entryPrice * (1 + c.slippage)) * (1 + c.feeBuy);
  const caps = {
    RISK: riskBudget / riskPerShare,
    POSITION_NOTIONAL: (nav * c.maxPositionNotional) / perUnitCost,
    CASH: cash / perUnitCost,
    GROSS_EXPOSURE: Math.max(0, nav * c.maxGrossExposure - grossExposure) / perUnitCost,
  };
  let cappedBy = 'RISK', raw = caps.RISK;
  for (const [name, v] of Object.entries(caps)) if (v < raw) { raw = v; cappedBy = name; }

  const quantity = floorToLot(raw, c.lot);
  if (quantity <= 0) {
    // Name the binding constraint rather than a generic failure: "one lot costs
    // more than the risk budget allows" and "no cash left" are different
    // problems with different fixes.
    return { quantity: 0, notional: 0, riskBudget, rejectReason: `BELOW_ONE_LOT_${cappedBy}`, cappedBy };
  }
  const notional = fillPrice > 0 ? quantity * fillPrice * (1 + c.feeBuy) : buyCost(quantity, entryPrice, c).total;
  return { quantity, notional, riskBudget, rejectReason: null, cappedBy };
}

/**
 * What happened to an open position on one daily bar.
 *
 * PRIORITY, and the order is the whole point:
 *   1. no usable entry            -> NO_FILL
 *   2. stop AND target both hit   -> STOP
 *   3. stop hit                   -> STOP
 *   4. target hit                 -> TARGET
 *   5. neither, INTRADAY_EOD      -> EOD_CLOSE
 *   6. neither, POSITION          -> still open, or TIME_EXIT at maxHoldBars
 *
 * Rule 2 is a conservative assumption, not a fact. Daily OHLC records that the
 * low reached the stop and the high reached the target; it cannot say which came
 * first. Resolving to STOP is the same choice walkForwardResolve already makes.
 *
 * @param {{high:number,low:number,close:number}} bar
 */
function resolveBar({ bar, stopPrice, targetPrice, exitPolicy, barsHeld = 1, config = DEFAULT_CONFIG }) {
  const c = { ...DEFAULT_CONFIG, ...config };
  if (!bar || !(bar.close > 0)) return { exitReason: null, exitPrice: null, open: true, unpriced: true };

  const hitStop = bar.low > 0 && bar.low <= stopPrice;
  const hitTarget = bar.high > 0 && bar.high >= targetPrice;

  if (hitStop) return { exitReason: 'STOP', exitPrice: stopPrice, open: false, ambiguous: hitTarget };
  if (hitTarget) return { exitReason: 'TARGET', exitPrice: targetPrice, open: false, ambiguous: false };

  if (exitPolicy === EXIT_POLICIES.INTRADAY_EOD) {
    return { exitReason: 'EOD_CLOSE', exitPrice: bar.close, open: false, ambiguous: false };
  }
  if (barsHeld >= c.maxHoldBars) {
    return { exitReason: 'TIME_EXIT', exitPrice: bar.close, open: false, ambiguous: false };
  }
  return { exitReason: null, exitPrice: null, open: true, ambiguous: false };
}

/**
 * Account value. NAV is cash plus what the holdings are worth — nothing else,
 * and it must reconcile exactly. `unmarkable` names are carried at cost and
 * reported, never silently valued at zero.
 */
function markToMarket({ cash, positions, priceOf }) {
  let marketValue = 0;
  const unmarkable = [];
  for (const p of positions) {
    const px = priceOf(p.ticker);
    if (!(px > 0)) { unmarkable.push(p.ticker); marketValue += Number(p.cost_basis || 0); continue; }
    marketValue += Number(p.quantity) * px;
  }
  return { cash, marketValue, totalNav: cash + marketValue, unmarkable };
}

module.exports = {
  LOT, DEFAULT_CONFIG, EXIT_POLICIES,
  executionPolicyHash, floorToLot, buyCost, sellProceeds,
  sizeOrder, resolveBar, markToMarket, tradeLevels, atrFrom,
};
