/**
 * What was the universe look-ahead actually worth? (review P0.2)
 *
 * Removing it changed the headline CAGR from 23.76% to 20.26%, but that single
 * diff superimposes THREE changes and cannot be read as the look-ahead's price:
 *
 *   1. dropping the loaders' lifetime `placed >= 400 || nConc >= 200` screen
 *      (the look-ahead itself — strictly ADMITS more names)
 *   2. adding `minHiWindowBars`, an as-of depth test  (strictly EXCLUDES names)
 *   3. adding `requirePosfrac`, an as-of broker-coverage test (also EXCLUDES)
 *
 * Two of the three push the opposite way from the first, so the net number
 * attributes nothing. This runs each configuration in isolation on one loader,
 * so each term gets its own measurement.
 *
 * Usage: node measure_universe_lookahead.js
 */
'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const sb = require('./modules/strategy_book');

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
      close: new Array(n).fill(null), value: new Array(n).fill(null),
      dn0: new Array(n).fill(null), placed: 0, nConc: 0,
    });
    const s = series.get(r.stock_code);
    const c = Number(r.close_price);
    s.open[i] = Number(r.open_price) || c; s.high[i] = Number(r.high_price) || c;
    s.close[i] = c; s.value[i] = Number(r.value) || c * Number(r.volume || 0);
    s.placed++;
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
    s.dn0[i] = v; s.nConc++;
    if (i < concStart) concStart = i;
  }
  return { tradingDates, ihsgClose, ihsgSma: sb.smaSeries(ihsgClose, sb.DEFAULTS.regimeSma), series, concStart };
}

/** The lifetime screen, reinstated on demand so the OLD behaviour is reproducible. */
function applyLifetimeScreen(series) {
  const kept = new Map();
  for (const [t, s] of series) if (!(s.placed < 400 || s.nConc < 200)) kept.set(t, s);
  return kept;
}

function replay(series, ctx, firstI, lastI, opts) {
  const { ihsgClose, ihsgSma } = ctx;
  let cash = 1.0;
  const held = new Map();
  const eq = [];
  let trades = 0, eligibleSum = 0, decisions = 0;

  for (let i = firstI; i <= lastI; i += REBAL_BARS) {
    const execI = i + 1;
    if (execI > lastI + 1) break;
    const d = sb.targetBook({ series, i, ihsgClose, ihsgSma, currentHoldings: [...held.keys()], opts });
    eligibleSum += d.eligible; decisions++;

    let pv = cash;
    for (const [t, u] of held) { const px = series.get(t).open[execI]; if (px > 0) pv += u * px; }
    const tset = new Set(d.target);
    for (const [t, u] of [...held]) {
      if (tset.has(t)) continue;
      const px = series.get(t).open[execI];
      if (!(px > 0)) continue;                 // sell NO_FILL: keep holding
      cash += u * px * (1 - SELL_COST); trades++; held.delete(t);
    }
    for (const t of d.target.filter(x => !held.has(x))) {
      const px = series.get(t).open[execI];
      if (!(px > 0)) continue;
      const spend = Math.min(pv / Math.max(d.target.length, 1) * d.exposure, cash);
      if (spend <= 0) continue;
      cash -= spend; trades++;
      held.set(t, (spend * (1 - BUY_COST)) / px);
    }
    let mv = cash;
    for (const [t, u] of held) { const px = series.get(t).open[execI]; if (px > 0) mv += u * px; }
    eq.push(mv);
  }

  let final = cash;
  for (const [t, u] of held) {
    const s = series.get(t);
    for (let j = lastI; j >= 0; j--) if (s.close[j] > 0) { final += u * s.close[j] * (1 - SELL_COST); break; }
  }
  let peak = -Infinity, mdd = 0;
  for (const v of eq.concat([final])) { if (v > peak) peak = v; if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak); }
  const years = (lastI - firstI) / TRADING_DAYS_YEAR;
  return { cagr: Math.pow(final, 1 / years) - 1, mdd, trades, avgEligible: eligibleSum / Math.max(decisions, 1) };
}

(async () => {
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });
  const ctx = await load(pool);
  const firstI = Math.max(ctx.concStart + sb.DEFAULTS.posfracWindow, sb.DEFAULTS.hiBars, sb.DEFAULTS.regimeSma);
  const lastI = ctx.tradingDates.length - 2;
  const screened = applyLifetimeScreen(ctx.series);

  // Every configuration keeps the same execution model and the same dates. Only
  // the universe rule changes, one term at a time.
  const CONFIGS = [
    { label: 'A  OLD: lifetime screen, no as-of terms', series: screened,
      opts: { ...BASE, minHiWindowBars: 0, requirePosfrac: false } },
    { label: 'B  look-ahead REMOVED, no as-of terms', series: ctx.series,
      opts: { ...BASE, minHiWindowBars: 0, requirePosfrac: false } },
    { label: 'C  B + minHiWindowBars=200', series: ctx.series,
      opts: { ...BASE, minHiWindowBars: 200, requirePosfrac: false } },
    { label: 'D  C + requirePosfrac (= shipped)', series: ctx.series,
      opts: { ...BASE, minHiWindowBars: 200, requirePosfrac: true } },
    // The old axis-position test the shipped code also removed, isolated.
    { label: 'E  D but lifetime screen ALSO applied', series: screened,
      opts: { ...BASE, minHiWindowBars: 200, requirePosfrac: true } },
  ];

  console.log('='.repeat(88));
  console.log('P0.2 DECOMPOSITION — one universe term at a time, same dates, same execution');
  console.log('='.repeat(88));
  console.log(`window ${ctx.tradingDates[firstI]} .. ${ctx.tradingDates[lastI]}   tickers loaded ${ctx.series.size}   after lifetime screen ${screened.size}\n`);
  console.log('config                                       CAGR     maxDD   trades   avg eligible');
  const results = [];
  for (const c of CONFIGS) {
    const r = replay(c.series, ctx, firstI, lastI, c.opts);
    results.push({ ...c, ...r });
    console.log(`${c.label.padEnd(42)} ${(r.cagr * 100).toFixed(2).padStart(7)}%  ${(r.mdd * 100).toFixed(2).padStart(6)}%  ${String(r.trades).padStart(6)}   ${r.avgEligible.toFixed(1).padStart(12)}`);
  }

  const get = k => results.find(r => r.label.startsWith(k));
  console.log('\nATTRIBUTION');
  console.log(`  removing the look-ahead alone (A->B):        ${(((get('B').cagr - get('A').cagr)) * 100).toFixed(2)} pp`);
  console.log(`  adding the as-of depth test (B->C):          ${(((get('C').cagr - get('B').cagr)) * 100).toFixed(2)} pp`);
  console.log(`  adding as-of broker coverage (C->D):         ${(((get('D').cagr - get('C').cagr)) * 100).toFixed(2)} pp`);
  console.log(`  net, old vs shipped (A->D):                  ${(((get('D').cagr - get('A').cagr)) * 100).toFixed(2)} pp`);
  console.log(`  residual look-ahead still in the screen (E-D): ${(((get('E').cagr - get('D').cagr)) * 100).toFixed(2)} pp`);
  console.log('\nE is diagnostic only: it re-applies the lifetime screen ON TOP of the as-of terms.');
  console.log('Any gap between E and D is return that exists only because the universe was');
  console.log('chosen with knowledge of the future.');
  await pool.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
