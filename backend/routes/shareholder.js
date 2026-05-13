const express = require('express')
const { getDB } = require('../database/init')
const { authMiddleware } = require('../middleware/auth')
const proxy = require('../services/flowtracker-proxy')

const router = express.Router()

// GET /api/shareholder-reports — Insider Moves data
router.get('/shareholder-reports', authMiddleware, async (req, res) => {
  const { date, search, mode = 'all' } = req.query

  // ── Try Real API ──
  if (proxy.isEnabled() && date) {
    try {
      const result = await proxy.getInsiderMoves(date, date)
      if (result?.data) {
        const rawData = Array.isArray(result.data) ? result.data : (result.data?.data || [])
        const transformed = rawData.map((r, i) => ({
          no: i + 1,
          ticker: r.code || r.ticker || r.ticker_code,
          name: r.shareholderName || r.name || r.shareholder_name,
          remark: r.remarkType || r.remark || r.remark_type,
          d2: r.dMinus2 || r.d2 || r.d_minus_2 || 0,
          d1: r.dMinus1 || r.d1 || r.d_minus_1 || 0,
          pctD2: r.pctD2 || r.pct_d2 || 0,
          pctD1: r.pctD1 || r.pct_d1 || 0,
          change: r.change || r.changeAmount || r.change_amount || 0
        }))

        // Client-side search filter
        let filtered = transformed
        if (search) {
          const s = search.toLowerCase()
          if (mode === 'ticker') {
            filtered = transformed.filter(r => r.ticker?.toLowerCase().includes(s))
          } else if (mode === 'name') {
            filtered = transformed.filter(r => r.name?.toLowerCase().includes(s))
          } else {
            filtered = transformed.filter(r =>
              r.ticker?.toLowerCase().includes(s) || r.name?.toLowerCase().includes(s)
            )
          }
        }

        return res.json({
          data: filtered,
          reportDate: date,
          realAPI: true,
          source: result.source
        })
      }
    } catch (err) {
      console.warn('Insider moves proxy fallback:', err.message)
    }
  }

  // ── Fallback: Local ──
  const db = getDB()
  let query = 'SELECT * FROM shareholder_reports WHERE 1=1'
  const params = []

  if (date) {
    query += ' AND report_date = ?'
    params.push(date)
  }

  if (search) {
    if (mode === 'ticker') {
      query += ' AND ticker_code LIKE ?'
      params.push(`%${search}%`)
    } else if (mode === 'name') {
      query += ' AND shareholder_name LIKE ?'
      params.push(`%${search}%`)
    } else {
      query += ' AND (ticker_code LIKE ? OR shareholder_name LIKE ?)'
      params.push(`%${search}%`, `%${search}%`)
    }
  }

  query += ' ORDER BY id'

  const reports = db.prepare(query).all(...params)

  res.json({
    data: reports.map((r, i) => ({
      no: i + 1,
      ticker: r.ticker_code,
      name: r.shareholder_name,
      remark: r.remark_type,
      d2: r.d_minus_2,
      d1: r.d_minus_1,
      pctD2: r.pct_d2,
      pctD1: r.pct_d1,
      change: r.change_amount
    })),
    reportDate: date || 'latest'
  })
})

// GET /api/ownership/:ticker — Ownership structure
router.get('/ownership/:ticker', authMiddleware, (req, res) => {
  const { ticker } = req.params
  const db = getDB()

  const ownership = db.prepare(`
    SELECT * FROM ownership WHERE ticker_code = ? ORDER BY percentage DESC
  `).all(ticker)

  if (ownership.length === 0) {
    return res.status(404).json({ error: 'No ownership data found' })
  }

  res.json({
    ticker,
    syncDate: ownership[0].sync_date,
    data: ownership.map(o => ({
      name: o.holder_name,
      type: o.holder_type,
      shares: o.shares,
      pct: o.percentage
    }))
  })
})

// GET /api/balance-position/:ticker — KSEI balance
router.get('/balance-position/:ticker', authMiddleware, (req, res) => {
  const { ticker } = req.params
  const db = getDB()

  const data = db.prepare(`
    SELECT * FROM balance_position WHERE ticker_code = ? ORDER BY month
  `).all(ticker)

  res.json({ ticker, data })
})

module.exports = router
