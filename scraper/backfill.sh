#!/bin/bash
DB_PASSWORD="${DB_PASSWORD:?DB_PASSWORD environment variable must be set}"
DATES="2026-06-13 2026-06-16 2026-06-17 2026-06-18 2026-06-19"
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

echo "=== BACKFILL START ==="
for D in $DATES; do
  echo ""
  echo "--- Triggering cron for $D ---"
  # Wait for previous cron to finish
  while true; do
    RUNNING=$(curl -s $API/api/cron/status 2>/dev/null | grep -o '"running":true' | wc -l)
    if [ "$RUNNING" = "0" ]; then break; fi
    echo "  Waiting for previous cron to finish..."
    sleep 10
  done
  curl -s -X POST $API/api/cron/run -H 'Content-Type: application/json' -d "{\"date\":\"$D\"}"
  echo ""
  sleep 5
done

echo ""
echo "--- Waiting for last cron to complete... ---"
while true; do
  RUNNING=$(curl -s $API/api/cron/status 2>/dev/null | grep -o '"running":true' | wc -l)
  if [ "$RUNNING" = "0" ]; then break; fi
  echo "  Still running..."
  sleep 15
done

echo ""
echo "--- Triggering FT.id concentration pull for today ---"
curl -s -X POST "${AUTH[@]}" $API/api/ft-pull -H 'Content-Type: application/json' -d '{"date":"2026-06-20"}'
echo ""

echo ""
echo "=== BACKFILL COMPLETE ==="
echo ""
echo "--- Final data status ---"
mysql -u erp_user -p"$DB_PASSWORD" erp_manufacturing -e "SELECT MAX(date) AS broker_latest FROM idx_broker_summary;"
mysql -u erp_user -p"$DB_PASSWORD" erp_manufacturing -e "SELECT MAX(data_date) AS conc_latest FROM idx_concentration;"
mysql -u erp_user -p"$DB_PASSWORD" erp_manufacturing -e "SELECT MAX(date) AS price_latest FROM idx_stock_prices;"
echo ""
echo "--- Row counts for backfilled dates ---"
mysql -u erp_user -p"$DB_PASSWORD" erp_manufacturing -e "SELECT date, COUNT(*) AS records FROM idx_broker_summary WHERE date >= '2026-06-13' GROUP BY date ORDER BY date;"
