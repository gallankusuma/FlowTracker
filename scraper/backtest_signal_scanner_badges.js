/**
 * Backtest: replay the ACTUAL Signal Scanner scoring pipeline (/api/signal-scanner
 * in server.js) at many historical points over the last ~3 months, and record
 * win rate broken down by the context badges shown in the UI (Counter-trend,
 * Foreign Leading / Domestic FOMO, Volume spike) — the exact ask: "record win
 * rate + pattern probability for the badge combinations."
 *
 * Faithfulness: f1-f8 and classifySignal/DEFAULT_WEIGHTS below are copied
 * verbatim from server.js (not reimplemented from memory) since server.js
 * isn't a requirable module. f9-f14/weeklyTrend are required directly from
 * awo_technical.js (a real module, so no copy-risk there). Current AWO weights
 * are confirmed DEFAULT (isOptimized:false via /api/awo/status) and have been
 * since the rejected 2026-07-19 optimization attempt, so replaying with
 * DEFAULT_WEIGHTS across the whole window is methodologically consistent with
 * what actually ran in production this whole period — no weight-drift confound.
 *
 * Usage: node backtest_signal_scanner_badges.js
 */

'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const stats = require('./modules/statistics');
const { calcTechnicalFactors, computeWeeklyTrend } = require('./awo_technical');
const { detectPriceRegime } = require('./modules/regime_engine');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

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
// F1-F8 now imported from modules/awo_factors.js (fixed 2026-07-28 — see that
// file's header) instead of a hand-copied local version. IMPORTANT: this
// backtest's PAST output (the win-rate numbers hardcoded into
// modules/conviction.js's Conviction Tier reason text — "~43-44%",
// "~54-56%", "~34-38%", "73%→87%") was produced using the OLD, buggy
// versions of these formulas (F7's sign bug, F6's 50:50 boundary bug, F4's
// sign bug, dn0's mis-scaled sigmoid/caps all included). Re-running this
// script now with the fixed formulas may produce different win rates —
// those Conviction Tier numbers should be treated as provisional until
// re-validated against a fresh run.
const {
  f1_concentration, f2_trend, f3_volumeZ, f4_momentum,
  f5_relStrength, f6_breadth, f7_alignment, f8_streak,
  weightedComposite, computeConfidence, computeRiskModifier, combineFinalScore,
} = require('./modules/awo_factors');
function computeForeignDivergence(foreignBuy, foreignSell, domesticBuy, domesticSell) {
  const foreignTotal = (foreignBuy || 0) + (foreignSell || 0);
  const domesticTotal = (domesticBuy || 0) + (domesticSell || 0);
  if (foreignTotal <= 0 || domesticTotal <= 0) return null;
  const foreignRatio = (foreignBuy - foreignSell) / foreignTotal;
  const domesticRatio = (domesticBuy - domesticSell) / domesticTotal;
  const divergence = foreignRatio - domesticRatio;
  let label = 'ALIGNED';
  if (divergence > 0.15) label = 'FOREIGN_LEADING';
  else if (divergence < -0.15) label = 'DOMESTIC_FOMO';
  return { foreignRatio, domesticRatio, label };
}

const LOOKBACK_DAYS = 160; // ~7.5 trading months — now that idx_broker_flow_detail covers 2025-12-01 onward
const MAX_HOLD = 10;

async function main() {
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  const [tickerRows] = await pool.query(
    `SELECT stock_code, COUNT(*) n FROM idx_stock_prices GROUP BY stock_code HAVING n >= 250 ORDER BY stock_code`
  );
  const tickers = tickerRows.map(r => r.stock_code);
  console.log(`Tickers: ${tickers.length}`);

  // ─── OHLC per ticker ─────────────────────────────────────────────────────
  const ohlcMap = new Map();
  for (const t of tickers) {
    const [rows] = await pool.query(
      `SELECT date, open_price o, high_price h, low_price l, close_price c, volume v FROM idx_stock_prices WHERE stock_code=? ORDER BY date ASC`, [t]
    );
    ohlcMap.set(t, rows.map(r => ({
      date: r.date.toISOString().split('T')[0], open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v),
    })));
  }
  console.log('OHLC loaded');

  // ─── Concentration (dn0-dn4) ────────────────────────────────────────────
  const [concRows] = await pool.query(`SELECT data_date, stock_code, dn0, dn1, dn2, dn3, dn4 FROM idx_concentration`);
  const concMap = new Map(); // "stock|date" -> row
  for (const r of concRows) concMap.set(`${r.stock_code}|${r.data_date.toISOString().split('T')[0]}`, r);
  console.log(`Concentration rows: ${concRows.length}`);

  // ─── Broker summary: breadth (buyers/sellers count) per (date,stock) ───
  const [brokerRows] = await pool.query(`SELECT date, stock_code, broker_code, buy_val - sell_val net_val FROM idx_broker_summary`);
  const breadthMap = new Map(); // "stock|date" -> {buyers, sellers}
  for (const r of brokerRows) {
    const key = `${r.stock_code}|${r.date.toISOString().split('T')[0]}`;
    if (!breadthMap.has(key)) breadthMap.set(key, { buyers: 0, sellers: 0 });
    const e = breadthMap.get(key);
    if (Number(r.net_val) > 0) e.buyers++; else if (Number(r.net_val) < 0) e.sellers++;
  }
  console.log(`Broker summary rows: ${brokerRows.length}`);

  // ─── Foreign/domestic flow (for foreignDivergence) ──────────────────────
  const [flowRows] = await pool.query(
    `SELECT date, stock_code, investor_type, SUM(buy_val) buy, SUM(sell_val) sell FROM idx_broker_flow_detail GROUP BY date, stock_code, investor_type`
  );
  const flowMap = new Map(); // "stock|date" -> {foreign:{buy,sell}, domestic:{buy,sell}}
  for (const r of flowRows) {
    const key = `${r.stock_code}|${r.date.toISOString().split('T')[0]}`;
    if (!flowMap.has(key)) flowMap.set(key, {});
    flowMap.get(key)[r.investor_type] = { buy: Number(r.buy), sell: Number(r.sell) };
  }
  console.log(`Flow detail rows: ${flowRows.length}\n`);

  // ─── Cross-sectional market average daily change per date ──────────────
  const changeByDate = new Map(); // date -> [changes]
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

  // ─── Main loop ───────────────────────────────────────────────────────────
  const events = [];
  for (const ticker of tickers) {
    const candles = ohlcMap.get(ticker);
    if (candles.length < 260) continue; // need lookback for weekly trend + forward horizon

    const startIdx = candles.length - LOOKBACK_DAYS - MAX_HOLD;
    const endIdx = candles.length - MAX_HOLD;
    for (let i = Math.max(200, startIdx); i < endIdx; i++) {
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
      let f9 = 50, f10 = 50, f11 = 50, f12 = 50, f13 = 50, f14 = 50;
      try {
        const tech = calcTechnicalFactors(windowCandles.slice(-60));
        f9 = tech.f9; f10 = tech.f10; f11 = tech.f11; f12 = tech.f12; f13 = tech.f13; f14 = tech.f14;
      } catch {}
      let weeklyTrend = null;
      try { weeklyTrend = computeWeeklyTrend(windowCandles); } catch {}
      // No-lookahead: uses windowCandles (data up to index i only), NOT the
      // full `candles` array which contains future bars — same discipline as
      // weeklyTrend/tech above. This is what makes it valid to ask "did
      // priceRegime correlate with real outcomes" using already-stored history
      // instead of waiting for new signals to accumulate in production.
      let priceRegime = null;
      try { priceRegime = detectPriceRegime(windowCandles.slice(-280)); } catch {}

      // F1-F13 combine via weightedComposite (excludes factors lacking real
      // broker/breadth data from both numerator and weight sum). Final score
      // = Directional × Confidence × RiskModifier per AWO Engine.md §3.4,
      // matching the same shape used in server.js/regenerate_signal_history.js.
      const { composite: rawComposite13, factorCoverage } = weightedComposite(
        { f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13 },
        { f1: DEFAULT_WEIGHTS.f1, f2: DEFAULT_WEIGHTS.f2, f3: DEFAULT_WEIGHTS.f3, f4: DEFAULT_WEIGHTS.f4,
          f5: DEFAULT_WEIGHTS.f5, f6: DEFAULT_WEIGHTS.f6, f7: DEFAULT_WEIGHTS.f7, f8: DEFAULT_WEIGHTS.f8,
          f9: DEFAULT_WEIGHTS.f9, f10: DEFAULT_WEIGHTS.f10, f11: DEFAULT_WEIGHTS.f11, f12: DEFAULT_WEIGHTS.f12, f13: DEFAULT_WEIGHTS.f13 },
        { f1: brokerDataAvailable, f2: brokerDataAvailable, f6: breadthDataAvailable, f7: brokerDataAvailable, f8: brokerDataAvailable }
      );
      const composite = combineFinalScore(rawComposite13, computeConfidence(factorCoverage), computeRiskModifier(f14));
      const signal = classifySignal(composite);
      const isBullish = signal === 'STRONG BUY' || signal === 'BUY';
      const isBearish = signal === 'SELL' || signal === 'STRONG SELL';
      if (!isBullish && !isBearish) continue; // skip WATCH/NEUTRAL — not actionable

      let trendAligned = null;
      if (weeklyTrend && weeklyTrend.trend !== 'NEUTRAL') {
        trendAligned = isBullish ? weeklyTrend.trend === 'BULLISH' : weeklyTrend.trend === 'BEARISH';
      }

      const flow = flowMap.get(`${ticker}|${date}`) || {};
      const fd = (flow.foreign && flow.domestic)
        ? computeForeignDivergence(flow.foreign.buy, flow.foreign.sell, flow.domestic.buy, flow.domestic.sell)
        : null;

      const rawVolumeZ = volumes.length >= 5 ? stats.zScoreFromArray(volumes) : 0;
      const volumeSpike = rawVolumeZ > 2;

      for (const h of [5, 10]) {
        const future = candles[i + h];
        if (!future) continue;
        const ret = (future.close / candles[i].close - 1) * 100;
        const win = isBullish ? ret > 0 : ret < 0;
        events.push({
          ticker, date, signal, horizon: h, win, isBullish,
          trendAligned, foreignLabel: fd?.label ?? null, volumeSpike,
          priceRegime: priceRegime?.regime ?? null,
        });
      }
    }
  }

  console.log(`Total signal-horizon events: ${events.length}\n`);

  function wr(arr) {
    if (!arr.length) return { n: 0, wr: 0 };
    return { n: arr.length, wr: arr.filter(e => e.win).length / arr.length * 100 };
  }

  for (const h of [5, 10]) {
    const decided = events.filter(e => e.horizon === h);
    console.log('='.repeat(80));
    console.log(`HORIZON +${h}d — n=${decided.length}`);
    console.log('='.repeat(80));

    console.log(`Overall: ${JSON.stringify(wr(decided))}`);
    console.log(`BUY-like: ${JSON.stringify(wr(decided.filter(e => e.signal==='BUY'||e.signal==='STRONG BUY')))}`);
    console.log(`SELL-like: ${JSON.stringify(wr(decided.filter(e => e.signal==='SELL'||e.signal==='STRONG SELL')))}\n`);

    console.log('-- Trend alignment --');
    console.log(`Aligned (trendAligned=true): ${JSON.stringify(wr(decided.filter(e => e.trendAligned===true)))}`);
    console.log(`Counter-trend (trendAligned=false): ${JSON.stringify(wr(decided.filter(e => e.trendAligned===false)))}`);
    console.log(`No weekly trend data: ${JSON.stringify(wr(decided.filter(e => e.trendAligned===null)))}\n`);

    console.log('-- Price-Action Regime (priceRegime, informational badge — checking if it SHOULD ever be more) --');
    for (const dirLabel of ['BUY-like', 'SELL-like']) {
      const dirArr = decided.filter(e => dirLabel === 'BUY-like' ? e.isBullish : !e.isBullish);
      console.log(`  [${dirLabel}] n=${dirArr.length}`);
      for (const regimeLabel of ['TREND_UP', 'TREND_DOWN', 'RANGE', 'HIGH_VOLATILITY', 'UNKNOWN']) {
        const r = wr(dirArr.filter(e => e.priceRegime === regimeLabel));
        console.log(`    ${regimeLabel}: n=${r.n} wr=${r.wr.toFixed(1)}%`);
      }
    }
    console.log('');

    console.log('-- priceRegime SPLIT-HALF VALIDATION (does any pattern replicate?) --');
    {
      const allDatesR = [...new Set(decided.map(e => e.date))].sort();
      const midDateR = allDatesR[Math.floor(allDatesR.length / 2)];
      for (const [halfLabel, halfArr] of [['HALF 1 (earlier)', decided.filter(e => e.date < midDateR)], ['HALF 2 (later)', decided.filter(e => e.date >= midDateR)]]) {
        console.log(`  [${halfLabel}]`);
        for (const dirLabel of ['BUY-like', 'SELL-like']) {
          const dirArr = halfArr.filter(e => dirLabel === 'BUY-like' ? e.isBullish : !e.isBullish);
          const tu = wr(dirArr.filter(e => e.priceRegime === 'TREND_UP'));
          const td = wr(dirArr.filter(e => e.priceRegime === 'TREND_DOWN'));
          const rg = wr(dirArr.filter(e => e.priceRegime === 'RANGE'));
          const hv = wr(dirArr.filter(e => e.priceRegime === 'HIGH_VOLATILITY'));
          console.log(`    ${dirLabel}: TREND_UP n=${tu.n} wr=${tu.wr.toFixed(1)}% | TREND_DOWN n=${td.n} wr=${td.wr.toFixed(1)}% | RANGE n=${rg.n} wr=${rg.wr.toFixed(1)}% | HIGH_VOL n=${hv.n} wr=${hv.wr.toFixed(1)}%`);
        }
      }
    }
    console.log('');

    console.log('-- Foreign divergence (POOLED, confounded by direction mix) --');
    console.log(`Foreign Leading: ${JSON.stringify(wr(decided.filter(e => e.foreignLabel==='FOREIGN_LEADING')))}`);
    console.log(`Domestic FOMO: ${JSON.stringify(wr(decided.filter(e => e.foreignLabel==='DOMESTIC_FOMO')))}`);
    console.log(`Aligned/neutral: ${JSON.stringify(wr(decided.filter(e => e.foreignLabel==='ALIGNED')))}`);
    console.log(`No flow data: ${JSON.stringify(wr(decided.filter(e => e.foreignLabel===null)))}\n`);

    console.log('-- Foreign divergence, SEPARATED BY DIRECTION (deconfounded) --');
    for (const dirLabel of ['BUY-like', 'SELL-like']) {
      const dirArr = decided.filter(e => dirLabel === 'BUY-like' ? e.isBullish : !e.isBullish);
      console.log(`  [${dirLabel}] n=${dirArr.length}`);
      console.log(`    Foreign Leading: ${JSON.stringify(wr(dirArr.filter(e => e.foreignLabel==='FOREIGN_LEADING')))}`);
      console.log(`    Domestic FOMO:   ${JSON.stringify(wr(dirArr.filter(e => e.foreignLabel==='DOMESTIC_FOMO')))}`);
      console.log(`    Aligned/neutral: ${JSON.stringify(wr(dirArr.filter(e => e.foreignLabel==='ALIGNED')))}`);
      console.log(`    No flow data:    ${JSON.stringify(wr(dirArr.filter(e => e.foreignLabel===null)))}`);
    }
    console.log('');

    console.log('-- Sanity check: does foreignLabel correlate with direction? (the suspected confound) --');
    const flCount = decided.filter(e => e.foreignLabel==='FOREIGN_LEADING');
    const dfCount = decided.filter(e => e.foreignLabel==='DOMESTIC_FOMO');
    console.log(`  Foreign Leading events: ${flCount.filter(e=>e.isBullish).length} BUY-like / ${flCount.filter(e=>!e.isBullish).length} SELL-like`);
    console.log(`  Domestic FOMO events:   ${dfCount.filter(e=>e.isBullish).length} BUY-like / ${dfCount.filter(e=>!e.isBullish).length} SELL-like`);
    console.log('');

    console.log('-- SPLIT-HALF VALIDATION: does "Foreign Leading underperforms" replicate across regimes? --');
    const allDates = [...new Set(decided.map(e => e.date))].sort();
    const midDate = allDates[Math.floor(allDates.length / 2)];
    console.log(`  Date range: ${allDates[0]} to ${allDates[allDates.length-1]}, split: ${midDate}`);
    for (const [halfLabel, halfArr] of [['HALF 1 (earlier)', decided.filter(e => e.date < midDate)], ['HALF 2 (later)', decided.filter(e => e.date >= midDate)]]) {
      console.log(`  [${halfLabel}]`);
      for (const dirLabel of ['BUY-like', 'SELL-like']) {
        const dirArr = halfArr.filter(e => dirLabel === 'BUY-like' ? e.isBullish : !e.isBullish);
        const fl = wr(dirArr.filter(e => e.foreignLabel === 'FOREIGN_LEADING'));
        const df = wr(dirArr.filter(e => e.foreignLabel === 'DOMESTIC_FOMO'));
        console.log(`    ${dirLabel}: Foreign Leading n=${fl.n} wr=${fl.wr.toFixed(1)}% | Domestic FOMO n=${df.n} wr=${df.wr.toFixed(1)}%`);
      }
    }
    console.log('');

    console.log('-- BUY/SELL win rate BY MONTH (regime hypothesis check) --');
    const marketChangesByMonth = new Map();
    for (const [d, chgs] of changeByDate) {
      const ym = d.slice(0, 7);
      if (!marketChangesByMonth.has(ym)) marketChangesByMonth.set(ym, []);
      marketChangesByMonth.get(ym).push(...chgs);
    }
    const byMonth = new Map();
    for (const e of decided) {
      const ym = e.date.slice(0, 7);
      if (!byMonth.has(ym)) byMonth.set(ym, { buy: [], sell: [] });
      const m = byMonth.get(ym);
      if (e.isBullish) m.buy.push(e); else m.sell.push(e);
    }
    for (const ym of [...byMonth.keys()].sort()) {
      const m = byMonth.get(ym);
      const marketAvgChg = stats.mean(marketChangesByMonth.get(ym) || [0]);
      console.log(`  ${ym}: marketAvgDailyChg=${marketAvgChg>=0?'+':''}${marketAvgChg.toFixed(2)}% | BUY n=${m.buy.length} wr=${wr(m.buy).wr.toFixed(1)}% | SELL n=${m.sell.length} wr=${wr(m.sell).wr.toFixed(1)}%`);
    }
    console.log('');

    console.log('-- Volume spike --');
    console.log(`Spike (z>2): ${JSON.stringify(wr(decided.filter(e => e.volumeSpike)))}`);
    console.log(`No spike: ${JSON.stringify(wr(decided.filter(e => !e.volumeSpike)))}\n`);

    console.log('-- Combinations (n>=15 only) --');
    const combos = new Map();
    for (const e of decided) {
      const key = `trend=${e.trendAligned===true?'ALIGNED':e.trendAligned===false?'COUNTER':'N/A'} | foreign=${e.foreignLabel||'N/A'} | vol=${e.volumeSpike?'SPIKE':'normal'}`;
      if (!combos.has(key)) combos.set(key, []);
      combos.get(key).push(e);
    }
    const sorted = [...combos.entries()].filter(([,arr]) => arr.length >= 15).sort((a,b) => wr(b[1]).wr - wr(a[1]).wr);
    for (const [key, arr] of sorted) {
      console.log(`${key} => n=${arr.length}, winRate=${wr(arr).wr.toFixed(1)}%`);
    }
    console.log('');
  }

  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
