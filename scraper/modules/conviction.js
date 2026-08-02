/**
 * modules/conviction.js
 * Conviction Tier — combines the signal-quality findings validated via
 * backtest_signal_scanner_badges.js / backtest_harmonic_winrate.js into a
 * single tier + position-size multiplier, so the journal actually sizes
 * positions by how much historical evidence backs each signal, instead of a
 * flat allocation for every pick regardless of quality.
 *
 * RETRACTED 2026-07-28: the Counter-trend hard gate (trendAligned===false →
 * AVOID/0x) that used to sit here was based on a backtest run against F1-F8
 * formulas that turned out to have real bugs (F7 sign error, F6 50:50
 * boundary bug, F4 sign error, dn0 mis-scaled — see project memory
 * "AWO formula review fixes 2026-07-28"). Re-ran the exact same backtest
 * against the FIXED formulas: the counter-trend/aligned gap that justified
 * the hard block evaporated (45.9% vs 45.8% at +5d, n=370 vs n=1378) and
 * REVERSED at +10d (46.5% vs 42.7%) — the opposite of what the gate assumed.
 * Most likely the old "counter-trend is bad" finding was itself an artifact
 * of the same bugs (F7 in particular could mislabel which signals even
 * counted as aligned vs counter-trend). The gate is removed; trendAligned is
 * still surfaced as an informational badge in the UI, just no longer forces
 * AVOID/0x sizing.
 *
 * Validated inputs still in use (see project memory for the backing numbers,
 * refreshed 2026-07-28 against the fixed formulas):
 *   - AWO composite direction: SELL-like signals ~52% win rate vs BUY-like
 *     ~36% (+5d, n=1434/798) — same direction as before the formula fix,
 *     magnitude close to the original ~54-56%/~34-38% finding, so this one
 *     replicated rather than being an artifact.
 *   - Harmonic smart_money_confirmed: 73%->87% win rate, replicated in both
 *     regime halves of backtest_harmonic_winrate.js — strongest single boost.
 *     (Not yet re-validated against the F1-F8 fix — harmonic scoring doesn't
 *     use F1-F8 at all, so this number is unaffected by the bugs that hit
 *     the counter-trend/BUY-SELL findings above.)
 *   - ABCD vs exotic harmonic patterns (Gartley/Bat/Crab/Shark/Butterfly/Cypher):
 *     ABCD has the only sample size large enough to trust (695/787 events);
 *     the others are individually too thin (12-21 events) to size up on.
 *   - Explicitly NOT used: foreignDivergence label (Foreign Leading vs Domestic
 *     FOMO) — flipped direction entirely between the two regime halves tested,
 *     genuinely inconclusive, not a stable edge either way. Volume spike badge
 *     also excluded — no positive lift in either backtest.
 *
 * UPDATE 2026-07-22 (direction of the BUY<<SELL gap, still holds post-fix):
 * the gap turned out to be largely MARKET-REGIME driven, not a fixed property
 * of BUY signals — month-by-month breakdown showed BUY beating SELL in
 * clearly up-trending months and SELL crushing BUY in down-trending months —
 * see detectMarketDirection below.
 *
 * @returns {{tier:string, sizeMultiplier:number, reason:string}}
 */
'use strict';

const UP_THRESHOLD = 0.15;   // trailing avg daily cross-sectional change, %/day
const DOWN_THRESHOLD = -0.15;

/**
 * Classify UP / DOWN / FLAT market direction for conviction tiering.
 * Prefers the REAL IHSG index (idx_ihsg_history, added 2026-07-22 — see
 * fetchAndCacheIHSG/getIHSGTrend in server.js) since that's the actual market
 * benchmark, not a proxy. Falls back to the cross-sectional average daily
 * change across tracked stocks (the original proxy) only if IHSG data isn't
 * populated yet (e.g. fresh install before the first fetch).
 */
async function detectMarketDirection(pool) {
  try {
    const [ihsgRows] = await pool.query(
      `SELECT change_pct FROM idx_ihsg_history
       WHERE date >= (SELECT MAX(date) FROM idx_ihsg_history) - INTERVAL 10 DAY`
    );
    if (ihsgRows.length >= 5) {
      const avg = ihsgRows.reduce((s, r) => s + Number(r.change_pct || 0), 0) / ihsgRows.length;
      const direction = avg > UP_THRESHOLD ? 'UP' : avg < DOWN_THRESHOLD ? 'DOWN' : 'FLAT';
      return { direction, avgDailyChange: Math.round(avg * 1000) / 1000, source: 'IHSG' };
    }
  } catch {}

  try {
    const [rows] = await pool.query(
      `SELECT change_pct FROM idx_stock_prices
       WHERE date >= (SELECT MAX(date) FROM idx_stock_prices) - INTERVAL 10 DAY`
    );
    if (!rows.length) return { direction: 'FLAT', avgDailyChange: 0, source: 'proxy' };
    const avg = rows.reduce((s, r) => s + Number(r.change_pct || 0), 0) / rows.length;
    const direction = avg > UP_THRESHOLD ? 'UP' : avg < DOWN_THRESHOLD ? 'DOWN' : 'FLAT';
    return { direction, avgDailyChange: Math.round(avg * 1000) / 1000, source: 'proxy' };
  } catch {
    return { direction: 'FLAT', avgDailyChange: 0, source: 'proxy' };
  }
}

/**
 * `market` gates which reason text is used — the tier MECHANISM (trend-align
 * gate, smart-money bonus, regime-aware BUY/SELL sizing) is a general prior
 * that ports to any market, but the specific win-rate numbers in the default
 * reason strings came from backtests run ONLY on IDX data (see file header).
 * Any market other than 'IDX' gets the same tier/sizeMultiplier but honest
 * "structural heuristic, not backtested here" text instead of borrowed
 * IDX statistics — added when the harmonic engine was extended to the US
 * (S&P 500) market, which also has no broker-flow data (smartMoneyConfirmed
 * is structurally always false there, same as CRYPTO).
 */
function computeConvictionTier({ source, patternType, direction, trendAligned, smartMoneyConfirmed, signal, marketDirection, market = 'IDX' }) {
  const validated = market === 'IDX';

  // Counter-trend hard gate REMOVED 2026-07-28 — see file header. trendAligned
  // is intentionally unused here now; still surfaced as an informational
  // badge in the Signal Scanner UI, just doesn't affect tier/sizing anymore.

  const isHarmonic = source === 'harmonic' || (patternType && patternType !== 'AWO_SIGNAL');
  if (isHarmonic) {
    if (smartMoneyConfirmed) {
      return { tier: 'S', sizeMultiplier: 1.0, reason: validated
        ? 'Smart money confirmed — 73%→87% win rate, replicated across 2 market regimes'
        : 'Smart money confirmed — structural heuristic, not backtested on this market' };
    }
    if (patternType === 'ABCD') {
      return { tier: 'A', sizeMultiplier: 0.8, reason: validated
        ? 'ABCD pattern — largest validated sample (695 events), ~73-75% win rate'
        : 'ABCD pattern — structural heuristic (pattern geometry only), not backtested on this market' };
    }
    return { tier: 'B', sizeMultiplier: 0.5, reason: validated
      ? `${patternType || 'Exotic'} pattern — too few historical instances to fully trust yet`
      : `${patternType || 'Exotic'} pattern — structural heuristic, not backtested on this market` };
  }

  const isBearish = direction === 'BEARISH' || signal === 'SELL' || signal === 'STRONG SELL';
  const isBullish = direction === 'BULLISH' || signal === 'BUY' || signal === 'STRONG BUY';

  if (isBullish) {
    if (marketDirection === 'UP') {
      return { tier: 'A', sizeMultiplier: 0.8, reason: validated
        ? 'BUY-side, market currently UP-trending — BUY outperformed SELL in the last 2 comparable up-months'
        : 'BUY-side, market currently UP-trending — structural regime heuristic, not backtested on this market' };
    }
    return { tier: 'C', sizeMultiplier: 0.4, reason: validated
      ? 'BUY-side AWO signal, market not confirmed up-trending — historically ~36% win rate in flat/down regimes (refreshed 2026-07-28)'
      : 'BUY-side signal, market not confirmed up-trending — structural regime heuristic, not backtested on this market' };
  }
  if (isBearish) {
    if (marketDirection === 'UP') {
      return { tier: 'C', sizeMultiplier: 0.4, reason: validated
        ? 'SELL-side, market currently UP-trending — SELL underperformed sharply in the last comparable up-month (16.5%)'
        : 'SELL-side, market currently UP-trending — structural regime heuristic, not backtested on this market' };
    }
    return { tier: 'A', sizeMultiplier: 0.8, reason: validated
      ? 'SELL-side AWO signal — historically ~52% win rate, stronger still in down/flat regimes (refreshed 2026-07-28)'
      : 'SELL-side signal — structural regime heuristic, not backtested on this market' };
  }
  return { tier: 'B', sizeMultiplier: 0.5, reason: 'Insufficient context to classify' };
}

module.exports = { computeConvictionTier, detectMarketDirection };
