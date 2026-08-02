#!/bin/bash
DATES="2026-06-23 2026-06-24 2026-06-25 2026-06-26 2026-06-30"
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

echo "=== BACKFILL FOR NEW TICKERS ==="
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
echo "=== BACKFILL COMPLETE ==="
