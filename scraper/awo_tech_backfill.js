/**
 * AWO Technical Backfill Script
 * 
 * Calculates technical factors (f9-f14) for all existing signals
 * using historical OHLCV data from idx_stock_prices.
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const { calcTechnicalFactors, sma, ema } = require('./awo_technical');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

async function main() {
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });
  
  console.log('\n🔬 AWO Technical Factors Backfill\n');

  // 1. Load all OHLCV data into memory
  console.log('📈 Loading OHLCV data...');
  const [priceRows] = await pool.query(
    `SELECT stock_code, date, open_price, high_price, low_price, close_price, volume
     FROM idx_stock_prices ORDER BY stock_code, date`
  );
  
  const priceMap = {};
  for (const r of priceRows) {
    const d = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date);
    if (!priceMap[r.stock_code]) priceMap[r.stock_code] = [];
    priceMap[r.stock_code].push({
      date: d,
      open: parseFloat(r.open_price),
      high: parseFloat(r.high_price),
      low: parseFloat(r.low_price),
      close: parseFloat(r.close_price),
      volume: parseInt(r.volume) || 0,
    });
  }
  console.log(`   Loaded OHLCV for ${Object.keys(priceMap).length} tickers\n`);

  // 2. Get all signals that need technical factors
  const [signals] = await pool.query(
    `SELECT id, stock_code, data_date FROM idx_signal_history WHERE f10_macd IS NULL ORDER BY data_date`
  );
  console.log(`📊 ${signals.length} signals need technical factors\n`);

  let updated = 0, skipped = 0;

  for (const sig of signals) {
    const dateStr = sig.data_date instanceof Date 
      ? sig.data_date.toISOString().slice(0, 10) 
      : String(sig.data_date);
    
    const allCandles = priceMap[sig.stock_code];
    if (!allCandles || allCandles.length < 15) {
      skipped++;
      continue;
    }

    // Get candles up to signal date
    const candles = allCandles.filter(c => c.date <= dateStr);
    if (candles.length < 15) {
      skipped++;
      continue;
    }

    // Calculate technical factors
    const tech = calcTechnicalFactors(candles.slice(-60)); // last 60 candles

    await pool.query(
      `UPDATE idx_signal_history 
       SET f9_rsi = ?, f10_macd = ?, f11_bollinger = ?, 
           f12_ema_trend = ?, f13_support_resistance = ?, f14_atr = ?
       WHERE id = ?`,
      [tech.f9, tech.f10, tech.f11, tech.f12, tech.f13, tech.f14, sig.id]
    );
    updated++;

    if (updated % 100 === 0) {
      process.stdout.write(`\r   ✅ ${updated}/${signals.length} updated (${skipped} skipped)`);
    }
  }

  console.log(`\r   ✅ ${updated}/${signals.length} updated (${skipped} skipped)\n`);

  // 3. Quick stats
  const [stats] = await pool.query(
    `SELECT 
       ROUND(AVG(f9_rsi),1) as avg_f9,
       ROUND(AVG(f10_macd),1) as avg_f10,
       ROUND(AVG(f11_bollinger),1) as avg_f11,
       ROUND(AVG(f12_ema_trend),1) as avg_f12,
       ROUND(AVG(f13_support_resistance),1) as avg_f13,
       ROUND(AVG(f14_atr),1) as avg_f14
     FROM idx_signal_history WHERE f10_macd IS NOT NULL`
  );
  console.log('📊 Average Technical Factor Scores:');
  console.log(`   f9  RSI Zone:    ${stats[0].avg_f9}`);
  console.log(`   f10 MACD Signal: ${stats[0].avg_f10}`);
  console.log(`   f11 Bollinger:   ${stats[0].avg_f11}`);
  console.log(`   f12 EMA Trend:   ${stats[0].avg_f12}`);
  console.log(`   f13 S/R Prox:    ${stats[0].avg_f13}`);
  console.log(`   f14 ATR Vol:     ${stats[0].avg_f14}`);

  // 4. Win rate breakdown by technical factors
  const [wrByRSI] = await pool.query(`
    SELECT 
      CASE WHEN f9_rsi >= 70 THEN 'OVERSOLD (>70)'
           WHEN f9_rsi >= 50 THEN 'NEUTRAL (50-70)'
           ELSE 'OVERBOUGHT (<50)' END as zone,
      COUNT(1) as total,
      SUM(outcome='WIN') as wins,
      ROUND(SUM(outcome='WIN')/NULLIF(SUM(outcome IN ('WIN','LOSS')),0)*100,1) as wr
    FROM idx_signal_history 
    WHERE f9_rsi IS NOT NULL AND outcome IS NOT NULL
    GROUP BY zone ORDER BY wr DESC
  `);
  console.log('\n📈 Win Rate by RSI Zone:');
  for (const r of wrByRSI) {
    console.log(`   ${r.zone}: ${r.wr}% WR (${r.total} signals)`);
  }

  await pool.end();
  console.log('\n✅ Technical backfill complete!\n');
}

main().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
