require('dotenv').config();
const mysql = require('mysql2/promise');
const DB = { host: 'localhost', user: 'erp_user', password: process.env.DB_PASSWORD, database: 'erp_manufacturing' };
async function run() {
  try {
    const pool = mysql.createPool(DB);
    const [rows] = await pool.query("SELECT id, ticker, status, created_at FROM ft_recommendations WHERE ticker='BSSR' ORDER BY id DESC LIMIT 5");
    console.table(rows);
    process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
}
run();
