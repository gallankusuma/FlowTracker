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
const policy = require('./trade_policy');
const { calcATR } = require('../awo_technical');

/** IDX board lot. Position sizes are always a whole multiple of this. */
const LOT = 100;

/**
 * The execution contract. Versioned as one object rather than scattered
 * constants, because it is hashed: change a fee, the slippage, or an exit rule
 * and the resulting record is a different experiment that must not be pooled
 * with the old one.
 */
/**
 * The RISK LAYER comes from modules/trade_policy.js, which exists to be the
 * single source of truth for it.
 *
 * The previous version claimed to do this and did not: it re-declared
 * maxHoldBars, riskAtrMult, fallbackRiskPct and targetR as literals that
 * happened to match the POSITION profile. Matching by coincidence is not
 * sharing — change the profile and the virtual portfolio would have kept sizing
 * against the old one while the trade-plan engine moved, and nothing would have
 * said so. The 2026-08-05 review caught it.
 *
 * `resolve()` reads the active profile fresh, so AWO_HORIZON=SWING really does
 * produce a different contract — and the profile NAME is part of the config, so
 * the execution policy hash moves with it instead of two profiles quietly
 * sharing a track record.
 */
function riskLayer() {
  const p = policy.active();
  return {
    profile: p.name,
    maxHoldBars: p.maxHoldBars,
    riskAtrMult: p.riskAtrMult,
    fallbackRiskPct: p.fallbackRiskPct,
    targetR: p.target1R,
  };
}

const DEFAULT_CONFIG = {
  // v2 (2026-08-05): the accounting and execution changes from the review —
  // session calendar, opening-NAV sizing, gap-aware exits, aggregate per-name
  // cap, strategy-hash isolation. v1 records must not be pooled with these.
  version: 2,
  startingCash: 100_000_000,
  riskPerTrade: 0.005,          // 0.50% of NAV at risk per position
  maxPositionNotional: 0.125,   // 12.5% of NAV in any one name, AGGREGATE
  maxPositions: 8,
  maxGrossExposure: 0.90,       // never more than 90% invested
  feeBuy: 0.0015,
  feeSell: 0.0025,
  slippage: 0.0010,
  lot: LOT,
  // Pyramiding is OFF: a name already held is not bought again. Explicit and
  // hashed, because "top up the winners" is a different strategy, not a detail.
  allowPyramiding: false,
  ...riskLayer(),
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

/**
 * ATR over bars ending at the last element, via awo_technical.calcATR.
 *
 * This used to be a local loop with the docstring "Wilder ATR" over a plain
 * mean of the last 14 true ranges. Wilder smoothing is recursive and gives a
 * different number, so the label was simply false, and the virtual portfolio
 * was sizing against an ATR the rest of the system does not use. Delegating
 * removes the second implementation rather than correcting it in place — a
 * corrected copy is still a copy, and the next divergence is a matter of time.
 */
function atrFrom(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null;
  const usable = bars.filter(b => b && b.high > 0 && b.low > 0 && b.close > 0);
  if (usable.length < period + 1) return null;
  return calcATR(usable.map(b => b.high), usable.map(b => b.low), usable.map(b => b.close), period);
}

const EXIT_POLICIES = { POSITION: 'POSITION', INTRADAY_EOD: 'INTRADAY_EOD' };

/**
 * THE EXECUTION ENGINE VERSION — deliberate, and not the git commit.
 *
 * `execution_policy_hash` captures the CONFIGURATION: fees, slippage, caps, the
 * risk layer. It does not move when the ALGORITHM changes, and on 2026-08-05 two
 * material rules changed without shifting it by a character — gap fills moved to
 * the open, and an unreadable bar began blocking the walk instead of being
 * skipped. Trades before and after are not comparable, and nothing said so.
 *
 * The raw commit is the wrong instrument for this. It moves when a comment is
 * edited, which would retire an account and restart its capital over a typo.
 * This number moves when EXECUTION BEHAVIOUR moves, and a human has to decide
 * that it did. It is part of the account identity: bump it and the old account
 * retires while a new one starts again from Rp100 juta.
 *
 * BUMP THIS when any of these change materially:
 *   fill rules, gap handling, missing-bar behaviour, NAV/opening sizing,
 *   order sequencing, retirement behaviour, transaction lifecycle.
 *
 * History:
 *   1  the original engine (2026-08-04)
 *   2  session calendar as the date axis; opening-NAV sizing; aggregate per-name
 *      cap; gap fills at the open; DATA_INCOMPLETE blocks the walk; retirement
 *      unwinds instead of running on; strategy-hash isolation  (2026-08-05)
 */
const EXECUTION_ENGINE_VERSION = 2;

/**
 * Identity of the execution contract. Two accounts differing only in exit
 * policy get different hashes, which is the point: their results are answers to
 * different questions.
 */
function executionPolicyHash(config, exitPolicy) {
  const c = { ...DEFAULT_CONFIG, ...config };
  const payload = Object.keys(c).sort().map(k => [k, c[k]]);
  // The engine version is IN the hash. Without it a behaviour change kept the
  // same hash, so the same account carried trades executed under two different
  // algorithms and called the result one record.
  return crypto.createHash('sha256')
    .update(JSON.stringify({ exitPolicy, engine: EXECUTION_ENGINE_VERSION, config: payload }))
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
function sizeOrder({
  nav, cash, entryPrice, stopPrice, fillPrice = null,
  grossExposure = 0, openPositions = 0,
  // Market value ALREADY held in this same name, at the opening price. The
  // per-name cap is aggregate, not per order: the target book legitimately
  // retains a name across rebalances, so without this a retained ticker was
  // bought again every plan and one name could pass 12.5% three times over.
  tickerExposure = 0,
  config = DEFAULT_CONFIG,
}) {
  const c = { ...DEFAULT_CONFIG, ...config };
  const no = (reason) => ({ quantity: 0, notional: 0, riskBudget: 0, rejectReason: reason, cappedBy: null });

  // Pyramiding is a strategy choice, not a sizing detail. With it off, a name
  // already held is simply not bought again — the position that exists is the
  // position the plan wanted.
  if (tickerExposure > 0 && !c.allowPyramiding) return no('ALREADY_HELD');

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
    // Aggregate: what this name may hold in total, less what it already holds.
    POSITION_NOTIONAL: Math.max(0, nav * c.maxPositionNotional - tickerExposure) / perUnitCost,
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
 *   1. no close                     -> unpriced, stays open
 *   2. no high or no low            -> DATA_INCOMPLETE, stays open
 *   3. open gapped through stop     -> STOP at the OPEN
 *   4. open gapped through target   -> TARGET at the OPEN
 *   5. stop AND target both touched -> STOP at the stop
 *   6. stop touched                 -> STOP
 *   7. target touched               -> TARGET
 *   8. neither, INTRADAY_EOD        -> EOD_CLOSE
 *   9. neither, POSITION            -> still open, or TIME_EXIT at maxHoldBars
 *
 * Rule 5 is a conservative assumption, not a fact. Daily OHLC records that the
 * low reached the stop and the high reached the target; it cannot say which came
 * first. Resolving to STOP is the same choice walkForwardResolve already makes.
 *
 * Rules 3 and 4 exist because assuming otherwise flatters the simulation. A
 * stock that gaps from 1000 to 800 through a 950 stop cannot be sold at 950 —
 * the first available price is the open, and the loss is larger than the plan.
 *
 * @param {{open:number,high:number,low:number,close:number}} bar
 */
function resolveBar({ bar, stopPrice, targetPrice, exitPolicy, barsHeld = 1, config = DEFAULT_CONFIG }) {
  const c = { ...DEFAULT_CONFIG, ...config };
  if (!bar || !(bar.close > 0)) return { exitReason: null, exitPrice: null, open: true, unpriced: true };

  // AN INCOMPLETE BAR IS NOT A QUIET BAR.
  // Missing high/low used to fall through every touch test and land on
  // EOD_CLOSE, which reads as "the level was never reached". It is not the same
  // claim: one is an observation, the other is an absence of one. A data outage
  // that looks like an execution outcome is the failure this project keeps
  // repeating, so it gets its own answer and the position stays open.
  if (!(bar.high > 0) || !(bar.low > 0)) {
    return { exitReason: null, exitPrice: null, open: true, dataIncomplete: true };
  }

  // GAPS FIRST, and this is the correction that matters most for realism.
  // The old code exited at exactly `stopPrice` whenever low <= stop, so a stock
  // that closed at 1000 and opened at 800 through a 950 stop was recorded as
  // selling at 950. Nobody could have. The first price at which the position
  // could actually be exited is the open, so a gap through the level fills
  // there and the loss is the real one.
  const hasOpen = bar.open > 0;
  if (hasOpen && bar.open <= stopPrice) {
    return { exitReason: 'STOP', exitPrice: bar.open, open: false, ambiguous: false, gapped: true };
  }
  // Gapping up through the target is the mirror image, and the honest fill is
  // also the open — better than the target, which is what actually happens to a
  // resting sell order when the market opens above it.
  if (hasOpen && bar.open >= targetPrice) {
    return { exitReason: 'TARGET', exitPrice: bar.open, open: false, ambiguous: false, gapped: true };
  }

  const hitStop = bar.low <= stopPrice;
  const hitTarget = bar.high >= targetPrice;

  if (hitStop) return { exitReason: 'STOP', exitPrice: stopPrice, open: false, ambiguous: hitTarget, gapped: false };
  if (hitTarget) return { exitReason: 'TARGET', exitPrice: targetPrice, open: false, ambiguous: false, gapped: false };

  if (exitPolicy === EXIT_POLICIES.INTRADAY_EOD) {
    return { exitReason: 'EOD_CLOSE', exitPrice: bar.close, open: false, ambiguous: false, gapped: false };
  }
  if (barsHeld >= c.maxHoldBars) {
    return { exitReason: 'TIME_EXIT', exitPrice: bar.close, open: false, ambiguous: false, gapped: false };
  }
  return { exitReason: null, exitPrice: null, open: true, ambiguous: false };
}

/**
 * Account value. NAV is cash plus what the holdings are worth — nothing else,
 * and it must reconcile exactly. `unmarkable` names are carried at cost and
 * reported, never silently valued at zero.
 */
function markToMarket({ cash, positions, priceOf, lastCloseOf = null }) {
  let marketValue = 0;
  const unmarkable = [];   // fell all the way back to cost — NAV is degraded
  const stale = [];        // marked at a last-known close, not today's

  for (const p of positions) {
    const px = priceOf(p.ticker);
    if (px > 0) { marketValue += Number(p.quantity) * px; continue; }

    // FALL BACK TO THE LAST KNOWN PRICE BEFORE FALLING BACK TO COST.
    // Carrying an unpriced holding at cost is not neutral: a name that has
    // doubled, or halved, snaps back to its entry value and the NAV jumps for
    // reasons that have nothing to do with the market. One missing close should
    // not erase months of P&L. Cost is the last resort, and when it is used the
    // account is reported as degraded rather than merely annotated.
    const last = lastCloseOf ? lastCloseOf(p.ticker) : null;
    if (last > 0) {
      marketValue += Number(p.quantity) * last;
      stale.push(p.ticker);
      continue;
    }
    unmarkable.push(p.ticker);
    marketValue += Number(p.cost_basis || 0);
  }

  return {
    cash, marketValue, totalNav: cash + marketValue,
    unmarkable, stale,
    degraded: unmarkable.length > 0,
  };
}

module.exports = {
  LOT, DEFAULT_CONFIG, EXIT_POLICIES, riskLayer, EXECUTION_ENGINE_VERSION,
  executionPolicyHash, floorToLot, buyCost, sellProceeds,
  sizeOrder, resolveBar, markToMarket, tradeLevels, atrFrom,
};
