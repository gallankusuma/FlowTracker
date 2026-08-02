/**
 * Backfills idx_ihsg_factor_history across the full 2-year idx_ihsg_history
 * window (2024-07-22 onward) — same idea as regenerate_signal_history.js for
 * individual stocks, applied to the index. Each historical day's 7 factors
 * (6 technical, reusing calcTechnicalFactors — same formulas as server.js's
 * computeIHSGFactors — plus Market Breadth) are computed using only data up
 * to and including that day (rolling window, no lookahead).
 *
 * Market Breadth for a historical date needs idx_stock_prices' change_pct for
 * that SAME date across all tracked stocks — only available where the stock
 * price backfill already reaches, so early dates may have thinner breadth
 * samples (still valid, just smaller n).
 *
 * Usage: node regenerate_ihsg_factor_history.js [--dry-run]
 */

'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const { calcTechnicalFactors } = require('./awo_technical');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  const [ihsgRows] = await pool.query(
    `SELECT date, open_price o, high_price h, low_price l, close_price c, volume v FROM idx_ihsg_history ORDER BY date ASC`
  );
  const candles = ihsgRows.map(r => ({
    date: r.date.toISOString().split('T')[0], open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v),
  }));
  console.log(`IHSG candles: ${candles.length} (${candles[0]?.date} to ${candles[candles.length - 1]?.date})`);

  console.log('Loading cross-sectional change_pct for market breadth...');
  const [priceRows] = await pool.query(`SELECT date, change_pct FROM idx_stock_prices`);
  const changesByDate = new Map();
  for (const r of priceRows) {
    const d = r.date.toISOString().split('T')[0];
    if (!changesByDate.has(d)) changesByDate.set(d, []);
    changesByDate.get(d).push(Number(r.change_pct));
  }

  console.log('Computing factors for each historical day...\n');
  const rowsToInsert = [];
  for (let i = 30; i < candles.length; i++) {
    const windowCandles = candles.slice(0, i + 1).slice(-60);
    let tech;
    try { tech = calcTechnicalFactors(windowCandles); } catch { continue; }

    const date = candles[i].date;
    const changes = changesByDate.get(date) || [];
    const total = changes.length;
    const positive = changes.filter(c => c > 0).length;
    const breadthPct = total > 0 ? (positive / total) * 100 : 50;
    const f_breadth = Math.round(breadthPct);

    const composite = Math.round((f_breadth + tech.f9 + tech.f10 + tech.f11 + tech.f12 + tech.f13 + tech.f14) / 7);
    const trend = composite >= 60 ? 'BULLISH' : composite <= 40 ? 'BEARISH' : 'NEUTRAL';

    rowsToInsert.push([
      date, composite, trend, f_breadth,
      Math.round(tech.f9), Math.round(tech.f10), Math.round(tech.f11), Math.round(tech.f12), Math.round(tech.f13), Math.round(tech.f14),
      Math.round(breadthPct * 100) / 100,
    ]);
  }

  console.log(`Rows to insert: ${rowsToInsert.length}`);
  if (dryRun) { console.log('(dry run — not writing)'); await pool.end(); return; }

  let inserted = 0;
  const BATCH = 200;
  for (let i = 0; i < rowsToInsert.length; i += BATCH) {
    const batch = rowsToInsert.slice(i, i + BATCH);
    const [result] = await pool.query(
      `INSERT INTO idx_ihsg_factor_history
        (date, composite_score, trend, f_breadth, f_rsi, f_macd, f_bollinger, f_ema_trend, f_support_resistance, f_atr, breadth_pct)
       VALUES ?
       ON DUPLICATE KEY UPDATE composite_score=VALUES(composite_score), trend=VALUES(trend),
         f_breadth=VALUES(f_breadth), f_rsi=VALUES(f_rsi), f_macd=VALUES(f_macd), f_bollinger=VALUES(f_bollinger),
         f_ema_trend=VALUES(f_ema_trend), f_support_resistance=VALUES(f_support_resistance), f_atr=VALUES(f_atr),
         breadth_pct=VALUES(breadth_pct)`,
      [batch]
    );
    inserted += result.affectedRows;
    console.log(`  [${Math.min(i + BATCH, rowsToInsert.length)}/${rowsToInsert.length}] done`);
  }

  console.log(`\nDone. ${inserted} rows affected (insert+update counts as 2 in MySQL's affectedRows for ON DUPLICATE KEY UPDATE).`);
  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
