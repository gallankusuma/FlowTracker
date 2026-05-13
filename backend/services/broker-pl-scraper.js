/**
 * Broker P/L Scraper Service
 * 
 * Scrapes broker stalker data from FlowTracker API for all brokers
 * and stores aggregated P/L summary in local SQLite.
 * 
 * Designed to run:
 * - Daily via cron at 16:30 WIB (after market close)
 * - Manually via admin API endpoint
 */

const { getDB } = require('../database/init')
const proxy = require('./flowtracker-proxy')

const DELAY_MS = 800 // 800ms between requests to avoid rate limiting
const MAX_CONSECUTIVE_FAILS = 15

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Run the full scrape for a given trading date
 * @param {Object} options 
 * @param {string} options.date - Trading date (YYYY-MM-DD). If null, uses today.
 * @param {string} options.investor - 'all', 'f' (foreign), 'd' (domestic)
 * @param {string} options.market - 'RG' or 'ALL'
 * @returns {Object} { success: number, failed: number, total: number, date: string }
 */
async function runScrape(options = {}) {
  const { investor = 'all', market = 'RG' } = options
  let { date } = options

  // Get the last trading day if no date specified
  if (!date) {
    try {
      const tradingDays = await proxy.getTradingDays(2)
      const days = tradingDays?.data?.dates || []
      date = days[0] || new Date().toISOString().split('T')[0]
    } catch {
      date = new Date().toISOString().split('T')[0]
    }
  }

  console.log(`\n🔄 [BROKER SCRAPER] Starting scrape for date: ${date} (investor=${investor}, market=${market})`)

  // 1. Get broker list
  let brokers = []
  try {
    const listResult = await proxy.getBrokerList()
    if (listResult?.data) {
      const raw = listResult.data
      brokers = Array.isArray(raw) ? raw : (raw?.data || [])
    }
  } catch (err) {
    console.error('❌ [BROKER SCRAPER] Failed to get broker list:', err.message)
  }

  if (!brokers.length) {
    // Fallback to local DB brokers
    try {
      const db = getDB()
      brokers = db.prepare('SELECT code, entity_name as name FROM brokers ORDER BY code').all()
    } catch {}
  }

  if (!brokers.length) {
    console.error('❌ [BROKER SCRAPER] No brokers found. Aborting.')
    return { success: 0, failed: 0, total: 0, date }
  }

  console.log(`📊 [BROKER SCRAPER] Processing ${brokers.length} brokers...`)

  // 2. Get market prices for P/L
  let marketPrices = {}
  try {
    const md = await proxy.getMarketSummaryParsed()
    if (md) marketPrices = md
  } catch {}

  // 3. Process brokers sequentially
  const db = getDB()
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

  let success = 0
  let failed = 0
  let consecutiveFails = 0

  for (let i = 0; i < brokers.length; i++) {
    const broker = brokers[i]
    const code = broker.code || broker.broker_code || (typeof broker === 'string' ? broker : null)
    if (!code) continue

    try {
      const result = await proxy.getBrokerStalker(code, { from: date, to: date, investor, market })

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

        // Weighted P/L
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

        const brokerName = broker.entity_name || broker.name || summary.brokerName || code

        upsert.run(date, code, brokerName, totalNet, totalBuy, totalSell, totalPL, activeTickers, topFocus, investor, market)

        success++
        consecutiveFails = 0

        if ((i + 1) % 10 === 0) {
          console.log(`  📊 Progress: ${i + 1}/${brokers.length} (${success} success, ${failed} failed)`)
        }
      } else {
        failed++
        consecutiveFails++
      }
    } catch (err) {
      failed++
      consecutiveFails++

      if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        console.error(`❌ [BROKER SCRAPER] Too many consecutive failures (${MAX_CONSECUTIVE_FAILS}). Stopping.`)
        break
      }
    }

    // Delay between requests
    if (i < brokers.length - 1) {
      await sleep(DELAY_MS)
    }
  }

  console.log(`✅ [BROKER SCRAPER] Complete: ${success} success, ${failed} failed, ${brokers.length} total`)
  console.log(`   Date: ${date} | Investor: ${investor} | Market: ${market}\n`)

  return { success, failed, total: brokers.length, date }
}

/**
 * Get available scraped dates from the database
 */
function getScrapedDates() {
  const db = getDB()
  return db.prepare(`
    SELECT DISTINCT trade_date, COUNT(*) as broker_count, MAX(scraped_at) as last_scraped
    FROM broker_daily_pl
    GROUP BY trade_date
    ORDER BY trade_date DESC
    LIMIT 30
  `).all()
}

/**
 * Get broker summary from DB for a date range
 */
function getBrokerSummaryFromDB(options = {}) {
  const { from, to, investor = 'all', market = 'RG' } = options
  const db = getDB()

  if (from && to && from !== to) {
    // Date range — aggregate across dates
    return db.prepare(`
      SELECT 
        broker_code as code,
        broker_name as name,
        SUM(total_net) as totalNet,
        SUM(total_buy) as totalBuy,
        SUM(total_sell) as totalSell,
        AVG(estimated_pl) as totalPL,
        MAX(active_tickers) as activeTickers,
        top_focus as topFocus,
        COUNT(DISTINCT trade_date) as tradingDays
      FROM broker_daily_pl
      WHERE trade_date >= ? AND trade_date <= ?
        AND investor_type = ? AND market = ?
      GROUP BY broker_code
      ORDER BY ABS(SUM(total_net)) DESC
    `).all(from, to, investor, market)
  } else {
    // Single date
    const date = from || to
    return db.prepare(`
      SELECT 
        broker_code as code,
        broker_name as name,
        total_net as totalNet,
        total_buy as totalBuy,
        total_sell as totalSell,
        estimated_pl as totalPL,
        active_tickers as activeTickers,
        top_focus as topFocus
      FROM broker_daily_pl
      WHERE trade_date = ?
        AND investor_type = ? AND market = ?
      ORDER BY ABS(total_net) DESC
    `).all(date, investor, market)
  }
}

module.exports = {
  runScrape,
  getScrapedDates,
  getBrokerSummaryFromDB
}
