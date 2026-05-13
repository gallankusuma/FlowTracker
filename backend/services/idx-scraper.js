/**
 * IDX Official Data Scraper
 * 
 * Fetches data directly from idx.co.id (Indonesia Stock Exchange)
 * NO LOGIN REQUIRED — only needs a session cookie from visiting the site.
 * 
 * Data available:
 * - All IHSG stocks with OHLCV, foreign flow, market cap
 * - All registered brokers
 * - Daily broker trading summary
 * - Foreign/domestic trading flows
 * 
 * Historical data: Available since ~2015 for stock summary, broker summary
 */

const axios = require('axios')
const { getDB } = require('../database/init')

const IDX_BASE = 'https://www.idx.co.id'
const DELAY_MS = 1500 // Be polite to IDX servers
const MAX_RETRIES = 3

// Browser-like headers (required by IDX)
const BROWSER_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
  'Referer': 'https://www.idx.co.id/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'X-Requested-With': 'XMLHttpRequest'
}

let sessionCookie = ''

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Session Management ──

async function ensureSession() {
  if (sessionCookie) return

  console.log('🔑 [IDX] Obtaining session cookie...')
  try {
    const res = await axios.get(`${IDX_BASE}/id`, {
      headers: {
        'Accept': 'text/html',
        'User-Agent': BROWSER_HEADERS['User-Agent']
      },
      timeout: 15000,
      maxRedirects: 5
    })

    const cookies = res.headers['set-cookie']
    if (cookies) {
      sessionCookie = cookies.map(c => c.split(';')[0]).join('; ')
      console.log('✅ [IDX] Session obtained')
    }

    await sleep(1000)

    // Validate session with a simple request
    await axios.get(`${IDX_BASE}/primary/home/GetIndexList`, {
      headers: { ...BROWSER_HEADERS, Cookie: sessionCookie },
      timeout: 10000
    })

  } catch (err) {
    console.warn('⚠️ [IDX] Session setup warning:', err.message)
    // Continue anyway — some endpoints work without cookies
  }
}

async function idxFetch(path, retries = MAX_RETRIES) {
  await ensureSession()

  const url = path.startsWith('http') ? path : `${IDX_BASE}${path}`

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, {
        headers: { ...BROWSER_HEADERS, ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
        timeout: 30000
      })
      return res.data
    } catch (err) {
      if (err.response?.status >= 500 && attempt < retries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 15000)
        console.warn(`   ⚠️ [IDX] Retry ${attempt}/${retries} for ${path} (${err.response?.status}), waiting ${delay}ms...`)
        await sleep(delay)
        sessionCookie = '' // Force new session
        continue
      }
      console.error(`   ❌ [IDX] Failed: ${path} → ${err.response?.status || err.message}`)
      return null
    }
  }
  return null
}


// ═══════════════════════════════════════════════════════
// MASTER DATA: Brokers
// ═══════════════════════════════════════════════════════

async function scrapeIDXBrokers() {
  console.log('\n🏢 [IDX] Scraping all registered brokers...')

  const data = await idxFetch('/primary/ExchangeMember/GetBrokerSearch?start=0&length=9999')
  if (!data?.data || !Array.isArray(data.data)) {
    console.error('❌ [IDX] No broker data returned')
    return { success: false, count: 0 }
  }

  const brokers = data.data
  const db = getDB()

  const upsertMaster = db.prepare(`
    INSERT INTO master_brokers (code, name, category, scraped_at)
    VALUES (?, ?, 'local', datetime('now'))
    ON CONFLICT(code) DO UPDATE SET
      name = excluded.name,
      scraped_at = datetime('now')
  `)

  const upsertLegacy = db.prepare(`
    INSERT INTO brokers (code, entity_name) VALUES (?, ?)
    ON CONFLICT(code) DO UPDATE SET entity_name = excluded.entity_name
  `)

  let count = 0
  const insertMany = db.transaction((rows) => {
    for (const item of rows) {
      const code = item.Code
      const name = item.Name
      if (!code) continue
      upsertMaster.run(code, name)
      upsertLegacy.run(code, name)
      count++
    }
  })

  insertMany(brokers)
  console.log(`✅ [IDX] ${count} brokers saved`)
  return { success: true, count }
}


// ═══════════════════════════════════════════════════════
// MASTER DATA: Stock Summary (All Tickers)
// ═══════════════════════════════════════════════════════

async function scrapeIDXStocks(date) {
  // date format: YYYYMMDD
  if (!date) {
    const d = new Date()
    d.setDate(d.getDate() - 1) // Yesterday
    date = d.toISOString().split('T')[0].replace(/-/g, '')
  }

  console.log(`\n📊 [IDX] Scraping stock summary for ${date}...`)

  const data = await idxFetch(`/primary/TradingSummary/GetStockSummary?date=${date}`)
  if (!data?.data || !Array.isArray(data.data)) {
    console.error('❌ [IDX] No stock data returned for', date)
    return { success: false, count: 0, date }
  }

  const stocks = data.data
  const db = getDB()

  const upsertMaster = db.prepare(`
    INSERT INTO master_tickers (code, name, last_price, change_pct, scraped_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(code) DO UPDATE SET
      name = excluded.name,
      last_price = excluded.last_price,
      change_pct = excluded.change_pct,
      scraped_at = datetime('now')
  `)

  const upsertLegacy = db.prepare(`
    INSERT INTO tickers (code, name, last_price, last_value, universe)
    VALUES (?, ?, ?, ?, '["IHSG"]')
    ON CONFLICT(code) DO UPDATE SET
      name = excluded.name,
      last_price = excluded.last_price,
      last_value = excluded.last_value
  `)

  let count = 0
  const insertMany = db.transaction((rows) => {
    for (const item of rows) {
      const code = item.StockCode
      const name = item.StockName
      if (!code) continue
      const close = item.Close || 0
      const previous = item.Previous || 0
      const changePct = previous > 0 ? ((close - previous) / previous * 100) : 0

      upsertMaster.run(code, name, close, Number(changePct.toFixed(2)))
      upsertLegacy.run(code, name, close, item.Value || 0)
      count++
    }
  })

  insertMany(stocks)
  console.log(`✅ [IDX] ${count} stocks saved`)
  return { success: true, count, date }
}


// ═══════════════════════════════════════════════════════
// DAILY DATA: Broker Summary
// ═══════════════════════════════════════════════════════

async function scrapeIDXBrokerSummary(date) {
  // date format: YYYYMMDD
  if (!date) {
    const d = new Date()
    d.setDate(d.getDate() - 1)
    date = d.toISOString().split('T')[0].replace(/-/g, '')
  }

  const dateFormatted = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`
  console.log(`\n🏢 [IDX] Scraping broker summary for ${dateFormatted}...`)

  const data = await idxFetch(`/primary/TradingSummary/GetBrokerSummary?length=9999&start=0&date=${date}`)
  if (!data?.data || !Array.isArray(data.data)) {
    console.error('❌ [IDX] No broker summary for', dateFormatted)
    return { success: false, count: 0, date: dateFormatted }
  }

  const rows = data.data
  const db = getDB()

  const upsert = db.prepare(`
    INSERT INTO broker_daily_pl
      (trade_date, broker_code, broker_name, total_net, total_buy, total_sell, estimated_pl, active_tickers, top_focus, investor_type, market, scraped_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, 'all', 'RG', datetime('now'))
    ON CONFLICT(trade_date, broker_code, investor_type, market)
    DO UPDATE SET
      broker_name = excluded.broker_name,
      total_net = excluded.total_net,
      total_buy = excluded.total_buy,
      total_sell = excluded.total_sell,
      scraped_at = datetime('now')
  `)

  let count = 0
  const insertMany = db.transaction((items) => {
    for (const item of items) {
      const code = item.IDFirm
      const name = item.FirmName
      if (!code) continue
      const value = item.Value || 0
      const volume = item.Volume || 0

      // IDX returns total value/volume per broker, not split buy/sell
      // We store total_buy = Value (total traded value), total_sell = 0, total_net = Value
      upsert.run(dateFormatted, code, name, value, value, 0, /* no P/L from IDX */)
      count++
    }
  })

  insertMany(rows)

  // Also save trading day
  try {
    const dow = new Date(dateFormatted + 'T00:00:00Z').getUTCDay()
    db.prepare(`
      INSERT INTO trading_days (trade_date, day_of_week, scraped_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(trade_date) DO NOTHING
    `).run(dateFormatted, dow)
  } catch {}

  console.log(`✅ [IDX] ${count} broker records saved for ${dateFormatted}`)
  return { success: true, count, date: dateFormatted }
}


// ═══════════════════════════════════════════════════════
// PHASE 1: Full Master Data Scrape
// ═══════════════════════════════════════════════════════

async function runIDXMasterScrape() {
  console.log('\n' + '═'.repeat(60))
  console.log('  IDX PHASE 1: MASTER DATA SCRAPE (NO LOGIN NEEDED)')
  console.log('═'.repeat(60))

  const logId = logStart('idx_master', null, 0)

  const results = {}

  // 1. Get all brokers
  results.brokers = await scrapeIDXBrokers()
  await sleep(2000)

  // 2. Get all stocks (using latest trading day)
  results.stocks = await scrapeIDXStocks()
  await sleep(2000)

  // 3. Get broker summary for latest day
  results.brokerSummary = await scrapeIDXBrokerSummary()

  console.log('\n📋 IDX Master Scrape Results:')
  console.log(`   Brokers: ${results.brokers.count || 0}`)
  console.log(`   Stocks: ${results.stocks.count || 0}`)
  console.log(`   Broker Summary: ${results.brokerSummary.count || 0}`)

  logComplete(logId, (results.brokers.count || 0) + (results.stocks.count || 0) + (results.brokerSummary.count || 0), 0)
  return results
}


// ═══════════════════════════════════════════════════════
// PHASE 2: Historical Backfill
// ═══════════════════════════════════════════════════════

function generateTradingDates(startDate, endDate) {
  const dates = []
  const start = new Date(startDate)
  const end = new Date(endDate)

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay()
    if (dow !== 0 && dow !== 6) { // Skip weekends
      dates.push(d.toISOString().split('T')[0].replace(/-/g, ''))
    }
  }
  return dates
}

function getAlreadyScrapedDates() {
  const db = getDB()
  return new Set(
    db.prepare('SELECT DISTINCT trade_date FROM broker_daily_pl').all().map(r => r.trade_date)
  )
}

async function runIDXHistoricalBackfill(startDate = '2025-01-01') {
  console.log('\n' + '═'.repeat(60))
  console.log('  IDX PHASE 2: HISTORICAL BACKFILL')
  console.log(`  From: ${startDate} → Yesterday`)
  console.log('═'.repeat(60))

  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const endDate = yesterday.toISOString().split('T')[0]

  const allDates = generateTradingDates(startDate, endDate)
  const scraped = getAlreadyScrapedDates()

  // Convert scraped dates to YYYYMMDD format for comparison
  const scrapedYMD = new Set([...scraped].map(d => d.replace(/-/g, '')))
  const toScrape = allDates.filter(d => !scrapedYMD.has(d))

  if (toScrape.length === 0) {
    console.log('✅ [IDX BACKFILL] All dates already scraped!')
    return { totalDates: 0, message: 'All dates already scraped' }
  }

  console.log(`📅 [IDX BACKFILL] ${toScrape.length} dates to scrape (${allDates.length} total trading days)`)

  const logId = logStart('idx_historical', `${startDate}→${endDate}`, toScrape.length)

  let totalSuccess = 0, totalFailed = 0, consecutiveFails = 0

  for (let i = 0; i < toScrape.length; i++) {
    const date = toScrape[i]
    const dateFormatted = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`
    process.stdout.write(`  📆 [${i + 1}/${toScrape.length}] ${dateFormatted}...`)

    const result = await scrapeIDXBrokerSummary(date)

    if (result.success && result.count > 0) {
      console.log(` ✅ ${result.count} brokers`)
      totalSuccess += result.count
      consecutiveFails = 0
    } else {
      console.log(` ⚠️ No data (might be holiday)`)
      totalFailed++
      consecutiveFails++
    }

    logProgress(logId, i + 1, totalFailed)

    if (consecutiveFails >= 10) {
      console.warn('   ⚠️ 10 consecutive empty dates — might have reached data boundary')
      consecutiveFails = 0 // Reset and continue
    }

    // Rate limiting
    if (i < toScrape.length - 1) {
      await sleep(DELAY_MS)
    }
  }

  logComplete(logId, toScrape.length, totalFailed)

  console.log(`\n✅ [IDX BACKFILL] Complete!`)
  console.log(`   Dates processed: ${toScrape.length}`)
  console.log(`   Total broker records: ${totalSuccess}`)
  console.log(`   Empty dates (holidays?): ${totalFailed}`)

  return { totalDates: toScrape.length, totalRecords: totalSuccess, totalFailed }
}


// ═══════════════════════════════════════════════════════
// PHASE 3: Daily Update
// ═══════════════════════════════════════════════════════

async function runIDXDailyUpdate() {
  console.log('\n' + '═'.repeat(60))
  console.log('  IDX PHASE 3: DAILY UPDATE')
  console.log('═'.repeat(60))

  const logId = logStart('idx_daily', null, 0)

  // Get yesterday's date in YYYYMMDD
  const d = new Date()
  d.setDate(d.getDate() - 1)
  const date = d.toISOString().split('T')[0].replace(/-/g, '')

  // Skip weekends
  if (d.getDay() === 0 || d.getDay() === 6) {
    console.log('📅 [IDX DAILY] Weekend — skipping')
    logComplete(logId, 0, 0)
    return { skipped: true, reason: 'weekend' }
  }

  // 1. Refresh stock prices
  console.log('📊 [IDX DAILY] Refreshing stock prices...')
  const stocks = await scrapeIDXStocks(date)
  await sleep(2000)

  // 2. Get broker summary for today
  console.log('🏢 [IDX DAILY] Getting broker summary...')
  const brokers = await scrapeIDXBrokerSummary(date)

  logComplete(logId, (stocks.count || 0) + (brokers.count || 0), 0)

  console.log(`✅ [IDX DAILY] Done: ${stocks.count} stocks, ${brokers.count} brokers`)
  return { stocks: stocks.count, brokers: brokers.count }
}


// ── Scraper Log helpers (reuse from data-scraper) ──

function logStart(type, targetDate, total) {
  const db = getDB()
  const result = db.prepare(`
    INSERT INTO scraper_log (scraper_type, target_date, status, total_records)
    VALUES (?, ?, 'running', ?)
  `).run(type, targetDate, total || 0)
  return result.lastInsertRowid
}

function logProgress(logId, processed, failed) {
  const db = getDB()
  db.prepare(`
    UPDATE scraper_log SET records_processed = ?, records_failed = ? WHERE id = ?
  `).run(processed, failed, logId)
}

function logComplete(logId, processed, failed) {
  const db = getDB()
  db.prepare(`
    UPDATE scraper_log SET status = 'complete', records_processed = ?, records_failed = ?, finished_at = datetime('now') WHERE id = ?
  `).run(processed, failed, logId)
}


// ── Status ──

function getIDXScraperStatus() {
  const db = getDB()

  const tickerCount = db.prepare('SELECT COUNT(*) as c FROM master_tickers').get().c
  const brokerCount = db.prepare('SELECT COUNT(*) as c FROM master_brokers').get().c
  const dateRange = db.prepare(`
    SELECT MIN(trade_date) as oldest, MAX(trade_date) as newest, COUNT(DISTINCT trade_date) as total
    FROM broker_daily_pl
  `).get()

  const recentLogs = db.prepare(`
    SELECT * FROM scraper_log WHERE scraper_type LIKE 'idx_%' ORDER BY id DESC LIMIT 10
  `).all()

  return {
    source: 'IDX Official (idx.co.id)',
    loginRequired: false,
    masterData: { tickers: tickerCount, brokers: brokerCount },
    scraped: dateRange,
    recentLogs
  }
}


module.exports = {
  scrapeIDXBrokers,
  scrapeIDXStocks,
  scrapeIDXBrokerSummary,
  runIDXMasterScrape,
  runIDXHistoricalBackfill,
  runIDXDailyUpdate,
  getIDXScraperStatus
}
