/**
 * Regime Gate — Shadow Mode Retroactive Analysis (P1 follow-up #13, 2026-07-30)
 *
 * `modules/regime_engine.js`'s `detectPriceRegime()` was deliberately built
 * as an informational badge only (2026-07-29), never a signal gate — the
 * explicit lesson from the Counter-trend hard gate that got adopted from one
 * backtest, ran live, then had to be retracted once a fixed-formula
 * re-backtest showed it didn't hold (see BACKTEST_EXPERIMENTS.md and
 * project memory). Its own doc comment says exactly what should happen
 * next: "surface it, watch it against real outcomes, only promote it to
 * something that filters/sizes signals once it's been validated."
 *
 * This script is that validation step, run retroactively against the same
 * historical window already used by EXP-001 through EXP-007: for every
 * historical AWO Full BUY/SELL signal, recompute what `detectPriceRegime`
 * would have said AS OF that signal's date (no lookahead — same candles
 * slice discipline as every other backtest here), derive the shadow gate's
 * verdict via `regimeGateVerdict()`, and compare REAL future-path trade
 * outcomes (T+1 entry, ATR/SR stop/target, fee+slippage — reusing
 * `evaluateCandidateOutcome` from awo_optimizer.js, the exact same function
 * the live optimizer uses) between the "gate would ALLOW" and "gate would
 * BLOCK" groups.
 *
 * If BLOCKED trades are meaningfully worse than ALLOWED trades, that's real
 * evidence the gate could help. If not, promoting it would repeat the
 * Counter-trend mistake. Either way, this is diagnostic only — no gate is
 * enabled by this script or by anything reading its output.
 *
 * Usage: node backtest_regime_gate_shadow.js
 */

'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const stats = require('./modules/statistics');
const { calcTechnicalFactors } = require('./awo_technical');
const { detectPriceRegime, regimeGateVerdict } = require('./modules/regime_engine');
const { evaluateCandidateOutcome } = require('./awo_optimizer');
const {
  f1_concentration, f2_trend, f3_volumeZ, f4_momentum, f5_relStrength,
  f6_breadth, f7_alignment, f8_streak,
  weightedComposite, computeConfidence, computeRiskModifier, combineFinalScore,
} = require('./modules/awo_factors');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const WINDOW_START = '2026-01-19';
const WINDOW_END = '2026-07-29';
const REGIME_MIN_CANDLES = 210; // matches REGIME_CONFIG.minCandles

const DEFAULT_WEIGHTS = {
  f1: 0.14, f2: 0.10, f3: 0.08, f4: 0.10,
  f5: 0.07, f6: 0.10, f7: 0.08, f8: 0.05,
  f9: 0.06, f10: 0.06, f11: 0.05, f12: 0.05,
  f13: 0.03, f14: 0.03,
};
const THRESHOLDS = { strongBuy: 78, buy: 63, watch: 53, neutral: 40, sell: 25 };
function classifySignal(score) {
  const t = THRESHOLDS;
  if (score >= t.strongBuy) return 'STRONG BUY';
  if (score >= t.buy) return 'BUY';
  if (score >= t.watch) return 'WATCH';
  if (score >= t.neutral) return 'NEUTRAL';
  if (score >= t.sell) return 'SELL';
  return 'STRONG SELL';
}

function metrics(trades) {
  if (!trades.length) return null;
  const netRs = trades.map(t => t.netR);
  const wins = netRs.filter(r => r > 0);
  const losses = netRs.filter(r => r <= 0);
  const winRate = wins.length / trades.length;
  const avgWin = wins.length ? stats.mean(wins) : 0;
  const avgLoss = losses.length ? Math.abs(stats.mean(losses)) : 0;
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;
  const grossProfit = wins.reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  return { n: trades.length, winRate: winRate * 100, expectancy, profitFactor };
}

async function main() {
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  const [tickerRows] = await pool.query(
    `SELECT stock_code, COUNT(*) n FROM idx_stock_prices GROUP BY stock_code HAVING n >= 260 ORDER BY stock_code`
  );
  const tickers = tickerRows.map(r => r.stock_code);
  console.log(`Tickers: ${tickers.length}, window: ${WINDOW_START} to ${WINDOW_END}\n`);

  const ohlcMap = new Map();
  for (const t of tickers) {
    const [rows] = await pool.query(
      `SELECT date, open_price o, high_price h, low_price l, close_price c, volume v FROM idx_stock_prices WHERE stock_code=? ORDER BY date ASC`, [t]
    );
    ohlcMap.set(t, rows.map(r => ({
      date: r.date.toISOString().split('T')[0], open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v),
    })));
  }

  const [concRows] = await pool.query(`SELECT data_date, stock_code, dn0, dn1, dn2, dn3, dn4 FROM idx_concentration`);
  const concMap = new Map();
  for (const r of concRows) concMap.set(`${r.stock_code}|${r.data_date.toISOString().split('T')[0]}`, r);

  const [brokerRows] = await pool.query(`SELECT date, stock_code, broker_code, buy_val - sell_val net_val FROM idx_broker_summary`);
  const breadthMap = new Map();
  for (const r of brokerRows) {
    const key = `${r.stock_code}|${r.date.toISOString().split('T')[0]}`;
    if (!breadthMap.has(key)) breadthMap.set(key, { buyers: 0, sellers: 0 });
    const e = breadthMap.get(key);
    if (Number(r.net_val) > 0) e.buyers++; else if (Number(r.net_val) < 0) e.sellers++;
  }

  const changeByDate = new Map();
  for (const t of tickers) {
    const c = ohlcMap.get(t);
    for (let i = 1; i < c.length; i++) {
      const chg = (c[i].close / c[i - 1].close - 1) * 100;
      if (!changeByDate.has(c[i].date)) changeByDate.set(c[i].date, []);
      changeByDate.get(c[i].date).push(chg);
    }
  }
  const marketAvgByDate = new Map();
  for (const [date, arr] of changeByDate) marketAvgByDate.set(date, stats.mean(arr));

  // Group trades by (regime, wouldBlock) so we can see the gate's effect
  // broken down by regime too, not just a single pooled ALLOW/BLOCK number.
  const byGate = { ALLOW: [], BLOCK: [] };
  const byRegimeGate = {}; // e.g. "TREND_DOWN|BLOCK" -> trades[]
  const allTrades = []; // ungated FULL baseline, for reference

  let regimeCounts = {};

  for (const ticker of tickers) {
    const candles = ohlcMap.get(ticker);
    if (candles.length < 260) continue;
    const startIdx = candles.findIndex(c => c.date >= WINDOW_START);
    let endIdx = candles.length - 1;
    for (let k = candles.length - 1; k >= 0; k--) { if (candles[k].date <= WINDOW_END) { endIdx = k; break; } }
    endIdx = Math.min(endIdx, candles.length - 16); // leave room for T+1 entry + up to 15-day hold
    if (startIdx < 0 || endIdx <= startIdx) continue;

    for (let i = startIdx; i <= endIdx; i++) {
      const date = candles[i].date;
      const closes = candles.slice(0, i + 1).map(c => c.close);
      const volumes = candles.slice(Math.max(0, i - 29), i + 1).map(c => c.volume);
      const dailyChange = (candles[i].close / candles[i - 1].close - 1) * 100;
      const priceDirection = dailyChange > 0 ? 1 : dailyChange < 0 ? -1 : 0;

      const conc = concMap.get(`${ticker}|${date}`);
      const dn0 = conc ? Number(conc.dn0 ?? 0) : null;
      const dnValues = conc ? [conc.dn4, conc.dn3, conc.dn2, conc.dn1, conc.dn0].map(v => v !== null && v !== undefined ? Number(v) : null) : [];
      const breadthKey = `${ticker}|${date}`;
      const breadth = breadthMap.get(breadthKey) || { buyers: 0, sellers: 0 };
      const brokerDataAvailable = !!conc;
      const breadthDataAvailable = breadthMap.has(breadthKey);
      const marketAvgChange = marketAvgByDate.get(date) || 0;

      const f1 = f1_concentration(dn0);
      const f2 = f2_trend(dnValues);
      const f3 = f3_volumeZ(volumes, priceDirection);
      const f4 = f4_momentum(closes);
      const f5 = f5_relStrength(dailyChange, marketAvgChange);
      const f6 = f6_breadth(breadth.buyers, breadth.sellers);
      const f7 = f7_alignment(dailyChange, dn0);
      const f8 = f8_streak(dnValues);

      const windowCandles = candles.slice(0, i + 1);
      const tech = calcTechnicalFactors(windowCandles.slice(-60));
      const { f9, f10, f11, f12, f13, f14 } = tech;

      const scores = { f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13 };
      const availability = { f1: brokerDataAvailable, f2: brokerDataAvailable, f6: breadthDataAvailable, f7: brokerDataAvailable, f8: brokerDataAvailable };
      const { composite: raw, factorCoverage } = weightedComposite(scores, DEFAULT_WEIGHTS, availability);
      const composite = combineFinalScore(raw, computeConfidence(factorCoverage), computeRiskModifier(f14));
      const signalType = classifySignal(composite);
      const isDirectional = ['STRONG BUY', 'BUY', 'SELL', 'STRONG SELL'].includes(signalType);
      if (!isDirectional) continue;

      // No-lookahead regime: only candles up to and including the signal day.
      let regime = null;
      if (windowCandles.length >= REGIME_MIN_CANDLES) {
        try { regime = detectPriceRegime(windowCandles.slice(-280)).regime; } catch { regime = null; }
      }
      regimeCounts[regime || 'INSUFFICIENT'] = (regimeCounts[regime || 'INSUFFICIENT'] || 0) + 1;

      const verdict = regimeGateVerdict(signalType, regime);
      const outcome = evaluateCandidateOutcome({ signalType, candles, signalIdx: i });
      if (!outcome || !outcome.result) continue;

      const trade = { netR: outcome.netR };
      allTrades.push(trade);
      byGate[verdict.wouldBlock ? 'BLOCK' : 'ALLOW'].push(trade);
      const key = `${regime || 'INSUFFICIENT'}|${verdict.wouldBlock ? 'BLOCK' : 'ALLOW'}`;
      if (!byRegimeGate[key]) byRegimeGate[key] = [];
      byRegimeGate[key].push(trade);
    }
  }

  console.log('='.repeat(80));
  console.log(`Regime distribution across all directional signals in window:`);
  console.log('='.repeat(80));
  for (const [regime, n] of Object.entries(regimeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${regime.padEnd(20)} ${n}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('FULL (ungated) baseline vs shadow-gate ALLOW vs shadow-gate BLOCK');
  console.log('='.repeat(80));
  const full = metrics(allTrades);
  const allow = metrics(byGate.ALLOW);
  const block = metrics(byGate.BLOCK);
  const fmt = (label, m) => m
    ? `${label.padEnd(22)} n=${String(m.n).padEnd(6)} winRate=${m.winRate.toFixed(1)}%  expectancy=${m.expectancy.toFixed(3)}R  profitFactor=${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : 'inf'}`
    : `${label.padEnd(22)} n=0`;
  console.log(fmt('FULL (ungated)', full));
  console.log(fmt('Shadow gate: ALLOW', allow));
  console.log(fmt('Shadow gate: BLOCK', block));
  if (allow && block) {
    const delta = block.expectancy - allow.expectancy;
    console.log(`\nΔexpectancy (BLOCK - ALLOW) = ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}R`);
    console.log(delta < 0
      ? '  BLOCK trades are WORSE than ALLOW trades — consistent with the gate adding value (if this holds up under further testing).'
      : '  BLOCK trades are NOT worse than ALLOW trades — gating on this rule would not have helped, or would have hurt.');
  }

  console.log('\n' + '='.repeat(80));
  console.log('Breakdown by regime × shadow-gate verdict');
  console.log('='.repeat(80));
  for (const [key, trades] of Object.entries(byRegimeGate).sort()) {
    console.log(fmt(key, metrics(trades)));
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
