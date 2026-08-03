/**
 * EXP-017 — Broker veto overlay on the HI52W book
 *
 * QUESTION
 * --------
 * EXP-016 found persistent top-3-broker accumulation (POSFRAC_60) predicts
 * UNDERperformance, with |IC| 0.105 and |IR| 0.83 — the strongest relationship
 * in the registry, and stable in sign across all three calendar years. Retail
 * cannot readily short on IDX, so the usable form is a VETO on the long book:
 * do not buy names showing persistent broker accumulation.
 *
 * Does that veto survive costs and a walk-forward on the actual book?
 *
 * This is the first time the project has had two signals from genuinely
 * different sources to combine. EXP-012 established the price-momentum family
 * is internally correlated 0.49-0.67 and cannot add to itself; broker flow is
 * orthogonal by construction.
 *
 * THE CONTROL THAT DECIDES IT
 * ---------------------------
 * A veto removes candidates, which mechanically changes concentration and
 * turnover. Any veto might therefore "help" for reasons having nothing to do
 * with the signal. RANDOM20 vetoes a seeded-random 20% of candidates each
 * rebalance. If the real veto does not clearly beat the random one, the effect
 * is bookkeeping, not information.
 *
 * DISCIPLINE (unchanged from EXP-014/015)
 * ---------------------------------------
 * HI52W ranking and the 200d-SMA regime filter are FIXED. Every variant is
 * scored as the MEAN across all 9 (rebalance x buffer) cells, never a selected
 * cell, plus a split-half walk-forward. The median across cells is reported
 * alongside the mean — EXP-015's lesson, where a mean over divergent paths was
 * carried by three outlier cells.
 *
 * WINDOW — read this before comparing to EXP-013/014
 * --------------------------------------------------
 * Concentration data only begins 2024-01-02, and POSFRAC_60 needs 60 days of
 * it, so this runs on ~2.3 years versus EXP-013/014's ~9. The BASE row is
 * re-run on this SAME shortened window so the comparison is like-for-like; its
 * numbers will not match EXP-014's and are not meant to.
 *
 * SURVIVORSHIP-BIASED RESEARCH RESULT.
 *
 * Usage: node backtest_broker_veto.js [--positions 8] [--json out.json]
 */
'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const stats = require('./modules/statistics');
const cs = require('./modules/cross_sectional');
const sb = require('./modules/strategy_book');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const HI_BARS = 252, ADV_WINDOW = 20, MIN_ADV = 5e9, MIN_ELIGIBLE = 20;
const BUY_COST = 0.20 / 100, SELL_COST = 0.30 / 100;
const TRADING_DAYS_YEAR = 245, REGIME_SMA = 200;
const POSFRAC_WINDOW = 60, POSFRAC_MIN_REAL = 35;
const DN_BOUND = 100;
const RANDOM_SEED = 42;

const CELLS = [];
for (const rb of [{ k: 'weekly', b: 5 }, { k: 'biweekly', b: 10 }, { k: 'monthly', b: 21 }])
  for (const buf of [1, 2, 3]) CELLS.push({ rebalance: rb.k, rebalBars: rb.b, buffer: buf });

/**
 * Two controls decide whether this is signal or bookkeeping:
 *  - RANDOM: vetoing anything changes concentration and turnover by itself.
 *  - REVERSE: vetoes the BOTTOM of the POSFRAC distribution instead of the top.
 *    If the effect is really about persistent broker accumulation predicting
 *    underperformance, removing the LEAST-accumulated names must HURT. If it
 *    helps too, the benefit has nothing to do with the signal's direction.
 * The dose grid (5/10/15/20/25/30/40%) tests for a smooth response — a real
 * effect should strengthen with dose, not switch sign between neighbours.
 */
const VARIANTS = [
  { key: 'BASE (no veto)',     veto: null, exitOnVeto: false },
  { key: 'VETO top 5%',        veto: 0.05, exitOnVeto: false },
  { key: 'VETO top 10%',       veto: 0.10, exitOnVeto: false },
  { key: 'VETO top 15%',       veto: 0.15, exitOnVeto: false },
  { key: 'VETO top 20%',       veto: 0.20, exitOnVeto: false },
  { key: 'VETO top 25%',       veto: 0.25, exitOnVeto: false },
  { key: 'VETO top 30%',       veto: 0.30, exitOnVeto: false },
  { key: 'VETO top 40%',       veto: 0.40, exitOnVeto: false },
  { key: 'VETO top 20% +exit', veto: 0.20, exitOnVeto: true  },
  { key: 'REVERSE bot 20%',    veto: 0.20, exitOnVeto: false, reverse: true },
  { key: 'REVERSE bot 30%',    veto: 0.30, exitOnVeto: false, reverse: true },
  { key: 'RANDOM 20% (ctrl)',  veto: 0.20, exitOnVeto: false, random: true },
];

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { positions: 8, json: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--positions') out.positions = Number(a[++i]);
    else if (a[i] === '--json') out.json = a[++i];
  }
  return out;
}
const toDateStr = d => d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d).split('T')[0];
function rollingMedian(arr, i, w) {
  if (i + 1 < w) return null;
  const s = arr.slice(i - w + 1, i + 1).filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function maxDrawdown(c) {
  let peak = -Infinity, mdd = 0;
  for (const v of c) { if (v > peak) peak = v; if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak); }
  return mdd;
}
const annualise = (t, d) => d > 0 ? Math.pow(1 + t, TRADING_DAYS_YEAR / d) - 1 : null;
const pct = (v, d = 2) => (v === null || !Number.isFinite(v)) ? '    n/a' : (v * 100).toFixed(d).padStart(7) + '%';

async function main() {
  const opts = parseArgs();
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  console.log('='.repeat(112));
  console.log(`EXP-017 — Broker veto (POSFRAC_60) on the HI52W + regime book, ${opts.positions} positions`);
  console.log('Mean AND median across all 9 (rebalance x buffer) cells. *** SURVIVORSHIP-BIASED ***');
  console.log('='.repeat(112));

  const [ihsgRows] = await pool.query('SELECT date, close_price FROM idx_ihsg_history ORDER BY date ASC');
  const tradingDates = ihsgRows.map(r => toDateStr(r.date));
  const ihsg = ihsgRows.map(r => Number(r.close_price));
  const dateIdx = new Map(tradingDates.map((d, i) => [d, i]));
  const n = tradingDates.length;

  const ihsgSMA = new Array(n).fill(null);
  let run = 0;
  for (let i = 0; i < n; i++) {
    run += ihsg[i];
    if (i >= REGIME_SMA) run -= ihsg[i - REGIME_SMA];
    if (i >= REGIME_SMA - 1) ihsgSMA[i] = run / REGIME_SMA;
  }

  const [priceRows] = await pool.query(
    `SELECT stock_code, date, open_price, high_price, close_price, volume, value
       FROM idx_stock_prices WHERE close_price > 0 ORDER BY stock_code, date ASC`
  );
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

  const [concRows] = await pool.query('SELECT stock_code, data_date, dn0 FROM idx_concentration ORDER BY data_date ASC');
  for (const r of concRows) {
    const i = dateIdx.get(toDateStr(r.data_date));
    if (i === undefined) continue;
    const s = series.get(r.stock_code);
    if (!s || r.dn0 === null) continue;
    const x = Number(r.dn0);
    if (!Number.isFinite(x)) continue;
    s.dn0[i] = Math.abs(x) > DN_BOUND ? Math.sign(x) * DN_BOUND : x;  // same clip as EXP-016
    s.nConc++;
  }
  for (const [t, s] of series) if (s.placed < 400 || s.nConc < 200) series.delete(t);

  const concIdx = concRows.map(r => dateIdx.get(toDateStr(r.data_date))).filter(v => v !== undefined);
  const concStart = Math.min(...concIdx);
  const firstI = Math.max(concStart + POSFRAC_WINDOW, HI_BARS, REGIME_SMA);
  const lastI = n - 2;
  console.log(`\nWindow    : ${tradingDates[firstI]} .. ${tradingDates[lastI]}  (${((lastI - firstI) / TRADING_DAYS_YEAR).toFixed(1)} years — SHORTER than EXP-013/014's ~9y)`);
  console.log(`Universe  : ${series.size} tickers with both price and concentration history\n`);

  /**
   * Veto selection rule per variant. Injected into the live module so the
   * experiment varies ONLY this, never eligibility/ranking/buffering.
   */
  function makeSelector(variant, rng) {
    if (variant.veto === null) return null;
    return (rows) => {
      const banned = new Set();
      if (variant.random) {
        for (const r of rows) if (rng() < variant.veto) banned.add(r.ticker);
        return banned;
      }
      const withPf = rows.filter(r => r.posfrac !== null)
        .sort((a, b) => variant.reverse ? a.posfrac - b.posfrac : b.posfrac - a.posfrac);
      const k = Math.floor(withPf.length * variant.veto);
      for (let z = 0; z < k; z++) banned.add(withPf[z].ticker);
      return banned;
    };
  }

  function simulate({ rebalBars, buffer, variant, lo, hi }) {
    const loI = lo === undefined ? firstI : lo, hiI = hi === undefined ? lastI : hi;
    let cash = 1.0;
    const held = new Map();
    const curve = [];
    const rng = cs.mulberry32(RANDOM_SEED + rebalBars * 100 + buffer);
    let vetoed = 0, shortfall = 0, periods = 0, noFill = 0, fills = 0;

    for (let i = loI; i <= hiI; i += rebalBars) {
      const execI = i + 1;

      // THE DECISION comes from the live module — the same function
      // strategy_forward.js calls in production. Its eligibility uses data
      // through bar i only; the previous local copy screened on open[i+1],
      // which quietly discarded names that turned out to be untradeable the
      // NEXT day. That is information the decision could not have had.
      const decision = sb.targetBook({
        series, i, ihsgClose: ihsg, ihsgSma: ihsgSMA,
        currentHoldings: [...held.keys()],
        opts: {
          positions: opts.positions, bufferMult: buffer,
          exitOnVeto: !!variant.exitOnVeto,
          vetoFrac: variant.veto === null ? 0 : variant.veto,
          vetoSelector: makeSelector(variant, rng),
          minAdv: MIN_ADV, advWindow: ADV_WINDOW, hiBars: HI_BARS,
          posfracWindow: POSFRAC_WINDOW, posfracMinReal: POSFRAC_MIN_REAL,
          regimeSma: REGIME_SMA, minEligible: MIN_ELIGIBLE,
        },
      });
      if (decision.eligible < MIN_ELIGIBLE) continue;
      periods++;

      const exposure = decision.exposure;
      vetoed += decision.vetoedCount;
      if (exposure > 0 && decision.target.length < opts.positions) shortfall++;

      let pv = cash;
      for (const [t, u] of held) { const px = series.get(t).open[execI]; if (px > 0) pv += u * px; }

      const target = decision.target;
      const targetSet = new Set(target);

      for (const [t, u] of [...held]) {
        if (targetSet.has(t)) continue;
        const px = series.get(t).open[execI];
        if (px > 0) cash += u * px * (1 - SELL_COST);
        held.delete(t);
      }
      const toBuy = target.filter(t => !held.has(t));
      if (toBuy.length) {
        const per = (pv * exposure) / Math.max(target.length, 1);
        for (const t of toBuy) {
          const px = series.get(t).open[execI];
          // NO_FILL: the name was eligible and selected on the evidence
          // available at T, but there is no opening price at T+1 — suspension,
          // halt, or no trade. A real book would carry the intent and simply
          // miss the fill, holding cash. It must NOT be removed from the
          // cross-section retroactively, which is what the old eligibility
          // screen did and why results were flattered.
          if (!(px > 0)) { noFill++; continue; }
          fills++;
          const spend = Math.min(per, cash);
          if (spend <= 0) break;
          cash -= spend;
          held.set(t, (held.get(t) || 0) + (spend * (1 - BUY_COST)) / px);
        }
      }
      let mv = cash;
      for (const [t, u] of held) { const px = series.get(t).open[execI]; if (px > 0) mv += u * px; }
      curve.push(mv);
    }

    let final = cash;
    for (const [t, u] of held) { const s = series.get(t); for (let j = hiI; j >= 0; j--) if (s.close[j] > 0) { final += u * s.close[j] * (1 - SELL_COST); break; } }
    curve.push(final);
    const rets = [];
    for (let k = 1; k < curve.length; k++) rets.push(curve[k] / curve[k - 1] - 1);
    const vol = rets.length > 1 ? stats.stdDev(rets) * Math.sqrt(TRADING_DAYS_YEAR / rebalBars) : null;
    const cagr = annualise(final - 1, hiI - loI);
    return { cagr, mdd: maxDrawdown(curve), vol, retVol: vol > 0 ? cagr / vol : null,
             vetoed, shortfallPct: periods ? shortfall / periods : 0,
             noFill, fills, noFillPct: (fills + noFill) ? noFill / (fills + noFill) : 0 };
  }

  function universeCagr(rebalBars, lo, hi) {
    const loI = lo === undefined ? firstI : lo, hiI = hi === undefined ? lastI : hi;
    let cash = 1.0; const held = new Map();
    for (let i = loI; i <= hiI; i += rebalBars) {
      const execI = i + 1;
      // The benchmark must use the SAME eligibility as the strategy, or the
      // comparison silently measures the screen instead of the selection.
      const xs = sb.crossSection(series, i, {
        minAdv: MIN_ADV, advWindow: ADV_WINDOW, hiBars: HI_BARS,
        posfracWindow: POSFRAC_WINDOW, posfracMinReal: POSFRAC_MIN_REAL, vetoFrac: 0,
      });
      if (xs.length < MIN_ELIGIBLE) continue;
      let pv = cash;
      for (const [t, u] of held) { const px = series.get(t).open[execI]; if (px > 0) pv += u * px; }
      const tset = new Set(xs.map(x => x.ticker));
      for (const [t, u] of [...held]) {
        if (tset.has(t)) continue;
        const px = series.get(t).open[execI];
        if (px > 0) cash += u * px * (1 - SELL_COST);
        held.delete(t);
      }
      const per = pv / tset.size;
      for (const t of [...tset].filter(x => !held.has(x))) {
        const px = series.get(t).open[execI];
        if (!(px > 0)) continue;
        const spend = Math.min(per, cash);
        if (spend <= 0) break;
        cash -= spend; held.set(t, (held.get(t) || 0) + (spend * (1 - BUY_COST)) / px);
      }
    }
    let final = cash;
    for (const [t, u] of held) { const s = series.get(t); for (let j = hiI; j >= 0; j--) if (s.close[j] > 0) { final += u * s.close[j] * (1 - SELL_COST); break; } }
    return annualise(final - 1, hiI - loI);
  }

  const uniCache = new Map();
  const uni = (b, lo, hi) => { const k = `${b}|${lo}|${hi}`; if (!uniCache.has(k)) uniCache.set(k, universeCagr(b, lo, hi)); return uniCache.get(k); };

  function score(variant, lo, hi) {
    const rows = CELLS.map(c => {
      const r = simulate({ rebalBars: c.rebalBars, buffer: c.buffer, variant, lo, hi });
      return { ...r, excess: r.cagr - uni(c.rebalBars, lo, hi) };
    });
    const f = k => rows.map(r => r[k]).filter(Number.isFinite);
    const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    return {
      meanExcess: stats.mean(f('excess')), medExcess: med(f('excess')),
      meanCagr: stats.mean(f('cagr')), meanMDD: stats.mean(f('mdd')),
      meanRetVol: stats.mean(f('retVol')), positive: rows.filter(r => r.excess > 0).length,
      shortfall: stats.mean(f('shortfallPct')), noFillPct: stats.mean(f('noFillPct')),
    };
  }

  const midI = firstI + Math.floor((lastI - firstI) / 2);

  console.log('='.repeat(112));
  console.log('FULL WINDOW — mean across 9 cells (median in brackets: EXP-015 showed means hide outlier cells)');
  console.log('='.repeat(112));
  console.log('  variant                 CAGR   excess (median)    maxDD   ret/vol  +cells  under-filled  NO_FILL');
  const full = {};
  for (const v of VARIANTS) {
    const s = score(v);
    full[v.key] = s;
    console.log(`  ${v.key.padEnd(20)} ${pct(s.meanCagr)}  ${pct(s.meanExcess)} (${pct(s.medExcess)})  ${pct(s.meanMDD)}    ${s.meanRetVol.toFixed(2).padStart(5)}    ${String(s.positive).padStart(2)}/9   ${pct(s.shortfall, 1)}  ${pct(s.noFillPct, 2)}`);
  }

  console.log('\n' + '='.repeat(112));
  console.log('SPLIT-HALF — does it hold in both halves?');
  console.log('='.repeat(112));
  console.log('  variant               P1 excess   P1 maxDD   P1 r/v      P2 excess   P2 maxDD   P2 r/v');
  const split = {};
  for (const v of VARIANTS) {
    const a = score(v, firstI, midI), b = score(v, midI, lastI);
    split[v.key] = { p1: a, p2: b };
    console.log(`  ${v.key.padEnd(20)} ${pct(a.meanExcess)}   ${pct(a.meanMDD)}    ${a.meanRetVol.toFixed(2).padStart(5)}      ${pct(b.meanExcess)}   ${pct(b.meanMDD)}    ${b.meanRetVol.toFixed(2).padStart(5)}`);
  }

  console.log('\n' + '='.repeat(112));
  console.log('MECHANICAL VERDICT');
  console.log('='.repeat(112));
  const base = full['BASE (no veto)'], ctrl = full['RANDOM 20% (ctrl)'];
  const best = VARIANTS.filter(v => v.veto !== null && !v.random && !v.reverse)
    .map(v => ({ key: v.key, ...full[v.key] }))
    .reduce((a, b) => (b.meanExcess > a.meanExcess ? b : a));

  console.log('\n  DOSE RESPONSE (entry-only vetoes) — a real effect strengthens with dose:');
  ['VETO top 5%', 'VETO top 10%', 'VETO top 15%', 'VETO top 20%', 'VETO top 25%', 'VETO top 30%', 'VETO top 40%']
    .forEach(k => console.log(`    ${k.padEnd(16)} excess ${pct(full[k].meanExcess)}  (median ${pct(full[k].medExcess)})`));

  console.log('\n  REVERSE CONTROL — banning the LEAST-accumulated names should HURT:');
  ['REVERSE bot 20%', 'REVERSE bot 30%']
    .forEach(k => console.log(`    ${k.padEnd(16)} excess ${pct(full[k].meanExcess)}  vs BASE ${pct(base.meanExcess)}  -> ${full[k].meanExcess < base.meanExcess ? 'hurts (expected)' : 'HELPS — signal direction not confirmed'}`));

  console.log(`\n  BASE          excess ${pct(base.meanExcess)}  maxDD ${pct(base.meanMDD)}  ret/vol ${base.meanRetVol.toFixed(2)}`);
  console.log(`  RANDOM (ctrl) excess ${pct(ctrl.meanExcess)}  maxDD ${pct(ctrl.meanMDD)}  ret/vol ${ctrl.meanRetVol.toFixed(2)}`);
  console.log(`  BEST VETO     excess ${pct(best.meanExcess)}  maxDD ${pct(best.meanMDD)}  ret/vol ${best.meanRetVol.toFixed(2)}   (${best.key})`);

  const beatsBase = best.meanExcess > base.meanExcess;
  const beatsRandom = best.meanExcess > ctrl.meanExcess;
  const sp = split[best.key], spB = split['BASE (no veto)'];
  const bothHalves = sp.p1.meanExcess > spB.p1.meanExcess && sp.p2.meanExcess > spB.p2.meanExcess;

  console.log(`\n  beats BASE:              ${beatsBase ? 'YES' : 'no'}   (${pct(best.meanExcess - base.meanExcess)} of excess)`);
  console.log(`  beats RANDOM control:    ${beatsRandom ? 'YES' : 'no'}   (${pct(best.meanExcess - ctrl.meanExcess)})`);
  console.log(`  beats BASE in BOTH halves: ${bothHalves ? 'YES' : 'no'}`);
  console.log('\n  All three must be YES. Beating BASE alone proves nothing — removing candidates');
  console.log('  changes concentration and turnover on its own, which is what RANDOM measures.');
  console.log('  And a veto that only works in one half is the EXP-013 failure mode repeating.');

  if (opts.json) {
    require('fs').writeFileSync(opts.json, JSON.stringify({ full, split }, null, 2));
    console.log(`\n  JSON written to ${opts.json}`);
  }
  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
