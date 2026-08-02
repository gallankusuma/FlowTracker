/**
 * Recalculates idx_concentration for the full backfilled history using the
 * updated RG+NG blended formula (see autoCalculateConcentration in server.js).
 * Calls the live server's own /api/calc-concentration?force=true so the logic
 * lives in exactly one place, not duplicated here.
 *
 * Usage: node recalc_concentration_history.js [--days 112] [--dry-run]
 */

'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { days: 112, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days') out.days = parseInt(args[++i], 10);
    else if (args[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

async function calcConcentration(date, force) {
  const resp = await fetch('http://127.0.0.1:3100/api/calc-concentration', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, force }),
  });
  return resp.json();
}

async function main() {
  const opts = parseArgs();
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 3 });

  const [dateRows] = await pool.query(
    'SELECT DISTINCT date FROM idx_broker_summary ORDER BY date DESC LIMIT ?',
    [opts.days]
  );
  const dates = dateRows.map(r => (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10))).sort();
  await pool.end();

  console.log(`Recalc plan: ${dates.length} dates (${dates[0]} .. ${dates[dates.length - 1]}), force=true`);
  if (opts.dryRun) { console.log('(dry run — not calling)'); return; }

  let done = 0, totalStocks = 0, errors = 0;
  const startTime = Date.now();

  for (const date of dates) {
    try {
      const result = await calcConcentration(date, true);
      if (result.success) {
        totalStocks += result.stocks || 0;
        done++;
      } else {
        errors++;
        console.log(`  ${date}: FAILED — ${result.error}`);
      }
    } catch (e) {
      errors++;
      console.log(`  ${date}: ERROR ${e.message}`);
    }
    if (done % 10 === 0 || done === dates.length) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`[${done}/${dates.length}] done — stocks recalculated so far=${totalStocks} errors=${errors} elapsed=${elapsed}s`);
    }
    await delay(200); // be gentle on the live API — it's serving real traffic too
  }

  console.log(`\nRecalc complete: ${dates.length} dates processed, ${totalStocks} stock-days recalculated, ${errors} errors`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
