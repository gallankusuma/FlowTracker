require('dotenv').config()
const express = require('express')
const cors = require('cors')
const path = require('path')
const { initDB } = require('./database/init')
const ftProxy = require('./services/flowtracker-proxy')

// Routes
const authRoutes = require('./routes/auth')
const marketRoutes = require('./routes/market')
const brokerRoutes = require('./routes/broker')
const shareholderRoutes = require('./routes/shareholder')
const adminRoutes = require('./routes/admin')

const app = express()
const PORT = process.env.PORT || 3001
const IS_PROD = process.env.NODE_ENV === 'production'

// Middleware
app.use(cors({
  origin: IS_PROD
    ? (process.env.FRONTEND_URL || true)
    : true,
  credentials: true
}))
app.use(express.json())

// Initialize database
initDB()
ftProxy.init()

// ── Daily Data Update (runs at 16:30 WIB / 09:30 UTC after market close) ──
try {
  const idxScraper = require('./services/idx-scraper')

  // Schedule: every weekday at 16:30 WIB (09:30 UTC)
  const SCRAPE_HOUR = 9  // 09 UTC = 16 WIB
  const SCRAPE_MIN = 30

  function scheduleScraper() {
    const now = new Date()
    const targetUTC = new Date(now)
    targetUTC.setUTCHours(SCRAPE_HOUR, SCRAPE_MIN, 0, 0)

    // If already past today's schedule, move to tomorrow
    if (now >= targetUTC) {
      targetUTC.setDate(targetUTC.getDate() + 1)
    }

    // Skip weekends
    while (targetUTC.getUTCDay() === 0 || targetUTC.getUTCDay() === 6) {
      targetUTC.setDate(targetUTC.getDate() + 1)
    }

    const delay = targetUTC - now
    const hoursUntil = (delay / 3600000).toFixed(1)
    console.log(`⏰ Next daily update (IDX): ${targetUTC.toISOString()} (~${hoursUntil}h from now)`)

    setTimeout(async () => {
      console.log('🕐 Running scheduled daily IDX update...')
      try {
        await idxScraper.runIDXDailyUpdate()
      } catch (err) {
        console.error('❌ Scheduled daily update failed:', err.message)
      }
      // Schedule next one
      scheduleScraper()
    }, delay)
  }

  scheduleScraper()
} catch (err) {
  console.warn('⚠️ Data scraper init skipped:', err.message)
}

// API Routes
app.use('/api', authRoutes)
app.use('/api', marketRoutes)
app.use('/api', brokerRoutes)
app.use('/api', shareholderRoutes)
app.use('/api', adminRoutes)

// Version endpoint
app.get('/api/version', (req, res) => {
  res.json({ version: '1.0.0', name: 'FlowTracker API', status: 'active', env: IS_PROD ? 'production' : 'development' })
})

// Serve frontend in production
if (IS_PROD) {
  const frontendPath = path.join(__dirname, '..', 'frontend', 'dist')
  app.use(express.static(frontendPath))

  // SPA fallback — any non-API route serves index.html (Express 5 syntax)
  app.get('{*path}', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(frontendPath, 'index.html'))
    }
  })
}

// Root (dev mode)
if (!IS_PROD) {
  app.get('/', (req, res) => {
    res.json({ message: 'FlowTracker API — v1.0.0', docs: '/api/version' })
  })
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌊 FlowTracker ${IS_PROD ? 'PRODUCTION' : 'DEV'} running on http://0.0.0.0:${PORT}`)
})
