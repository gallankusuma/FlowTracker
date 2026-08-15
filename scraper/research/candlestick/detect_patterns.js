/**
 * EXP-028A — Pattern Detection & Occurrence Database.
 *
 * Purpose, in the review's words: "memastikan sistem membaca pattern secara
 * deterministic". Nothing here measures whether a pattern works; that is
 * EXP-028B. This stage exists so the occurrence set is a fixed, reproducible
 * artefact that later stages can be argued about without re-deriving it.
 *
 * TWO TABLES, NOT ONE, AND THE SECOND IS THE IMPORTANT ONE
 * -------------------------------------------------------
 * `idx_candlestick_occurrences` holds detections, as the spec describes. But an
 * occurrence table alone cannot answer "out of how many?", and a base rate with
 * a guessed denominator is worse than no base rate. So every bar examined is
 * also recorded in `idx_candlestick_bars` with its geometry and, when geometry
 * could not be computed, the REASON.
 *
 * That is what makes the data contract's "occurrence = unresolved, bukan
 * dianggap false" real rather than aspirational. 11% of IDX bars have zero
 * range and another 30% have a range under five ticks; if those were simply
 * absent from the occurrence table they would be indistinguishable from bars
 * that were examined and did not match, and every base rate in EXP-028B would
 * be computed against a denominator that quietly included them.
 *
 * THE CANONICAL CALENDAR IS THE AXIS
 * ----------------------------------
 * Bars are placed on `idx_ihsg_history` sessions, not on the rows a ticker
 * happens to have. A ticker that did not trade on a session leaves a HOLE, and a
 * two-candle pattern spanning that hole is refused rather than silently reaching
 * back to the previous traded bar — which would make "the previous candle" mean
 * different things for liquid and illiquid names. This is the same axis
 * discipline EXP-026 uses and the same failure it was fixing.
 *
 * ONE SOURCE PER TICKER
 * ---------------------
 * idx_stock_prices and idx_price_candidates now overlap. Choosing per BAR would
 * splice two provenances inside one series, so the choice is made once per
 * ticker and recorded on every row.
 *
 * Usage:
 *   node research/candlestick/detect_patterns.js [--limit N] [--tickers A,B]
 *                                                [--min-bars 750] [--dry-run]
 */
'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const { geometrySeries, UNRESOLVED } = require('./candle_geometry');
const { PATTERNS, TAXONOMY_VERSION, priorTrend, taxonomyHash } = require('./pattern_taxonomy_v1');

const DETECTOR_VERSION = 'detect-v1';

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { limit: 0, tickers: null, minBars: 750, dryRun: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--limit') o.limit = parseInt(a[++i], 10);
    else if (a[i] === '--tickers') o.tickers = a[++i].split(',').map(s => s.trim().toUpperCase());
    else if (a[i] === '--min-bars') o.minBars = parseInt(a[++i], 10);
    else if (a[i] === '--dry-run') o.dryRun = true;
  }
  return o;
}

const iso = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

async function ensureTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS idx_candlestick_bars (
      stock_code       VARCHAR(10) NOT NULL,
      session_date     DATE        NOT NULL,
      source           VARCHAR(24) NOT NULL,
      resolved         TINYINT(1)  NOT NULL,
      unresolved_reason VARCHAR(24) NULL,
      body_ratio       DECIMAL(9,6) NULL,
      upper_wick_ratio DECIMAL(9,6) NULL,
      lower_wick_ratio DECIMAL(9,6) NULL,
      close_location   DECIMAL(9,6) NULL,
      range_pct        DECIMAL(12,6) NULL,
      range_vs_atr     DECIMAL(12,6) NULL,
      gap_pct          DECIMAL(12,6) NULL,
      ticks_in_range   DECIMAL(12,4) NULL,
      geometry_reliable TINYINT(1)  NOT NULL DEFAULT 0,
      prior_trend      VARCHAR(8)  NULL,
      detector_version VARCHAR(24) NOT NULL,
      created_at       TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (stock_code, session_date),
      KEY idx_cb_date (session_date),
      KEY idx_cb_resolved (resolved)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS idx_candlestick_occurrences (
      stock_code       VARCHAR(10) NOT NULL,
      session_date     DATE        NOT NULL,
      pattern_id       VARCHAR(40) NOT NULL,
      pattern_version  VARCHAR(40) NOT NULL,
      family           VARCHAR(32) NOT NULL,
      direction        VARCHAR(32) NOT NULL,
      candle_count     TINYINT     NOT NULL,
      prior_trend      VARCHAR(8)  NULL,
      body_ratio       DECIMAL(9,6) NULL,
      upper_wick_ratio DECIMAL(9,6) NULL,
      lower_wick_ratio DECIMAL(9,6) NULL,
      close_location   DECIMAL(9,6) NULL,
      range_vs_atr     DECIMAL(12,6) NULL,
      geometry_reliable TINYINT(1)  NOT NULL DEFAULT 0,
      source           VARCHAR(24) NOT NULL,
      detector_version VARCHAR(24) NOT NULL,
      taxonomy_hash    CHAR(64)    NOT NULL,
      created_at       TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (stock_code, session_date, pattern_id),
      KEY idx_co_pattern (pattern_id),
      KEY idx_co_date (session_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

/** Which table to read a ticker from, decided once and recorded. */
async function chooseSources(pool, minBars) {
  const [a] = await pool.query(
    `SELECT stock_code c, COUNT(*) n FROM idx_stock_prices
      WHERE close_price > 0 AND open_price > 0 GROUP BY stock_code`);
  const [b] = await pool.query(
    `SELECT stock_code c, COUNT(*) n FROM idx_price_candidates
      WHERE close_price > 0 AND open_price IS NOT NULL GROUP BY stock_code`);
  const prod = new Map(a.map(r => [r.c, Number(r.n)]));
  const cand = new Map(b.map(r => [r.c, Number(r.n)]));

  const chosen = new Map();
  for (const code of new Set([...prod.keys(), ...cand.keys()])) {
    const p = prod.get(code) || 0, c = cand.get(code) || 0;
    // idx_stock_prices is the production series and wins when it is deep enough;
    // the staging table is a fallback, never a per-bar top-up.
    if (p >= minBars) chosen.set(code, { table: 'idx_stock_prices', bars: p });
    else if (c >= minBars) chosen.set(code, { table: 'idx_price_candidates', bars: c });
  }
  return chosen;
}

async function loadBars(pool, table, code) {
  const [rows] = await pool.query(
    `SELECT date, open_price o, high_price h, low_price l, close_price c, volume v
       FROM ${table} WHERE stock_code = ? AND close_price > 0 ORDER BY date ASC`, [code]);
  const byDate = new Map();
  for (const r of rows) {
    byDate.set(iso(r.date), {
      open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c),
      volume: r.v == null ? null : Number(r.v),
    });
  }
  return byDate;
}

async function main() {
  const opts = parseArgs();
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });
  await ensureTables(pool);

  const hash = taxonomyHash();
  const [ih] = await pool.query('SELECT date FROM idx_ihsg_history ORDER BY date ASC');
  const axis = ih.map(r => iso(r.date));
  console.log(`canonical axis: ${axis[0]} .. ${axis[axis.length - 1]} (${axis.length} sessions)`);
  console.log(`taxonomy ${TAXONOMY_VERSION} sha256 ${hash.slice(0, 16)}… — ${PATTERNS.length} patterns`);
  console.log(`detector ${DETECTOR_VERSION}\n`);

  const sources = await chooseSources(pool, opts.minBars);
  let codes = [...sources.keys()].sort();
  if (opts.tickers) codes = codes.filter(c => opts.tickers.includes(c));
  if (opts.limit > 0) codes = codes.slice(0, opts.limit);
  console.log(`tickers with >= ${opts.minBars} full-OHLC bars: ${codes.length}`);
  if (opts.dryRun) { console.log('(dry run)'); await pool.end(); return; }

  let barRows = 0, occRows = 0, unresolved = 0, done = 0;
  const reasonTally = {}, patternTally = {};
  const t0 = Date.now();

  for (const code of codes) {
    const src = sources.get(code);
    const byDate = await loadBars(pool, src.table, code);

    // Align to the canonical axis. Sessions the ticker did not trade become
    // holes, not omissions — geometrySeries keeps the slot so index i-1 always
    // means "the previous CANONICAL session".
    const bars = axis.map(d => byDate.get(d) || null);
    const geo = geometrySeries(bars);

    const barVals = [], occVals = [];
    for (let i = 0; i < axis.length; i++) {
      if (!bars[i]) continue;                    // never traded here: nothing to record
      const gg = geo[i];
      const trend1 = priorTrend(bars, i, 1);
      barVals.push([
        code, axis[i], src.table, gg.resolved ? 1 : 0, gg.reason,
        gg.bodyRatio, gg.upperWickRatio, gg.lowerWickRatio, gg.closeLocation,
        gg.rangePct, gg.rangeVsAtr, gg.gapPct, gg.ticksInRange,
        gg.geometryReliable ? 1 : 0, trend1, DETECTOR_VERSION,
      ]);
      if (!gg.resolved) { unresolved++; reasonTally[gg.reason] = (reasonTally[gg.reason] || 0) + 1; continue; }

      for (const p of PATTERNS) {
        if (i < p.candleCount - 1) continue;
        const trend = priorTrend(bars, i, p.candleCount);
        let hit = false;
        try { hit = !!p.match({ geo, bars, i, trend }); } catch { hit = false; }
        if (!hit) continue;
        patternTally[p.id] = (patternTally[p.id] || 0) + 1;
        occVals.push([
          code, axis[i], p.id, TAXONOMY_VERSION, p.family, p.direction, p.candleCount, trend,
          gg.bodyRatio, gg.upperWickRatio, gg.lowerWickRatio, gg.closeLocation, gg.rangeVsAtr,
          gg.geometryReliable ? 1 : 0, src.table, DETECTOR_VERSION, hash,
        ]);
      }
    }

    for (let k = 0; k < barVals.length; k += 2000) {
      const chunk = barVals.slice(k, k + 2000);
      const [r] = await pool.query(
        `INSERT INTO idx_candlestick_bars
          (stock_code, session_date, source, resolved, unresolved_reason,
           body_ratio, upper_wick_ratio, lower_wick_ratio, close_location,
           range_pct, range_vs_atr, gap_pct, ticks_in_range, geometry_reliable,
           prior_trend, detector_version)
         VALUES ? ON DUPLICATE KEY UPDATE
           source=VALUES(source), resolved=VALUES(resolved), unresolved_reason=VALUES(unresolved_reason),
           body_ratio=VALUES(body_ratio), upper_wick_ratio=VALUES(upper_wick_ratio),
           lower_wick_ratio=VALUES(lower_wick_ratio), close_location=VALUES(close_location),
           range_pct=VALUES(range_pct), range_vs_atr=VALUES(range_vs_atr), gap_pct=VALUES(gap_pct),
           ticks_in_range=VALUES(ticks_in_range), geometry_reliable=VALUES(geometry_reliable),
           prior_trend=VALUES(prior_trend), detector_version=VALUES(detector_version)`,
        [chunk]);
      barRows += r.affectedRows;
    }
    for (let k = 0; k < occVals.length; k += 2000) {
      const chunk = occVals.slice(k, k + 2000);
      const [r] = await pool.query(
        `INSERT INTO idx_candlestick_occurrences
          (stock_code, session_date, pattern_id, pattern_version, family, direction, candle_count,
           prior_trend, body_ratio, upper_wick_ratio, lower_wick_ratio, close_location,
           range_vs_atr, geometry_reliable, source, detector_version, taxonomy_hash)
         VALUES ? ON DUPLICATE KEY UPDATE
           pattern_version=VALUES(pattern_version), family=VALUES(family), direction=VALUES(direction),
           candle_count=VALUES(candle_count), prior_trend=VALUES(prior_trend),
           body_ratio=VALUES(body_ratio), upper_wick_ratio=VALUES(upper_wick_ratio),
           lower_wick_ratio=VALUES(lower_wick_ratio), close_location=VALUES(close_location),
           range_vs_atr=VALUES(range_vs_atr), geometry_reliable=VALUES(geometry_reliable),
           source=VALUES(source), detector_version=VALUES(detector_version),
           taxonomy_hash=VALUES(taxonomy_hash)`,
        [chunk]);
      occRows += r.affectedRows;
    }

    if (++done % 50 === 0 || done === codes.length) {
      console.log(`[${done}/${codes.length}] bars=${barRows.toLocaleString()} occurrences=${occRows.toLocaleString()} ${Math.round((Date.now() - t0) / 1000)}s`);
    }
  }

  const [[tot]] = await pool.query('SELECT COUNT(*) n FROM idx_candlestick_bars');
  const [[res]] = await pool.query('SELECT COUNT(*) n FROM idx_candlestick_bars WHERE resolved = 1');
  const [[rel]] = await pool.query('SELECT COUNT(*) n FROM idx_candlestick_bars WHERE geometry_reliable = 1');

  console.log(`\nbars examined      : ${Number(tot.n).toLocaleString()}`);
  console.log(`  resolved         : ${Number(res.n).toLocaleString()} (${(res.n / tot.n * 100).toFixed(2)}%)`);
  console.log(`  geometry reliable: ${Number(rel.n).toLocaleString()} (${(rel.n / tot.n * 100).toFixed(2)}%)`);
  console.log(`  unresolved by reason: ${JSON.stringify(reasonTally)}`);
  console.log('\noccurrences by pattern (RAW COUNTS — no claim about value):');
  for (const p of PATTERNS) {
    const n = patternTally[p.id] || 0;
    console.log(`  ${p.id.padEnd(24)} ${String(n).padStart(7)}  ${(n / res.n * 100).toFixed(3)}% of resolved bars`);
  }
  console.log('\nThese are frequencies, not evidence. EXP-028B measures outcome.');
  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
