/**
 * What is this strategy actually harvesting?
 *
 * "Follow the smart money or be retail" is not the axis that matters. The axis
 * is whether there is a specific, describable inefficiency being captured, and
 * which component captures it. This strategy has three, and they are separable:
 *
 *   SELECTION  rank by HI52W (proximity to the 252-day high) and hold the top N
 *   VETO       exclude names showing persistent visible broker accumulation
 *              (EXP-016: that accumulation predicts UNDERperformance)
 *   TIMING     hold nothing at all while IHSG sits below its own 200-day SMA
 *
 * Each is switched off in turn, everything else held fixed, on the same dates
 * and the same universe. Whatever survives is what is actually being harvested;
 * whatever does not is a story.
 *
 * The timing layer is disabled by passing an all-null SMA series, which makes
 * `belowSma` false at every bar (strategy_book.js) without touching the module.
 *
 * SURVIVORSHIP-BIASED RESEARCH RESULT, in-sample, on an unproven candidate.
 * Read the ORDERING of the components, not the levels.
 *
 * Usage: node measure_edge_decomposition.js
 */
'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const sb = require('./modules/strategy_book');
const exec = require('./modules/execution');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const REBAL_BARS = 10, BUY_COST = 0.20 / 100, SELL_COST = 0.30 / 100, TRADING_DAYS_YEAR = 245;
const BASE = { positions: 8, bufferMult: 2, vetoFrac: 0.20, exitOnVeto: true };

const toDateStr = d => d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d).split('T')[0];

async function load(pool) {
  const [ihsgRows] = await pool.query('SELECT date, close_price FROM idx_ihsg_history ORDER BY date ASC');
  const tradingDates = ihsgRows.map(r => toDateStr(r.date));
  const ihsgClose = ihsgRows.map(r => Number(r.close_price));
  const dateIdx = new Map(tradingDates.map((d, i) => [d, i]));
  const n = tradingDates.length;
  const [priceRows] = await pool.query(
    `SELECT stock_code, date, open_price, high_price, close_price, volume, value
       FROM idx_stock_prices WHERE close_price > 0 ORDER BY stock_code, date ASC`);
  const series = new Map();
  for (const r of priceRows) {
    const i = dateIdx.get(toDateStr(r.date));
    if (i === undefined) continue;
    if (!series.has(r.stock_code)) series.set(r.stock_code, {
      open: new Array(n).fill(null), high: new Array(n).fill(null),
      close: new Array(n).fill(null), value: new Array(n).fill(null), dn0: new Array(n).fill(null),
    });
    const s = series.get(r.stock_code);
    const c = Number(r.close_price);
    s.open[i] = Number(r.open_price) || c; s.high[i] = Number(r.high_price) || c;
    s.close[i] = c; s.value[i] = Number(r.value) || c * Number(r.volume || 0);
  }
  const [concRows] = await pool.query('SELECT stock_code, data_date, dn0 FROM idx_concentration');
  let concStart = Infinity;
  for (const r of concRows) {
    const i = dateIdx.get(toDateStr(r.data_date));
    if (i === undefined) continue;
    const s = series.get(r.stock_code);
    if (!s) continue;
    const v = sb.clipDn(r.dn0, sb.DEFAULTS.dnBound);
    if (v === null) continue;
    s.dn0[i] = v;
    if (i < concStart) concStart = i;
  }
  return { tradingDates, ihsgClose, ihsgSma: sb.smaSeries(ihsgClose, sb.DEFAULTS.regimeSma), series, concStart };
}

function replay(ctx, firstI, lastI, opts, useTiming) {
  const { series, ihsgClose } = ctx;
  // All-null SMA => belowSma is false at every bar => always invested.
  const sma = useTiming ? ctx.ihsgSma : new Array(ctx.ihsgSma.length).fill(null);
  let cash = 1.0;
  const held = new Map();
  const eq = [];
  let investedPeriods = 0, periods = 0;

  for (let i = firstI; i <= lastI; i += REBAL_BARS) {
    const execI = i + 1;
    if (execI > lastI + 1) break;
    const d = sb.targetBook({ series, i, ihsgClose, ihsgSma: sma, currentHoldings: [...held.keys()], opts });
    periods++;
    if (d.target.length) investedPeriods++;

    const pv = cash + exec.markToMarket(held, series, execI).value;
    const tset = new Set(d.target);
    for (const [t, u] of [...held]) {
      if (tset.has(t)) continue;
      const px = exec.sellFill(series.get(t), execI);
      if (px === null) continue;                       // sell NO_FILL: keep holding
      cash += u * px * (1 - SELL_COST); held.delete(t);
    }
    for (const t of d.target.filter(x => !held.has(x))) {
      const px = exec.buyFill(series.get(t), execI);
      if (px === null) continue;
      const spend = Math.min(pv / Math.max(d.target.length, 1), cash);
      if (spend <= 0) continue;
      cash -= spend;
      held.set(t, (spend * (1 - BUY_COST)) / px);
    }
    eq.push(cash + exec.markToMarket(held, series, execI).value);
  }

  let final = cash;
  for (const [t, u] of held) {
    const px = exec.markPrice(series.get(t), lastI);
    if (px !== null) final += u * px * (1 - SELL_COST);
  }
  let peak = -Infinity, mdd = 0;
  for (const v of eq.concat([final])) { if (v > peak) peak = v; if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak); }
  const years = (lastI - firstI) / TRADING_DAYS_YEAR;
  return { cagr: Math.pow(final, 1 / years) - 1, mdd, investedPct: investedPeriods / Math.max(periods, 1) };
}

(async () => {
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });
  const ctx = await load(pool);
  const firstI = Math.max(ctx.concStart + sb.DEFAULTS.posfracWindow, sb.DEFAULTS.hiBars, sb.DEFAULTS.regimeSma);
  const lastI = ctx.tradingDates.length - 2;

  // Does the veto's edge live in the thin, easily-pushed names, or does it
  // survive among the most liquid? If an edge exists only where a single holder
  // can move price, it is a manipulation artefact and can be switched off by
  // whoever is creating it. If it survives at high liquidity, that explanation
  // gets much weaker.
  if (process.argv.includes('--liquidity-sweep')) {
    console.log('VETO EDGE vs LIQUIDITY FLOOR — is the edge only in the thin names?');
    console.log('');
    console.log('  minAdv      universe   rank+timing   +veto      veto adds');
    for (const minAdv of [5e9, 10e9, 20e9, 50e9, 100e9]) {
      const withVeto = replay(ctx, firstI, lastI, { ...BASE, minAdv, vetoFrac: 0.20, exitOnVeto: true }, true);
      const noVeto   = replay(ctx, firstI, lastI, { ...BASE, minAdv, vetoFrac: 0, exitOnVeto: false }, true);
      const xs = sb.crossSection(ctx.series, lastI, { ...BASE, minAdv });
      console.log(`  Rp ${String(minAdv / 1e9).padStart(3)}bn   ${String(xs.length).padStart(6)}    ${(noVeto.cagr * 100).toFixed(2).padStart(8)}%  ${(withVeto.cagr * 100).toFixed(2).padStart(8)}%  ${((withVeto.cagr - noVeto.cagr) * 100).toFixed(2).padStart(8)} pp`);
    }
    console.log('');
    console.log('Universe is the eligible count at the final bar. A shrinking "veto adds"');
    console.log('column as the floor rises would mean the edge lives in the thin end.');
    await pool.end();
    return;
  }

  const CONFIGS = [
    { label: 'ALL THREE  rank + veto + timing', veto: true,  timing: true  },
    { label: 'no TIMING  rank + veto',          veto: true,  timing: false },
    { label: 'no VETO    rank + timing',        veto: false, timing: true  },
    { label: 'NEITHER    rank only',            veto: false, timing: false },
  ];

  console.log('='.repeat(86));
  console.log('WHAT IS ACTUALLY BEING HARVESTED — each component switched off in turn');
  console.log('='.repeat(86));
  console.log(`${ctx.tradingDates[firstI]} .. ${ctx.tradingDates[lastI]}   *** SURVIVORSHIP-BIASED, IN-SAMPLE ***\n`);
  const ihsgCagr = Math.pow(ctx.ihsgClose[lastI] / ctx.ihsgClose[firstI], TRADING_DAYS_YEAR / (lastI - firstI)) - 1;
  console.log(`IHSG buy-and-hold over the same window: ${(ihsgCagr * 100).toFixed(2)}%\n`);

  console.log('configuration                        CAGR     maxDD    invested');
  const out = {};
  for (const c of CONFIGS) {
    const r = replay(ctx, firstI, lastI,
      { ...BASE, vetoFrac: c.veto ? 0.20 : 0, exitOnVeto: c.veto }, c.timing);
    out[c.label.slice(0, 10).trim()] = r;
    console.log(`${c.label.padEnd(34)} ${(r.cagr * 100).toFixed(2).padStart(7)}%  ${(r.mdd * 100).toFixed(2).padStart(6)}%  ${(r.investedPct * 100).toFixed(0).padStart(7)}%`);
  }

  const all = out['ALL THREE'], noT = out['no TIMING'], noV = out['no VETO'], none = out['NEITHER'];
  console.log('\nWHAT EACH COMPONENT IS WORTH');
  console.log(`  timing, on top of rank+veto:   ${((all.cagr - noT.cagr) * 100).toFixed(2).padStart(7)} pp   (and ${((noT.mdd - all.mdd) * 100).toFixed(2)} pp less drawdown)`);
  console.log(`  veto,   on top of rank+timing: ${((all.cagr - noV.cagr) * 100).toFixed(2).padStart(7)} pp`);
  console.log(`  rank alone vs IHSG:            ${((none.cagr - ihsgCagr) * 100).toFixed(2).padStart(7)} pp`);
  console.log('\nRead the ordering, not the levels. In-sample, one regime, survivorship-biased,');
  console.log('and the candidate is NOT proven (EXP-020: no positive excess in both halves).');
  await pool.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
