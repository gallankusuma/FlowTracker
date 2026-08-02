#!/usr/bin/env node
require('dotenv').config();
const { detectHarmonicPatterns } = require('./harmonicEngine');
const mysql = require('mysql2/promise');

(async () => {
  const pool = mysql.createPool({
    host: 'localhost', user: 'erp_user', password: process.env.DB_PASSWORD,
    database: 'erp_manufacturing', waitForConnections: true, connectionLimit: 2,
  });

  const [rows] = await pool.query(
    `SELECT date, open_price as \`open\`, high_price as high, low_price as low,
            close_price as \`close\`, volume
     FROM ft_price_ohlc WHERE ticker='BBCA' AND date >= '2026-01-01' ORDER BY date ASC`
  );
  const ohlc = rows.map(r => ({ ...r, date: String(r.date).slice(0,10) }));
  console.log(`BBCA: ${ohlc.length} candles (${ohlc[0]?.date} to ${ohlc[ohlc.length-1]?.date})`);

  // LOOSE: no recency/span filter — how many patterns exist in total?
  const loose = detectHarmonicPatterns(ohlc, 'BBCA', {
    maxPatternSpan: 999, maxDAge: 999, maxPrzGap: 1.0
  });
  const byType1 = {};
  for (const p of loose) byType1[p.pattern_type] = (byType1[p.pattern_type]||0)+1;
  console.log(`\nLOOSE (all history): ${loose.length} patterns`, JSON.stringify(byType1));

  // TIGHT: production settings
  const tight = detectHarmonicPatterns(ohlc, 'BBCA', {
    maxPatternSpan: 60, maxDAge: 5, maxPrzGap: 0.08
  });
  const byType2 = {};
  for (const p of tight) byType2[p.pattern_type] = (byType2[p.pattern_type]||0)+1;
  console.log(`TIGHT (production):  ${tight.length} patterns`, JSON.stringify(byType2));

  // Show ALL loose patterns
  console.log('\n=== ALL PATTERNS (LOOSE) ===');
  for (const p of loose) {
    const pd = p.pattern_data;
    const r = p.ratios;
    console.log(
      `${p.pattern_type.padEnd(12)} ${p.direction.padEnd(8)} fib:${String(p.fib_score).padStart(3)} ` +
      `| X:${pd.X.date.slice(5)} D:${pd.D.date.slice(5)} span:${pd.D.index-pd.X.index} ` +
      `| XB:${(r.XB||0).toFixed(3)} AC:${(r.AC||0).toFixed(3)} BD:${(r.BD||0).toFixed(3)} XD:${(r.XD||0).toFixed(3)}`
    );
  }

  await pool.end();
})();
