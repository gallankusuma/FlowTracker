#!/bin/bash
DB_PASSWORD="${DB_PASSWORD:?DB_PASSWORD environment variable must be set}"
API="http://127.0.0.1:3100"

# Admin endpoints now require a key (2026-08-02). Port 3100 is bound to
# 0.0.0.0 with no firewall, so every unauthenticated route was reachable from
# the public internet. Sourced from .env when not already exported, the same
# way DB_PASSWORD is supplied.
if [ -z "${ADMIN_API_KEY:-}" ] && [ -f "$(dirname "$0")/.env" ]; then
  ADMIN_API_KEY=$(grep -E '^ADMIN_API_KEY=' "$(dirname "$0")/.env" | head -1 | cut -d= -f2- | tr -d '"'"'"'"')
fi
ADMIN_API_KEY="${ADMIN_API_KEY:?ADMIN_API_KEY must be set or present in .env}"
AUTH=(-H "x-admin-key: $ADMIN_API_KEY")

echo "=== Auto-calculating concentration for missing dates ==="

for D in 2026-06-18 2026-06-19; do
  echo ""
  echo "--- Calculating concentration for $D ---"
  curl -s -X POST "${AUTH[@]}" $API/api/calc-concentration -H 'Content-Type: application/json' -d "{\"date\":\"$D\"}"
  echo ""
done

echo ""
echo "=== Done! Checking final status ==="
mysql -u erp_user -p"$DB_PASSWORD" erp_manufacturing -e "SELECT data_date, COUNT(*) AS stocks FROM idx_concentration WHERE data_date >= CAST(20260610 AS DATE) GROUP BY data_date ORDER BY data_date;"
