require('dotenv').config();
const mysql = require('mysql2/promise');

const DB = {
  host: 'localhost',
  user: 'erp_user',
  password: process.env.DB_PASSWORD,
  database: 'erp_manufacturing'
};

async function run() {
  try {
    const pool = mysql.createPool(DB);

    // 1. Fix corrupted rows (closed_date IS NULL but status != 'OPEN')
    const [rows] = await pool.query(
      `SELECT id, ticker, direction, entry_min, entry_max, stop_loss, target_1, target_2, status, created_at 
       FROM ft_recommendations 
       WHERE status IN ('HIT_T1', 'HIT_T2', 'STOPPED', 'WIN', 'LOSS') AND (result_pct IS NULL OR closed_price IS NULL)`
    );

    let updated = 0;
    for (const rec of rows) {
      const entry = (Number(rec.entry_min) + Number(rec.entry_max)) / 2;
      let result_pct = 0, price = 0;

      if (rec.direction === 'BULLISH') {
        if (rec.status === 'HIT_T2') { price = rec.target_2; result_pct = ((rec.target_2 - entry) / entry * 100); }
        else if (rec.status === 'HIT_T1') { price = rec.target_1; result_pct = ((rec.target_1 - entry) / entry * 100); }
        else if (rec.status === 'STOPPED') { price = rec.stop_loss; result_pct = ((rec.stop_loss - entry) / entry * 100); }
      } else {
        if (rec.status === 'HIT_T2') { price = rec.target_2; result_pct = ((entry - rec.target_2) / entry * 100); }
        else if (rec.status === 'HIT_T1') { price = rec.target_1; result_pct = ((entry - rec.target_1) / entry * 100); }
        else if (rec.status === 'STOPPED') { price = rec.stop_loss; result_pct = ((entry - rec.stop_loss) / entry * 100); }
      }

      await pool.query(
        `UPDATE ft_recommendations SET result_pct=?, closed_price=?, closed_date=DATE(created_at) WHERE id=?`,
        [result_pct.toFixed(2), price, rec.id]
      );
      updated++;
    }
    console.log(`Fixed ${updated} corrupted rows.`);

    const [sgro] = await pool.query(`SELECT id, ticker, status, entry_min, created_at FROM ft_recommendations WHERE ticker='SGRO' ORDER BY id DESC`);
    console.log("SGRO rows in DB:");
    console.table(sgro);

    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
run();
