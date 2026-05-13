const Database = require('better-sqlite3')
const path = require('path')
const bcrypt = require('bcryptjs')

const DB_PATH = path.join(__dirname, '..', 'flowtracker.db')
let db

function getDB() {
  if (!db) {
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
  }
  return db
}

function initDB() {
  const db = getDB()

  // ── Users ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user' CHECK(role IN ('user','admin','superadmin')),
      subscription_end TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // ── Tickers ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickers (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sector TEXT,
      last_price REAL DEFAULT 0,
      market_cap REAL DEFAULT 0,
      last_value REAL DEFAULT 0,
      universe TEXT DEFAULT '["IHSG"]'
    )
  `)

  // ── Brokers ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS brokers (
      code TEXT PRIMARY KEY,
      entity_name TEXT NOT NULL
    )
  `)

  // ── Flow Data (daily concentration) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS flow_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_date TEXT NOT NULL,
      ticker_code TEXT NOT NULL,
      foreign_flow REAL DEFAULT 0,
      retail_flow REAL DEFAULT 0,
      big_money_flow REAL DEFAULT 0,
      concentration_pct REAL DEFAULT 0,
      daily_change REAL DEFAULT 0,
      FOREIGN KEY (ticker_code) REFERENCES tickers(code),
      UNIQUE(trade_date, ticker_code)
    )
  `)

  // ── Broker Summary (daily per broker per ticker) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS broker_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_date TEXT NOT NULL,
      ticker_code TEXT NOT NULL,
      broker_code TEXT NOT NULL,
      buy_value REAL DEFAULT 0,
      buy_lot INTEGER DEFAULT 0,
      sell_value REAL DEFAULT 0,
      sell_lot INTEGER DEFAULT 0,
      net_value REAL DEFAULT 0,
      net_lot INTEGER DEFAULT 0,
      avg_price REAL DEFAULT 0,
      segment TEXT DEFAULT 'REGULAR',
      FOREIGN KEY (ticker_code) REFERENCES tickers(code),
      FOREIGN KEY (broker_code) REFERENCES brokers(code),
      UNIQUE(trade_date, ticker_code, broker_code, segment)
    )
  `)

  // ── Ownership ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS ownership (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_date TEXT NOT NULL,
      ticker_code TEXT NOT NULL,
      holder_name TEXT NOT NULL,
      holder_type TEXT DEFAULT 'HOLDER',
      shares INTEGER DEFAULT 0,
      percentage REAL DEFAULT 0,
      FOREIGN KEY (ticker_code) REFERENCES tickers(code)
    )
  `)

  // ── Balance Position (KSEI monthly) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS balance_position (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT NOT NULL,
      ticker_code TEXT NOT NULL,
      investor_type TEXT NOT NULL,
      investor_category TEXT NOT NULL,
      shares INTEGER DEFAULT 0,
      FOREIGN KEY (ticker_code) REFERENCES tickers(code)
    )
  `)

  // ── Shareholder Reports (Insider Moves) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS shareholder_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_date TEXT NOT NULL,
      ticker_code TEXT NOT NULL,
      shareholder_name TEXT NOT NULL,
      remark_type TEXT,
      d_minus_2 INTEGER DEFAULT 0,
      d_minus_1 INTEGER DEFAULT 0,
      pct_d2 REAL DEFAULT 0,
      pct_d1 REAL DEFAULT 0,
      change_amount INTEGER DEFAULT 0,
      FOREIGN KEY (ticker_code) REFERENCES tickers(code)
    )
  `)

  // ── CMS: Content (for FAQ, announcements, disclaimers) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS cms_content (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_type TEXT NOT NULL,
      title TEXT,
      body TEXT,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // ── CMS: Settings ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS cms_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // ── Audit Log ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // ── Broker Daily P/L (scraped summary per broker per date) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS broker_daily_pl (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_date TEXT NOT NULL,
      broker_code TEXT NOT NULL,
      broker_name TEXT,
      total_net REAL DEFAULT 0,
      total_buy REAL DEFAULT 0,
      total_sell REAL DEFAULT 0,
      estimated_pl REAL,
      active_tickers INTEGER DEFAULT 0,
      top_focus TEXT,
      investor_type TEXT DEFAULT 'all',
      market TEXT DEFAULT 'RG',
      scraped_at TEXT DEFAULT (datetime('now')),
      UNIQUE(trade_date, broker_code, investor_type, market)
    )
  `)

  // Index for fast lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_broker_daily_pl_date ON broker_daily_pl(trade_date)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_broker_daily_pl_broker ON broker_daily_pl(broker_code)
  `)

  // ── Master Tickers (all IHSG emitens from API) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS master_tickers (
      code TEXT PRIMARY KEY,
      name TEXT,
      sector TEXT,
      last_price REAL DEFAULT 0,
      change_pct REAL DEFAULT 0,
      market_cap REAL DEFAULT 0,
      is_unusual INTEGER DEFAULT 0,
      is_crossing INTEGER DEFAULT 0,
      is_suspend INTEGER DEFAULT 0,
      is_likuid INTEGER DEFAULT 0,
      scraped_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // ── Master Brokers (all brokers from API) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS master_brokers (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT DEFAULT 'local',
      scraped_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // ── Trading Days (valid trading dates cache) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS trading_days (
      trade_date TEXT PRIMARY KEY,
      day_of_week INTEGER,
      scraped_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // ── Scraper Log (track scraping jobs) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS scraper_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scraper_type TEXT NOT NULL,
      target_date TEXT,
      status TEXT DEFAULT 'running',
      records_processed INTEGER DEFAULT 0,
      records_failed INTEGER DEFAULT 0,
      total_records INTEGER DEFAULT 0,
      error_message TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT
    )
  `)

  // Index for scraper status lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_scraper_log_type ON scraper_log(scraper_type, status)
  `)

  // ── Seed default admin user ──
  const adminExists = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@flowtracker.id')
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 10)
    db.prepare(`
      INSERT INTO users (name, email, password_hash, role, subscription_end)
      VALUES (?, ?, ?, ?, ?)
    `).run('Admin', 'admin@flowtracker.id', hash, 'superadmin', '2027-12-31T23:59:59Z')
  }

  // ── Seed demo user ──
  const demoExists = db.prepare('SELECT id FROM users WHERE email = ?').get('gallankusuma41@gmail.com')
  if (!demoExists) {
    const hash = bcrypt.hashSync('Gk@240388', 10)
    const subEnd = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString()
    db.prepare(`
      INSERT INTO users (name, email, password_hash, role, subscription_end)
      VALUES (?, ?, ?, ?, ?)
    `).run('GALLAN', 'gallankusuma41@gmail.com', hash, 'user', subEnd)
  }

  console.log('✅ Database initialized')
  seedData(db)
}

function seedData(db) {
  // Check if data already seeded
  const tickerCount = db.prepare('SELECT COUNT(*) as count FROM tickers').get().count
  if (tickerCount > 0) return

  console.log('📊 Seeding mock data...')

  // ── Seed Tickers ──
  const insertTicker = db.prepare('INSERT OR IGNORE INTO tickers (code, name, sector, last_price, market_cap, last_value, universe) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const tickersData = [
    ['BBRI', 'Bank Rakyat Indonesia', 'Banking', 3260, 400e12, 1.1e12, '["IHSG"]'],
    ['BMRI', 'Bank Mandiri', 'Banking', 4630, 350e12, 1.7e12, '["IHSG"]'],
    ['BBCA', 'Bank Central Asia', 'Banking', 8750, 1080e12, 2.3e12, '["IHSG"]'],
    ['ASII', 'PT Astra International Tbk', 'Automotive', 5825, 235e12, 214.2e9, '["IHSG","Astra Group"]'],
    ['TLKM', 'Telekomunikasi Indonesia', 'Telecom', 2640, 260e12, 890e9, '["IHSG"]'],
    ['UNVR', 'Unilever Indonesia', 'Consumer', 2230, 85e12, 156e9, '["IHSG"]'],
    ['ICBP', 'Indofood CBP Sukses Makmur', 'Consumer', 10250, 120e12, 342e9, '["IHSG","Salim Group"]'],
    ['INDF', 'Indofood Sukses Makmur', 'Consumer', 6575, 58e12, 287e9, '["IHSG","Salim Group"]'],
    ['KLBF', 'Kalbe Farma', 'Pharma', 1480, 70e12, 198e9, '["IHSG"]'],
    ['ANTM', 'Aneka Tambang', 'Mining', 1670, 40e12, 423e9, '["IHSG"]'],
    ['MDKA', 'Merdeka Copper Gold', 'Mining', 2940, 71e12, 178e9, '["IHSG","Prajogo Pangestu"]'],
    ['BRPT', 'Barito Pacific', 'Petrochem', 985, 50e12, 89e9, '["IHSG","Prajogo Pangestu"]'],
    ['TPIA', 'Chandra Asri Pacific', 'Petrochem', 7150, 82e12, 45e9, '["IHSG","Prajogo Pangestu"]'],
    ['SMGR', 'Semen Indonesia', 'Cement', 3840, 23e12, 312e9, '["IHSG"]'],
    ['BBNI', 'Bank Negara Indonesia', 'Banking', 4120, 77e12, 678e9, '["IHSG"]'],
    ['EMTK', 'Elang Mahkota Teknologi', 'Media', 456, 25e12, 56e9, '["IHSG","Emtek Group"]'],
    ['KOIN', 'Kokoh Inti Arebama', 'Trade', 82, 500e6, 1.6e6, '["IHSG"]'],
    ['SOSS', 'Shield On Service', 'Services', 915, 1.5e9, 183.5e3, '["IHSG"]'],
    ['UNTR', 'United Tractors', 'Heavy Equip', 27400, 102e12, 134.3e9, '["IHSG","Astra Group"]'],
    ['AALI', 'Astra Agro Lestari', 'Plantation', 8050, 15e12, 21.3e9, '["IHSG","Astra Group"]'],
  ]
  for (const t of tickersData) {
    insertTicker.run(...t)
  }

  // ── Seed Brokers ──
  const insertBroker = db.prepare('INSERT OR IGNORE INTO brokers (code, entity_name) VALUES (?, ?)')
  const brokersData = [
    ['AD', 'SUKADANA PRIMA SEKURITAS'], ['AF', 'HARITA KENCANA SEKURITAS'],
    ['AG', 'KIWOOM SEKURITAS INDONESIA'], ['AH', 'SHINHAN SEKURITAS INDONESIA'],
    ['AI', 'UOB KAY HIAN SEKURITAS'], ['AK', 'UBS SEKURITAS INDONESIA'],
    ['AN', 'WANTEG SEKURITAS'], ['AO', 'ERDIKHA ELIT SEKURITAS'],
    ['BK', 'DEUTSCHE SEKURITAS INDONESIA'], ['CC', 'MANDIRI SEKURITAS'],
    ['DR', 'BCA SEKURITAS'], ['GR', 'PANIN SEKURITAS'],
    ['IF', 'INDO PREMIER SEKURITAS'], ['KK', 'MAYBANK SEKURITAS INDONESIA'],
    ['KZ', 'MIRAE ASSET SEKURITAS INDONESIA'], ['NI', 'TRIMEGAH SEKURITAS INDONESIA'],
    ['PD', 'SINARMAS SEKURITAS'], ['RX', 'MACQUARIE SEKURITAS INDONESIA'],
    ['SQ', 'SUCOR SEKURITAS'], ['XA', 'CLSA SEKURITAS INDONESIA'],
    ['XL', 'SAMUEL SEKURITAS INDONESIA'], ['YP', 'CGS-CIMB SEKURITAS INDONESIA'],
    ['YU', 'CGS INTERNASIONAL SEKURITAS'], ['ZP', 'MORGAN STANLEY SEKURITAS INDONESIA'],
    ['ZR', 'JP MORGAN SEKURITAS INDONESIA'],
  ]
  for (const b of brokersData) {
    insertBroker.run(...b)
  }

  // ── Seed Flow Data (last 10 trading days for each ticker) ──
  const insertFlow = db.prepare(`
    INSERT OR IGNORE INTO flow_data (trade_date, ticker_code, foreign_flow, retail_flow, big_money_flow, concentration_pct, daily_change)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const dates = ['2026-04-24', '2026-04-25', '2026-04-28', '2026-04-29', '2026-04-30',
                 '2026-05-02', '2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08']
  for (const t of tickersData) {
    const code = t[0]
    for (let i = 0; i < dates.length; i++) {
      const ff = (Math.random() - 0.5) * 100e9
      const rf = (Math.random() - 0.5) * 80e9
      const bf = (Math.random() - 0.5) * 60e9
      const conc = (Math.random() - 0.3) * 40
      const dc = (Math.random() - 0.5) * 6
      insertFlow.run(dates[i], code, ff, rf, bf, conc, dc)
    }
  }

  // ── Seed Broker Summary (daily broker-level transactions) ──
  const insertBS = db.prepare(`
    INSERT OR IGNORE INTO broker_summary (trade_date, ticker_code, broker_code, buy_value, buy_lot, sell_value, sell_lot, net_value, net_lot, avg_price, segment)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const brokerCodes = brokersData.map(b => b[0])
  const recentDates = ['2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08']

  for (const t of tickersData) {
    const tCode = t[0]
    const price = t[3]
    // Each ticker gets transactions from 5-10 random brokers
    const numBrokers = 5 + Math.floor(Math.random() * 6)
    const shuffled = [...brokerCodes].sort(() => Math.random() - 0.5).slice(0, numBrokers)

    for (const bCode of shuffled) {
      for (const date of recentDates) {
        const buyVal = Math.random() * 50e9
        const sellVal = Math.random() * 50e9
        const buyLot = Math.round(buyVal / price)
        const sellLot = Math.round(sellVal / price)
        const netVal = buyVal - sellVal
        const netLot = buyLot - sellLot
        const avgPrice = price * (0.98 + Math.random() * 0.04)
        insertBS.run(date, tCode, bCode, buyVal, buyLot, sellVal, sellLot, netVal, netLot, Math.round(avgPrice), 'REGULAR')
      }
    }
  }

  // ── Seed Shareholder Reports (Insider Moves) ──
  const insertSH = db.prepare(`
    INSERT INTO shareholder_reports (report_date, ticker_code, shareholder_name, remark_type, d_minus_2, d_minus_1, pct_d2, pct_d1, change_amount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insiderData = [
    ['2026-05-08', 'ASII', 'JARDINE CYCLE AND CARRIAGE LIMITED', 'CC', 20290000000, 20290000000, 50.11, 50.11, 0],
    ['2026-05-08', 'BBRI', 'PEMERINTAH REPUBLIK INDONESIA', 'YU', 21643000000, 21643000000, 53.19, 53.19, 0],
    ['2026-05-08', 'BMRI', 'PEMERINTAH REPUBLIK INDONESIA', 'YU', 13948000000, 13948000000, 60.00, 60.00, 0],
    ['2026-05-08', 'ANTM', 'PEMERINTAH REPUBLIK INDONESIA', 'CC', 15627000000, 15627000000, 65.00, 65.00, 0],
    ['2026-05-08', 'UNVR', 'UNILEVER OVERSEAS HOLDINGS', 'CP', 6484877500, 6484877500, 84.99, 84.99, 0],
    ['2026-05-08', 'TLKM', 'PEMERINTAH REPUBLIK INDONESIA', 'YU', 26396375000, 26396375000, 52.09, 52.09, 0],
    ['2026-05-08', 'ICBP', 'PT INDOFOOD SUKSES MAKMUR', 'CC', 9375500000, 9475500000, 80.53, 81.39, 100000000],
    ['2026-05-08', 'MDKA', 'PT MERDEKA RESOURCE', 'ER', 0, 567890123, 0, 2.34, 567890123],
  ]
  for (const d of insiderData) {
    insertSH.run(...d)
  }

  // ── Seed Ownership (ASII) ──
  const insertOwn = db.prepare('INSERT INTO ownership (sync_date, ticker_code, holder_name, holder_type, shares, percentage) VALUES (?, ?, ?, ?, ?, ?)')
  const ownData = [
    ['2026-03-31', 'ASII', 'Jardine Cycle and Carriage Limited', 'HOLDER', 20290000000, 50.11],
    ['2026-03-31', 'ASII', 'Toyota Motor Corporation', 'HOLDER', 1970000000, 4.74],
    ['2026-03-31', 'ASII', 'DJS Ketenagakerjaan Program JHT', 'HOLDER', 1110000000, 2.74],
    ['2026-03-31', 'ASII', 'Citibank NY S/A Orbis SICAV', 'HOLDER', 522590000, 1.29],
    ['2026-03-31', 'ASII', 'Masyarakat', 'PUBLIC', 15740000000, 38.80],
  ]
  for (const o of ownData) {
    insertOwn.run(...o)
  }

  // ── Seed CMS Content (FAQ) ──
  const insertCMS = db.prepare('INSERT INTO cms_content (content_type, title, body, sort_order) VALUES (?, ?, ?, ?)')
  const faqData = [
    ['faq', 'Apa itu FlowTracker?', 'FlowTracker adalah platform analisis pasar saham Indonesia yang melacak aliran dana dari broker, investor asing, ritel, dan institusi.', 1],
    ['faq', 'Apakah FlowTracker cocok untuk pemula?', 'Ya! FlowTracker dirancang dengan antarmuka yang intuitif dan menyediakan panduan penggunaan serta video tutorial.', 2],
    ['faq', 'Bagaimana cara kerja fitur Insider Moves?', 'Insider Moves memantau perubahan kepemilikan saham oleh Direksi, Komisaris, dan Pemegang Saham Pengendali berdasarkan laporan OJK.', 3],
    ['faq', 'Apa perbedaan Flow Analyzer dengan Accumulation Streak?', 'Flow Analyzer menampilkan konsentrasi broker harian, sedangkan Accumulation Streak mendeteksi pola akumulasi berturut-turut dalam 2-5 hari.', 4],
    ['faq', 'Apakah data di FlowTracker diupdate setiap hari?', 'Ya, data diperbarui setiap hari bursa berdasarkan data resmi dari IDX, KSEI, dan OJK.', 5],
    ['faq', 'Dapatkah saya memantau broker spesifik?', 'Ya! Gunakan fitur Broker Activity dan klik Run Stalker untuk melihat detail transaksi broker tertentu.', 6],
    ['faq', 'Apakah FlowTracker bisa diakses melalui HP?', 'FlowTracker dirancang responsive dan dapat diakses melalui browser di perangkat mobile.', 7],
    ['faq', 'Bagaimana cara berlangganan?', 'Klik tombol Perpanjang di dashboard atau hubungi admin untuk informasi paket langganan.', 8],
    ['disclaimer', 'Informasi Bukan Nasihat Keuangan', 'Semua data dan analisis di FlowTracker hanya bersifat informatif.', 1],
    ['disclaimer', 'Risiko Pasar Modal', 'Investasi di pasar modal mengandung risiko kerugian.', 2],
    ['disclaimer', 'Akurasi Data', 'Data bersumber dari IDX, KSEI, dan OJK. Kami berupaya menjaga akurasi.', 3],
  ]
  for (const c of faqData) {
    insertCMS.run(...c)
  }

  // ── Seed Settings ──
  const insertSetting = db.prepare('INSERT OR IGNORE INTO cms_settings (key, value) VALUES (?, ?)')
  insertSetting.run('site_name', 'FlowTracker')
  insertSetting.run('tagline', 'Uncover the Hidden Moves')
  insertSetting.run('data_last_update', '2026-05-08')

  console.log('✅ Mock data seeded successfully')
}

module.exports = { getDB, initDB }
