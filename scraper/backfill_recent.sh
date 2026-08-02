#!/bin/bash
DATES="2026-06-23 2026-06-24 2026-06-25 2026-06-26 2026-06-30"
API="http://127.0.0.1:3100"

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
