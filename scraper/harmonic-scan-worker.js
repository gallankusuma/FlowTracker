#!/usr/bin/env node
require('dotenv').config();
/**
 * harmonic-scan-worker.js
 * Runs harmonic pattern scan as a separate process.
 * Communicates results via JSON file.
 * Usage: node harmonic-scan-worker.js [outputFile] [minRR]
 */
const mysql = require('mysql2/promise');
const { detectHarmonicPatterns, detectWyckoffPhase, detectOrderBlocks,
        detectFairValueGaps, detectLiquiditySweeps, calcUltraConviction: calcMasterScore } = require('./harmonicEngine');
const { computeConvictionTier } = require('./modules/conviction');
const https = require('https');
const fs = require('fs');

const OUTPUT_FILE = process.argv[2] || '/tmp/harmonic-scan-results.json';
const MIN_RR = Number(process.argv[3] || 1.0);
const MARKET = (process.argv[4] || 'IDX').toUpperCase();
let CUSTOM_WEIGHTS = null;
try { if (process.env.SCAN_WEIGHTS) CUSTOM_WEIGHTS = JSON.parse(process.env.SCAN_WEIGHTS); } catch {}

// Same DB config as server.js
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
  waitForConnections: true,
  connectionLimit: 3,
});

const { IDX_TICKERS } = require('./modules/tickers');
const { US_TICKERS } = require('./modules/us_tickers');

let TOP_STOCKS = [];
if (MARKET === 'CRYPTO') {
  TOP_STOCKS = [
    "BTC-USD","ETH-USD","BNB-USD","SOL-USD","XRP-USD","ADA-USD","AVAX-USD","DOGE-USD",
    "DOT-USD","LINK-USD","MATIC-USD","SHIB-USD","LTC-USD","UNI-USD","BCH-USD","ATOM-USD",
    "XLM-USD","INJ-USD","RNDR-USD","FET-USD","OP-USD","ARB-USD","SUI-USD","SEI-USD",
    "APT-USD","FIL-USD","NEAR-USD","TON-USD","TIA-USD","JUP-USD"
  ];
} else if (MARKET === 'US') {
  TOP_STOCKS = US_TICKERS;
} else {
  TOP_STOCKS = IDX_TICKERS;
}

function fetchYahooCandles(ticker, range = '6mo') {
  // US tickers are already bare Yahoo symbols (AAPL) — no suffix at all.
  const symbol = MARKET === 'US' ? ticker : (ticker.includes('-USD') ? ticker : `${ticker}.JK`);
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=1d`;
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const r = j?.chart?.result?.[0];
          if (!r) return resolve({ candles: [] });
          const ts = r.timestamp || [];
          const q = r.indicators?.quote?.[0] || {};
          const candles = ts.map((t, i) => ({
            date: new Date(t * 1000).toISOString().slice(0, 10),
            open: q.open?.[i] || 0, high: q.high?.[i] || 0,
            low: q.low?.[i] || 0, close: q.close?.[i] || 0,
            volume: q.volume?.[i] || 0,
          })).filter(c => c.close > 0);
          resolve({ candles });
        } catch (e) { resolve({ candles: [] }); }
      });
    });
    req.on('error', () => resolve({ candles: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ candles: [] }); });
  });
}

// US tickers get their own table (us_stock_prices) rather than sharing
// ft_price_ohlc with IDX — IDX codes are always exactly 4 letters and a
// handful of S&P 500 tickers happen to also be 4 letters (ORCL, ABBV, etc.);
// a shared ticker-keyed table would risk one market silently overwriting
// the other's price history if a code ever collided.
const OHLC_TABLE = MARKET === 'US' ? 'us_stock_prices' : 'ft_price_ohlc';

async function fetchAndCacheOHLC(ticker, days = 180) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const [cached] = await pool.query(
    `SELECT date, open_price as \`open\`, high_price as high, low_price as low,
            close_price as \`close\`, volume
     FROM ${OHLC_TABLE} WHERE ticker=? AND date >= ? ORDER BY date ASC`,
    [ticker, cutoff]
  );

  if (cached.length > 10) {
    const rawDate = cached[cached.length - 1].date;
    const lastDate = rawDate instanceof Date ? rawDate.toISOString().slice(0,10) : String(rawDate).slice(0,10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10);
    if (lastDate >= yesterday) {
      return cached.map(r => ({ ...r, date: String(r.date).slice(0,10) }));
    }
  }

  try {
    const range = days >= 150 ? '6mo' : days >= 80 ? '3mo' : '1mo';
    const result = await fetchYahooCandles(ticker, range);
    const candles = (result.candles || []).filter(c => c.close > 0);
    if (candles.length === 0) throw new Error('No candles');

    const vals = candles.map(c => [ticker, c.date, c.open, c.high, c.low, c.close, c.volume]);
    try {
      await pool.query(
        `INSERT INTO ${OHLC_TABLE} (ticker, date, open_price, high_price, low_price, close_price, volume)
         VALUES ? ON DUPLICATE KEY UPDATE
         open_price=VALUES(open_price), high_price=VALUES(high_price),
         low_price=VALUES(low_price), close_price=VALUES(close_price), volume=VALUES(volume)`,
        [vals]
      );
    } catch {}
    return candles;
  } catch {
    return cached.map(r => ({ ...r, date: String(r.date).slice(0,10) }));
  }
}

async function loadBrokerCategories() {
  const foreign = new Set(), bigMoney = new Set(), retail = new Set();
  try {
    const [rows] = await pool.query('SELECT broker_code, category FROM ft_broker_config');
    for (const r of rows) {
      if (r.category === 'foreign') foreign.add(r.broker_code);
      else if (r.category === 'big_money') bigMoney.add(r.broker_code);
      else retail.add(r.broker_code);
    }
  } catch {}
  return { foreign, bigMoney, retail };
}

async function run() {
  console.log(`[worker] Starting scan of ${TOP_STOCKS.length} stocks, min_rr=${MIN_RR}`);
  
  // Write initial progress
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ scanning: true, progress: `0/${TOP_STOCKS.length}`, results: [] }));

  const today = new Date().toISOString().slice(0,10);
  const d5ago = new Date(Date.now() - 5 * 86400000).toISOString().slice(0,10);

  const _cats = await loadBrokerCategories();
  const [brokerRows] = await pool.query(
    `SELECT stock_code, broker_code, SUM(buy_val) bv, SUM(sell_val) sv
     FROM idx_broker_summary WHERE date >= ? AND stock_code IN (?)
     GROUP BY stock_code, broker_code`,
    [d5ago, TOP_STOCKS]
  ).catch(() => [[]]);
  const brokerMap = {};
  for (const r of brokerRows) {
    if (!brokerMap[r.stock_code]) brokerMap[r.stock_code] = {};
    brokerMap[r.stock_code][r.broker_code] = Number(r.bv) - Number(r.sv);
  }

  const [[concDateRow]] = await pool.query('SELECT MAX(data_date) d FROM idx_concentration').catch(() => [[{}]]);
  const concDate = concDateRow?.d ? String(concDateRow.d).split('T')[0] : null;
  const concMap = {};
  if (concDate) {
    const [cRows] = await pool.query(
      'SELECT stock_code, dn0, dn1, dn2 FROM idx_concentration WHERE data_date=? AND stock_code IN (?)',
      [concDate, TOP_STOCKS]
    ).catch(() => [[]]);
    for (const r of cRows) concMap[r.stock_code] = r;
  }

  const results = [];
  const errors = [];

  for (let i = 0; i < TOP_STOCKS.length; i++) {
    const ticker = TOP_STOCKS[i];
    process.stdout.write(`\r[worker] ${i+1}/${TOP_STOCKS.length} ${ticker}    `);
    
    // Update progress file every 10 stocks
    if (i % 10 === 0) {
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
        scanning: true, progress: `${i+1}/${TOP_STOCKS.length} (${ticker})`,
        results: [...results], partial: true,
      }));
    }

    try {
      const ohlc = await fetchAndCacheOHLC(ticker, 180);
      if (ohlc.length < 20) continue;

      const patterns = detectHarmonicPatterns(ohlc, ticker);
      for (const p of patterns) {
        if (p.risk_reward < MIN_RR) continue;

        let wyckoff_phase = 'UNKNOWN', in_order_block = false,
            in_fvg = false, liquidity_sweep = false,
            vol_spike = false, above_vwap = null;
        try {
          const wy = detectWyckoffPhase(ohlc);
          const obs = detectOrderBlocks(ohlc);
          const fvgs = detectFairValueGaps(ohlc);
          const sw = detectLiquiditySweeps(ohlc);
          wyckoff_phase = wy?.phase || 'UNKNOWN';
          const last = ohlc[ohlc.length - 1];
          in_order_block = obs.some(o => last.close >= Math.min(o.high,o.low) && last.close <= Math.max(o.high,o.low));
          in_fvg = fvgs.some(f => {
            const top = f.top||f.high, bot = f.bot||f.low;
            return last.close >= Math.min(top,bot) && last.close <= Math.max(top,bot);
          });
          liquidity_sweep = !!(sw?.swept_low || sw?.swept_high);
          const vols = ohlc.map(c => c.volume || 0);
          const avg30 = vols.slice(-30).reduce((a,b)=>a+b,0) / Math.min(30, vols.length);
          const avg5 = vols.slice(-5).reduce((a,b)=>a+b,0) / 5;
          vol_spike = avg30 > 0 && (avg5 / avg30) > 1.5;
          const closes = ohlc.map(c => c.close);
          const ma20 = closes.slice(-20).reduce((a,b)=>a+b,0) / Math.min(20, closes.length);
          above_vwap = last.close > ma20;
        } catch {}

        const bMap = brokerMap[ticker] || {};
        let foreignNet = 0, bigMoneyNet = 0;
        for (const [bk, net] of Object.entries(bMap)) {
          if (_cats.foreign.has(bk)) foreignNet += net;
          else if (_cats.bigMoney.has(bk)) bigMoneyNet += net;
        }
        const conc = concMap[ticker] || {};

        // Build args matching calcUltraConviction(pattern, structureData, wyckoffData, smcData, volProfileData, brokerData)
        const last = ohlc[ohlc.length - 1];
        const wy = detectWyckoffPhase(ohlc) || {};
        const obs = detectOrderBlocks(ohlc) || [];
        const fvgs = detectFairValueGaps(ohlc) || [];
        const sw = detectLiquiditySweeps(ohlc) || {};
        const { buildVolumeProfile } = require('./harmonicEngine');
        const vp = typeof buildVolumeProfile === 'function' ? buildVolumeProfile(ohlc) : {};

        const structureData = { trend: above_vwap ? p.direction : 'NEUTRAL', bos_bullish: false, bos_bearish: false, choch: false };
        const wyckoffData = { phase: wy.phase || 'UNKNOWN', spring: wy.spring || false, upthrust: wy.upthrust || false, sign_of_strength: wy.sign_of_strength || false, buying_climax: wy.buying_climax || false };
        const smcData = { order_blocks: obs, fair_value_gaps: fvgs, liquidity_sweeps: sw };
        const volProfileData = vp || {};
        const brokerData = { foreignNet, bigMoneyNet, dn0: Number(conc.dn0||0), dn1: Number(conc.dn1||0), dn2: Number(conc.dn2||0) };

        let ms;
        try {
          ms = calcMasterScore(p, structureData, wyckoffData, smcData, volProfileData, brokerData, CUSTOM_WEIGHTS);
        } catch {
          ms = { master_score: Math.min(100, (p.fib_score || 50) + (p.risk_reward > 2 ? 10 : 0)), signal: p.direction === 'BULLISH' ? 'BUY' : 'SELL', breakdown: {} };
        }

        // Calculate 30-day Bollinger Bands
        const bb_data = [];
        try {
          const closes = ohlc.map(c => c.close);
          const startIndex = Math.max(19, closes.length - 30);
          for (let k = startIndex; k < closes.length; k++) {
            const slice = closes.slice(k - 19, k + 1);
            if (slice.length < 20) continue;
            const sma = slice.reduce((a, b) => a + b, 0) / 20;
            const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / 20;
            const stddev = Math.sqrt(variance);
            bb_data.push({
              close: closes[k],
              sma: Number(sma.toFixed(2)),
              upper: Number((sma + 2 * stddev).toFixed(2)),
              lower: Number((sma - 2 * stddev).toFixed(2))
            });
          }
        } catch (e) {}
        p.bb_data = bb_data;

        const smart_money_confirmed = (foreignNet > 0 && bigMoneyNet > 0 && p.direction === 'BULLISH') ||
                               (foreignNet < 0 && bigMoneyNet < 0 && p.direction === 'BEARISH');
        const convictionTier = computeConvictionTier({
          source: 'harmonic', patternType: p.pattern_type, smartMoneyConfirmed: smart_money_confirmed, market: MARKET,
        });

        results.push({
          ...p,
          conviction_score: ms.master_score || ms.score || 50,
          signal: ms.signal || p.direction,
          conviction_breakdown: ms.breakdown || {},
          smart_money_confirmed,
          foreign_3d_B: Math.round(foreignNet / 1e9 * 10) / 10,
          wyckoff_phase, in_order_block, in_fvg, liquidity_sweep,
          current_price: last.close,
          smc_tags: [in_order_block?'OB':'', in_fvg?'FVG':'', liquidity_sweep?'Sweep':''].filter(Boolean).join(','),
          convictionTier: convictionTier.tier,
          sizeMultiplier: convictionTier.sizeMultiplier,
          tierReason: convictionTier.reason,
        });
      }
    } catch (err) {
      errors.push({ ticker, error: err.message });
    }
  }

  results.sort((a, b) => b.conviction_score - a.conviction_score);
  
  const output = {
    scanning: false, progress: 'done',
    date: today, ts: Date.now(),
    scanned: TOP_STOCKS.length, found: results.length, errors: errors.length,
    results, market: MARKET
  };
  
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output));
  console.log(`\n[worker] Done! ${results.length} patterns, ${errors.length} errors. Saved to ${OUTPUT_FILE}`);
  
  await pool.end();
  process.exit(0);
}

run().catch(err => {
  console.error('[worker] Fatal:', err);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ scanning: false, progress: 'error', results: [], error: err.message }));
  process.exit(1);
});
