#!/bin/bash
DB_PASSWORD="${DB_PASSWORD:?DB_PASSWORD environment variable must be set}"
API='http://127.0.0.1:3100'

echo '=== FlowTracker Data Backfill ==='
echo "Start: $(date)"
echo ""

# Missing weekdays: Jun 13, 16, 20, 23, 24, 25, 26, 27, 30
for D in 2026-06-13 2026-06-16 2026-06-20 2026-06-23 2026-06-24 2026-06-25 2026-06-26 2026-06-27 2026-06-30; do
  # Check if data already exists
  EXISTING=$(mysql -u erp_user -p"$DB_PASSWORD" erp_manufacturing -Nse "SELECT COUNT(*) FROM idx_broker_summary WHERE date='$D'" 2>/dev/null)
  if [ "$EXISTING" -gt "100" ] 2>/dev/null; then
    echo "⏭️  $D already has $EXISTING records, skipping"
    continue
  fi
  
  echo ""
  echo "📡 Pulling broker data for $D ..."
  RESULT=$(curl -s -X POST "$API/api/cron/run" \
    -H 'Content-Type: application/json' \
    -d "{\"date\":\"$D\"}" 2>/dev/null)
  echo "  Response: $(echo $RESULT | head -c 200)"

  # Wait for cron to finish (max 5 min per date)
  sleep 3
  for i in $(seq 1 60); do
    STATUS=$(curl -s "$API/api/cron/status" 2>/dev/null)
    RUNNING=$(echo "$STATUS" | grep -o '"running":true')
    if [ -z "$RUNNING" ]; then
      echo "  ✅ Cron finished for $D"
      break
    fi
    sleep 5
  done

  echo "  📊 Calculating concentration for $D..."
  curl -s -X POST "$API/api/calc-concentration" \
    -H 'Content-Type: application/json' \
    -d "{\"date\":\"$D\"}" 2>/dev/null | head -c 200
  echo ""
done

echo ""
echo "=== Final Data Status ==="
mysql -u erp_user -p"$DB_PASSWORD" erp_manufacturing \
  -e 'SELECT date, COUNT(*) AS records FROM idx_broker_summary WHERE date >= "2026-06-12" GROUP BY date ORDER BY date;' 2>/dev/null

echo ""
mysql -u erp_user -p"$DB_PASSWORD" erp_manufacturing \
  -e 'SELECT data_date, COUNT(*) AS stocks FROM idx_concentration WHERE data_date >= "2026-06-12" GROUP BY data_date ORDER BY data_date;' 2>/dev/null

echo ""
echo "=== Backfill complete at $(date) ==="
