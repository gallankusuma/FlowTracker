'use strict';

/**
 * Single source of truth for the TRADING HORIZON and trade-plan geometry.
 *
 * WHY THIS MODULE EXISTS (2026-08-02)
 * ------------------------------------
 * The horizon was previously three unrelated hardcoded constants that had
 * silently drifted apart from each other and from how the system is actually
 * traded:
 *
 *   awo_optimizer.js      OUTCOME_MAX_HOLD = 15   (outcome labelling + purge gap)
 *   modules/paper_trading MAX_HOLD_DAYS    = 15   (live paper-trade exits)
 *   awo_technical.js      1.5x ATR risk, 1.5R/2.5R targets
 *   server.js             age > 30 days -> EXPIRED (journal rows)
 *
 * Every directional factor, every backtest, and the live paper trader were
 * therefore calibrated for a 1-3 week SWING horizon. Holding a position past
 * 15 trading days was not merely discouraged — it was unrepresentable: the
 * optimizer force-labelled a TIME_EXIT at bar 15 and the paper trader closed
 * the position there. A 2-8 week POSITION style could not be expressed at all,
 * and its backtest results could never have been measured.
 *
 * These knobs are genuinely coupled and must move together. Widening the hold
 * without widening the risk unit just means more time for a too-tight stop to
 * be hit by noise; widening the risk unit without widening the targets shrinks
 * the reward/risk ratio below what the 0.50% round-trip cost needs.
 *
 * COST ARITHMETIC — why riskAtrMult matters more than it looks
 * ------------------------------------------------------------
 * The round-trip cost is a fixed ~0.50% of notional, but the unit of account
 * is R (= entry - stopLoss). Cost measured in R is therefore
 *
 *     costR = 0.50% / (riskAtrMult * ATR%)
 *
 * For a typical IDX big cap at ATR ~2%, the SWING profile's 1.5x ATR gives a
 * ~3% risk unit and burns ~0.17R per round trip; a 2% fixed stop (as used in
 * EXP-002/003) burns 0.25R — a quarter of the risk budget gone before the
 * trade moves. POSITION's 2.5x ATR gives a ~5% risk unit and ~0.10R of cost.
 * Wider is not "riskier" here: position SIZE is what controls risk, and the
 * sizing layer divides by the risk unit.
 *
 * SCOPE — what this module deliberately does NOT do
 * --------------------------------------------------
 * It sets the horizon of the EXIT and the geometry of the PLAN. It does not
 * change the speed of the FACTORS (F4 still reads 3-5 day ROC, F12 still uses
 * EMA9/21, F2 still reads a 5-day dn window). Slowing those to match is a
 * separate, larger change — until it lands, a POSITION profile is holding
 * swing-speed signals for longer, which is a real mismatch and an expected
 * finding of the next backtest round, not a bug in this module.
 *
 * CHANGING THE PROFILE INVALIDATES PAPER-TRADING HISTORY
 * ------------------------------------------------------
 * maxHoldBars and the target multiples are exit-policy parameters that are NOT
 * part of candidateKeyFromWeights (documented gap in modules/paper_trading.js).
 * Trades resolved under different profiles are not comparable, so any profile
 * change must be accompanied by an AWO_MODEL_VERSION bump in server.js, which
 * makes getOrFreezeChallenger auto-archive a stale challenger rather than let
 * it accumulate a mixed-policy track record.
 *
 * USAGE
 *   const policy = require('./modules/trade_policy');
 *   policy.active().maxHoldBars
 *   policy.resolve({ maxHoldBars: 60 })   // backtests sweeping the horizon
 */

/**
 * @typedef {Object} TradeProfile
 * @property {string} label              Human-readable name
 * @property {number} maxHoldBars        Trading days before a TIME_EXIT is forced
 * @property {number} riskAtrMult        Risk unit as a multiple of ATR(14)
 * @property {number} fallbackRiskPct    Risk unit when ATR is unavailable, % of price
 * @property {number} target1R           First target, in R
 * @property {number} target2R           Second target, in R
 * @property {number} targetSnapCeilingR Furthest an S/R level may sit and still be
 *                                       snapped to as target2, in R
 * @property {number} journalExpiryDays  Calendar days before an open journal row
 *                                       is marked EXPIRED
 */

/** @type {Record<string, TradeProfile>} */
const PROFILES = {
  // The historical calibration. Kept so prior results stay reproducible and so
  // the horizon can be A/B-tested rather than merely replaced.
  SWING: {
    label: 'Swing (1-3 weeks)',
    maxHoldBars: 15,
    riskAtrMult: 1.5,
    fallbackRiskPct: 3,
    target1R: 1.5,
    target2R: 2.5,
    targetSnapCeilingR: 4,
    journalExpiryDays: 30,
  },

  // Active profile as of 2026-08-02. 40 trading days ~ 8 calendar weeks, the
  // top of the intended 2-8 week holding range. journalExpiryDays covers that
  // 40-bar window in calendar terms (~56 days) plus buffer, so a position is
  // never marked EXPIRED while its thesis is still legitimately running.
  POSITION: {
    label: 'Position (2-8 weeks)',
    maxHoldBars: 40,
    riskAtrMult: 2.5,
    fallbackRiskPct: 5,
    target1R: 2,
    target2R: 4,
    targetSnapCeilingR: 6.4,
    journalExpiryDays: 75,
  },
};

const DEFAULT_PROFILE = 'POSITION';

function profileName() {
  const raw = (process.env.AWO_HORIZON || DEFAULT_PROFILE).toUpperCase();
  if (!PROFILES[raw]) {
    console.warn(
      `[trade_policy] Unknown AWO_HORIZON="${process.env.AWO_HORIZON}" — ` +
      `falling back to ${DEFAULT_PROFILE}. Valid: ${Object.keys(PROFILES).join(', ')}`
    );
    return DEFAULT_PROFILE;
  }
  return raw;
}

/**
 * The active profile, read fresh from env on every call so a test or a backtest
 * can flip AWO_HORIZON without module-cache surprises.
 * @returns {TradeProfile & {name: string}}
 */
function active() {
  const name = profileName();
  return { name, ...PROFILES[name] };
}

/**
 * Active profile with explicit per-call overrides applied — the form callers
 * should use so a backtest can sweep one knob without mutating global state.
 * @param {Partial<TradeProfile>} [overrides]
 * @returns {TradeProfile & {name: string}}
 */
function resolve(overrides) {
  return { ...active(), ...(overrides || {}) };
}

module.exports = { PROFILES, DEFAULT_PROFILE, active, resolve };
