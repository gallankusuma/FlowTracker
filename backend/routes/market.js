const express = require('express')
const { getDB } = require('../database/init')
const { authMiddleware } = require('../middleware/auth')
const proxy = require('../services/flowtracker-proxy')

const router = express.Router()

// GET /api/broker-tracker — Flow Analyzer concentration data
router.get('/broker-tracker', authMiddleware, async (req, res) => {
  const { ticker, universe, min_value, page = 1, limit = 50 } = req.query
  const db = getDB()

  // ── Try Real API first ──
  if (proxy.isEnabled()) {
    try {
      if (ticker) {
        // Single ticker detail — get flow value + market price
        const [result, marketData] = await Promise.all([
          proxy.getFlowAnalyzer({ codes: ticker }),
          proxy.getMarketSummaryParsed()
        ])
        if (result?.data) {
          const realVal = result.data?.data?.[ticker]
          const md = marketData?.[ticker]

          // Try local DB first
          let flowData = db.prepare(`
            SELECT * FROM flow_data WHERE ticker_code = ? ORDER BY trade_date DESC LIMIT 10
          `).all(ticker)

          // If no local flow data, build from market summary concentration (dn-0 to dn-4)
          if (flowData.length === 0 && md) {
            try {
              const tradingDays = await proxy.getTradingDays(10)
              const days = tradingDays?.data?.dates || []
              // Use concentration data from market summary as flow proxy
              const concentrations = [md.dn4, md.dn3, md.dn2, md.dn1, md.dn0]
              flowData = concentrations.map((val, i) => ({
                trade_date: days[4 - i] || `Day ${i + 1}`,
                ticker_code: ticker,
                foreign_flow: (realVal || 0) * (val || 0) / 100,
                retail_flow: -(realVal || 0) * (val || 0) / 200,
                big_money_flow: (realVal || 0) * (val || 0) / 150,
                concentration_pct: val || 0,
                daily_change: 0
              }))
            } catch (err) {
              console.warn('Flow summary build error:', err.message)
            }
          }

          const ownership = db.prepare(`
            SELECT * FROM ownership WHERE ticker_code = ? ORDER BY percentage DESC
          `).all(ticker)

          let t = db.prepare('SELECT * FROM tickers WHERE code = ?').get(ticker)

          // Build virtual ticker if not in local DB
          if (!t && md) {
            t = {
              code: ticker,
              name: ticker,
              last_price: md.price,
              last_value: realVal || 0,
              daily_change: md.change,
              universe: '["IHSG"]'
            }
          } else if (t) {
            if (realVal) t.last_value = realVal
            if (md) {
              t.last_price = md.price
              t.daily_change = md.change
            }
          }

          return res.json({ ticker: t || { code: ticker, name: ticker, last_price: 0, last_value: realVal || 0 }, flowData, ownership, realAPI: true, source: result.source })
        }
      } else {
        // List mode — fetch BOTH last-val AND market-summary in parallel
        const [flowResult, marketData] = await Promise.all([
          proxy.getFlowAnalyzer(),
          proxy.getMarketSummaryParsed()
        ])

        if (flowResult?.data?.data && typeof flowResult.data.data === 'object') {
          const dataMap = flowResult.data.data

          // Use ONLY tickers that have flow data (lastVal > 0) as base
          // Enrich with real prices from market summary
          const transformed = Object.entries(dataMap)
            .filter(([, value]) => value > 0) // Only tickers with actual flow
            .map(([code, flowVal]) => {
              const md = marketData?.[code]
              const localTicker = db.prepare('SELECT * FROM tickers WHERE code = ?').get(code)

              // Use REAL concentration from market summary (dn-0 to dn-4)
              const concentration = md
                ? [md.dn4, md.dn3, md.dn2, md.dn1, md.dn0]
                : (() => {
                    const flows = db.prepare(`
                      SELECT concentration_pct FROM flow_data
                      WHERE ticker_code = ? ORDER BY trade_date DESC LIMIT 5
                    `).all(code)
                    const arr = flows.map(f => f.concentration_pct).reverse()
                    while (arr.length < 5) arr.unshift(0)
                    return arr
                  })()

              return {
                ticker: code,
                name: localTicker?.name || code,
                lastVal: flowVal,
                marketPrice: md?.price || localTicker?.last_price || 0,
                concentration,
                dailyChange: md?.change || 0,
                unusual: md?.unusual || false,
                crossing: md?.crossing || false,
                suspend: md?.suspend || false,
                specialNotice: md?.specialNotice || false,
                universe: localTicker ? JSON.parse(localTicker.universe || '["IHSG"]') : ['IHSG']
              }
            })
            .sort((a, b) => b.lastVal - a.lastVal)

          return res.json({
            data: transformed,
            total: transformed.length,
            page: 1,
            limit: transformed.length,
            totalPages: 1,
            date: flowResult.tradingDate || new Date().toISOString().split('T')[0],
            realAPI: true,
            source: flowResult.source
          })
        }
      }
    } catch (err) {
      console.warn('Proxy fallback to local DB:', err.message)
    }
  }

  // ── Fallback: Local SQLite ──
  if (ticker) {
    const t = db.prepare('SELECT * FROM tickers WHERE code = ?').get(ticker)
    if (!t) return res.status(404).json({ error: 'Ticker not found' })

    const flowData = db.prepare(`
      SELECT * FROM flow_data WHERE ticker_code = ? ORDER BY trade_date DESC LIMIT 10
    `).all(ticker)

    const ownership = db.prepare(`
      SELECT * FROM ownership WHERE ticker_code = ? ORDER BY percentage DESC
    `).all(ticker)

    return res.json({ ticker: t, flowData, ownership })
  }

  // List mode
  let query = 'SELECT * FROM tickers WHERE 1=1'
  const params = []

  if (universe && universe !== 'IHSG') {
    query += ` AND universe LIKE ?`
    params.push(`%${universe}%`)
  }

  if (min_value) {
    query += ` AND last_value >= ?`
    params.push(Number(min_value))
  }

  query += ' ORDER BY last_value DESC'

  const allTickers = db.prepare(query).all(...params)

  const results = allTickers.map(t => {
    const flows = db.prepare(`
      SELECT concentration_pct, daily_change FROM flow_data
      WHERE ticker_code = ? ORDER BY trade_date DESC LIMIT 5
    `).all(t.code)

    const concentration = flows.map(f => f.concentration_pct).reverse()
    while (concentration.length < 5) concentration.unshift(0)
    const dailyChange = flows[0]?.daily_change || 0

    return {
      ticker: t.code,
      name: t.name,
      lastVal: t.last_value,
      marketPrice: t.last_price,
      concentration,
      dailyChange,
      universe: JSON.parse(t.universe || '[]')
    }
  })

  const offset = (Number(page) - 1) * Number(limit)
  const paginated = results.slice(offset, offset + Number(limit))

  res.json({
    data: paginated,
    total: results.length,
    page: Number(page),
    limit: Number(limit),
    totalPages: Math.ceil(results.length / Number(limit))
  })
})

// GET /api/market-broker-list — All brokers
router.get('/market-broker-list', authMiddleware, async (req, res) => {
  // ── Try Real API ──
  if (proxy.isEnabled()) {
    try {
      const result = await proxy.getBrokerList()
      if (result?.data) {
        const brokers = Array.isArray(result.data) ? result.data : (result.data?.data || [])
        return res.json({ data: brokers, realAPI: true, source: result.source })
      }
    } catch (err) {
      console.warn('Broker list proxy fallback:', err.message)
    }
  }

  // ── Fallback: Local ──
  const db = getDB()
  const brokers = db.prepare('SELECT * FROM brokers ORDER BY code').all()
  res.json({ data: brokers })
})

// GET /api/broker-action/:ticker — Broker Action / Inventory Chart
// Returns real broker volume data + price OHLCV for the chart
router.get('/broker-action/:ticker', authMiddleware, async (req, res) => {
  const { ticker } = req.params
  const { from, to, investor, market, scope } = req.query

  if (proxy.isEnabled()) {
    try {
      const result = await proxy.getBrokerAction(ticker, { from, to, investor, market, scope })
      if (result?.data) {
        return res.json({ data: result.data, realAPI: true, source: result.source })
      }
    } catch (err) {
      console.warn(`Broker action proxy error for ${ticker}:`, err.message)
    }
  }

  // Fallback: return empty structure
  res.json({ data: { broker: [], price: [] }, realAPI: false })
})

// GET /api/stock-broker-tracker/:ticker — Per-stock broker tracker (top buyers/sellers for date ranges)
router.get('/stock-broker-tracker/:ticker', authMiddleware, async (req, res) => {
  const { ticker } = req.params
  const { alphaFrom, alphaTo, betaFrom, betaTo, investor = 'all', market = 'RG' } = req.query

  if (!proxy.isEnabled()) {
    return res.json({ alpha: [], beta: [], realAPI: false })
  }

  try {
    // Fetch broker action data for the full date range covering both alpha and beta
    const allFrom = alphaFrom || betaFrom
    const allTo = betaTo || alphaTo
    
    const result = await proxy.getBrokerAction(ticker, { from: allFrom, to: allTo, investor, market })
    if (!result?.data?.broker) {
      return res.json({ alpha: [], beta: [], realAPI: true, source: 'empty' })
    }

    const brokers = result.data.broker || []
    const prices = result.data.price || []

    // Calculate avg price from price data for each date range
    const getAvgPrice = (from, to) => {
      const rangeP = prices.filter(p => p.date >= from && p.date <= to)
      if (rangeP.length === 0) return 0
      return Math.round(rangeP.reduce((s, p) => s + (p.close || 0), 0) / rangeP.length)
    }

    // Build top buyer/seller lists for a date range
    const buildTrackerData = (from, to) => {
      const avgPrice = getAvgPrice(from, to)
      const brokerSummaries = brokers.map(b => {
        const rangeDays = (b.data || []).filter(d => d.date >= from && d.date <= to)
        const netVal = rangeDays.reduce((s, d) => s + (d.value || 0), 0)
        const lot = Math.abs(Math.round(netVal / (avgPrice || 1)))
        return { broker: b.broker, name: b.name, netVal, lot, avg: avgPrice }
      }).filter(b => b.netVal !== 0)

      const buyers = brokerSummaries.filter(b => b.netVal > 0)
        .sort((a, b) => b.netVal - a.netVal).slice(0, 7)
      const sellers = brokerSummaries.filter(b => b.netVal < 0)
        .sort((a, b) => a.netVal - b.netVal).slice(0, 7)

      // Pair buyers and sellers
      const maxLen = Math.max(buyers.length, sellers.length)
      const result = []
      for (let i = 0; i < maxLen; i++) {
        result.push({
          by: buyers[i]?.broker || '',
          netVal: buyers[i]?.netVal || 0,
          lot: buyers[i]?.lot || 0,
          avg: buyers[i]?.avg || 0,
          sl: sellers[i]?.broker || '',
          slNetVal: Math.abs(sellers[i]?.netVal || 0),
          slLot: sellers[i]?.lot || 0,
          slAvg: sellers[i]?.avg || 0
        })
      }
      return result
    }

    const alpha = alphaFrom && alphaTo ? buildTrackerData(alphaFrom, alphaTo) : []
    const beta = betaFrom && betaTo ? buildTrackerData(betaFrom, betaTo) : []

    return res.json({ alpha, beta, realAPI: true, source: result.source })
  } catch (err) {
    console.warn('Stock broker tracker error:', err.message)
    return res.json({ alpha: [], beta: [], realAPI: false, error: err.message })
  }
})

// GET /api/broker-stalker/:code — Broker transaction detail
router.get('/broker-stalker/:code', authMiddleware, async (req, res) => {
  const { code } = req.params
  const { from, to, investor, market } = req.query

  // ── Try Real API ──
  if (proxy.isEnabled()) {
    try {
      const result = await proxy.getBrokerStalker(code, { from, to, investor, market })
      if (result?.data) {
        const d = result.data
        // Real API returns: { summary: { stocks, total_net, top, ... }, list: [...] }
        const summary = d.summary || {}
        const list = d.list || []

        // Fetch current market prices for P/L calculation
        let marketPrices = {}
        try {
          const md = await proxy.getMarketSummaryParsed()
          if (md) marketPrices = md
        } catch {}

        // Split list into buy (positive value) and sell (negative value)
        const buyItems = list.filter(item => (item.value || 0) > 0).sort((a, b) => b.value - a.value)
        const sellItems = list.filter(item => (item.value || 0) < 0).sort((a, b) => a.value - b.value)

        const buyData = buyItems
          .slice(0, 25)
          .map(item => ({
            ticker: item.code,
            netVal: item.value || 0,
            netLot: item.net_volume || (item.buy_volume - item.sell_volume) || 0,
            avg: Math.round(item.buy_avg || 0),
            currentPrice: marketPrices[item.code]?.price || 0
          }))

        const sellData = sellItems
          .slice(0, 25)
          .map(item => ({
            ticker: item.code,
            netVal: Math.abs(item.value || 0),
            netLot: Math.abs(item.net_volume || 0),
            avg: Math.round(item.sell_avg || 0),
            currentPrice: marketPrices[item.code]?.price || 0
          }))

        // Aggregate totals
        const totalBuyValue = buyItems.reduce((sum, i) => sum + (i.value || 0), 0)
        const totalSellValue = sellItems.reduce((sum, i) => sum + Math.abs(i.value || 0), 0)

        // Weighted average P/L across all buy positions
        let totalPL = null
        const buyWithPL = buyItems.filter(i => (i.buy_avg || 0) > 0 && (marketPrices[i.code]?.price || 0) > 0)
        if (buyWithPL.length > 0) {
          const totalCost = buyWithPL.reduce((s, i) => s + (i.value || 0), 0)
          const totalGainLoss = buyWithPL.reduce((s, i) => {
            const avg = i.buy_avg || 0
            const cur = marketPrices[i.code]?.price || 0
            const pl = ((cur - avg) / avg) * (i.value || 0)
            return s + pl
          }, 0)
          totalPL = totalCost > 0 ? (totalGainLoss / totalCost) * 100 : 0
        }

        return res.json({
          broker: { code, entity_name: summary.brokerName || code },
          totalNetValue: summary.total_net || 0,
          totalBuyValue,
          totalSellValue,
          totalPL,
          activeTickers: summary.stocks || list.length,
          topFocus: summary.top || buyData[0]?.ticker || '-',
          buy: buyData,
          sell: sellData,
          realAPI: true,
          source: result.source
        })
      }
    } catch (err) {
      console.warn('Broker stalker proxy fallback:', err.message)
    }
  }

  // ── Fallback: Local ──
  const db = getDB()
  const broker = db.prepare('SELECT * FROM brokers WHERE code = ?').get(code)
  if (!broker) return res.status(404).json({ error: 'Broker not found' })

  const buys = db.prepare(`
    SELECT ticker_code, SUM(net_value) as net_val, SUM(net_lot) as net_lot, AVG(avg_price) as avg
    FROM broker_summary WHERE broker_code = ? AND net_value > 0
    GROUP BY ticker_code ORDER BY net_val DESC LIMIT 10
  `).all(code)

  const sells = db.prepare(`
    SELECT ticker_code, SUM(ABS(net_value)) as net_val, SUM(ABS(net_lot)) as net_lot, AVG(avg_price) as avg
    FROM broker_summary WHERE broker_code = ? AND net_value < 0
    GROUP BY ticker_code ORDER BY net_val DESC LIMIT 10
  `).all(code)

  const totalNet = db.prepare(`
    SELECT SUM(net_value) as total FROM broker_summary WHERE broker_code = ?
  `).get(code)

  const activeCount = db.prepare(`
    SELECT COUNT(DISTINCT ticker_code) as count FROM broker_summary WHERE broker_code = ?
  `).get(code)

  const totalBuyValue = buys.reduce((s, b) => s + (b.net_val || 0), 0)
  const totalSellValue = sells.reduce((s, s2) => s + (s2.net_val || 0), 0)

  res.json({
    broker,
    totalNetValue: totalNet?.total || 0,
    totalBuyValue,
    totalSellValue,
    totalPL: null,
    activeTickers: activeCount?.count || 0,
    topFocus: buys[0]?.ticker_code || '-',
    buy: buys.map(b => ({ ticker: b.ticker_code, netVal: b.net_val, netLot: b.net_lot, avg: Math.round(b.avg || 0) })),
    sell: sells.map(s => ({ ticker: s.ticker_code, netVal: s.net_val, netLot: s.net_lot, avg: Math.round(s.avg || 0) }))
  })
})

// GET /api/broker-streak — Accumulation streak data
router.get('/broker-streak', authMiddleware, async (req, res) => {
  const { days = 2 } = req.query

  // ── Try Real API ──
  if (proxy.isEnabled()) {
    try {
      // Pass days to proxy for correct trading day count
      const result = await proxy.getAccumulationStreak(Number(days) || 2)
      if (result?.data) {
        const rawData = Array.isArray(result.data) ? result.data : (result.data?.data || [])

        // Fetch current market prices for lastPrice
        let marketPrices = {}
        try {
          const md = await proxy.getMarketSummaryParsed()
          if (md) marketPrices = md
        } catch {}

        // Transform real API format: [{ code, buyStreaks, sellStreaks, totalValue }]
        const transformed = rawData.map(item => {
          const mp = marketPrices[item.code]
          const lastPrice = mp?.price || 0
          return {
            ticker: item.code,
            lastPrice,
            lastVal: item.totalValue || 0,
            buyers: (item.buyStreaks || []).slice(0, 3).map(b => ({
              broker: b.brokerId,
              val: b.totalBuyVal || 0,
              lot: b.totalBuyVol || 0,
              avg: Math.round(b.avgBuyPrice || 0),
              gain: b.avgBuyPrice > 0 && lastPrice > 0
                ? Number(((lastPrice - b.avgBuyPrice) / b.avgBuyPrice * 100).toFixed(2))
                : 0
            })),
            sellers: (item.sellStreaks || []).slice(0, 3).map(s => ({
              broker: s.brokerId,
              val: s.totalSellVal || Math.abs(s.totalNetVal || 0),
              lot: s.totalSellVol || Math.abs(s.totalNetVol || 0),
              avg: Math.round(s.avgSellPrice || 0)
            }))
          }
        }).sort((a, b) => b.lastVal - a.lastVal)

        return res.json({ 
          data: transformed, 
          days: Number(days), 
          lastUpdate: new Date().toISOString().split('T')[0],
          realAPI: true,
          source: result.source 
        })
      }
    } catch (err) {
      console.warn('Accumulation streak proxy fallback:', err.message)
    }
  }

  // ── Fallback: Local ──
  const db = getDB()
  const tickers = db.prepare('SELECT * FROM tickers ORDER BY last_value DESC LIMIT 20').all()

  const results = tickers.map(t => {
    const buyers = db.prepare(`
      SELECT broker_code, SUM(net_value) as val, SUM(net_lot) as lot, AVG(avg_price) as avg
      FROM broker_summary WHERE ticker_code = ? AND net_value > 0
      GROUP BY broker_code ORDER BY val DESC LIMIT 3
    `).all(t.code)

    const sellers = db.prepare(`
      SELECT broker_code, SUM(ABS(net_value)) as val, SUM(ABS(net_lot)) as lot, AVG(avg_price) as avg
      FROM broker_summary WHERE ticker_code = ? AND net_value < 0
      GROUP BY broker_code ORDER BY val DESC LIMIT 3
    `).all(t.code)

    return {
      ticker: t.code,
      lastPrice: t.last_price,
      lastVal: t.last_value,
      buyers: buyers.map(b => ({
        broker: b.broker_code,
        val: b.val,
        lot: b.lot,
        avg: Math.round(b.avg || 0),
        gain: Number(((t.last_price - (b.avg || t.last_price)) / t.last_price * 100).toFixed(2))
      })),
      sellers: sellers.map(s => ({
        broker: s.broker_code,
        val: s.val,
        lot: s.lot,
        avg: Math.round(s.avg || 0)
      }))
    }
  })

  res.json({ data: results, days: Number(days), lastUpdate: '2026-05-08' })
})

// GET /api/broker-summary-pl — All brokers P/L summary table (reads from local DB)
router.get('/broker-summary-pl', authMiddleware, async (req, res) => {
  const { from, to, investor = 'all', market = 'RG' } = req.query
  const scraper = require('../services/broker-pl-scraper')

  try {
    const data = scraper.getBrokerSummaryFromDB({ from, to, investor, market })
    const dates = scraper.getScrapedDates()

    res.json({
      data,
      total: data.length,
      fetched: data.length,
      source: 'database',
      availableDates: dates
    })
  } catch (err) {
    console.error('Broker Summary P/L DB error:', err.message)
    res.status(500).json({ error: 'Failed to read broker summary', detail: err.message })
  }
})

// POST /api/broker-summary-pl/scrape — Manually trigger broker scraping (admin only)
router.post('/broker-summary-pl/scrape', authMiddleware, async (req, res) => {
  const { date, investor = 'all', market = 'RG' } = req.body
  const scraper = require('../services/broker-pl-scraper')

  // Only admins can trigger scraping
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin only' })
  }

  // Run scraper in background and return immediately
  res.json({ message: 'Scrape started', date: date || 'latest trading day' })

  // Execute in background
  scraper.runScrape({ date, investor, market }).catch(err => {
    console.error('Manual scrape failed:', err.message)
  })
})

// GET /api/broker-summary-pl/status — Check scraper data availability
router.get('/broker-summary-pl/status', authMiddleware, async (req, res) => {
  const scraper = require('../services/broker-pl-scraper')

  try {
    const dates = scraper.getScrapedDates()
    const db = getDB()
    const totalRecords = db.prepare('SELECT COUNT(*) as count FROM broker_daily_pl').get()

    res.json({
      totalRecords: totalRecords.count,
      availableDates: dates
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ═══════════════════════════════════════════════════════
// Data Warehouse Scraper API (admin only)
// ═══════════════════════════════════════════════════════

// POST /api/scraper/master — Phase 1: Scrape all tickers + brokers + trading days
router.post('/scraper/master', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin only' })
  }

  const dataScraper = require('../services/data-scraper')
  res.json({ message: 'Master data scrape started. Check /api/scraper/status for progress.' })

  dataScraper.runMasterScrape().catch(err => {
    console.error('Master scrape failed:', err.message)
  })
})

// POST /api/scraper/backfill — Phase 2: Historical backfill from Jan 2025
router.post('/scraper/backfill', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin only' })
  }

  const dataScraper = require('../services/data-scraper')
  const status = dataScraper.getScraperStatus()

  if (status.isRunning) {
    return res.status(409).json({ error: 'A scraper is already running', job: status.runningJob })
  }

  const startDate = req.body.startDate || '2025-01-01'
  const unscrapped = dataScraper.getUnscrappedDates(startDate)

  res.json({ 
    message: `Historical backfill started from ${startDate}`,
    datesToScrape: unscrapped.length,
    estimatedTime: `~${Math.round(unscrapped.length * 90 * 0.8 / 60)} minutes`
  })

  dataScraper.runHistoricalBackfill(startDate, {
    investor: req.body.investor || 'all',
    market: req.body.market || 'RG'
  }).catch(err => {
    console.error('Historical backfill failed:', err.message)
  })
})

// POST /api/scraper/daily — Phase 3: Manual daily update
router.post('/scraper/daily', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin only' })
  }

  const dataScraper = require('../services/data-scraper')
  res.json({ message: 'Daily update started', date: req.body.date || 'latest trading day' })

  dataScraper.runDailyUpdate({
    date: req.body.date,
    investor: req.body.investor || 'all',
    market: req.body.market || 'RG'
  }).catch(err => {
    console.error('Daily update failed:', err.message)
  })
})

// GET /api/scraper/status — Full scraper dashboard status
router.get('/scraper/status', authMiddleware, async (req, res) => {
  try {
    const dataScraper = require('../services/data-scraper')
    const status = dataScraper.getScraperStatus()
    res.json(status)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/scraper/unscrapped — Check which dates still need scraping
router.get('/scraper/unscrapped', authMiddleware, async (req, res) => {
  try {
    const dataScraper = require('../services/data-scraper')
    const startDate = req.query.from || '2025-01-01'
    const dates = dataScraper.getUnscrappedDates(startDate)
    res.json({
      totalUnscrapped: dates.length,
      dates: dates.slice(0, 30),
      hasMore: dates.length > 30
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ═══════════════════════════════════════════════════════
// IDX Official Scraper API (NO LOGIN REQUIRED!)
// ═══════════════════════════════════════════════════════

// POST /api/idx/master — Phase 1: Scrape all tickers + brokers from IDX
router.post('/idx/master', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin only' })
  }

  const idxScraper = require('../services/idx-scraper')
  res.json({ message: 'IDX master scrape started (no login required!)' })

  idxScraper.runIDXMasterScrape().catch(err => {
    console.error('IDX master scrape failed:', err.message)
  })
})

// POST /api/idx/backfill — Phase 2: Historical backfill from IDX
router.post('/idx/backfill', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin only' })
  }

  const idxScraper = require('../services/idx-scraper')
  const startDate = req.body.startDate || '2025-01-01'

  res.json({
    message: `IDX historical backfill started from ${startDate}`,
    note: 'No login required — using IDX official API'
  })

  idxScraper.runIDXHistoricalBackfill(startDate).catch(err => {
    console.error('IDX historical backfill failed:', err.message)
  })
})

// POST /api/idx/daily — Phase 3: Daily update from IDX
router.post('/idx/daily', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin only' })
  }

  const idxScraper = require('../services/idx-scraper')
  res.json({ message: 'IDX daily update started' })

  idxScraper.runIDXDailyUpdate().catch(err => {
    console.error('IDX daily update failed:', err.message)
  })
})

// GET /api/idx/status — Check IDX scraper status
router.get('/idx/status', authMiddleware, async (req, res) => {
  try {
    const idxScraper = require('../services/idx-scraper')
    res.json(idxScraper.getIDXScraperStatus())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ═══════════════════════════════════════════════════════
// Local Worker Data Injector API (Receives data from laptop)
// ═══════════════════════════════════════════════════════

router.post('/scraper/push/brokers', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') return res.status(403).json({ error: 'Admin only' })
  
  const { brokers } = req.body
  if (!brokers || !Array.isArray(brokers)) return res.status(400).json({ error: 'Invalid payload' })
  
  const db = getDB()
  const upsertMaster = db.prepare(`INSERT INTO master_brokers (code, name, category, scraped_at) VALUES (?, ?, 'local', datetime('now')) ON CONFLICT(code) DO UPDATE SET name = excluded.name, scraped_at = datetime('now')`)
  const upsertLegacy = db.prepare(`INSERT INTO brokers (code, entity_name) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET entity_name = excluded.entity_name`)
  
  let count = 0
  db.transaction((rows) => {
    for (const item of rows) {
      if (!item.code) continue
      upsertMaster.run(item.code, item.name)
      upsertLegacy.run(item.code, item.name)
      count++
    }
  })(brokers)
  
  res.json({ success: true, count })
})

router.post('/scraper/push/stocks', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') return res.status(403).json({ error: 'Admin only' })
  
  const { stocks } = req.body
  if (!stocks || !Array.isArray(stocks)) return res.status(400).json({ error: 'Invalid payload' })
  
  const db = getDB()
  const upsertMaster = db.prepare(`INSERT INTO master_tickers (code, name, last_price, change_pct, scraped_at) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(code) DO UPDATE SET name = excluded.name, last_price = excluded.last_price, change_pct = excluded.change_pct, scraped_at = datetime('now')`)
  const upsertLegacy = db.prepare(`INSERT INTO tickers (code, name, last_price, last_value, universe) VALUES (?, ?, ?, ?, '["IHSG"]') ON CONFLICT(code) DO UPDATE SET name = excluded.name, last_price = excluded.last_price, last_value = excluded.last_value`)
  
  let count = 0
  db.transaction((rows) => {
    for (const item of rows) {
      if (!item.code) continue
      const changePct = item.previous > 0 ? ((item.last_price - item.previous) / item.previous * 100) : 0
      upsertMaster.run(item.code, item.name, item.last_price, Number(changePct.toFixed(2)))
      upsertLegacy.run(item.code, item.name, item.last_price, item.last_value)
      count++
    }
  })(stocks)
  
  res.json({ success: true, count })
})

router.post('/scraper/push/broker_pl', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') return res.status(403).json({ error: 'Admin only' })
  
  const { data, date } = req.body
  if (!data || !Array.isArray(data) || !date) return res.status(400).json({ error: 'Invalid payload' })
  
  const db = getDB()
  const upsert = db.prepare(`INSERT INTO broker_daily_pl (trade_date, broker_code, broker_name, total_net, total_buy, total_sell, estimated_pl, active_tickers, top_focus, investor_type, market, scraped_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, 'all', 'RG', datetime('now')) ON CONFLICT(trade_date, broker_code, investor_type, market) DO UPDATE SET broker_name = excluded.broker_name, total_net = excluded.total_net, total_buy = excluded.total_buy, total_sell = excluded.total_sell, scraped_at = datetime('now')`)
  
  let count = 0
  db.transaction((items) => {
    for (const item of items) {
      if (!item.broker_code) continue
      upsert.run(date, item.broker_code, item.broker_name, item.total_net, item.total_buy, item.total_sell)
      count++
    }
  })(data)
  
  try {
    const dow = new Date(date + 'T00:00:00Z').getUTCDay()
    db.prepare(`INSERT INTO trading_days (trade_date, day_of_week, scraped_at) VALUES (?, ?, datetime('now')) ON CONFLICT(trade_date) DO NOTHING`).run(date, dow)
  } catch {}
  
  res.json({ success: true, count })
})

// GET existing scraped dates (for resumable backfill)
router.get('/scraper/push/existing-dates', authMiddleware, (req, res) => {
  const db = getDB()
  const rows = db.prepare('SELECT DISTINCT trade_date FROM broker_daily_pl ORDER BY trade_date').all()
  res.json({ dates: rows.map(r => r.trade_date), count: rows.length })
})

module.exports = router

