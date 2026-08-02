#!/bin/bash
DB_PASSWORD="${DB_PASSWORD:?DB_PASSWORD environment variable must be set}"
API="http://127.0.0.1:3100"

echo "=== Auto-calculating concentration for missing dates ==="

for D in 2026-06-18 2026-06-19; do
  echo ""
  echo "--- Calculating concentration for $D ---"
  curl -s -X POST $API/api/calc-concentration -H 'Content-Type: application/json' -d "{\"date\":\"$D\"}"
  echo ""
done

echo ""
echo "=== Done! Checking final status ==="
mysql -u erp_user -p"$DB_PASSWORD" erp_manufacturing -e "SELECT data_date, COUNT(*) AS stocks FROM idx_concentration WHERE data_date >= CAST(20260610 AS DATE) GROUP BY data_date ORDER BY data_date;"
