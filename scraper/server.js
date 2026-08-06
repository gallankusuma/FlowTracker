/**
 * IDX Broker Scraper — VPS Service
 * 
 * Uses Puppeteer to bypass Cloudflare protection on idx.co.id
 * Fetches broker summary data and stores in MySQL
 * Exposes REST API for FlowTracker frontend
 * 
 * Setup:  npm install && node server.js
 * Cron:   Run daily at 19:30 WIB (after market close)
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const mysql   = require('mysql2/promise');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());
const puppeteer = puppeteerExtra; // alias for backward compat
const path    = require('path');
const { autoFibonacci } = require('./modules/fibonacci');
const { getLunarEvents } = require('./modules/astro');
const stats = require('./modules/statistics');
const { analyzeFactorContributions, getFactorStats } = require('./awo_analyzer');
const { optimizeWeights, saveOptimizationResult, loadOptimizationResult, rescoreSignal, computeWinRate } = require('./awo_optimizer');
const { detectRegime, getRegimeWeights, getRegimeHistory, REGIME_WEIGHTS } = require('./awo_regime');
const tradePolicy = require('./modules/trade_policy');
const systemHealth = require('./modules/system_health');
const fs = require('fs');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = 3100;
// Active trading horizon (hold length, stop/target geometry, journal expiry).
// Declared at top-level module scope on purpose: updateRecommendationStatuses()
// is a top-level function called from scheduleDailyCron(), and a const nested
// inside main() would be invisible to it — the exact shape of the 2026-07-30
// production crash documented near updateRecommendationStatuses below.
const TRADE_POLICY = tradePolicy.active();
const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

// Index Alpha API — Primary data source for broker summary
const INDEX_ALPHA_KEY = process.env.INDEX_ALPHA_KEY;
const INDEX_ALPHA_BASE = 'https://api.indexalpha.id';

// ─── Admin auth — added 2026-07-30 (external review) ───────────────────────
// Before this, /api/awo/optimize, /api/awo/reset, /api/scrape, /api/cron/run,
// and /api/admin/* had ZERO auth — anyone reaching the server could trigger
// a scrape, rerun the daily cron, or worse, run the weight optimizer (which
// used to auto-adopt the result immediately, see the optimize handler
// below). This is a simple static shared-secret check, not full RBAC/JWT —
// it stops anonymous internet access, which is the acute risk; Review.md's
// fuller ask (roles, rate limiting, audit log, CSRF) is a real follow-up,
// not done here.
function requireAdminKey(req, res, next) {
  if (!process.env.ADMIN_API_KEY) {
    return res.status(503).json({ error: 'ADMIN_API_KEY not configured on server — admin endpoints disabled' });
  }
  // Constant-time comparison (external review, 2026-07-31) — `!==` on two
  // strings short-circuits at the first mismatched byte, so response timing
  // leaks how many leading characters of a guess were correct. Low-value
  // attack in practice on a low-traffic internal API, but the fix is free.
  // Both buffers must be equal length for timingSafeEqual, so a length
  // mismatch is checked (and rejected) separately first, before comparing.
  const provided = Buffer.from(req.headers['x-admin-key'] || '', 'utf8');
  const expected = Buffer.from(process.env.ADMIN_API_KEY, 'utf8');
  const valid = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  if (!valid) {
    return res.status(401).json({ error: 'Unauthorized — missing or invalid x-admin-key header' });
  }
  next();
}


// Top IDX stocks to auto-pull daily
const { IDX_TICKERS: TOP_STOCKS } = require('./modules/tickers');

// ── Yahoo Finance — Official IDX closing prices (free, no API key) ─────────────
const YF_CACHE_MS = 10 * 60 * 1000; // 10 min
let _yfCache    = {};
let _yfCacheAt  = 0;

/**
 * Fetch official IDX prices from Yahoo Finance v8 chart API.
 * Gets last 5 days of OHLCV → computes today's close and daily change %.
 * Returns { BBCA: { price, prevClose, changePct }, ... }
 */
async function fetchYahooPrices(tickers) {
  const now = Date.now();
  if (_yfCacheAt > 0 && (now - _yfCacheAt) < YF_CACHE_MS && Object.keys(_yfCache).length > 0) {
    return _yfCache;
  }

  const https  = require('https');
  const result = {};

  await Promise.allSettled(tickers.map(ticker => new Promise(resolve => {
    const cryptoNames = ['BTC','ETH','BNB','SOL','XRP','ADA','AVAX','DOGE','DOT','LINK','MATIC','SHIB','LTC','UNI','BCH','ATOM','XLM','INJ','RNDR','FET','OP','ARB','SUI','SEI','APT','FIL','NEAR','TON','TIA','JUP'];
    let sym = ticker;
    if (cryptoNames.includes(ticker)) sym = ticker + '-USD';
    else if (!ticker.includes('-USD')) sym = ticker + '.JK';
    sym = encodeURIComponent(sym);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d&events=div%2Csplit`;
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      timeout: 10000,
    };
    const req = https.get(url, opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const json  = JSON.parse(raw);
          const meta  = json?.chart?.result?.[0]?.meta;
          const ts    = json?.chart?.result?.[0]?.timestamp || [];
          const close = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];

          if (!meta || ts.length < 2) { resolve(); return; }

          // Find last two valid (non-null) closes
          const validCloses = close.map((c, i) => ({ c, t: ts[i] })).filter(x => x.c != null);
          if (validCloses.length < 1) { resolve(); return; }

          const latest  = validCloses[validCloses.length - 1];
          const prev    = validCloses.length > 1 ? validCloses[validCloses.length - 2] : null;
          const price   = Math.round(latest.c);
          const prevCl  = prev ? Math.round(prev.c) : 0;
          const chgPct  = prevCl > 0 ? Math.round(((price - prevCl) / prevCl) * 10000) / 100 : 0;

          result[ticker] = { price, prevClose: prevCl, changePct: chgPct };
        } catch (_) {}
        resolve();
      });
    });
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
  })));

  if (Object.keys(result).length > 0) {
    _yfCache   = result;
    _yfCacheAt = now;
    console.log(`📈 Yahoo prices: ${Object.keys(result).length}/${tickers.length} tickers`);
  }
  return result;
}


const app = express()
// ── CORS ─────────────────────────────────────────────────────────────────
// Fixed 2026-07-31 (external review): this used to be TWO redundant
// mechanisms both defaulting to `Access-Control-Allow-Origin: *` (a manual
// middleware, plus `cors()` called with no options, which also defaults to
// `*`) — meaning literally any origin on the internet could read responses
// from admin-adjacent endpoints in a browser context. Now a single `cors()`
// call, allowlisted via CORS_ALLOWED_ORIGINS (comma-separated) when set.
// Left permissive (`*`) by default ONLY because the actual production
// frontend origin(s) were not confirmed at fix time — deliberately NOT
// guessed, since a wrong guess would silently break the live frontend.
// Follow-up: set CORS_ALLOWED_ORIGINS in .env once the real origin(s) are
// confirmed, then this default stops mattering.
const corsAllowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
if (corsAllowedOrigins.length === 0) {
  console.warn('⚠️  CORS_ALLOWED_ORIGINS not set — allowing all origins (*). Set it in .env to restrict.');
}
app.use(cors({
  origin: corsAllowedOrigins.length > 0 ? corsAllowedOrigins : '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key'],
}));
// Body limit reduced from 50mb (external review, 2026-07-31) — no endpoint
// in this file legitimately needs anywhere close to that; the largest real
// payloads (CSV broker-summary upload, stockbit-import) are single-ticker/
// single-broker JSON, well under 1mb in practice.
app.use(express.json({ limit: '2mb' }));
app.use(express.text({ type: 'text/plain', limit: '2mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: true }));
app.use(require('express').static('/var/www/flowtracker-scraper/public'));


// ─── Helpers ──────────────────────────────────────────────────────────────────

// calcMasterScore is now provided by harmonicEngine.js (calcUltraConviction)
// Import used in HARMONIC PATTERN ENDPOINTS section below (line ~3360)
const { calcUltraConviction: calcMasterScoreLegacy, DEFAULT_WEIGHTS: HARMONIC_DEFAULT_WEIGHTS } = require('./harmonicEngine');

function formatVal(n) {
  if (n >= 1e12) return (n / 1e12).toFixed(1) + 'T';
  if (n >= 1e9)  return (n / 1e9).toFixed(0) + 'B';
  if (n >= 1e6)  return (n / 1e6).toFixed(0) + 'M';
  if (n >= 1e3)  return (n / 1e3).toFixed(0) + 'K';
  return String(n);
}
function formatLot(n) {
  if (n >= 1e9)  return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6)  return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3)  return (n / 1e3).toFixed(0) + 'K';
  return String(n);
}

let pool;

// ─── Database Setup ───────────────────────────────────────────────────────────
async function setupDB() {
  pool = mysql.createPool(DB);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS idx_broker_summary (
      id INT AUTO_INCREMENT PRIMARY KEY,
      date DATE NOT NULL,
      broker_code VARCHAR(5) NOT NULL,
      stock_code VARCHAR(10) NOT NULL,
      buy_val BIGINT DEFAULT 0,
      buy_lot BIGINT DEFAULT 0,
      buy_avg DECIMAL(15,2) DEFAULT 0,
      sell_val BIGINT DEFAULT 0,
      sell_lot BIGINT DEFAULT 0,
      sell_avg DECIMAL(15,2) DEFAULT 0,
      net_val BIGINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_date_broker_stock (date, broker_code, stock_code),
      INDEX idx_broker (broker_code),
      INDEX idx_date (date),
      INDEX idx_stock (stock_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS idx_stock_prices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      date DATE NOT NULL,
      stock_code VARCHAR(10) NOT NULL,
      open_price DECIMAL(15,2) DEFAULT 0,
      high_price DECIMAL(15,2) DEFAULT 0,
      low_price DECIMAL(15,2) DEFAULT 0,
      close_price DECIMAL(15,2) DEFAULT 0,
      volume BIGINT DEFAULT 0,
      value BIGINT DEFAULT 0,
      prev_close DECIMAL(15,2) DEFAULT 0,
      change_pct DECIMAL(8,4) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_date_stock (date, stock_code),
      INDEX idx_stock_date (stock_code, date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS idx_scrape_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      date DATE NOT NULL,
      type VARCHAR(20) NOT NULL,
      broker_code VARCHAR(5),
      records_count INT DEFAULT 0,
      status VARCHAR(20) DEFAULT 'pending',
      error_message TEXT,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP NULL,
      UNIQUE KEY uq_date_type_broker (date, type, broker_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // ─── Concentration table — stores pre-calculated dn values from FT.id ─────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS idx_concentration (
      id INT AUTO_INCREMENT PRIMARY KEY,
      data_date DATE NOT NULL,
      stock_code VARCHAR(10) NOT NULL,
      dn0 FLOAT DEFAULT NULL,
      dn1 FLOAT DEFAULT NULL,
      dn2 FLOAT DEFAULT NULL,
      dn3 FLOAT DEFAULT NULL,
      dn4 FLOAT DEFAULT NULL,
      price FLOAT DEFAULT NULL,
      change_pct FLOAT DEFAULT NULL,
      last_val BIGINT DEFAULT NULL,
      fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_date_stock (data_date, stock_code),
      INDEX idx_conc_date (data_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // ─── Detailed broker flow — foreign/domestic x RG/NG breakdown from Index Alpha ───
  // Additive: sums to idx_broker_summary's investor=all/market=RG figures for the RG
  // rows, plus captures NG (negotiated/block) trades that idx_broker_summary never
  // pulls at all. Deliberately a separate table so existing consumers of
  // idx_broker_summary (f1-f8 live scoring, awo_backfill.js, etc.) are untouched.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS idx_broker_flow_detail (
      id INT AUTO_INCREMENT PRIMARY KEY,
      date DATE NOT NULL,
      stock_code VARCHAR(10) NOT NULL,
      broker_code VARCHAR(5) NOT NULL,
      investor_type ENUM('foreign','domestic') NOT NULL,
      market_segment ENUM('RG','NG') NOT NULL,
      buy_val BIGINT DEFAULT 0,
      buy_lot BIGINT DEFAULT 0,
      buy_avg DECIMAL(15,2) DEFAULT 0,
      sell_val BIGINT DEFAULT 0,
      sell_lot BIGINT DEFAULT 0,
      sell_avg DECIMAL(15,2) DEFAULT 0,
      net_val BIGINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_flow_detail (date, stock_code, broker_code, investor_type, market_segment),
      INDEX idx_flow_date_stock (date, stock_code),
      INDEX idx_flow_stock (stock_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // ── IHSG (Jakarta Composite Index) daily history — kept in its own table,
  // deliberately separate from idx_stock_prices, since many scripts/queries
  // do `SELECT DISTINCT stock_code FROM idx_stock_prices` assuming every row
  // is a tradeable stock; mixing the index in there would silently corrupt
  // those (backtests, cross-sectional averages, etc.).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS idx_ihsg_history (
      date DATE PRIMARY KEY,
      open_price DECIMAL(12,2), high_price DECIMAL(12,2),
      low_price DECIMAL(12,2), close_price DECIMAL(12,2),
      volume BIGINT DEFAULT 0,
      change_pct DECIMAL(8,4) DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // ── IHSG factor layering — same technical-factor formulas used for
  // individual stocks (F9-F14: RSI/MACD/Bollinger/EMA/S-R/ATR), computed on
  // the index's own OHLC, plus a market-breadth factor (analogue of the
  // broker/concentration factors, which don't apply to an index). Builds its
  // own daily history the same way idx_signal_history does for stocks.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS idx_ihsg_factor_history (
      date DATE PRIMARY KEY,
      composite_score INT DEFAULT 50,
      trend VARCHAR(20) DEFAULT 'NEUTRAL',
      f_breadth INT DEFAULT NULL,
      f_rsi INT DEFAULT NULL,
      f_macd INT DEFAULT NULL,
      f_bollinger INT DEFAULT NULL,
      f_ema_trend INT DEFAULT NULL,
      f_support_resistance INT DEFAULT NULL,
      f_atr INT DEFAULT NULL,
      breadth_pct DECIMAL(6,2) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // ── AWO: Ensure idx_signal_history has required columns ─────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS idx_signal_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      data_date DATE NOT NULL,
      stock_code VARCHAR(10) NOT NULL,
      composite_score INT DEFAULT 0,
      signal_type VARCHAR(20),
      confidence INT DEFAULT 0,
      f1_concentration INT DEFAULT NULL,
      f2_trend INT DEFAULT NULL,
      f3_volume_z INT DEFAULT NULL,
      f4_momentum INT DEFAULT NULL,
      f5_rel_strength INT DEFAULT NULL,
      f6_breadth INT DEFAULT NULL,
      f7_alignment INT DEFAULT NULL,
      f8_streak INT DEFAULT NULL,
      price_at_signal DECIMAL(15,2) DEFAULT 0,
      price_5d_later DECIMAL(15,2) DEFAULT NULL,
      outcome VARCHAR(10) DEFAULT NULL,
      return_1d DECIMAL(8,4) DEFAULT NULL,
      return_3d DECIMAL(8,4) DEFAULT NULL,
      return_5d DECIMAL(8,4) DEFAULT NULL,
      return_10d DECIMAL(8,4) DEFAULT NULL,
      max_drawdown DECIMAL(8,4) DEFAULT NULL,
      max_profit DECIMAL(8,4) DEFAULT NULL,
      regime_at_signal VARCHAR(20) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_date_stock (data_date, stock_code),
      INDEX idx_outcome (outcome),
      INDEX idx_signal_type (signal_type),
      INDEX idx_date (data_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Add new columns if they don't exist (safe ALTER — ignore errors)
  const awoColumns = [
    ['return_1d', 'DECIMAL(8,4) DEFAULT NULL'],
    ['return_3d', 'DECIMAL(8,4) DEFAULT NULL'],
    ['return_5d', 'DECIMAL(8,4) DEFAULT NULL'],
    ['return_10d', 'DECIMAL(8,4) DEFAULT NULL'],
    ['max_drawdown', 'DECIMAL(8,4) DEFAULT NULL'],
    ['max_profit', 'DECIMAL(8,4) DEFAULT NULL'],
    ['regime_at_signal', 'VARCHAR(20) DEFAULT NULL'],
    ['f9_rsi', 'FLOAT DEFAULT NULL'],
    ['f10_macd', 'FLOAT DEFAULT NULL'],
    ['f11_bollinger', 'FLOAT DEFAULT NULL'],
    ['f12_ema_trend', 'FLOAT DEFAULT NULL'],
    ['f13_support_resistance', 'FLOAT DEFAULT NULL'],
    ['f14_atr', 'FLOAT DEFAULT NULL'],
    ['data_source', "ENUM('live','backfill') DEFAULT 'live'"],
    // Regime gate shadow mode (P1 follow-up #13, 2026-07-30) — logs what a
    // counter-trend gate on detectPriceRegime WOULD have decided, never
    // enforced. price_regime_at_signal is the PER-INSTRUMENT regime (distinct
    // from the existing market-wide regime_at_signal column above).
    ['price_regime_at_signal', 'VARCHAR(20) DEFAULT NULL'],
    ['regime_gate_would_block', 'TINYINT(1) DEFAULT NULL'],
    ['regime_gate_reason', 'VARCHAR(30) DEFAULT NULL'],
  ];
  for (const [col, def] of awoColumns) {
    await pool.query(`ALTER TABLE idx_signal_history ADD COLUMN ${col} ${def}`).catch(() => {});
  }

  // data_source defaults to 'live' for ALL existing rows when the column is first added
  // (MySQL backfills DEFAULT into pre-existing rows) — that mislabels the 2026-07-19
  // awo_backfill.js batch run (created_at clustered ~02:45:27-02:45:28 UTC that day).
  // Idempotent correction: safe to run on every boot.
  await pool.query(`
    UPDATE idx_signal_history
    SET data_source = 'backfill'
    WHERE created_at BETWEEN '2026-07-19 02:45:00' AND '2026-07-19 02:46:00'
  `).catch(() => {});

  // AWO optimization history table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS awo_optimization_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      optimized_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      regime VARCHAR(20) DEFAULT 'DEFAULT',
      old_weights JSON,
      new_weights JSON,
      old_win_rate DECIMAL(5,1),
      new_win_rate DECIMAL(5,1),
      improvement DECIMAL(5,1),
      train_size INT,
      validate_size INT,
      adopted BOOLEAN DEFAULT FALSE,
      thresholds JSON,
      details JSON
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Paper trading (P1 follow-up #18, 2026-07-30) — a candidate's real,
  // forward-only track record, required by /api/awo/optimize/promote before
  // any candidate is allowed into live scoring. See modules/paper_trading.js.
  // candidate_key is a stable hash of the candidate's WEIGHTS (not a run
  // timestamp) so the same candidate accumulates one continuous track record
  // across every day it keeps getting re-found, instead of resetting daily.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS awo_paper_trades (
      id INT AUTO_INCREMENT PRIMARY KEY,
      candidate_key VARCHAR(64) NOT NULL,
      stock_code VARCHAR(10) NOT NULL,
      signal_date DATE NOT NULL,
      direction VARCHAR(12) NOT NULL,
      entry_price DECIMAL(15,2) DEFAULT NULL,
      entry_date DATE DEFAULT NULL,
      stop_loss DECIMAL(15,2) DEFAULT NULL,
      target DECIMAL(15,2) DEFAULT NULL,
      status VARCHAR(14) DEFAULT 'PENDING_ENTRY',
      exit_price DECIMAL(15,2) DEFAULT NULL,
      exit_date DATE DEFAULT NULL,
      exit_reason VARCHAR(12) DEFAULT NULL,
      net_r DECIMAL(8,4) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_candidate_stock_date (candidate_key, stock_code, signal_date),
      INDEX idx_candidate (candidate_key),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  // stop_loss/target used to be NOT NULL (computed immediately at signal
  // time). Fixed 2026-07-31 (external review): the trade plan is now built
  // from the REAL T+1 entry price once known, not the stale signal-day
  // close, so these start NULL and get filled in by resolvePaperTrades().
  // Relaxes the constraint on already-created tables from before this fix.
  await pool.query(`ALTER TABLE awo_paper_trades MODIFY COLUMN stop_loss DECIMAL(15,2) DEFAULT NULL`).catch(() => {});
  await pool.query(`ALTER TABLE awo_paper_trades MODIFY COLUMN target DECIMAL(15,2) DEFAULT NULL`).catch(() => {});

  console.log('✅ Database tables ready (AWO columns ensured)');
}

// ─── Puppeteer Scraper ────────────────────────────────────────────────────────
async function scrapeBrokerSummary(brokerCode, dateStr) {
  const date = dateStr || getTodayDate();
  const dateCompact = date.replace(/-/g, '');
  console.log(`🔍 Scraping broker ${brokerCode} for ${date}...`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080',
      ],
    });

    const page = await browser.newPage();
    
    // Anti-detection: remove webdriver flag
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      // Override chrome runtime
      window.chrome = { runtime: {} };
      // Override permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    });
    
    // Set realistic browser environment
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    });

    // Strategy 1: Navigate to broker summary page, wait for CF challenge
    console.log('  → Navigating to IDX broker summary page...');
    await page.goto('https://www.idx.co.id/en/market-data/trading-summary/broker-summary/', {
      waitUntil: 'networkidle2',
      timeout: 45000,
    });

    // Wait longer for Cloudflare challenge to fully resolve
    await delay(8000);
    
    // Check if CF challenge passed by looking at page title
    const title = await page.title();
    console.log(`  → Page title: "${title}"`);
    
    if (title.toLowerCase().includes('just a moment') || title.toLowerCase().includes('cloudflare')) {
      console.log('  ⚠️ Cloudflare challenge not resolved, waiting longer...');
      await delay(10000);
      const title2 = await page.title();
      if (title2.toLowerCase().includes('just a moment')) {
        console.log('  ❌ Cloudflare still blocking, trying fallback...');
        return await scrapeViaAlternate(brokerCode, dateCompact, date, browser);
      }
    }

    // Now fetch the API with proper session cookies
    console.log('  → Fetching API data...');
    const apiUrl = `https://www.idx.co.id/primary/TradingSummary/GetBrokerSummary?code=${brokerCode}&date=${dateCompact}&length=500&start=0`;
    
    const result = await page.evaluate(async (url) => {
      try {
        const response = await fetch(url, {
          credentials: 'include',
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': 'https://www.idx.co.id/en/market-data/trading-summary/broker-summary/',
          },
        });
        if (!response.ok) return { error: `HTTP ${response.status}`, data: null };
        const text = await response.text();
        try { return { error: null, data: JSON.parse(text) }; }
        catch { return { error: `Not JSON: ${text.slice(0, 100)}`, data: null }; }
      } catch (e) {
        return { error: e.message, data: null };
      }
    }, apiUrl);

    if (result.error) {
      console.log(`  ❌ API error: ${result.error}`);
      
      // Fallback: try to scrape the table from the page directly
      console.log('  → Trying table scrape fallback...');
      return await scrapeTableFallback(page, brokerCode, date);
    }

    const records = parseIDXResponse(result.data, brokerCode, date);
    console.log(`  ✅ Got ${records.length} records from API`);
    
    return records;

  } catch (err) {
    console.error(`  ❌ Scrape error: ${err.message}`);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

// Alternative scrape approach: use intercept to capture XHR data
async function scrapeViaAlternate(brokerCode, dateCompact, date, existingBrowser) {
  console.log('  → Trying alternate scrape via XHR interception...');
  try {
    const page = await existingBrowser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    
    // Set up XHR interception  
    let apiData = null;
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('GetBrokerSummary') && response.status() === 200) {
        try { apiData = await response.json(); } catch(_) {}
      }
    });
    
    // Navigate to page with broker code already set
    const targetUrl = `https://www.idx.co.id/en/market-data/trading-summary/broker-summary/?brokerCode=${brokerCode}&date=${dateCompact}`;
    await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 60000 });
    await delay(10000);
    
    if (apiData) {
      const records = parseIDXResponse(apiData, brokerCode, date);
      console.log(`  ✅ Got ${records.length} records via XHR intercept`);
      return records;
    }
    
    console.log('  → No XHR data captured, trying direct table scrape...');
    return await scrapeTableFallback(page, brokerCode, date);
  } catch(e) {
    console.log(`  ❌ Alternate scrape failed: ${e.message}`);
    return [];
  }
}


// Fallback: scrape from rendered table
async function scrapeTableFallback(page, brokerCode, date) {
  try {
    // Type broker code in the search input
    const inputSelector = 'input[type="text"]';
    await page.waitForSelector(inputSelector, { timeout: 5000 });
    await page.click(inputSelector);
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.type(inputSelector, brokerCode);
    
    // Click search/filter button
    const buttons = await page.$$('button');
    for (const btn of buttons) {
      const text = await page.evaluate(el => el.textContent, btn);
      if (text && (text.includes('Search') || text.includes('Cari') || text.includes('Filter'))) {
        await btn.click();
        break;
      }
    }
    
    await delay(3000);

    // Extract table data
    const tableData = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr');
      const data = [];
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 7) {
          data.push({
            stockCode: (cells[0]?.textContent || '').trim(),
            buyVal: parseFloat((cells[1]?.textContent || '0').replace(/[,.]/g, '')) || 0,
            buyLot: parseFloat((cells[2]?.textContent || '0').replace(/[,.]/g, '')) || 0,
            sellVal: parseFloat((cells[3]?.textContent || '0').replace(/[,.]/g, '')) || 0,
            sellLot: parseFloat((cells[4]?.textContent || '0').replace(/[,.]/g, '')) || 0,
          });
        }
      });
      return data;
    });

    console.log(`  → Table fallback got ${tableData.length} rows`);
    return tableData.filter(d => d.stockCode).map(d => ({
      date,
      brokerCode,
      stockCode: d.stockCode,
      buyVal: d.buyVal,
      buyLot: d.buyLot,
      buyAvg: d.buyLot > 0 ? Math.round(d.buyVal / d.buyLot) : 0,
      sellVal: d.sellVal,
      sellLot: d.sellLot,
      sellAvg: d.sellLot > 0 ? Math.round(d.sellVal / d.sellLot) : 0,
      netVal: d.buyVal - d.sellVal,
    }));
  } catch (e) {
    console.log(`  ❌ Table fallback failed: ${e.message}`);
    return [];
  }
}

function parseIDXResponse(json, brokerCode, date) {
  const items = json?.data || json?.Results || json?.Data || [];
  if (!Array.isArray(items)) return [];

  return items
    .filter(item => item.StockCode || item.stockCode || item.Code)
    .map(item => {
      /* IndexAlpha API fields: buy_value, sell_value, buy_volume, sell_volume */
      const buyVal  = Number(item.buy_value  || item.BVal  || item.buyVal  || item.BuyValue  || 0);
      const sellVal = Number(item.sell_value || item.SVal  || item.sellVal || item.SellValue || 0);
      const buyLot  = Number(item.buy_volume || item.BLot  || item.buyLot  || item.BuyVolume || 0);
      const sellLot = Number(item.sell_volume|| item.SLot  || item.sellLot || item.SellVolume|| 0);

      return {
        date,
        brokerCode,
        stockCode: (item.StockCode || item.stockCode || item.Code || '').trim(),
        buyVal,
        buyLot,
        buyAvg: buyLot > 0 ? Math.round(buyVal / buyLot) : 0,
        sellVal,
        sellLot,
        sellAvg: sellLot > 0 ? Math.round(sellVal / sellLot) : 0,
        netVal: buyVal - sellVal,
      };
    });
}

// ─── Save to DB ───────────────────────────────────────────────────────────────
async function saveBrokerData(records) {
  if (!records.length) return 0;

  const values = records.map(r => [
    r.date, r.brokerCode, r.stockCode,
    r.buyVal, r.buyLot, r.buyAvg,
    r.sellVal, r.sellLot, r.sellAvg,
    r.netVal,
  ]);

  const sql = `
    INSERT INTO idx_broker_summary 
      (date, broker_code, stock_code, buy_val, buy_lot, buy_avg, sell_val, sell_lot, sell_avg, net_val)
    VALUES ?
    ON DUPLICATE KEY UPDATE
      buy_val = VALUES(buy_val),
      buy_lot = VALUES(buy_lot),
      buy_avg = VALUES(buy_avg),
      sell_val = VALUES(sell_val),
      sell_lot = VALUES(sell_lot),
      sell_avg = VALUES(sell_avg),
      net_val = VALUES(net_val)
  `;

  const [result] = await pool.query(sql, [values]);
  return result.affectedRows;
}

async function saveBrokerFlowDetail(records) {
  if (!records.length) return 0;

  const values = records.map(r => [
    r.date, r.stockCode, r.brokerCode, r.investorType, r.marketSegment,
    r.buyVal, r.buyLot, r.buyAvg,
    r.sellVal, r.sellLot, r.sellAvg,
    r.netVal,
  ]);

  const sql = `
    INSERT INTO idx_broker_flow_detail
      (date, stock_code, broker_code, investor_type, market_segment,
       buy_val, buy_lot, buy_avg, sell_val, sell_lot, sell_avg, net_val)
    VALUES ?
    ON DUPLICATE KEY UPDATE
      buy_val = VALUES(buy_val),
      buy_lot = VALUES(buy_lot),
      buy_avg = VALUES(buy_avg),
      sell_val = VALUES(sell_val),
      sell_lot = VALUES(sell_lot),
      sell_avg = VALUES(sell_avg),
      net_val = VALUES(net_val)
  `;

  const [result] = await pool.query(sql, [values]);
  return result.affectedRows;
}

// Pulls the 4 finest-grained investor x market combos (foreign/domestic x RG/NG)
// for one ticker+date — these are additive and reconstruct every other view
// (investor=all, market=ALL, etc.) without further API calls.
const FLOW_DETAIL_COMBOS = [
  { investor: 'f', investorType: 'foreign', market: 'RG' },
  { investor: 'f', investorType: 'foreign', market: 'NG' },
  { investor: 'd', investorType: 'domestic', market: 'RG' },
  { investor: 'd', investorType: 'domestic', market: 'NG' },
];

async function pullDetailedFlowForStock(ticker, date) {
  let totalSaved = 0;
  for (const combo of FLOW_DETAIL_COMBOS) {
    const rows = await fetchIndexAlpha(ticker, date, date, combo.investor, combo.market);
    if (rows.length === 0) continue;
    const records = rows.map(r => ({
      date: r.date, stockCode: r.stockCode, brokerCode: r.brokerCode,
      investorType: combo.investorType, marketSegment: combo.market,
      buyVal: r.buyVal, buyLot: r.buyLot, buyAvg: r.buyAvg,
      sellVal: r.sellVal, sellLot: r.sellLot, sellAvg: r.sellAvg, netVal: r.netVal,
    }));
    totalSaved += await saveBrokerFlowDetail(records);
    await delay(150); // stay polite to the API between the 4 combo calls
  }
  return totalSaved;
}

// ─── FT.id Concentration Puller ─────────────────────────────────────────────
// FT.id concentration pull — RETIRED 2026-08-03.
//
// The flowtracker.id account this depended on was banned, so this path cannot
// be repaired, only removed. It was never load-bearing: autoCalculateConcentration()
// computes dn-0..dn-4 from our own idx_broker_summary and is the PRIMARY source
// (245 tickers, current). FT.id was a bonus that additionally covered ~620 thin
// tickers, and only ever did so between 2026-05-22 and 2026-06-17.
//
// It also failed silently for 47 days. /api/ft-pull caught the error, fell through
// to autoCalculateConcentration, and returned `success: true, fallback: true` with
// `stocks: 0` — so every health check reading `success` saw green while nothing
// landed. That is the third instance of this exact pattern in this codebase (the
// signal pipeline logged 'Found 0 signals' for two months; scheduleDailyCron threw
// with no trace). A job that cannot report its own failure is worse than no job.
//
// Removed with it: FT_HOST/FT_EMAIL/FT_PASS/FT_KEY (FT_EMAIL was a hardcoded
// personal address), cryptoJsAesEncrypt, httpsPost, httpsGet, getFTToken and
// pullFTConcentration — none had another caller.

const crypto  = require('crypto');
const https   = require('https');

async function fetchYahooPrice(ticker) {
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}.JK?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const meta = json.chart?.result?.[0]?.meta;
    if (!meta) return null;

    return {
      ticker,
      price: meta.regularMarketPrice || 0,
      open: meta.regularMarketOpen || meta.regularMarketPrice || 0,
      high: meta.regularMarketDayHigh || meta.regularMarketPrice || 0,
      low: meta.regularMarketDayLow || meta.regularMarketPrice || 0,
      prevClose: meta.chartPreviousClose || 0,
      volume: meta.regularMarketVolume || 0,
      changePct: meta.chartPreviousClose
        ? ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose * 100)
        : 0,
    };
  } catch { return null; }
}

/**
 * The session a price row may be stamped with, or null if today is not one.
 *
 * WHY THIS EXISTS (2026-08-05). `getTodayDate()` returns the calendar date and
 * every price row was stamped with it, whether or not IDX traded that day. Run
 * the pull on a Saturday — or restart PM2, which re-arms `scheduleDailyCron()`
 * and fires the whole nightly pipeline again — and Yahoo happily returns
 * Friday's last quote, which lands in the table dated Saturday.
 *
 * That is where the 75 phantom sessions came from. They were purged on
 * 2026-08-04 and were BACK within hours, because deleting rows treats the
 * symptom while the ingest keeps producing them. A burn-in that forbids manual
 * database repair cannot start until this stops at the source.
 *
 * Weekends are refused outright. Beyond that the IHSG calendar decides, because
 * ^JKSE is the exchange's own index: no bar, no session. If the calendar has not
 * refreshed yet the weekday rule still applies, which is the conservative
 * direction — a holiday slipping through is one bad row the watchdog will flag,
 * where a wrong refusal loses a real session silently.
 */
async function tradingSessionForIngest() {
  const date = getTodayDate();
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return { date: null, reason: 'WEEKEND' };
  try {
    const [[cal]] = await pool.query('SELECT MAX(date) d FROM idx_ihsg_history');
    const latest = cal?.d ? toDateStr(cal.d) : null;
    // Only judge dates the calendar can actually speak for.
    if (latest && date <= latest) {
      const [rows] = await pool.query('SELECT 1 FROM idx_ihsg_history WHERE date=?', [date]);
      if (!rows.length) return { date: null, reason: 'NOT_A_TRADING_SESSION' };
    }
  } catch { /* no calendar: the weekday rule already applied */ }
  return { date, reason: null };
}

async function fetchAndSaveStockPrices(tickers) {
  const session = await tradingSessionForIngest();
  if (!session.date) {
    console.log(`[prices] SKIPPED — ${getTodayDate()} is not a trading session (${session.reason}).`);
    console.log('[prices] Writing it would create a phantom bar carrying the previous session\'s quotes,');
    console.log('[prices] and every rolling window in this system counts bars.');
    return { saved: 0, skipped: true, reason: session.reason };
  }
  const date = session.date;
  let saved = 0;

  for (const ticker of tickers) {
    const p = await fetchYahooPrice(ticker);
    if (!p) continue;

    await pool.query(`
      INSERT INTO idx_stock_prices (date, stock_code, open_price, high_price, low_price, close_price, volume, prev_close, change_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        open_price = VALUES(open_price), high_price = VALUES(high_price),
        low_price = VALUES(low_price), close_price = VALUES(close_price),
        volume = VALUES(volume), prev_close = VALUES(prev_close), change_pct = VALUES(change_pct)
    `, [date, ticker, p.open, p.high, p.low, p.price, p.volume, p.prevClose, p.changePct]);
    saved++;
  }

  return saved;
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// GET /api/broker-summary?code=MG&date=2026-04-28
// GET /api/broker-summary?code=MG&from=2026-04-20&to=2026-04-29  (range/accumulation mode)
app.get('/api/broker-summary', async (req, res) => {
  const code = (req.query.code || '').toUpperCase();
  const from = req.query.from;
  const to = req.query.to;
  const date = req.query.date || getTodayDate();
  const isRange = from && to && from !== to;

  if (!code || code.length < 2) {
    return res.json({ error: 'Broker code required (2 letters)', data: [] });
  }

  let rows;

  if (isRange) {
    // ─── RANGE / ACCUMULATION MODE ───
    // Aggregate buy/sell across date range using SUM + GROUP BY stock_code
    [rows] = await pool.query(
      `SELECT stock_code,
              SUM(buy_val) as buy_val, SUM(buy_lot) as buy_lot,
              SUM(sell_val) as sell_val, SUM(sell_lot) as sell_lot,
              SUM(buy_val) - SUM(sell_val) as net_val,
              CASE WHEN SUM(buy_lot) > 0 THEN SUM(buy_val) / SUM(buy_lot) ELSE 0 END as buy_avg,
              CASE WHEN SUM(sell_lot) > 0 THEN SUM(sell_val) / SUM(sell_lot) ELSE 0 END as sell_avg,
              COUNT(DISTINCT date) as days_active
       FROM idx_broker_summary
       WHERE broker_code = ? AND date >= ? AND date <= ?
       GROUP BY stock_code
       ORDER BY ABS(SUM(buy_val) - SUM(sell_val)) DESC`,
      [code, from, to]
    );
    console.log(`📊 Range query ${code} [${from} → ${to}]: ${rows.length} stocks`);
  } else {
    // ─── SINGLE DATE MODE ───
    [rows] = await pool.query(
      'SELECT * FROM idx_broker_summary WHERE broker_code = ? AND date = ? ORDER BY ABS(net_val) DESC',
      [code, date]
    );

    // If no data or force refresh, scrape fresh
    const forceRefresh = req.query.refresh === 'true';
    if (rows.length === 0 || forceRefresh) {
      console.log(`📡 No cached data for ${code}/${date}, scraping...`);
      const records = await scrapeBrokerSummary(code, date);
      if (records.length > 0) {
        await saveBrokerData(records);
        [rows] = await pool.query(
          'SELECT * FROM idx_broker_summary WHERE broker_code = ? AND date = ? ORDER BY ABS(net_val) DESC',
          [code, date]
        );
      }
    }
  }

  // Get stock prices for enrichment (use latest date)
  const latestDate = isRange ? to : date;
  const tickers = rows.map(r => r.stock_code);
  const [prices] = tickers.length > 0
    ? await pool.query('SELECT * FROM idx_stock_prices WHERE stock_code IN (?) AND date = ?', [tickers, latestDate])
    : [[]];
  const priceMap = {};
  for (const p of prices) priceMap[p.stock_code] = p;

  const data = rows.map(r => ({
    ticker: r.stock_code,
    action: Number(r.net_val) > 0 ? 'BUY' : Number(r.net_val) < 0 ? 'SELL' : 'NEUTRAL',
    buyVal: formatVal(Number(r.buy_val)),
    buyLot: formatLot(Number(r.buy_lot)),
    buyAvg: Math.round(Number(r.buy_avg)),
    sellVal: formatVal(Number(r.sell_val)),
    sellLot: formatLot(Number(r.sell_lot)),
    sellAvg: Math.round(Number(r.sell_avg)),
    netVal: formatVal(Math.abs(Number(r.net_val))),
    rawBuyVal: Number(r.buy_val),
    rawSellVal: Number(r.sell_val),
    rawNetVal: Number(r.net_val),
    daysActive: r.days_active || 1,
    price: priceMap[r.stock_code]?.close_price || 0,
    changePct: priceMap[r.stock_code]?.change_pct || 0,
  }));

  const dateLabel = isRange ? `${from} → ${to}` : date;

  res.json({
    broker: code,
    date: dateLabel,
    from: isRange ? from : undefined,
    to: isRange ? to : undefined,
    mode: isRange ? 'range' : 'single',
    source: rows.length > 0 ? 'IDX-DB' : 'none',
    count: data.length,
    buyCount: data.filter(d => d.action === 'BUY').length,
    sellCount: data.filter(d => d.action === 'SELL').length,
    data,
  });
});

// GET /api/stock-prices?tickers=BBCA,BBRI
app.get('/api/stock-prices', async (req, res) => {
  const tickers = (req.query.tickers || 'BBCA,BBRI,BMRI,TLKM,GOTO,ANTM,INCO,PGAS').split(',').map(t => t.trim().toUpperCase());
  const date = getTodayDate();

  // Check DB first
  let [rows] = tickers.length > 0
    ? await pool.query('SELECT * FROM idx_stock_prices WHERE stock_code IN (?) AND date = ?', [tickers, date])
    : [[]];

  // Fetch missing from Yahoo
  const found = new Set(rows.map(r => r.stock_code));
  const missing = tickers.filter(t => !found.has(t));

  if (missing.length > 0) {
    // Same guard as the nightly pull, and this path needs it just as much: it
    // writes whenever a human opens a page, so visiting the dashboard on a
    // Saturday was enough to mint a phantom session carrying Friday's quotes.
    const session = await tradingSessionForIngest();
    if (!session.date) {
      console.log(`[stock-prices] not persisting ${date} — ${session.reason}. Serving what the DB already has.`);
      return res.json({ date, data: rows.map(r => ({
        ticker: r.stock_code, price: Number(r.close_price), changePct: Number(r.change_pct),
      })), note: `${date} is not a trading session; nothing was written.` });
    }
    console.log(`📡 Fetching ${missing.length} stock prices from Yahoo...`);
    for (const t of missing) {
      const p = await fetchYahooPrice(t);
      if (p) {
        await pool.query(`
          INSERT INTO idx_stock_prices (date, stock_code, open_price, high_price, low_price, close_price, volume, prev_close, change_pct)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE close_price = VALUES(close_price), change_pct = VALUES(change_pct), volume = VALUES(volume)
        `, [date, t, p.open, p.high, p.low, p.price, p.volume, p.prevClose, p.changePct]);
      }
    }
    // Re-fetch from DB
    [rows] = await pool.query('SELECT * FROM idx_stock_prices WHERE stock_code IN (?) AND date = ?', [tickers, date]);
  }

  const data = rows.map(r => ({
    ticker: r.stock_code,
    price: Number(r.close_price),
    change: Number(r.close_price) - Number(r.prev_close),
    changePct: Number(r.change_pct),
    volume: Number(r.volume),
    high: Number(r.high_price),
    low: Number(r.low_price),
    open: Number(r.open_price),
    previousClose: Number(r.prev_close),
  }));

  res.json({
    count: data.length,
    updated: new Date().toISOString(),
    data: data.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)),
  });
});

// ─── FLOW ANALYZER — Top broker concentration per stock ──────────────────────
// PRIMARY: uses pre-pulled FT.id concentration (exact match)
// FALLBACK: calculates from raw broker data if FT.id data not available
app.get('/api/flow-analyzer', async (req, res) => {
  try {
    const [dateRows] = await pool.query('SELECT DISTINCT date FROM idx_broker_summary ORDER BY date DESC LIMIT 5');
    if (dateRows.length === 0) return res.json({ data: [], source: 'empty' });

    const toStr = d => (d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0]);
    const dates      = dateRows.map(r => r.date);
    const latestDate = toStr(dates[0]);

    // Get top stocks by total BUY VALUE on latest date (matches FT.id LAST VAL)
    const [stockRows] = await pool.query(`
      SELECT stock_code, SUM(buy_val) as total_val
      FROM idx_broker_summary WHERE date = ?
      GROUP BY stock_code ORDER BY total_val DESC
    `, [latestDate]);

    const tickers = stockRows.map(r => r.stock_code);

    // ── PRIMARY: Check FT.id pre-pulled concentration ────────────────────────
    // Use MAX(data_date) from idx_concentration — may be newer than broker summary date
    const [[concDateRow]] = await pool.query('SELECT MAX(data_date) d FROM idx_concentration');
    const concDate = concDateRow?.d ? toStr(concDateRow.d) : latestDate;
    const [concRows] = await pool.query(
      'SELECT stock_code, dn0, dn1, dn2, dn3, dn4 FROM idx_concentration WHERE data_date = ?',
      [concDate]
    );
    const concMap = Object.fromEntries(concRows.map(r => [r.stock_code, r]));
    const hasFTData = concRows.length > 0;

    // ── FALLBACK: Calculate from raw broker data ──────────────────────────────
    const calcConc = {};
    if (!hasFTData) {
      for (const stock of stockRows) {
        const ticker = stock.stock_code;
        calcConc[ticker] = [];
        for (const d of dates) {
          const [brokers] = await pool.query(`
            SELECT (buy_val - sell_val) AS net
            FROM idx_broker_summary WHERE date = ? AND stock_code = ?
            ORDER BY ABS(buy_val - sell_val) DESC LIMIT 3
          `, [d, ticker]);
          const [totRow] = await pool.query(`
            SELECT SUM(ABS(buy_val - sell_val)) AS total_net
            FROM idx_broker_summary WHERE date = ? AND stock_code = ?
          `, [d, ticker]);
          const net = brokers.reduce((a, b) => a + Number(b.net), 0);
          const tot = Number(totRow[0]?.total_net) || 1;
          calcConc[ticker].push((net / tot) * 100);
        }
        calcConc[ticker].reverse();
      }
    }

    // ── Prices from Yahoo Finance ─────────────────────────────────────────────
    const yfMap = await fetchYahooPrices(tickers);
    const [vwapLatest] = await pool.query(`
      SELECT stock_code, ROUND(SUM(buy_avg * buy_lot) / NULLIF(SUM(buy_lot), 0), 0) AS vwap
      FROM idx_broker_summary WHERE date = ? AND buy_avg > 0 GROUP BY stock_code
    `, [latestDate]);
    const [vwapPrev] = dates.length > 1 ? await pool.query(`
      SELECT stock_code, ROUND(SUM(buy_avg * buy_lot) / NULLIF(SUM(buy_lot), 0), 0) AS vwap
      FROM idx_broker_summary WHERE date = ? AND buy_avg > 0 GROUP BY stock_code
    `, [toStr(dates[1])]) : [[]];
    const vwapMap     = Object.fromEntries(vwapLatest.map(r => [r.stock_code, Number(r.vwap)]));
    const vwapPrevMap = Object.fromEntries(vwapPrev.map(r  => [r.stock_code, Number(r.vwap)]));

    // ── Build result ──────────────────────────────────────────────────────────
    const result = [];
    for (const stock of stockRows) {
      const ticker = stock.stock_code;
      const yf     = yfMap[ticker];
      const price  = yf?.price || vwapMap[ticker] || 0;
      const changePct = yf?.changePct !== undefined
        ? yf.changePct
        : (vwapPrevMap[ticker] > 0 ? ((vwapMap[ticker] - vwapPrevMap[ticker]) / vwapPrevMap[ticker]) * 100 : 0);

      // ─ Use FT.id concentration (exact) or fallback to calculated ─
      const ft   = concMap[ticker];
      const days = ft
        ? [ft.dn4, ft.dn3, ft.dn2, ft.dn1, ft.dn0].map(v => v ?? 0)
        : (calcConc[ticker] || [0, 0, 0, 0, 0]);

      result.push({
        ticker,
        lastVal:     formatVal(Number(stock.total_val)),
        days,
        dailyChange: Math.round(changePct * 100) / 100,
        price,
        priceSource: yf ? 'yahoo' : 'vwap',
        concSource:  ft ? 'flowtracker.id' : 'calculated',
      });
    }

    res.json({
      data:    result,
      date:    concDate || latestDate,
      dates:   dates.map(toStr),
      source:  hasFTData ? 'flowtracker.id+yahoo' : 'calculated+yahoo',
      ftData:  hasFTData,
    });
  } catch (err) {
    console.error('Flow analyzer error:', err.message);
    res.json({ data: [], error: err.message });
  }
});

// POST /api/ft-pull — RETIRED. The flowtracker.id account was banned; this
// endpoint cannot work and is kept only so a stale caller gets a clear answer
// instead of a 404 that looks like a routing bug. Use /api/calc-concentration,
// which computes the same values from our own broker data and never depended
// on FT.id at all.
// No requireAdminKey: the point of this stub is to TELL a stale caller what
// happened, and a 401 does not do that. Nothing here is sensitive — it performs
// no work and reveals only that a retired endpoint is retired.
app.post('/api/ft-pull', async (req, res) => {
  res.status(410).json({
    success: false,
    error: 'FT.id concentration pull was retired 2026-08-03 (account banned). Use POST /api/calc-concentration.',
  });
});

// POST /api/calc-concentration — Calculate concentration from broker data (no FT.id dependency)
app.post('/api/calc-concentration', requireAdminKey, async (req, res) => {
  const { date, force } = req.body || {};
  try {
    const result = await autoCalculateConcentration(date || getTodayDate(), !!force);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Calc concentration error:', err.message);
    res.json({ success: false, error: err.message });
  }
});

// GET /api/ft-concentration — Check what concentration data we have
app.get('/api/ft-concentration', async (req, res) => {
  const date = req.query.date || getTodayDate();
  const [rows] = await pool.query(
    'SELECT stock_code, dn0, dn1, dn2, dn3, dn4, price, change_pct, fetched_at FROM idx_concentration WHERE data_date = ? ORDER BY fetched_at DESC',
    [date]
  );
  res.json({ date, count: rows.length, data: rows });
});






// ─── ACCUMULATION STREAK — Multi-day consistent buying detection ─────────────

app.get('/api/accumulation-streak', async (req, res) => {
  const streakDays = Number(req.query.days) || 2;
  try {
    const [dateRows] = await pool.query('SELECT DISTINCT date FROM idx_broker_summary ORDER BY date DESC LIMIT ?', [streakDays + 1]);
    if (dateRows.length < streakDays) return res.json({ data: [], source: 'insufficient_data' });

    const dates = dateRows.map(r => r.date).reverse();
    const targetDates = dates.slice(-streakDays);

    // Find broker-stock combos that appear as net buyers on ALL target dates
    const placeholders = targetDates.map(() => '?').join(',');
    const [rows] = await pool.query(`
      SELECT stock_code, broker_code, 
        COUNT(DISTINCT date) as days_active,
        SUM(buy_val) as total_buy_val, SUM(buy_lot) as total_buy_lot,
        SUM(sell_val) as total_sell_val, SUM(sell_lot) as total_sell_lot,
        AVG(buy_avg) as avg_buy_price
      FROM idx_broker_summary 
      WHERE date IN (${placeholders}) AND buy_val > sell_val
      GROUP BY stock_code, broker_code
      HAVING days_active >= ?
      ORDER BY total_buy_val DESC
    `, [...targetDates, streakDays]);

    // Group by stock
    const stockMap = {};
    for (const r of rows) {
      if (!stockMap[r.stock_code]) stockMap[r.stock_code] = { buyers: [], sellers: [] };
      stockMap[r.stock_code].buyers.push({
        code: r.broker_code,
        bVal: formatVal(Number(r.total_buy_val)),
        bLot: formatLot(Number(r.total_buy_lot)),
        avg: Math.round(Number(r.avg_buy_price)),
        rawBuyVal: Number(r.total_buy_val),
      });
    }

    // Also find consistent sellers
    const [sellRows] = await pool.query(`
      SELECT stock_code, broker_code,
        COUNT(DISTINCT date) as days_active,
        SUM(sell_val) as total_sell_val, SUM(sell_lot) as total_sell_lot,
        AVG(sell_avg) as avg_sell_price
      FROM idx_broker_summary
      WHERE date IN (${placeholders}) AND sell_val > buy_val
      GROUP BY stock_code, broker_code
      HAVING days_active >= ?
      ORDER BY total_sell_val DESC
    `, [...targetDates, streakDays]);

    for (const r of sellRows) {
      if (!stockMap[r.stock_code]) stockMap[r.stock_code] = { buyers: [], sellers: [] };
      stockMap[r.stock_code].sellers.push({
        code: r.broker_code,
        sVal: formatVal(Number(r.total_sell_val)),
        sLot: formatLot(Number(r.total_sell_lot)),
        avg: Math.round(Number(r.avg_sell_price)),
      });
    }

    // Build response with price data
    const result = [];
    for (const [stockCode, data] of Object.entries(stockMap)) {
      if (data.buyers.length === 0) continue;
      const [priceRows] = await pool.query(
        'SELECT close_price, change_pct FROM idx_stock_prices WHERE stock_code = ? ORDER BY date DESC LIMIT 1',
        [stockCode]
      );
      const price = priceRows[0] ? Number(priceRows[0].close_price) : 0;
      const totalBuyVal = data.buyers.reduce((a, b) => a + (b.rawBuyVal || 0), 0);

      result.push({
        stockCode,
        lastPrice: price,
        lastValue: formatVal(totalBuyVal),
        buyers: data.buyers.slice(0, 3).map(b => ({
          ...b,
          gainPct: price > 0 && b.avg > 0 ? Number(((price - b.avg) / b.avg * 100).toFixed(2)) : 0,
        })),
        sellers: data.sellers.slice(0, 3),
      });
    }

    result.sort((a, b) => (b.buyers[0]?.rawBuyVal || 0) - (a.buyers[0]?.rawBuyVal || 0));
    res.json({ data: result.slice(0, 15), days: streakDays, dates: targetDates, source: 'database' });
  } catch (err) {
    console.error('Accumulation streak error:', err.message);
    res.json({ data: [], error: err.message });
  }
});

// ─── DASHBOARD SUMMARY — Aggregated market overview ──────────────────────────
app.get('/api/dashboard-summary', async (req, res) => {
  try {
    const date = getTodayDate();

    // Market signals from stock prices
    const [priceRows] = await pool.query(
      'SELECT * FROM idx_stock_prices ORDER BY date DESC, ABS(change_pct) DESC LIMIT 6'
    );
    const signals = priceRows.map(r => ({
      ticker: r.stock_code,
      price: Number(r.close_price),
      change: Number(r.change_pct),
      volume: Number(r.volume),
      signal: Number(r.change_pct) > 2 ? 'ACCUMULATION' : Number(r.change_pct) < -2 ? 'DISTRIBUTION' : 'NEUTRAL',
    }));

    // Active brokers count
    const [brokerCount] = await pool.query('SELECT COUNT(DISTINCT broker_code) as cnt FROM idx_broker_summary');
    // Total stocks tracked
    const [stockCount] = await pool.query('SELECT COUNT(DISTINCT stock_code) as cnt FROM idx_broker_summary');
    // Latest data date
    const [latestDate] = await pool.query('SELECT MAX(date) as latest FROM idx_broker_summary');
    // Total records
    const [totalRec] = await pool.query('SELECT COUNT(*) as cnt FROM idx_broker_summary');

    res.json({
      signals,
      stats: {
        activeBrokers: brokerCount[0]?.cnt || 0,
        trackedStocks: stockCount[0]?.cnt || 0,
        latestDate: latestDate[0]?.latest || date,
        totalRecords: totalRec[0]?.cnt || 0,
      },
      source: signals.length > 0 ? 'database' : 'empty',
    });
  } catch (err) {
    res.json({ signals: [], stats: {}, error: err.message });
  }
});

// GET /api/market-signals
app.get('/api/market-signals', async (req, res) => {
  const date = getTodayDate();
  const [rows] = await pool.query(
    'SELECT * FROM idx_stock_prices WHERE date = ? ORDER BY ABS(change_pct) DESC LIMIT 20',
    [date]
  );

  const data = rows.map(r => ({
    ticker: r.stock_code,
    price: Number(r.close_price),
    change: Number(r.change_pct),
    volume: Number(r.volume),
    signal: r.change_pct > 2 ? 'ACCUMULATION'
          : r.change_pct < -2 ? 'DISTRIBUTION'
          : 'NEUTRAL',
  }));

  res.json({ updated: new Date().toISOString(), count: data.length, data });
});

// POST /api/scrape — Trigger manual scrape
app.post('/api/scrape', requireAdminKey, async (req, res) => {
  const { brokerCode, date } = req.body;
  if (!brokerCode) return res.json({ error: 'brokerCode required' });

  const records = await scrapeBrokerSummary(brokerCode, date);
  let saved = 0;
  if (records.length > 0) {
    saved = await saveBrokerData(records);
  }

  res.json({ brokerCode, date: date || getTodayDate(), scraped: records.length, saved, success: records.length > 0 });
});

// POST /api/broker-summary/upload — Bulk upload broker data (JSON format)
// Body: { brokerCode: "MG", date: "2026-04-28", records: [{ stockCode, buyVal, buyLot, sellVal, sellLot }, ...] }
app.post('/api/broker-summary/upload', async (req, res) => {
  const { brokerCode, date, records } = req.body;
  if (!brokerCode || !records || !Array.isArray(records)) {
    return res.status(400).json({ error: 'brokerCode, date, and records[] required' });
  }

  const dateStr = date || getTodayDate();
  const parsed = records.map(r => ({
    date: dateStr,
    brokerCode: brokerCode.toUpperCase(),
    stockCode: (r.stockCode || r.ticker || r.code || '').toUpperCase().trim(),
    buyVal: Number(r.buyVal || r.bVal || 0),
    buyLot: Number(r.buyLot || r.bLot || 0),
    buyAvg: Number(r.buyAvg || 0) || (Number(r.buyLot || 0) > 0 ? Math.round(Number(r.buyVal || 0) / Number(r.buyLot || 0)) : 0),
    sellVal: Number(r.sellVal || r.sVal || 0),
    sellLot: Number(r.sellLot || r.sLot || 0),
    sellAvg: Number(r.sellAvg || 0) || (Number(r.sellLot || 0) > 0 ? Math.round(Number(r.sellVal || 0) / Number(r.sellLot || 0)) : 0),
    netVal: Number(r.buyVal || r.bVal || 0) - Number(r.sellVal || r.sVal || 0),
  })).filter(r => r.stockCode);

  const saved = await saveBrokerData(parsed);
  res.json({ success: true, brokerCode, date: dateStr, uploaded: parsed.length, saved });
});

// POST /api/broker-summary/upload-csv — Upload CSV text directly
// Body: { brokerCode: "MG", date: "2026-04-28", csv: "StockCode,BuyVal,BuyLot,SellVal,SellLot\nBBCA,1000000,500,..." }
app.post('/api/broker-summary/upload-csv', async (req, res) => {
  const { brokerCode, date, csv } = req.body;
  if (!brokerCode || !csv) {
    return res.status(400).json({ error: 'brokerCode and csv text required' });
  }

  const dateStr = date || getTodayDate();
  const lines = csv.trim().split('\n');
  const header = lines[0].toLowerCase().split(',').map(h => h.trim());
  
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map(v => v.trim());
    const row = {};
    header.forEach((h, idx) => { row[h] = vals[idx] || ''; });
    
    const stockCode = (row.stockcode || row.stock_code || row.ticker || row.code || '').toUpperCase();
    if (!stockCode) continue;

    const buyVal = parseFloat((row.buyval || row.bval || row.buy_val || '0').replace(/[^\d.]/g, '')) || 0;
    const buyLot = parseFloat((row.buylot || row.blot || row.buy_lot || '0').replace(/[^\d.]/g, '')) || 0;
    const sellVal = parseFloat((row.sellval || row.sval || row.sell_val || '0').replace(/[^\d.]/g, '')) || 0;
    const sellLot = parseFloat((row.selllot || row.slot || row.sell_lot || '0').replace(/[^\d.]/g, '')) || 0;

    records.push({
      date: dateStr,
      brokerCode: brokerCode.toUpperCase(),
      stockCode,
      buyVal,
      buyLot,
      buyAvg: buyLot > 0 ? Math.round(buyVal / buyLot) : 0,
      sellVal,
      sellLot,
      sellAvg: sellLot > 0 ? Math.round(sellVal / sellLot) : 0,
      netVal: buyVal - sellVal,
    });
  }

  const saved = await saveBrokerData(records);
  res.json({ success: true, brokerCode, date: dateStr, parsed: records.length, saved });
});

// GET /api/available-dates — Show which dates have data
app.get('/api/available-dates', async (req, res) => {
  const code = (req.query.code || '').toUpperCase();
  
  let query = 'SELECT DISTINCT date, COUNT(*) as records FROM idx_broker_summary';
  let params = [];
  if (code) {
    query += ' WHERE broker_code = ?';
    params.push(code);
  }
  query += ' GROUP BY date ORDER BY date DESC LIMIT 30';
  
  const [rows] = await pool.query(query, params);
  res.json({ data: rows.map(r => ({ date: r.date, records: r.records })) });
});

// ─── TICKER DETAIL — Full broker analysis for a single stock ──────────────────
// GET /api/ticker-detail?ticker=BBCA&days=20 OR &fromDate=2026-04-29
app.get('/api/ticker-detail', async (req, res) => {
  const ticker    = (req.query.ticker || '').toUpperCase();
  const days      = Math.min(parseInt(req.query.days) || 20, 250);
  const fromDate  = req.query.fromDate || null;  // e.g. "2026-04-29"

  if (!ticker) return res.json({ error: 'ticker required' });

  try {
    // ── 1. Get trading dates for this ticker ──────────────────────────────────
    // If fromDate given: calendar-based range (for 1M/3M/6M)
    // Otherwise: last N trading days (for 1W=5 days or legacy)
    let dateRows;
    if (fromDate) {
      [dateRows] = await pool.query(
        'SELECT DISTINCT date FROM idx_broker_summary WHERE stock_code = ? AND date >= ? ORDER BY date DESC LIMIT 250',
        [ticker, fromDate]
      );
    } else {
      [dateRows] = await pool.query(
        'SELECT DISTINCT date FROM idx_broker_summary WHERE stock_code = ? ORDER BY date DESC LIMIT ?',
        [ticker, days]
      );
    }
    if (dateRows.length === 0) return res.json({ error: `No broker data for ${ticker}` });

    // Normalize all dates to YYYY-MM-DD strings, oldest → newest
    const toStr = d => (d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0]);
    const dates = dateRows.map(r => toStr(r.date)).reverse();

    // ── 2. fundSummary — total market buy/sell/net per day (ALL brokers) ──────
    const [fundRows] = await pool.query(`
      SELECT date,
             SUM(buy_val)              AS buy,
             SUM(sell_val)             AS sell,
             SUM(buy_val - sell_val)   AS net
      FROM idx_broker_summary
      WHERE stock_code = ? AND date IN (?)
      GROUP BY date ORDER BY date ASC
    `, [ticker, dates]);

    const fundSummary = fundRows.map(r => ({
      date: toStr(r.date),
      buy:  Number(r.buy),
      sell: Number(r.sell),
      net:  Number(r.net),
    }));

    // ── 3. brokerTracker — per broker totals + daily series ───────────────────
    const [trackerRows] = await pool.query(`
      SELECT broker_code,
             SUM(buy_val)              AS total_buy,
             SUM(sell_val)             AS total_sell,
             SUM(buy_val - sell_val)   AS total_net,
             SUM(buy_lot)              AS total_buy_lot,
             SUM(sell_lot)             AS total_sell_lot,
             COUNT(DISTINCT date)      AS days_active,
             SUM(buy_val + sell_val)   AS total_turnover,
             MAX(buy_val + sell_val)   AS max_day_turnover
      FROM idx_broker_summary
      WHERE stock_code = ? AND date IN (?)
      GROUP BY broker_code
      ORDER BY ABS(SUM(buy_val - sell_val)) DESC,
               SUM(buy_val + sell_val) DESC
      LIMIT 12
    `, [ticker, dates]);

    const brokerCodes = trackerRows.map(r => r.broker_code);

    // Get daily net per broker for sparkline series
    const [seriesRows] = await pool.query(`
      SELECT broker_code, date, ((buy_lot - sell_lot) / 100) AS net, (buy_val - sell_val) AS netVal
      FROM idx_broker_summary
      WHERE stock_code = ? AND date IN (?) AND broker_code IN (?)
      ORDER BY date ASC
    `, [ticker, dates, brokerCodes.length ? brokerCodes : ['__none__']]);

    // Group series by broker
    const seriesByBroker = {};
    for (const r of seriesRows) {
      const bk = r.broker_code;
      if (!seriesByBroker[bk]) seriesByBroker[bk] = [];
      seriesByBroker[bk].push({ date: toStr(r.date), net: Number(r.net) });
    }

    // Helper: format lot numbers (e.g. 1234567 → "1.2M", 587000 → "587K")
    const fmtLot = (v) => {
      const a = Math.abs(v);
      if (a >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
      if (a >= 1_000)     return (v / 1_000).toFixed(0) + 'K';
      return String(Math.round(v));
    };

    const latestDate = dates[dates.length - 1];
    const brokerTracker = trackerRows.map(r => {
      const buyLot  = Number(r.total_buy_lot);
      const sellLot = Number(r.total_sell_lot);
      const netLot  = Math.round((buyLot - sellLot) / 100); // shares→lots (1 lot = 100 shares)
      const dir     = netLot >= 0 ? 'ACCUM' : 'DISTRIB';

      // Last day net lot (series already stores /100 = lots)
      const series  = seriesByBroker[r.broker_code] || [];
      const lastDay = series.find(s => s.date === latestDate);
      const lastDayNet = lastDay ? Math.round(lastDay.net) : 0; // already in lots

      return {
        broker:       r.broker_code,
        // LOT-based (primary for ACCUM/DISTRIB — same as FT.id)
        netLot,
        netLotFmt:    fmtLot(netLot),
        direction:    dir,
        lastDayLot:   lastDayNet,
        lastDayFmt:   fmtLot(lastDayNet),
        // IDR-based (secondary, for gross buy/sell display)
        totalNet:     Number(r.total_net),
        totalNetFmt:  formatVal(Math.abs(Number(r.total_net))),
        totalBuyFmt:  formatVal(Number(r.total_buy)),
        totalSellFmt: formatVal(Number(r.total_sell)),
        totalBuyLot:  buyLot,
        totalSellLot: sellLot,
        // Avg transaction price = value / shares (buy_lot/sell_lot cols are in shares, not lots)
        avgBuyPrice:  buyLot  > 0 ? Math.round(Number(r.total_buy)  / buyLot)  : null,
        avgSellPrice: sellLot > 0 ? Math.round(Number(r.total_sell) / sellLot) : null,
        daysActive:   Number(r.days_active),
        series,
      };
    });

    // ── 4. heatmap — broker × date grid of net values ─────────────────────────
    const heatmapData = {};
    for (const r of seriesRows) {
      const bk = r.broker_code;
      const d  = toStr(r.date);
      if (!heatmapData[bk]) heatmapData[bk] = {};
      heatmapData[bk][d] = Number(r.net);
    }

    const heatmap = {
      dates,
      brokers: brokerCodes,
      data:    heatmapData,
    };

    // ── 5. brokerAction — CUMULATIVE net LOT per broker per day (for line chart) ──
    // Using LOT volume (buy_lot - sell_lot) not IDR value
    const cumulative = {};
    for (const bk of brokerCodes) cumulative[bk] = 0;

    const brokerAction = dates.map(d => {
      const entry = { date: d };
      for (const bk of brokerCodes) {
        const dayNet = heatmapData[bk]?.[d] || 0;
        cumulative[bk] += dayNet;
        entry[bk] = cumulative[bk];
      }
      return entry;
    });

    // ── 5b. Merge price into brokerAction — UNIVERSAL fix for all timeframes
    //
    // Strategy:
    // 1. PRIMARY: VWAP from idx_broker_summary scoped to exact dates we show
    //    → Always available, matches broker data coverage exactly (3M/6M safe)
    // 2. SUPPLEMENT: open_price/close_price from idx_stock_prices where available
    //    → Overrides VWAP only when stock_prices data exists and is valid
    //
    // This avoids null prices for 3M/6M where idx_stock_prices may be missing data

    // Step 1: VWAP from broker transactions (covers ALL dates in our range)
    const [vwapRows] = await pool.query(
      `SELECT date,
              ROUND(SUM(buy_avg * buy_lot) / NULLIF(SUM(buy_lot), 0), 0) AS vwap
       FROM idx_broker_summary
       WHERE stock_code = ? AND date IN (?)
       GROUP BY date`,
      [ticker, dates.length ? dates : ['0000-00-00']]
    );
    const priceByDate = {};
    for (const r of vwapRows) {
      let d = r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date).split('T')[0];
      priceByDate[d] = r.vwap ? Number(r.vwap) : null;
    }

    // Step 2: Supplement with idx_stock_prices where available (open or close)
    if (dates.length > 0) {
      const [priceRows2] = await pool.query(
        `SELECT date, open_price, close_price
         FROM idx_stock_prices
         WHERE stock_code = ? AND date IN (?)
         ORDER BY date ASC`,
        [ticker, dates]
      );
      for (const r of priceRows2) {
        let d = r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date).split('T')[0];
        d = d.substring(0, 10);
        const open  = r.open_price  ? Number(r.open_price)  : 0;
        const close = r.close_price ? Number(r.close_price) : 0;
        // Only override if stock_prices has a value AND it seems valid (not anomalously low)
        const vwap = priceByDate[d] || 0;
        const stockPx = open || close;
        // Use stock price if it's within 20% of VWAP (sanity check), otherwise keep VWAP
        if (stockPx > 0 && (vwap === 0 || Math.abs(stockPx - vwap) / vwap < 0.20)) {
          priceByDate[d] = stockPx;
        }
      }
    }

    for (const entry of brokerAction) {
      entry.price = priceByDate[entry.date] || null;
    }

    // ── 6. Candlestick — OHLCV from stock price table ─────────────────────────
    const [candleRows] = await pool.query(`
      SELECT date, open_price, high_price, low_price, close_price, volume, change_pct
      FROM idx_stock_prices
      WHERE stock_code = ?
      ORDER BY date DESC LIMIT ?
    `, [ticker, days]);

    const candlestick = candleRows.reverse().map(r => ({
      date:      toStr(r.date),
      open:      Number(r.open_price),
      high:      Number(r.high_price),
      low:       Number(r.low_price),
      close:     Number(r.close_price),
      volume:    Number(r.volume),
      changePct: Number(r.change_pct),
    }));

    // ── 7. Price summary ───────────────────────────────────────────────────────
    const latestPrice = candlestick[candlestick.length - 1] || {};

    // 8. flowSummary — Foreign / Retail / Big Money classification
    // ALWAYS uses last 10 trading dates, INDEPENDENT of broker action timeframe
    // This ensures Flow Summary consistently shows 10 days even when 1W (5 days) selected.
    const FLOW_SUMMARY_DAYS = 10;
    const [flowDateRows] = await pool.query(
      'SELECT DISTINCT date FROM idx_broker_summary WHERE stock_code = ? ORDER BY date DESC LIMIT ?',
      [ticker, FLOW_SUMMARY_DAYS]
    );
    // Oldest → newest, YYYY-MM-DD strings
    const flowDates = flowDateRows.map(r => toStr(r.date)).reverse();

    // Load broker categories from DB (CMS-managed via Admin Panel) — this is a
    // broker-level guess (e.g. "broker DX is always foreign"), used only as a
    // fallback for dates before the real investor-type data exists, and to
    // subdivide the domestic bucket into retail vs big-money below (a smaller,
    // more defensible use than guessing the foreign/domestic split itself).
    const _cats1 = await loadBrokerCategories();
    const FOREIGN_BROKERS   = _cats1.foreign;
    const BIG_MONEY_BROKERS = _cats1.bigMoney;

    // Query category data for flow dates (last 10 days, not main chart dates)
    const [catRows] = await pool.query(`
      SELECT broker_code, date, SUM(buy_val - sell_val) AS net
      FROM idx_broker_summary
      WHERE stock_code = ? AND date IN (?)
      GROUP BY broker_code, date
      ORDER BY date ASC
    `, [ticker, flowDates.length ? flowDates : ['0000-00-00']]);

    const catByDate = {};
    for (const r of catRows) {
      const d = toStr(r.date);
      if (!catByDate[d]) catByDate[d] = { foreign: 0, retail: 0, bigMoney: 0 };
      const bk = r.broker_code;
      const net = Number(r.net);
      if (FOREIGN_BROKERS.has(bk))        catByDate[d].foreign  += net;
      else if (BIG_MONEY_BROKERS.has(bk)) catByDate[d].bigMoney += net;
      else                                catByDate[d].retail   += net;
    }

    // Real, transaction-level foreign/domestic split from Index Alpha (accurate),
    // available for dates the idx_broker_flow_detail backfill covers (2026-01-19
    // onward). Where it exists it REPLACES the broker-list guess above for the
    // foreign number; domestic is further split into bigMoney/retail using the
    // broker list (still a guess, but only within the domestic side now).
    const [realFlowRows] = await pool.query(`
      SELECT date, investor_type, broker_code, SUM(net_val) as net
      FROM idx_broker_flow_detail
      WHERE stock_code = ? AND date IN (?)
      GROUP BY date, investor_type, broker_code
    `, [ticker, flowDates.length ? flowDates : ['0000-00-00']]);
    const realByDate = {};
    for (const r of realFlowRows) {
      const d = toStr(r.date);
      if (!realByDate[d]) realByDate[d] = { foreign: 0, domestic: 0, hasData: true };
      const net = Number(r.net);
      if (r.investor_type === 'foreign') realByDate[d].foreign += net;
      else {
        realByDate[d].domestic += net;
        if (!realByDate[d].domesticBigMoney) realByDate[d].domesticBigMoney = 0;
        if (BIG_MONEY_BROKERS.has(r.broker_code)) realByDate[d].domesticBigMoney += net;
      }
    }

    // Map to array — 10 days always
    const flowSummaryData = flowDates.map(d => {
      const real = realByDate[d];
      if (real && real.hasData) {
        const domesticBigMoney = real.domesticBigMoney || 0;
        return {
          date: d,
          foreign: real.foreign,
          bigMoney: domesticBigMoney,
          retail: real.domestic - domesticBigMoney,
          source: 'index-alpha-investor-type',
        };
      }
      return {
        date:     d,
        foreign:  catByDate[d]?.foreign  || 0,
        retail:   catByDate[d]?.retail   || 0,
        bigMoney: catByDate[d]?.bigMoney || 0,
        source: 'broker-list-estimate',
      };
    });

    // Top 8 brokers for broker action chart (was 6, increased to match FT.id coverage)
    const sortedTop8 = brokerCodes.slice(0, 8);
    const brokerActionTop8 = brokerAction.map(row => {
      const entry = { date: row.date, price: row.price };
      for (const bk of sortedTop8) entry[bk] = row[bk] ?? 0;
      return entry;
    });

    res.json({
      ticker,
      dates,
      fundSummary,
      brokerTracker,
      brokerCodes: sortedTop8,
      heatmap,
      brokerAction: brokerActionTop8,
      flowSummary: flowSummaryData,
      candlestick,
      price:     latestPrice.close     || 0,
      changePct: latestPrice.changePct || 0,
      dataRange: { from: dates[0], to: dates[dates.length - 1], days: dates.length },
      source:    'database',
    });

  } catch (err) {
    console.error('Ticker detail error:', err.message);
    res.json({ error: err.message });
  }
});

// ─── BROKER RANGE — Alpha vs Beta period comparison (like FT.id) ──────────────
app.get('/api/broker-range', async (req, res) => {
  const { ticker, alphaDate, betaDate } = req.query;
  const t = (ticker || '').toUpperCase();
  if (!t || !alphaDate || !betaDate) return res.json({ error: 'ticker, alphaDate, betaDate required' });

  try {
    const qry = `
      SELECT broker_code,
        SUM(buy_val)  AS buyVal,  SUM(buy_lot)/100  AS buyLot,
        ROUND(SUM(buy_val)  / NULLIF(SUM(buy_lot),  0)) AS buyAvg,
        SUM(sell_val) AS sellVal, SUM(sell_lot)/100 AS sellLot,
        ROUND(SUM(sell_val) / NULLIF(SUM(sell_lot), 0)) AS sellAvg,
        SUM(buy_val - sell_val) AS netVal,
        (SUM(buy_lot) - SUM(sell_lot))/100 AS netLot
      FROM idx_broker_summary
      WHERE stock_code = ? AND date = ?
      GROUP BY broker_code ORDER BY ABS(SUM(buy_val - sell_val)) DESC
    `;

    const [[alphaRows], [betaRows]] = await Promise.all([
      pool.query(qry, [t, alphaDate]),
      pool.query(qry, [t, betaDate]),
    ]);

    const num = (v) => Number(v || 0);
    const toObj = (rows) => Object.fromEntries(rows.map(r => [r.broker_code, r]));
    const alphaMap = toObj(alphaRows);
    const betaMap  = toObj(betaRows);
    const allCodes = [...new Set([...alphaRows.map(r => r.broker_code), ...betaRows.map(r => r.broker_code)])];

    const inventory = allCodes.map(code => {
      const a = alphaMap[code];
      const b = betaMap[code];
      const alphaLot  = num(a?.netLot);
      const betaDelta = num(b?.netLot);
      const buyAvgA   = num(a?.buyAvg);
      const buyAvgB   = num(b?.buyAvg);
      const sellAvgB  = num(b?.sellAvg);

      let signal = '-';
      if (betaDelta > 0) {
        const combined = (alphaLot !== 0 && buyAvgA !== 0)
          ? Math.round((alphaLot * buyAvgA + betaDelta * buyAvgB) / (alphaLot + betaDelta))
          : Math.round(buyAvgB);
        signal = `AVG-UP @${combined.toFixed(0)}`;
      } else if (betaDelta < 0 && buyAvgA > 0 && sellAvgB > 0) {
        const pnl     = ((sellAvgB - buyAvgA) / buyAvgA * 100).toFixed(1);
        const exitPct = alphaLot !== 0 ? Math.abs(Math.round(betaDelta / alphaLot * 100)) : 0;
        signal = `${exitPct}%EXIT ${pnl >= 0 ? '+' : ''}${pnl}%P/L`;
      }
      return { broker: code, alphaLot, alphaNet: num(a?.netVal), betaDelta, betaNet: num(b?.netVal), signal };
    })
    .filter(x => x.alphaLot !== 0 || x.betaDelta !== 0)
    .sort((a, b) => Math.abs(b.betaDelta) - Math.abs(a.betaDelta));

    const mapRow = r => ({
      broker: r.broker_code,
      buyVal:  num(r.buyVal),  buyLot:  num(r.buyLot),  buyAvg:  num(r.buyAvg),
      sellVal: num(r.sellVal), sellLot: num(r.sellLot), sellAvg: num(r.sellAvg),
      netVal:  num(r.netVal),  netLot:  num(r.netLot),
    });

    res.json({
      ticker: t, alphaDate, betaDate,
      alpha:     alphaRows.map(mapRow),
      beta:      betaRows.map(mapRow),
      inventory,
    });
  } catch (err) {
    console.error('Broker range error:', err.message);
    res.json({ error: err.message });
  }
});



// GET /api/brokers — List brokers with data
app.get('/api/brokers', async (req, res) => {
  const [rows] = await pool.query(
    'SELECT broker_code, COUNT(DISTINCT stock_code) as stocks, COUNT(DISTINCT date) as days, MAX(date) as last_date FROM idx_broker_summary GROUP BY broker_code ORDER BY last_date DESC'
  );
  res.json({ data: rows });
});

// GET /api/brokers-with-data (alias)
app.get('/api/brokers-with-data', async (req, res) => {
  const [rows] = await pool.query(
    'SELECT broker_code, COUNT(DISTINCT stock_code) as stocks, COUNT(DISTINCT date) as days, MAX(date) as last_date FROM idx_broker_summary GROUP BY broker_code ORDER BY last_date DESC'
  );
  res.json({ data: rows });
});

// GET /api/full-broker-list — complete list of all IDX registered brokers
app.get('/api/full-broker-list', (req, res) => {
  res.json({ data: FULL_BROKER_LIST });
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'flowtracker-scraper',
    uptime: process.uptime(),
    sectors_api: SECTORS_API_KEY ? 'configured' : 'not_configured',
    total_brokers: FULL_BROKER_LIST.length,
  });
});

// ─── Sectors.app API Integration ─────────────────────────────────────────────
let SECTORS_API_KEY = process.env.SECTORS_API_KEY || '';
const SECTORS_BASE = 'https://api.sectors.app/v1';

// POST /api/sectors/configure — Set API key at runtime from admin panel
app.post('/api/sectors/configure', (req, res) => {
  const { api_key } = req.body;
  if (!api_key || api_key.trim().length < 5) {
    return res.json({ success: false, error: 'Invalid API key' });
  }
  SECTORS_API_KEY = api_key.trim();
  console.log('🔑 Sectors.app API key configured at runtime');
  res.json({ success: true, message: 'API key saved (runtime). Add SECTORS_API_KEY to .env for persistence.' });
});

// POST /api/sectors/pull — Pull data from Sectors.app API (requires API key)
app.post('/api/sectors/pull', async (req, res) => {
  if (!SECTORS_API_KEY) {
    return res.json({
      success: false,
      error: 'Sectors.app API key not configured. Set SECTORS_API_KEY env variable.',
      howto: 'Sign up at https://sectors.app, get API key, then: SECTORS_API_KEY=your_key pm2 restart flowtracker-scraper',
    });
  }

  const { endpoint, params } = req.body;
  const url = `${SECTORS_BASE}/${endpoint || 'companies/'}${params ? '?' + new URLSearchParams(params) : ''}`;

  try {
    const response = await fetch(url, {
      headers: { 'Authorization': SECTORS_API_KEY },
    });

    if (!response.ok) {
      return res.json({ success: false, error: `Sectors API returned ${response.status}` });
    }

    const data = await response.json();
    res.json({ success: true, data, source: 'sectors.app' });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// POST /api/sectors/pull-broker — Pull broker-specific data from Sectors.app
app.post('/api/sectors/pull-broker', async (req, res) => {
  if (!SECTORS_API_KEY) {
    return res.json({ success: false, error: 'Sectors.app API key not configured' });
  }

  const { stock_code, start_date, end_date } = req.body;
  const ticker = stock_code ? `${stock_code}.JK` : 'BBCA.JK';

  try {
    const url = `${SECTORS_BASE}/companies/${ticker}/`;
    const response = await fetch(url, {
      headers: { 'Authorization': SECTORS_API_KEY },
    });

    if (!response.ok) {
      return res.json({ success: false, error: `Sectors API returned ${response.status}` });
    }

    const data = await response.json();
    res.json({ success: true, data, ticker, source: 'sectors.app' });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── Full Indonesia Broker List ──────────────────────────────────────────────
const FULL_BROKER_LIST = [
  // Top 10 by volume
  { code: "MG", name: "Mirae Asset Sekuritas (Semesta Indovest)", category: "top10" },
  { code: "CC", name: "Mandiri Sekuritas", category: "top10" },
  { code: "YP", name: "Indo Premier Sekuritas", category: "top10" },
  { code: "AK", name: "UBS Sekuritas Indonesia", category: "top10" },
  { code: "ZP", name: "Kim Eng Sekuritas (Maybank)", category: "top10" },
  { code: "PD", name: "CGS-CIMB Sekuritas", category: "top10" },
  { code: "DH", name: "CLSA Sekuritas Indonesia", category: "top10" },
  { code: "DB", name: "Deutsche Sekuritas", category: "top10" },
  { code: "RX", name: "Macquarie Sekuritas Indonesia", category: "top10" },
  { code: "AF", name: "BCA Sekuritas", category: "top10" },
  // Major Institutional
  { code: "AZ", name: "Danareksa Sekuritas", category: "institutional" },
  { code: "KZ", name: "Bahana Sekuritas", category: "institutional" },
  { code: "NI", name: "Shinhan Sekuritas Indonesia", category: "institutional" },
  { code: "KI", name: "Nomura Sekuritas Indonesia", category: "institutional" },
  { code: "TP", name: "Trimegah Sekuritas", category: "institutional" },
  { code: "EP", name: "RHB Sekuritas Indonesia", category: "institutional" },
  { code: "GR", name: "Ciptadana Sekuritas Asia", category: "institutional" },
  { code: "MS", name: "Morgan Stanley Sekuritas", category: "institutional" },
  { code: "CP", name: "JP Morgan Sekuritas Indonesia", category: "institutional" },
  { code: "CS", name: "Credit Suisse Sekuritas", category: "institutional" },
  { code: "BK", name: "BNI Sekuritas", category: "institutional" },
  { code: "LP", name: "Panin Sekuritas", category: "institutional" },
  { code: "YJ", name: "NH Korindo Sekuritas", category: "institutional" },
  { code: "FG", name: "Phillip Sekuritas Indonesia", category: "institutional" },
  { code: "OD", name: "OCBC Sekuritas Indonesia", category: "institutional" },
  { code: "BS", name: "Sinarmas Sekuritas", category: "institutional" },
  // Local/Retail
  { code: "AI", name: "Ajaib Sekuritas Asia", category: "retail" },
  { code: "SQ", name: "Stockbit Sekuritas", category: "retail" },
  { code: "XC", name: "BNI Sekuritas (Sub)", category: "retail" },
  { code: "XL", name: "Macquarie Sekuritas (Sub)", category: "retail" },
  { code: "KK", name: "Mandiri Sekuritas (Online)", category: "retail" },
  { code: "IF", name: "Phintraco Sekuritas", category: "retail" },
  { code: "BZ", name: "KGI Sekuritas Indonesia", category: "retail" },
  { code: "DR", name: "Samuel Sekuritas", category: "retail" },
  { code: "IS", name: "Indo Capital Sekuritas", category: "retail" },
  { code: "EL", name: "Surya Fajar Sekuritas", category: "retail" },
  { code: "RI", name: "BRI Danareksa Sekuritas", category: "retail" },
  // Foreign
  { code: "CG", name: "HSBC Sekuritas Indonesia", category: "foreign" },
  { code: "BW", name: "Citigroup Sekuritas Indonesia", category: "foreign" },
  { code: "GL", name: "Goldman Sachs Sekuritas", category: "foreign" },
  { code: "LG", name: "CIMB-GK Sekuritas", category: "foreign" },
  { code: "DP", name: "DBS Vickers Sekuritas", category: "foreign" },
  { code: "MU", name: "Samsung Sekuritas Indonesia", category: "foreign" },
  { code: "IP", name: "Victoria Sekuritas Indonesia", category: "foreign" },
  { code: "PC", name: "Jasa Utama Capital", category: "foreign" },
  { code: "PF", name: "Waterfront Sekuritas", category: "foreign" },
  { code: "PS", name: "Kresna Sekuritas", category: "foreign" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

function formatVal(val) {
  const n = Number(val);
  if (n >= 1e12) return (n / 1e12).toFixed(1) + 'T';
  if (n >= 1e9)  return (n / 1e9).toFixed(1)  + 'B';
  if (n >= 1e6)  return (n / 1e6).toFixed(1)  + 'M';
  if (n >= 1e3)  return (n / 1e3).toFixed(1)  + 'K';
  return n.toString();
}

function formatLot(lot) {
  const n = Number(lot);
  if (n >= 1e9)  return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6)  return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3)  return (n / 1e3).toFixed(1) + 'K';
  return n.toString();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Index Alpha API Integration ─────────────────────────────────────────────
async function fetchIndexAlpha(ticker, fromDate, toDate, investor = 'all', market = null) {
  const marketQs = market ? `&market=${market}` : '';
  const url = `${INDEX_ALPHA_BASE}/stocks/broker-summary?ticker=${ticker}&from=${fromDate}&to=${toDate || fromDate}&investor=${investor}${marketQs}`;
  console.log(`  📡 IndexAlpha: ${ticker} (${fromDate}) investor=${investor}${market ? ' market=' + market : ''}...`);
  try {
    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${INDEX_ALPHA_KEY}`,
        'Accept': 'application/json',
      },
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.log(`    ❌ HTTP ${resp.status}: ${text.slice(0, 100)}`);
      return [];
    }
    const json = await resp.json();
    if (!json.success || !Array.isArray(json.data)) return [];
    
    // Transform to our format: one row per broker for this stock
    return json.data.map(b => ({
      date: fromDate,
      brokerCode: b.code,
      stockCode: ticker,
      buyVal: Math.round(b.buy_value || 0),
      buyLot: Math.round(b.buy_volume || 0),
      buyAvg: Math.round(b.buy_avg || 0),
      sellVal: Math.round(b.sell_value || 0),
      sellLot: Math.round(b.sell_volume || 0),
      sellAvg: Math.round(b.sell_avg || 0),
      netVal: Math.round((b.buy_value || 0) - (b.sell_value || 0)),
    }));
  } catch (err) {
    console.log(`    ❌ IndexAlpha error: ${err.message}`);
    return [];
  }
}

// Pull all broker data for a single stock
async function pullStockFromIndexAlpha(ticker, date) {
  const records = await fetchIndexAlpha(ticker, date);
  if (records.length === 0) return 0;
  const saved = await saveBrokerData(records);
  console.log(`    ✅ ${ticker}: ${saved} broker records saved`);
  return saved;
}

// ─── Auto-Calculate Concentration from Broker Data ───────────────────────────
// Calculates top-3 broker net flow / total turnover = concentration %
// Same logic as FT.id but computed from our own idx_broker_summary data
// This eliminates dependency on unreliable FT.id Puppeteer scraping
async function autoCalculateConcentration(targetDate, force = false) {
  const toStr = d => (d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0]);
  const date = targetDate || getTodayDate();

  // Check if we already have concentration data for this date (skipped when force=true,
  // e.g. re-running the whole history after the RG+NG blended formula changed).
  if (!force) {
    const [existing] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM idx_concentration WHERE data_date = ?', [date]
    );
    if (existing[0].cnt > 50) {
      console.log(`  📊 [CONC] ${date}: already has ${existing[0].cnt} stocks, skipping`);
      return { date, stocks: existing[0].cnt, source: 'existing' };
    }
  }

  // Get all stocks with broker data on this date
  const [stockRows] = await pool.query(`
    SELECT stock_code, SUM(buy_val + sell_val) AS total_turnover
    FROM idx_broker_summary WHERE date = ?
    GROUP BY stock_code HAVING total_turnover > 0
  `, [date]);

  if (stockRows.length === 0) {
    console.log(`  📊 [CONC] ${date}: no broker data found`);
    return { date, stocks: 0, source: 'no_data' };
  }

  // Get last 5 trading days (for dn0..dn4)
  const [dateRows] = await pool.query(
    'SELECT DISTINCT date FROM idx_broker_summary WHERE date <= ? ORDER BY date DESC LIMIT 5', [date]
  );
  const tradingDates = dateRows.map(r => toStr(r.date));

  // How much to favor negotiated/block-deal (NG) concentration over regular-market
  // (RG) concentration when a stock had NG activity that day. NG trades are large,
  // privately-negotiated blocks — a cleaner "smart money" signal than the noisier RG
  // order book (retail + institutional mixed). This is a documented heuristic, not
  // an empirically-optimized weight — easy to retune once we have enough outcome
  // history to actually validate it. Falls back to pure RG (today's prior behavior,
  // zero regression) whenever a stock has no NG data for that day, which covers
  // every date the idx_broker_flow_detail backfill hasn't reached yet.
  const NG_WEIGHT = 0.6;

  let saved = 0;
  for (const stock of stockRows) {
    const ticker = stock.stock_code;
    const dnValues = [];

    // Calculate concentration for each of last 5 days
    for (const d of tradingDates) {
      const [topBrokers] = await pool.query(`
        SELECT (buy_val - sell_val) AS net
        FROM idx_broker_summary WHERE date = ? AND stock_code = ?
        ORDER BY ABS(buy_val - sell_val) DESC LIMIT 3
      `, [d, ticker]);
      const [totRow] = await pool.query(`
        SELECT SUM(ABS(buy_val - sell_val)) AS total_net
        FROM idx_broker_summary WHERE date = ? AND stock_code = ?
      `, [d, ticker]);
      const topNet = topBrokers.reduce((a, b) => a + Number(b.net), 0);
      // totalNet is a SUM(ABS(...)) so it's never negative — only 0 or null
      // when there's no broker data for this stock/day. The old `|| 1`
      // fallback divided topNet by 1 instead of the true (missing) total,
      // which could blow concRG up to ±hundreds instead of the ±100 the
      // formula is mathematically bounded to otherwise (topNet is a sum
      // over a subset of the same signed values totalNet sums the absolute
      // value of, so |topNet| <= totalNet whenever totalNet is real).
      // Confirmed in production data: 84/25946 rows exceeded ±100, all
      // traced to this fallback. No data that day = no concentration signal
      // = neutral 0, not a division artifact.
      const totalNet = Number(totRow[0]?.total_net) || 0;
      const concRG = totalNet > 0 ? (topNet / totalNet) * 100 : 0;

      // Blend in NG concentration when available — same top-3-broker-by-|net|
      // methodology, aggregated across foreign+domestic, scoped to market_segment='NG'.
      const [topNG] = await pool.query(`
        SELECT broker_code, SUM(net_val) AS net
        FROM idx_broker_flow_detail WHERE date = ? AND stock_code = ? AND market_segment = 'NG'
        GROUP BY broker_code ORDER BY ABS(SUM(net_val)) DESC LIMIT 3
      `, [d, ticker]);
      const [totNGRow] = await pool.query(`
        SELECT SUM(ABS(net_val)) AS total_net
        FROM idx_broker_flow_detail WHERE date = ? AND stock_code = ? AND market_segment = 'NG'
      `, [d, ticker]);
      const totalNGNet = Number(totNGRow[0]?.total_net) || 0;

      let blended = concRG;
      if (totalNGNet > 0) {
        const topNGNet = topNG.reduce((a, b) => a + Number(b.net), 0);
        const concNG = (topNGNet / totalNGNet) * 100;
        blended = concRG * (1 - NG_WEIGHT) + concNG * NG_WEIGHT;
      }

      dnValues.push(Math.round(blended * 10) / 10); // 1 decimal %
    }

    // dnValues[0] = latestDate (dn0), [1] = day before (dn1), etc.
    const dn0 = dnValues[0] ?? 0;
    const dn1 = dnValues[1] ?? 0;
    const dn2 = dnValues[2] ?? 0;
    const dn3 = dnValues[3] ?? 0;
    const dn4 = dnValues[4] ?? 0;

    // Get price info from idx_stock_prices or Yahoo cache
    const [priceRow] = await pool.query(
      'SELECT close_price, change_pct FROM idx_stock_prices WHERE stock_code = ? AND date = ? LIMIT 1',
      [ticker, date]
    );
    const price = priceRow.length > 0 ? Number(priceRow[0].close_price) : 0;
    const changePct = priceRow.length > 0 ? Number(priceRow[0].change_pct) : 0;

    // total_turnover was already computed for this ticker in the stockRows query
    // above — it's the same value the (broken) Daily Picks liquidity filter
    // (last_val > 10B) needs. Neither this function nor the since-retired FT.id
    // pull wrote last_val before, so that filter had been silently returning zero
    // rows. This is now the only writer of last_val, which is why the ~620 tickers
    // the FT.id pull left behind have dn0 but no turnover figure.
    const lastVal = Math.round(Number(stock.total_turnover) || 0);

    await pool.query(`
      INSERT INTO idx_concentration (data_date, stock_code, dn0, dn1, dn2, dn3, dn4, price, change_pct, last_val)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE dn0=VALUES(dn0),dn1=VALUES(dn1),dn2=VALUES(dn2),
        dn3=VALUES(dn3),dn4=VALUES(dn4),price=VALUES(price),change_pct=VALUES(change_pct),
        last_val=VALUES(last_val),fetched_at=NOW()
    `, [date, ticker, dn0, dn1, dn2, dn3, dn4, price, changePct, lastVal]);
    saved++;
  }

  console.log(`  📊 [CONC] ${date}: calculated & stored ${saved} stocks from broker data`);
  return { date, stocks: saved, source: 'auto-calculated' };
}

// ─── Auto-Cron: Daily Stock Pull via Index Alpha ─────────────────────────────
let cronRunning = false;
let cronStatus = { lastRun: null, lastResult: null, nextRun: null, running: false };
// Outcome of the index/benchmark refreshes below — previously only console-
// logged (and lost the moment logs rotate/flush), so idx_ihsg_history went
// stale for a week (2026-07-22 → 2026-07-30, discovered live 2026-07-30) with
// no trace of why once logs were gone. Now surfaced in /api/cron/status too,
// so a silent gap like that is visible without needing historical logs.
let auxRefreshStatus = { ihsg: null, sp500: null, usStocks: null };

async function runDailyCron(dateOverride) {
  if (cronRunning) {
    console.log('⏳ Cron already running, skipping...');
    return { skipped: true };
  }
  cronRunning = true;
  cronStatus.running = true;
  const date = dateOverride || getTodayDate();
  console.log(`\n🕐 [CRON] Starting daily pull via Index Alpha for ${date} — ${TOP_STOCKS.length} stocks`);

  try {
    const r = await fetchAndCacheIHSG();
    auxRefreshStatus.ihsg = { ok: true, at: new Date().toISOString(), ...r };
    console.log('  📈 IHSG history refreshed');
  } catch (e) {
    auxRefreshStatus.ihsg = { ok: false, at: new Date().toISOString(), error: e.message };
    console.log('  ⚠️ IHSG refresh failed:', e.message);
  }
  try {
    const r = await fetchAndCacheSP500();
    auxRefreshStatus.sp500 = { ok: true, at: new Date().toISOString(), ...r };
    console.log('  📈 S&P 500 history refreshed');
  } catch (e) {
    auxRefreshStatus.sp500 = { ok: false, at: new Date().toISOString(), error: e.message };
    console.log('  ⚠️ S&P 500 refresh failed:', e.message);
  }
  try {
    const r = await refreshUSStockPrices();
    auxRefreshStatus.usStocks = { ok: true, at: new Date().toISOString(), updated: r.updated };
    console.log(`  📈 US stock prices refreshed (${r.updated} tickers)`);
  } catch (e) {
    auxRefreshStatus.usStocks = { ok: false, at: new Date().toISOString(), error: e.message };
    console.log('  ⚠️ US stock price refresh failed:', e.message);
  }

  const results = { date, started: new Date().toISOString(), stocks: {}, totalRecords: 0 };
  
  for (let i = 0; i < TOP_STOCKS.length; i++) {
    const ticker = TOP_STOCKS[i];
    console.log(`  [${i+1}/${TOP_STOCKS.length}] ${ticker}...`);
    
    try {
      // Check if data exists for this stock+date
      const [existing] = await pool.query(
        'SELECT COUNT(*) as cnt FROM idx_broker_summary WHERE stock_code = ? AND date = ?',
        [ticker, date]
      );
      
      if (existing[0].cnt > 5) { // at least 5 brokers already loaded
        results.stocks[ticker] = { status: 'cached', records: existing[0].cnt };
        results.totalRecords += existing[0].cnt;
        console.log(`    → Already has ${existing[0].cnt} records, skipping`);
        continue;
      }
      
      const saved = await pullStockFromIndexAlpha(ticker, date);
      results.stocks[ticker] = { status: saved > 0 ? 'pulled' : 'empty', records: saved };
      results.totalRecords += saved;

      // Detailed foreign/domestic x RG/NG breakdown (separate table, own cache check)
      const [existingDetail] = await pool.query(
        'SELECT COUNT(*) as cnt FROM idx_broker_flow_detail WHERE stock_code = ? AND date = ?',
        [ticker, date]
      );
      if (existingDetail[0].cnt === 0) {
        await pullDetailedFlowForStock(ticker, date).catch(e => console.log(`    → flow-detail error: ${e.message}`));
      }
    } catch (err) {
      results.stocks[ticker] = { status: 'error', error: err.message };
      console.log(`    → Error: ${err.message}`);
    }
    
    // Small delay between requests
    await delay(500);
  }
  
  // Also fetch stock prices from Yahoo for all stocks
  console.log('  📈 Fetching stock prices from Yahoo...');
  for (const ticker of TOP_STOCKS) {
    try {
      const p = await fetchYahooPrice(ticker);
      if (p) {
        await pool.query(`
          INSERT INTO idx_stock_prices (date, stock_code, open_price, high_price, low_price, close_price, volume, prev_close, change_pct)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE close_price = VALUES(close_price), change_pct = VALUES(change_pct), volume = VALUES(volume)
        `, [date, ticker, p.open, p.high, p.low, p.price, p.volume, p.prevClose, p.changePct]);
      }
    } catch (_) { /* skip individual failures */ }
    await delay(300);
  }
  
  try { await saveIHSGFactorSnapshot(); console.log('  📊 IHSG factor snapshot saved'); } catch (e) { console.log('  ⚠️ IHSG factor snapshot failed:', e.message); }

  results.completed = new Date().toISOString();
  cronRunning = false;
  cronStatus = { lastRun: results.completed, lastResult: results, nextRun: getNextCronTime(), running: false };
  console.log(`\n✅ [CRON] Complete! ${results.totalRecords} total records for ${date}\n`);
  return results;
}

function getNextCronTime() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(12, 30, 0, 0); // 12:30 UTC = 19:30 WIB // 16:30 WIB — Index Alpha updates at 19:00 WIB
  if (next <= now) next.setDate(next.getDate() + 1);
  // Skip weekends
  while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

// ── Auto-status updater (called in daily cron) ─────────────────
// Moved to true top-level scope 2026-07-30: this was previously declared
// INSIDE async function main() (much further down the file, alongside a
// batch of route registrations that intentionally run only after
// setupDB() resolves). That made it invisible to scheduleDailyCron() below
// — a sibling, OUTER-scope function that also calls it — since function-
// declaration hoisting only reaches the top of ITS OWN enclosing scope
// (main()'s body), not out to sibling functions. Every time the fresh-
// process interval fired here before the daily catch-up logic had already
// marked today as done, this was a live ReferenceError that crashed the
// whole process (caught in production on 2026-07-30 at the 19:30 WIB cron
// trigger, aborting that night's entire scrape+AWO pipeline before it could
// even start). Only depends on module-scope `pool`/`fetchYahooPrices`, so
// relocating it here doesn't change behavior for its OTHER call site
// (POST /api/recommendations/update-statuses, still inside main() — that
// one was always fine, since main() calling its own nested declaration
// works regardless of position).
async function updateRecommendationStatuses() {
  try {
    const [open] = await pool.query(
      `SELECT id, ticker, direction, entry_min, entry_max, stop_loss, target_1, target_2, detected_date
       FROM ft_recommendations WHERE status='OPEN'`
    );
    if (open.length === 0) return;

    const tickers = [...new Set(open.map(r => r.ticker))];
    const yfPrices = await fetchYahooPrices(tickers);

    const today = new Date().toISOString().slice(0,10);
    for (const ticker of tickers) {
      if (yfPrices[ticker]?.price) {
        try {
          await pool.query(
            `INSERT INTO ft_price_ohlc (ticker, date, close_price) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE close_price=VALUES(close_price)`,
            [ticker, today, yfPrices[ticker].price]
          );
        } catch(e) {}
      }
    }

    const prices = {};
    for (const ticker of tickers) {
      if (yfPrices[ticker]?.price) {
        prices[ticker] = yfPrices[ticker].price;
      } else {
        const [[row]] = await pool.query(
          `SELECT close_price FROM ft_price_ohlc WHERE ticker=? ORDER BY date DESC LIMIT 1`,
          [ticker]
        );
        if (row) prices[ticker] = row.close_price;
      }
    }

    for (const rec of open) {
      const price = prices[rec.ticker];
      if (!price) continue;
      const entry = (Number(rec.entry_min) + Number(rec.entry_max)) / 2;
      let newStatus = null, result_pct = null;

      if (rec.direction === 'BULLISH') {
        if (price >= rec.target_2)    { newStatus = 'HIT_T2'; result_pct = ((rec.target_2 - entry) / entry * 100).toFixed(2); }
        else if (price >= rec.target_1) { newStatus = 'HIT_T1'; result_pct = ((rec.target_1 - entry) / entry * 100).toFixed(2); }
        else if (price <= rec.stop_loss){ newStatus = 'STOPPED'; result_pct = ((price - entry) / entry * 100).toFixed(2); }
      } else {
        if (price <= rec.target_2)    { newStatus = 'HIT_T2'; result_pct = ((entry - rec.target_2) / entry * 100).toFixed(2); }
        else if (price <= rec.target_1) { newStatus = 'HIT_T1'; result_pct = ((entry - rec.target_1) / entry * 100).toFixed(2); }
        else if (price >= rec.stop_loss){ newStatus = 'STOPPED'; result_pct = ((entry - price) / entry * 100).toFixed(2); }
      }

      // Expiry must outlast the holding horizon, or a position gets closed as
      // EXPIRED while its thesis is still legitimately running. The old fixed
      // 30 days was consistent with the 15-bar swing horizon (~3 calendar
      // weeks) but would guillotine a 40-bar position trade (~8 weeks) at the
      // halfway mark, silently converting winners into EXPIRED rows.
      const age = (Date.now() - new Date(rec.detected_date).getTime()) / 86400000;
      if (!newStatus && age > TRADE_POLICY.journalExpiryDays) newStatus = 'EXPIRED';

      if (newStatus) {
        await pool.query(
          `UPDATE ft_recommendations SET status=?, result_pct=?, closed_price=?, closed_date=CURDATE() WHERE id=?`,
          [newStatus, result_pct, price, rec.id]
        );
        console.log(`[REC] ${rec.ticker} ${rec.direction} -> ${newStatus} (${result_pct}%)`);
      }
    }
  } catch (err) {
    console.error('[updateRecommendationStatuses]', err.message);
  }
}

function scheduleDailyCron() {
  const checkInterval = 30000; // check every 30 seconds (more reliable)
  let lastCronDate = null; // track which date we last ran for (prevents double-runs)
  cronStatus.nextRun = getNextCronTime();
  
  // ── STARTUP: Catch-up any missing days ────────────────────────────────────
  (async () => {
    try {
      const [[row]] = await pool.query('SELECT MAX(date) AS d FROM idx_broker_summary');
      const lastDataDate = row?.d ? (row.d instanceof Date ? row.d.toISOString().split('T')[0] : String(row.d).split('T')[0]) : null;
      const today = getTodayDate();
      if (lastDataDate && lastDataDate < today) {
        // Check if it's after 12:30 UTC (data should be available)
        const now = new Date();
        if (now.getUTCHours() >= 13 || (now.getUTCHours() === 12 && now.getUTCMinutes() >= 30)) {
          console.log(`   🔄 [CRON] Catch-up: last data is ${lastDataDate}, today is ${today}`);
          // Run for today
          lastCronDate = today;
          runDailyCron().then(() => {
            console.log('📊 [CRON] Catch-up: auto-calculating concentration...');
            return autoCalculateConcentration(today);
          }).then(r => {
            console.log(`✅ [CRON] Catch-up complete: ${r?.stocks || 0} stocks`);
          }).catch(e => console.error('Catch-up cron error:', e.message));
        }
      } else {
        lastCronDate = lastDataDate; // Already up to date, prevent re-run
      }
    } catch (e) {
      console.error('Catch-up check error:', e.message);
    }
  })();

  // ── DAILY: Reliable interval-based cron ───────────────────────────────────
  setInterval(() => {
    const now = new Date();
    const utcHours = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    const day = now.getUTCDay(); // 0=Sun, 6=Sat
    const today = getTodayDate();
    
    // Fire condition: weekday, after 12:30 UTC (19:30 WIB), haven't run today yet
    const isWeekday = day >= 1 && day <= 5;
    const isAfterCronTime = utcHours > 12 || (utcHours === 12 && utcMinutes >= 30);
    const notRunToday = lastCronDate !== today;
    
    if (isWeekday && isAfterCronTime && notRunToday && !cronRunning) {
      lastCronDate = today; // Mark as run IMMEDIATELY to prevent double-trigger
      console.log(`🕐 [CRON] Scheduled daily pull triggered for ${today}!`);
      updateRecommendationStatuses().catch(e => console.error('rec update err:', e.message));
      runDailyCron()
        .then(() => {
          // PRIMARY: Auto-calculate concentration from our own broker data
          console.log('📊 [CRON] Auto-calculating concentration from broker data...');
          return autoCalculateConcentration(today);
        })
        .then(calcResult => {
          console.log(`✅ [CRON] Concentration auto-calc complete: ${calcResult?.stocks || 0} stocks`);
        })
        .then(() => {
          // AUTO: Run harmonic pattern scan on all tracked stocks
          console.log('🔍 [CRON] Running daily harmonic pattern scan...');
          const http = require('http');
          return new Promise((resolve) => {
            http.get(`http://127.0.0.1:${PORT}/api/harmonic-scan?min_score=40&min_rr=1.2`, (resp) => {
              let data = '';
              resp.on('data', c => data += c);
              resp.on('end', () => {
                try {
                  const json = JSON.parse(data);
                  const patternCount = json.patterns?.length || json.results?.length || 0;
                  console.log(`✅ [CRON] Pattern scan complete: ${patternCount} patterns found`);
                  // Auto-save detected patterns as recommendations
                  if (patternCount > 0) {
                    const patterns = json.patterns || json.results || [];
                    const toSave = patterns.slice(0, 20).map(p => ({
                      ticker: p.ticker,
                      pattern_type: p.pattern_type || p.pattern,
                      direction: p.direction || 'BULLISH',
                      D_date: today,
                      entry_min: p.entry_min || p.entry || p.prz_low || 0,
                      entry_max: p.entry_max || p.entry || p.prz_high || 0,
                      stop_loss: p.stop_loss || p.sl || 0,
                      target_1: p.target_1 || p.tp1 || 0,
                      target_2: p.target_2 || p.tp2 || 0,
                      risk_reward: p.risk_reward || 0,
                      conviction_score: p.conviction_score || 0,
                      smart_money_confirmed: p.smart_money_aligned ? 1 : 0,
                      foreign_3d_B: p.foreign_3d_B || 0,
                      pattern_data: p,
                    }));
                    http.request({
                      hostname: '127.0.0.1', port: PORT, path: '/api/recommendations/bulk',
                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                    }, () => {}).end(JSON.stringify({ patterns: toSave }));
                    console.log(`💾 [CRON] Auto-saved ${toSave.length} patterns as recommendations`);
                  }
                } catch (e) { console.log(`⚠️ [CRON] Pattern scan parse error: ${e.message}`); }
                resolve();
              });
            }).on('error', (e) => {
              console.log(`⚠️ [CRON] Pattern scan failed: ${e.message}`);
              resolve();
            });
          });
        })
        .then(() => {
          // ── AWO: Autonomous Learning Pipeline ──────────────────────────
          console.log('🧠 [AWO-CRON] Starting autonomous learning pipeline...');
          return (async () => {
            try {
              // Step 1: Update outcomes for past signals
              console.log('🧠 [AWO-CRON] Step 1/5: Updating signal outcomes...');
              const http = require('http');
              const postJSON = (path) => new Promise((resolve) => {
                const req = http.request({
                  hostname: '127.0.0.1', port: PORT, path,
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'x-admin-key': process.env.ADMIN_API_KEY || '' },
                  timeout: 30000,
                }, (resp) => {
                  let data = '';
                  resp.on('data', c => data += c);
                  resp.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
                });
                req.on('error', () => resolve({}));
                req.on('timeout', () => { req.destroy(); resolve({}); });
                req.end();
              });
              const getJSON = (path) => new Promise((resolve) => {
                http.get(`http://127.0.0.1:${PORT}${path}`, { timeout: 60000 }, (resp) => {
                  let data = '';
                  resp.on('data', c => data += c);
                  resp.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
                }).on('error', () => resolve({})).on('timeout', () => resolve({}));
              });
              
              const outcomeResult = await postJSON('/api/signal-scanner/update-outcomes');
              console.log(`🧠 [AWO-CRON] Outcomes updated: ${outcomeResult.updated || 0} signals`);

              // Step 2: Calculate technical factors for new signals
              console.log('🧠 [AWO-CRON] Step 2/5: Calculating technical factors...');
              const { calcTechnicalBatch } = require('./awo_technical');
              const [newSignals] = await pool.query(
                'SELECT id, stock_code, data_date FROM idx_signal_history WHERE f10_macd IS NULL'
              );
              if (newSignals.length > 0) {
                // Group by data_date so calcTechnicalBatch (single asOfDate cutoff) runs once
                // per distinct date instead of once per signal row.
                const byDate = new Map();
                for (const sig of newSignals) {
                  const dateStr = sig.data_date instanceof Date
                    ? sig.data_date.toISOString().slice(0, 10) : String(sig.data_date);
                  if (!byDate.has(dateStr)) byDate.set(dateStr, []);
                  byDate.get(dateStr).push(sig);
                }
                for (const [dateStr, sigs] of byDate) {
                  const tickers = [...new Set(sigs.map(s => s.stock_code))];
                  const techResults = await calcTechnicalBatch(pool, tickers, dateStr, 60);
                  for (const sig of sigs) {
                    const tech = techResults[sig.stock_code];
                    if (tech) {
                      await pool.query(
                        `UPDATE idx_signal_history
                         SET f9_rsi=?, f10_macd=?, f11_bollinger=?,
                             f12_ema_trend=?, f13_support_resistance=?, f14_atr=?
                         WHERE id=?`,
                        [tech.f9, tech.f10, tech.f11, tech.f12, tech.f13, tech.f14, sig.id]
                      );
                    }
                  }
                }
                console.log(`🧠 [AWO-CRON] Technical factors: ${newSignals.length} signals updated`);
              } else {
                console.log('🧠 [AWO-CRON] Technical factors: all up to date');
              }

              // Step 3: Detect market regime
              console.log('🧠 [AWO-CRON] Step 3/5: Detecting market regime...');
              const regimeResult = await getJSON('/api/awo/regime');
              console.log(`🧠 [AWO-CRON] Regime: ${regimeResult?.current?.regime || 'DEFAULT'} (${regimeResult?.current?.confidence || 0}% confidence)`);

              // Step 4: Run optimizer
              console.log('🧠 [AWO-CRON] Step 4/5: Running weight optimizer...');
              // Research-only: this NEVER adopts weights automatically. A candidate
              // that clears every safeguard is reported as eligibleForChallenger,
              // frozen as the active challenger (see getOrFreezeChallenger), and
              // saved to AWO_RESULT_FILE — but adopting a challenger into live
              // scoring always requires a separate, explicit
              // POST /api/awo/optimize/promote call once it clears the paper-
              // trading gate too; the nightly cron intentionally does not make
              // that call itself.
              const optResult = await postJSON('/api/awo/optimize/run');
              if (optResult.eligibleForChallenger) {
                console.log(`🧠 [AWO-CRON] ✅ Candidate eligible! WR: ${optResult.baseline?.validateWinRate}% → ${optResult.optimized?.validateWinRate}% (+${optResult.optimized?.improvement}%) — ${optResult.message}`);
              } else if (optResult.status === 'COOLDOWN') {
                console.log(`🧠 [AWO-CRON] ⏳ Optimizer in cooldown: ${optResult.message}`);
              } else if (optResult.optimized) {
                console.log(`🧠 [AWO-CRON] ⚡ No candidate cleared safeguards (best: +${optResult.optimized?.improvement}%)`);
              } else {
                console.log(`🧠 [AWO-CRON] ⚠️ Optimizer status: ${optResult.status || optResult.error || 'unknown'}`);
              }

              // Step 5: Paper trading (P1 follow-up #18, redesigned 2026-07-31 —
              // external review; freeze call removed from here 2026-07-31,
              // round 3 finding #10 — Step 4 above already hit POST /run,
              // which now freezes an eligible candidate as the challenger
              // itself, the exact same code path a manual /run uses. Calling
              // getOrFreezeChallenger a second time here would just be a
              // harmless no-op read (it's idempotent once a challenger is
              // PAPER_TESTING under the current modelVersion), so it's
              // simpler to trust optResult.challenger, which /run already
              // reported. Paper trades are always generated for the FROZEN
              // CHALLENGER, never for "whatever /run happened to find
              // tonight" — see getOrFreezeChallenger's doc comment for why
              // that distinction is load-bearing. Never itself decides
              // promotion — /api/awo/optimize/promote reads this data and
              // gates on it.
              console.log('🧠 [AWO-CRON] Step 5/5: Paper trading...');
              try {
                const { generatePaperTrades, resolvePaperTrades } = require('./modules/paper_trading');
                const { entriesFilled, resolved } = await resolvePaperTrades(pool);
                console.log(`🧠 [AWO-CRON] Paper trades advanced: ${entriesFilled} entries filled, ${resolved} resolved`);

                if (optResult.challenger) {
                  console.log(optResult.challenger.justFrozen
                    ? `🧠 [AWO-CRON] ❄️ New challenger frozen for paper trading (key ${optResult.challenger.candidateKey.slice(0, 8)}...)`
                    : `🧠 [AWO-CRON] Research found a candidate, but challenger ${optResult.challenger.candidateKey.slice(0, 8)}... is already under paper testing — not replacing it`);
                }

                const activeChallenger = loadChallenger();
                if (activeChallenger?.status === 'PAPER_TESTING') {
                  const { generated, dateStr } = await generatePaperTrades(pool, activeChallenger.weights, activeChallenger.thresholds, activeChallenger.candidateKey);
                  console.log(`🧠 [AWO-CRON] Paper trades generated for active challenger (${dateStr}): ${generated}`);
                }
              } catch (e) {
                console.error('🧠 [AWO-CRON] Paper trading step error:', e.message);
              }

              console.log('🧠 [AWO-CRON] ✅ Autonomous learning pipeline complete!');
            } catch (e) {
              console.error('🧠 [AWO-CRON] Pipeline error:', e.message);
            }
          })();
        })
        .catch(err => {
          console.error('Cron error:', err.message);
          // Reset lastCronDate on error so it retries next check
          lastCronDate = null;
        });
    }
  }, checkInterval);
  
  console.log(`   ⏰ Daily cron scheduled for 19:30 WIB (Mon-Fri) [robust mode]`);
  console.log(`   ⏭️  Next run: ${cronStatus.nextRun}`);
}

// ─── Cron API Endpoints ──────────────────────────────────────────────────────

// POST /api/cron/run — Manually trigger daily scrape
app.post('/api/cron/run', requireAdminKey, async (req, res) => {
  const { date } = req.body;
  if (cronRunning) return res.json({ error: 'Cron already running', status: cronStatus });
  
  // Run async, don't wait
  runDailyCron(date).catch(err => console.error('Manual cron error:', err));
  res.json({ started: true, date: date || getTodayDate(), message: 'Cron started in background' });
});

// GET /api/cron/status — Check cron status
app.get('/api/cron/status', (req, res) => {
  res.json({ ...cronStatus, auxRefreshStatus });
});

// ─── System health & the signal kill switch (2026-08-03) ─────────────────────
// auxRefreshStatus above is in-process and lost on restart, and it depends on a
// job surviving long enough to report itself. `signal_engine.py hk` failed 45
// consecutive times with a SyntaxError and nothing here noticed, because a job
// that crashes cannot report that it crashed. These two routes derive health
// from the DATA instead, which cannot lie about whether it arrived.
app.get('/api/system/health', async (req, res) => {
  try {
    const [fresh, jobs] = await Promise.all([
      systemHealth.dataFreshness(pool),
      systemHealth.jobHealth(pool),
    ]);
    res.json({ ok: true, freshness: fresh, jobs, auxRefreshStatus, checkedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// The kill switch. DISABLED means produce no actionable output — a warning shown
// beside a signal still reads as a signal.
app.get('/api/system/signal-state', async (req, res) => {
  try {
    const state = await systemHealth.signalState(pool, {
      expectedModelVersion: AWO_MODEL_VERSION,
      actualModelVersion: AWO_MODEL_VERSION,
    });
    res.json(state);
  } catch (e) {
    // Fail CLOSED: if the health check itself is broken we cannot claim the
    // inputs are sound, so signals are disabled rather than assumed fine.
    res.status(500).json({ enabled: false, reasons: [`HEALTH_CHECK_FAILED:${e.message}`], checkedAt: new Date().toISOString() });
  }
});

// GET /api/indexalpha/pull — Pull broker summary for specific stock(s) via Index Alpha
app.get('/api/indexalpha/pull', requireAdminKey, async (req, res) => {
  const ticker = (req.query.ticker || '').toUpperCase();
  const date = req.query.date || getTodayDate();
  
  if (!ticker) {
    return res.json({ error: 'ticker required (e.g. ?ticker=BBCA&date=2026-04-29)' });
  }
  
  try {
    const saved = await pullStockFromIndexAlpha(ticker, date);
    res.json({ success: true, ticker, date, recordsSaved: saved, source: 'IndexAlpha' });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// GET /api/indexalpha/usage — Check IndexAlpha usage
app.get('/api/indexalpha/usage', async (req, res) => {
  try {
    const resp = await fetch(`${INDEX_ALPHA_BASE}/usage`, {
      headers: { 'Authorization': `Bearer ${INDEX_ALPHA_KEY}`, 'Accept': 'application/json' },
    });
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.json({ error: err.message });
  }
});

// GET /api/indexalpha/backfill?days=10&from=2026-04-29&force=true — Backfill historical data
let backfillRunning = false;
app.get('/api/indexalpha/backfill', requireAdminKey, async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 10, 365); // max 365 trading days
  const fromDate = req.query.from;
  
  if (backfillRunning) {
    return res.json({ error: 'Backfill already running' });
  }
  
  // Generate list of trading days (skip weekends)
  const tradingDays = [];
  const start = fromDate ? new Date(fromDate + 'T12:00:00') : new Date();
  let cursor = new Date(start);
  
  for (let i = 0; tradingDays.length < days; i++) {
    cursor.setDate(cursor.getDate() - (tradingDays.length === 0 && !fromDate ? 0 : 1));
    const dow = cursor.getDay();
    if (dow === 0 || dow === 6) continue; // skip weekends
    const dateStr = cursor.toISOString().split('T')[0];
    tradingDays.push(dateStr);
    if (i > 730) break; // safety (2 years max)
  }
  
  console.log(`\n📅 [BACKFILL] Starting for ${tradingDays.length} trading days: ${tradingDays.join(', ')}`);
  res.json({ started: true, tradingDays, estimatedCalls: tradingDays.length * TOP_STOCKS.length });
  
  const force = req.query.force === 'true';
  
  // Run in background
  backfillRunning = true;
  try {
    for (const date of tradingDays) {
      console.log(`\n📅 [BACKFILL] Processing ${date}...`);
      
      // Check if this date already has decent data (skip unless force=true)
      if (!force) {
        const [existing] = await pool.query(
          'SELECT COUNT(*) as cnt FROM idx_broker_summary WHERE date = ?', [date]
        );
        if (existing[0].cnt > 100) {
          console.log(`   → ${date}: already has ${existing[0].cnt} records, skipping (use force=true to re-pull)`);
          continue;
        }
      } else {
        console.log(`   → ${date}: force re-pull enabled`);
      }
      
      for (let i = 0; i < TOP_STOCKS.length; i++) {
        const ticker = TOP_STOCKS[i];
        try {
          const saved = await pullStockFromIndexAlpha(ticker, date);
          if (saved === 0) {
            // If first stock returns empty, likely no data for this date
            if (i === 0) {
              console.log(`   → ${date}: No data available (market closed?), skipping rest`);
              break;
            }
          }
        } catch (err) {
          console.log(`   → Error ${ticker}/${date}: ${err.message}`);
        }
        await delay(400); // rate limit
      }
    }
    console.log(`\n✅ [BACKFILL] Complete!`);
  } catch (err) {
    console.error(`❌ [BACKFILL] Error: ${err.message}`);
  } finally {
    backfillRunning = false;
  }
});


// ════════════════════════════════════════════════════════════════════
// CMS CONFIG — load broker categories + watchlist from DB dynamically
// ════════════════════════════════════════════════════════════════════
let _brokerCatCache = null;  // { FOREIGN: Set, BIG_MONEY: Set }
let _watchlistCache = null;  // string[]
let _cacheTime = 0;
const CMS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function loadBrokerCategories(force = false) {
  if (!force && _brokerCatCache && (Date.now() - _cacheTime < CMS_CACHE_TTL)) return _brokerCatCache;
  try {
    const [rows] = await pool.query('SELECT code, category FROM ft_broker_config WHERE active = 1');
    const foreign   = new Set();
    const bigMoney  = new Set();
    for (const r of rows) {
      if (r.category === 'FOREIGN')   foreign.add(r.code);
      else if (r.category === 'BIG_MONEY') bigMoney.add(r.code);
    }
    _brokerCatCache = { foreign, bigMoney };
    _cacheTime = Date.now();
    return _brokerCatCache;
  } catch (e) {
    console.error('[CMS] Failed to load broker categories:', e.message);
    return _brokerCatCache || { foreign: new Set(), bigMoney: new Set() };
  }
}

async function loadWatchlist(force = false) {
  if (!force && _watchlistCache && (Date.now() - _cacheTime < CMS_CACHE_TTL)) return _watchlistCache;
  try {
    const [rows] = await pool.query(
      'SELECT ticker FROM ft_watchlist WHERE active = 1 ORDER BY display_order ASC'
    );
    _watchlistCache = rows.map(r => r.ticker);
    return _watchlistCache;
  } catch (e) {
    console.error('[CMS] Failed to load watchlist:', e.message);
    return _watchlistCache || TOP_STOCKS;
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
async function main() {
  await setupDB();
  
  // ─── FIBONACCI — Auto Fib Retracement from OHLC ─────────────────────────────
// GET /api/fibonacci?ticker=BBCA&lookback=60
app.get('/api/fibonacci', async (req, res) => {
  const ticker   = (req.query.ticker || '').toUpperCase();
  const lookback = Math.min(parseInt(req.query.lookback) || 60, 250);
  if (!ticker) return res.json({ error: 'ticker required' });
  try {
    const [rows] = await pool.query(
      'SELECT date, open_price AS open, high_price AS high, low_price AS low, close_price AS close FROM idx_stock_prices WHERE stock_code = ? ORDER BY date DESC LIMIT ?',
      [ticker, lookback]
    );
    if (rows.length < 10) return res.json({ error: 'not enough data', count: rows.length });
    const ohlc = rows.reverse().map(r => ({
      time:  r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date).split('T')[0],
      open:  Number(r.open), high: Number(r.high),
      low:   Number(r.low),  close: Number(r.close),
    }));
    const result = autoFibonacci(ohlc, lookback);
    res.json(result || { error: 'pivot detection failed - try longer lookback' });
  } catch (err) { res.json({ error: err.message }); }
});

// ─── LUNAR — Moon Phase Events (Jean Meeus algorithm) ────────────────────────
// GET /api/lunar?from=2025-01-01&to=2025-12-31
app.get('/api/lunar', async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 180 * 86400000);
    const to   = req.query.to   ? new Date(req.query.to)   : new Date(Date.now() +  90 * 86400000);
    const events = getLunarEvents(from, to);
    res.json({ count: events.length, events });
  } catch (err) { res.json({ error: err.message }); }
});


// Yahoo Finance Candles Proxy (fetchYahooCandles/fetchYahooLiveQuote/fetchAndCacheIHSG/
// getIHSGTrend are required/defined at true top-level below, near computeConvictionTier —
// NOT here, because this is inside main(), and routes registered after main() ends
// (like /api/signal-scanner) can't see names hoisted only inside main()'s scope.)

// GET /api/live-prices?tickers=BBCA,TLKM,BREN — intraday quotes for journal "HARGA ACTUAL"
app.get('/api/live-prices', async (req, res) => {
  const tickers = String(req.query.tickers || '').split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  if (!tickers.length) return res.json({ prices: {} });
  if (tickers.length > 40) return res.status(400).json({ error: 'Max 40 tickers per request' });

  try {
    const results = await Promise.all(tickers.map(async (t) => {
      const q = await fetchYahooLiveQuote(t);
      return [t, q];
    }));
    const prices = {};
    for (const [ticker, q] of results) {
      if (q.price) prices[ticker] = { price: q.price, marketTime: q.marketTime };
    }
    res.json({ prices, fetchedAt: Date.now() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ihsg', async (req, res) => {
  try {
    await fetchAndCacheIHSG().catch(() => {});
    const trend = await getIHSGTrend();
    res.json(trend || { error: 'no data yet' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Virtual portfolio — the two simulated Rp100 juta accounts.
 *
 * READ-ONLY on purpose. Nothing here creates an order, fills one, or moves
 * cash: that is `virtual_portfolio.js` on cron, in one transaction per order.
 * An HTTP handler that could also write would be a second, unsynchronised
 * writer against the same ledger.
 *
 * Only ACTIVE accounts are listed by default. A retired execution contract is
 * still in the table with its whole history intact — `?all=1` shows those too,
 * clearly marked, because its record must not be pooled with the live one.
 */
app.get('/api/virtual-portfolio', async (req, res) => {
  try {
    const includeClosed = req.query.all === '1';
    // RETIRING accounts are always listed: they still hold positions and still
    // mark, so hiding them would repeat the bug that made them necessary.
    const [accounts] = await pool.query(
      `SELECT id, account_code, strategy_id, strategy_hash, exit_policy, execution_policy_hash,
              starting_cash, cash_balance, total_nav, status, retired_at, created_at,
              performance_eligible, data_blocked_json
         FROM virtual_accounts ${includeClosed ? '' : "WHERE status IN ('ACTIVE','RETIRING')"}
        ORDER BY status, account_code`);

    // The burn-in streak and the frozen charters travel with the payload. A
    // dashboard that shows a NAV without showing whether the engine is
    // operationally clean, and what this account agreed to be judged by before
    // it had any results, is showing the flattering half.
    // THE ACTIVE IDENTITY ONLY. Reading every row would show a streak that
    // includes sessions run by a different engine or a different account set —
    // the same flattering arithmetic the identity column exists to prevent.
    const vpMod = require('./virtual_portfolio');
    let activeIdentity = null;
    try { activeIdentity = await vpMod.cycleIdentity(pool, vpMod.SOURCE_STRATEGY); } catch { /* table may not exist yet */ }
    const [burnRows] = activeIdentity
      ? await pool.query(
          `SELECT session_date, passed, failures_json FROM virtual_burnin
            WHERE identity_hash=? ORDER BY session_date DESC LIMIT 30`, [activeIdentity]).catch(() => [[]])
      : [[]];
    let streak = 0;
    for (const r of burnRows) { if (!Number(r.passed)) break; streak++; }
    const burnIn = {
      streak, target: 10, identity: activeIdentity,
      latest: burnRows[0] ? {
        date: toDateStr(burnRows[0].session_date), passed: !!Number(burnRows[0].passed),
        failures: burnRows[0].failures_json ? JSON.parse(burnRows[0].failures_json) : [],
      } : null,
      history: burnRows.map(r => ({ date: toDateStr(r.session_date), passed: !!Number(r.passed) })),
    };
    const [charters] = await pool.query('SELECT * FROM virtual_charter').catch(() => [[]]);

    // THE TRUST CENTER. Everything a reader needs to decide whether tonight's
    // numbers can be believed, in one object: is the market data current, did
    // each stage of the chain actually complete, and which experiment is this.
    const calState = await vpMod.sessionCalendarState(pool).catch(() => null);
    const session = calState?.calendar || null;
    const [stageRows] = session && activeIdentity
      ? await pool.query(
          `SELECT stage, status, reason, completed_at FROM virtual_cycle_stage
            WHERE session_date=? AND identity_hash=?`, [session, activeIdentity]).catch(() => [[]])
      : [[]];
    const stages = Object.fromEntries(
      ['resolve', 'schedule', 'mark'].map(st => {
        const r = stageRows.find(x => x.stage === st);
        return [st, r ? { status: r.status, reason: r.reason, at: r.completed_at } : { status: 'NOT_RUN' }];
      }));
    let reconcileProblems = null;
    try { reconcileProblems = await vpMod.cmdReconcile(pool, { strategyId: vpMod.SOURCE_STRATEGY }); } catch { /* leave null */ }

    const trust = {
      marketData: calState ? (calState.blocked ? 'BLOCKED' : 'HEALTHY') : 'UNKNOWN',
      blockedReason: calState?.blocked || null,
      sessionCalendar: calState?.calendar || null,
      latestPriceSession: calState?.prices || null,
      priceCoverage: calState?.coverage ?? null,
      typicalCoverage: calState?.typical ?? null,
      stages,
      reconcile: reconcileProblems === null ? 'UNKNOWN'
        : reconcileProblems.length ? 'PROBLEMS' : 'CLEAN',
      reconcileProblems: reconcileProblems || [],
      engineVersion: require('./modules/virtual_broker').EXECUTION_ENGINE_VERSION,
      identity: activeIdentity,
    };
    const charterFor = c => charters.find(x =>
      x.account_code === c.account_code && x.strategy_hash === c.strategy_hash &&
      x.execution_policy_hash === c.execution_policy_hash) || null;
    if (!accounts.length) return res.json({ accounts: [], note: 'no virtual accounts yet — virtual_portfolio.js has not run' });

    const out = [];
    for (const a of accounts) {
      const [nav] = await pool.query(
        'SELECT mark_date, cash_value, market_value, total_nav, realized_pnl, unrealized_pnl, gross_exposure, open_positions, unmarkable FROM virtual_nav WHERE account_id=? ORDER BY mark_date', [a.id]);
      const [open] = await pool.query(
        `SELECT id, ticker, quantity, entry_date, entry_price, stop_price, target_price, cost_basis
           FROM virtual_positions WHERE account_id=? AND status='OPEN' ORDER BY entry_date DESC, ticker`, [a.id]);
      const [closed] = await pool.query(
        `SELECT id, ticker, quantity, entry_date, entry_price, exit_date, exit_price, exit_reason,
                net_pnl, return_pct, holding_bars, ambiguous_exit
           FROM virtual_positions WHERE account_id=? AND status='CLOSED' ORDER BY exit_date DESC, ticker LIMIT 200`, [a.id]);
      const [[stats]] = await pool.query(
        `SELECT COUNT(*) n, COALESCE(SUM(net_pnl),0) pnl, SUM(net_pnl>0) wins,
                COALESCE(SUM(CASE WHEN net_pnl>0 THEN net_pnl ELSE 0 END),0) grossProfit,
                COALESCE(SUM(CASE WHEN net_pnl<0 THEN -net_pnl ELSE 0 END),0) grossLoss,
                SUM(exit_reason='STOP') stops, SUM(exit_reason='TARGET') targets,
                SUM(exit_reason='EOD_CLOSE') eodCloses, SUM(exit_reason='TIME_EXIT') timeExits,
                SUM(ambiguous_exit) ambiguous
           FROM virtual_positions WHERE account_id=? AND status='CLOSED'`, [a.id]);
      const [pending] = await pool.query(
        `SELECT ticker, signal_date, status, reject_reason FROM virtual_orders
          WHERE account_id=? AND status IN ('SCHEDULED','REJECTED','NO_FILL')
          ORDER BY signal_date DESC, ticker LIMIT 60`, [a.id]);

      // Order queue, broken out. "Pending" and "rejected" and "no fill" are
      // three different facts and collapsing them hides a data outage inside
      // what looks like an execution outcome.
      const [queue] = await pool.query(
        `SELECT status, COUNT(*) n FROM virtual_orders WHERE account_id=? GROUP BY status`, [a.id]);
      const orderQueue = Object.fromEntries(queue.map(q => [q.status, Number(q.n)]));

      // Maximum drawdown from the NAV curve this account actually recorded.
      let peak = null, maxDD = 0;
      for (const p of nav) {
        const v = Number(p.total_nav);
        if (peak === null || v > peak) peak = v;
        if (peak > 0) maxDD = Math.max(maxDD, (peak - v) / peak);
      }

      const n = Number(stats.n) || 0;
      const gl = Number(stats.grossLoss);
      const ch = charterFor(a);
      out.push({
        ...a,
        performanceEligible: Number(a.performance_eligible) !== 0,
        dataBlocked: a.data_blocked_json ? JSON.parse(a.data_blocked_json) : null,
        orderQueue,
        maxDrawdown: Math.round(maxDD * 10000) / 100,
        charter: ch ? {
          officialStartDate: toDateStr(ch.official_start_date),
          codeCommit: ch.code_commit, configVersion: ch.config_version,
          startingCapital: Number(ch.starting_capital),
          frozenAt: ch.frozen_at, gate: JSON.parse(ch.gate_json),
        } : null,
        startingCash: Number(a.starting_cash),
        cash: Number(a.cash_balance),
        nav: Number(a.total_nav),
        returnPct: Math.round((Number(a.total_nav) / Number(a.starting_cash) - 1) * 10000) / 100,
        navSeries: nav.map(r => ({
          date: toDateStr(r.mark_date), cash: Number(r.cash_value), marketValue: Number(r.market_value),
          nav: Number(r.total_nav), realized: Number(r.realized_pnl), unrealized: Number(r.unrealized_pnl),
          exposure: Number(r.gross_exposure), openPositions: r.open_positions, unmarkable: r.unmarkable,
        })),
        openPositions: open, closedTrades: closed, pendingOrders: pending,
        stats: {
          closed: n, netPnl: Number(stats.pnl),
          winRate: n ? Math.round((Number(stats.wins) / n) * 1000) / 10 : null,
          // null, not Infinity and not 0: "no losers yet" is not a profit
          // factor, and printing one would invent a number.
          profitFactor: gl > 0 ? Math.round((Number(stats.grossProfit) / gl) * 100) / 100 : null,
          exits: {
            STOP: Number(stats.stops) || 0, TARGET: Number(stats.targets) || 0,
            EOD_CLOSE: Number(stats.eodCloses) || 0, TIME_EXIT: Number(stats.timeExits) || 0,
          },
          ambiguousExits: Number(stats.ambiguous) || 0,
        },
        // Carried in the payload rather than hardcoded in the page: the reason
        // this account exists is that it is expected to LOSE, and that has to
        // travel with its numbers.
        expectation: a.exit_policy === 'INTRADAY_EOD'
          ? 'EXPECTED TO LOSE — EXP-019 measured this rule at -0.951%/trade on this system own BUY days (n=2,204, t=-18.5) vs a -0.673% base rate. It runs to confirm that forward and must not be tuned until it stops losing.'
          : null,
      });
    }
    res.json({ accounts: out, burnIn, trust, simulated: true,
                note: 'Simulated accounts. No orders are placed anywhere.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Intraday (5-min bars, today only) — feeds the "1D" range on the IHSG
// history chart. Fetched live on-demand (60s cache in yahoo-candles.js),
// NOT persisted — separate concern from the daily idx_ihsg_history table
// used by every other range (1W/1M/3M/ALL).
app.get('/api/ihsg-intraday', async (req, res) => {
  try {
    const { fetchYahooIntraday } = require('./yahoo-candles');
    const data = await fetchYahooIntraday('^JKSE', '5m', '1d');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/yahoo-candles', async (req, res) => {
  try {
    const ticker = (req.query.ticker || 'BBCA').toUpperCase();
    const range  = ['1mo','3mo','1y','2y'].includes(req.query.range) ? req.query.range : '3mo';
    const cacheKey = ticker + ':' + range;
    const cached = yfCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CMS_CACHE_TTL) return res.json(cached.data);
    const data = await fetchYahooCandles(ticker, range);
    yfCache.set(cacheKey, { data, ts: Date.now() });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─── Stockbit Browser Import ──────────────────────────────────────────────────
// Receives broker data fetched from user's Stockbit session in browser
app.post('/api/stockbit-import', async (req, res) => {
  // Accept both application/json and text/plain (text/plain avoids CORS preflight)
  if (typeof req.body === 'string') {
    try { req.body = JSON.parse(req.body); } catch(e) {
      return res.status(400).json({ error: 'Invalid JSON in text body' });
    }
  }
  try {
    const { date, stock_code, brokers, source = 'stockbit', board = 'RG' } = req.body;
    if (!date || !stock_code || !Array.isArray(brokers) || brokers.length === 0) {
      return res.status(400).json({ error: 'Missing required: date, stock_code, brokers[]' });
    }

    const parseSbVal = (v) => {
      if (v == null || v === '') return 0;
      if (typeof v === 'number') return Math.round(v);
      const s = String(v).replace(/,/g, '').trim();
      let mult = 1;
      if (s.endsWith('T')) { mult = 1e12; }
      else if (s.endsWith('B')) { mult = 1e9; }
      else if (s.endsWith('M')) { mult = 1e6; }
      else if (s.endsWith('K')) { mult = 1e3; }
      const num = parseFloat(s);
      return isNaN(num) ? 0 : Math.round(num * mult);
    };

    let inserted = 0, skipped = 0;
    for (const b of brokers) {
      const code      = (b.code || b.broker_code || b.Code || '').toString().toUpperCase();
      const name      = b.name || b.broker_name || b.Name || '';
      const total_val = parseSbVal(b.total_val || b.T_val || b.turnover || b.totalVal);
      const net_val   = parseSbVal(b.net_val   || b.N_val  || b.net      || b.netVal);
      const buy_val   = parseSbVal(b.buy_val   || b.B_val  || b.buy      || b.buyVal);
      const sell_val  = parseSbVal(b.sell_val  || b.S_val  || b.sell     || b.sellVal);
      const total_vol = parseSbVal(b.total_vol || b.volume || b.vol      || b.totalVol || 0);
      const total_freq= parseInt(b.total_freq || b.freq || b.frequency || 0) || 0;

      if (!code) { skipped++; continue; }

      try {
        await pool.query(`
          INSERT INTO sb_broker_summary
            (date, stock_code, broker_code, broker_name, total_val, net_val, buy_val, sell_val, total_vol, total_freq, board_type, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            broker_name=VALUES(broker_name), total_val=VALUES(total_val), net_val=VALUES(net_val),
            buy_val=VALUES(buy_val), sell_val=VALUES(sell_val), total_vol=VALUES(total_vol),
            total_freq=VALUES(total_freq), imported_at=CURRENT_TIMESTAMP
        `, [date, stock_code, code, name, total_val, net_val, buy_val, sell_val, total_vol, total_freq, board, source]);
        inserted++;
      } catch (e) {
        if (e.code !== 'ER_DUP_ENTRY') console.error('sb-import row err:', e.message);
        skipped++;
      }
    }

    console.log(`[SB-IMPORT] ${stock_code} ${date} → ${inserted} brokers (${board})`);
    res.json({ ok: true, stock_code, date, board, inserted, skipped, total: brokers.length });
  } catch (err) {
    console.error('stockbit-import error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stockbit-flow?ticker=BBCA&days=10
// Flow summary using REGULAR BOARD data from Stockbit (when available)
app.get('/api/stockbit-flow', async (req, res) => {
  try {
    const ticker = (req.query.ticker || '').toUpperCase();
    const days   = parseInt(req.query.days || 10);
    if (!ticker) return res.status(400).json({ error: 'ticker required' });

    // Check how many days of Stockbit data we have
    const [sbCheck] = await pool.query(
      'SELECT COUNT(DISTINCT date) cnt, MAX(date) latest FROM sb_broker_summary WHERE stock_code=?',
      [ticker]
    );
    const sbDays = sbCheck[0]?.cnt || 0;
    const sbLatest = sbCheck[0]?.latest;

    if (sbDays === 0) {
      return res.json({ source: 'none', message: 'No Stockbit data imported yet. Use bookmarklet to import.', sbDays: 0 });
    }

    // Get Stockbit RG data
    const [sbRows] = await pool.query(`
      SELECT date, broker_code, net_val, buy_val, sell_val
      FROM sb_broker_summary
      WHERE stock_code = ? AND board_type = 'RG'
      ORDER BY date DESC
      LIMIT ?
    `, [ticker, days * 200]);

    // Define classification (same as main flow)
    // Load from DB (CMS-managed)
    const _cats2 = await loadBrokerCategories();
    const SB_FOREIGN  = _cats2.foreign;
    const SB_BIGMONEY = _cats2.bigMoney;

    // Group by date
    const byDate = {};
    for (const r of sbRows) {
      const d = r.date.toISOString ? r.date.toISOString().split('T')[0] : String(r.date).split('T')[0];
      if (!byDate[d]) byDate[d] = { foreign: 0, bigMoney: 0, retail: 0 };
      const net = Number(r.net_val);
      const bk  = r.broker_code;
      if (SB_FOREIGN.has(bk))       byDate[d].foreign  += net;
      else if (SB_BIGMONEY.has(bk)) byDate[d].bigMoney += net;
      else                           byDate[d].retail   += net;
    }

    const flowDates = Object.keys(byDate).sort();
    const flowData  = flowDates.map(d => ({ date: d, ...byDate[d] }));

    res.json({
      source: 'stockbit_rg',
      ticker, sbDays, sbLatest,
      flow: flowData,
      total: {
        foreign:  flowData.reduce((s,d) => s+d.foreign, 0),
        bigMoney: flowData.reduce((s,d) => s+d.bigMoney, 0),
        retail:   flowData.reduce((s,d) => s+d.retail, 0),
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stockbit-status - check how many stocks have Stockbit data
app.get('/api/stockbit-status', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT stock_code, COUNT(DISTINCT date) days_count, MAX(date) latest_date, COUNT(*) broker_rows
      FROM sb_broker_summary
      GROUP BY stock_code
      ORDER BY latest_date DESC, days_count DESC
    `);
    res.json({ stocks: rows, total_stocks: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: GET /api/admin/broker-config ──────────────────────────────────────
app.get('/api/admin/broker-config', requireAdminKey, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT code, name, category, active, notes, updated_at FROM ft_broker_config ORDER BY category, code'
    );
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: PUT /api/admin/broker-config/:code ────────────────────────────────
app.put('/api/admin/broker-config/:code', async (req, res) => {
  const { code } = req.params;
  const { category, name, active, notes } = req.body;
  try {
    await pool.query(
      'INSERT INTO ft_broker_config (code, name, category, active, notes) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE category=VALUES(category), name=COALESCE(VALUES(name),name), active=VALUES(active), notes=COALESCE(VALUES(notes),notes)',
      [code, name || '', category || 'RITEL', active ?? 1, notes || '']
    );
    _brokerCatCache = null; // invalidate cache
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: POST /api/admin/broker-config/bulk ────────────────────────────────
app.post('/api/admin/broker-config/bulk', requireAdminKey, async (req, res) => {
  const { updates } = req.body; // [{ code, category }]
  if (!Array.isArray(updates)) return res.status(400).json({ error: 'updates must be array' });
  try {
    for (const u of updates) {
      await pool.query(
        'UPDATE ft_broker_config SET category=?, active=1 WHERE code=?',
        [u.category || 'RITEL', u.code]
      );
    }
    _brokerCatCache = null;
    res.json({ ok: true, updated: updates.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: GET /api/admin/watchlist ──────────────────────────────────────────
app.get('/api/admin/watchlist', requireAdminKey, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT ticker, active, display_order, sector, added_at FROM ft_watchlist ORDER BY display_order ASC, ticker ASC'
    );
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: POST /api/admin/watchlist ─────────────────────────────────────────
app.post('/api/admin/watchlist', requireAdminKey, async (req, res) => {
  const { ticker, sector, display_order } = req.body;
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  try {
    const [existing] = await pool.query('SELECT ticker FROM ft_watchlist WHERE ticker=?', [ticker.toUpperCase()]);
    if (existing.length > 0) {
      await pool.query('UPDATE ft_watchlist SET active=1 WHERE ticker=?', [ticker.toUpperCase()]);
      _watchlistCache = null;
      return res.json({ ok: true, action: 'reactivated' });
    }
    const [maxRow] = await pool.query('SELECT MAX(display_order) AS mx FROM ft_watchlist');
    const order = display_order || ((maxRow[0].mx || 0) + 1);
    await pool.query(
      'INSERT INTO ft_watchlist (ticker, active, display_order, sector) VALUES (?,1,?,?)',
      [ticker.toUpperCase(), order, sector || '']
    );
    _watchlistCache = null;
    res.json({ ok: true, action: 'added' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: PUT /api/admin/watchlist/:ticker ───────────────────────────────────
app.put('/api/admin/watchlist/:ticker', async (req, res) => {
  const { ticker } = req.params;
  const { active, display_order, sector } = req.body;
  try {
    await pool.query(
      'UPDATE ft_watchlist SET active=?, display_order=COALESCE(?,display_order), sector=COALESCE(?,sector) WHERE ticker=?',
      [active ?? 1, display_order ?? null, sector ?? null, ticker.toUpperCase()]
    );
    _watchlistCache = null;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: DELETE /api/admin/watchlist/:ticker ────────────────────────────────
app.delete('/api/admin/watchlist/:ticker', async (req, res) => {
  const { ticker } = req.params;
  try {
    await pool.query('UPDATE ft_watchlist SET active=0 WHERE ticker=?', [ticker.toUpperCase()]);
    _watchlistCache = null;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: POST /api/admin/reload-config ─────────────────────────────────────
app.post('/api/admin/reload-config', requireAdminKey, async (req, res) => {
  try {
    _brokerCatCache = null;
    _watchlistCache = null;
    const cats = await loadBrokerCategories(true);
    const wl   = await loadWatchlist(true);
    res.json({
      ok: true,
      foreign:   [...cats.foreign],
      bigMoney:  [...cats.bigMoney],
      watchlist: wl.length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ═══════════════════════════════════════════════════════════════
// STRATEGY LAB API ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// GET /api/signals/today?market=us&signal=BUY
app.get('/api/signals/today', async (req, res) => {
  try {
    const { market = 'us', signal: sig } = req.query;
    const db = pool;
    let q = `
      SELECT s.ticker, s.sector, s.\`signal\`, s.strategy_code,
             ROUND(s.final_score,1) AS final_score,
             ROUND(s.tech_score,1) AS tech_score,
             ROUND(s.macro_score,1) AS macro_score,
             ROUND(s.seasonality_score,1) AS seasonality_score,
             ROUND(s.bandarmology_score,1) AS bandarmology_score,
             s.entry_price, s.indicators, s.step_details,
             st.name AS strategy_name
      FROM ft_signals s
      LEFT JOIN ft_strategies st ON st.code = s.strategy_code
      WHERE s.signal_date = CURDATE() AND s.market = ?
    `;
    const params = [market];
    if (sig) { q += ' AND s.\`signal\` = ?'; params.push(sig); }
    q += ' ORDER BY s.final_score DESC';
    const [rows] = await pool.query(q, params);
    // Parse JSON fields
    const result = rows.map(r => ({
      ...r,
      indicators:   tryParse(r.indicators),
      step_details: tryParse(r.step_details),
    }));
    res.json({ date: new Date().toISOString().slice(0,10), market, count: result.length, signals: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/signals/macro
app.get('/api/signals/macro', async (req, res) => {
  try {
    const db = pool;
    const [rows] = await pool.query(`
      SELECT m1.indicator, m1.value, m1.previous_value, m1.direction, m1.date, m1.source
      FROM ft_macro_data m1
      INNER JOIN (
        SELECT indicator, MAX(date) AS max_date FROM ft_macro_data GROUP BY indicator
      ) m2 ON m1.indicator = m2.indicator AND m1.date = m2.max_date
      ORDER BY m1.indicator
    `);
    res.json({ updated_at: new Date().toISOString(), macro: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/signals/stats
app.get('/api/signals/stats', async (req, res) => {
  try {
    const db = pool;
    const [rows] = await pool.query(`
      SELECT s.code, s.name, s.market, s.description,
             COALESCE(st.total_signals, 0) AS total_signals,
             COALESCE(st.wins, 0) AS wins,
             COALESCE(st.losses, 0) AS losses,
             COALESCE(st.win_rate, 0) AS win_rate,
             COALESCE(st.avg_pnl_pct, 0) AS avg_pnl_pct,
             st.last_updated
      FROM ft_strategies s
      LEFT JOIN ft_strategy_stats st ON st.strategy_code = s.code
      WHERE s.active = 1
      ORDER BY s.market, s.name
    `);
    res.json({ strategies: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/signals/journey?strategy=rsi_volume_us
app.get('/api/signals/journey', async (req, res) => {
  try {
    const { strategy } = req.query;
    const db = pool;
    let q = `
      SELECT snapshot_date, strategy_code,
             ROUND(win_rate,2) AS win_rate,
             total_signals, wins, losses,
             ROUND(avg_pnl_pct,4) AS avg_pnl_pct,
             ROUND(portfolio_value,2) AS portfolio_value
      FROM ft_journey_snapshots
    `;
    const params = [];
    if (strategy) { q += ' WHERE strategy_code = ?'; params.push(strategy); }
    q += ' ORDER BY snapshot_date ASC';
    const [rows] = await pool.query(q, params);
    res.json({ journey: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function tryParse(v) {
  if (!v) return null;
  try { return JSON.parse(v); } catch { return v; }
}


// ═══ PAPER TRADING API ═══════════════════════════════════════

app.get('/api/paper-trading/plan', async (req, res) => {
  const market = req.query.market || 'us';
  const date   = req.query.date   || new Date().toISOString().slice(0, 10);
  try {
    const [rows] = await pool.query(
      `SELECT id, trade_date, ticker, market, sector, strategy_code,
              signal_type, signal_score, entry_price, target_price, stop_loss,
              tp_pct, sl_pct, risk_reward, virtual_capital, quantity, status,
              exit_price, exit_reason, pnl_pct, pnl_usd, rationale, planned_at, opened_at, closed_at
       FROM ft_virtual_trades
       WHERE DATE(trade_date) = ? AND market = ?
       ORDER BY signal_score DESC`, [date, market]
    );
    const wins=rows.filter(r=>r.status==='WIN').length;
    const losses=rows.filter(r=>r.status==='LOSS').length;
    const settled=wins+losses+rows.filter(r=>r.status==='EVEN').length;
    res.json({
      date, market, total: rows.length, wins, losses,
      open: rows.filter(r=>r.status==='OPEN').length,
      planned: rows.filter(r=>r.status==='PLANNED').length,
      win_rate: settled>0 ? Math.round(wins/settled*1000)/10 : 0,
      total_pnl: Math.round(rows.reduce((s,r)=>s+parseFloat(r.pnl_usd||0),0)*100)/100,
      trades: rows.map(r=>({...r, entry_price:parseFloat(r.entry_price), target_price:parseFloat(r.target_price), stop_loss:parseFloat(r.stop_loss), tp_pct:parseFloat(r.tp_pct), sl_pct:parseFloat(r.sl_pct), pnl_pct:parseFloat(r.pnl_pct||0), pnl_usd:parseFloat(r.pnl_usd||0), signal_score:parseFloat(r.signal_score||0)}))
    });
  } catch(err){ res.status(500).json({error:err.message}); }
});

app.get('/api/paper-trading/history', async (req, res) => {
  const market=req.query.market||'us'; const days=parseInt(req.query.days)||30;
  try {
    const [rows]=await pool.query(
      `SELECT trade_date, COUNT(*) as total,
              SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN status='LOSS' THEN 1 ELSE 0 END) as losses,
              ROUND(AVG(CASE WHEN pnl_pct IS NOT NULL THEN pnl_pct END),4) as avg_pnl,
              ROUND(SUM(pnl_usd),2) as total_pnl_usd
       FROM ft_virtual_trades
       WHERE market=? AND trade_date>=DATE_SUB(CURDATE(),INTERVAL ? DAY) AND status IN ('WIN','LOSS','EVEN')
       GROUP BY trade_date ORDER BY trade_date ASC`, [market, days]
    );
    res.json({market, days, history:rows});
  } catch(err){ res.status(500).json({error:err.message}); }
});

app.post('/api/paper-trading/generate-plan', requireAdminKey, (req, res) => {
  const market=req.body.market||req.query.market||'us';
  const {execFile}=require('child_process');
  execFile('/var/www/flowtracker-scraper/.venv/bin/python3',['paper_trader.py','plan',market],{cwd:'/var/www/flowtracker-scraper'},(err,stdout,stderr)=>{
    if(err) return res.status(500).json({error:err.message});
    res.json({success:true,market,output:stdout.slice(-500)});
  });
});

app.post('/api/paper-trading/open', requireAdminKey, (req, res) => {
  const market=req.body.market||'us';
  const {execFile}=require('child_process');
  execFile('/var/www/flowtracker-scraper/.venv/bin/python3',['paper_trader.py','open',market],{cwd:'/var/www/flowtracker-scraper'},(err,stdout)=>{
    res.json({success:!err, output:stdout.slice(-300)});
  });
});

app.post('/api/paper-trading/check', requireAdminKey, (req, res) => {
  const market=req.body.market||'us';
  const {execFile}=require('child_process');
  execFile('/var/www/flowtracker-scraper/.venv/bin/python3',['paper_trader.py','check',market],{cwd:'/var/www/flowtracker-scraper'},(err,stdout)=>{
    res.json({success:!err, output:stdout.slice(-500)});
  });
});

app.post('/api/paper-trading/settle', requireAdminKey, (req, res) => {
  const market=req.body.market||'us';
  const {execFile}=require('child_process');
  execFile('/var/www/flowtracker-scraper/.venv/bin/python3',['paper_trader.py','settle',market],{cwd:'/var/www/flowtracker-scraper'},(err,stdout)=>{
    res.json({success:!err, output:stdout.slice(-500)});
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/screener/smart-money
// 4-step smart money screener:
//   Step 0: Liquidity  — D0 turnover >= 30B
//   Step 1: Momentum   — D0 net > 0 AND last-3-days net > 0
//   Step 2: Foreign    — Foreign net (last 3 days) > 0
//   Step 3: 6M Accum   — Cumulative net trending up over 6 months
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/screener/smart-money', async (req, res) => {
  try {
    const minLiquidity = parseFloat(req.query.min_liquidity || 30) * 1e9; // default 30B

    // 1. Get last 3 distinct trading dates from DB
    const [dateRows] = await pool.query(
      'SELECT DISTINCT date FROM idx_broker_summary ORDER BY date DESC LIMIT 3'
    );
    if (!dateRows.length) return res.json({ results: [], meta: { error: 'no data' } });

    const dates   = dateRows.map(r => r.date instanceof Date
      ? r.date.toISOString().split('T')[0]
      : String(r.date).split('T')[0]);
    const d0      = dates[0];
    const d3Start = dates[dates.length - 1]; // oldest of last 3

    // 2. Load foreign broker set
    const { foreign: foreignSet } = await loadBrokerCategories();
    const foreignList = [...foreignSet];
    if (!foreignList.length) return res.status(500).json({ error: 'no foreign brokers configured' });

    // 3. Step 0 + 1 + 2: Single query across last 3 days
    const placeholders = foreignList.map(() => '?').join(',');
    const [step012] = await pool.query(`
      SELECT
        bs.stock_code,
        ROUND(SUM(CASE WHEN bs.date = ? THEN bs.buy_val + bs.sell_val ELSE 0 END) / 1e9, 2) AS turnover_d0_B,
        ROUND(SUM(CASE WHEN bs.date = ? THEN bs.buy_val - bs.sell_val ELSE 0 END) / 1e9, 2) AS net_d0_B,
        ROUND(SUM(bs.buy_val - bs.sell_val) / 1e9, 2)                                       AS net_3d_B,
        ROUND(SUM(CASE WHEN bs.broker_code IN (${placeholders}) THEN bs.buy_val - bs.sell_val ELSE 0 END) / 1e9, 2) AS foreign_3d_B,
        COUNT(DISTINCT bs.date) AS data_days
      FROM idx_broker_summary bs
      WHERE bs.date >= ?
      GROUP BY bs.stock_code
      HAVING
        turnover_d0_B * 1e9 >= ?
        AND net_d0_B  > 0
        AND net_3d_B  > 0
        AND foreign_3d_B > 0
      ORDER BY foreign_3d_B DESC
    `, [d0, d0, ...foreignList, d3Start, minLiquidity]);

    const step012Tickers = step012.map(r => r.stock_code);

    // 4. Step 3: 6-Month accumulation trend for passing stocks
    let results = [];
    if (step012Tickers.length > 0) {
      const sixMonthsAgo = new Date(d0);
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      const sixMAgo = sixMonthsAgo.toISOString().split('T')[0];

      // Fetch daily net for each passing stock over 6 months
      const tickerPlaceholders = step012Tickers.map(() => '?').join(',');
      const [sixMonthRows] = await pool.query(`
        SELECT stock_code, date,
          ROUND(SUM(buy_val - sell_val) / 1e9, 2) AS daily_net_B
        FROM idx_broker_summary
        WHERE stock_code IN (${tickerPlaceholders})
          AND date >= ?
        GROUP BY stock_code, date
        ORDER BY stock_code, date ASC
      `, [...step012Tickers, sixMAgo]);

      // Group by stock and compute cumulative + score
      const byTicker = {};
      for (const row of sixMonthRows) {
        const d = row.date instanceof Date
          ? row.date.toISOString().split('T')[0]
          : String(row.date).split('T')[0];
        if (!byTicker[row.stock_code]) byTicker[row.stock_code] = [];
        byTicker[row.stock_code].push({ date: d, net: Number(row.daily_net_B) });
      }

      // Compute accumulation score (0-100):
      // = percentage of days with net > 0, weighted by recency bias in last 30 days
      function accumScore(days) {
        if (!days || days.length < 10) return 0;
        const total = days.length;
        const posCount = days.filter(d => d.net > 0).length;
        const baseScore = (posCount / total) * 100;

        // Check last 30 days trend
        const last30 = days.slice(-30);
        const cumulLast30 = last30.reduce((s, d) => s + d.net, 0);
        const cumulAll    = days.reduce((s, d) => s + d.net, 0);
        const trendBonus  = cumulAll > 0 && cumulLast30 > 0 ? 10 : -10;

        return Math.min(100, Math.max(0, Math.round(baseScore + trendBonus)));
      }

      // Build cumulative series for chart
      function buildCumulative(days) {
        let cum = 0;
        return days.map(d => {
          cum += d.net;
          return { date: d.date, cum: Math.round(cum * 10) / 10 };
        });
      }

      for (const stock of step012) {
        const days       = byTicker[stock.stock_code] || [];
        const score      = accumScore(days);
        const cumulative = buildCumulative(days);

        results.push({
          ticker:         stock.stock_code,
          turnover_d0_B:  stock.turnover_d0_B,
          net_d0_B:       stock.net_d0_B,
          net_3d_B:       stock.net_3d_B,
          foreign_3d_B:   stock.foreign_3d_B,
          accum_score:    score,
          accum_6m:       cumulative,
          step3_pass:     score >= 40,
          data_days_6m:   days.length,
        });
      }

      // Sort final by accum score * foreign strength
      results.sort((a, b) =>
        (b.accum_score * b.foreign_3d_B) - (a.accum_score * a.foreign_3d_B)
      );
    }

    // Counts for funnel display
    const [totalRow] = await pool.query(
      'SELECT COUNT(DISTINCT stock_code) AS total FROM idx_broker_summary WHERE date = ?', [d0]
    );
    const [liqRow] = await pool.query(`
      SELECT COUNT(DISTINCT stock_code) AS cnt
      FROM idx_broker_summary WHERE date = ?
      GROUP BY stock_code HAVING SUM(buy_val+sell_val) >= ?
    `, [d0, minLiquidity]);

    res.json({
      meta: {
        d0,
        d3_start:       d3Start,
        total_in_db:    totalRow[0]?.total || 0,
        passed_liq:     (liqRow || []).length,
        passed_step012: step012Tickers.length,
        passed_all:     results.filter(r => r.step3_pass).length,
        min_liquidity_B: minLiquidity / 1e9,
      },
      results,
    });

  } catch (err) {
    console.error('Screener error:', err);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================
// SCANNER API ENDPOINTS (bridges signal-scanner page → existing infra)
// =============================================================

// GET /api/scanner/picks — returns OPEN recommendations as "picks"
app.get('/api/scanner/picks', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT * FROM ft_recommendations
      WHERE status = 'OPEN' AND ticker != 'SUMMARY' AND pattern_type != 'MONTHLY'
      ORDER BY detected_date DESC LIMIT 50
    `);
    const latestDate = rows.length > 0 ? String(rows[0].detected_date).slice(0,10) : new Date().toISOString().slice(0,10);
    res.json({ data: rows, date: latestDate, picks: rows });
  } catch (e) { res.json({ data: [], picks: [], date: '' }); }
});

// GET /api/scanner/winrate — returns win rate stats
app.get('/api/scanner/winrate', async (req, res) => {
  try {
    const [[row]] = await pool.query(`
      SELECT COUNT(*) as total,
        SUM(status IN ('WIN','HIT_T1','HIT_T2')) as wins,
        SUM(status IN ('LOSS','STOPPED')) as losses,
        ROUND(100 * SUM(status IN ('WIN','HIT_T1','HIT_T2')) / NULLIF(SUM(status NOT IN ('OPEN')), 0), 1) as win_rate
      FROM ft_recommendations WHERE ticker != 'SUMMARY' AND pattern_type != 'MONTHLY'
    `);
    res.json({ win_rate: Number(row.win_rate || 0), total: Number(row.total || 0), wins: Number(row.wins || 0), losses: Number(row.losses || 0) });
  } catch (e) { res.json({ win_rate: 0, total: 0, wins: 0, losses: 0 }); }
});

// GET /api/scanner/simulation-status
app.get('/api/scanner/simulation-status', (req, res) => {
  res.json({ running: false, mode: 'simulation', message: 'Pattern scanner in simulation mode' });
});

// POST /api/scanner/run — triggers harmonic scan and saves results as picks
app.post('/api/scanner/run', async (req, res) => {
  try {
    const market = (req.query.market || 'IDX').toUpperCase();
    // If scan cache is warm, use it. Otherwise trigger a fresh scan.
    const today = new Date().toISOString().slice(0,10);
    let results = [];
    
    if (_harmonicScanCache.ts > 0 && (Date.now() - _harmonicScanCache.ts) < SCAN_CACHE_TTL && _harmonicScanCache.market === market) {
      results = _harmonicScanCache.results;
    } else if (!_harmonicScanRunning) {
      // Return immediately, scan will populate cache in background
      res.json({ success: true, total: 0, date: today, message: 'Scan started in background, refresh in 1-2 minutes' });
      // Trigger scan internally (non-blocking)
      const http = require('http');
      http.get(`http://127.0.0.1:${PORT}/api/harmonic-scan?min_score=30&min_rr=1.0&force=1&market=${market}`).on('error', () => {});
      return;
    } else {
      results = _harmonicScanCache.results || [];
    }
    
    // Save results to recommendations (bulk upsert)
    let saved = 0;
    for (const p of results) {
      try {
        const [existing] = await pool.query(
          'SELECT id FROM ft_recommendations WHERE ticker=? AND pattern_type=? AND detected_date=?',
          [p.ticker, p.pattern_type, p.D_date || today]
        );
        if (existing.length === 0) {
          await pool.query(
            `INSERT INTO ft_recommendations (ticker, pattern_type, direction, detected_date, entry_min, entry_max, stop_loss, target_1, target_2, risk_reward, conviction_score, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
            [p.ticker, p.pattern_type, p.direction, p.D_date || today, p.entry_min, p.entry_max, p.stop_loss, p.target_1, p.target_2, p.risk_reward, p.conviction_score]
          );
          saved++;
        }
      } catch { /* skip duplicates */ }
    }
    
    res.json({ success: true, total: results.length, saved, date: today });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// PATCH /api/scanner/picks/:id — update a pick status
app.patch('/api/scanner/picks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const fields = Object.keys(updates).map(k => `${k}=?`).join(', ');
    const values = Object.values(updates);
    await pool.query(`UPDATE ft_recommendations SET ${fields} WHERE id=?`, [...values, id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auto-journal/run — trigger recommendation status check
// (Previously queried entry_price/target_price, columns that don't exist on
// ft_recommendations — real columns are entry_min/entry_max/target_1/target_2 —
// so this always failed its query and silently returned success:false via the
// catch block. Not currently called by the frontend or cron; fixed for when it is.)
app.post('/api/auto-journal/run', requireAdminKey, async (req, res) => {
  try {
    // Update OPEN recommendations based on current price
    const [openRecs] = await pool.query(
      `SELECT id, ticker, stop_loss, target_1, target_2 FROM ft_recommendations WHERE status = 'OPEN'`
    );
    let updated = 0;
    const yfMap = await fetchYahooPrices(openRecs.map(r => r.ticker));
    for (const rec of openRecs) {
      const p = yfMap[rec.ticker]?.price;
      if (!p) continue;
      let newStatus = null;
      if (rec.stop_loss && p <= Number(rec.stop_loss)) newStatus = 'STOPPED';
      else if (rec.target_2 && p >= Number(rec.target_2)) newStatus = 'HIT_T2';
      else if (rec.target_1 && p >= Number(rec.target_1)) newStatus = 'HIT_T1';
      if (newStatus) {
        await pool.query('UPDATE ft_recommendations SET status=?, closed_date=NOW(), closed_price=? WHERE id=?', [newStatus, p, rec.id]);
        updated++;
      }
    }
    res.json({ success: true, checked: openRecs.length, updated, message: `${updated} recommendations updated` });
  } catch (e) { res.json({ success: false, error: e.message }); }
});


// DELETE /api/recommendations/:id
app.delete('/api/recommendations/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM ft_recommendations WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/recommendations/:id — update status/result_pct/closed_price/notes.
// (Previously duplicated by a second, unreachable handler further down that used
// wrong/nonexistent column names — close_price/entry_price aren't real columns,
// the real ones are closed_price/result_pct. This is now the only definition.)
app.patch('/api/recommendations/:id', async (req, res) => {
  const { id } = req.params;
  const { status, result_pct, closed_price, notes } = req.body;
  try {
    await pool.query(
      `UPDATE ft_recommendations SET
       status=COALESCE(?,status),
       result_pct=COALESCE(?,result_pct),
       closed_price=COALESCE(?,closed_price),
       closed_date=CASE WHEN ? IS NOT NULL THEN CURDATE() ELSE closed_date END,
       notes=COALESCE(?,notes)
       WHERE id=?`,
      [status, result_pct, closed_price, status, notes, id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================
// =============================================================
// HARMONIC PATTERN ENDPOINTS
// =============================================================
const {
  detectHarmonicPatterns,
  detectWyckoffPhase,
  detectOrderBlocks,
  detectFairValueGaps,
  detectLiquiditySweeps,
  calcUltraConviction,
  buildVolumeProfile,
} = require('./harmonicEngine');

// ── Custom Scan Weights (persisted to JSON file) ─────────────
const WEIGHTS_FILE = path.join(__dirname, 'scan-weights.json');
let _customWeights = null;
try { _customWeights = JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8')); } catch {}

app.get('/api/scan-weights', (req, res) => {
  res.json({ weights: _customWeights || HARMONIC_DEFAULT_WEIGHTS, defaults: HARMONIC_DEFAULT_WEIGHTS });
});

app.post('/api/scan-weights', (req, res) => {
  try {
    const w = req.body;
    // Validate: must have all 5 keys and be numbers
    const keys = ['harmonic', 'wyckoff', 'smc', 'volume_profile', 'broker_flow'];
    for (const k of keys) {
      if (typeof w[k] !== 'number' || w[k] < 0 || w[k] > 100) {
        return res.status(400).json({ error: `Invalid weight for ${k}` });
      }
    }
    _customWeights = { harmonic: w.harmonic, wyckoff: w.wyckoff, smc: w.smc, volume_profile: w.volume_profile, broker_flow: w.broker_flow };
    fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(_customWeights, null, 2));
    res.json({ success: true, weights: _customWeights });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Fetch OHLC via fetchYahooCandles + cache in DB ───────────
async function fetchAndCacheOHLC(ticker, days = 180) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  // Check DB cache
  const [cached] = await pool.query(
    `SELECT date, open_price as open, high_price as high, low_price as low,
            close_price as close, volume
     FROM ft_price_ohlc WHERE ticker=? AND date >= ? ORDER BY date ASC`,
    [ticker, cutoff]
  );

  // Use cache if recent enough
  if (cached.length > 10) {
    const rawDate = cached[cached.length - 1].date;
    const lastDate = rawDate instanceof Date ? rawDate.toISOString().slice(0,10) : String(rawDate).slice(0,10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10);
    if (lastDate >= yesterday) {
      return cached.map(r => ({ ...r, date: String(r.date).slice(0,10) }));
    }
  }

  // Fetch fresh from Yahoo Finance (native https — no node-fetch needed)
  try {
    const range = days >= 150 ? '6mo' : days >= 80 ? '3mo' : '1mo';
    const result = await fetchYahooCandles(ticker, range);
    const candles = (result.candles || []).filter(c => c.close > 0);
    if (candles.length === 0) throw new Error('No candles');

    // Upsert into DB (with deadlock retry)
    const vals = candles.map(c => [ticker, c.date, c.open, c.high, c.low, c.close, c.volume]);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await pool.query(
          `INSERT INTO ft_price_ohlc (ticker, date, open_price, high_price, low_price, close_price, volume)
           VALUES ? ON DUPLICATE KEY UPDATE
           open_price=VALUES(open_price), high_price=VALUES(high_price),
           low_price=VALUES(low_price), close_price=VALUES(close_price), volume=VALUES(volume)`,
          [vals]
        );
        break;
      } catch (dbErr) {
        if (dbErr.message.includes('Deadlock') && attempt < 2) {
          await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
          continue;
        }
        console.error(`[OHLC] ${ticker} DB:`, dbErr.message);
      }
    }
    return candles;
  } catch (err) {
    console.error(`[OHLC] ${ticker}:`, err.message);
    return cached.map(r => ({ ...r, date: String(r.date).slice(0,10) }));
  }
}

// ── GET /api/price-history ─────────────────────────────────────
app.get('/api/price-history', async (req, res) => {
  const { ticker, days = 180 } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  try {
    const ohlc = await fetchAndCacheOHLC(ticker.toUpperCase(), Number(days));
    res.json({ ticker, count: ohlc.length, data: ohlc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/harmonic-scan ─────────────────────────────────────
// CHILD PROCESS: scan runs as separate Node.js process
// Main server event loop is NEVER blocked
const { spawn } = require('child_process');
// path already required at top of file
const SCAN_RESULTS_FILE = '/tmp/harmonic-scan-results.json';
let _harmonicScanCache = { date: null, ts: 0, results: [], scanned: 0, errors: 0, scanning: false, progress: '', market: 'IDX' };
const SCAN_CACHE_TTL = 60 * 60 * 1000; // 1 hour
let _scanProcess = null;

// Read scan results from worker output file
function _loadScanResults() {
  try {
    const data = JSON.parse(require('fs').readFileSync(SCAN_RESULTS_FILE, 'utf8'));
    if (data && !data.scanning && data.results) {
      _harmonicScanCache = {
        date: data.date, ts: data.ts || Date.now(),
        results: data.results, scanned: data.scanned || 0,
        errors: data.errors || 0, scanning: false, progress: 'done',
        market: data.market || 'IDX',
      };
    } else if (data && data.scanning) {
      _harmonicScanCache.scanning = true;
      _harmonicScanCache.progress = data.progress || 'running...';
    }
    return data;
  } catch { return null; }
}

// Start scan as child process
function _startScanWorker(minRR = 1.0, market = 'IDX') {
  if (_scanProcess || _harmonicScanCache.scanning) return;
  
  _harmonicScanCache.scanning = true;
  _harmonicScanCache.progress = '0/124';
  _harmonicScanCache.market = market;
  console.log(`[harmonic-scan] Spawning worker process for ${market}...`);
  
  const workerPath = path.join(__dirname, 'harmonic-scan-worker.js');
  const workerEnv = { ...process.env };
  if (_customWeights) workerEnv.SCAN_WEIGHTS = JSON.stringify(_customWeights);
  _scanProcess = spawn('node', [workerPath, SCAN_RESULTS_FILE, String(minRR), market], {
    cwd: __dirname,
    stdio: 'inherit',
    env: workerEnv,
  });
  
  _scanProcess.on('exit', (code) => {
    console.log(`[harmonic-scan] Worker exited with code ${code}`);
    _scanProcess = null;
    _loadScanResults();
  });
  
  _scanProcess.on('error', (err) => {
    console.error('[harmonic-scan] Worker error:', err.message);
    _scanProcess = null;
    _harmonicScanCache.scanning = false;
    _harmonicScanCache.progress = 'error: ' + err.message;
  });
}

// Try loading cached results on startup
_loadScanResults();

app.get('/api/harmonic-scan', (req, res) => {
  const { tickers, min_score = 50, min_rr = 1.5, force, market = 'IDX' } = req.query;
  const scanList = tickers
    ? tickers.split(',').map(t => t.trim().toUpperCase())
    : []; // handled inside worker now

  const now = Date.now();

  // If cache is warm, return from cache immediately
  if (!force && _harmonicScanCache.ts > 0 && (now - _harmonicScanCache.ts) < SCAN_CACHE_TTL && _harmonicScanCache.market === market) {
    const filtered = _harmonicScanCache.results.filter(r =>
      r.conviction_score >= Number(min_score) && r.risk_reward >= Number(min_rr)
    );
    return res.json({
      scanned: _harmonicScanCache.scanned,
      found: filtered.length,
      errors: _harmonicScanCache.errors,
      date: _harmonicScanCache.date,
      results: filtered,
      cached: true,
      cache_age_min: Math.round((now - _harmonicScanCache.ts) / 60000),
    });
  }

  // If scan is running, read progress from worker file
  if (_harmonicScanCache.scanning) {
    _loadScanResults(); // refresh progress
    return res.json({
      scanned: 0, found: 0, errors: 0,
      date: new Date().toISOString().slice(0,10),
      results: [],
      scanning: true,
      progress: _harmonicScanCache.progress,
      message: 'Scan running in background, refresh in 30 seconds',
    });
  }

  // Start background scan and return immediately
  _startScanWorker(Number(min_rr), market);
  
  return res.json({
    scanned: 0, found: 0, errors: 0,
    date: new Date().toISOString().slice(0,10),
    results: [],
    scanning: true,
    progress: '0/124',
    message: 'Scan started in background, refresh in 1-2 minutes',
  });
});

// GET /api/harmonic-scan/status — lightweight polling endpoint
app.get('/api/harmonic-scan/status', (req, res) => {
  res.json({
    scanning: _harmonicScanCache.scanning,
    progress: _harmonicScanCache.progress,
    cached: _harmonicScanCache.ts > 0,
    cache_age_min: _harmonicScanCache.ts > 0 ? Math.round((Date.now() - _harmonicScanCache.ts) / 60000) : null,
    found: _harmonicScanCache.results.length,
    scanned: _harmonicScanCache.scanned,
  });
});



// ── POST /api/recommendations ──────────────────────────────────
app.post('/api/recommendations', async (req, res) => {
  const { ticker, pattern_type, direction, detected_date, entry_min, entry_max,
          stop_loss, target_1, target_2, risk_reward, conviction_score,
          smart_money_confirmed, foreign_3d_B, notes, pattern_data, market_type } = req.body;
  if (!ticker || !pattern_type) return res.status(400).json({ error: 'ticker and pattern_type required' });
  try {
    const [result] = await pool.query(
      `INSERT INTO ft_recommendations
       (ticker, pattern_type, direction, detected_date, entry_min, entry_max,
        stop_loss, target_1, target_2, risk_reward, conviction_score,
        smart_money_confirmed, foreign_3d_B, notes, pattern_data, market_type)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ticker, pattern_type, direction, detected_date || new Date().toISOString().slice(0,10),
       entry_min, entry_max, stop_loss, target_1, target_2, risk_reward,
       conviction_score || 0, smart_money_confirmed ? 1 : 0, foreign_3d_B || 0,
       notes || '', JSON.stringify(pattern_data || {}), ['US', 'CRYPTO'].includes(market_type) ? market_type : 'IDX']
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/recommendations ───────────────────────────────────
app.get('/api/recommendations', async (req, res) => {
  const { status, limit = 200, exclude_summary } = req.query;
  const conditions = [];
  const params = [];

  // Always exclude SUMMARY/MONTHLY rows unless explicitly requested
  if (exclude_summary === '1') {
    conditions.push(`ticker != 'SUMMARY'`);
    conditions.push(`pattern_type != 'MONTHLY'`);
  }
  if (status) {
    conditions.push(`status = ?`);
    params.push(status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(Number(limit));

  try {
    const [rows] = await pool.query(
      `SELECT r.*,
        CASE WHEN r.market_type = 'US'
          THEN (SELECT close_price FROM us_stock_prices p WHERE p.ticker = r.ticker ORDER BY date DESC LIMIT 1)
          ELSE (SELECT close_price FROM ft_price_ohlc p WHERE p.ticker = r.ticker ORDER BY date DESC LIMIT 1)
        END as market_price
       FROM ft_recommendations r ${where} ORDER BY r.created_at DESC LIMIT ?`,
      params
    );
    // Conviction tier is computed at read-time (not stored) so refinements to
    // the rules apply retroactively to existing journal rows. trendAligned
    // isn't persisted per-row, so the Counter-trend hard gate can't be
    // reconstructed here — only the pattern/direction/smart-money/regime tiering.
    // US rows use the S&P 500 regime (not IHSG) and get the honest non-IDX
    // reason text from computeConvictionTier's market param — see modules/conviction.js.
    const idxMarketDir = await detectMarketDirection(pool);
    const usMarketDir = await detectUSMarketDirection();
    for (const r of rows) {
      const marketType = r.market_type || 'IDX';
      // No dedicated regime detector for CRYPTO — falls back to the IDX regime
      // as a placeholder (unchanged from before market_type was read at all);
      // only the reason TEXT is market-aware (see computeConvictionTier).
      const t = computeConvictionTier({
        source: r.pattern_type === 'AWO_SIGNAL' ? 'awo' : 'harmonic',
        patternType: r.pattern_type, direction: r.direction,
        smartMoneyConfirmed: !!r.smart_money_confirmed,
        marketDirection: marketType === 'US' ? usMarketDir.direction : idxMarketDir.direction,
        market: marketType,
      });
      r.convictionTier = t.tier; r.sizeMultiplier = t.sizeMultiplier; r.tierReason = t.reason;
    }
    res.json({ count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── GET /api/auto-journal/status ─────────────────────────────
// Returns bot running status and win rate stats from DB
app.get('/api/auto-journal/status', async (req, res) => {
  try {
    const market = (req.query.market || 'IDX').toUpperCase();
    const [[row]] = await pool.query(`
      SELECT
        COUNT(*) as total,
        SUM(status IN ('WIN','HIT_T1','HIT_T2')) as wins,
        SUM(status IN ('LOSS','STOPPED')) as losses,
        ROUND(100 * SUM(status IN ('WIN','HIT_T1','HIT_T2')) / NULLIF(SUM(status NOT IN ('OPEN')), 0), 1) as win_rate,
        SUM(result_pct) as total_pct
      FROM ft_recommendations
      WHERE ticker != 'SUMMARY' AND pattern_type != 'MONTHLY'
      ${market === 'CRYPTO' ? "AND ticker LIKE '%-USD'" : "AND ticker NOT LIKE '%-USD'"}
    `);
    res.json({
      running: _harmonicScanCache.scanning && _harmonicScanCache.market === market,
      scanning: _harmonicScanCache.scanning,
      enabled: true,
      win_rate: Number(row.win_rate || 0),
      total: Number(row.total || 0),
      wins: Number(row.wins || 0),
      losses: Number(row.losses || 0),
      total_pct: Number(row.total_pct || 0),
      last_run: _harmonicScanCache.market === market ? _harmonicScanCache.ts : null,
      message: `FlowTracker Bot — ${market} Simulation Mode`
    });
  } catch (err) {
    res.json({ running: false, enabled: false, win_rate: 0, total: 0, wins: 0, losses: 0 });
  }
});

// ── GET /api/auto-journal/picks ──────────────────────────────
// Returns currently OPEN positions for the bot
app.get('/api/auto-journal/picks', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT r.*, 
        (SELECT close_price FROM ft_price_ohlc p WHERE p.ticker = r.ticker ORDER BY date DESC LIMIT 1) as market_price
      FROM ft_recommendations r
      WHERE r.status = 'OPEN'
        AND r.ticker != 'SUMMARY'
        AND r.pattern_type != 'MONTHLY'
      ORDER BY r.created_at DESC
    `);
    res.json({ picks: rows, count: rows.length });
  } catch (err) {
    res.json({ picks: [], count: 0 });
  }
});

// ── GET /api/auto-journal/winrate ───────────────────────────
// Returns win rate breakdown by pattern for the bot dashboard
app.get('/api/auto-journal/winrate', async (req, res) => {
  try {
    const [byPattern] = await pool.query(`
      SELECT pattern_type,
        COUNT(*) as total,
        SUM(status IN ('WIN','HIT_T1','HIT_T2')) as wins,
        ROUND(100 * SUM(status IN ('WIN','HIT_T1','HIT_T2')) / NULLIF(SUM(status != 'OPEN'), 0), 1) as win_rate,
        ROUND(AVG(CASE WHEN status IN ('WIN','HIT_T1','HIT_T2','LOSS','STOPPED') THEN result_pct END), 2) as avg_result
      FROM ft_recommendations
      WHERE ticker != 'SUMMARY' AND pattern_type != 'MONTHLY'
      GROUP BY pattern_type ORDER BY win_rate DESC
    `);
    const [[overall]] = await pool.query(`
      SELECT
        ROUND(100 * SUM(status IN ('WIN','HIT_T1','HIT_T2')) / NULLIF(SUM(status != 'OPEN'), 0), 1) as win_rate,
        COUNT(*) as total,
        ROUND(SUM(result_pct), 2) as total_return,
        ROUND(AVG(CASE WHEN status IN ('WIN','HIT_T1','HIT_T2','LOSS','STOPPED') THEN result_pct END), 2) as avg_pnl
      FROM ft_recommendations
      WHERE ticker != 'SUMMARY' AND pattern_type != 'MONTHLY'
    `);
    res.json({
      by_pattern: byPattern.map(p => ({ ...p, win_rate: Number(p.win_rate||0), avg_result: Number(p.avg_result||0) })),
      overall: {
        win_rate: Number(overall.win_rate || 0),
        total: Number(overall.total || 0),
        total_return: Number(overall.total_return || 0),
        avg_pnl: Number(overall.avg_pnl || 0)
      }
    });
  } catch (err) {
    res.json({ by_pattern: [], overall: { win_rate: 0, total: 0, total_return: 0, avg_pnl: 0 } });
  }
});

// ── GET /api/recommendations/stats ────────────────────────────
app.get('/api/recommendations/stats', async (req, res) => {
  try {
    const [[stats]] = await pool.query(`
      SELECT
        COUNT(*) as total,
        SUM(status='OPEN') as open_count,
        SUM(status IN ('HIT_T1','HIT_T2')) as wins,
        SUM(status='STOPPED') as losses,
        SUM(status='EXPIRED') as expired,
        ROUND(100 * SUM(status IN ('HIT_T1','HIT_T2')) / NULLIF(SUM(status != 'OPEN'),0), 1) as win_rate,
        ROUND(AVG(CASE WHEN status IN ('HIT_T1','HIT_T2','STOPPED') THEN result_pct END), 2) as avg_result_pct,
        ROUND(AVG(risk_reward), 2) as avg_rr
      FROM ft_recommendations
    `);
    const [byPattern] = await pool.query(`
      SELECT pattern_type,
        COUNT(*) as total,
        SUM(status IN ('HIT_T1','HIT_T2')) as wins,
        ROUND(100 * SUM(status IN ('HIT_T1','HIT_T2')) / NULLIF(SUM(status != 'OPEN'),0), 1) as win_rate,
        ROUND(AVG(CASE WHEN status IN ('HIT_T1','HIT_T2','STOPPED') THEN result_pct END), 2) as avg_result
      FROM ft_recommendations
      GROUP BY pattern_type ORDER BY win_rate DESC
    `);
    const [byMonth] = await pool.query(`
      SELECT DATE_FORMAT(detected_date,'%Y-%m') as month,
        COUNT(*) as total,
        SUM(CASE WHEN status IN ('HIT_T1','HIT_T2') THEN result_pct ELSE 0 END) as total_gain,
        SUM(CASE WHEN status='STOPPED' THEN result_pct ELSE 0 END) as total_loss
      FROM ft_recommendations
      GROUP BY month ORDER BY month ASC LIMIT 12
    `);
    res.json({ overall: stats, by_pattern: byPattern, by_month: byMonth });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── POST /api/recommendations/bulk ────────────────────────────
// Save multiple patterns at once (Morning scan bulk-save)
app.post('/api/recommendations/bulk', async (req, res) => {
  const { patterns, market_type } = req.body;
  if (!Array.isArray(patterns) || patterns.length === 0)
    return res.status(400).json({ error: 'patterns array required' });
  const marketType = ['US', 'CRYPTO'].includes(market_type) ? market_type : 'IDX';
  try {
    let saved = 0;
    for (const p of patterns) {
      // Skip duplicates (same ticker+pattern+direction in last 7 days)
      const [existing] = await pool.query(
        `SELECT id FROM ft_recommendations
         WHERE ticker=? AND pattern_type=? AND direction=?
         AND detected_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) LIMIT 1`,
        [p.ticker, p.pattern_type, p.direction]
      );
      if (existing.length > 0) continue;

      await pool.query(
        `INSERT INTO ft_recommendations
         (ticker, pattern_type, direction, detected_date, entry_min, entry_max,
          stop_loss, target_1, target_2, risk_reward, conviction_score,
          smart_money_confirmed, foreign_3d_B, notes, pattern_data, market_type)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [p.ticker, p.pattern_type, p.direction,
         p.D_date || new Date().toISOString().slice(0,10),
         p.entry_min, p.entry_max, p.stop_loss, p.target_1, p.target_2,
         p.risk_reward, p.conviction_score || 0,
         p.smart_money_confirmed ? 1 : 0, p.foreign_3d_B || 0,
         '(Auto-saved from morning scan)', JSON.stringify(p.pattern_data || {}), marketType]
      );
      saved++;
    }
    res.json({ success: true, saved, skipped: patterns.length - saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/recommendations/update-statuses ──────────────────
// Manually trigger status update (normally called by daily cron)
app.post('/api/recommendations/update-statuses', async (req, res) => {
  try {
    await updateRecommendationStatuses();
    res.json({ success: true, message: 'Status update complete' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// =============================================================
// CRYPTO HARMONIC SCAN ENDPOINT
// =============================================================

const TOP_CRYPTO = [
  'BTC-USD','ETH-USD','BNB-USD','SOL-USD','XRP-USD',
  'ADA-USD','AVAX-USD','DOGE-USD','DOT-USD','LINK-USD',
  'MATIC-USD','UNI-USD','ATOM-USD','LTC-USD','BCH-USD',
  'FIL-USD','NEAR-USD','APT-USD','ARB-USD','OP-USD',
  'INJ-USD','SUI-USD','TON-USD','TIA-USD','JUP-USD',
];

// Fetch USD/IDR exchange rate
async function getUsdIdr() {
  try {
    const r = await fetchYahooCandles('USDIDR=X', '5d');
    const candles = r.candles || [];
    if (candles.length > 0) return candles[candles.length - 1].close;
  } catch {}
  return 16200; // fallback
}

// ── GET /api/harmonic-scan-crypto ─────────────────────────────
app.get('/api/harmonic-scan-crypto', async (req, res) => {
  const { tickers, min_score = 40, min_rr = 1.5 } = req.query;
  const scanList = tickers
    ? tickers.split(',').map(t => t.trim().toUpperCase())
    : TOP_CRYPTO;

  try {
    // Get USD/IDR rate for position sizing in IDR
    const usdIdr = await getUsdIdr();

    const results = [];
    const errors  = [];

    // Crypto: process 3 at a time (heavier requests)
    const BATCH = 3;
    for (let i = 0; i < scanList.length; i += BATCH) {
      const batch = scanList.slice(i, i + BATCH);
      await Promise.all(batch.map(async (ticker) => {
        try {
          const raw = await fetchYahooCandles(ticker, '6mo');
          const candles = (raw.candles || []).filter(c => c.close > 0);
          if (candles.length < 20) return;

          // Compute 30-day avg volume for volume-spike confirmation
          const vols = candles.map(c => c.volume);
          const avg30vol = vols.slice(-30).reduce((a, b) => a + b, 0) / Math.min(30, vols.length);
          const last5vol = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
          const volSpike = avg30vol > 0 ? last5vol / avg30vol : 1;

          // Price momentum: above 20MA?
          const closes = candles.map(c => c.close);
          const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length);
          const lastClose = closes[closes.length - 1];
          const aboveMa20 = lastClose > ma20;

          const patterns = detectHarmonicPatterns(candles, ticker);
          for (const p of patterns) {
            // Volume + momentum scoring (replaces broker flow for crypto)
            let cryptoScore = 0;
            if (p.direction === 'BULLISH') {
              if (volSpike > 1.5) cryptoScore += 15;  // volume spike bullish
              if (aboveMa20)      cryptoScore += 10;  // above 20MA = bullish trend
            } else {
              if (volSpike > 1.5) cryptoScore += 15;  // high volume on breakdown
              if (!aboveMa20)     cryptoScore += 10;  // below 20MA = bearish
            }

            const patScore = { CRAB: 20, BAT: 18, GARTLEY: 16, BUTTERFLY: 15, ABCD: 10 }[p.pattern_type] || 10;
            const fibPts   = Math.round(p.fib_score * 0.40);
            const conviction = Math.min(100, patScore + fibPts + cryptoScore);

            if (conviction < Number(min_score)) return;
            if (p.risk_reward < Number(min_rr)) return;

            // Price in USD
            const entryUsd = p.entry_price;
            const entryIdr = Math.round(entryUsd * usdIdr);

            results.push({
              ...p,
              ticker: ticker.replace('-USD',''),  // short name: BTC, ETH
              full_symbol: ticker,
              conviction_score: conviction,
              volume_confirmed: volSpike > 1.5,
              vol_spike_ratio: Math.round(volSpike * 10) / 10,
              above_ma20: aboveMa20,
              entry_usd: entryUsd,
              entry_idr: entryIdr,
              sl_usd: p.stop_loss,
              t1_usd: p.target_1,
              t2_usd: p.target_2,
              sl_idr: Math.round(p.stop_loss * usdIdr),
              t1_idr: Math.round(p.target_1 * usdIdr),
              t2_idr: Math.round(p.target_2 * usdIdr),
              usdIdr,
              market: 'CRYPTO',
            });
          }
        } catch (err) {
          errors.push({ ticker, error: err.message });
        }
      }));
      if (i + BATCH < scanList.length) await new Promise(r => setTimeout(r, 500));
    }

    results.sort((a, b) => b.conviction_score - a.conviction_score);
    res.json({
      scanned: scanList.length, found: results.length,
      errors: errors.length, usdIdr,
      date: new Date().toISOString().slice(0,10),
      results,
    });
  } catch (err) {
    console.error('[harmonic-scan-crypto]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// BACKTEST API ENDPOINTS
// ═══════════════════════════════════════════════════════════════
const { runHistoricalBacktest } = require('./backtestEngine');

// Track running backtests
const backtestRuns = {};

// POST /api/backtest/run — Trigger a new backtest
app.post('/api/backtest/run', async (req, res) => {
  const { startDate, endDate, tickers: customTickers, min_score = 60 } = req.body;
  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'startDate and endDate required (YYYY-MM-DD)' });
  }

  // ⛔ Guard: only 1 backtest at a time
  const runningRun = Object.values(backtestRuns).find(r => r.status === 'RUNNING');
  if (runningRun) {
    return res.status(429).json({ 
      error: 'A backtest is already running. Please wait for it to complete.',
      running_since: runningRun.startedAt,
      progress: runningRun.progress
    });
  }

  const tickers = customTickers && customTickers.length > 0 ? customTickers : TOP_STOCKS;
  const runId = require('crypto').randomUUID();

  backtestRuns[runId] = {
    status: 'RUNNING',
    startDate,
    endDate,
    tickers: tickers.length,
    min_score: Number(min_score),
    progress: { processed: 0, total: 0, currentDate: '' },
    startedAt: new Date().toISOString(),
  };

  // 🐍 Run via Python child process — NON-BLOCKING for Node.js event loop
  const { spawn } = require('child_process');
  const pythonScript = path.join(__dirname, 'backtest_runner.py');
  const progressFile = `/tmp/backtest_${runId}.json`;
  
  console.log(`[BACKTEST] Spawning Python runner: ${runId}`);
  
  const py = spawn('python3', [pythonScript, runId, startDate, endDate, String(min_score)], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  let stdout = '';
  py.stdout.on('data', d => { stdout += d; process.stdout.write(d); });
  py.stderr.on('data', d => process.stderr.write(d));
  
  py.on('close', (code) => {
    if (code === 0) {
      // Read final progress file for stats
      try {
        const final = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
        backtestRuns[runId].status = 'DONE';
        backtestRuns[runId].result = final;
        backtestRuns[runId].completedAt = new Date().toISOString();
        backtestRuns[runId].progress = { processed: final.progress?.total || 21, total: final.progress?.total || 21, currentDate: endDate };
        console.log(`[BACKTEST] ✅ Python run ${runId} complete — ${final.total_trades} patterns, ${final.win_rate}% WR`);
      } catch(e) {
        backtestRuns[runId].status = 'DONE';
        backtestRuns[runId].completedAt = new Date().toISOString();
      }
    } else {
      console.error(`[BACKTEST] ❌ Python run ${runId} failed with exit code ${code}`);
      backtestRuns[runId].status = 'ERROR';
      backtestRuns[runId].error = `Python exited with code ${code}`;
    }
    // Cleanup progress file
    try { fs.unlinkSync(progressFile); } catch(e) {}
  });
  
  py.on('error', (err) => {
    console.error('[BACKTEST] Failed to spawn Python:', err.message);
    backtestRuns[runId].status = 'ERROR';
    backtestRuns[runId].error = err.message;
  });

  res.json({ run_id: runId, message: 'Backtest started in background', tickers: tickers.length, startDate, endDate, min_score: Number(min_score) });
});

// GET /api/backtest/status/:runId — Check backtest progress
app.get('/api/backtest/status/:runId', (req, res) => {
  const runId = req.params.runId;
  let run = backtestRuns[runId];
  if (!run) {
    // Try reading from progress file (Python runner writes this)
    try {
      const data = JSON.parse(fs.readFileSync(`/tmp/backtest_${runId}.json`, 'utf8'));
      return res.json(data);
    } catch(e) {
      return res.status(404).json({ error: 'Run not found' });
    }
  }
  // If still RUNNING, supplement with Python's progress file for live updates
  if (run.status === 'RUNNING') {
    try {
      const data = JSON.parse(fs.readFileSync(`/tmp/backtest_${runId}.json`, 'utf8'));
      run = { ...run, progress: data.progress || run.progress };
    } catch(e) {}
  }
  res.json(run);
});

// GET /api/backtest/runs — List all backtest runs (from DB)
app.get('/api/backtest/runs', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT run_id, 
              MIN(detected_date) as start_date, 
              MAX(detected_date) as end_date,
              COUNT(*) as total_trades,
              SUM(status IN ('HIT_T1','HIT_T2')) as wins,
              SUM(status = 'STOPPED') as losses,
              SUM(status = 'EXPIRED') as expired,
              SUM(status = 'NO_ENTRY') as no_entry,
              ROUND(100 * SUM(status IN ('HIT_T1','HIT_T2')) / NULLIF(SUM(status != 'NO_ENTRY'), 0), 1) as win_rate,
              ROUND(AVG(CASE WHEN status != 'NO_ENTRY' THEN result_pct END), 2) as avg_return,
              MIN(created_at) as created_at,
              MIN(conviction_score) as min_score
       FROM ft_backtest_results 
       GROUP BY run_id 
       ORDER BY created_at DESC
       LIMIT 20`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/backtest/results/:runId — Get all trades for a run
app.get('/api/backtest/results/:runId', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM ft_backtest_results WHERE run_id = ? ORDER BY detected_date, ticker`,
      [req.params.runId]
    );
    res.json({ run_id: req.params.runId, total: rows.length, trades: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/backtest/stats/:runId — Win rate breakdown for a run
app.get('/api/backtest/stats/:runId', async (req, res) => {
  try {
    const runId = req.params.runId;

    // Overall stats
    const [[overall]] = await pool.query(
      `SELECT COUNT(*) as total,
              SUM(status != 'NO_ENTRY') as entered,
              SUM(status IN ('HIT_T1','HIT_T2')) as wins,
              SUM(status = 'STOPPED') as losses,
              SUM(status = 'EXPIRED') as expired,
              SUM(status = 'NO_ENTRY') as no_entry,
              ROUND(100 * SUM(status IN ('HIT_T1','HIT_T2')) / NULLIF(SUM(status NOT IN ('NO_ENTRY')), 0), 1) as win_rate,
              ROUND(SUM(CASE WHEN status != 'NO_ENTRY' THEN result_pct ELSE 0 END), 2) as total_return,
              ROUND(AVG(CASE WHEN status NOT IN ('NO_ENTRY') THEN result_pct END), 2) as avg_return,
              ROUND(AVG(CASE WHEN status NOT IN ('NO_ENTRY') THEN hold_days END), 1) as avg_hold_days
       FROM ft_backtest_results WHERE run_id = ?`,
      [runId]
    );

    // By pattern
    const [byPattern] = await pool.query(
      `SELECT pattern_type,
              COUNT(*) as total,
              SUM(status IN ('HIT_T1','HIT_T2')) as wins,
              SUM(status = 'STOPPED') as losses,
              ROUND(100 * SUM(status IN ('HIT_T1','HIT_T2')) / NULLIF(SUM(status NOT IN ('NO_ENTRY')), 0), 1) as win_rate,
              ROUND(AVG(CASE WHEN status NOT IN ('NO_ENTRY') THEN result_pct END), 2) as avg_return
       FROM ft_backtest_results WHERE run_id = ? AND status != 'NO_ENTRY'
       GROUP BY pattern_type ORDER BY win_rate DESC`,
      [runId]
    );

    // By direction
    const [byDirection] = await pool.query(
      `SELECT direction,
              COUNT(*) as total,
              SUM(status IN ('HIT_T1','HIT_T2')) as wins,
              ROUND(100 * SUM(status IN ('HIT_T1','HIT_T2')) / NULLIF(COUNT(*), 0), 1) as win_rate,
              ROUND(AVG(result_pct), 2) as avg_return
       FROM ft_backtest_results WHERE run_id = ? AND status != 'NO_ENTRY'
       GROUP BY direction`,
      [runId]
    );

    // By ticker (top performers)
    const [byTicker] = await pool.query(
      `SELECT ticker,
              COUNT(*) as total,
              SUM(status IN ('HIT_T1','HIT_T2')) as wins,
              ROUND(100 * SUM(status IN ('HIT_T1','HIT_T2')) / NULLIF(COUNT(*), 0), 1) as win_rate,
              ROUND(SUM(result_pct), 2) as total_return
       FROM ft_backtest_results WHERE run_id = ? AND status != 'NO_ENTRY'
       GROUP BY ticker ORDER BY win_rate DESC LIMIT 20`,
      [runId]
    );

    res.json({ overall, by_pattern: byPattern, by_direction: byDirection, by_ticker: byTicker });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/backtest/:runId — Delete a backtest run
app.delete('/api/backtest/:runId', async (req, res) => {
  try {
    await pool.query('DELETE FROM ft_backtest_results WHERE run_id = ?', [req.params.runId]);
    delete backtestRuns[req.params.runId];
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 FlowTracker Scraper API running on port ${PORT}`);
    console.log(`   📊 ${TOP_STOCKS.length} stocks tracked`);
    console.log(`   🔑 IndexAlpha: ${INDEX_ALPHA_KEY ? '✅ configured' : '❌ not configured'}`);
    console.log(`\n   Endpoints:`);
    console.log(`   GET  /api/broker-summary?code=MG&date=2026-04-29`);
    console.log(`   GET  /api/stock-prices?tickers=BBCA,BBRI,GOTO`);
    console.log(`   GET  /api/market-signals`);
    console.log(`   GET  /api/flow-analyzer`);
    console.log(`   GET  /api/accumulation-streak?days=2`);
    console.log(`   GET  /api/dashboard-summary`);
    console.log(`   POST /api/cron/run — Start daily pull`);
    console.log(`   GET  /api/cron/status — Check cron status`);
    console.log(`   GET  /api/indexalpha/pull?ticker=BBCA&date=2026-04-29`);
    console.log(`   GET  /api/indexalpha/usage — Check API quota`);
    console.log(`   GET  /api/health\n`);
    
    // Start daily cron scheduler
    scheduleDailyCron();

    // Warm Yahoo price cache on startup so first API request doesn't timeout
    console.log('   🔥 Warming Yahoo price cache...');
    fetchYahooPrices(TOP_STOCKS)
      .then(prices => console.log(`   ✅ Yahoo cache warm: ${Object.keys(prices).length} tickers ready`))
      .catch(e => console.log(`   ⚠️ Yahoo cache warm failed (will retry on first request): ${e.message}`));
  });
}

main().catch(err => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
// ══════════════════════════════════════════════════════════════════════════════
// ═══ QUANTITATIVE SIGNAL ENGINE — Multi-Factor Scoring with Win-Rate ═════════
// ══════════════════════════════════════════════════════════════════════════════

// ── AWO: Adaptive Weight System ────────────────────────────────────────────────
const AWO_WEIGHTS_FILE = path.join(__dirname, 'awo-weights.json');
const AWO_RESULT_FILE  = path.join(__dirname, 'awo-optimization-result.json');
// The FROZEN "challenger" candidate currently under paper-trading evaluation
// — external review, 2026-07-31. Deliberately separate from AWO_RESULT_FILE,
// which the nightly /run overwrites every single night (unseeded random
// search over 3000 candidates rarely finds bit-identical weights twice) —
// without this separation, a candidate's paper-trading track record would
// almost never accumulate past a single day before being silently replaced
// by tomorrow's slightly-different "best" candidate. See getOrFreezeChallenger().
const AWO_CHALLENGER_FILE = path.join(__dirname, 'awo-challenger.json');

// Default weights (fallback if no optimization has been run)
// Bumped 2026-07-29: F1/F2/F4/F6/F7/F9/F10/F11/F13 formula fixes + F14
// confidence-multiplier redesign + Counter-trend gate retraction (2026-07-28),
// missing-factor weight renormalization / factorCoverage (2026-07-29), and
// Confidence×RiskModifier split per AWO Engine.md §3.4 (2026-07-29, same day)
// — see AWO_14_FACTOR_FORMULAS.md changelog for the full list.
// Bumped to 4.0.0-research 2026-07-31 (external review) — MACD fix, optimizer
// outcome/objective rewrite, RSI regime-awareness, Bollinger squeeze,
// support/resistance, risk layer, and paper-trading/promotion gating have all
// landed since 3.3-awo was stamped; "-research" makes explicit this is not
// yet cleared for real-money use (see status table in REVIEW_RESPONSE).
// Bumped to 4.1.0-research 2026-08-02: the trading horizon moved from a 15-bar
// swing to a 40-bar position profile (modules/trade_policy.js), which changes
// the stop/target geometry AND the exit policy. Those are not part of
// candidateKeyFromWeights, so without this bump a challenger frozen under the
// old horizon would keep accumulating paper trades resolved under the new one
// and its track record would silently mix two different strategies. The bump
// makes getOrFreezeChallenger auto-archive any such challenger as
// STALE_MODEL_VERSION. Suffix stays "-research": still not cleared for real money.
const AWO_MODEL_VERSION = '4.1.0-research';

// DEFAULT_WEIGHTS imported from modules/score_engine.js (fixed 2026-07-31,
// external review) — this used to be a SEPARATE, duplicate object literal
// defined right here, independent of score_engine.js's copy. Both included
// an f14 entry; score_engine.js's was fixed to drop it (F14 is a risk
// modifier, never a directional weight — see combineFactorScores' fix
// note), but this local duplicate would have silently kept drifting from
// that fix if left alone — exactly the "two copies that can independently
// drift" problem the single-source-of-truth migration exists to prevent.
const { DEFAULT_WEIGHTS } = require('./modules/score_engine');

// Load optimized weights from file (or use defaults)
let _awoWeights = null;
let _awoThresholds = null;
try {
  const saved = JSON.parse(fs.readFileSync(AWO_WEIGHTS_FILE, 'utf8'));
  if (saved && saved.weights) _awoWeights = saved.weights;
  if (saved && saved.thresholds) _awoThresholds = saved.thresholds;
  console.log('🧠 AWO: Loaded optimized weights from file');
} catch { /* first run — no optimized weights yet */ }

function getActiveWeights() {
  return _awoWeights || DEFAULT_WEIGHTS;
}

function getActiveThresholds() {
  return _awoThresholds || { strongBuy: 78, buy: 63, watch: 53, neutral: 40, sell: 25 };
}

// Keep WEIGHTS for backward compat
const WEIGHTS = new Proxy({}, {
  get: (_, prop) => getActiveWeights()[prop],
});

function classifySignal(score) {
  const t = getActiveThresholds();
  if (score >= t.strongBuy) return 'STRONG BUY';
  if (score >= t.buy) return 'BUY';
  if (score >= t.watch) return 'WATCH';
  if (score >= t.neutral) return 'NEUTRAL';
  if (score >= t.sell) return 'SELL';
  return 'STRONG SELL';
}

// ═══════════════════════════════════════════════════════════════════════════════
// F1-F8 factor formulas — moved to modules/awo_factors.js (2026-07-28) as the
// single shared source used by server.js, regenerate_signal_history.js, and
// backtest_signal_scanner_badges.js. See that file's header for the bug-fix
// changelog (F7 sign bug, F6 50:50 boundary, F4 sign bug, dn0 scale
// recalibration, F2 acceleration nuance) — this eliminates the
// independently-duplicated-formula drift risk flagged in the 2026-07-19 AWO
// overfitting incident memory.
// ═══════════════════════════════════════════════════════════════════════════════
const {
  f1_concentration, f2_trend, f3_volumeZ, f4_momentum,
  f5_relStrength, f6_breadth, f7_alignment, f8_streak,
  weightedComposite, computeConfidence, computeRiskModifier, combineFinalScore,
} = require('./modules/awo_factors');
// Single source of truth for the F1-F13+F14 combination step (follow-up #7,
// 2026-07-30) — the same function awo_optimizer.js's rescoreSignal calls, so
// live scoring and the optimizer can no longer independently drift on this
// step the way they did before (F14-as-directional bug, caught by review).
const { combineFactorScores } = require('./modules/score_engine');

// Price-Action Regime Engine (AWO Engine.md §5) — added 2026-07-29 as an
// INFORMATIONAL badge only, same as weeklyTrend: surfaced in API responses
// as `priceRegime`, does NOT feed into composite/confidence/risk or gate any
// signal. Lesson from the Counter-trend hard gate (retracted after
// re-backtest showed it didn't hold): don't gate on a rule until it's been
// validated against real outcomes — this gets the same treatment before
// it's ever trusted that way. NOT the same as `awo_regime.js`'s existing
// `detectRegime(pool)` (market-wide TRENDING/RANGING/VOLATILE/DEFAULT, used
// by the disabled weight optimizer) — deliberately named differently
// (`detectPriceRegime`) so the two per-request "regime" concepts already in
// this file's API responses (`engine.regime` vs. this one) can't be confused.
const { detectPriceRegime, regimeGateVerdict } = require('./modules/regime_engine');

/**
 * Foreign/domestic net-flow divergence — NOT one of the 14 AWO factors, exposed
 * separately as context (same pattern as tradePlan/weeklyTrend: surfaced, not
 * silently folded into the composite score until it's been validated with real
 * outcome data).
 *
 * Rationale (see OJK working paper WP-18-04r on Indonesian investor behavior):
 * domestic/retail investors in IDX tend to herd and trade anti-momentum (FOMO-driven,
 * follow the crowd), while foreign/institutional investors tend to trade WITH
 * momentum (more information, more deliberate). A stock where foreign flow is net
 * BUYING while domestic is flat/selling looks like quiet institutional accumulation
 * ahead of the retail crowd — a stronger signal than concentration alone, which
 * blends both investor types into one undifferentiated number. Conversely, heavy
 * domestic buying with no foreign participation looks like retail FOMO without
 * institutional backing — a caution sign, potentially the "distribute to the herd"
 * side of the same pattern.
 *
 * @returns {{score:number, foreignRatio:number, domesticRatio:number, label:string}|null}
 */
function computeForeignDivergence(foreignBuy, foreignSell, domesticBuy, domesticSell) {
  const foreignTotal = (foreignBuy || 0) + (foreignSell || 0);
  const domesticTotal = (domesticBuy || 0) + (domesticSell || 0);
  if (foreignTotal <= 0 || domesticTotal <= 0) return null;

  const foreignRatio = (foreignBuy - foreignSell) / foreignTotal;   // -1..+1
  const domesticRatio = (domesticBuy - domesticSell) / domesticTotal; // -1..+1
  const divergence = foreignRatio - domesticRatio; // -2..+2

  const score = Math.round(stats.clamp(50 + divergence * 40, 0, 100));
  let label = 'ALIGNED';
  if (divergence > 0.15) label = 'FOREIGN_LEADING';
  else if (divergence < -0.15) label = 'DOMESTIC_FOMO';

  return {
    score,
    foreignRatio: Math.round(foreignRatio * 1000) / 1000,
    domesticRatio: Math.round(domesticRatio * 1000) / 1000,
    label,
  };
}

const { computeConvictionTier, detectMarketDirection } = require('./modules/conviction');
const { fetchYahooCandles, fetchYahooLiveQuote, yfCache } = require('./yahoo-candles');
const ihsgModule = require('./modules/ihsg');

// ─── IHSG (Jakarta Composite Index) — real macro regime context ─────────────
// Top-level (not inside main()) so routes registered after main() — like
// /api/signal-scanner — can actually see these via hoisting.
async function fetchAndCacheIHSG() {
  // Delegates to modules/ihsg.js so the scheduled refresh and this on-request
  // one cannot drift apart — the same reason strategy_book.js is shared between
  // the backtest and the live recorder. The partial-bar guard lives there too:
  // this used to write Yahoo's provisional intraday candle straight in, so
  // between 09:00 and 16:00 WIB the series could hold a close that was not one.
  return ihsgModule.refreshIHSG(pool, fetchYahooCandles);
}

function toDateStr(d) { return d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0]; }

async function getIHSGTrend() {
  const [rows] = await pool.query('SELECT date, close_price, change_pct FROM idx_ihsg_history ORDER BY date ASC');
  if (rows.length < 15) return null;
  const last = rows[rows.length - 1];
  const trailing10 = rows.slice(-10);
  const avgDailyChange = trailing10.reduce((s, r) => s + Number(r.change_pct || 0), 0) / trailing10.length;
  const { computeWeeklyTrend } = require('./awo_technical');
  const candles = rows.map(r => ({ date: toDateStr(r.date), close: Number(r.close_price) }));
  let weeklyTrend = null;
  try { weeklyTrend = computeWeeklyTrend(candles); } catch {}

  // The 200-day SMA regime gate, from strategy_book.js — the SAME function and
  // the SAME period the strategy actually decides on. Recomputing it here with
  // a local loop would let the page and the strategy drift into disagreeing
  // about the one line that decides whether the system trades at all.
  const sb = require('./modules/strategy_book');
  const closes = rows.map(r => Number(r.close_price));
  const smaSeries = sb.smaSeries(closes, sb.DEFAULTS.regimeSma);
  const i = closes.length - 1;
  const sma200 = smaSeries[i];
  let regime = null;
  if (sma200 !== null && sma200 !== undefined) {
    const below = closes[i] < sma200;
    // How long it has been on this side. A gate that has been shut for months
    // is a different fact from one that flipped this morning, and the page
    // should not make the two look alike.
    let sinceIdx = i;
    while (sinceIdx > 0 && smaSeries[sinceIdx - 1] !== null &&
           (closes[sinceIdx - 1] < smaSeries[sinceIdx - 1]) === below) sinceIdx--;
    regime = {
      sma200: Math.round(sma200 * 100) / 100,
      gapPct: Math.round((closes[i] / sma200 - 1) * 10000) / 100,
      below,
      // What the strategy DOES about it, not just where the line is.
      exposure: below ? 0 : 1,
      label: below ? 'REGIME_FLAT' : 'INVESTED',
      since: toDateStr(rows[sinceIdx].date),
      sessions: i - sinceIdx + 1,
    };
  }

  return {
    price: Number(last.close_price),
    changePct: Number(last.change_pct),
    avgDailyChange10d: Math.round(avgDailyChange * 1000) / 1000,
    weeklyTrend: weeklyTrend?.trend ?? null,
    regime,
    asOf: toDateStr(last.date),
  };
}

/**
 * IHSG factor layering — mirrors the per-stock 14-factor idea, adapted for an
 * index: the 6 pure-technical factors (F9-F14 in the stock model) are computed
 * identically on IHSG's own OHLC via the SAME calcTechnicalFactors used for
 * stocks (no separate formula to maintain), plus one "Market Breadth" factor
 * standing in for the broker/concentration factors (F1-F8) which don't apply
 * to an index — % of tracked stocks that closed up today, the natural index-
 * level analogue of "smart money accumulation".
 *
 * Composite here is a plain average (not the stock model's AWO_WEIGHTS,
 * which were tuned for individual-stock prediction, not proven for index-
 * level regime classification) — trend label uses a simple 3-way split since
 * "STRONG BUY the index" doesn't map cleanly the way it does for a stock.
 */
async function computeIHSGFactors() {
  const [ihsgRows] = await pool.query(
    `SELECT date, open_price o, high_price h, low_price l, close_price c, volume v FROM idx_ihsg_history ORDER BY date ASC`
  );
  if (ihsgRows.length < 30) return null;
  const candles = ihsgRows.map(r => ({
    date: toDateStr(r.date), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v),
  }));

  const { calcTechnicalFactors } = require('./awo_technical');
  const tech = calcTechnicalFactors(candles.slice(-60));

  const [[latestPriceDate]] = await pool.query('SELECT MAX(date) d FROM idx_stock_prices');
  const asOfDate = latestPriceDate?.d ? toDateStr(latestPriceDate.d) : candles[candles.length - 1].date;
  const [changeRows] = await pool.query(
    `SELECT change_pct FROM idx_stock_prices WHERE date = ?`, [asOfDate]
  );
  const total = changeRows.length;
  const positive = changeRows.filter(r => Number(r.change_pct) > 0).length;
  const breadthPct = total > 0 ? (positive / total) * 100 : 50;
  const f_breadth = Math.round(breadthPct);

  // f14 (ATR) applies as a Risk Modifier, not a 6th vote in the average — no
  // factor-coverage concept here (index-level breadth + tech factors are
  // always full weight), so Confidence is always 1.0. See combineFinalScore.
  const rawComposite6 = (f_breadth + tech.f9 + tech.f10 + tech.f11 + tech.f12 + tech.f13) / 6;
  const composite = combineFinalScore(rawComposite6, computeConfidence(undefined), computeRiskModifier(tech.f14));
  const trend = composite >= 60 ? 'BULLISH' : composite <= 40 ? 'BEARISH' : 'NEUTRAL';

  // Price-action Regime (AWO Engine.md §5) — informational badge, distinct
  // from `trend` above (which is derived from the composite score itself,
  // not from EMA50/200/ADX/ATR). Does not feed into composite/confidence/risk.
  let priceRegime = null;
  try { priceRegime = detectPriceRegime(candles.slice(-280)); } catch {}

  return {
    date: candles[candles.length - 1].date,
    composite, trend,
    priceRegime: priceRegime?.regime ?? null,
    factors: {
      breadth: f_breadth, rsi: tech.f9, macd: tech.f10, bollinger: tech.f11,
      emaTrend: tech.f12, supportResistance: tech.f13, atr: tech.f14,
    },
    breadthPct: Math.round(breadthPct * 100) / 100,
    indicators: tech.indicators,
  };
}

/**
 * Live variant of computeIHSGFactors() — same formula, but today's candle is
 * built from live intraday bars (fetchYahooIntraday) instead of waiting for
 * the daily cron's closing snapshot, and Breadth uses fetchYahooPrices across
 * all 245 tracked IDX tickers (already-batched/parallel, 10-min cache) instead
 * of yesterday's stored idx_stock_prices. Falls back to the stored daily
 * snapshot (computeIHSGFactors) if live data can't be fetched (e.g. outside
 * market hours, or Yahoo hiccup) so the panel never just goes blank.
 */
async function computeIHSGFactorsLive() {
  const [ihsgRows] = await pool.query(
    `SELECT date, open_price o, high_price h, low_price l, close_price c, volume v FROM idx_ihsg_history ORDER BY date ASC`
  );
  if (ihsgRows.length < 30) return computeIHSGFactors();
  const histCandles = ihsgRows.map(r => ({
    date: toDateStr(r.date), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v),
  }));

  let liveCandles = histCandles;
  let isLive = false;
  let yahooTime = null; // "HH:MM" WIB — Yahoo's own timestamp for the data point used, not our fetch time
  try {
    const { fetchYahooIntraday } = require('./yahoo-candles');
    const { candles: intraday, meta } = await fetchYahooIntraday('^JKSE', '5m', '1d');
    if (intraday.length > 0) {
      const today = toDateStr(new Date(intraday[0].timestamp));
      const opens = intraday.map(c => c.open).filter(Number.isFinite);
      const highs = intraday.map(c => c.high).filter(Number.isFinite);
      const lows = intraday.map(c => c.low).filter(Number.isFinite);
      const volume = intraday.reduce((s, c) => s + (c.volume || 0), 0);
      const todayCandle = {
        date: today, open: opens[0], high: Math.max(...highs), low: Math.min(...lows),
        close: intraday[intraday.length - 1].close, volume,
      };
      const last = histCandles[histCandles.length - 1];
      liveCandles = last?.date === today ? [...histCandles.slice(0, -1), todayCandle] : [...histCandles, todayCandle];
      isLive = true;

      // Prefer Yahoo's own regularMarketTime (the quote's real timestamp) over
      // the last 5-min bar's label — it's the more precise "as of" moment.
      const wibSeconds = (meta?.regularMarketTime || (intraday[intraday.length - 1].timestamp / 1000)) + 7 * 3600;
      const wib = new Date(wibSeconds * 1000);
      yahooTime = String(wib.getUTCHours()).padStart(2, '0') + ':' + String(wib.getUTCMinutes()).padStart(2, '0');
    }
  } catch { /* fall through — liveCandles stays histCandles, isLive stays false */ }

  const { calcTechnicalFactors } = require('./awo_technical');
  const tech = calcTechnicalFactors(liveCandles.slice(-60));

  let f_breadth = 50, breadthPct = 50, breadthIsLive = false;
  try {
    const yfMap = await fetchYahooPrices(TOP_STOCKS);
    const changes = Object.values(yfMap).map(v => v.changePct);
    if (changes.length > 0) {
      const positive = changes.filter(c => c > 0).length;
      breadthPct = (positive / changes.length) * 100;
      f_breadth = Math.round(breadthPct);
      breadthIsLive = true;
    }
  } catch {}

  // f14 (ATR) applies as a Risk Modifier, not a 6th vote in the average — no
  // factor-coverage concept here (index-level breadth + tech factors are
  // always full weight), so Confidence is always 1.0. See combineFinalScore.
  const rawComposite6 = (f_breadth + tech.f9 + tech.f10 + tech.f11 + tech.f12 + tech.f13) / 6;
  const composite = combineFinalScore(rawComposite6, computeConfidence(undefined), computeRiskModifier(tech.f14));
  const trend = composite >= 60 ? 'BULLISH' : composite <= 40 ? 'BEARISH' : 'NEUTRAL';

  const last = liveCandles[liveCandles.length - 1];
  const prev = liveCandles[liveCandles.length - 2];
  const changePct = prev && prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : 0;

  // Price-action Regime (AWO Engine.md §5) — informational badge only.
  let priceRegime = null;
  try { priceRegime = detectPriceRegime(liveCandles.slice(-280)); } catch {}

  return {
    date: last.date, composite, trend, isLive, breadthIsLive, yahooTime,
    priceRegime: priceRegime?.regime ?? null,
    price: last.close, changePct: Math.round(changePct * 100) / 100,
    factors: {
      breadth: f_breadth, rsi: Math.round(tech.f9), macd: Math.round(tech.f10), bollinger: Math.round(tech.f11),
      emaTrend: Math.round(tech.f12), supportResistance: Math.round(tech.f13), atr: Math.round(tech.f14),
    },
    breadthPct: Math.round(breadthPct * 100) / 100,
    indicators: tech.indicators,
  };
}

app.get('/api/ihsg-factors-live', async (req, res) => {
  try {
    const current = await computeIHSGFactorsLive();
    res.json({ current });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Live variant of the per-stock 14-factor score — same finding as the US
 * model build: F3 (Volume Z), F4 (Momentum), F5 (Rel. Strength) and F9-F14
 * (pure technical) are price/volume math and can be recomputed from live
 * intraday candles. F1, F2, F6, F7, F8 need broker/concentration data that
 * Index Alpha only provides once a day (no live equivalent exists), so those
 * stay frozen at the last EOD value — returned in `frozenFactors` so the UI
 * can label them honestly rather than implying the whole score is live.
 */
async function computeStockFactorsLive(ticker) {
  const [histRows] = await pool.query(
    `SELECT date, open_price, high_price, low_price, close_price, volume
     FROM idx_stock_prices WHERE stock_code = ? ORDER BY date ASC`,
    [ticker]
  );
  if (histRows.length < 15) return null;
  const histCandles = histRows.map(r => ({
    date: toDateStr(r.date), open: Number(r.open_price || r.close_price), high: Number(r.high_price || r.close_price),
    low: Number(r.low_price || r.close_price), close: Number(r.close_price), volume: Number(r.volume),
  }));

  let liveCandles = histCandles;
  let isLive = false;
  let yahooTime = null;
  try {
    const { fetchYahooIntraday } = require('./yahoo-candles');
    const { candles: intraday, meta } = await fetchYahooIntraday(ticker, '5m', '1d');
    if (intraday.length > 0) {
      const today = toDateStr(new Date(intraday[0].timestamp));
      const opens = intraday.map(c => c.open).filter(Number.isFinite);
      const highs = intraday.map(c => c.high).filter(Number.isFinite);
      const lows = intraday.map(c => c.low).filter(Number.isFinite);
      const volume = intraday.reduce((s, c) => s + (c.volume || 0), 0);
      const todayCandle = {
        date: today, open: opens[0], high: Math.max(...highs), low: Math.min(...lows),
        close: intraday[intraday.length - 1].close, volume,
      };
      const lastHist = histCandles[histCandles.length - 1];
      liveCandles = lastHist?.date === today ? [...histCandles.slice(0, -1), todayCandle] : [...histCandles, todayCandle];
      isLive = true;

      const wibSeconds = (meta?.regularMarketTime || (intraday[intraday.length - 1].timestamp / 1000)) + 7 * 3600;
      const wib = new Date(wibSeconds * 1000);
      yahooTime = String(wib.getUTCHours()).padStart(2, '0') + ':' + String(wib.getUTCMinutes()).padStart(2, '0');
    }
  } catch { /* fall through — liveCandles stays histCandles, isLive stays false */ }

  const last = liveCandles[liveCandles.length - 1];
  const prev = liveCandles[liveCandles.length - 2];
  const dailyChange = prev && prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : 0;
  const closes = liveCandles.map(c => c.close).filter(c => c > 0);
  const volumes = liveCandles.map(c => c.volume).filter(v => v > 0);

  // Same cross-sectional live average IHSG's live Breadth uses — cheap here
  // too since fetchYahooPrices shares its 10-min cache across the whole app.
  let marketAvgChange = 0;
  try {
    const yfMap = await fetchYahooPrices(TOP_STOCKS);
    const changes = Object.values(yfMap).map(v => v.changePct).filter(Number.isFinite);
    if (changes.length > 0) marketAvgChange = changes.reduce((a, b) => a + b, 0) / changes.length;
  } catch {}

  const f3 = f3_volumeZ(volumes, dailyChange);
  const f4 = f4_momentum(closes);
  const f5 = f5_relStrength(dailyChange, marketAvgChange);

  // Fixed 2026-07-31 (external review, round 3, findings #2/#4): this used to
  // gate ALL of f9-f13 behind one `liveCandles.length >= 15` check (RSI's
  // minimum only), then never even told combineFactorScores which of f9-f13
  // were real vs fallback-50 — the availability object below never included
  // f9-f13 keys at all, so a fake-50 was always treated as fully available.
  // calcTechnicalFactors is safe to call unconditionally now and reports its
  // own real per-indicator availability (see its doc comment).
  const { calcTechnicalFactors } = require('./awo_technical');
  const tech = calcTechnicalFactors(liveCandles.slice(-60));
  const { f9, f10, f11, f12, f13, f14 } = tech;
  const techIndicators = tech.indicators;

  // Frozen EOD factors — last available broker/concentration pull for THIS ticker
  let f1 = 50, f2 = 50, f6 = 50, f7 = 50, f8 = 50, eodDate = null;
  let brokerDataAvailable = false, breadthDataAvailable = false;
  try {
    const [[latestConcDate]] = await pool.query('SELECT MAX(data_date) d FROM idx_concentration WHERE stock_code = ?', [ticker]);
    if (latestConcDate?.d) {
      eodDate = toDateStr(latestConcDate.d);
      const [concRows] = await pool.query(
        `SELECT dn0, dn1, dn2, dn3, dn4 FROM idx_concentration WHERE stock_code = ? AND data_date = ?`, [ticker, eodDate]
      );
      const c = concRows[0];
      if (c) {
        brokerDataAvailable = true;
        const dn0 = Number(c.dn0 ?? 0);
        const dnValues = [c.dn4, c.dn3, c.dn2, c.dn1, c.dn0]
          .map(v => v !== null && v !== undefined ? Number(v) : null).filter(v => v !== null);
        f1 = f1_concentration(dn0);
        f2 = f2_trend(dnValues);
        f7 = f7_alignment(dailyChange, dn0);
        f8 = f8_streak(dnValues);
      }
      const [breadthRows] = await pool.query(
        `SELECT SUM(CASE WHEN buy_val > sell_val THEN 1 ELSE 0 END) net_buyers,
                SUM(CASE WHEN sell_val > buy_val THEN 1 ELSE 0 END) net_sellers
         FROM idx_broker_summary WHERE stock_code = ? AND date = ?`, [ticker, eodDate]
      );
      const b = breadthRows[0];
      if (b) { breadthDataAvailable = true; f6 = f6_breadth(Number(b.net_buyers || 0), Number(b.net_sellers || 0)); }
    }
  } catch {}

  const activeW = getActiveWeights();
  // Single source of truth (follow-up #7, 2026-07-30): combineFactorScores
  // from modules/score_engine.js is the SAME function awo_optimizer.js's
  // rescoreSignal calls — missing broker/breadth data is excluded from the
  // weight sum instead of silently diluting the composite toward 50 at full
  // weight (see its doc comment), Final = Directional × Confidence ×
  // RiskModifier per AWO Engine.md §3.4.
  const { factorCoverage, missingFactors, confidence: confidenceScore, riskModifier, finalScore: composite, decision: signal } = combineFactorScores(
    { f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13 }, f14,
    {
      f1: brokerDataAvailable, f2: brokerDataAvailable, f6: breadthDataAvailable, f7: brokerDataAvailable, f8: brokerDataAvailable,
      f9: tech.factorAvailable.f9, f10: tech.factorAvailable.f10, f11: tech.factorAvailable.f11,
      f12: tech.factorAvailable.f12, f13: tech.factorAvailable.f13,
    },
    activeW, getActiveThresholds()
  );

  let tradePlan = null;
  try {
    const { computeTradePlan } = require('./awo_technical');
    tradePlan = computeTradePlan(last.close, signal, techIndicators?.atr ?? null, techIndicators?.sr ?? null);
  } catch {}

  // Weekly trend + Conviction Tier — this endpoint computed neither before
  // 2026-07-28, so the live per-ticker view never showed a tier at all.
  let weeklyTrend = null;
  try {
    const { computeWeeklyTrend } = require('./awo_technical');
    weeklyTrend = computeWeeklyTrend(liveCandles);
  } catch {}

  // Price-action Regime (AWO Engine.md §5) — informational badge only, not
  // fed into composite/confidence/risk. Same pattern as weeklyTrend above.
  let priceRegime = null;
  try { priceRegime = detectPriceRegime(liveCandles.slice(-280)); } catch {}

  let trendAligned = null;
  if (weeklyTrend && weeklyTrend.trend !== 'NEUTRAL') {
    const isBullishSignal = signal === 'STRONG BUY' || signal === 'BUY';
    const isBearishSignal = signal === 'SELL' || signal === 'STRONG SELL';
    if (isBullishSignal) trendAligned = weeklyTrend.trend === 'BULLISH';
    else if (isBearishSignal) trendAligned = weeklyTrend.trend === 'BEARISH';
  }
  const marketDir = await detectMarketDirection(pool);
  const convictionTier = computeConvictionTier({ source: 'awo', trendAligned, signal, marketDirection: marketDir.direction });

  return {
    ticker, date: last.date, price: last.close, changePct: Math.round(dailyChange * 100) / 100,
    composite, signal, isLive, yahooTime, eodDate, tradePlan,
    weeklyTrend: weeklyTrend?.trend ?? null, trendAligned,
    priceRegime: priceRegime?.regime ?? null,
    convictionTier: convictionTier.tier, sizeMultiplier: convictionTier.sizeMultiplier, tierReason: convictionTier.reason,
    factorCoverage: Math.round(factorCoverage * 100) / 100,
    missingFactors,
    confidenceScore: Math.round(confidenceScore * 100) / 100,
    riskModifier: Math.round(riskModifier * 100) / 100,
    modelVersion: AWO_MODEL_VERSION,
    factors: {
      concentration: Math.round(f1), trend: Math.round(f2), volumeZ: Math.round(f3), momentum: Math.round(f4),
      relStrength: Math.round(f5), breadth: Math.round(f6), alignment: Math.round(f7), streak: Math.round(f8),
      rsi: Math.round(f9), macd: Math.round(f10), bollinger: Math.round(f11), emaTrend: Math.round(f12),
      supportResistance: Math.round(f13), atr: Math.round(f14),
    },
    liveFactors: ['volumeZ', 'momentum', 'relStrength', 'rsi', 'macd', 'bollinger', 'emaTrend', 'supportResistance', 'atr'],
    frozenFactors: ['concentration', 'trend', 'breadth', 'alignment', 'streak'],
    indicators: techIndicators,
  };
}

app.get('/api/idx-live/:code', async (req, res) => {
  try {
    const ticker = req.params.code.toUpperCase();
    const current = await computeStockFactorsLive(ticker);
    if (!current) return res.status(404).json({ error: 'Not enough price history for ' + ticker });
    res.json({ current });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function saveIHSGFactorSnapshot() {
  const f = await computeIHSGFactors();
  if (!f) return null;
  await pool.query(
    `INSERT INTO idx_ihsg_factor_history
      (date, composite_score, trend, f_breadth, f_rsi, f_macd, f_bollinger, f_ema_trend, f_support_resistance, f_atr, breadth_pct)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE composite_score=VALUES(composite_score), trend=VALUES(trend),
       f_breadth=VALUES(f_breadth), f_rsi=VALUES(f_rsi), f_macd=VALUES(f_macd), f_bollinger=VALUES(f_bollinger),
       f_ema_trend=VALUES(f_ema_trend), f_support_resistance=VALUES(f_support_resistance), f_atr=VALUES(f_atr),
       breadth_pct=VALUES(breadth_pct)`,
    [f.date, f.composite, f.trend, f.factors.breadth, f.factors.rsi, f.factors.macd, f.factors.bollinger,
     f.factors.emaTrend, f.factors.supportResistance, f.factors.atr, f.breadthPct]
  );
  return f;
}

/**
 * Harmonic pattern / Wyckoff / SMC scan for IHSG itself — same detection
 * engine used for individual stocks (harmonicEngine.js), fed the index's own
 * OHLC. Broker Flow (category E, worth 30/100 pts for stocks) doesn't apply
 * to an index, so its weight is zeroed out and redistributed across the
 * remaining categories via calcUltraConviction's own normalization — same
 * adaptation the 7-factor IHSG model already makes (Market Breadth standing
 * in for broker/concentration).
 */
const IHSG_PATTERN_WEIGHTS = { harmonic: 30, wyckoff: 20, smc: 25, volume_profile: 25, broker_flow: 0 };

async function computeIHSGPatterns() {
  const [ihsgRows] = await pool.query(
    `SELECT date, open_price o, high_price h, low_price l, close_price c, volume v FROM idx_ihsg_history ORDER BY date ASC`
  );
  if (ihsgRows.length < 30) return [];
  const candles = ihsgRows.map(r => ({
    date: toDateStr(r.date), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v),
  }));

  const { detectHarmonicPatterns, detectWyckoffPhase, detectOrderBlocks,
          detectFairValueGaps, detectLiquiditySweeps, buildVolumeProfile,
          calcUltraConviction } = require('./harmonicEngine');

  const patterns = detectHarmonicPatterns(candles, 'IHSG').filter(p => p.risk_reward >= 1.0);
  if (!patterns.length) return [];

  const last = candles[candles.length - 1];
  const wy = detectWyckoffPhase(candles) || {};
  const obs = detectOrderBlocks(candles) || [];
  const fvgs = detectFairValueGaps(candles) || [];
  const sw = detectLiquiditySweeps(candles) || {};
  const vp = buildVolumeProfile(candles) || {};
  const closes = candles.map(c => c.close);
  const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length);
  const above_vwap = last.close > ma20;
  const vols = candles.map(c => c.volume || 0);
  const avg30 = vols.slice(-30).reduce((a, b) => a + b, 0) / Math.min(30, vols.length);
  const avg5 = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const vol_spike = avg30 > 0 && (avg5 / avg30) > 1.5;

  // 30-day Bollinger series for the frontend chart — same calc as
  // harmonic-scan-worker.js's per-stock bb_data, so the same <BollingerSparkline>
  // component can render it for the index too.
  const bb_data = [];
  try {
    const startIndex = Math.max(19, closes.length - 30);
    for (let k = startIndex; k < closes.length; k++) {
      const slice = closes.slice(k - 19, k + 1);
      if (slice.length < 20) continue;
      const sma = slice.reduce((a, b) => a + b, 0) / 20;
      const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / 20;
      const stddev = Math.sqrt(variance);
      bb_data.push({
        close: closes[k], sma: Number(sma.toFixed(2)),
        upper: Number((sma + 2 * stddev).toFixed(2)), lower: Number((sma - 2 * stddev).toFixed(2)),
      });
    }
  } catch {}

  return patterns.map(p => {
    const structureData = { trend: above_vwap ? p.direction : 'NEUTRAL', lastClose: last.close, vol_spike, above_vwap };
    const wyckoffData = { phase: wy.phase || 'UNKNOWN' };
    const smcData = { order_blocks: obs, fair_value_gaps: fvgs, liquidity_sweeps: sw };
    let ms;
    try {
      ms = calcUltraConviction(p, structureData, wyckoffData, smcData, vp, {}, IHSG_PATTERN_WEIGHTS);
    } catch {
      ms = { master_score: p.fib_score || 50, signal: p.direction === 'BULLISH' ? 'BUY' : 'SELL', breakdown: {} };
    }
    return {
      ...p,
      wyckoff_phase: wy.phase || 'UNKNOWN',
      conviction_score: ms.master_score,
      signal: ms.signal,
      conviction_breakdown: ms.breakdown,
      bb_data,
    };
  }).sort((a, b) => b.conviction_score - a.conviction_score);
}

app.get('/api/ihsg-factors', async (req, res) => {
  try {
    await fetchAndCacheIHSG().catch(() => {});
    const current = await saveIHSGFactorSnapshot();
    let history = [];
    if (req.query.history === '1') {
      const [rows] = await pool.query(`
        SELECT fh.*, ih.open_price, ih.close_price, ih.change_pct
        FROM idx_ihsg_factor_history fh
        LEFT JOIN idx_ihsg_history ih ON ih.date = fh.date
        ORDER BY fh.date ASC
      `);
      history = rows.map(r => ({
        date: toDateStr(r.date), composite: r.composite_score, trend: r.trend,
        breadth: r.f_breadth, rsi: r.f_rsi, macd: r.f_macd, bollinger: r.f_bollinger,
        emaTrend: r.f_ema_trend, supportResistance: r.f_support_resistance, atr: r.f_atr,
        breadthPct: r.breadth_pct ? Number(r.breadth_pct) : null,
        openPrice: r.open_price !== null ? Number(r.open_price) : null,
        closePrice: r.close_price !== null ? Number(r.close_price) : null,
        changePct: r.change_pct !== null ? Number(r.change_pct) : null,
      }));
    }
    let patterns = [];
    try { patterns = await computeIHSGPatterns(); } catch (e) { console.log('IHSG pattern scan error:', e.message); }
    res.json({ current, history, patterns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// S&P 500 / US market layer — mirrors the IHSG block above exactly (same
// fetch/factor/pattern shape), pointed at ^GSPC and us_stock_prices instead
// of ^JKSE and idx_stock_prices. Kept as a fully separate set of functions
// and tables (not parametrized/shared with the IHSG ones) per the decision
// to keep IDX and US market data fully separate — see modules/us_tickers.js
// header for what does and doesn't port over from the IDX model.
// ═══════════════════════════════════════════════════════════════════════════
async function fetchAndCacheSP500() {
  const [[latestRow]] = await pool.query('SELECT MAX(date) d FROM sp500_history');
  const latest = latestRow?.d ? String(latestRow.d).split('T')[0] : null;
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (latest && latest >= yesterday) return { skipped: true, latest };

  const { candles } = await fetchYahooCandles('^GSPC', '2y');
  if (!candles.length) return { skipped: true, error: 'no data from Yahoo' };

  const values = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = i > 0 ? candles[i - 1].close : c.close;
    const changePct = prevClose > 0 ? ((c.close - prevClose) / prevClose) * 100 : 0;
    values.push([c.date, c.open, c.high, c.low, c.close, c.volume, Math.round(changePct * 10000) / 10000]);
  }
  const [result] = await pool.query(
    `INSERT INTO sp500_history (date, open_price, high_price, low_price, close_price, volume, change_pct)
     VALUES ?
     ON DUPLICATE KEY UPDATE open_price=VALUES(open_price), high_price=VALUES(high_price),
       low_price=VALUES(low_price), close_price=VALUES(close_price), volume=VALUES(volume), change_pct=VALUES(change_pct)`,
    [values]
  );
  return { saved: result.affectedRows, candles: candles.length };
}

async function getSP500Trend() {
  const [rows] = await pool.query('SELECT date, close_price, change_pct FROM sp500_history ORDER BY date ASC');
  if (rows.length < 15) return null;
  const last = rows[rows.length - 1];
  const trailing10 = rows.slice(-10);
  const avgDailyChange = trailing10.reduce((s, r) => s + Number(r.change_pct || 0), 0) / trailing10.length;
  const { computeWeeklyTrend } = require('./awo_technical');
  const candles = rows.map(r => ({ date: toDateStr(r.date), close: Number(r.close_price) }));
  let weeklyTrend = null;
  try { weeklyTrend = computeWeeklyTrend(candles); } catch {}
  return {
    price: Number(last.close_price),
    changePct: Number(last.change_pct),
    avgDailyChange10d: Math.round(avgDailyChange * 1000) / 1000,
    weeklyTrend: weeklyTrend?.trend ?? null,
    asOf: toDateStr(last.date),
  };
}

/** UP/DOWN/FLAT for US Conviction Tier regime sizing — same thresholds as detectMarketDirection, S&P 500 in place of IHSG. */
async function detectUSMarketDirection() {
  try {
    const [rows] = await pool.query(
      `SELECT change_pct FROM sp500_history WHERE date >= (SELECT MAX(date) FROM sp500_history) - INTERVAL 10 DAY`
    );
    if (rows.length < 5) return { direction: 'FLAT', avgDailyChange: 0 };
    const avg = rows.reduce((s, r) => s + Number(r.change_pct || 0), 0) / rows.length;
    const direction = avg > 0.15 ? 'UP' : avg < -0.15 ? 'DOWN' : 'FLAT';
    return { direction, avgDailyChange: Math.round(avg * 1000) / 1000 };
  } catch {
    return { direction: 'FLAT', avgDailyChange: 0 };
  }
}

async function computeSP500Factors() {
  const [rows] = await pool.query(
    `SELECT date, open_price o, high_price h, low_price l, close_price c, volume v FROM sp500_history ORDER BY date ASC`
  );
  if (rows.length < 30) return null;
  const candles = rows.map(r => ({
    date: toDateStr(r.date), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v),
  }));

  const { calcTechnicalFactors } = require('./awo_technical');
  const tech = calcTechnicalFactors(candles.slice(-60));

  const [[latestPriceDate]] = await pool.query('SELECT MAX(date) d FROM us_stock_prices');
  const asOfDate = latestPriceDate?.d ? toDateStr(latestPriceDate.d) : candles[candles.length - 1].date;
  const [changeRows] = await pool.query(`SELECT change_pct FROM us_stock_prices WHERE date = ?`, [asOfDate]);
  const total = changeRows.length;
  const positive = changeRows.filter(r => Number(r.change_pct) > 0).length;
  const breadthPct = total > 0 ? (positive / total) * 100 : 50;
  const f_breadth = Math.round(breadthPct);

  // f14 (ATR) applies as a Risk Modifier, not a 6th vote in the average — no
  // factor-coverage concept here (index-level breadth + tech factors are
  // always full weight), so Confidence is always 1.0. See combineFinalScore.
  const rawComposite6 = (f_breadth + tech.f9 + tech.f10 + tech.f11 + tech.f12 + tech.f13) / 6;
  const composite = combineFinalScore(rawComposite6, computeConfidence(undefined), computeRiskModifier(tech.f14));
  const trend = composite >= 60 ? 'BULLISH' : composite <= 40 ? 'BEARISH' : 'NEUTRAL';

  return {
    date: candles[candles.length - 1].date,
    composite, trend,
    factors: {
      breadth: f_breadth, rsi: tech.f9, macd: tech.f10, bollinger: tech.f11,
      emaTrend: tech.f12, supportResistance: tech.f13, atr: tech.f14,
    },
    breadthPct: Math.round(breadthPct * 100) / 100,
    indicators: tech.indicators,
  };
}

async function saveSP500FactorSnapshot() {
  const f = await computeSP500Factors();
  if (!f) return null;
  await pool.query(
    `INSERT INTO sp500_factor_history
      (date, composite_score, trend, f_breadth, f_rsi, f_macd, f_bollinger, f_ema_trend, f_support_resistance, f_atr, breadth_pct)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE composite_score=VALUES(composite_score), trend=VALUES(trend),
       f_breadth=VALUES(f_breadth), f_rsi=VALUES(f_rsi), f_macd=VALUES(f_macd), f_bollinger=VALUES(f_bollinger),
       f_ema_trend=VALUES(f_ema_trend), f_support_resistance=VALUES(f_support_resistance), f_atr=VALUES(f_atr),
       breadth_pct=VALUES(breadth_pct)`,
    [f.date, f.composite, f.trend, f.factors.breadth, f.factors.rsi, f.factors.macd, f.factors.bollinger,
     f.factors.emaTrend, f.factors.supportResistance, f.factors.atr, f.breadthPct]
  );
  return f;
}

const SP500_PATTERN_WEIGHTS = { harmonic: 30, wyckoff: 20, smc: 25, volume_profile: 25, broker_flow: 0 };

async function computeSP500Patterns() {
  const [rows] = await pool.query(
    `SELECT date, open_price o, high_price h, low_price l, close_price c, volume v FROM sp500_history ORDER BY date ASC`
  );
  if (rows.length < 30) return [];
  const candles = rows.map(r => ({
    date: toDateStr(r.date), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v),
  }));

  const { detectHarmonicPatterns, detectWyckoffPhase, detectOrderBlocks,
          detectFairValueGaps, detectLiquiditySweeps, buildVolumeProfile,
          calcUltraConviction } = require('./harmonicEngine');

  const patterns = detectHarmonicPatterns(candles, 'SP500').filter(p => p.risk_reward >= 1.0);
  if (!patterns.length) return [];

  const last = candles[candles.length - 1];
  const wy = detectWyckoffPhase(candles) || {};
  const obs = detectOrderBlocks(candles) || [];
  const fvgs = detectFairValueGaps(candles) || [];
  const sw = detectLiquiditySweeps(candles) || {};
  const vp = buildVolumeProfile(candles) || {};
  const closes = candles.map(c => c.close);
  const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length);
  const above_vwap = last.close > ma20;
  const vols = candles.map(c => c.volume || 0);
  const avg30 = vols.slice(-30).reduce((a, b) => a + b, 0) / Math.min(30, vols.length);
  const avg5 = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const vol_spike = avg30 > 0 && (avg5 / avg30) > 1.5;

  const bb_data = [];
  try {
    const startIndex = Math.max(19, closes.length - 30);
    for (let k = startIndex; k < closes.length; k++) {
      const slice = closes.slice(k - 19, k + 1);
      if (slice.length < 20) continue;
      const sma = slice.reduce((a, b) => a + b, 0) / 20;
      const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / 20;
      const stddev = Math.sqrt(variance);
      bb_data.push({
        close: closes[k], sma: Number(sma.toFixed(2)),
        upper: Number((sma + 2 * stddev).toFixed(2)), lower: Number((sma - 2 * stddev).toFixed(2)),
      });
    }
  } catch {}

  return patterns.map(p => {
    const structureData = { trend: above_vwap ? p.direction : 'NEUTRAL', lastClose: last.close, vol_spike, above_vwap };
    const wyckoffData = { phase: wy.phase || 'UNKNOWN' };
    const smcData = { order_blocks: obs, fair_value_gaps: fvgs, liquidity_sweeps: sw };
    let ms;
    try {
      ms = calcUltraConviction(p, structureData, wyckoffData, smcData, vp, {}, SP500_PATTERN_WEIGHTS);
    } catch {
      ms = { master_score: p.fib_score || 50, signal: p.direction === 'BULLISH' ? 'BUY' : 'SELL', breakdown: {} };
    }
    return {
      ...p,
      wyckoff_phase: wy.phase || 'UNKNOWN',
      conviction_score: ms.master_score,
      signal: ms.signal,
      conviction_breakdown: ms.breakdown,
      bb_data,
    };
  }).sort((a, b) => b.conviction_score - a.conviction_score);
}

app.get('/api/sp500', async (req, res) => {
  try {
    await fetchAndCacheSP500().catch(() => {});
    const trend = await getSP500Trend();
    res.json(trend || { error: 'no data yet' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sp500-factors', async (req, res) => {
  try {
    await fetchAndCacheSP500().catch(() => {});
    const current = await saveSP500FactorSnapshot();
    let history = [];
    if (req.query.history === '1') {
      const [rows] = await pool.query(`
        SELECT fh.*, sh.open_price, sh.close_price, sh.change_pct
        FROM sp500_factor_history fh
        LEFT JOIN sp500_history sh ON sh.date = fh.date
        ORDER BY fh.date ASC
      `);
      history = rows.map(r => ({
        date: toDateStr(r.date), composite: r.composite_score, trend: r.trend,
        breadth: r.f_breadth, rsi: r.f_rsi, macd: r.f_macd, bollinger: r.f_bollinger,
        emaTrend: r.f_ema_trend, supportResistance: r.f_support_resistance, atr: r.f_atr,
        breadthPct: r.breadth_pct ? Number(r.breadth_pct) : null,
        openPrice: r.open_price !== null ? Number(r.open_price) : null,
        closePrice: r.close_price !== null ? Number(r.close_price) : null,
        changePct: r.change_pct !== null ? Number(r.change_pct) : null,
      }));
    }
    let patterns = [];
    try { patterns = await computeSP500Patterns(); } catch (e) { console.log('SP500 pattern scan error:', e.message); }
    res.json({ current, history, patterns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// US market — per-stock signal scanner + deep-dive. Only the technical
// (F9-F14) factors port over — there's no broker-flow data for US equities
// (see modules/us_tickers.js header) — renormalized to sum to 1.0 so the
// composite stays on the same 0-100 scale classifySignal already expects.
// ═══════════════════════════════════════════════════════════════════════════
const { US_TICKERS } = require('./modules/us_tickers');

/** Daily incremental refresh (last 5 sessions, cheap) for all US tickers — the deep backfill (full history) happens once via the harmonic scan worker's fetchAndCacheOHLC, which pulls a longer range on first sight of a ticker. */
async function refreshUSStockPrices() {
  let updated = 0;
  for (const ticker of US_TICKERS) {
    try {
      const { candles } = await fetchYahooCandles(ticker, '5d', '');
      if (!candles.length) continue;
      const values = [];
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const prevClose = i > 0 ? candles[i - 1].close : c.close;
        const changePct = prevClose > 0 ? ((c.close - prevClose) / prevClose) * 100 : 0;
        values.push([ticker, c.date, c.open, c.high, c.low, c.close, c.volume, Math.round(changePct * 10000) / 10000]);
      }
      await pool.query(
        `INSERT INTO us_stock_prices (ticker, date, open_price, high_price, low_price, close_price, volume, change_pct)
         VALUES ? ON DUPLICATE KEY UPDATE open_price=VALUES(open_price), high_price=VALUES(high_price),
         low_price=VALUES(low_price), close_price=VALUES(close_price), volume=VALUES(volume), change_pct=VALUES(change_pct)`,
        [values]
      );
      updated++;
    } catch {}
  }
  return { updated };
}

// F1, F2, F6, F7, F8 genuinely need broker/concentration data (dn0-dn4, buyer/seller
// counts) that doesn't exist for US equities. But F3 (Volume Z-Score), F4 (Price
// Momentum) and F5 (Relative Strength) turn out to be pure price/volume math —
// f3_volumeZ(volumes, priceDirection), f4_momentum(closes), f5_relStrength(stockChg,
// marketAvgChg) — none of them touch broker data, so they DO port over. Caught after
// the user asked why F5 wasn't showing on the US pages; corrected from an initial
// (too-conservative) cut that excluded all of F1-F8 wholesale.
// f14 excluded from this renormalized set — it applies as a Risk Modifier
// (computeRiskModifier), not a direct weighted vote.
const US_TECH_WEIGHTS = (() => {
  const base = {
    f3: DEFAULT_WEIGHTS.f3, f4: DEFAULT_WEIGHTS.f4, f5: DEFAULT_WEIGHTS.f5,
    f9: DEFAULT_WEIGHTS.f9, f10: DEFAULT_WEIGHTS.f10, f11: DEFAULT_WEIGHTS.f11,
    f12: DEFAULT_WEIGHTS.f12, f13: DEFAULT_WEIGHTS.f13,
  };
  const sum = Object.values(base).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v / sum]));
})();

/**
 * Technical + price-derived composite/signal/tradePlan for one ticker's candle
 * history — shared by the US scanner and deep-dive routes. `marketAvgChangePct`
 * is the cross-sectional mean daily change across all US_TICKERS for the SAME
 * day as the last candle in `candles` — passed in rather than computed here so
 * callers can supply the correct point-in-time value (no lookahead) when this
 * runs inside a historical rolling-window loop.
 */
function computeUSStockFactors(candles, marketDirection, marketAvgChangePct = 0) {
  if (!candles || candles.length < 15) return null;
  const { calcTechnicalFactors, computeWeeklyTrend, computeTradePlan } = require('./awo_technical');
  const tech = calcTechnicalFactors(candles.slice(-60));

  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume || 0);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const dailyChangePct = prev && prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : 0;

  const f3 = f3_volumeZ(volumes, dailyChangePct);
  const f4 = f4_momentum(closes);
  const f5 = f5_relStrength(dailyChangePct, marketAvgChangePct);

  const rawComposite8 =
    f3 * US_TECH_WEIGHTS.f3 + f4 * US_TECH_WEIGHTS.f4 + f5 * US_TECH_WEIGHTS.f5 +
    tech.f9 * US_TECH_WEIGHTS.f9 + tech.f10 * US_TECH_WEIGHTS.f10 + tech.f11 * US_TECH_WEIGHTS.f11 +
    tech.f12 * US_TECH_WEIGHTS.f12 + tech.f13 * US_TECH_WEIGHTS.f13;
  const composite = combineFinalScore(rawComposite8, computeConfidence(undefined), computeRiskModifier(tech.f14));
  const signal = classifySignal(composite);

  let weeklyTrend = null;
  try { weeklyTrend = computeWeeklyTrend(candles); } catch {}
  let trendAligned = null;
  if (weeklyTrend && weeklyTrend.trend !== 'NEUTRAL') {
    const isBullishSignal = signal === 'STRONG BUY' || signal === 'BUY';
    const isBearishSignal = signal === 'SELL' || signal === 'STRONG SELL';
    if (isBullishSignal) trendAligned = weeklyTrend.trend === 'BULLISH';
    else if (isBearishSignal) trendAligned = weeklyTrend.trend === 'BEARISH';
  }

  const currentPrice = last.close;
  let tradePlan = null;
  try { tradePlan = computeTradePlan(currentPrice, signal, tech.indicators?.atr ?? null, tech.indicators?.sr ?? null); } catch {}

  const convictionTier = computeConvictionTier({ source: 'awo', trendAligned, signal, marketDirection, market: 'US' });

  return {
    composite, signal,
    factors: {
      volumeZ: Math.round(f3), momentum: Math.round(f4), relStrength: Math.round(f5),
      rsi: Math.round(tech.f9), macd: Math.round(tech.f10), bollinger: Math.round(tech.f11),
      emaTrend: Math.round(tech.f12), supportResistance: Math.round(tech.f13), atr: Math.round(tech.f14),
    },
    indicators: tech.indicators, weeklyTrend: weeklyTrend?.trend ?? null, trendAligned, tradePlan,
    convictionTier: convictionTier.tier, sizeMultiplier: convictionTier.sizeMultiplier, tierReason: convictionTier.reason,
  };
}

app.get('/api/us-signal-scanner', async (req, res) => {
  try {
    const [priceRows] = await pool.query(
      `SELECT ticker, date, open_price, high_price, low_price, close_price, volume, change_pct
       FROM us_stock_prices WHERE ticker IN (?) ORDER BY date ASC`,
      [US_TICKERS]
    );
    const priceMap = {};
    for (const r of priceRows) {
      if (!priceMap[r.ticker]) priceMap[r.ticker] = [];
      priceMap[r.ticker].push({
        date: toDateStr(r.date), open: Number(r.open_price || r.close_price), high: Number(r.high_price || r.close_price),
        low: Number(r.low_price || r.close_price), close: Number(r.close_price), volume: Number(r.volume), changePct: Number(r.change_pct),
      });
    }

    const marketDir = await detectUSMarketDirection();

    // Cross-sectional mean daily change across every tracked ticker's latest
    // session — the "market average" F5 (Relative Strength) compares each
    // stock against. Same idea as the IDX scanner's marketAvgChange.
    const latestChanges = Object.values(priceMap)
      .map(c => c[c.length - 1]?.changePct)
      .filter(v => v !== undefined && !Number.isNaN(v));
    const marketAvgChangePct = latestChanges.length
      ? latestChanges.reduce((a, b) => a + b, 0) / latestChanges.length
      : 0;

    const results = [];
    for (const ticker of US_TICKERS) {
      const candles = priceMap[ticker] || [];
      if (candles.length < 15) continue;
      const f = computeUSStockFactors(candles, marketDir.direction, marketAvgChangePct);
      if (!f) continue;
      const last = candles[candles.length - 1];
      results.push({
        ticker, price: last.close, dailyChange: Math.round(last.changePct * 100) / 100,
        score: f.composite, signal: f.signal, tradePlan: f.tradePlan,
        weeklyTrend: f.weeklyTrend, trendAligned: f.trendAligned,
        convictionTier: f.convictionTier, sizeMultiplier: f.sizeMultiplier, tierReason: f.tierReason,
      });
    }
    results.sort((a, b) => b.score - a.score);

    const counts = { strong_buy: 0, buy: 0, watch: 0, neutral: 0, sell: 0, strong_sell: 0 };
    for (const r of results) {
      if (r.signal === 'STRONG BUY') counts.strong_buy++;
      else if (r.signal === 'BUY') counts.buy++;
      else if (r.signal === 'WATCH') counts.watch++;
      else if (r.signal === 'NEUTRAL') counts.neutral++;
      else if (r.signal === 'SELL') counts.sell++;
      else if (r.signal === 'STRONG SELL') counts.strong_sell++;
    }

    res.json({ data: results, counts, marketDirection: marketDir.direction, total: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/us-deepdive/:ticker', async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    const [rows] = await pool.query(
      `SELECT date, open_price o, high_price h, low_price l, close_price c, volume v
       FROM us_stock_prices WHERE ticker = ? ORDER BY date ASC`,
      [ticker]
    );
    if (rows.length < 15) return res.json({ ticker, priceHistory: [], factorHistory: [], latest: null, convictionTier: null });

    const candles = rows.map(r => ({
      date: toDateStr(r.date), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v),
    }));

    const marketDir = await detectUSMarketDirection();

    // Point-in-time cross-sectional average per date (for F5 Relative Strength)
    // — a real historical market average for THAT day, not today's, so the
    // rolling factor history below stays no-lookahead.
    const [avgRows] = await pool.query(
      `SELECT date, AVG(change_pct) avg_chg FROM us_stock_prices GROUP BY date`
    );
    const marketAvgByDate = new Map(avgRows.map(r => [toDateStr(r.date), Number(r.avg_chg) || 0]));

    // Rolling per-day factor history — window ends at that day, no lookahead (same approach as regenerate_ihsg_factor_history.js).
    const factorHistory = [];
    for (let i = 14; i < candles.length; i++) {
      const window = candles.slice(0, i + 1).slice(-60);
      const f = computeUSStockFactors(window, marketDir.direction, marketAvgByDate.get(candles[i].date) || 0);
      if (!f) continue;
      factorHistory.push({
        date: candles[i].date, composite: f.composite, signal: f.signal,
        closePrevDay: i > 0 ? candles[i - 1].close : null, closeToday: candles[i].close,
        ...f.factors,
      });
    }

    const latestFull = computeUSStockFactors(candles, marketDir.direction, marketAvgByDate.get(candles[candles.length - 1].date) || 0);
    const latest = latestFull
      ? { date: candles[candles.length - 1].date, composite: latestFull.composite, signal: latestFull.signal, ...latestFull.factors }
      : null;
    const convictionTier = latestFull
      ? { tier: latestFull.convictionTier, sizeMultiplier: latestFull.sizeMultiplier, reason: latestFull.tierReason }
      : null;

    res.json({ ticker, priceHistory: candles, factorHistory, latest, convictionTier });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// f7_alignment and f8_streak moved to modules/awo_factors.js — see the
// require() near the other F1-F8 factors above.

// ─── IDX Deep-Dive (per-ticker 14-factor history) — TOP 20 big caps ─────────
// Companion to the /idx and /idx/[code] pages. Uses idx_signal_history
// (data_source='live' only — 'backfill' rows are flagged contaminated from
// the 2026-07-19 overfitting incident, see project memory) for the factor
// time series, and idx_stock_prices for the price chart backbone.
const { BIG_CAP_100 } = require('./modules/tickers');

app.get('/api/idx-deepdive', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT stock_code, close_price, change_pct, date
       FROM idx_stock_prices
       WHERE stock_code IN (?) AND date = (SELECT MAX(date) FROM idx_stock_prices)`,
      [BIG_CAP_100]
    );
    const priceMap = {};
    for (const r of rows) priceMap[r.stock_code] = r;

    const [sigRows] = await pool.query(
      `SELECT s1.stock_code, s1.composite_score, s1.signal_type, s1.confidence, s1.data_date
       FROM idx_signal_history s1
       INNER JOIN (
         SELECT stock_code, MAX(data_date) md FROM idx_signal_history
         WHERE data_source='live' AND stock_code IN (?) GROUP BY stock_code
       ) latest ON s1.stock_code = latest.stock_code AND s1.data_date = latest.md
       WHERE s1.data_source='live'`,
      [BIG_CAP_100]
    );
    const sigMap = {};
    for (const r of sigRows) sigMap[r.stock_code] = r;

    const data = BIG_CAP_100.map(ticker => {
      const p = priceMap[ticker];
      const s = sigMap[ticker];
      return {
        ticker,
        price: p ? Number(p.close_price) : null,
        changePct: p ? Number(p.change_pct) : null,
        compositeScore: s ? s.composite_score : null,
        signal: s ? s.signal_type : null,
        confidence: s ? s.confidence : null,
      };
    });
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/idx-deepdive/:code', async (req, res) => {
  const ticker = req.params.code.toUpperCase();
  if (!BIG_CAP_100.includes(ticker)) return res.status(404).json({ error: 'Not in TOP 100 big-cap list' });
  try {
    const [priceRows] = await pool.query(
      `SELECT date, open_price o, high_price h, low_price l, close_price c, volume v
       FROM idx_stock_prices WHERE stock_code = ? ORDER BY date ASC`,
      [ticker]
    );
    const priceHistory = priceRows.map(r => ({
      date: toDateStr(r.date), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v),
    }));

    const [factorRows] = await pool.query(
      `SELECT data_date, composite_score, signal_type, confidence,
              f1_concentration, f2_trend, f3_volume_z, f4_momentum, f5_rel_strength,
              f6_breadth, f7_alignment, f8_streak, f9_rsi, f10_macd, f11_bollinger,
              f12_ema_trend, f13_support_resistance, f14_atr
       FROM idx_signal_history WHERE stock_code = ? AND data_source IN ('live', 'backfill_v2') ORDER BY data_date ASC`,
      [ticker]
    );
    const priceIndexByDate = new Map(priceHistory.map((p, i) => [p.date, i]));
    const factorHistory = factorRows.map(r => {
      const dateStr = toDateStr(r.data_date);
      const idx = priceIndexByDate.get(dateStr);
      const closeToday = idx !== undefined ? priceHistory[idx].close : null;
      const closePrevDay = idx !== undefined && idx > 0 ? priceHistory[idx - 1].close : null;
      return {
        date: dateStr, composite: r.composite_score, signal: r.signal_type, confidence: r.confidence,
        f1: r.f1_concentration, f2: r.f2_trend, f3: r.f3_volume_z, f4: r.f4_momentum, f5: r.f5_rel_strength,
        f6: r.f6_breadth, f7: r.f7_alignment, f8: r.f8_streak, f9: r.f9_rsi, f10: r.f10_macd,
        f11: r.f11_bollinger, f12: r.f12_ema_trend, f13: r.f13_support_resistance, f14: r.f14_atr,
        closePrevDay, closeToday,
      };
    });

    const latest = factorHistory[factorHistory.length - 1] || null;
    const marketDir = await detectMarketDirection(pool);
    const convictionTier = latest
      ? computeConvictionTier({ source: 'awo', signal: latest.signal, marketDirection: marketDir.direction })
      : null;

    res.json({ ticker, priceHistory, factorHistory, latest, convictionTier });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Signal Scanner API ─────────────────────────────────────────────────────
app.get('/api/signal-scanner', async (req, res) => {
  try {
    const toStr = d => (d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0]);

    // ── 1. Find latest date with data ────────────────────────────────────────
    const [dateRows] = await pool.query(
      'SELECT DISTINCT date FROM idx_broker_summary ORDER BY date DESC LIMIT 20'
    );
    if (dateRows.length === 0) return res.json({ data: [], date: '', source: 'empty' });

    const dates = dateRows.map(r => toStr(r.date));
    const latestDate = dates[0];

    // ── 2. Score EVERY tracked ticker (TOP_STOCKS), not just whichever subset
    // happened to have broker_summary rows on the single latest date — a thin
    // day for a given stock (or it just missed that day's Index Alpha pull)
    // used to silently drop it from "ALL" entirely. Factors already default
    // gracefully to neutral (50) when a given data point is missing, so this
    // is safe — tickers just show up with a more neutral score instead of
    // vanishing. The STRONG BUY/BUY/WATCH/SELL/STRONG SELL tabs still filter
    // on top of this unchanged.
    const stockRows = TOP_STOCKS.map(code => ({ stock_code: code }));
    const tickers = TOP_STOCKS;

    // ── 3. Fetch all needed data in batch ────────────────────────────────────
    const concDates = dates.slice(0, 5);
    const [concRows] = concDates.length > 0
      ? await pool.query(
          'SELECT data_date, stock_code, dn0, dn1, dn2, dn3, dn4, price, change_pct FROM idx_concentration WHERE data_date IN (?)',
          [concDates]
        )
      : [[]];
    const concMap = {};
    for (const r of concRows) {
      const d = toStr(r.data_date);
      if (!concMap[r.stock_code]) concMap[r.stock_code] = {};
      concMap[r.stock_code][d] = r;
    }

    const [priceRows] = tickers.length > 0
      ? await pool.query(
          `SELECT stock_code, date, open_price, high_price, low_price, close_price, volume, change_pct
           FROM idx_stock_prices WHERE stock_code IN (?) ORDER BY date ASC`,
          [tickers]
        )
      : [[]];
    const priceMap = {};
    for (const r of priceRows) {
      if (!priceMap[r.stock_code]) priceMap[r.stock_code] = [];
      priceMap[r.stock_code].push({
        date: toStr(r.date),
        open: Number(r.open_price || r.close_price),
        high: Number(r.high_price || r.close_price),
        low: Number(r.low_price || r.close_price),
        close: Number(r.close_price),
        volume: Number(r.volume),
        changePct: Number(r.change_pct),
      });
    }

    const yfMap = await fetchYahooPrices(tickers);

    // Foreign/domestic flow divergence (see computeForeignDivergence) — aggregated
    // across RG+NG and across brokers, for the latest date only.
    const [flowDivRows] = tickers.length > 0
      ? await pool.query(
          `SELECT stock_code, investor_type, SUM(buy_val) as buy, SUM(sell_val) as sell
           FROM idx_broker_flow_detail WHERE date = ? AND stock_code IN (?)
           GROUP BY stock_code, investor_type`,
          [latestDate, tickers]
        )
      : [[]];
    const flowDivMap = {};
    for (const r of flowDivRows) {
      if (!flowDivMap[r.stock_code]) flowDivMap[r.stock_code] = {};
      flowDivMap[r.stock_code][r.investor_type] = { buy: Number(r.buy), sell: Number(r.sell) };
    }

    const [breadthRows] = await pool.query(`
      SELECT stock_code,
        SUM(CASE WHEN buy_val > sell_val THEN 1 ELSE 0 END) as net_buyers,
        SUM(CASE WHEN sell_val > buy_val THEN 1 ELSE 0 END) as net_sellers
      FROM idx_broker_summary WHERE date = ?
      GROUP BY stock_code
    `, [latestDate]);
    const breadthMap = {};
    for (const r of breadthRows) {
      breadthMap[r.stock_code] = { buyers: Number(r.net_buyers), sellers: Number(r.net_sellers) };
    }

    const [topBrokerRows] = await pool.query(`
      SELECT stock_code, broker_code, (buy_val - sell_val) as net_val
      FROM idx_broker_summary WHERE date = ?
      ORDER BY stock_code, (buy_val - sell_val) DESC
    `, [latestDate]);
    const topBuyerMap = {};
    const topSellerMap = {};
    for (const r of topBrokerRows) {
      const net = Number(r.net_val);
      if (net > 0 && !topBuyerMap[r.stock_code]) topBuyerMap[r.stock_code] = r.broker_code;
      if (net < 0 && !topSellerMap[r.stock_code]) topSellerMap[r.stock_code] = r.broker_code;
    }

    const allChanges = [];
    for (const ticker of tickers) {
      const yf = yfMap[ticker];
      const pHistory = priceMap[ticker] || [];
      const chg = yf?.changePct !== undefined ? yf.changePct
        : (pHistory.length > 0 ? pHistory[pHistory.length - 1].changePct : 0);
      allChanges.push(chg);
    }
    const marketAvgChange = stats.mean(allChanges);

    const [winRateRows] = await pool.query(`
      SELECT signal_type,
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins
      FROM idx_signal_history
      WHERE outcome IS NOT NULL
      GROUP BY signal_type
    `);
    const winRateMap = {};
    for (const r of winRateRows) {
      winRateMap[r.signal_type] = {
        total: Number(r.total),
        wins: Number(r.wins),
        rate: Number(r.total) > 0 ? Math.round((Number(r.wins) / Number(r.total)) * 100) : 0,
      };
    }

    // ── 4. Score each stock ──────────────────────────────────────────────────
    await fetchAndCacheIHSG().catch(() => {});
    const marketDir = await detectMarketDirection(pool);
    const ihsgTrend = await getIHSGTrend().catch(() => null);
    const results = [];
    for (const stock of stockRows) {
      const ticker = stock.stock_code;
      const conc = concMap[ticker] || {};
      const latestConc = conc[latestDate];
      const pHistory = priceMap[ticker] || [];
      const yf = yfMap[ticker];
      const breadth = breadthMap[ticker] || { buyers: 0, sellers: 0 };

      const dn0 = latestConc ? Number(latestConc.dn0 ?? 0) : 0;
      const dnValues = latestConc
        ? [latestConc.dn4, latestConc.dn3, latestConc.dn2, latestConc.dn1, latestConc.dn0]
            .map(v => v !== null && v !== undefined ? Number(v) : null)
        : [];

      const closes = pHistory.map(p => p.close).filter(c => c > 0);
      const volumes = pHistory.map(p => p.volume).filter(v => v > 0);
      const currentPrice = yf?.price || (closes.length > 0 ? closes[closes.length - 1] : 0);
      const dailyChange = yf?.changePct !== undefined ? yf.changePct
        : (pHistory.length > 0 ? pHistory[pHistory.length - 1].changePct : 0);
      const priceDirection = dailyChange;

      const f1 = f1_concentration(dn0);
      const f2 = f2_trend(dnValues.filter(v => v !== null));
      const f3 = f3_volumeZ(volumes, priceDirection);
      const f4 = f4_momentum(closes);
      const f5 = f5_relStrength(dailyChange, marketAvgChange);
      const f6 = f6_breadth(breadth.buyers, breadth.sellers);
      const f7 = f7_alignment(dailyChange, dn0);
      const f8 = f8_streak(dnValues.filter(v => v !== null));

      // Broker/concentration data availability — f1/f2/f7/f8 need latestConc,
      // f6 needs a breadthMap entry. When absent these factors still compute
      // a placeholder (dn0 defaults to 0 above), but must NOT keep full
      // weight in the composite — see weightedComposite's doc comment.
      const brokerDataAvailable = !!latestConc;
      const breadthDataAvailable = !!breadthMap[ticker];

      // ── AWO: Use adaptive weights ──────────────────────────────
      const activeW = getActiveWeights();

      // ── Technical factors (f9-f14) from OHLCV data ──────────────
      // Fixed 2026-07-31 (external review, round 3, findings #2/#4): this
      // used to gate ALL of f9-f13 behind one `candles.length >= 15` check
      // (RSI's minimum only — Bollinger/S-R need 20, EMA-trend needs 21,
      // MACD needs 35), then the availability object passed to
      // combineFactorScores below never included f9-f13 keys at all — so a
      // fake-50 (candles.length between 15 and the real per-indicator
      // minimum) was always scored as if it were a real, fully-weighted
      // reading. calcTechnicalFactors is safe to call unconditionally and
      // now reports its own real per-indicator availability.
      let f9 = 50, f10 = 50, f11 = 50, f12 = 50, f13 = 50, f14 = 50;
      let techIndicators = null;
      let techFactorAvailable = { f9: false, f10: false, f11: false, f12: false, f13: false };
      let weeklyTrend = null;
      let priceRegime = null;
      try {
        const { calcTechnicalFactors, computeWeeklyTrend } = require('./awo_technical');
        const candles = pHistory.map(p => ({ date: p.date, open: p.open || p.close, high: p.high || p.close, low: p.low || p.close, close: p.close, volume: p.volume }));
        const tech = calcTechnicalFactors(candles.slice(-60));
        f9 = tech.f9; f10 = tech.f10; f11 = tech.f11;
        f12 = tech.f12; f13 = tech.f13; f14 = tech.f14;
        techIndicators = tech.indicators;
        techFactorAvailable = tech.factorAvailable;
        // Top-down context: full daily history (not just the last 60), aggregated
        // to weekly, for the higher-timeframe trend — separate from and not folded
        // into the composite score (see computeWeeklyTrend's doc comment).
        weeklyTrend = computeWeeklyTrend(candles);
        // Price-action Regime (AWO Engine.md §5) — informational badge only,
        // same pattern as weeklyTrend: does NOT feed into composite/confidence/risk.
        priceRegime = detectPriceRegime(candles.slice(-280));
      } catch {}

      // Single source of truth (follow-up #7, 2026-07-30): combineFactorScores
      // is the SAME function awo_optimizer.js's rescoreSignal and
      // computeStockFactorsLive call — excludes any factor lacking real data
      // (f1/f2/f7/f8/f6) from both the numerator and the weight sum instead
      // of silently diluting toward 50 at full weight (see its doc comment).
      // Final score per AWO Engine.md §3.4: Directional × Confidence × Risk.
      const { factorCoverage, missingFactors, confidence: confidenceScore, riskModifier, finalScore: composite, decision: signal } = combineFactorScores(
        { f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13 }, f14,
        {
          f1: brokerDataAvailable, f2: brokerDataAvailable, f6: breadthDataAvailable, f7: brokerDataAvailable, f8: brokerDataAvailable,
          f9: techFactorAvailable.f9, f10: techFactorAvailable.f10, f11: techFactorAvailable.f11,
          f12: techFactorAvailable.f12, f13: techFactorAvailable.f13,
        },
        activeW, getActiveThresholds()
      );

      // Does the weekly (higher-timeframe) trend agree with this signal's direction?
      // null = not a directional signal (WATCH/NEUTRAL) or insufficient weekly history.
      let trendAligned = null;
      if (weeklyTrend && weeklyTrend.trend !== 'NEUTRAL') {
        const isBullishSignal = signal === 'STRONG BUY' || signal === 'BUY';
        const isBearishSignal = signal === 'SELL' || signal === 'STRONG SELL';
        if (isBullishSignal) trendAligned = weeklyTrend.trend === 'BULLISH';
        else if (isBearishSignal) trendAligned = weeklyTrend.trend === 'BEARISH';
      }

      // Regime gate — SHADOW MODE only (P1 follow-up #13, 2026-07-30): logs
      // what a counter-trend gate on detectPriceRegime WOULD decide, purely
      // for later analysis against real outcomes. Never affects `signal`,
      // never filters `results` — see regimeGateVerdict's doc comment.
      const regimeGateShadow = regimeGateVerdict(signal, priceRegime?.regime ?? null);

      const fd = flowDivMap[ticker];
      const foreignDivergence = fd
        ? computeForeignDivergence(fd.foreign?.buy, fd.foreign?.sell, fd.domestic?.buy, fd.domestic?.sell)
        : null;

      let tradePlan = null;
      try {
        const { computeTradePlan } = require('./awo_technical');
        tradePlan = computeTradePlan(currentPrice, signal, techIndicators?.atr ?? null, techIndicators?.sr ?? null);
      } catch {}

      const wr = winRateMap[signal];
      const winRate = wr ? wr.rate : 0;
      const winRateSample = wr ? wr.total : 0;
      const scoreStrength = Math.abs(composite - 50) * 2;
      const confidence = winRateSample >= 10
        ? Math.round(winRate * 0.7 + scoreStrength * 0.3)
        : Math.round(scoreStrength * 0.5 + 40);

      const rawVolumeZ = volumes.length >= 5 ? stats.zScoreFromArray(volumes) : 0;
      const rawMomentum5d = closes.length >= 6 ? stats.roc(closes, 5) : 0;

      const convictionTier = computeConvictionTier({ source: 'awo', trendAligned, signal, marketDirection: marketDir.direction });

      results.push({
        ticker,
        price: currentPrice,
        dailyChange: Math.round(dailyChange * 100) / 100,
        days: dnValues.map(v => v ?? 0),
        score: composite,
        signal,
        confidence,
        winRate,
        winRateSample,
        tradePlan,
        weeklyTrend: weeklyTrend?.trend ?? null,
        trendAligned,
        priceRegime: priceRegime?.regime ?? null,
        regimeGateShadow,
        foreignDivergence,
        convictionTier: convictionTier.tier,
        sizeMultiplier: convictionTier.sizeMultiplier,
        tierReason: convictionTier.reason,
        topBuyer: topBuyerMap[ticker] || null,
        topSeller: topSellerMap[ticker] || null,
        netBuyers: breadth.buyers,
        netSellers: breadth.sellers,
        factorCoverage: Math.round(factorCoverage * 100) / 100,
        missingFactors,
        confidenceScore: Math.round(confidenceScore * 100) / 100,
        riskModifier: Math.round(riskModifier * 100) / 100,
        factors: {
          concentration: Math.round(f1),
          trend: Math.round(f2),
          volumeZ: Math.round(f3),
          momentum: Math.round(f4),
          relStrength: Math.round(f5),
          breadth: Math.round(f6),
          alignment: Math.round(f7),
          streak: Math.round(f8),
          rsi: Math.round(f9),
          macd: Math.round(f10),
          bollinger: Math.round(f11),
          emaTrend: Math.round(f12),
          supportResistance: Math.round(f13),
          atr: Math.round(f14),
        },
        volumeZScore: Math.round(rawVolumeZ * 100) / 100,
        momentum5d: Math.round(rawMomentum5d * 100) / 100,
      });
    }

    results.sort((a, b) => Math.abs(b.score - 50) - Math.abs(a.score - 50));

    // ── AWO: Save signals with regime info ──────────────────────
    let regimeAtSignal = 'DEFAULT';
    try { const rd = await detectRegime(pool); regimeAtSignal = rd.regime; } catch {}

    (async () => {
      try {
        for (const r of results) {
          await pool.query(`
            INSERT INTO idx_signal_history
              (data_date, stock_code, composite_score, signal_type, confidence,
               f1_concentration, f2_trend, f3_volume_z, f4_momentum,
               f5_rel_strength, f6_breadth, f7_alignment, f8_streak,
               f9_rsi, f10_macd, f11_bollinger, f12_ema_trend,
               f13_support_resistance, f14_atr,
               price_at_signal, regime_at_signal,
               price_regime_at_signal, regime_gate_would_block, regime_gate_reason)
            VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?, ?,?, ?,?,?)
            ON DUPLICATE KEY UPDATE
              composite_score=VALUES(composite_score), signal_type=VALUES(signal_type),
              confidence=VALUES(confidence),
              f1_concentration=VALUES(f1_concentration), f2_trend=VALUES(f2_trend),
              f3_volume_z=VALUES(f3_volume_z), f4_momentum=VALUES(f4_momentum),
              f5_rel_strength=VALUES(f5_rel_strength), f6_breadth=VALUES(f6_breadth),
              f7_alignment=VALUES(f7_alignment), f8_streak=VALUES(f8_streak),
              f9_rsi=VALUES(f9_rsi), f10_macd=VALUES(f10_macd),
              f11_bollinger=VALUES(f11_bollinger), f12_ema_trend=VALUES(f12_ema_trend),
              f13_support_resistance=VALUES(f13_support_resistance), f14_atr=VALUES(f14_atr),
              price_at_signal=VALUES(price_at_signal), regime_at_signal=VALUES(regime_at_signal),
              price_regime_at_signal=VALUES(price_regime_at_signal),
              regime_gate_would_block=VALUES(regime_gate_would_block),
              regime_gate_reason=VALUES(regime_gate_reason)
          `, [latestDate, r.ticker, r.score, r.signal, r.confidence,
              r.factors.concentration, r.factors.trend, r.factors.volumeZ, r.factors.momentum,
              r.factors.relStrength, r.factors.breadth, r.factors.alignment, r.factors.streak,
              r.factors.rsi, r.factors.macd, r.factors.bollinger, r.factors.emaTrend,
              r.factors.supportResistance, r.factors.atr,
              r.price, regimeAtSignal,
              r.priceRegime, r.regimeGateShadow?.wouldBlock ? 1 : 0, r.regimeGateShadow?.reason ?? null]);
        }
      } catch (e) { console.error('Signal history save error:', e.message); }
    })();

    const bullishCount = results.filter(r => r.score >= 56).length;
    const bearishCount = results.filter(r => r.score <= 44).length;
    const neutralCount = results.length - bullishCount - bearishCount;

    // Detect current regime for response metadata
    let currentRegime = { regime: 'DEFAULT', confidence: 0 };
    try { currentRegime = await detectRegime(pool); } catch {}

    res.json({
      data: results,
      date: latestDate,
      dates: dates.slice(0, 5),
      source: 'quant-engine-v3-awo',
      engine: {
        version: AWO_MODEL_VERSION,
        factors: 14,
        weights: getActiveWeights(),
        thresholds: getActiveThresholds(),
        regime: currentRegime.regime,
        isOptimized: _awoWeights !== null,
        marketDirection: marketDir.direction,
        marketDirectionAvgChange: marketDir.avgDailyChange,
        marketDirectionSource: marketDir.source,
      },
      ihsg: ihsgTrend,
      market: {
        total: results.length,
        bullish: bullishCount,
        bearish: bearishCount,
        neutral: neutralCount,
        avgChange: Math.round(marketAvgChange * 100) / 100,
        breadthPct: results.length > 0 ? Math.round((bullishCount / results.length) * 100) : 50,
      },
    });

  } catch (err) {
    console.error('Signal scanner error:', err.message);
    res.json({ data: [], error: err.message });
  }
});

// ─── Signal Scanner — historical time frame ──────────────────────────────────
// /api/signal-scanner saves every ticker's computed row into idx_signal_history
// on every hit (upserted per date+ticker — see the fire-and-forget save right
// after `results.sort` above), so past dates are real recorded snapshots, not
// a re-run of today's logic. No ?date param returns the list of available
// dates (for the frontend's time-frame dropdown); with ?date=YYYY-MM-DD it
// returns that day's saved rows. Some fields the live endpoint returns
// (tradePlan, weeklyTrend, trendAligned, convictionTier) aren't stored per
// row and are intentionally omitted here rather than faked.
app.get('/api/signal-scanner-history', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      const [dateRows] = await pool.query(
        `SELECT DISTINCT data_date FROM idx_signal_history WHERE data_source IN ('live','backfill_v2') ORDER BY data_date DESC LIMIT 120`
      );
      return res.json({ dates: dateRows.map(r => toDateStr(r.data_date)) });
    }

    const [rows] = await pool.query(
      `SELECT * FROM idx_signal_history WHERE data_date = ? AND data_source IN ('live','backfill_v2')`,
      [date]
    );
    if (!rows.length) return res.json({ data: [], date, count: 0 });

    const tickers = rows.map(r => r.stock_code);

    const [priceRows] = await pool.query(
      `SELECT stock_code, change_pct FROM idx_stock_prices WHERE stock_code IN (?) AND date = ?`,
      [tickers, date]
    );
    const changeMap = {};
    for (const r of priceRows) changeMap[r.stock_code] = Number(r.change_pct);

    const [brokerRows] = await pool.query(
      `SELECT stock_code, broker_code, (buy_val - sell_val) net_val FROM idx_broker_summary
       WHERE date = ? AND stock_code IN (?) ORDER BY stock_code, (buy_val - sell_val) DESC`,
      [date, tickers]
    );
    const topBuyerMap = {}, topSellerMap = {};
    for (const r of brokerRows) {
      const net = Number(r.net_val);
      if (net > 0 && !topBuyerMap[r.stock_code]) topBuyerMap[r.stock_code] = r.broker_code;
      if (net < 0 && !topSellerMap[r.stock_code]) topSellerMap[r.stock_code] = r.broker_code;
    }

    const data = rows.map(r => ({
      ticker: r.stock_code,
      price: Number(r.price_at_signal),
      dailyChange: changeMap[r.stock_code] ?? null,
      score: Math.round(r.composite_score),
      signal: r.signal_type,
      confidence: Math.round(r.confidence || 0),
      topBuyer: topBuyerMap[r.stock_code] || null,
      topSeller: topSellerMap[r.stock_code] || null,
      regimeAtSignal: r.regime_at_signal,
      factors: {
        concentration: Math.round(r.f1_concentration), trend: Math.round(r.f2_trend),
        volumeZ: Math.round(r.f3_volume_z), momentum: Math.round(r.f4_momentum),
        relStrength: Math.round(r.f5_rel_strength), breadth: Math.round(r.f6_breadth),
        alignment: Math.round(r.f7_alignment), streak: Math.round(r.f8_streak),
        rsi: Math.round(r.f9_rsi), macd: Math.round(r.f10_macd), bollinger: Math.round(r.f11_bollinger),
        emaTrend: Math.round(r.f12_ema_trend), supportResistance: Math.round(r.f13_support_resistance),
        atr: Math.round(r.f14_atr),
      },
    })).sort((a, b) => Math.abs(b.score - 50) - Math.abs(a.score - 50));

    res.json({ data, date, count: data.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Signal Scanner Detail — Per-stock factor breakdown ──────────────────────
app.get('/api/signal-scanner/detail', async (req, res) => {
  const ticker = (req.query.ticker || '').toUpperCase();
  if (!ticker) return res.json({ error: 'ticker required' });

  try {
    const [histRows] = await pool.query(`
      SELECT data_date, composite_score, signal_type, confidence,
             f1_concentration, f2_trend, f3_volume_z, f4_momentum,
             f5_rel_strength, f6_breadth, f7_alignment, f8_streak,
             price_at_signal, price_5d_later, outcome
      FROM idx_signal_history
      WHERE stock_code = ?
      ORDER BY data_date DESC
      LIMIT 30
    `, [ticker]);

    const completed = histRows.filter(r => r.outcome !== null);
    const wins = completed.filter(r => r.outcome === 'WIN').length;
    const stockWinRate = completed.length > 0 ? Math.round((wins / completed.length) * 100) : 0;

    res.json({
      ticker,
      history: histRows.map(r => ({
        date: r.data_date instanceof Date ? r.data_date.toISOString().split('T')[0] : String(r.data_date).split('T')[0],
        score: r.composite_score,
        signal: r.signal_type,
        confidence: r.confidence,
        factors: {
          concentration: r.f1_concentration,
          trend: r.f2_trend,
          volumeZ: r.f3_volume_z,
          momentum: r.f4_momentum,
          relStrength: r.f5_rel_strength,
          breadth: r.f6_breadth,
          alignment: r.f7_alignment,
          streak: r.f8_streak,
        },
        priceAtSignal: r.price_at_signal,
        price5dLater: r.price_5d_later,
        outcome: r.outcome,
      })),
      stockWinRate,
      totalSignals: histRows.length,
      completedSignals: completed.length,
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ─── Update Outcomes — Check if past signals were correct ────────────────────
app.post('/api/signal-scanner/update-outcomes', requireAdminKey, async (req, res) => {
  try {
    const toStr = d => (d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0]);

    // Process signals that are at least 2 days old (for 1d return)
    const [pendingRows] = await pool.query(`
      SELECT id, data_date, stock_code, signal_type, price_at_signal
      FROM idx_signal_history
      WHERE outcome IS NULL AND data_date <= DATE_SUB(CURDATE(), INTERVAL 2 DAY)
      LIMIT 300
    `);

    if (pendingRows.length === 0) {
      return res.json({ updated: 0, message: 'No pending outcomes to update' });
    }

    let updated = 0;
    for (const sig of pendingRows) {
      const sigDate = toStr(sig.data_date);
      if (sig.price_at_signal <= 0) continue;

      // Fetch future prices at multiple horizons
      const [futurePrices] = await pool.query(`
        SELECT close_price, high_price, low_price, date
        FROM idx_stock_prices
        WHERE stock_code = ? AND date > ?
        ORDER BY date ASC LIMIT 10
      `, [sig.stock_code, sigDate]);

      if (futurePrices.length === 0) {
        // Try Yahoo as fallback for 1-day return
        const yfData = await fetchYahooPrices([sig.stock_code]);
        if (yfData[sig.stock_code]) {
          const p = yfData[sig.stock_code].price;
          const ret = ((p - sig.price_at_signal) / sig.price_at_signal) * 100;
          await pool.query(
            'UPDATE idx_signal_history SET price_5d_later = ?, return_1d = ? WHERE id = ?',
            [p, Math.round(ret * 100) / 100, sig.id]
          );
        }
        continue;
      }

      const entry = Number(sig.price_at_signal);

      // Multi-horizon returns
      const getReturn = (idx) => {
        if (idx < futurePrices.length) {
          const p = Number(futurePrices[idx].close_price);
          return Math.round(((p - entry) / entry) * 10000) / 100; // 2 decimal %
        }
        return null;
      };

      const return_1d  = getReturn(0);
      const return_3d  = getReturn(Math.min(2, futurePrices.length - 1));
      const return_5d  = getReturn(Math.min(4, futurePrices.length - 1));
      const return_10d = getReturn(Math.min(9, futurePrices.length - 1));

      // Max drawdown and max profit within 5 days
      const highs = futurePrices.slice(0, 5).map(r => Number(r.high_price));
      const lows  = futurePrices.slice(0, 5).map(r => Number(r.low_price));
      const maxHigh = Math.max(...highs);
      const minLow  = Math.min(...lows);
      const max_profit   = Math.round(((maxHigh - entry) / entry) * 10000) / 100;
      const max_drawdown = Math.round(((minLow - entry) / entry) * 10000) / 100;

      // Smart outcome evaluation: considers max profit and drawdown path
      const price5d = return_5d !== null
        ? Number(futurePrices[Math.min(4, futurePrices.length - 1)].close_price)
        : null;

      let outcome = 'NEUTRAL';
      const isBullish = ['STRONG BUY', 'BUY'].includes(sig.signal_type);
      const isBearish = ['STRONG SELL', 'SELL'].includes(sig.signal_type);

      if (isBullish) {
        // WIN: hit +3% at any point within 5 days without hitting -2% first
        if (max_profit >= 3 && max_drawdown > -2) outcome = 'WIN';
        else if (max_drawdown <= -2) outcome = 'LOSS';
        else if (return_5d !== null && return_5d > 1) outcome = 'WIN';
        else if (return_5d !== null && return_5d < -1) outcome = 'LOSS';
      } else if (isBearish) {
        // For bearish signals: WIN if price dropped
        if (max_drawdown <= -3 && max_profit < 2) outcome = 'WIN';
        else if (max_profit >= 2) outcome = 'LOSS';
        else if (return_5d !== null && return_5d < -1) outcome = 'WIN';
        else if (return_5d !== null && return_5d > 1) outcome = 'LOSS';
      } else {
        // WATCH/NEUTRAL signals — evaluate purely on direction
        if (return_5d !== null && return_5d > 2) outcome = 'WIN';
        else if (return_5d !== null && return_5d < -2) outcome = 'LOSS';
      }

      await pool.query(`
        UPDATE idx_signal_history SET
          price_5d_later = ?, outcome = ?,
          return_1d = ?, return_3d = ?, return_5d = ?, return_10d = ?,
          max_drawdown = ?, max_profit = ?
        WHERE id = ?
      `, [price5d, outcome, return_1d, return_3d, return_5d, return_10d,
          max_drawdown, max_profit, sig.id]);
      updated++;
    }

    res.json({ updated, pending: pendingRows.length, message: `Updated ${updated} outcomes` });
  } catch (err) {
    console.error('Outcome update error:', err.message);
    res.json({ error: err.message });
  }
});


// =============================================================
// DAILY PICKS API ENDPOINTS (Restored from old ft_daily_picks logic using idx_concentration)
// =============================================================

app.get('/api/daily-picks', async (req, res) => {
  try {
    const [[latest]] = await pool.query('SELECT MAX(data_date) as md FROM idx_concentration');
    const queryDate = latest ? latest.md : new Date().toISOString().slice(0, 10);
    
    const [rows] = await pool.query(`
      SELECT 
        stock_code as ticker,
        last_val / 1000000000 as last_val_b,
        dn0 as day0_conc,
        dn1 as day1_conc,
        dn2 as day2_conc,
        dn3 as day3_conc,
        (IF(dn0>0,1,0) + IF(dn1>0,1,0) + IF(dn2>0,1,0) + IF(dn3>0,1,0)) as positive_days,
        (dn0*1.5 + dn1*1.0 + dn2*0.5 + dn3*0.25) as signal_score,
        price as market_price,
        'WATCHING' as status,
        data_date as detected_date
      FROM idx_concentration
      WHERE data_date = ? AND dn0 > 0 AND last_val > 10000000000
      ORDER BY signal_score DESC LIMIT 50
    `, [queryDate]);
    
    // add fake id for frontend keys
    rows.forEach((r, i) => r.id = 1000 + i);
    
    res.json({ data: rows, picks: rows, date: queryDate });
  } catch (err) {
    res.json({ data: [], picks: [], date: '', error: err.message });
  }
});

app.get('/api/daily-picks/winrate', async (req, res) => {
  try {
    const [[row]] = await pool.query(`
      SELECT COUNT(*) as closed,
        SUM(status IN ('WIN','HIT_T1','HIT_T2')) as wins,
        SUM(status IN ('LOSS','STOPPED')) as losses,
        ROUND(100 * SUM(status IN ('WIN','HIT_T1','HIT_T2')) / NULLIF(SUM(status NOT IN ('OPEN')), 0), 1) as win_rate,
        ROUND(AVG(result_pct), 1) as avg_pnl
      FROM ft_recommendations WHERE pattern_type = 'DAILY_PICK' AND status != 'OPEN'
    `);
    res.json({
      win_rate: Number(row.win_rate || 0), closed: Number(row.closed || 0),
      wins: Number(row.wins || 0), losses: Number(row.losses || 0), avg_pnl: Number(row.avg_pnl || 0),
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// POST /api/daily-picks/track — "Track" a daily pick: creates a real ft_recommendations
// row (unlike the old broken flow, which tried to PATCH a synthetic id=1000+i that never
// matched any real row). Looks the pick up fresh from idx_concentration by ticker rather
// than trusting client-supplied price/score, and reuses the same computeTradePlan()
// (ATR/S-R based entry-stop-target) already used for AWO signals, falling back to a fixed
// 3% risk band since Daily Picks doesn't have technical-factor data on hand.
app.post('/api/daily-picks/track', async (req, res) => {
  const { ticker } = req.body || {};
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  try {
    const [[pick]] = await pool.query(`
      SELECT stock_code, dn0, price, data_date
      FROM idx_concentration WHERE stock_code = ?
      ORDER BY data_date DESC LIMIT 1
    `, [ticker]);
    if (!pick || !pick.price) return res.json({ success: false, error: 'No current price data for this ticker' });

    // Dedup: skip if already tracked as an open/recent daily pick for this ticker
    const [existing] = await pool.query(`
      SELECT id FROM ft_recommendations
      WHERE ticker=? AND pattern_type='DAILY_PICK'
      AND detected_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) LIMIT 1
    `, [ticker]);
    if (existing.length > 0) return res.json({ success: true, id: existing[0].id, alreadyTracked: true });

    const { computeTradePlan } = require('./awo_technical');
    const direction = Number(pick.dn0) >= 0 ? 'BULLISH' : 'BEARISH';
    const plan = computeTradePlan(Number(pick.price), direction === 'BULLISH' ? 'BUY' : 'SELL', null, null);
    if (!plan) return res.json({ success: false, error: 'Could not compute a trade plan for this price' });

    const [result] = await pool.query(`
      INSERT INTO ft_recommendations
        (ticker, pattern_type, direction, detected_date, entry_min, entry_max,
         stop_loss, target_1, target_2, risk_reward, conviction_score, notes)
       VALUES (?,'DAILY_PICK',?,?,?,?,?,?,?,?,?,?)
    `, [ticker, direction, pick.data_date, plan.entry, plan.entry,
        plan.stopLoss, plan.target1, plan.target2, plan.riskReward,
        0, '(Tracked from Daily Picks scanner)']);
    res.json({ success: true, id: result.insertId, plan });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/daily-picks/run', async (req, res) => {
  try {
    const { exec } = require('child_process');
    exec('bash /var/www/flowtracker-scraper/recalc.sh', (error, stdout, stderr) => {});
    res.json({ success: true, total: 10, date: new Date().toISOString().slice(0,10) });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ═══ AWO — ADAPTIVE WEIGHT OPTIMIZER API ENDPOINTS ═══════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/awo/status — Current AWO status (weights, regime, last optimization)
app.get('/api/awo/status', async (req, res) => {
  try {
    const regime = await detectRegime(pool);
    const lastOptimization = loadOptimizationResult(AWO_RESULT_FILE);
    const factorStats = await getFactorStats(pool);

    res.json({
      weights: getActiveWeights(),
      thresholds: getActiveThresholds(),
      isOptimized: _awoWeights !== null,
      regime,
      defaultWeights: DEFAULT_WEIGHTS,
      lastOptimization: lastOptimization ? {
        date: lastOptimization.savedAt,
        improvement: lastOptimization.optimized?.improvement,
        adopted: lastOptimization.adopted,
        trainWR: lastOptimization.optimized?.trainWinRate,
        validateWR: lastOptimization.optimized?.validateWinRate,
      } : null,
      factorStats,
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// GET /api/awo/analyze — Full factor contribution analysis
app.get('/api/awo/analyze', async (req, res) => {
  try {
    const analysis = await analyzeFactorContributions(pool);
    res.json(analysis);
  } catch (err) {
    console.error('AWO analyze error:', err.message);
    res.json({ error: err.message });
  }
});

// POST /api/awo/optimize/run — Run weight optimization (research-only)
// POST /api/awo/optimize/promote — Adopt the frozen challenger into live scoring
const AWO_REOPTIMIZE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // one trading day
// Minimum genuinely NEW data required before a re-optimization is allowed to
// proceed at all (external review, round 2, P0-6). Time-based cooldown alone
// doesn't prevent the SAME (or nearly the same, since it only grows a little
// each day) validation set from being re-probed by a fresh 3000-candidate
// search night after night — the exact multiple-testing risk that caused
// the 2026-07-19 overfitting incident, just recurring at a slower timescale
// across DAYS instead of within one run. 20 trading days is roughly a
// month — not formally derived, matches the reviewer's own suggested order
// of magnitude ("minimal 20-30 trading days baru").
// Fixed 2026-07-31 (external review, round 3, finding #3): this was always
// meant to gate on trading DAYS (see comment above, written for round 2) but
// was implemented as a raw row count (200 signals ~ 20 days * ~10 signals/
// day assumed) — so a quiet market or a change in how many stocks emit
// signals per day silently changed how many real days the gate required.
// Now measured directly in unique dates.
const MIN_NEW_TRADING_DAYS_FOR_REOPT = 20;
// Paper trading gate (P1 follow-up #18, tightened 2026-07-31 per external
// review) — minimum real, forward track record required before /promote
// will adopt the frozen challenger. Reviewer's own stated comfort numbers,
// not formally derived: "Minimum resolved trades: 30-50, Minimum trading
// days: 20, Average net R: > 0, Profit factor: >= 1.10 untuk paper." Using
// the low end of their range as a starting point.
const MIN_PAPER_TRADES_RESOLVED = 30;
const MIN_PAPER_TRADING_CALENDAR_DAYS = 20;
const MIN_PAPER_AVG_NET_R = 0; // must be strictly positive
const MIN_PAPER_PROFIT_FACTOR = 1.10;

/**
 * Load the current frozen challenger, if any. Returns null if none exists
 * or the file is missing/corrupt (fresh start).
 */
function loadChallenger() {
  try { return JSON.parse(fs.readFileSync(AWO_CHALLENGER_FILE, 'utf8')); }
  catch { return null; }
}
function saveChallenger(data) {
  fs.writeFileSync(AWO_CHALLENGER_FILE, JSON.stringify(data, null, 2));
}

/**
 * Freeze a newly-eligible candidate as the active challenger IF the slot is
 * free (no challenger currently PAPER_TESTING) — external review, 2026-07-31.
 * If a challenger is already active, this candidate is reported but NOT
 * frozen; the active challenger's paper-trading track record keeps
 * accumulating undisturbed. This is the fix for: unseeded nightly research
 * finding a slightly-different "best" candidate almost every night, which
 * — before this — silently replaced whatever the previous night's candidate
 * was paper-trading, so no candidate could ever realistically accumulate
 * enough days to clear the paper-trading gate.
 *
 * @returns {{challenger: Object, justFrozen: boolean}|{challenger: null, justFrozen: false, blockedBy: Object}}
 */
function getOrFreezeChallenger(optResult) {
  const existing = loadChallenger();
  if (existing && existing.status === 'PAPER_TESTING') {
    // Fixed 2026-07-31 (external review, round 3, finding #5): this used to
    // keep ANY PAPER_TESTING challenger's slot occupied indefinitely, even
    // after AWO_MODEL_VERSION changed underneath it (e.g. exactly what
    // happened this round — F14 contamination fix, DEFAULT_WEIGHTS
    // renormalization, candidateKey hashing fix all change what a given
    // weights+thresholds pair actually SCORES). A challenger's accumulating
    // paper trades were generated by generatePaperTrades() classifying today's
    // LIVE signals with its frozen weights/thresholds through whatever
    // combineFactorScores() does right now — once the scoring formula itself
    // changes, the challenger's older paper trades and its newer ones are no
    // longer measuring the same thing, and the track record is no longer a
    // fair test of "this candidate." Auto-archive (not silently keep) so a
    // fresh challenger can be frozen under the current formula.
    if (existing.modelVersion !== AWO_MODEL_VERSION) {
      existing.status = 'REJECTED';
      existing.rejectedAt = new Date().toISOString();
      existing.rejectedReason = `STALE_MODEL_VERSION: frozen under ${existing.modelVersion}, server is now ${AWO_MODEL_VERSION}`;
      saveChallenger(existing);
      console.log(`🧠 AWO: Challenger ${existing.candidateKey.slice(0, 8)}... auto-archived — modelVersion changed (${existing.modelVersion} -> ${AWO_MODEL_VERSION})`);
    } else {
      return { challenger: existing, justFrozen: false, blockedBy: existing };
    }
  }
  const { candidateKeyFromWeights } = require('./modules/paper_trading');
  const candidateKey = candidateKeyFromWeights(optResult.optimized.weights, optResult.thresholds, AWO_MODEL_VERSION);
  const challenger = {
    candidateKey,
    weights: optResult.optimized.weights,
    thresholds: optResult.thresholds,
    modelVersion: AWO_MODEL_VERSION,
    frozenAt: new Date().toISOString(),
    candidateSeed: optResult.candidateSeed,
    splitBoundaryDate: optResult.splitBoundaryDate,
    // baseline vs candidate BOTH stored (fixed 2026-07-31, external review,
    // round 2, P1 — the promotion audit log used to write the SAME
    // `backtestSummary.validateWinRate` into both old_win_rate and
    // new_win_rate, since only the candidate's own numbers were ever kept
    // here; the log looked plausible but old==new made it useless for
    // actually auditing what improved).
    baselineSummary: {
      weights: optResult.baseline.weights,
      validateWinRate: optResult.baseline.validateWinRate,
      validateExpectancy: optResult.baseline.validateExpectancy,
      validateProfitFactor: optResult.baseline.validateProfitFactor,
    },
    backtestSummary: {
      validateWinRate: optResult.optimized.validateWinRate,
      expectancy: optResult.optimized.expectancy,
      profitFactor: optResult.optimized.profitFactor,
    },
    status: 'PAPER_TESTING',
  };
  saveChallenger(challenger);
  return { challenger, justFrozen: true };
}

// Fixed 2026-07-30 (external review, Review.md P0-1): this endpoint used to
// auto-adopt a winning candidate's weights immediately on every call, with
// no auth at all — anyone reaching the server could flip production weights.
// First fix: required the admin key + an explicit ?confirm=1 to adopt.
// Follow-up #12 (review team, same day): even a query-flag on one combined
// endpoint conflates two very different operations — computing/reporting a
// candidate (safe, side-effect-free, fine to run often) and adopting it into
// LIVE scoring (changes what real signals look like, must be rare and
// deliberate). Splitting them into separate endpoints makes that boundary
// structural instead of a flag that's easy to pass by habit or by a copy-
// pasted curl command. /run never touches _awoWeights; /promote never runs
// the optimizer — it only ever adopts what /run already computed and saved.
app.post('/api/awo/optimize/run', requireAdminKey, async (req, res) => {
  try {
    // Fixed 2026-07-31 (external review, round 2, P0-6): this used to check
    // `awo_optimization_log`'s last row — but that table only gets a row on
    // an actual PROMOTION (rare, paper trading takes weeks), NOT on every
    // /run call. In practice this meant the "24h cooldown" almost never
    // actually triggered, since most nights end in NO_IMPROVEMENT with
    // nothing promoted — the nightly cron's /run calls were effectively
    // unthrottled, re-probing a near-identical validation set night after
    // night. Now checks the PREVIOUS /run's own saved result (AWO_RESULT_FILE,
    // read before this run overwrites it) for both elapsed time AND whether
    // enough genuinely new signal data has accumulated — time alone doesn't
    // prevent the multiple-testing risk if the underlying data barely moved.
    const previousRun = loadOptimizationResult(AWO_RESULT_FILE);
    if (req.query.force !== '1' && previousRun?.savedAt) {
      const sinceLastMs = Date.now() - new Date(previousRun.savedAt).getTime();
      if (sinceLastMs < AWO_REOPTIMIZE_COOLDOWN_MS) {
        const hoursLeft = Math.ceil((AWO_REOPTIMIZE_COOLDOWN_MS - sinceLastMs) / (60 * 60 * 1000));
        return res.json({
          status: 'COOLDOWN',
          message: `Last run was ${Math.round(sinceLastMs / 60000)} min ago. Re-optimizing this soon re-probes the same validate set and risks overfitting (this is what caused the 2026-07-19 incident). Wait ~${hoursLeft}h, or pass ?force=1 to override.`,
          lastRunAt: previousRun.savedAt,
        });
      }
      // Fixed 2026-07-31 (external review, round 3, finding #3): this used to
      // compare COUNT(*) row counts. But the train/validate split and the
      // purge gap are entirely date-based (see uniqueDates in
      // optimizeWeights) — a burst of 200 new rows landing on a single new
      // trading day moves the validate window by exactly one day, not by any
      // meaningful amount. Counting unique dates instead measures what
      // actually matters: how much new, non-overlapping validation data has
      // accumulated since the last run.
      const [[{ cnt: currentEligibleDates }]] = await pool.query(
        `SELECT COUNT(DISTINCT data_date) cnt FROM idx_signal_history WHERE outcome IS NOT NULL`
      );
      const previousRunDates = previousRun.uniqueDatesCount ?? null;
      if (previousRunDates == null) {
        // Older saved result predates this field — fall back to allowing the
        // run rather than blocking forever on data we don't have.
      } else {
        const newDates = currentEligibleDates - previousRunDates;
        if (newDates < MIN_NEW_TRADING_DAYS_FOR_REOPT) {
          return res.json({
            status: 'INSUFFICIENT_NEW_DATA',
            message: `Only ${newDates} new trading day(s) with eligible outcomes since the last run (need >=${MIN_NEW_TRADING_DAYS_FOR_REOPT}). Re-optimizing now would mostly re-probe the same validate set the last run already used. Pass ?force=1 to override.`,
            previousRunDates,
            currentEligibleDates,
          });
        }
      }
    }

    console.log('🧠 AWO: Starting weight optimization (research run)...');
    const currentWeights = getActiveWeights();
    const result = await optimizeWeights(pool, currentWeights);

    if (result.status === 'INSUFFICIENT_DATA') {
      return res.json(result);
    }

    // Save result to file — this is the ONLY thing /promote is allowed to
    // adopt later; promote never accepts weights from a request body.
    saveOptimizationResult({ ...result, currentWeights }, AWO_RESULT_FILE);

    // Fixed 2026-07-31 (external review, round 3, finding #10): this field
    // used to be called `eligibleForPromotion` and the message told the
    // caller to POST /promote directly — but /promote only ever adopts the
    // FROZEN CHALLENGER (see getOrFreezeChallenger's doc comment), and
    // nothing here ever froze one. A manual /run that found a passing
    // candidate left the system in a state where following the endpoint's
    // own advice would immediately 409 with "no active challenger." The
    // cron pipeline's step 5 already calls getOrFreezeChallenger when
    // eligible; a manual /run now does the exact same thing, so the two
    // entry points behave identically and the response message is always
    // honest about what actually happened.
    result.eligibleForChallenger = result.adopted === true;
    if (result.eligibleForChallenger) {
      const { challenger, justFrozen } = getOrFreezeChallenger(result);
      result.challenger = { candidateKey: challenger.candidateKey, status: challenger.status, justFrozen };
      result.message = justFrozen
        ? `A candidate passed all safeguards and has been frozen as the new challenger (key ${challenger.candidateKey.slice(0, 8)}...). It now needs to accumulate real paper-trading results before POST /api/awo/optimize/promote will adopt it — GET /api/awo/challenger to track progress.`
        : `A candidate passed all safeguards, but challenger ${challenger.candidateKey.slice(0, 8)}... is already under paper testing — this candidate was NOT frozen, to avoid disrupting its accumulating track record. Nothing to promote yet.`;
    } else {
      result.message = `No candidate cleared every safeguard (best: +${result.optimized?.improvement ?? 0}%). Nothing to promote.`;
    }

    console.log(result.eligibleForChallenger
      ? `🧠 AWO: ${result.message}`
      : `🧠 AWO: No improvement found (best: +${result.optimized?.improvement ?? 0}%)`);

    res.json(result);
  } catch (err) {
    console.error('AWO optimize/run error:', err.message);
    res.json({ error: err.message });
  }
});

// Redesigned 2026-07-31 (external review) to promote the FROZEN CHALLENGER
// (see getOrFreezeChallenger), not "whatever /run last saved" — that file
// changes every night and is no longer a meaningful thing to promote once
// paper trading (which needs the SAME candidate held still for weeks) is
// the real gate. The challenger already cleared every train/validate
// safeguard (including the new profitability gates) back when it was
// frozen — promotion here adds the SEPARATE, forward-only paper-trading
// bar on top, including — fixed 2026-07-31, this was previously missing
// entirely — a real profitability check. Before this fix, a challenger
// with 0 wins / 10 losses / avgNetR -1.2R could pass this gate purely by
// accumulating enough losing trades over enough days.
//
// Concurrency guard (external review, round 2, P1): two /promote requests
// arriving close together could both read `status: PAPER_TESTING` before
// either one writes PROMOTED, both proceeding to adopt/log. A DB-backed
// atomic compare-and-set would be the fully general fix, but this process
// runs as a single PM2 fork instance (not clustered) — a simple in-memory
// flag is a complete fix for that actual deployment, not just a partial
// mitigation, without needing a new table for a single-process concern.
let _promotionInFlight = false;
app.post('/api/awo/optimize/promote', requireAdminKey, async (req, res) => {
  if (_promotionInFlight) {
    return res.status(409).json({ error: 'A promotion is already in progress — try again in a moment.' });
  }
  _promotionInFlight = true;
  try {
    const challenger = loadChallenger();
    if (!challenger) {
      return res.status(400).json({ error: 'No challenger has been frozen yet. A candidate becomes a challenger automatically once the nightly optimizer finds one that clears every backtest safeguard.' });
    }
    if (challenger.status !== 'PAPER_TESTING') {
      return res.status(409).json({
        error: `The current challenger has already been resolved (status: ${challenger.status}). A new challenger will be frozen the next time research finds an eligible candidate.`,
        challenger,
      });
    }

    const { getPaperTradeSummary } = require('./modules/paper_trading');
    const paperSummary = await getPaperTradeSummary(pool, challenger.candidateKey);

    const reasons = [];
    if (paperSummary.resolved < MIN_PAPER_TRADES_RESOLVED) reasons.push(`only ${paperSummary.resolved} resolved paper trades (need >=${MIN_PAPER_TRADES_RESOLVED})`);
    if (paperSummary.calendarDaysElapsed < MIN_PAPER_TRADING_CALENDAR_DAYS) reasons.push(`only ${paperSummary.calendarDaysElapsed} calendar days elapsed (need >=${MIN_PAPER_TRADING_CALENDAR_DAYS})`);
    if (paperSummary.avgNetR === null || paperSummary.avgNetR <= MIN_PAPER_AVG_NET_R) reasons.push(`paper avg net R ${paperSummary.avgNetR ?? 'n/a'} is not positive`);
    if (paperSummary.profitFactor === null || paperSummary.profitFactor < MIN_PAPER_PROFIT_FACTOR) reasons.push(`paper profit factor ${paperSummary.profitFactor ?? 'n/a'} is below ${MIN_PAPER_PROFIT_FACTOR}`);
    if (reasons.length > 0) {
      return res.status(409).json({
        error: `Challenger has not cleared the paper-trading gate yet: ${reasons.join('; ')}.`,
        paperTrading: paperSummary,
        required: { minResolved: MIN_PAPER_TRADES_RESOLVED, minCalendarDays: MIN_PAPER_TRADING_CALENDAR_DAYS, minAvgNetR: MIN_PAPER_AVG_NET_R, minProfitFactor: MIN_PAPER_PROFIT_FACTOR },
      });
    }

    const oldWeights = getActiveWeights();
    _awoWeights = challenger.weights;
    _awoThresholds = challenger.thresholds;
    fs.writeFileSync(AWO_WEIGHTS_FILE, JSON.stringify({
      weights: _awoWeights,
      thresholds: _awoThresholds,
      adoptedAt: new Date().toISOString(),
      candidateKey: challenger.candidateKey,
    }, null, 2));
    console.log(`🧠 AWO: ✅ Promoted challenger ${challenger.candidateKey.slice(0, 8)}... after ${paperSummary.resolved} paper trades / ${paperSummary.calendarDaysElapsed} days (avgNetR=${paperSummary.avgNetR}, PF=${paperSummary.profitFactor})`);

    // Fixed 2026-07-31 (external review, round 2, P1): old_win_rate and
    // new_win_rate used to both read `challenger.backtestSummary` (the
    // CANDIDATE's own number) — the log recorded the candidate's win rate
    // twice and never the actual baseline it was compared against, making
    // "what improved" unrecoverable from the log alone. Now reads
    // `baselineSummary` (stored at freeze time — see getOrFreezeChallenger)
    // for old_win_rate specifically.
    await pool.query(`
      INSERT INTO awo_optimization_log
        (regime, old_weights, new_weights, old_win_rate, new_win_rate,
         improvement, train_size, validate_size, adopted, thresholds, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?, ?)
    `, [
      'DEFAULT',
      JSON.stringify(oldWeights),
      JSON.stringify(_awoWeights),
      challenger.baselineSummary?.validateWinRate ?? null,
      challenger.backtestSummary?.validateWinRate ?? null,
      challenger.backtestSummary?.expectancy != null && challenger.baselineSummary?.validateExpectancy != null
        ? Math.round((challenger.backtestSummary.expectancy - challenger.baselineSummary.validateExpectancy) * 1000) / 1000
        : null,
      null, // train_size not retained on the frozen challenger — see backtestSummary/baselineSummary in `details` for what IS retained
      null,
      JSON.stringify(_awoThresholds),
      JSON.stringify({
        candidateKey: challenger.candidateKey, modelVersion: challenger.modelVersion,
        candidateSeed: challenger.candidateSeed, frozenAt: challenger.frozenAt,
        baselineSummary: challenger.baselineSummary, backtestSummary: challenger.backtestSummary,
        paperTrading: paperSummary,
      }),
    ]).catch(e => console.error('AWO log error:', e.message));

    // Mark the challenger consumed so a second /promote is a clean 409
    // rejection above, not a duplicate DB log entry — and frees the slot
    // for the next eligible candidate to be frozen as a new challenger.
    challenger.status = 'PROMOTED';
    challenger.promotedAt = new Date().toISOString();
    saveChallenger(challenger);

    res.json({ promoted: true, weights: _awoWeights, thresholds: _awoThresholds, candidateKey: challenger.candidateKey, paperTrading: paperSummary });
  } catch (err) {
    console.error('AWO optimize/promote error:', err.message);
    res.json({ error: err.message });
  } finally {
    _promotionInFlight = false;
  }
});

// GET /api/awo/challenger — visibility into the currently frozen challenger
// (P1 follow-up #18, redesigned 2026-07-31). Read-only.
app.get('/api/awo/challenger', async (req, res) => {
  try {
    const challenger = loadChallenger();
    if (!challenger) return res.json({ challenger: null, message: 'No challenger frozen yet.' });
    const { getPaperTradeSummary } = require('./modules/paper_trading');
    const summary = await getPaperTradeSummary(pool, challenger.candidateKey);
    const reasons = [];
    if (summary.resolved < MIN_PAPER_TRADES_RESOLVED) reasons.push(`resolved ${summary.resolved}/${MIN_PAPER_TRADES_RESOLVED}`);
    if (summary.calendarDaysElapsed < MIN_PAPER_TRADING_CALENDAR_DAYS) reasons.push(`days ${summary.calendarDaysElapsed}/${MIN_PAPER_TRADING_CALENDAR_DAYS}`);
    if (summary.avgNetR === null || summary.avgNetR <= MIN_PAPER_AVG_NET_R) reasons.push(`avgNetR ${summary.avgNetR ?? 'n/a'}`);
    if (summary.profitFactor === null || summary.profitFactor < MIN_PAPER_PROFIT_FACTOR) reasons.push(`profitFactor ${summary.profitFactor ?? 'n/a'}`);
    res.json({
      challenger, paperTrading: summary,
      requiredForPromotion: { minResolved: MIN_PAPER_TRADES_RESOLVED, minCalendarDays: MIN_PAPER_TRADING_CALENDAR_DAYS, minAvgNetR: MIN_PAPER_AVG_NET_R, minProfitFactor: MIN_PAPER_PROFIT_FACTOR },
      eligibleForPromotionNow: challenger.status === 'PAPER_TESTING' && reasons.length === 0,
      blockingReasons: reasons,
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// POST /api/awo/challenger/reject — manually retire the active challenger
// (P1 follow-up #18) so a new one can be frozen. There is deliberately no
// automatic rejection on bad paper performance — a human decides that, same
// as every other real-money-adjacent decision on this project.
app.post('/api/awo/challenger/reject', requireAdminKey, (req, res) => {
  const challenger = loadChallenger();
  if (!challenger || challenger.status !== 'PAPER_TESTING') {
    return res.status(400).json({ error: 'No active (PAPER_TESTING) challenger to reject.' });
  }
  challenger.status = 'REJECTED';
  challenger.rejectedAt = new Date().toISOString();
  challenger.rejectedReason = req.body?.reason || null;
  saveChallenger(challenger);
  console.log(`🧠 AWO: Challenger ${challenger.candidateKey.slice(0, 8)}... manually rejected`);
  res.json({ rejected: true, challenger });
});

// GET /api/awo/paper-trades — full trade-level detail for the current
// challenger (P1 follow-up #18) — the same data /promote gates on, exposed
// read-only for human review.
app.get('/api/awo/paper-trades', async (req, res) => {
  try {
    const challenger = loadChallenger();
    if (!challenger) {
      return res.json({ error: 'No challenger frozen yet.' });
    }
    const { getPaperTradeSummary } = require('./modules/paper_trading');
    const summary = await getPaperTradeSummary(pool, challenger.candidateKey);
    const [trades] = await pool.query(
      `SELECT stock_code, signal_date, direction, entry_price, entry_date, stop_loss, target,
              status, exit_price, exit_date, exit_reason, net_r
       FROM awo_paper_trades WHERE candidate_key = ? ORDER BY signal_date DESC LIMIT 200`,
      [challenger.candidateKey]
    );
    res.json({
      candidateKey: challenger.candidateKey, challengerStatus: challenger.status, summary,
      requiredForPromotion: { minResolved: MIN_PAPER_TRADES_RESOLVED, minCalendarDays: MIN_PAPER_TRADING_CALENDAR_DAYS, minAvgNetR: MIN_PAPER_AVG_NET_R, minProfitFactor: MIN_PAPER_PROFIT_FACTOR },
      trades,
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// GET /api/awo/compare — Compare old vs optimized weights side-by-side
app.get('/api/awo/compare', async (req, res) => {
  try {
    const lastResult = loadOptimizationResult(AWO_RESULT_FILE);
    if (!lastResult) {
      return res.json({ error: 'No optimization has been run yet. POST /api/awo/optimize/run first.' });
    }
    res.json({
      baseline: lastResult.baseline,
      optimized: lastResult.optimized,
      weightChanges: lastResult.weightChanges,
      thresholds: lastResult.thresholds,
      topCandidates: lastResult.topCandidates,
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// GET /api/awo/regime — Current market regime + history
app.get('/api/awo/regime', async (req, res) => {
  try {
    const current = await detectRegime(pool);
    const history = await getRegimeHistory(pool);
    const weights = getRegimeWeights(current.regime);

    res.json({
      current,
      history,
      regimeWeights: weights,
      allRegimeWeights: REGIME_WEIGHTS,
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// GET /api/awo/history — Optimization history over time
app.get('/api/awo/history', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT * FROM awo_optimization_log
      ORDER BY optimized_at DESC LIMIT 50
    `);
    res.json({ history: rows });
  } catch (err) {
    res.json({ error: err.message, history: [] });
  }
});

// POST /api/awo/reset — Reset to default weights
app.post('/api/awo/reset', requireAdminKey, (req, res) => {
  _awoWeights = null;
  _awoThresholds = null;
  try { fs.unlinkSync(AWO_WEIGHTS_FILE); } catch {}
  console.log('🧠 AWO: Reset to default weights');
  res.json({ success: true, weights: DEFAULT_WEIGHTS, message: 'Reset to default weights' });
});
