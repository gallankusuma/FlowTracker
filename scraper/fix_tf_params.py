#!/usr/bin/env python3
"""
Fix weekly/monthly to actually produce results:
1. Lower MIN_OHLC_BARS for weekly/monthly (from 15 to 8 for monthly)
2. Adjust monthly swing threshold (0.08 -> 0.05) 
3. For monthly, need at least 12 months of data -> lower max_d_age to include more
"""
import os
RUNNER = '/var/www/flowtracker-scraper/backtest_runner.py'
with open(RUNNER, 'r') as f:
    rc = f.read()

# 1. Fix TF_CONFIG — relax monthly settings
old_mo = "    '1mo': { 'max_d_age': 2,  'swing_threshold': 0.08, 'max_pattern_span': 30,  'swing_left': 3, 'swing_right': 2 },"
new_mo = "    '1mo': { 'max_d_age': 3,  'swing_threshold': 0.05, 'max_pattern_span': 24,  'swing_left': 2, 'swing_right': 1 },"

if old_mo in rc:
    rc = rc.replace(old_mo, new_mo, 1)
    print("[1] ✅ Relaxed monthly TF_CONFIG (threshold 0.08->0.05, swing 3/2->2/1)")
else:
    print("[1] ⚠️ Monthly config not found")

# 2. Also relax weekly a bit
old_wk = "    '1wk': { 'max_d_age': 3,  'swing_threshold': 0.06, 'max_pattern_span': 40,  'swing_left': 4, 'swing_right': 2 },"
new_wk = "    '1wk': { 'max_d_age': 4,  'swing_threshold': 0.05, 'max_pattern_span': 40,  'swing_left': 3, 'swing_right': 2 },"

if old_wk in rc:
    rc = rc.replace(old_wk, new_wk, 1)
    print("[2] ✅ Relaxed weekly TF_CONFIG (threshold 0.06->0.05, d_age 3->4)")
else:
    print("[2] ⚠️ Weekly config not found")

# 3. Lower min_bars for monthly — 8 candles should be enough to try
old_min = "            min_bars = 15 if interval != '1d' else MIN_OHLC_BARS"
new_min = "            min_bars = 6 if interval == '1mo' else (12 if interval == '1wk' else MIN_OHLC_BARS)"
if old_min in rc:
    rc = rc.replace(old_min, new_min, 1)
    print("[3] ✅ Updated min_bars: daily=60, weekly=12, monthly=6")
else:
    print("[3] ⚠️ min_bars not found")

with open(RUNNER, 'w') as f:
    f.write(rc)

import subprocess
r = subprocess.run(['python3', '-m', 'py_compile', RUNNER], capture_output=True, text=True)
print(f"[PY] {'✅ Syntax OK' if r.returncode == 0 else '❌ ' + r.stderr[:200]}")

# Restart
subprocess.run(['pm2', 'restart', 'flowtracker-scraper'], capture_output=True)
print("[4] ✅ PM2 restart")

# Re-test
print("\n--- Re-test ---")
import sys
sys.path.insert(0, '/var/www/flowtracker-scraper')
# Force reimport
for mod_name in list(sys.modules.keys()):
    if 'backtest' in mod_name:
        del sys.modules[mod_name]

from backtest_runner import resample_ohlc, detect_swings, detect_harmonic_patterns, TF_CONFIG
import pymysql

DB_CFG = dict(host='localhost', port=3306, user='erp_user', password=os.environ.get('DB_PASSWORD'),
              database='erp_manufacturing', cursorclass=pymysql.cursors.DictCursor)
conn = pymysql.connect(**DB_CFG)
cur = conn.cursor()
cur.execute("SELECT ticker, date, open_price AS `open`, high_price AS high, low_price AS low, close_price AS close, volume FROM ft_price_ohlc WHERE ticker='BBRI' ORDER BY date ASC")
rows = cur.fetchall()
conn.close()

daily = [{'date': str(r['date'])[:10], 'open': float(r['open']), 'high': float(r['high']),
          'low': float(r['low']), 'close': float(r['close']), 'volume': float(r['volume'] or 0)} for r in rows]

for tf in ['1wk', '1mo']:
    cfg = TF_CONFIG.get(tf, {})
    data = resample_ohlc(daily, tf)
    swings = detect_swings(data, cfg.get('swing_threshold', 0.04), 20)
    patterns = detect_harmonic_patterns(data, 'BBRI', {}, data[-1]['date'], 0, cfg) if len(data) >= 6 else []
    print(f"  {tf}: {len(data)} candles, {len(swings)} swings, {len(patterns)} patterns")
    for p in patterns[:2]:
        print(f"    {p['pattern_type']} {p['direction']} D={p['D_date']} score={p.get('conviction_score','?')}")
