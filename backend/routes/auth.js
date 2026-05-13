const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { getDB } = require('../database/init')
const { authMiddleware, JWT_SECRET } = require('../middleware/auth')

const router = express.Router()

// POST /api/login
router.post('/login', (req, res) => {
  const { email, password } = req.body
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' })
  }

  const db = getDB()
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email)
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' })
  }

  const valid = bcrypt.compareSync(password, user.password_hash)
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password' })
  }

  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  )

  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      subscription_end: user.subscription_end
    }
  })
})

// POST /api/register
router.post('/register', (req, res) => {
  const { name, email, password } = req.body
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' })
  }

  const db = getDB()
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
  if (existing) {
    return res.status(409).json({ error: 'Email already registered' })
  }

  const hash = bcrypt.hashSync(password, 10)
  const subEnd = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString()

  const result = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, subscription_end) VALUES (?, ?, ?, 'user', ?)
  `).run(name, email, hash, subEnd)

  const token = jwt.sign(
    { id: result.lastInsertRowid, email, name, role: 'user' },
    JWT_SECRET,
    { expiresIn: '7d' }
  )

  res.status(201).json({
    token,
    user: { id: result.lastInsertRowid, name, email, role: 'user', subscription_end: subEnd }
  })
})

// GET /api/auth — verify token
router.get('/auth', authMiddleware, (req, res) => {
  const db = getDB()
  const user = db.prepare('SELECT id, name, email, role, subscription_end FROM users WHERE id = ?').get(req.user.id)
  if (!user) return res.status(404).json({ error: 'User not found' })
  res.json({ user })
})

// PUT /api/users/password — change password
router.put('/users/password', authMiddleware, (req, res) => {
  const { oldPassword, newPassword } = req.body
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Old and new passwords are required' })
  }

  const db = getDB()
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)
  if (!user) return res.status(404).json({ error: 'User not found' })

  const valid = bcrypt.compareSync(oldPassword, user.password_hash)
  if (!valid) return res.status(401).json({ error: 'Old password is incorrect' })

  const hash = bcrypt.hashSync(newPassword, 10)
  db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime("now") WHERE id = ?').run(hash, user.id)

  res.json({ message: 'Password updated successfully' })
})

module.exports = router
