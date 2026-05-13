/**
 * Data Warehouse Scraper Service
 * 
 * Three-phase scraping strategy:
 * 1. Master Data — All IHSG tickers + all brokers (one-time)
 * 2. Historical Backfill — Jan 2025 to yesterday (one-time, resumable)
 * 3. Daily Update — Today's data only (cron, after market close)
 * 
 * All data goes to local SQLite. No repeated API calls for already-scraped data.
 */

const { getDB } = require('../database/init')
const proxy = require('./flowtracker-proxy')

const DELAY_MS = 800
const MAX_CONSECUTIVE_FAILS = 20

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Scraper Log helpers ──

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

function logFailed(logId, errorMessage) {
  const db = getDB()
  db.prepare(`
    UPDATE scraper_log SET status = 'failed', error_message = ?, finished_at = datetime('now') WHERE id = ?
  `).run(errorMessage, logId)
}

// ═══════════════════════════════════════════════════════
// PHASE 1: Master Data
// ═══════════════════════════════════════════════════════

/**
 * Scrape all IHSG tickers from market-summary/latest
 * Returns count of tickers saved
 */
async function scrapeMasterTickers() {
  console.log('\n📊 [MASTER] Scraping all IHSG tickers...')
  const logId = logStart('master_tickers', null, 0)

  try {
    const result = await proxy.getMarketSummary()
    if (!result?.data?.content?.response?.['market-summary']?.children) {
      throw new Error('Market summary response empty or invalid')
    }

    const children = result.data.content.response['market-summary'].children
    let dataRows = null

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

    if (!dataRows || dataRows.length === 0) {
      throw new Error('No ticker data found in market summary')
    }

    const db = getDB()
    const upsert = db.prepare(`
      INSERT INTO master_tickers (code, name, last_price, change_pct, is_unusual, is_crossing, is_suspend, is_likuid, scraped_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(code) DO UPDATE SET
        last_price = excluded.last_price,
        change_pct = excluded.change_pct,
        is_unusual = excluded.is_unusual,
        is_crossing = excluded.is_crossing,
        is_suspend = excluded.is_suspend,
        is_likuid = excluded.is_likuid,
        scraped_at = datetime('now')
    `)

    // Also update the existing tickers table for backward compat
    const upsertLegacy = db.prepare(`
      INSERT INTO tickers (code, name, last_price, last_value, universe)
      VALUES (?, ?, ?, 0, '["IHSG"]')
      ON CONFLICT(code) DO UPDATE SET
        last_price = excluded.last_price
    `)

    let count = 0
    const insertMany = db.transaction((rows) => {
      for (const row of rows) {
        const match = row.symbol?.match(/>([A-Z0-9]{2,5})</)
        if (!match) continue
        const ticker = match[1]

        // Try to extract name from the symbol HTML
        const nameMatch = row.symbol?.match(/class="text-xs[^"]*"[^>]*>([^<]+)</)
        const name = nameMatch ? nameMatch[1].trim() : ticker

        upsert.run(
          ticker,
          name,
          row.price || 0,
          row['%1d'] || 0,
          row.unusual === 'v' ? 1 : 0,
          row.crossing === 'v' ? 1 : 0,
          row.suspend === 'v' ? 1 : 0,
          row.likuid === 'v' ? 1 : 0
        )

        upsertLegacy.run(ticker, name, row.price || 0)
        count++
      }
    })

    insertMany(dataRows)
    console.log(`✅ [MASTER] ${count} tickers saved to master_tickers`)
    logComplete(logId, count, 0)
    return { success: true, count }

  } catch (err) {
    console.error('❌ [MASTER] Ticker scrape failed:', err.message)
    logFailed(logId, err.message)
    return { success: false, error: err.message }
  }
}

/**
 * Scrape all brokers from market-broker-list
 */
async function scrapeMasterBrokers() {
  console.log('\n🏢 [MASTER] Scraping all brokers...')
  const logId = logStart('master_brokers', null, 0)

  try {
    const result = await proxy.getBrokerList()
    let brokers = []

    if (result?.data) {
      const raw = result.data
      brokers = Array.isArray(raw) ? raw : (raw?.data || [])
    }

    if (!brokers.length) {
      throw new Error('No brokers returned from API')
    }

    const db = getDB()
    const upsert = db.prepare(`
      INSERT INTO master_brokers (code, name, scraped_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(code) DO UPDATE SET
        name = excluded.name,
        scraped_at = datetime('now')
    `)

    // Also update legacy brokers table
    const upsertLegacy = db.prepare(`
      INSERT INTO brokers (code, entity_name)
      VALUES (?, ?)
      ON CONFLICT(code) DO UPDATE SET
        entity_name = excluded.entity_name
    `)

    let count = 0
    const insertMany = db.transaction((rows) => {
      for (const broker of rows) {
        const code = broker.code || broker.broker_code
        const name = broker.entity_name || broker.name || code
        if (!code) continue

        upsert.run(code, name)
        upsertLegacy.run(code, name)
        count++
      }
    })

    insertMany(brokers)
    console.log(`✅ [MASTER] ${count} brokers saved to master_brokers`)
    logComplete(logId, count, 0)
    return { success: true, count }

  } catch (err) {
    console.error('❌ [MASTER] Broker scrape failed:', err.message)
    logFailed(logId, err.message)
    return { success: false, error: err.message }
  }
}

/**
 * Scrape valid trading days list
 */
async function scrapeTradingDays(count = 200) {
  console.log(`\n📅 [MASTER] Scraping trading days (${count})...`)

  try {
    const result = await proxy.getTradingDays(count)
    const dates = result?.data?.dates || []

    if (!dates.length) {
      console.warn('⚠️ [MASTER] No trading days returned')
      return { success: false, count: 0 }
    }

    const db = getDB()
    const upsert = db.prepare(`
      INSERT INTO trading_days (trade_date, day_of_week, scraped_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(trade_date) DO NOTHING
    `)

    let saved = 0
    for (const d of dates) {
      const dow = new Date(d + 'T00:00:00Z').getUTCDay()
      upsert.run(d, dow)
      saved++
    }

    console.log(`✅ [MASTER] ${saved} trading days saved`)
    return { success: true, count: saved, oldest: dates[dates.length - 1], newest: dates[0] }

  } catch (err) {
    console.error('❌ [MASTER] Trading days scrape failed:', err.message)
    return { success: false, error: err.message }
  }
}

/**
 * Run all Phase 1 master data scrapes
 */
async function runMasterScrape() {
  console.log('\n' + '═'.repeat(60))
  console.log('  PHASE 1: MASTER DATA SCRAPE')
  console.log('═'.repeat(60))

  const results = {}

  results.tickers = await scrapeMasterTickers()
  await sleep(2000)

  results.brokers = await scrapeMasterBrokers()
  await sleep(1000)

  results.tradingDays = await scrapeTradingDays(200)

  console.log('\n📋 Master Scrape Results:')
  console.log(`   Tickers: ${results.tickers.count || 0}`)
  console.log(`   Brokers: ${results.brokers.count || 0}`)
  console.log(`   Trading Days: ${results.tradingDays.count || 0}`)

  return results
}


// ═══════════════════════════════════════════════════════
// PHASE 2: Historical Backfill
// ═══════════════════════════════════════════════════════

/**
 * Get all trading dates that need to be scraped
 * (from startDate to yesterday, excluding already-scraped dates)
 */
function getUnscrappedDates(startDate = '2025-01-01') {
  const db = getDB()
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStr = yesterday.toISOString().split('T')[0]

  // Get all valid trading days in our range
  const allDays = db.prepare(`
    SELECT trade_date FROM trading_days
    WHERE trade_date >= ? AND trade_date <= ?
    ORDER BY trade_date ASC
  `).all(startDate, yesterdayStr).map(r => r.trade_date)

  // Get already-scraped dates
  const scrapedDates = new Set(
    db.prepare(`
      SELECT DISTINCT trade_date FROM broker_daily_pl
      WHERE trade_date >= ? AND trade_date <= ?
    `).all(startDate, yesterdayStr).map(r => r.trade_date)
  )

  // Return only unscraped dates
  return allDays.filter(d => !scrapedDates.has(d))
}

/**
 * Scrape broker P/L data for a single date
 * (Reuses logic from broker-pl-scraper but with master_brokers)
 */
async function scrapeOneDate(date, options = {}) {
  const { investor = 'all', market = 'RG' } = options
  const db = getDB()

  // Get brokers from master_brokers (or fallback)
  let brokers = db.prepare('SELECT code, name FROM master_brokers ORDER BY code').all()
  if (!brokers.length) {
    brokers = db.prepare('SELECT code, entity_name as name FROM brokers ORDER BY code').all()
  }

  if (!brokers.length) {
    return { success: 0, failed: 0, total: 0, skipped: true }
  }

  // Get market prices (for P/L calculation)
  let marketPrices = {}
  try {
    const mp = await proxy.getMarketSummaryParsed()
    if (mp) marketPrices = mp
  } catch {}

  const upsert = db.prepare(`
    INSERT INTO broker_daily_pl 
      (trade_date, broker_code, broker_name, total_net, total_buy, total_sell, estimated_pl, active_tickers, top_focus, investor_type, market, scraped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(trade_date, broker_code, investor_type, market)
    DO UPDATE SET
      broker_name = excluded.broker_name,
      total_net = excluded.total_net,
      total_buy = excluded.total_buy,
      total_sell = excluded.total_sell,
      estimated_pl = excluded.estimated_pl,
      active_tickers = excluded.active_tickers,
      top_focus = excluded.top_focus,
      scraped_at = datetime('now')
  `)

  let success = 0, failed = 0, consecutiveFails = 0

  for (let i = 0; i < brokers.length; i++) {
    const broker = brokers[i]
    try {
      const result = await proxy.getBrokerStalker(broker.code, { from: date, to: date, investor, market })

      if (result?.data) {
        const d = result.data
        const summary = d.summary || {}
        const list = d.list || []

        const buyItems = list.filter(item => (item.value || 0) > 0)
        const sellItems = list.filter(item => (item.value || 0) < 0)

        const totalBuy = buyItems.reduce((s, item) => s + (item.value || 0), 0)
        const totalSell = sellItems.reduce((s, item) => s + Math.abs(item.value || 0), 0)
        const totalNet = summary.total_net || (totalBuy - totalSell)
        const activeTickers = summary.stocks || list.length

        const sortedBuys = [...buyItems].sort((a, b) => (b.value || 0) - (a.value || 0))
        const topFocus = summary.top || (sortedBuys.length > 0 ? sortedBuys[0]?.code : null)

        // P/L calculation
        let totalPL = null
        const buyWithPL = buyItems.filter(item => (item.buy_avg || 0) > 0 && (marketPrices[item.code]?.price || 0) > 0)
        if (buyWithPL.length > 0) {
          const totalCost = buyWithPL.reduce((s, item) => s + (item.value || 0), 0)
          const totalGainLoss = buyWithPL.reduce((s, item) => {
            const avg = item.buy_avg || 0
            const cur = marketPrices[item.code]?.price || 0
            return s + (((cur - avg) / avg) * (item.value || 0))
          }, 0)
          totalPL = totalCost > 0 ? Number(((totalGainLoss / totalCost) * 100).toFixed(2)) : 0
        }

        upsert.run(date, broker.code, broker.name, totalNet, totalBuy, totalSell, totalPL, activeTickers, topFocus, investor, market)
        success++
        consecutiveFails = 0
      } else {
        failed++
        consecutiveFails++
      }
    } catch {
      failed++
      consecutiveFails++
    }

    if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
      console.warn(`   ⚠️ Too many fails for ${date}, stopping early`)
      break
    }

    if (i < brokers.length - 1) await sleep(DELAY_MS)
  }

  return { success, failed, total: brokers.length }
}

/**
 * Run historical backfill from startDate
 * This is designed to be RESUMABLE — it skips already-scraped dates
 */
async function runHistoricalBackfill(startDate = '2025-01-01', options = {}) {
  console.log('\n' + '═'.repeat(60))
  console.log('  PHASE 2: HISTORICAL BACKFILL')
  console.log(`  From: ${startDate} → Yesterday`)
  console.log('═'.repeat(60))

  const unscrappedDates = getUnscrappedDates(startDate)

  if (unscrappedDates.length === 0) {
    console.log('✅ [BACKFILL] All dates already scraped! Nothing to do.')
    return { totalDates: 0, message: 'All dates already scraped' }
  }

  console.log(`📅 [BACKFILL] ${unscrappedDates.length} dates to scrape`)
  console.log(`   First: ${unscrappedDates[0]} | Last: ${unscrappedDates[unscrappedDates.length - 1]}`)

  const logId = logStart('historical_backfill', `${unscrappedDates[0]}→${unscrappedDates[unscrappedDates.length - 1]}`, unscrappedDates.length)

  let totalSuccess = 0, totalFailed = 0

  for (let d = 0; d < unscrappedDates.length; d++) {
    const date = unscrappedDates[d]
    console.log(`\n📆 [BACKFILL] Date ${d + 1}/${unscrappedDates.length}: ${date}`)

    const result = await scrapeOneDate(date, options)
    totalSuccess += result.success
    totalFailed += result.failed

    console.log(`   ✅ ${result.success} brokers | ❌ ${result.failed} failed`)

    // Update log every date
    logProgress(logId, d + 1, totalFailed)

    // Pause 2 seconds between dates to be nice to API
    if (d < unscrappedDates.length - 1) {
      await sleep(2000)
    }
  }

  logComplete(logId, unscrappedDates.length, totalFailed)

  console.log(`\n✅ [BACKFILL] Complete!`)
  console.log(`   Dates scraped: ${unscrappedDates.length}`)
  console.log(`   Total records: ${totalSuccess}`)
  console.log(`   Total failures: ${totalFailed}`)

  return {
    totalDates: unscrappedDates.length,
    totalRecords: totalSuccess,
    totalFailed
  }
}


// ═══════════════════════════════════════════════════════
// PHASE 3: Daily Update
// ═══════════════════════════════════════════════════════

/**
 * Run daily update — only scrapes today's (or latest trading day's) data
 * Also refreshes ticker prices from market summary
 */
async function runDailyUpdate(options = {}) {
  console.log('\n' + '═'.repeat(60))
  console.log('  PHASE 3: DAILY UPDATE')
  console.log('═'.repeat(60))

  let { date } = options
  const { investor = 'all', market = 'RG' } = options

  // Get latest trading day
  if (!date) {
    try {
      const tradingDays = await proxy.getTradingDays(2)
      const days = tradingDays?.data?.dates || []
      date = days[0] || new Date().toISOString().split('T')[0]
    } catch {
      date = new Date().toISOString().split('T')[0]
    }
  }

  console.log(`📅 [DAILY] Target date: ${date}`)

  const logId = logStart('daily_update', date, 0)

  // Step 1: Refresh ticker prices (quick, single API call)
  console.log('📊 [DAILY] Refreshing ticker prices...')
  try {
    await scrapeMasterTickers()
  } catch {}

  // Step 2: Scrape broker data for this date
  console.log(`🏢 [DAILY] Scraping broker data for ${date}...`)
  const result = await scrapeOneDate(date, { investor, market })

  console.log(`✅ [DAILY] Complete: ${result.success} brokers, ${result.failed} failed`)
  logComplete(logId, result.success, result.failed)

  // Step 3: Save trading day
  try {
    const db = getDB()
    const dow = new Date(date + 'T00:00:00Z').getUTCDay()
    db.prepare(`
      INSERT INTO trading_days (trade_date, day_of_week, scraped_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(trade_date) DO NOTHING
    `).run(date, dow)
  } catch {}

  return { date, ...result }
}


// ═══════════════════════════════════════════════════════
// Status & Info
// ═══════════════════════════════════════════════════════

/**
 * Get comprehensive scraper status
 */
function getScraperStatus() {
  const db = getDB()

  // Master data counts
  const tickerCount = db.prepare('SELECT COUNT(*) as count FROM master_tickers').get().count
  const brokerCount = db.prepare('SELECT COUNT(*) as count FROM master_brokers').get().count
  const tradingDayCount = db.prepare('SELECT COUNT(*) as count FROM trading_days').get().count

  // Scraped date range
  const dateRange = db.prepare(`
    SELECT MIN(trade_date) as oldest, MAX(trade_date) as newest, COUNT(DISTINCT trade_date) as total
    FROM broker_daily_pl
  `).get()

  // Recent scraper logs
  const recentLogs = db.prepare(`
    SELECT * FROM scraper_log
    ORDER BY id DESC
    LIMIT 10
  `).all()

  // Currently running?
  const running = db.prepare(`
    SELECT * FROM scraper_log WHERE status = 'running' ORDER BY id DESC LIMIT 1
  `).get()

  return {
    masterData: {
      tickers: tickerCount,
      brokers: brokerCount,
      tradingDays: tradingDayCount
    },
    scraped: {
      oldestDate: dateRange.oldest,
      newestDate: dateRange.newest,
      totalDatesScraped: dateRange.total
    },
    isRunning: !!running,
    runningJob: running || null,
    recentLogs
  }
}

module.exports = {
  // Phase 1
  scrapeMasterTickers,
  scrapeMasterBrokers,
  scrapeTradingDays,
  runMasterScrape,
  // Phase 2
  scrapeOneDate,
  runHistoricalBackfill,
  getUnscrappedDates,
  // Phase 3
  runDailyUpdate,
  // Info
  getScraperStatus
}
