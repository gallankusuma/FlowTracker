/**
 * FlowTracker Real API Proxy Service
 * 
 * Proxies requests to api.flowtracker.id with:
 * - Auto-login & JWT token management
 * - SQLite response caching
 * - Automatic fallback to local DB on failure
 */

const axios = require('axios')
const CryptoJS = require('crypto-js')
const { getDB } = require('../database/init')

const API_BASE = process.env.FT_API_BASE || 'https://api.flowtracker.id/api'
const CACHE_TTL = parseInt(process.env.FT_CACHE_TTL || '300', 10) // 5 min default
const AES_KEY = 'sahamintel-secret-key-32-chars-!!'

let authToken = null
let tokenExpiry = 0

let _lastLoginAttempt = 0
// ── Auth ──────────────────────────────────────────────────

async function login() {
  const email = process.env.FT_EMAIL
  const password = process.env.FT_PASSWORD

  if (!email || !password) {
    console.warn('⚠️  FT_EMAIL / FT_PASSWORD not set — proxy disabled')
    return null
  }

  try {
    // Encrypt password with AES (matches FlowTracker client-side encryption)
    const encryptedPassword = CryptoJS.AES.encrypt(password, AES_KEY).toString()

    console.log('🔐 Logging in to FlowTracker API...')
    const res = await axios.post(`${API_BASE}/login`, {
      email,
      password: encryptedPassword
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    })

    if (res.data?.token) {
      authToken = res.data.token
      tokenExpiry = Date.now() + 3600 * 1000 // 1 hour
      console.log('✅ FlowTracker API authenticated successfully')
      return authToken
    }

    console.warn('⚠️  Login response missing token:', JSON.stringify(res.data).slice(0, 200))
    return null
  } catch (err) {
    console.error('❌ FlowTracker API login failed:', err.response?.data?.message || err.response?.status || err.message)
    return null
  }
}

async function getToken() {
  if (authToken && Date.now() < tokenExpiry) return authToken
  return login()
}

// ── Cache ─────────────────────────────────────────────────

function initCacheTable() {
  const db = getDB()
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_cache (
      cache_key TEXT PRIMARY KEY,
      response_data TEXT NOT NULL,
      cached_at INTEGER NOT NULL
    )
  `)
  // Clean up stale cache entries on startup
  try {
    const deleted = db.prepare('DELETE FROM api_cache WHERE cached_at < ?').run(Date.now() - CACHE_TTL * 1000)
    if (deleted.changes > 0) console.log(`🗑️  Cleared ${deleted.changes} stale cache entries`)
  } catch {}
}

function getCached(key) {
  try {
    const db = getDB()
    const row = db.prepare('SELECT response_data, cached_at FROM api_cache WHERE cache_key = ?').get(key)
    if (!row) return null

    const age = (Date.now() - row.cached_at) / 1000
    if (age > CACHE_TTL) {
      db.prepare('DELETE FROM api_cache WHERE cache_key = ?').run(key)
      return null
    }

    return JSON.parse(row.response_data)
  } catch {
    return null
  }
}

function setCache(key, data) {
  try {
    const db = getDB()
    db.prepare(`
      INSERT OR REPLACE INTO api_cache (cache_key, response_data, cached_at)
      VALUES (?, ?, ?)
    `).run(key, JSON.stringify(data), Date.now())
  } catch (err) {
    console.warn('Cache write error:', err.message)
  }
}

// ── Proxy Request ─────────────────────────────────────────

async function proxyGet(endpoint, params = {}) {
  const cacheKey = `${endpoint}|${JSON.stringify(params)}`

  // Check cache first
  const cached = getCached(cacheKey)
  if (cached) {
    return { data: cached, source: 'cache' }
  }

  // Get auth token
  const token = await getToken()
  if (!token) return null // Proxy disabled

  try {
    const res = await axios.get(`${API_BASE}${endpoint}`, {
      params,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    })

    // Cache the response
    setCache(cacheKey, res.data)

    return { data: res.data, source: 'api' }
  } catch (err) {
    // Handle 401 ONLY — re-login and retry (NOT 403, which is rate limiting)
    if (err.response?.status === 401) {
      authToken = null
      // Cooldown: don't re-login more than once per 30 seconds
      const now = Date.now()
      if (now - _lastLoginAttempt < 30000) {
        console.warn('⏳ Login cooldown active, skipping re-auth')
        return null
      }
      _lastLoginAttempt = now
      const newToken = await login()
      if (newToken) {
        try {
          const retry = await axios.get(`${API_BASE}${endpoint}`, {
            params,
            headers: { 'Authorization': `Bearer ${newToken}` },
            timeout: 20000
          })
          setCache(cacheKey, retry.data)
          return { data: retry.data, source: 'api-retry' }
        } catch {
          return null
        }
      }
    }

    console.error(`❌ Proxy ${endpoint} failed:`, err.response?.status || err.message)
    return null
  }
}

// ── Specific API Methods ──────────────────────────────────

// Cache last known trading days (with TTL)
let _tradingDays = null
let _tradingDaysFetchedAt = 0
const TRADING_DAYS_TTL = 30 * 60 * 1000 // 30 minutes

async function fetchTradingDays(count = 5) {
  const now = Date.now()
  if (_tradingDays && _tradingDays.length > 0 && (now - _tradingDaysFetchedAt) < TRADING_DAYS_TTL) {
    return _tradingDays
  }
  const result = await proxyGet('/market/valid-trading-days', { count })
  if (result?.data) {
    // Real API returns { dates: ["2026-05-08", ...] }
    _tradingDays = result.data?.dates || (Array.isArray(result.data) ? result.data : [])
    _tradingDaysFetchedAt = now
    console.log(`📅 Trading days refreshed: [${_tradingDays.slice(0, 3).join(', ')}...]`)
    return _tradingDays
  }
  return []
}

/**
 * Flow Analyzer — /market/last-val
 * Requires: date (last trading day) + codes (full ticker list)
 */
async function getFlowAnalyzer(options = {}) {
  const { investor = 'all', market = 'RG', codes } = options
  let { date } = options

  // Get last valid trading day if date not specified
  if (!date) {
    const days = await fetchTradingDays(2)
    date = days[0] || new Date().toISOString().split('T')[0]
  }

  // If no codes specified, get ALL tickers from market summary (real 800+ tickers)
  let tickerCodes = codes
  if (!tickerCodes) {
    try {
      // First try to get all ticker codes from the real market summary
      const marketData = await getMarketSummaryParsed()
      if (marketData && Object.keys(marketData).length > 50) {
        tickerCodes = Object.keys(marketData).join(',')
        console.log(`📊 Flow Analyzer: using ${Object.keys(marketData).length} tickers from market summary`)
      } else {
        throw new Error('Market summary insufficient')
      }
    } catch {
      // Fallback to local DB
      try {
        const db = getDB()
        const tickers = db.prepare('SELECT code FROM tickers ORDER BY last_value DESC').all()
        tickerCodes = tickers.map(t => t.code).join(',')
      } catch {
        tickerCodes = 'BBRI,BMRI,BBCA,ASII,TLKM,UNVR,ICBP,INDF,KLBF,ANTM'
      }
    }
  }

  const result = await proxyGet('/market/last-val', { date, investor, market, codes: tickerCodes })
  if (result) result.tradingDate = date // attach the actual trading date used
  return result
}

/**
 * Broker Stalker — /market/broker-stalker-optimized
 * Uses last valid trading day as from/to default
 */
async function getBrokerStalker(brokerCode, options = {}) {
  let { from, to, investor = 'all', market = 'RG' } = options

  // Get last valid trading day if dates not specified
  if (!from || !to) {
    const days = await fetchTradingDays(2)
    const lastDay = days[0] || new Date().toISOString().split('T')[0]
    from = from || lastDay
    to = to || lastDay
  }

  return proxyGet('/market/broker-stalker-optimized', {
    broker: brokerCode,
    from, to,
    investor, market
  })
}

/**
 * Accumulation Streak — /market/accumulation-streak-analysis
 * Requires comma-separated valid trading dates
 */
async function getAccumulationStreak(numDays = 2) {
  const allDays = await fetchTradingDays(10) // fetch more to have buffer
  const dates = allDays.slice(0, Number(numDays) || 2).join(',')
  console.log(`📅 AccumulationStreak: numDays=${numDays} → dates=[${dates}]`)
  return proxyGet('/market/accumulation-streak-analysis', { dates })
}

/**
 * Insider Moves — /market/analysis
 */
async function getInsiderMoves(from, to, page = 1, limit = 50) {
  const endpoint = `analysis/shareholder-above?from=${from}&to=${to}&page=${page}&limit=${limit}`
  return proxyGet('/market/analysis', { endpoint })
}

/**
 * Broker Action / Inventory Chart — /market/analysis
 * endpoint=analysis/inventory-chart/stock/{TICKER}?from=...&to=...&scope=vol&investor=all&market=ALL
 * Returns: { broker: [{ broker, name, data: [{date, value}] }], price: [{date, open, high, low, close, volume}] }
 */
async function getBrokerAction(ticker, options = {}) {
  let { from, to, investor = 'all', market = 'ALL', scope = 'vol' } = options

  // Default date range: last 1 month
  if (!from || !to) {
    const today = new Date()
    to = to || today.toISOString().split('T')[0]
    const fromDate = new Date(today)
    fromDate.setMonth(fromDate.getMonth() - 1)
    from = from || fromDate.toISOString().split('T')[0]
  }

  const endpoint = `analysis/inventory-chart/stock/${ticker}?from=${from}&to=${to}&scope=${scope}&investor=${investor}&market=${market}`
  return proxyGet('/market/analysis', { endpoint })
}

/**
 * Broker List — /market-broker-list
 */
async function getBrokerList() {
  return proxyGet('/market-broker-list')
}

/**
 * Valid Trading Days — /market/valid-trading-days
 */
async function getTradingDays(count = 10) {
  return proxyGet('/market/valid-trading-days', { count })
}

/**
 * Market Summary — /market-summary/latest
 * Returns parsed ticker data with REAL prices, daily change %, and concentration
 */
async function getMarketSummary() {
  return proxyGet('/market-summary/latest')
}

/**
 * Parsed Market Summary — returns Map<ticker, { price, change, dn0..dn4, wn1..wn4, unusual, crossing }>
 * This is the REAL market data with actual stock prices
 */
let _marketSummaryCache = null
let _marketSummaryCacheTime = 0

async function getMarketSummaryParsed() {
  // Cache for 5 minutes
  const now = Date.now()
  if (_marketSummaryCache && (now - _marketSummaryCacheTime) < CACHE_TTL * 1000) {
    return _marketSummaryCache
  }

  const result = await getMarketSummary()
  if (!result?.data?.content?.response?.['market-summary']?.children) {
    return null
  }

  const children = result.data.content.response['market-summary'].children
  let dataRows = null

  // Find the DataTable in the nested structure
  for (const child of children) {
    const inner = child?.props?.children
    if (Array.isArray(inner)) {
      for (const c of inner) {
        if (c?.type === 'DataTable' && Array.isArray(c?.props?.data)) {
          dataRows = c.props.data
          break
        }
      }
    }
    if (dataRows) break
  }

  if (!dataRows) return null

  // Parse into clean map
  const tickerMap = {}
  for (const row of dataRows) {
    // Extract ticker code from HTML symbol field: >BBCA<
    const match = row.symbol?.match(/>([A-Z]{4})</)
    if (!match) continue
    const ticker = match[1]

    tickerMap[ticker] = {
      price: row.price || 0,
      change: row['%1d'] || 0,
      dn0: row['dn-0'] || 0,
      dn1: row['dn-1'] || 0,
      dn2: row['dn-2'] || 0,
      dn3: row['dn-3'] || 0,
      dn4: row['dn-4'] || 0,
      wn1: row['wn-1'] || 0,
      wn2: row['wn-2'] || 0,
      wn3: row['wn-3'] || 0,
      wn4: row['wn-4'] || 0,
      unusual: row.unusual === 'v',
      crossing: row.crossing === 'v',
      suspend: row.suspend === 'v',
      pinky: row.pinky === 'v',
      likuid: row.likuid === 'v',
      specialNotice: row.special_notice === 'v'
    }
  }

  console.log(`📊 Market Summary: ${Object.keys(tickerMap).length} tickers with real prices loaded`)
  _marketSummaryCache = tickerMap
  _marketSummaryCacheTime = now
  return tickerMap
}

// ── Check if proxy is enabled ─────────────────────────────

function isEnabled() {
  return !!(process.env.FT_EMAIL && process.env.FT_PASSWORD && process.env.FT_API_BASE)
}

// ── Initialize ────────────────────────────────────────────

function init() {
  initCacheTable()
  if (isEnabled()) {
    console.log('🔌 FlowTracker API Proxy: ENABLED')
    console.log(`   → Base: ${API_BASE}`)
    console.log(`   → Cache TTL: ${CACHE_TTL}s`)
    // Pre-login on startup
    login().catch(() => {})
  } else {
    console.log('🔌 FlowTracker API Proxy: DISABLED (using local DB)')
  }
}

module.exports = {
  init,
  isEnabled,
  getFlowAnalyzer,
  getBrokerStalker,
  getBrokerAction,
  getAccumulationStreak,
  getInsiderMoves,
  getBrokerList,
  getTradingDays,
  getMarketSummary,
  getMarketSummaryParsed,
  getToken,
}
