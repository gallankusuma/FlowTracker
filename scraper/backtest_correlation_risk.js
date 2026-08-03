/**
 * EXP-015 — Correlation risk model: concentration diagnostic, correlation cap,
 *           and Hierarchical Risk Parity sizing
 *
 * WHY
 * ---
 * EXP-014 left the single largest risk in the book completely unmeasured: there
 * is no IDX sector data (ft_ticker_sectors holds 31 US tickers, zero overlap),
 * so 8 names near their 52-week high could be 5 correlated commodity stocks and
 * every number produced so far would be blind to it.
 *
 * Sector labels are not actually required. Ten years of returns give a
 * correlation matrix directly, which is what a sector label is a crude proxy
 * FOR. This experiment (a) measures how concentrated the book has really been,
 * (b) tests a correlation cap at selection time, and (c) tests Hierarchical
 * Risk Parity sizing (Lopez de Prado 2016), which is designed specifically for
 * noisy correlation estimates — the case we are in.
 *
 * DISCIPLINE (unchanged from EXP-014)
 * -----------------------------------
 * The factor and the ranking rule are FIXED. Every variant is scored as the
 * MEAN across all 9 (rebalance x buffer) cells, never a selected cell. The
 * 200d-SMA regime filter — the one layer that transferred out of sample — is
 * applied throughout, and a no-regime row is shown for reference. Nothing is
 * tuned: correlation thresholds are round numbers, the window is a plain 252
 * days, and HRP has no free parameters.
 *
 * NO LOOKAHEAD
 * ------------
 * Correlations at rebalance date t use returns strictly through t. They are
 * precomputed on a weekly grid and a rebalance looks up the most recent grid
 * point <= t, so a correlation estimate may be up to 4 trading days stale —
 * deliberately backward, never forward.
 *
 * SURVIVORSHIP-BIASED RESEARCH RESULT.
 *
 * Usage: node backtest_correlation_risk.js [--positions 8] [--json out.json]
 */
'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const exec = require('./modules/execution');
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
const CORR_WINDOW = 252;   // 1 year of daily returns
const GRID_STEP = 5;       // correlation matrices precomputed weekly

const CELLS = [];
for (const rb of [{ k: 'weekly', b: 5 }, { k: 'biweekly', b: 10 }, { k: 'monthly', b: 21 }])
  for (const buf of [1, 2, 3]) CELLS.push({ rebalance: rb.k, rebalBars: rb.b, buffer: buf });

const VARIANTS = [
  { key: 'EQUAL (no regime)', corrCap: null, hrp: false, regime: 1 },
  { key: 'EQUAL',             corrCap: null, hrp: false, regime: 0 },
  { key: 'HRP',               corrCap: null, hrp: true,  regime: 0 },
  { key: 'CORRCAP 0.7',       corrCap: 0.7,  hrp: false, regime: 0 },
  { key: 'CORRCAP 0.6',       corrCap: 0.6,  hrp: false, regime: 0 },
  { key: 'CORRCAP 0.7 + HRP', corrCap: 0.7,  hrp: true,  regime: 0 },
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
const annualise = (t, d) => d > 0 ? Math.pow(1 + t, TRADING_DAYS_YEAR / d) - 1 : null;
const pct = (v, d = 2) => (v === null || !Number.isFinite(v)) ? '    n/a' : (v * 100).toFixed(d).padStart(7) + '%';

// ── Hierarchical Risk Parity (Lopez de Prado 2016) ──────────────────────────
/** Single-linkage agglomerative clustering; returns merge order as a tree. */
function linkageSingle(dist, n) {
  const active = Array.from({ length: n }, (_, i) => ({ id: i, members: [i] }));
  const merges = [];
  while (active.length > 1) {
    let bi = 0, bj = 1, bd = Infinity;
    for (let a = 0; a < active.length; a++) {
      for (let b = a + 1; b < active.length; b++) {
        let m = Infinity;
        for (const x of active[a].members) for (const y of active[b].members) {
          const d = dist[x * n + y];
          if (d < m) m = d;
        }
        if (m < bd) { bd = m; bi = a; bj = b; }
      }
    }
    const merged = { id: -1, members: [...active[bi].members, ...active[bj].members],
                     left: active[bi], right: active[bj] };
    merges.push(merged);
    active.splice(bj, 1); active.splice(bi, 1); active.push(merged);
  }
  return active[0];
}
/** Quasi-diagonal ordering: depth-first walk of the linkage tree. */
function quasiDiag(node) {
  if (!node.left) return [...node.members];
  return [...quasiDiag(node.left), ...quasiDiag(node.right)];
}
/** Inverse-variance portfolio weight vector for a subset. */
function ivp(cov, n, idx) {
  const inv = idx.map(i => { const v = cov[i * n + i]; return v > 0 ? 1 / v : 0; });
  const tot = inv.reduce((s, v) => s + v, 0);
  return tot > 0 ? inv.map(v => v / tot) : idx.map(() => 1 / idx.length);
}
function clusterVar(cov, n, idx) {
  const w = ivp(cov, n, idx);
  let v = 0;
  for (let a = 0; a < idx.length; a++) for (let b = 0; b < idx.length; b++)
    v += w[a] * cov[idx[a] * n + idx[b]] * w[b];
  return v;
}
/** Recursive bisection over the quasi-diagonal order. */
function hrpWeights(cov, n, order) {
  const w = new Map(order.map(i => [i, 1]));
  const stack = [order];
  while (stack.length) {
    const items = stack.pop();
    if (items.length <= 1) continue;
    const half = Math.floor(items.length / 2);
    const left = items.slice(0, half), right = items.slice(half);
    const vL = clusterVar(cov, n, left), vR = clusterVar(cov, n, right);
    const denom = vL + vR;
    const alpha = denom > 0 ? 1 - vL / denom : 0.5;
    for (const i of left) w.set(i, w.get(i) * alpha);
    for (const i of right) w.set(i, w.get(i) * (1 - alpha));
    stack.push(left, right);
  }
  const tot = [...w.values()].reduce((s, v) => s + v, 0);
  const out = new Map();
  for (const [i, v] of w) out.set(i, tot > 0 ? v / tot : 1 / order.length);
  return out;
}

async function main() {
  const opts = parseArgs();
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  console.log('='.repeat(118));
  console.log(`EXP-015 — Correlation risk model on a FIXED HI52W book (${opts.positions} positions)`);
  console.log('Mean across all 9 (rebalance x buffer) cells. 200d-SMA regime filter applied unless stated.');
  console.log('*** SURVIVORSHIP-BIASED RESEARCH RESULT ***');
  console.log('='.repeat(118));

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
      close: new Array(n).fill(null), value: new Array(n).fill(null), placed: 0,
    });
    const s = series.get(r.stock_code);
    const c = Number(r.close_price);
    s.open[i] = Number(r.open_price) || c; s.high[i] = Number(r.high_price) || c;
    s.close[i] = c; s.value[i] = Number(r.value) || c * Number(r.volume || 0);
    s.placed++;
  }
  // NO UNIVERSE FILTER HERE -- see review P0.2. This used to delete any ticker
  // whose LIFETIME bar count fell short, which asks whether a name will
  // eventually accumulate enough data by the end of the sample. Depth is now
  // checked per decision bar in this script's own crossSection(), over the
  // trailing window only.

  // Daily simple returns, used for every correlation/covariance estimate.
  for (const [, s] of series) {
    s.ret = new Array(n).fill(null);
    for (let i = 1; i < n; i++) {
      if (s.close[i] !== null && s.close[i - 1] !== null && s.close[i - 1] > 0)
        s.ret[i] = s.close[i] / s.close[i - 1] - 1;
    }
  }

  const firstI = Math.max(WARMUP, HI_BARS, REGIME_SMA, CORR_WINDOW + 1);
  const lastI = n - 2;
  console.log(`\nAxis ${tradingDates[firstI]}..${tradingDates[lastI]}   universe ${series.size} tickers`);
  console.log(`Correlation: ${CORR_WINDOW}-day window, precomputed every ${GRID_STEP} trading days (lookup is backward-only)\n`);

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

  // ── Precompute correlation matrices on a weekly grid ──────────────────────
  process.stdout.write('Precomputing correlation matrices');
  const grid = new Map(); // gridIdx -> { tickers, pos:Map, corr:Float64Array, sd:Float64Array }
  const gridPoints = [];
  for (let i = firstI; i <= lastI; i += GRID_STEP) {
    const xs = crossSection(i);
    if (xs.length < MIN_ELIGIBLE) continue;
    const tickers = xs.map(x => x.ticker);
    const m = tickers.length;
    // Standardise each name's return window once; correlation is then a dot product.
    const z = [], sd = new Float64Array(m);
    for (let a = 0; a < m; a++) {
      const s = series.get(tickers[a]);
      const w = [];
      for (let j = i - CORR_WINDOW + 1; j <= i; j++) w.push(s.ret[j] === null ? 0 : s.ret[j]);
      const mu = w.reduce((x, y) => x + y, 0) / w.length;
      let ss = 0;
      for (const v of w) ss += (v - mu) * (v - mu);
      const sdev = Math.sqrt(ss / w.length);
      sd[a] = sdev;
      z.push(sdev > 0 ? w.map(v => (v - mu) / sdev) : w.map(() => 0));
    }
    const corr = new Float64Array(m * m);
    for (let a = 0; a < m; a++) {
      corr[a * m + a] = 1;
      for (let b = a + 1; b < m; b++) {
        let dot = 0;
        const za = z[a], zb = z[b];
        for (let k = 0; k < za.length; k++) dot += za[k] * zb[k];
        const c = dot / za.length;
        corr[a * m + b] = c; corr[b * m + a] = c;
      }
    }
    grid.set(i, { tickers, pos: new Map(tickers.map((t, k) => [t, k])), corr, sd, m });
    gridPoints.push(i);
    if (gridPoints.length % 60 === 0) process.stdout.write('.');
  }
  console.log(` done (${gridPoints.length} grid points)\n`);

  /** Most recent grid point at or before i — backward-only by construction. */
  function gridAt(i) {
    let lo = 0, hi = gridPoints.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (gridPoints[mid] <= i) { best = gridPoints[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return best === -1 ? null : grid.get(best);
  }

  function corrOf(g, a, b) {
    const ia = g.pos.get(a), ib = g.pos.get(b);
    if (ia === undefined || ib === undefined) return null;
    return g.corr[ia * g.m + ib];
  }

  // ── Diagnostic: how concentrated has the book actually been? ──────────────
  function concentrationDiagnostic(rebalBars) {
    const bookCorrs = [], uniCorrs = [], maxPairs = [];
    for (let i = firstI; i <= lastI; i += rebalBars) {
      const g = gridAt(i);
      if (!g) continue;
      const xs = crossSection(i);
      if (xs.length < MIN_ELIGIBLE) continue;
      const book = xs.slice(0, opts.positions).map(x => x.ticker);
      let sum = 0, cnt = 0, mx = -1;
      for (let a = 0; a < book.length; a++) for (let b = a + 1; b < book.length; b++) {
        const c = corrOf(g, book[a], book[b]);
        if (c === null) continue;
        sum += c; cnt++; if (c > mx) mx = c;
      }
      if (cnt) { bookCorrs.push(sum / cnt); maxPairs.push(mx); }
      // Universe average pairwise correlation, sampled for cost.
      let usum = 0, ucnt = 0;
      for (let a = 0; a < g.m; a += 3) for (let b = a + 3; b < g.m; b += 3) { usum += g.corr[a * g.m + b]; ucnt++; }
      if (ucnt) uniCorrs.push(usum / ucnt);
    }
    return {
      bookMean: stats.mean(bookCorrs), uniMean: stats.mean(uniCorrs),
      maxPairMean: stats.mean(maxPairs),
      pctBookAbove: bookCorrs.filter((v, k) => maxPairs[k] > 0.7).length / Math.max(1, bookCorrs.length),
    };
  }

  const diag = concentrationDiagnostic(10);
  console.log('='.repeat(118));
  console.log('DIAGNOSTIC — how correlated is the book we have been holding?');
  console.log('='.repeat(118));
  console.log(`  mean pairwise correlation WITHIN the ${opts.positions}-name book : ${diag.bookMean.toFixed(3)}`);
  console.log(`  mean pairwise correlation across the eligible universe   : ${diag.uniMean.toFixed(3)}`);
  console.log(`  mean of the MOST correlated pair in the book             : ${diag.maxPairMean.toFixed(3)}`);
  console.log(`  share of rebalances holding a pair correlated > 0.70     : ${(diag.pctBookAbove * 100).toFixed(1)}%`);
  console.log(`\n  If the book's internal correlation sits meaningfully above the universe average,`);
  console.log('  the ranking has been quietly concentrating risk — which is exactly the blind spot');
  console.log('  a sector cap would normally catch, and which no number before EXP-015 could see.');

  // ── Simulation ────────────────────────────────────────────────────────────
  function simulate({ rebalBars, buffer, variant, lo, hi }) {
    const loI = lo === undefined ? firstI : lo, hiI = hi === undefined ? lastI : hi;
    let sellNoFill = 0;
    let cash = 1.0;
    const held = new Map();
    const curve = [];
    let rejectedByCorr = 0, shortfall = 0, periods = 0;

    for (let i = loI; i <= hiI; i += rebalBars) {
      const execI = i + 1;
      const g = gridAt(i);
      const xs = crossSection(i);
      if (!g || xs.length < MIN_ELIGIBLE) continue;
      periods++;

      let exposure = 1;
      if (variant.regime === 0 && ihsgSMA[i] !== null && ihsg[i] < ihsgSMA[i]) exposure = 0;

      let pv = cash;
      for (const [t, u] of held) { const px = series.get(t).open[execI]; if (px > 0) pv += u * px; }

      const rank = new Map(xs.map((x, k) => [x.ticker, k]));
      const keep = [...held.keys()].filter(t => rank.has(t) && rank.get(t) < opts.positions * buffer)
        .sort((a, b) => rank.get(a) - rank.get(b)).slice(0, opts.positions);

      let target;
      if (exposure === 0) target = [];
      else {
        target = [...keep];
        for (const x of xs) {
          if (target.length >= opts.positions) break;
          if (target.includes(x.ticker)) continue;
          if (variant.corrCap !== null) {
            // Reject a candidate too correlated with anything already chosen —
            // the correlation-matrix stand-in for a sector cap.
            let clash = false;
            for (const t of target) {
              const c = corrOf(g, x.ticker, t);
              if (c !== null && c > variant.corrCap) { clash = true; break; }
            }
            if (clash) { rejectedByCorr++; continue; }
          }
          target.push(x.ticker);
        }
        if (target.length < opts.positions) shortfall++;
      }
      const targetSet = new Set(target);

      for (const [t, u] of [...held]) {
        if (targetSet.has(t)) continue;
        // A seller who cannot sell still owns the shares (review P0.1).
        const px = exec.sellFill(series.get(t), execI);
        if (px === null) { sellNoFill++; continue; }
        cash += u * px * (1 - SELL_COST);
        held.delete(t);
      }

      const toBuy = target.filter(t => !held.has(t));
      if (toBuy.length) {
        let weights;
        if (variant.hrp && target.length > 1) {
          // HRP over the selected names, using the precomputed correlations.
          const m = target.length;
          const cov = new Float64Array(m * m), dist = new Float64Array(m * m);
          for (let a = 0; a < m; a++) for (let b = 0; b < m; b++) {
            const c = a === b ? 1 : (corrOf(g, target[a], target[b]) ?? 0);
            const sa = g.sd[g.pos.get(target[a])] ?? 0, sb = g.sd[g.pos.get(target[b])] ?? 0;
            cov[a * m + b] = c * sa * sb;
            dist[a * m + b] = Math.sqrt(Math.max(0, 0.5 * (1 - c)));
          }
          const tree = linkageSingle(dist, m);
          const w = hrpWeights(cov, m, quasiDiag(tree));
          weights = new Map(target.map((t, k) => [t, w.get(k) ?? 1 / m]));
        } else {
          weights = new Map(target.map(t => [t, 1 / target.length]));
        }
        const investable = pv * exposure;
        for (const t of toBuy) {
          const px = series.get(t).open[execI];
          if (!(px > 0)) continue;
          const spend = Math.min(investable * weights.get(t), cash);
          if (spend <= 0) continue;
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
             rejectedByCorr, shortfallPct: periods ? shortfall / periods : 0 };
  }

  function score(variant, lo, hi) {
    const rows = CELLS.map(c => simulate({ rebalBars: c.rebalBars, buffer: c.buffer, variant, lo, hi }));
    const f = k => rows.map(r => r[k]).filter(Number.isFinite);
    return {
      cagr: stats.mean(f('cagr')), mdd: stats.mean(f('mdd')), retVol: stats.mean(f('retVol')),
      worstMDD: Math.max(...f('mdd')), shortfall: stats.mean(f('shortfallPct')),
    };
  }

  const midI = firstI + Math.floor((lastI - firstI) / 2);

  console.log('\n' + '='.repeat(118));
  console.log('FULL SAMPLE — mean across 9 cells');
  console.log('='.repeat(118));
  console.log('  variant                  CAGR     maxDD   worstMDD   ret/vol   under-filled rebalances');
  const full = {};
  for (const v of VARIANTS) {
    const s = score(v);
    full[v.key] = s;
    console.log(`  ${v.key.padEnd(20)} ${pct(s.cagr)}  ${pct(s.mdd)}   ${pct(s.worstMDD)}     ${s.retVol.toFixed(2).padStart(5)}       ${pct(s.shortfall, 1)}`);
  }

  console.log('\n' + '='.repeat(118));
  console.log('SPLIT-HALF — does it hold in both periods?');
  console.log('='.repeat(118));
  console.log('  variant                P1 CAGR   P1 maxDD   P1 r/v      P2 CAGR   P2 maxDD   P2 r/v');
  const split = {};
  for (const v of VARIANTS) {
    const a = score(v, firstI, midI), b = score(v, midI, lastI);
    split[v.key] = { p1: a, p2: b };
    console.log(`  ${v.key.padEnd(20)} ${pct(a.cagr)}   ${pct(a.mdd)}    ${a.retVol.toFixed(2).padStart(5)}      ${pct(b.cagr)}   ${pct(b.mdd)}    ${b.retVol.toFixed(2).padStart(5)}`);
  }

  // ── Composition check ─────────────────────────────────────────────────────
  // A mean of CAGRs across 9 cells does NOT compound: mean(full) need not equal
  // any function of mean(P1) and mean(P2). Before reading the tables above as a
  // finding, verify on a SINGLE cell that the full-period total return really is
  // the product of its two half-period total returns. If a single cell composes,
  // the apparent inconsistency is an averaging artifact, not a simulation bug.
  console.log('\n' + '='.repeat(118));
  console.log('COMPOSITION CHECK — single cell (biweekly, buffer x2), total returns not CAGRs');
  console.log('='.repeat(118));
  const cell = { rebalBars: 10, buffer: 2 };
  const toTotal = (cagr, days) => Math.pow(1 + cagr, days / TRADING_DAYS_YEAR) - 1;
  console.log('  variant                fullTotal   P1total   P2total   (1+P1)(1+P2)-1   gap');
  for (const v of VARIANTS) {
    const f = simulate({ ...cell, variant: v });
    const a = simulate({ ...cell, variant: v, lo: firstI, hi: midI });
    const b = simulate({ ...cell, variant: v, lo: midI, hi: lastI });
    const fT = toTotal(f.cagr, lastI - firstI);
    const aT = toTotal(a.cagr, midI - firstI);
    const bT = toTotal(b.cagr, lastI - midI);
    const comp = (1 + aT) * (1 + bT) - 1;
    console.log(`  ${v.key.padEnd(20)} ${pct(fT)}  ${pct(aT)}  ${pct(bT)}      ${pct(comp)}  ${pct(fT - comp)}`);
  }
  console.log('\n  A small gap is expected (the split runs re-enter from cash at the midpoint and pay');
  console.log('  entry costs the continuous run does not). A large gap would mean a simulation bug.');

  // Per-cell dispersion for the two headline variants — a mean hides an outlier.
  console.log('\n  PER-CELL full-sample CAGR (shows whether the mean is carried by one cell):');
  for (const key of ['EQUAL', 'HRP']) {
    const v = VARIANTS.find(x => x.key === key);
    const vals = CELLS.map(c => simulate({ rebalBars: c.rebalBars, buffer: c.buffer, variant: v }).cagr);
    const sorted = [...vals].sort((a, b) => a - b);
    console.log(`    ${key.padEnd(6)} ` + vals.map(x => pct(x, 1)).join('') +
      `   median ${pct(sorted[4], 1)}  spread ${pct(sorted[8] - sorted[0], 1)}`);
  }

  console.log('\n' + '='.repeat(118));
  console.log('MECHANICAL VERDICT');
  console.log('='.repeat(118));
  const base = full['EQUAL'];
  console.log(`\n  Reference (EQUAL + regime): CAGR ${pct(base.cagr)}, maxDD ${pct(base.mdd)}, ret/vol ${base.retVol.toFixed(2)}`);
  const winners = VARIANTS.filter(v => v.key !== 'EQUAL' && v.key !== 'EQUAL (no regime)')
    .map(v => ({ key: v.key, ...full[v.key] }))
    .filter(s => s.mdd < base.mdd && s.retVol >= base.retVol);
  if (!winners.length) {
    console.log('\n  No correlation-based variant improves BOTH drawdown and return-per-risk.');
  } else {
    winners.sort((a, b) => b.retVol - a.retVol).forEach(s => {
      const sp = split[s.key];
      const both = sp.p1.mdd < split['EQUAL'].p1.mdd && sp.p2.mdd < split['EQUAL'].p2.mdd;
      console.log(`    ${s.key.padEnd(20)} maxDD ${pct(s.mdd)} vs ${pct(base.mdd)}   ret/vol ${s.retVol.toFixed(2)} vs ${base.retVol.toFixed(2)}   better maxDD in BOTH halves: ${both ? 'YES' : 'no'}`);
    });
  }

  if (opts.json) {
    require('fs').writeFileSync(opts.json, JSON.stringify({ diagnostic: diag, full, split }, null, 2));
    console.log(`\n  JSON written to ${opts.json}`);
  }
  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
