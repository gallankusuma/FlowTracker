#!/bin/bash
# DB_USER/DB_NAME default to the pre-flowtracker_app-cutover values only as a
# fallback for convenience — the real source of truth is scraper/.env
# (see modules/db_config.js, DB_ROTATION.md). Pass them via env if different.
DB_USER="${DB_USER:-erp_user}"
DB_NAME="${DB_NAME:-erp_manufacturing}"
DB_PASSWORD="${DB_PASSWORD:?DB_PASSWORD environment variable must be set}"
mysql -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" 2>/dev/null <<'EOF'
SELECT 
  date,
  COUNT(*) as rows,
  ROUND(SUM(buy_val)/1e9, 1) as buy_B,
  ROUND(SUM(sell_val)/1e9, 1) as sell_B,
  ROUND(SUM(buy_val+sell_val)/1e9, 1) as total_B,
  COUNT(DISTINCT broker_code) as brokers
FROM idx_broker_summary 
WHERE stock_code='BBCA' 
GROUP BY date 
ORDER BY date DESC 
LIMIT 5;

SELECT 'ALL STOCKS latest date' as info;
SELECT 
  stock_code,
  ROUND(SUM(buy_val+sell_val)/1e9,1) as total_B,
  COUNT(*) as rows
FROM idx_broker_summary 
WHERE date = (SELECT MAX(date) FROM idx_broker_summary)
GROUP BY stock_code 
ORDER BY total_B DESC 
LIMIT 10;
EOF
