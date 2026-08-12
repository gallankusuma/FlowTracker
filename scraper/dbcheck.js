require('dotenv').config();
const m = require('mysql2/promise');
const dbConfig = require('./modules/db_config');
(async () => {
  const c = await m.createConnection(dbConfig.getPoolConfig());

  console.log('=== Table schema ===');
  const [cols] = await c.query('DESCRIBE idx_broker_summary');
  cols.forEach(x => console.log(x.Field, x.Type));

  console.log('\n=== Sample row ===');
  const [sample] = await c.query(
    "SELECT * FROM idx_broker_summary WHERE stock_code='BBCA' AND date='2026-05-22' LIMIT 3"
  );
  sample.forEach(x => console.log(JSON.stringify(x)));

  await c.end();
})().catch(console.error);
