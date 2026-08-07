/**
 * Nightly Float Cost Map for the whole universe.
 *
 * THE HEADLINE NUMBER IS THE RESIDUAL, NOT THE RAW ONE. EXP-2026-08-07-023
 * measured avgCostGap raw at IC 0.0075 over 414 cross-sections — indistinguishable
 * from nothing — and at 0.0378 (IR 0.23) once ROC20 and ROC60 are regressed out.
 * The raw value overlaps 0.61 with 60-day momentum, so a screen showing it is
 * showing the price path with extra steps.
 *
 * That is why this runs over the WHOLE cross-section in one pass rather than one
 * ticker at a time: a residual only exists relative to the other names on the
 * same day. A per-ticker endpoint could not produce the number that matters.
 *
 * Writes two things:
 *   idx_float_map_daily                          history, so this can be studied later
 *   /var/www/flowtracker/public/float-map.json   what the page reads
 *
 * The JSON is a static file on purpose. The frontend has no database client and
 * the scraper is frozen for its burn-in, so neither gets touched; a snapshot
 * that changes once a day does not need a live query.
 *
 * Read-only against everything the IDX engine owns.
 */
'use strict';

require('/var/www/flowtracker-scraper/node_modules/dotenv').config({ path: '/var/www/flowtracker-scraper/.env' });
const mysql = require('/var/www/flowtracker-scraper/node_modules/mysql2/promise');
const fs = require('fs');
const path = require('path');

/**
 * MODEL IDENTITY. Change any constant below and this string must change with
 * it, because the snapshot carries it and a stored number whose model nobody
 * can name is not reproducible. Bump the version for a behavioural change;
 * modelCommit pins the exact source.
 *
 * V1: proportional-replacement chip distribution, 250-session lookback,
 *     40 buckets, turnover coefficient 0.75, typical-price kernel,
 *     corporate actions detected (>35% single session) and EXCLUDED.
 */
const MODEL_VERSION = 'FLOAT_MAP_V1';
const LOOKBACK = 250, BUCKETS = 40, TURNOVER_K = 0.75;

/**
 * The commit these scripts were deployed from, written by sync_research.sh.
 * Null rather than 'unknown' when absent: the page shows it as a warning, and a
 * plausible-looking placeholder is worse than an obvious hole.
 */
function modelCommit() {
  try { return fs.readFileSync(__dirname + '/.model-commit', 'utf8').trim() || null; }
  catch { return null; }
}
// NOT public/. Next 16 snapshots that directory at build time, so a file
// written afterwards 404s until the next rebuild — verified, not assumed. A
// route handler reads this path at request time instead, which keeps the
// nightly job decoupled from the frontend build entirely.
const OUT_JSON = process.env.FLOAT_MAP_JSON || '/var/www/flowtracker/data/float-map.json';

const DDL = `
CREATE TABLE IF NOT EXISTS idx_float_map_daily (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_date DATE NOT NULL,
  stock_code VARCHAR(12) NOT NULL,
  price DECIMAL(20,4) NOT NULL,
  avg_cost DECIMAL(20,4) NOT NULL,
  avg_cost_gap DECIMAL(12,6) NOT NULL,
  avg_cost_gap_resid DECIMAL(12,6) NULL,
  profit_supply DECIMAL(12,6) NOT NULL,
  dist_to_peak DECIMAL(12,6) NOT NULL,
  peak_low DECIMAL(20,4) NOT NULL,
  peak_high DECIMAL(20,4) NOT NULL,
  rotation20 DECIMAL(12,6) NOT NULL,
  rotation60 DECIMAL(12,6) NOT NULL,
  float_pct DECIMAL(8,4) NOT NULL,
  confidence TINYINT NOT NULL,
  distribution_json TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_day (session_date, stock_code)
)`;

const typical = b => (b.h + b.l + b.c) / 3;

function costMap(bars, floatShares) {
  if (bars.length < 60 || !floatShares) return null;
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1].c, b = bars[i].c;
    if (a > 0 && b > 0 && Math.abs(b / a - 1) > 0.35) return { corporateAction: true };
  }
  const lo = Math.min(...bars.map(b => b.l)), hi = Math.max(...bars.map(b => b.h));
  if (!(hi > lo)) return null;
  const step = (hi - lo) / BUCKETS, mid = i => lo + step * (i + 0.5);
  const dist = new Array(BUCKETS).fill(0);
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
    const w = []; let wsum = 0;
    for (let i = iLo; i <= iHi; i++) { const wi = Math.max(0.05, 1 - Math.abs(mid(i) - centre) / span); w.push(wi); wsum += wi; }
    const moved = floatShares * t;
    for (let i = iLo, k = 0; i <= iHi; i++, k++) dist[i] += moved * (w[k] / wsum);
  }
  const total = dist.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  const price = bars[bars.length - 1].c;
  const avgCost = dist.reduce((a, x, i) => a + x * mid(i), 0) / total;
  const peakI = dist.indexOf(Math.max(...dist));
  const sum = n => turns.slice(-n).reduce((a, b) => a + b, 0);
  return {
    price, avgCost,
    avgCostGap: price / avgCost - 1,
    profitSupply: dist.reduce((a, x, i) => a + (mid(i) < price ? x : 0), 0) / total,
    distToPeak: (price - mid(peakI)) / price,
    peakLow: mid(peakI) - step / 2, peakHigh: mid(peakI) + step / 2,
    rotation20: sum(20), rotation60: sum(60),
    roc20: price / bars[bars.length - 20].c - 1,
    roc60: price / bars[bars.length - 60].c - 1,
    // Coarse buckets for the chart; the full 40 would be noise on screen.
    bars: (() => {
      const out = [];
      for (let i = 0; i < BUCKETS; i += 2) {
        const s = (dist[i] + (dist[i + 1] || 0)) / total;
        if (s >= 0.005) out.push({ price: Math.round(mid(i)), share: +(s * 100).toFixed(1) });
      }
      return out.reverse();
    })(),
  };
}

/** Cross-sectional OLS residual of y on the given columns. */
function residualise(y, cols) {
  const n = y.length, p = cols.length + 1;
  const X = y.map((_, i) => [1, ...cols.map(c => c[i])]);
  const A = Array.from({ length: p }, () => new Array(p + 1).fill(0));
  for (let i = 0; i < n; i++)
    for (let a = 0; a < p; a++) {
      A[a][p] += X[i][a] * y[i];
      for (let b = 0; b < p; b++) A[a][b] += X[i][a] * X[i][b];
    }
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let j = c; j <= p; j++) A[r][j] -= f * A[c][j];
    }
  }
  const beta = A.map((row, i) => row[p] / row[i]);
  return y.map((v, i) => v - X[i].reduce((s, xv, a) => s + xv * beta[a], 0));
}

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'erp_manufacturing',
    waitForConnections: true, connectionLimit: 4, dateStrings: true,
  });
  await pool.query(DDL);

  const [floats] = await pool.query('SELECT stock_code, float_pct, float_shares FROM idx_free_float');
  const floatOf = new Map(floats.map(f => [f.stock_code, { shares: Number(f.float_shares), pct: Number(f.float_pct) }]));

  const [[cal]] = await pool.query('SELECT MAX(date) d FROM idx_stock_prices');
  const session = cal.d;
  const [[bstale]] = await pool.query('SELECT MAX(date) d FROM idx_broker_summary');
  const [[ffAsOf]] = await pool.query('SELECT MAX(fetched_at) d FROM idx_free_float');
  const brokerLag = Math.round((new Date(session) - new Date(bstale.d)) / 86400000);

  const [px] = await pool.query(
    `SELECT stock_code s, date d, high_price h, low_price l, close_price c, volume v
       FROM idx_stock_prices WHERE stock_code IN (?) AND volume > 0 ORDER BY stock_code, date`,
    [[...floatOf.keys()]]);
  const series = new Map();
  for (const r of px) {
    if (!series.has(r.s)) series.set(r.s, []);
    series.get(r.s).push({ d: r.d, h: +r.h, l: +r.l, c: +r.c, v: +r.v });
  }

  const rows = [];
  let skippedCA = 0, skippedShort = 0;
  for (const [tk, bars] of series) {
    if (bars.length < LOOKBACK) { skippedShort++; continue; }
    const win = bars.slice(-LOOKBACK);
    if (win[win.length - 1].d !== session) continue;   // no bar today: not tradable
    const m = costMap(win, floatOf.get(tk).shares);
    if (!m) continue;
    if (m.corporateAction) { skippedCA++; continue; }
    rows.push({ tk, floatPct: floatOf.get(tk).pct, ...m });
  }

  // The residual — the only number EXP-023 found predictive.
  const resid = rows.length >= 25
    ? residualise(rows.map(r => r.avgCostGap), [rows.map(r => r.roc20), rows.map(r => r.roc60)])
    : null;
  rows.forEach((r, i) => { r.avgCostGapResid = resid ? resid[i] : null; });

  // Rank on the residual, high = price furthest above its cost base once
  // momentum is removed.
  const sorted = [...rows].sort((a, b) => (b.avgCostGapResid ?? -9) - (a.avgCostGapResid ?? -9));
  sorted.forEach((r, i) => { r.rank = i + 1; });

  const confidence = 25 + 20 + 20 + (brokerLag <= 2 ? 20 : 0) + 15;   // CA excluded, not adjusted

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const r of rows) {
      await conn.query(
        `INSERT INTO idx_float_map_daily
          (session_date, stock_code, price, avg_cost, avg_cost_gap, avg_cost_gap_resid,
           profit_supply, dist_to_peak, peak_low, peak_high, rotation20, rotation60,
           float_pct, confidence, distribution_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE price=VALUES(price), avg_cost=VALUES(avg_cost),
           avg_cost_gap=VALUES(avg_cost_gap), avg_cost_gap_resid=VALUES(avg_cost_gap_resid),
           profit_supply=VALUES(profit_supply), dist_to_peak=VALUES(dist_to_peak),
           peak_low=VALUES(peak_low), peak_high=VALUES(peak_high),
           rotation20=VALUES(rotation20), rotation60=VALUES(rotation60),
           float_pct=VALUES(float_pct), confidence=VALUES(confidence),
           distribution_json=VALUES(distribution_json)`,
        [session, r.tk, r.price, r.avgCost, r.avgCostGap, r.avgCostGapResid,
         r.profitSupply, r.distToPeak, r.peakLow, r.peakHigh, r.rotation20, r.rotation60,
         r.floatPct, confidence, JSON.stringify(r.bars)]);
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }

  const payload = {
    // FRESHNESS CONTRACT. A snapshot that stops being regenerated still
    // returns HTTP 200 and still looks like today's ranking, which is far more
    // dangerous than a missing file — so every input carries its own date and
    // the page decides whether to trust the whole thing.
    modelVersion: MODEL_VERSION, modelCommit: modelCommit(), turnoverCoefficient: TURNOVER_K,
    session, generatedAt: new Date().toISOString(),
    priceMaxDate: session,
    brokerMaxDate: bstale.d,
    freeFloatAsOf: ffAsOf.d ? new Date(ffAsOf.d).toISOString() : null,
    confidence, brokerLagDays: brokerLag,
    universe: rows.length, skippedCorporateAction: skippedCA, skippedShortHistory: skippedShort,
    // Stated in the payload so the page cannot present the raw number as the finding.
    evidence: {
      experiment: 'EXP-2026-08-07-023',
      rawIC60D: 0.0075, residualIC60D: 0.0378, residualIR: 0.23,
      note: 'Raw avgCostGap is indistinguishable from zero and overlaps 0.61 with 60-day momentum. Only the momentum-residualised value showed forward predictiveness, and at a size EXP-011 already called untradeable.',
    },
    rows: sorted.map(r => ({
      ticker: r.tk, rank: r.rank,
      price: Math.round(r.price), avgCost: Math.round(r.avgCost),
      avgCostGap: +(r.avgCostGap * 100).toFixed(2),
      avgCostGapResid: r.avgCostGapResid === null ? null : +(r.avgCostGapResid * 100).toFixed(2),
      profitSupply: +(r.profitSupply * 100).toFixed(1),
      overheadSupply: +((1 - r.profitSupply) * 100).toFixed(1),
      peakLow: Math.round(r.peakLow), peakHigh: Math.round(r.peakHigh),
      rotation20: +(r.rotation20 * 100).toFixed(0), rotation60: +(r.rotation60 * 100).toFixed(0),
      floatPct: +r.floatPct.toFixed(1),
      dist: r.bars,
    })),
  };

  // Written atomically: a page that fetches a half-written file shows garbage
  // and has no way to tell.
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  const tmp = OUT_JSON + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, OUT_JSON);

  console.log(`session ${session} · ${rows.length} tickers · confidence ${confidence}/100`);
  console.log(`skipped: ${skippedCA} corporate action, ${skippedShort} short history · broker feed ${brokerLag}d behind`);
  console.log(`wrote ${OUT_JSON} (${(fs.statSync(OUT_JSON).size / 1024).toFixed(0)} KB)`);
  await pool.end();
})().catch(e => { console.error('FLOAT MAP DAILY FAILED:', e.message); process.exit(1); });
