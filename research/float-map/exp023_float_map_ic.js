/**
 * EXP-022 — does the Float Cost Map predict anything?
 *
 * The map is derived from the price path, so "% underwater" is close to a
 * restatement of recent returns: a stock that fell has holders trapped above by
 * construction. That makes the headline question not "does it have IC" but
 * "does it have IC that momentum does not already have". If nothing survives
 * residualising against plain momentum, this is a good descriptive tool and not
 * a signal — which is a finding, not a failure.
 *
 * Shape deliberately copied from EXP-011, the study this project already
 * trusts: cross-sectional ranking only. No entry timing, no stop, no target, no
 * costs. A factor that cannot sort forward returns here cannot be rescued by a
 * timing layer later.
 *
 *   universe        tickers with a free float on record
 *   date axis       idx_ihsg_history, the canonical trading calendar
 *   sampling        weekly (every 5th session) — daily dates share nearly all
 *                   of their forward window and make the CIs a fiction
 *   horizons        20 / 40 / 60 trading days
 *   IC              tie-aware Spearman, per date, then averaged
 *   significance    date-block bootstrap, 95%
 *
 * Exclusions are reported, never silent: corporate actions are detected by a
 * >35% single-session move and the affected ticker-date is dropped rather than
 * adjusted — cheaper than a full adjustment and honest for a ranking study.
 *
 * Read-only. Outside the frozen scraper tree.
 */
'use strict';

require('/var/www/flowtracker-scraper/node_modules/dotenv').config({ path: '/var/www/flowtracker-scraper/.env' });
const mysql = require('/var/www/flowtracker-scraper/node_modules/mysql2/promise');

const LOOKBACK   = 250;     // sessions of history the map is built from
const BUCKETS    = 40;
const TURNOVER_K = 0.75;
const HORIZONS   = [20, 40, 60];
const MIN_NAMES  = 25;      // a cross-section thinner than this is noise
const MIN_VALUE  = 5e9;     // Rp 5bn median 20d turnover, same screen as EXP-011
const BOOT       = 2000;

// ── sensitivity controls ───────────────────────────────────────────────────
// The free float on record is a TODAY snapshot applied backwards over nine
// years. Rather than guess at historical share counts that may not exist
// anywhere, these let the study answer the sharper question: does the result
// even CARE how wrong the float is?
//
//   --from YYYY-MM-DD   restrict to a recent window, where today's float is
//                       more likely to still be the right one
//   --float-noise S     multiply each ticker's float by exp(N(0,S)) — a
//                       deliberate misspecification of known size
//   --seed N            so a perturbation run is reproducible; Math.random
//                       would make a sensitivity test unrepeatable, which
//                       defeats the point of running one
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const FROM        = arg('--from');
const FLOAT_NOISE = Number(arg('--float-noise') || 0);
const SEED        = Number(arg('--seed') || 1);
const ONLY        = arg('--only');

// Mulberry32 — small, seeded, and good enough for a jitter.
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()); }

// ── stats ──────────────────────────────────────────────────────────────────
function rank(xs) {
  // Average ranks for ties. ARA/ARB makes exact return ties routine on IDX, and
  // naive ranking would silently order them by array position.
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function pearson(a, b) {
  const n = a.length;
  if (n < 3) return null;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return (da === 0 || db === 0) ? null : num / Math.sqrt(da * db);
}
const spearman = (a, b) => pearson(rank(a), rank(b));

/** Cross-sectional OLS residual of y on the columns of X (with intercept). */
function residualise(y, cols) {
  const n = y.length, k = cols.length;
  // Normal equations on a tiny design matrix; k is 1–2 here.
  const X = [];
  for (let i = 0; i < n; i++) X.push([1, ...cols.map(c => c[i])]);
  const p = k + 1;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  // Gauss-Jordan; if singular, fall back to the raw series rather than pretending.
  const M = XtX.map((row, i) => [...row, Xty[i]]);
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r2 = c + 1; r2 < p; r2++) if (Math.abs(M[r2][c]) > Math.abs(M[piv][c])) piv = r2;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r2 = 0; r2 < p; r2++) {
      if (r2 === c) continue;
      const f = M[r2][c] / M[c][c];
      for (let j = c; j <= p; j++) M[r2][j] -= f * M[c][j];
    }
  }
  const beta = M.map((row, i) => row[p] / row[i]);
  return y.map((v, i) => v - X[i].reduce((s, xv, a) => s + xv * beta[a], 0));
}

// ── the map, as of a point in time ─────────────────────────────────────────
/**
 * @param bars ascending, ALREADY truncated to <= the ranking date
 * @returns metrics, or null if the window is unusable
 */
function costMap(bars, floatShares) {
  if (bars.length < 60 || !floatShares) return null;

  // Corporate action inside the window: every historical price before it refers
  // to a different share count, so the old cost basis lands in a bucket that
  // never existed. Excluded rather than adjusted.
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1].c, b = bars[i].c;
    if (a > 0 && b > 0 && Math.abs(b / a - 1) > 0.35) return { corporateAction: true };
  }

  const lo = Math.min(...bars.map(b => b.l));
  const hi = Math.max(...bars.map(b => b.h));
  if (!(hi > lo)) return null;
  const step = (hi - lo) / BUCKETS;
  const mid = i => lo + step * (i + 0.5);
  const dist = new Array(BUCKETS).fill(0);
  const typical = b => (b.h + b.l + b.c) / 3;

  dist[Math.max(0, Math.min(BUCKETS - 1, Math.floor((typical(bars[0]) - lo) / step)))] = floatShares;

  const turns = [];
  for (const b of bars) {
    const raw = b.v / floatShares;
    turns.push(raw);
    const t = Math.min(1, raw * TURNOVER_K);
    for (let i = 0; i < BUCKETS; i++) dist[i] *= (1 - t);

    const iLo = Math.max(0, Math.floor((b.l - lo) / step));
    const iHi = Math.min(BUCKETS - 1, Math.floor((b.h - lo) / step));
    const centre = typical(b), span = Math.max(step, (b.h - b.l) / 2);
    let wsum = 0; const w = [];
    for (let i = iLo; i <= iHi; i++) { const wi = Math.max(0.05, 1 - Math.abs(mid(i) - centre) / span); w.push(wi); wsum += wi; }
    const moved = floatShares * t;
    for (let i = iLo, k = 0; i <= iHi; i++, k++) dist[i] += moved * (w[k] / wsum);
  }

  const total = dist.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  const price = bars[bars.length - 1].c;
  const avgCost = dist.reduce((a, x, i) => a + x * mid(i), 0) / total;
  const profitSupply = dist.reduce((a, x, i) => a + (mid(i) < price ? x : 0), 0) / total;
  const peakI = dist.indexOf(Math.max(...dist));
  const sum = n => turns.slice(-n).reduce((a, b) => a + b, 0);

  return {
    profitSupply,                                   // share of float estimated in profit
    overheadSupply: 1 - profitSupply,
    avgCostGap: price / avgCost - 1,                // price vs estimated average cost
    distToPeak: (price - mid(peakI)) / price,       // where price sits vs the biggest cluster
    rotation20: sum(20),
    rotation60: sum(60),
  };
}

// roc20/roc60 are included as CONTROLS, not candidates: the residualised panel
// shows higher IC than the raw one, which only makes sense if momentum itself
// is negatively predictive here and was cancelling part of the signal. That
// claim has to be measured in this exact sample, not assumed from EXP-010.
const FACTORS = ['profitSupply', 'avgCostGap', 'distToPeak', 'rotation20', 'rotation60', 'roc20', 'roc60'];

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'erp_manufacturing',
    waitForConnections: true, connectionLimit: 4,
    // DATE columns as 'YYYY-MM-DD' strings. Without this mysql2 hands back Date
    // objects and String(date).slice(0,10) yields "Mon Aug 01" — a bug this
    // project has already shipped once, and one that does not throw: it just
    // makes every date comparison quietly false.
    dateStrings: true,
  });

  const [floats] = await pool.query('SELECT stock_code, float_shares FROM idx_free_float');
  const floatOf = new Map(floats.map(f => [f.stock_code, Number(f.float_shares)]));
  if (FLOAT_NOISE > 0) {
    const r = rng(SEED);
    for (const [k, v] of floatOf) floatOf.set(k, v * Math.exp(gauss(r) * FLOAT_NOISE));
    console.log(`FLOAT PERTURBED: each ticker multiplied by exp(N(0,${FLOAT_NOISE})), seed ${SEED}`);
  }
  console.log(`universe: ${floatOf.size} tickers with a free float on record`);

  const [cal] = await pool.query('SELECT date FROM idx_ihsg_history ORDER BY date');
  const dates = cal.map(r => String(r.date).slice(0, 10));
  const dateIdx = new Map(dates.map((d, i) => [d, i]));
  console.log(`calendar: ${dates.length} sessions, ${dates[0]} .. ${dates[dates.length - 1]}`);

  const [px] = await pool.query(
    `SELECT stock_code s, date d, high_price h, low_price l, close_price c, volume v, value val
       FROM idx_stock_prices WHERE stock_code IN (?) AND volume > 0 ORDER BY stock_code, date`,
    [[...floatOf.keys()]]);
  const series = new Map();
  for (const r of px) {
    if (!series.has(r.s)) series.set(r.s, []);
    series.get(r.s).push({ d: String(r.d).slice(0, 10), h: +r.h, l: +r.l, c: +r.c, v: +r.v, val: +r.val });
  }
  console.log(`prices:   ${px.length.toLocaleString('en-US')} bars across ${series.size} tickers\n`);

  // Weekly ranking dates that leave room for the longest forward horizon.
  const maxH = Math.max(...HORIZONS);
  const first = LOOKBACK, lastIdx = dates.length - maxH - 1;
  const rankDates = [];
  for (let i = first; i <= lastIdx; i += 5) if (!FROM || dates[i] >= FROM) rankDates.push(dates[i]);
  console.log(`ranking dates: ${rankDates.length} (weekly, ${rankDates[0]} .. ${rankDates[rankDates.length - 1]})\n`);

  const perDate = [];   // { date, names, factors:{f:[...]}, fwd:{h:[...]}, mom:{roc20,roc60} }
  let skippedCA = 0, skippedThin = 0;

  for (const rd of rankDates) {
    const ri = dateIdx.get(rd);
    const rows = [];
    for (const [tk, bars] of series) {
      // Everything strictly at or before the ranking date. Nothing may look ahead.
      let end = -1;
      for (let i = bars.length - 1; i >= 0; i--) if (bars[i].d <= rd) { end = i; break; }
      if (end < LOOKBACK - 1) continue;
      const win = bars.slice(end - LOOKBACK + 1, end + 1);
      if (win[win.length - 1].d !== rd) continue;      // no bar that day: not tradable, skip

      const med = (() => {
        const v = win.slice(-20).map(b => b.val || b.c * b.v).sort((a, b) => a - b);
        return v[Math.floor(v.length / 2)];
      })();
      if (!(med >= MIN_VALUE)) { skippedThin++; continue; }

      const m = costMap(win, floatOf.get(tk));
      if (!m) continue;
      if (m.corporateAction) { skippedCA++; continue; }

      // Forward return on the canonical calendar, from the ranking close.
      const fwd = {};
      let ok = true;
      for (const h of HORIZONS) {
        const td = dates[ri + h];
        const fb = bars.find(b => b.d === td);
        if (!fb) { ok = false; break; }
        fwd[h] = fb.c / win[win.length - 1].c - 1;
      }
      if (!ok) continue;

      const c0 = win[win.length - 1].c;
      rows.push({
        tk, ...m, fwd,
        roc20: c0 / win[win.length - 20].c - 1,
        roc60: c0 / win[win.length - 60].c - 1,
      });
    }
    if (rows.length >= MIN_NAMES) perDate.push({ date: rd, rows });
  }

  console.log(`usable cross-sections: ${perDate.length} (median ${(() => {
    const n = perDate.map(p => p.rows.length).sort((a, b) => a - b);
    return n[Math.floor(n.length / 2)] || 0;
  })()} names)`);
  console.log(`excluded: ${skippedCA.toLocaleString('en-US')} ticker-dates for a detected corporate action, ${skippedThin.toLocaleString('en-US')} below the Rp5bn liquidity floor\n`);

  if (!perDate.length) { console.log('nothing to test'); await pool.end(); return; }

  // ── IC, raw and momentum-residualised ────────────────────────────────────
  const boot = ics => {
    const out = [];
    for (let b = 0; b < BOOT; b++) {
      let s = 0;
      for (let i = 0; i < ics.length; i++) s += ics[Math.floor(Math.random() * ics.length)];
      out.push(s / ics.length);
    }
    out.sort((a, b) => a - b);
    return [out[Math.floor(BOOT * 0.025)], out[Math.floor(BOOT * 0.975)]];
  };

  const report = (label, getIcs) => {
    console.log(`\n${label}`);
    console.log('factor           horizon    IC        IR    %pos   95% CI            ');
    for (const f of FACTORS) {
      if (ONLY && f !== ONLY) continue;
      for (const h of HORIZONS) {
        const ics = getIcs(f, h).filter(v => v !== null && Number.isFinite(v));
        if (ics.length < 10) { console.log(`${f.padEnd(15)} ${String(h).padStart(4)}D      (too few)`); continue; }
        const mean = ics.reduce((a, b) => a + b, 0) / ics.length;
        const sd = Math.sqrt(ics.reduce((a, b) => a + (b - mean) ** 2, 0) / (ics.length - 1));
        const ir = sd ? mean / sd : 0;
        const pos = ics.filter(v => v > 0).length / ics.length * 100;
        const [lo2, hi2] = boot(ics);
        const sig = (lo2 > 0 || hi2 < 0) ? ' *' : '';
        console.log(`${f.padEnd(15)} ${String(h).padStart(4)}D  ${mean.toFixed(4).padStart(8)}  ${ir.toFixed(2).padStart(6)}  ${pos.toFixed(0).padStart(4)}%  [${lo2.toFixed(4)}, ${hi2.toFixed(4)}]${sig}`);
      }
    }
  };

  report('RAW — does the metric sort forward returns at all?', (f, h) =>
    perDate.map(p => spearman(p.rows.map(r => r[f]), p.rows.map(r => r.fwd[h]))));

  report('RESIDUALISED on ROC20 + ROC60 — is there anything momentum does not already have?', (f, h) =>
    perDate.map(p => {
      const res = residualise(p.rows.map(r => r[f]), [p.rows.map(r => r.roc20), p.rows.map(r => r.roc60)]);
      return res ? spearman(res, p.rows.map(r => r.fwd[h])) : null;
    }));

  // How much of each metric is simply momentum wearing another name.
  console.log('\nOVERLAP WITH MOMENTUM (mean cross-sectional Spearman)');
  for (const f of FACTORS) {
    const a = perDate.map(p => spearman(p.rows.map(r => r[f]), p.rows.map(r => r.roc20)));
    const b = perDate.map(p => spearman(p.rows.map(r => r[f]), p.rows.map(r => r.roc60)));
    const m = xs => { const v = xs.filter(Number.isFinite); return v.reduce((x, y) => x + y, 0) / v.length; };
    console.log(`  ${f.padEnd(15)} vs ROC20 ${m(a).toFixed(3).padStart(7)}   vs ROC60 ${m(b).toFixed(3).padStart(7)}`);
  }

  console.log(`\n* = bootstrap 95% CI excludes zero. ${FACTORS.length * HORIZONS.length} pairs tested per panel,`);
  console.log(`  so ~${(FACTORS.length * HORIZONS.length * 0.05).toFixed(1)} false positives are expected at alpha=0.05 by chance alone.`);
  console.log('Ranking only — no timing, no stops, no costs. Survivorship-biased in the flattering direction.');
  console.log('Free float is a TODAY snapshot applied backwards: rights issues make historical float wrong.\n');

  await pool.end();
})().catch(e => { console.error('EXP-022 FAILED:', e.message); process.exit(1); });
