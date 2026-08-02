/**
 * Per-Factor Ablation — Advance.md §5, the natural follow-up to EXP-001-004.
 *
 * EXP-001/002/004 established that removing ALL broker factors (F1/F2/F6/
 * F7/F8) as one block beats keeping them (Technical-Only > Full, 4-for-4
 * across periods/exit-rules). That tells us the broker-factor FAMILY hurts,
 * but not WHICH factor(s) specifically — this test isolates each one.
 *
 * For each of F1-F13, generates its OWN signals from a composite computed
 * WITHOUT that one factor (all others normal), then simulates trades exactly
 * like EXP-001/004 (ATR/SR exit via computeTradePlan, T+1 entry, 15-day max
 * hold, same fee/slippage assumption). Also tests a 14th variant — Risk
 * Modifier disabled (F14 forced to a no-op 1.0x) — since F14 isn't a summed
 * factor anymore, "ablating" it means asking whether the confidence/risk
 * multiplier layer itself is helping or hurting.
 *
 * Window: the full concentration-covered span (2026-01-19 to 2026-07-29) —
 * maximizes sample size for this diagnostic pass. EXP-004 already
 * established the FULL-vs-baseline finding replicates across two halves of
 * this same window; this pass is about identifying WHICH factor, not
 * re-proving replication.
 *
 * Usage: node backtest_factor_ablation.js
 */

'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const stats = require('./modules/statistics');
const { calcTechnicalFactors, computeTradePlan } = require('./awo_technical');
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

const FEE_BUY_PCT = 0.15, FEE_SELL_PCT = 0.25, SLIPPAGE_PCT = 0.10;
const ROUND_TRIP_COST_PCT = FEE_BUY_PCT + FEE_SELL_PCT + SLIPPAGE_PCT;
const MAX_HOLD = 15;
const WINDOW_START = '2026-01-19';
const WINDOW_END = '2026-07-29';

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

const FACTOR_KEYS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12', 'f13'];
const VARIANTS = ['FULL', ...FACTOR_KEYS.map(f => 'NO_' + f.toUpperCase()), 'NO_RISK_MODIFIER'];

function simulateLongTrade(candles, entryIdx, atr, sr) {
  if (entryIdx >= candles.length) return null;
  const entryPrice = candles[entryIdx].open;
  const plan = computeTradePlan(entryPrice, 'BUY', atr, sr);
  if (!plan || !Number.isFinite(plan.stopLoss) || plan.stopLoss >= entryPrice) return null;
  const risk = entryPrice - plan.stopLoss;
  if (risk <= 0) return null;

  let exitPrice = null, exitReason = 'TIME_EXIT', holdDays = 0;
  const lastIdx = Math.min(entryIdx + MAX_HOLD - 1, candles.length - 1);
  for (let j = entryIdx; j <= lastIdx; j++) {
    const bar = candles[j];
    holdDays = j - entryIdx + 1;
    if (bar.low <= plan.stopLoss) { exitPrice = plan.stopLoss; exitReason = 'STOP'; break; }
    if (bar.high >= plan.target2) { exitPrice = plan.target2; exitReason = 'TARGET'; break; }
    if (j === lastIdx) { exitPrice = bar.close; exitReason = 'TIME_EXIT'; }
  }
  if (exitPrice === null) return null;

  const netR = ((exitPrice * (1 - ROUND_TRIP_COST_PCT / 100)) - (entryPrice * (1 + FEE_BUY_PCT / 100))) / risk;
  return { netR };
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

  const tradesByVariant = {};
  for (const v of VARIANTS) tradesByVariant[v] = [];

  for (const ticker of tickers) {
    const candles = ohlcMap.get(ticker);
    if (candles.length < 260) continue;
    const startIdx = candles.findIndex(c => c.date >= WINDOW_START);
    let endIdx = candles.length - 1;
    for (let k = candles.length - 1; k >= 0; k--) { if (candles[k].date <= WINDOW_END) { endIdx = k; break; } }
    endIdx = Math.min(endIdx, candles.length - MAX_HOLD - 1);
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
      const { f9, f10, f11, f12, f13, f14, indicators } = tech;
      const atr = indicators?.atr ?? null;
      const sr = indicators?.sr ?? null;

      const scores = { f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13 };
      const baseAvailability = { f1: brokerDataAvailable, f2: brokerDataAvailable, f6: breadthDataAvailable, f7: brokerDataAvailable, f8: brokerDataAvailable };

      for (const variant of VARIANTS) {
        const availability = { ...baseAvailability };
        let riskModifier = computeRiskModifier(f14);
        if (variant.startsWith('NO_') && variant !== 'NO_RISK_MODIFIER') {
          availability[variant.replace('NO_', '').toLowerCase()] = false;
        } else if (variant === 'NO_RISK_MODIFIER') {
          riskModifier = 1; // no-op: confidence still applies, but volatility no longer discounts the score
        }
        const { composite: raw, factorCoverage } = weightedComposite(scores, DEFAULT_WEIGHTS, availability);
        const composite = combineFinalScore(raw, computeConfidence(factorCoverage), riskModifier);
        if (classifySignal(composite) === 'BUY' || classifySignal(composite) === 'STRONG BUY') {
          const t = simulateLongTrade(candles, i + 1, atr, sr);
          if (t) tradesByVariant[variant].push(t);
        }
      }
    }
  }

  console.log('='.repeat(80));
  console.log(`FULL vs each single-factor-removed variant (${WINDOW_START} to ${WINDOW_END})`);
  console.log('='.repeat(80));
  const fullMetrics = metrics(tradesByVariant.FULL);
  console.log(`FULL (baseline)`.padEnd(20) + `n=${String(fullMetrics?.n ?? 0).padEnd(6)} winRate=${fullMetrics?.winRate.toFixed(1)}%  expectancy=${fullMetrics?.expectancy.toFixed(3)}R  profitFactor=${Number.isFinite(fullMetrics?.profitFactor) ? fullMetrics.profitFactor.toFixed(2) : 'inf'}\n`);

  const rows = [];
  for (const variant of VARIANTS) {
    if (variant === 'FULL') continue;
    const m = metrics(tradesByVariant[variant]);
    const delta = m && fullMetrics ? m.expectancy - fullMetrics.expectancy : null;
    rows.push({ variant, m, delta });
  }
  rows.sort((a, b) => (b.delta ?? -999) - (a.delta ?? -999));
  for (const { variant, m, delta } of rows) {
    if (!m) { console.log(`${variant.padEnd(20)} n=0`); continue; }
    const deltaStr = delta !== null ? `Δexpectancy=${delta >= 0 ? '+' : ''}${delta.toFixed(3)}R` : '';
    console.log(`${variant.padEnd(20)} n=${String(m.n).padEnd(6)} winRate=${m.winRate.toFixed(1)}%  expectancy=${m.expectancy.toFixed(3)}R  profitFactor=${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : 'inf'}  ${deltaStr}`);
  }

  console.log('\nReading this: a LARGE POSITIVE Δexpectancy means removing that factor made things much better than FULL —');
  console.log('i.e. that factor is actively dragging the composite down. A negative Δ means that factor was helping.');

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
