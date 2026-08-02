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

echo "=== Clearing and recalculating with NET-based formula ==="

# Clear auto-calculated data for Jun 18-19 so it recalculates
mysql -u erp_user -p"$DB_PASSWORD" erp_manufacturing -e "DELETE FROM idx_concentration WHERE data_date IN ('2026-06-18','2026-06-19');"
echo "Cleared Jun 18-19 concentration data"

# Recalculate with new net-based formula
for D in 2026-06-18 2026-06-19; do
  echo ""
  echo "--- Recalculating concentration for $D (NET-based) ---"
  curl -s -X POST "${AUTH[@]}" $API/api/calc-concentration -H 'Content-Type: application/json' -d "{\"date\":\"$D\"}"
  echo ""
done

echo ""
echo "=== Verification ==="
# Show sample data to compare
echo "--- Sample BBCA concentration (Jun 19) ---"
mysql -u erp_user -p"$DB_PASSWORD" erp_manufacturing -e "SELECT data_date, stock_code, dn0, dn1, dn2, dn3, dn4 FROM idx_concentration WHERE stock_code='BBCA' AND data_date >= '2026-06-17' ORDER BY data_date;"

echo ""
echo "--- Concentration dates coverage ---"
mysql -u erp_user -p"$DB_PASSWORD" erp_manufacturing -e "SELECT data_date, COUNT(*) AS stocks FROM idx_concentration WHERE data_date >= '2026-06-10' GROUP BY data_date ORDER BY data_date;"
