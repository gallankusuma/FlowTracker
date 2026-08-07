/**
 * Nightly Float Cost Map for the whole universe.
 *
 * THE HEADLINE NUMBER IS THE RESIDUAL, NOT THE RAW ONE. EXP-2026-08-07-023
 * measured avgCostGap raw at IC 0.0075 over 414 cross-sections — indistinguishable
 * from nothing — and at 0.0378 (IR 0.23) once ROC20 and ROC60 are regressed out.
 * That is why this runs over the WHOLE cross-section in one pass: a residual
 * only exists relative to the other names on the same day.
 *
 * The model itself lives in model.js so the generator and the IC experiment
 * cannot drift, and so it can be tested as pure arithmetic (test_model.js).
 *
 * Writes:
 *   idx_float_map_daily                        history, keyed by MODEL IDENTITY
 *   /var/www/flowtracker/data/float-map.json   what the page reads
 */
'use strict';

require('/var/www/flowtracker-scraper/node_modules/dotenv').config({ path: '/var/www/flowtracker-scraper/.env' });
const mysql = require('/var/www/flowtracker-scraper/node_modules/mysql2/promise');
const fs = require('fs');
const path = require('path');
const M = require('./model');

const OUT_JSON = process.env.FLOAT_MAP_JSON || '/var/www/flowtracker/data/float-map.json';

/** Beyond this, a stored free float is too old to build a map on. */
const FLOAT_MAX_AGE_DAYS = 10;

function modelCommit() {
  try { return fs.readFileSync(__dirname + '/.model-commit', 'utf8').trim() || null; }
  catch { return null; }
}

/**
 * History is keyed by MODEL IDENTITY, not just by day.
 *
 * Without model_version in the key, publishing FLOAT_MAP_V2 with a different
 * turnover coefficient would silently overwrite V1's rows via ON DUPLICATE KEY
 * UPDATE, and the table could no longer say which model produced which number.
 * A new model must not rewrite the evidence of the old one — the same rule the
 * burn-in protocol versioning exists to enforce.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS idx_float_map_daily (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_date DATE NOT NULL,
  stock_code VARCHAR(12) NOT NULL,
  model_version VARCHAR(32) NOT NULL,
  model_commit VARCHAR(40) NULL,
  turnover_coefficient DECIMAL(6,4) NOT NULL,
  generated_at TIMESTAMP NOT NULL,
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
  float_as_of TIMESTAMP NULL,
  seed_remaining DECIMAL(12,8) NOT NULL,
  confidence_data TINYINT NOT NULL,
  confidence_convergence TINYINT NOT NULL,
  confidence TINYINT NOT NULL,
  distribution_json TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_day_model (session_date, stock_code, model_version)
)`;

/** Additive upgrades for a table created by the first version of this script. */
const MIGRATIONS = [
  ['model_version', "ADD COLUMN model_version VARCHAR(32) NOT NULL DEFAULT 'FLOAT_MAP_V1' AFTER stock_code"],
  ['model_commit', 'ADD COLUMN model_commit VARCHAR(40) NULL AFTER model_version'],
  ['turnover_coefficient', 'ADD COLUMN turnover_coefficient DECIMAL(6,4) NOT NULL DEFAULT 0.75 AFTER model_commit'],
  ['generated_at', 'ADD COLUMN generated_at TIMESTAMP NULL AFTER turnover_coefficient'],
  ['float_as_of', 'ADD COLUMN float_as_of TIMESTAMP NULL AFTER float_pct'],
  ['seed_remaining', 'ADD COLUMN seed_remaining DECIMAL(12,8) NOT NULL DEFAULT 0 AFTER float_as_of'],
  ['confidence_data', 'ADD COLUMN confidence_data TINYINT NOT NULL DEFAULT 0 AFTER seed_remaining'],
  ['confidence_convergence', 'ADD COLUMN confidence_convergence TINYINT NOT NULL DEFAULT 0 AFTER confidence_data'],
];

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'erp_manufacturing',
    waitForConnections: true, connectionLimit: 4, dateStrings: true,
  });
  const db = process.env.DB_NAME || 'erp_manufacturing';
  await pool.query(DDL);
  for (const [col, ddl] of MIGRATIONS) {
    const [[c]] = await pool.query(
      `SELECT COUNT(*) n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=? AND TABLE_NAME='idx_float_map_daily' AND COLUMN_NAME=?`, [db, col]);
    if (!Number(c.n)) await pool.query(`ALTER TABLE idx_float_map_daily ${ddl}`);
  }
  // Replace the old day-only key so a second model cannot overwrite the first.
  const [[k]] = await pool.query(
    `SELECT COUNT(*) n FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=? AND TABLE_NAME='idx_float_map_daily' AND INDEX_NAME='uq_day_model'`, [db]);
  if (!Number(k.n)) {
    await pool.query('ALTER TABLE idx_float_map_daily DROP INDEX uq_day').catch(() => {});
    await pool.query('ALTER TABLE idx_float_map_daily ADD UNIQUE KEY uq_day_model (session_date, stock_code, model_version)');
  }

  // ── inputs, each with its own date ────────────────────────────────────────
  const [[cal]] = await pool.query('SELECT MAX(date) d FROM idx_stock_prices');
  const session = cal.d;
  const [[bstale]] = await pool.query('SELECT MAX(date) d FROM idx_broker_summary');

  // FRESHNESS ON THE EXCHANGE CALENDAR, not on weekdays. The page was counting
  // Monday-to-Friday, which turns every IDX holiday into a false stale.
  const [[bl]] = await pool.query(
    'SELECT COUNT(*) n FROM idx_ihsg_history WHERE date > ? AND date <= ?', [bstale.d, session]);
  const brokerLagSessions = Number(bl.n);

  const [floats] = await pool.query(
    `SELECT stock_code, float_pct, float_shares, fetch_status, last_success_at,
            DATEDIFF(NOW(), last_success_at) age_days
       FROM idx_free_float`).catch(async () => {
    // Older table shape, before per-ticker status existed.
    const [rows] = await pool.query(
      `SELECT stock_code, float_pct, float_shares, 'VALID' fetch_status,
              fetched_at last_success_at, DATEDIFF(NOW(), fetched_at) age_days FROM idx_free_float`);
    return [rows];
  });

  const floatOf = new Map(floats.map(f => [f.stock_code, {
    shares: Number(f.float_shares), pct: Number(f.float_pct),
    status: f.fetch_status || 'VALID',
    asOf: f.last_success_at, ageDays: Number(f.age_days ?? 999),
  }]));

  // PER-TICKER FRESHNESS. MAX(fetched_at) across the table said CURRENT when a
  // single ticker refreshed and ninety-eight carried month-old numbers.
  const coverage = { fresh: 0, stale: 0, rejected: 0, oldestFreshAsOf: null };
  for (const v of floatOf.values()) {
    if (v.status !== 'VALID') coverage.rejected++;
    else if (v.ageDays > FLOAT_MAX_AGE_DAYS) coverage.stale++;
    else {
      coverage.fresh++;
      if (!coverage.oldestFreshAsOf || v.asOf < coverage.oldestFreshAsOf) coverage.oldestFreshAsOf = v.asOf;
    }
  }

  const [px] = await pool.query(
    `SELECT stock_code s, date d, high_price h, low_price l, close_price c, volume v
       FROM idx_stock_prices WHERE stock_code IN (?) AND volume > 0 ORDER BY stock_code, date`,
    [[...floatOf.keys()]]);
  const series = new Map();
  for (const r of px) {
    if (!series.has(r.s)) series.set(r.s, []);
    series.get(r.s).push({ d: r.d, h: +r.h, l: +r.l, c: +r.c, v: +r.v });
  }

  // ── the map, per ticker ──────────────────────────────────────────────────
  const rows = [];
  const skipped = {};
  for (const [tk, allBars] of series) {
    const ff = floatOf.get(tk);
    if (ff.status !== 'VALID') { skipped.floatInvalid = (skipped.floatInvalid || 0) + 1; continue; }
    if (ff.ageDays > FLOAT_MAX_AGE_DAYS) { skipped.floatStale = (skipped.floatStale || 0) + 1; continue; }
    if (allBars.length < M.LOOKBACK) { skipped.shortHistory = (skipped.shortHistory || 0) + 1; continue; }
    const win = allBars.slice(-M.LOOKBACK);
    if (win[win.length - 1].d !== session) { skipped.noBarToday = (skipped.noBarToday || 0) + 1; continue; }

    const m = M.costMap(win, ff.shares);
    if (m.error) { skipped[m.error] = (skipped[m.error] || 0) + 1; continue; }

    const conf = M.confidenceFor({
      seedRemaining: m.seedRemaining, bars: win.length,
      floatStatus: ff.status, floatAgeDays: ff.ageDays, brokerLagSessions,
    });
    rows.push({ tk, ff, m, conf, dist: M.chartBuckets(m) });
  }

  const resid = M.residualise(rows.map(r => r.m.avgCostGap),
    [rows.map(r => r.m.roc20), rows.map(r => r.m.roc60)]);
  rows.forEach((r, i) => { r.residual = resid ? resid[i] : null; });

  const sorted = [...rows].sort((a, b) => (b.residual ?? -9) - (a.residual ?? -9));
  sorted.forEach((r, i) => { r.rank = i + 1; });

  const version = M.MODEL_VERSION, commit = modelCommit(), generatedAt = new Date();

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const r of rows) {
      await conn.query(
        `INSERT INTO idx_float_map_daily
          (session_date, stock_code, model_version, model_commit, turnover_coefficient, generated_at,
           price, avg_cost, avg_cost_gap, avg_cost_gap_resid, profit_supply, dist_to_peak,
           peak_low, peak_high, rotation20, rotation60, float_pct, float_as_of, seed_remaining,
           confidence_data, confidence_convergence, confidence, distribution_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           model_commit=VALUES(model_commit), generated_at=VALUES(generated_at),
           price=VALUES(price), avg_cost=VALUES(avg_cost), avg_cost_gap=VALUES(avg_cost_gap),
           avg_cost_gap_resid=VALUES(avg_cost_gap_resid), profit_supply=VALUES(profit_supply),
           dist_to_peak=VALUES(dist_to_peak), peak_low=VALUES(peak_low), peak_high=VALUES(peak_high),
           rotation20=VALUES(rotation20), rotation60=VALUES(rotation60), float_pct=VALUES(float_pct),
           float_as_of=VALUES(float_as_of), seed_remaining=VALUES(seed_remaining),
           confidence_data=VALUES(confidence_data), confidence_convergence=VALUES(confidence_convergence),
           confidence=VALUES(confidence), distribution_json=VALUES(distribution_json)`,
        [session, r.tk, version, commit, M.TURNOVER_K, generatedAt,
         r.m.price, r.m.avgCost, r.m.avgCostGap, r.residual, r.m.profitSupply, r.m.distToPeak,
         r.m.peakLow, r.m.peakHigh, r.m.rotation20, r.m.rotation60, r.ff.pct, r.ff.asOf,
         r.m.seedRemaining, r.conf.data, r.conf.convergence, r.conf.overall,
         JSON.stringify(r.dist)]);
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }

  const med = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };

  const payload = {
    modelVersion: version, modelCommit: commit, turnoverCoefficient: M.TURNOVER_K,
    session, generatedAt: generatedAt.toISOString(),
    priceMaxDate: session,
    brokerMaxDate: bstale.d, brokerLagSessions,
    freeFloat: {
      maxAgeDays: FLOAT_MAX_AGE_DAYS,
      fresh: coverage.fresh, stale: coverage.stale, rejected: coverage.rejected,
      total: floatOf.size,
      coveragePct: floatOf.size ? +(coverage.fresh / floatOf.size * 100).toFixed(1) : 0,
      oldestFreshAsOf: coverage.oldestFreshAsOf ? new Date(coverage.oldestFreshAsOf).toISOString() : null,
    },
    confidence: { medianOverall: med(rows.map(r => r.conf.overall)), perTicker: true },
    universe: rows.length, skipped,
    evidence: {
      experiment: 'EXP-2026-08-07-023',
      rawIC60D: 0.0075, residualIC60D: 0.0378, residualIR: 0.23,
      note: 'Raw avgCostGap is indistinguishable from zero and overlaps 0.61 with 60-day momentum. Only the momentum-residualised value showed forward predictiveness, at a size EXP-011 already called untradeable.',
    },
    rows: sorted.map(r => ({
      ticker: r.tk, rank: r.rank,
      price: Math.round(r.m.price), avgCost: Math.round(r.m.avgCost),
      avgCostGap: +(r.m.avgCostGap * 100).toFixed(2),
      avgCostGapResid: r.residual === null ? null : +(r.residual * 100).toFixed(2),
      profitSupply: +(r.m.profitSupply * 100).toFixed(1),
      overheadSupply: +((1 - r.m.profitSupply) * 100).toFixed(1),
      peakLow: Math.round(r.m.peakLow), peakHigh: Math.round(r.m.peakHigh),
      rotation20: +(r.m.rotation20 * 100).toFixed(0), rotation60: +(r.m.rotation60 * 100).toFixed(0),
      floatPct: +r.ff.pct.toFixed(1),
      floatAsOf: r.ff.asOf ? new Date(r.ff.asOf).toISOString().slice(0, 10) : null,
      floatAgeDays: r.ff.ageDays,
      seedRemaining: r.conf.seedRemainingPct,
      confidence: r.conf.overall, confidenceData: r.conf.data, confidenceConvergence: r.conf.convergence,
      dist: r.dist,
    })),
  };

  // Atomic: a page that fetches a half-written file shows garbage and cannot tell.
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  const tmp = OUT_JSON + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, OUT_JSON);

  console.log(`session ${session} · model ${version}@${commit || 'UNSTAMPED'} · ${rows.length} tickers`);
  console.log(`free float: ${coverage.fresh} fresh / ${coverage.stale} stale / ${coverage.rejected} rejected of ${floatOf.size}`);
  console.log(`broker feed ${brokerLagSessions} session(s) behind · median confidence ${payload.confidence.medianOverall}/100`);
  if (Object.keys(skipped).length) console.log(`skipped: ${JSON.stringify(skipped)}`);
  console.log(`wrote ${OUT_JSON} (${(fs.statSync(OUT_JSON).size / 1024).toFixed(0)} KB)`);
  await pool.end();
})().catch(e => { console.error('FLOAT MAP DAILY FAILED:', e.message); process.exit(1); });
