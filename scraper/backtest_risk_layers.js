/**
 * EXP-014 — Risk layers on a FIXED HI52W book
 *
 * QUESTION
 * --------
 * EXP-013 showed the HI52W portfolio's disqualifying number is not its return
 * but its 25-52% drawdown, and that tuning the ranking parameters does not
 * survive a walk-forward. So: hold the factor and the ranking rule FIXED, add
 * risk layers one at a time, and ask whether drawdown can be controlled without
 * giving back the (modest) excess.
 *
 * DISCIPLINE — why every layer is scored across ALL NINE cells
 * ------------------------------------------------------------
 * EXP-013's best cell (biweekly / top 16) was chosen with hindsight and
 * delivered -1.58% out of sample. Reporting a risk layer's effect on that cell
 * would compound the same error. Instead every layer is run against all 9
 * (rebalance x buffer) cells and reported as the MEAN across cells, so the
 * question answered is "does this layer help regardless of which parameter you
 * happened to pick" — the only version of the question that generalises.
 * Nothing here tunes the factor, the buffer, or the rebalance clock.
 *
 * LAYERS
 *   REGIME_FLAT  IHSG below its own 200-day SMA -> 0% exposure (stand aside)
 *   REGIME_HALF  IHSG below its own 200-day SMA -> 50% exposure
 *   INVVOL       size positions by 1/ATR% instead of equal weight
 *   STOP         per-position stop at 2.5x ATR below entry, checked DAILY,
 *                filled at the open when the bar gaps through it
 *   COMBINED     REGIME_HALF + INVVOL + STOP
 *
 * The 2.5x ATR stop distance is not tuned — it is the risk unit already set in
 * modules/trade_policy.js for the POSITION profile.
 *
 * NOT TESTED HERE: sector / correlation caps. There is no IDX sector data in
 * this database — ft_ticker_sectors holds 31 US tickers (TECH/FINTECH/ETF) with
 * zero overlap with the 245 tracked IDX names. This matters: 8 stocks near
 * their 52-week high on IDX are plausibly 5 commodity names, and that
 * concentration is invisible to every number below. Deferred, not dismissed.
 *
 * SURVIVORSHIP-BIASED RESEARCH RESULT.
 *
 * Usage: node backtest_risk_layers.js [--positions 8] [--json out.json]
 */
'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const stats = require('./modules/statistics');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const WARMUP = 260, HI_BARS = 252, ADV_WINDOW = 20, MIN_ADV = 5e9, MIN_ELIGIBLE = 25;
const MIN_HI_WINDOW_BARS = 200;   // real bars required INSIDE the trailing HI_BARS window (as-of; review P0.2)
const BUY_COST = 0.20 / 100, SELL_COST = 0.30 / 100;
const TRADING_DAYS_YEAR = 245;
const REGIME_SMA = 200;
const STOP_ATR_MULT = 2.5;   // from modules/trade_policy.js POSITION profile — not tuned here
const ATR_PERIOD = 14;

const CELLS = [];
for (const rb of [{ k: 'weekly', b: 5 }, { k: 'biweekly', b: 10 }, { k: 'monthly', b: 21 }])
  for (const buf of [1, 2, 3]) CELLS.push({ rebalance: rb.k, rebalBars: rb.b, buffer: buf });

const LAYERS = [
  { key: 'BASE',        regime: 1,   invVol: false, stop: false },
  { key: 'REGIME_FLAT', regime: 0,   invVol: false, stop: false },
  { key: 'REGIME_HALF', regime: 0.5, invVol: false, stop: false },
  { key: 'INVVOL',      regime: 1,   invVol: true,  stop: false },
  { key: 'STOP',        regime: 1,   invVol: false, stop: true  },
  { key: 'COMBINED',    regime: 0.5, invVol: true,  stop: true  },
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

function maxDrawdown(curve) {
  let peak = -Infinity, mdd = 0;
  for (const v of curve) { if (v > peak) peak = v; if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak); }
  return mdd;
}
const annualise = (total, nDays) => nDays > 0 ? Math.pow(1 + total, TRADING_DAYS_YEAR / nDays) - 1 : null;
const pct = (v, d = 2) => (v === null || !Number.isFinite(v)) ? '    n/a' : (v * 100).toFixed(d).padStart(7) + '%';

async function main() {
  const opts = parseArgs();
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  console.log('='.repeat(116));
  console.log(`EXP-014 — Risk layers on a FIXED HI52W book (${opts.positions} positions, long only)`);
  console.log('Every layer scored as the MEAN across all 9 (rebalance x buffer) cells — no cell is selected.');
  console.log('*** SURVIVORSHIP-BIASED RESEARCH RESULT — no sector/correlation cap (no IDX sector data) ***');
  console.log('='.repeat(116));

  const [ihsgRows] = await pool.query('SELECT date, close_price FROM idx_ihsg_history ORDER BY date ASC');
  const tradingDates = ihsgRows.map(r => toDateStr(r.date));
  const ihsg = ihsgRows.map(r => Number(r.close_price));
  const dateIdx = new Map(tradingDates.map((d, i) => [d, i]));
  const n = tradingDates.length;

  // IHSG 200-day SMA, computed from data through each bar only.
  const ihsgSMA = new Array(n).fill(null);
  let run = 0;
  for (let i = 0; i < n; i++) {
    run += ihsg[i];
    if (i >= REGIME_SMA) run -= ihsg[i - REGIME_SMA];
    if (i >= REGIME_SMA - 1) ihsgSMA[i] = run / REGIME_SMA;
  }

  const [priceRows] = await pool.query(
    `SELECT stock_code, date, open_price, high_price, low_price, close_price, volume, value
       FROM idx_stock_prices WHERE close_price > 0 ORDER BY stock_code, date ASC`
  );
  const series = new Map();
  for (const r of priceRows) {
    const i = dateIdx.get(toDateStr(r.date));
    if (i === undefined) continue;
    if (!series.has(r.stock_code)) series.set(r.stock_code, {
      open: new Array(n).fill(null), high: new Array(n).fill(null),
      low: new Array(n).fill(null), close: new Array(n).fill(null),
      value: new Array(n).fill(null), placed: 0,
    });
    const s = series.get(r.stock_code);
    const c = Number(r.close_price);
    s.open[i] = Number(r.open_price) || c;
    s.high[i] = Number(r.high_price) || c;
    s.low[i] = Number(r.low_price) || c;
    s.close[i] = c;
    s.value[i] = Number(r.value) || c * Number(r.volume || 0);
    s.placed++;
  }
  // NO UNIVERSE FILTER HERE -- see review P0.2. This used to delete any ticker
  // whose LIFETIME bar count fell short, which asks whether a name will
  // eventually accumulate enough data by the end of the sample. Depth is now
  // checked per decision bar in this script's own crossSection(), over the
  // trailing window only.

  // ATR(14) as a % of close, precomputed per ticker (Wilder smoothing).
  for (const [, s] of series) {
    s.atrPct = new Array(n).fill(null);
    let prevAtr = null, prevClose = null, seeded = 0, sum = 0;
    for (let i = 0; i < n; i++) {
      if (s.close[i] === null) { prevClose = null; continue; }
      if (prevClose === null) { prevClose = s.close[i]; continue; }
      const tr = Math.max(s.high[i] - s.low[i], Math.abs(s.high[i] - prevClose), Math.abs(s.low[i] - prevClose));
      if (prevAtr === null) {
        sum += tr; seeded++;
        if (seeded === ATR_PERIOD) prevAtr = sum / ATR_PERIOD;
      } else {
        prevAtr = (prevAtr * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
      }
      if (prevAtr !== null && s.close[i] > 0) s.atrPct[i] = (prevAtr / s.close[i]) * 100;
      prevClose = s.close[i];
    }
  }

  const firstI = Math.max(WARMUP, HI_BARS, REGIME_SMA);
  const lastI = n - 2;
  console.log(`\nAxis ${tradingDates[firstI]}..${tradingDates[lastI]}   universe ${series.size} tickers`);
  console.log(`Layers: regime = IHSG vs its own ${REGIME_SMA}d SMA; stop = ${STOP_ATR_MULT}x ATR(${ATR_PERIOD}), daily check, gap-filled at the open\n`);

  function crossSection(i) {
    const out = [];
    for (const [ticker, s] of series) {
      if (s.close[i] === null) continue;   // eligibility uses data through bar i only
      const adv = rollingMedian(s.value, i, ADV_WINDOW);
      if (adv === null || adv < MIN_ADV) continue;
      let hi = -Infinity, realBars = 0;
      for (let j = Math.max(0, i - HI_BARS + 1); j <= i; j++) {
        if (s.close[j] !== null && s.close[j] !== undefined) realBars++;
        if (s.high[j] !== null && s.high[j] > hi) hi = s.high[j];
      }
      // As-of depth check, replacing the loader's lifetime `placed < WARMUP+100`
      // delete (review P0.2). Counts only bars inside the trailing window, so
      // nothing after `i` can affect it.
      if (realBars < MIN_HI_WINDOW_BARS) continue;
      if (!(hi > 0)) continue;
      out.push({ ticker, score: (s.close[i] / hi) * 100 });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  function simulate({ rebalBars, buffer, layer, lo, hi }) {
    const loI = lo === undefined ? firstI : lo;
    const hiI = hi === undefined ? lastI : hi;
    let cash = 1.0;
    const held = new Map(); // ticker -> { units, stop }
    const curve = [];
    let trades = 0, stopExits = 0, flatPeriods = 0, periods = 0;

    const markValue = (i, priceField) => {
      let v = cash;
      for (const [t, p] of held) {
        const px = series.get(t)[priceField][i];
        if (px !== null && px > 0) v += p.units * px;
      }
      return v;
    };

    for (let i = loI; i <= hiI; i += rebalBars) {
      const execI = i + 1;
      const nextI = Math.min(i + rebalBars, hiI);

      // ── Daily stop walk over the PREVIOUS holding period happens before the
      // new rebalance decision, so a stopped name is already out and its cash
      // is available. (First iteration has no holdings, so this is a no-op.)
      if (layer.stop) {
        for (let j = Math.max(loI + 1, i - rebalBars + 1); j <= i && j < n; j++) {
          for (const [t, p] of [...held]) {
            const s = series.get(t);
            if (s.low[j] === null || p.stop === null) continue;
            if (s.low[j] <= p.stop) {
              // Gap through the stop fills at the open, not the stop price.
              const fill = (s.open[j] !== null && s.open[j] < p.stop) ? s.open[j] : p.stop;
              cash += p.units * fill * (1 - SELL_COST);
              held.delete(t); trades++; stopExits++;
            }
          }
        }
      }

      const xs = crossSection(i);
      if (xs.length < MIN_ELIGIBLE) continue;
      periods++;

      // Regime exposure — uses IHSG data through bar i only.
      let exposure = 1;
      if (layer.regime < 1 && ihsgSMA[i] !== null && ihsg[i] < ihsgSMA[i]) {
        exposure = layer.regime;
        if (exposure === 0) flatPeriods++;
      }

      const portValue = markValue(execI, 'open');

      const rank = new Map(xs.map((x, idx) => [x.ticker, idx]));
      const keepLimit = opts.positions * buffer;
      const keep = [...held.keys()].filter(t => rank.has(t) && rank.get(t) < keepLimit)
        .sort((a, b) => rank.get(a) - rank.get(b)).slice(0, opts.positions);
      const keepSet = new Set(keep);
      const fill = xs.map(x => x.ticker).filter(t => !keepSet.has(t))
        .slice(0, Math.max(0, opts.positions - keep.length));
      let target = exposure === 0 ? [] : [...keep, ...fill];
      const targetSet = new Set(target);

      // Sell everything not targeted.
      for (const [t, p] of [...held]) {
        if (targetSet.has(t)) continue;
        const px = series.get(t).open[execI];
        if (px === null || !(px > 0)) { held.delete(t); continue; }
        cash += p.units * px * (1 - SELL_COST);
        held.delete(t); trades++;
      }

      // Buy to target. Weights: equal, or inverse-ATR%.
      const toBuy = target.filter(t => !held.has(t));
      if (toBuy.length) {
        const investable = portValue * exposure;
        let weights;
        if (layer.invVol) {
          const inv = target.map(t => {
            const a = series.get(t).atrPct[i];
            return (a !== null && a > 0) ? 1 / a : null;
          });
          const valid = inv.filter(v => v !== null);
          const fallback = valid.length ? stats.mean(valid) : 1;
          const filled = inv.map(v => v === null ? fallback : v);
          const tot = filled.reduce((s, v) => s + v, 0);
          weights = new Map(target.map((t, k) => [t, filled[k] / tot]));
        } else {
          weights = new Map(target.map(t => [t, 1 / target.length]));
        }
        for (const t of toBuy) {
          const s = series.get(t);
          const px = s.open[execI];
          if (px === null || !(px > 0)) continue;
          const spend = Math.min(investable * weights.get(t), cash);
          if (spend <= 0) continue;
          const units = (spend * (1 - BUY_COST)) / px;
          cash -= spend;
          const atr = s.atrPct[i];
          const stop = layer.stop && atr !== null && atr > 0
            ? px * (1 - (STOP_ATR_MULT * atr) / 100) : null;
          held.set(t, { units, stop });
          trades++;
        }
      }

      curve.push(markValue(execI, 'open'));
    }

    let final = cash;
    for (const [t, p] of held) {
      const s = series.get(t);
      for (let j = hiI; j >= 0; j--) if (s.close[j] !== null && s.close[j] > 0) { final += p.units * s.close[j] * (1 - SELL_COST); break; }
    }
    curve.push(final);

    const rets = [];
    for (let k = 1; k < curve.length; k++) rets.push(curve[k] / curve[k - 1] - 1);
    const vol = rets.length > 1 ? stats.stdDev(rets) * Math.sqrt(TRADING_DAYS_YEAR / rebalBars) : null;
    const cagr = annualise(final - 1, hiI - loI);
    return { cagr, mdd: maxDrawdown(curve), vol, retVol: vol > 0 ? cagr / vol : null, trades, stopExits, flatPeriods, periods };
  }

  function universeCagr(rebalBars, lo, hi) {
    // Equal-weight eligible universe on the same clock — the benchmark.
    const loI = lo === undefined ? firstI : lo, hiI = hi === undefined ? lastI : hi;
    let cash = 1.0; const held = new Map();
    for (let i = loI; i <= hiI; i += rebalBars) {
      const execI = i + 1;
      const xs = crossSection(i);
      if (xs.length < MIN_ELIGIBLE) continue;
      let pv = cash;
      for (const [t, u] of held) { const px = series.get(t).open[execI]; if (px > 0) pv += u * px; }
      const targetSet = new Set(xs.map(x => x.ticker));
      for (const [t, u] of [...held]) {
        if (targetSet.has(t)) continue;
        const px = series.get(t).open[execI];
        if (px > 0) cash += u * px * (1 - SELL_COST);
        held.delete(t);
      }
      const toBuy = [...targetSet].filter(t => !held.has(t));
      const per = pv / targetSet.size;
      for (const t of toBuy) {
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

  const midI = firstI + Math.floor((lastI - firstI) / 2);
  const uniCache = new Map();
  const uni = (bars, lo, hi) => {
    const k = `${bars}|${lo}|${hi}`;
    if (!uniCache.has(k)) uniCache.set(k, universeCagr(bars, lo, hi));
    return uniCache.get(k);
  };

  function scoreLayer(layer, lo, hi) {
    const rows = CELLS.map(c => {
      const r = simulate({ rebalBars: c.rebalBars, buffer: c.buffer, layer, lo, hi });
      return { ...c, ...r, excess: r.cagr - uni(c.rebalBars, lo, hi) };
    });
    const f = k => rows.map(r => r[k]).filter(Number.isFinite);
    return {
      meanExcess: stats.mean(f('excess')), meanMDD: stats.mean(f('mdd')),
      meanRetVol: stats.mean(f('retVol')), meanCagr: stats.mean(f('cagr')),
      worstMDD: Math.max(...f('mdd')), positive: rows.filter(r => r.excess > 0).length,
      stopExits: Math.round(stats.mean(rows.map(r => r.stopExits))),
      flatPct: rows[0].periods ? stats.mean(rows.map(r => r.flatPeriods / r.periods)) : 0,
      rows,
    };
  }

  console.log('='.repeat(116));
  console.log('FULL SAMPLE — mean across all 9 cells');
  console.log('='.repeat(116));
  console.log('  layer          meanCAGR   meanExcess   meanMDD   worstMDD   ret/vol   +cells   stopExits   %periods flat');
  const full = {};
  for (const layer of LAYERS) {
    const s = scoreLayer(layer);
    full[layer.key] = s;
    console.log(`  ${layer.key.padEnd(13)} ${pct(s.meanCagr)}    ${pct(s.meanExcess)}  ${pct(s.meanMDD)}   ${pct(s.worstMDD)}     ${s.meanRetVol.toFixed(2).padStart(5)}     ${String(s.positive).padStart(2)}/9      ${String(s.stopExits).padStart(4)}       ${pct(s.flatPct, 1)}`);
  }

  console.log('\n' + '='.repeat(116));
  console.log('SPLIT-HALF — does the layer help in BOTH halves? (mean excess / mean maxDD across 9 cells)');
  console.log('='.repeat(116));
  console.log('  layer          P1 excess   P1 maxDD   P1 ret/vol      P2 excess   P2 maxDD   P2 ret/vol');
  const split = {};
  for (const layer of LAYERS) {
    const a = scoreLayer(layer, firstI, midI), b = scoreLayer(layer, midI, lastI);
    split[layer.key] = { p1: a, p2: b };
    console.log(`  ${layer.key.padEnd(13)} ${pct(a.meanExcess)}  ${pct(a.meanMDD)}      ${a.meanRetVol.toFixed(2).padStart(5)}      ${pct(b.meanExcess)}  ${pct(b.meanMDD)}      ${b.meanRetVol.toFixed(2).padStart(5)}`);
  }

  // ── THE CONTROL THAT DECIDES WHAT THIS IS ────────────────────────────────
  // The regime filter improves drawdown. But does it improve it BECAUSE of the
  // HI52W selection, or would simply standing aside from the whole market do
  // just as well? If universe+regime matches strategy+regime, then there is no
  // stock-selection edge here at all and the entire result is market timing.
  function universeWithRegime(rebalBars, exposureWhenBelow, lo, hi) {
    const loI = lo === undefined ? firstI : lo, hiI = hi === undefined ? lastI : hi;
    let cash = 1.0; const held = new Map(); const curve = [];
    for (let i = loI; i <= hiI; i += rebalBars) {
      const execI = i + 1;
      const xs = crossSection(i);
      if (xs.length < MIN_ELIGIBLE) continue;
      let pv = cash;
      for (const [t, u] of held) { const px = series.get(t).open[execI]; if (px > 0) pv += u * px; }
      const below = ihsgSMA[i] !== null && ihsg[i] < ihsgSMA[i];
      const exposure = below ? exposureWhenBelow : 1;
      const targetSet = exposure === 0 ? new Set() : new Set(xs.map(x => x.ticker));
      for (const [t, u] of [...held]) {
        if (targetSet.has(t)) continue;
        const px = series.get(t).open[execI];
        if (px > 0) cash += u * px * (1 - SELL_COST);
        held.delete(t);
      }
      const toBuy = [...targetSet].filter(t => !held.has(t));
      if (toBuy.length) {
        const per = (pv * exposure) / targetSet.size;
        for (const t of toBuy) {
          const px = series.get(t).open[execI];
          if (!(px > 0)) continue;
          const spend = Math.min(per, cash);
          if (spend <= 0) break;
          cash -= spend; held.set(t, (held.get(t) || 0) + (spend * (1 - BUY_COST)) / px);
        }
      }
      let mv = cash;
      for (const [t, u] of held) { const px = series.get(t).open[execI]; if (px > 0) mv += u * px; }
      curve.push(mv);
    }
    let final = cash;
    for (const [t, u] of held) { const s = series.get(t); for (let j = hiI; j >= 0; j--) if (s.close[j] > 0) { final += u * s.close[j] * (1 - SELL_COST); break; } }
    curve.push(final);
    return { cagr: annualise(final - 1, hiI - loI), mdd: maxDrawdown(curve) };
  }

  console.log('\n' + '='.repeat(116));
  console.log('CONTROL — is this stock selection, or just market timing?');
  console.log('='.repeat(116));
  console.log('  Same 200d-SMA regime rule applied to the WHOLE equal-weight universe (no HI52W selection at all).');
  console.log('\n  variant                                   full CAGR   full maxDD     P1 CAGR   P1 maxDD     P2 CAGR   P2 maxDD');
  const ctlRows = [];
  for (const [label, expo] of [['universe, no regime filter', 1], ['universe + regime FLAT', 0], ['universe + regime HALF', 0.5]]) {
    const f = universeWithRegime(10, expo);
    const p1 = universeWithRegime(10, expo, firstI, midI);
    const p2 = universeWithRegime(10, expo, midI, lastI);
    ctlRows.push({ label, full: f, p1, p2 });
    console.log(`  ${label.padEnd(40)} ${pct(f.cagr)}    ${pct(f.mdd)}    ${pct(p1.cagr)}   ${pct(p1.mdd)}    ${pct(p2.cagr)}   ${pct(p2.mdd)}`);
  }
  const stratFlat = full.REGIME_FLAT, uniFlat = ctlRows[1];
  console.log(`\n  HI52W + regime FLAT (mean of 9 cells)    ${pct(stratFlat.meanCagr)}    ${pct(stratFlat.meanMDD)}    ${pct(split.REGIME_FLAT.p1.meanCagr)}   ${pct(split.REGIME_FLAT.p1.meanMDD)}    ${pct(split.REGIME_FLAT.p2.meanCagr)}   ${pct(split.REGIME_FLAT.p2.meanMDD)}`);
  const selectionEdgeFull = stratFlat.meanCagr - uniFlat.full.cagr;
  const selectionEdgeP2 = split.REGIME_FLAT.p2.meanCagr - uniFlat.p2.cagr;
  console.log(`\n  Stock-selection contribution ON TOP of the regime filter:  full ${pct(selectionEdgeFull)}   Period 2 ${pct(selectionEdgeP2)}`);
  console.log('  If Period 2 is ~zero or negative, the recent-regime result is market timing, not selection.');

  console.log('\n' + '='.repeat(116));
  console.log('MECHANICAL VERDICT');
  console.log('='.repeat(116));
  const base = full.BASE;
  console.log(`\n  Baseline (no risk layer): excess ${pct(base.meanExcess)}, maxDD ${pct(base.meanMDD)}, ret/vol ${base.meanRetVol.toFixed(2)}`);
  const better = LAYERS.filter(l => l.key !== 'BASE').map(l => ({ key: l.key, ...full[l.key] }))
    .filter(s => s.meanMDD < base.meanMDD && s.meanRetVol > base.meanRetVol);
  if (!better.length) {
    console.log('\n  NO layer improves both drawdown AND return-per-unit-risk versus the baseline.');
  } else {
    console.log('\n  Layers improving BOTH maxDD and ret/vol on the full sample:');
    better.sort((a, b) => b.meanRetVol - a.meanRetVol).forEach(s => {
      const sp = split[s.key];
      const bothHalves = sp.p1.meanMDD < split.BASE.p1.meanMDD && sp.p2.meanMDD < split.BASE.p2.meanMDD;
      console.log(`    ${s.key.padEnd(13)} maxDD ${pct(s.meanMDD)} (base ${pct(base.meanMDD)})  ret/vol ${s.meanRetVol.toFixed(2)} (base ${base.meanRetVol.toFixed(2)})  drawdown improved in BOTH halves: ${bothHalves ? 'YES' : 'no'}`);
    });
  }
  console.log('\n  Read drawdown, not return. A layer that cuts maxDD while holding excess roughly');
  console.log('  flat is a win even if CAGR falls — that is what makes a book holdable.');
  console.log('  Nothing here is tuned: stop distance comes from trade_policy POSITION, the regime');
  console.log('  rule is a plain 200d SMA, and no cell was selected.');

  if (opts.json) {
    require('fs').writeFileSync(opts.json, JSON.stringify({
      full: Object.fromEntries(Object.entries(full).map(([k, v]) => [k, { ...v, rows: undefined }])),
      split: Object.fromEntries(Object.entries(split).map(([k, v]) => [k, { p1: { ...v.p1, rows: undefined }, p2: { ...v.p2, rows: undefined } }])),
    }, null, 2));
    console.log(`\n  JSON written to ${opts.json}`);
  }

  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
