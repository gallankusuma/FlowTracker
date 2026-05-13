const express = require('express')
const { getDB } = require('../database/init')
const { authMiddleware, adminMiddleware } = require('../middleware/auth')

const router = express.Router()

// ── CMS: FAQ & Content Management ──

// GET /api/cms/content — Get content by type
router.get('/cms/content', authMiddleware, (req, res) => {
  const { type } = req.query
  const db = getDB()

  let query = 'SELECT * FROM cms_content WHERE is_active = 1'
  const params = []

  if (type) {
    query += ' AND content_type = ?'
    params.push(type)
  }

  query += ' ORDER BY sort_order'
  const content = db.prepare(query).all(...params)
  res.json({ data: content })
})

// POST /api/cms/content — Create content (admin only)
router.post('/cms/content', authMiddleware, adminMiddleware, (req, res) => {
  const { content_type, title, body, sort_order = 0 } = req.body
  if (!content_type || !title) {
    return res.status(400).json({ error: 'content_type and title are required' })
  }

  const db = getDB()
  const result = db.prepare(`
    INSERT INTO cms_content (content_type, title, body, sort_order) VALUES (?, ?, ?, ?)
  `).run(content_type, title, body, sort_order)

  // Audit log
  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
    VALUES (?, 'create', 'cms_content', ?, ?)
  `).run(req.user.id, String(result.lastInsertRowid), JSON.stringify({ title, content_type }))

  res.status(201).json({ id: result.lastInsertRowid, message: 'Content created' })
})

// PUT /api/cms/content/:id — Update content (admin only)
router.put('/cms/content/:id', authMiddleware, adminMiddleware, (req, res) => {
  const { id } = req.params
  const { title, body, sort_order, is_active } = req.body
  const db = getDB()

  const existing = db.prepare('SELECT * FROM cms_content WHERE id = ?').get(id)
  if (!existing) return res.status(404).json({ error: 'Content not found' })

  db.prepare(`
    UPDATE cms_content SET
      title = COALESCE(?, title),
      body = COALESCE(?, body),
      sort_order = COALESCE(?, sort_order),
      is_active = COALESCE(?, is_active),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(title, body, sort_order, is_active, id)

  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
    VALUES (?, 'update', 'cms_content', ?, ?)
  `).run(req.user.id, id, JSON.stringify({ title, body }))

  res.json({ message: 'Content updated' })
})

// DELETE /api/cms/content/:id — Delete content (admin only)
router.delete('/cms/content/:id', authMiddleware, adminMiddleware, (req, res) => {
  const { id } = req.params
  const db = getDB()

  db.prepare('DELETE FROM cms_content WHERE id = ?').run(id)

  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id)
    VALUES (?, 'delete', 'cms_content', ?)
  `).run(req.user.id, id)

  res.json({ message: 'Content deleted' })
})

// ── CMS: Settings ──

// GET /api/cms/settings
router.get('/cms/settings', authMiddleware, (req, res) => {
  const db = getDB()
  const settings = db.prepare('SELECT * FROM cms_settings').all()
  const obj = {}
  settings.forEach(s => { obj[s.key] = s.value })
  res.json({ data: obj })
})

// PUT /api/cms/settings (admin only)
router.put('/cms/settings', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDB()
  const updates = req.body

  const stmt = db.prepare(`
    INSERT INTO cms_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `)

  for (const [key, value] of Object.entries(updates)) {
    stmt.run(key, String(value))
  }

  res.json({ message: 'Settings updated' })
})

// ── User Management (admin) ──

// GET /api/users — List all users (admin only)
router.get('/users', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDB()
  const users = db.prepare('SELECT id, name, email, role, subscription_end, created_at FROM users ORDER BY id').all()
  res.json({ data: users })
})

// ── Audit Log ──

// GET /api/audit-log (admin only)
router.get('/audit-log', authMiddleware, adminMiddleware, (req, res) => {
  const { limit = 50 } = req.query
  const db = getDB()
  const logs = db.prepare(`
    SELECT al.*, u.name as user_name FROM audit_log al
    LEFT JOIN users u ON al.user_id = u.id
    ORDER BY al.created_at DESC LIMIT ?
  `).all(Number(limit))
  res.json({ data: logs })
})

module.exports = router
