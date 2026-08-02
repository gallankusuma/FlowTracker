#!/usr/bin/env python3
"""Fix detect_swings min candles and check data length for monthly."""
import os
RUNNER = '/var/www/flowtracker-scraper/backtest_runner.py'
with open(RUNNER, 'r') as f:
    rc = f.read()

# 1. Lower detect_swings min from 10 to 5
old = "    if not ohlc or len(ohlc) < 10: return []"
new = "    if not ohlc or len(ohlc) < 5: return []"
if old in rc:
    rc = rc.replace(old, new, 1)
    print("[1] ✅ detect_swings min: 10 -> 5")

# 2. Also check: how much OHLC history is available?
# The DB query fetches WHERE date <= end_date, so we get ALL history
# For monthly backtest we need 12+ months of daily data -> enough for 12+ monthly candles
# But if the DB only has ~7 months of data, monthly will only have ~7 candles
# This is a data limitation, not a code issue
print("[2] ℹ️ Note: Monthly results depend on how much history is in DB")

with open(RUNNER, 'w') as f:
    f.write(rc)

import subprocess
r = subprocess.run(['python3', '-m', 'py_compile', RUNNER], capture_output=True, text=True)
print(f"[PY] {'✅ OK' if r.returncode == 0 else '❌ ' + r.stderr[:200]}")

subprocess.run(['pm2', 'restart', 'flowtracker-scraper'], capture_output=True)

# Re-test
import sys
sys.path.insert(0, '/var/www/flowtracker-scraper')
for m in list(sys.modules.keys()):
    if 'backtest' in m: del sys.modules[m]

from backtest_runner import resample_ohlc, detect_swings, detect_harmonic_patterns, TF_CONFIG
import pymysql
conn = pymysql.connect(host='localhost', port=3306, user='erp_user', password=os.environ.get('DB_PASSWORD'),
                       database='erp_manufacturing', cursorclass=pymysql.cursors.DictCursor)
cur = conn.cursor()

# Get total date range
cur.execute("SELECT MIN(date) as d1, MAX(date) as d2, COUNT(DISTINCT ticker) as n FROM ft_price_ohlc")
info = cur.fetchone()
print(f"\n[3] DB OHLC range: {info['d1']} to {info['d2']} ({info['n']} tickers)")

# Test multiple tickers
for ticker in ['BBRI', 'TLKM', 'BMRI']:
    cur.execute("SELECT date, open_price AS `open`, high_price AS high, low_price AS low, close_price AS close, volume FROM ft_price_ohlc WHERE ticker=%s ORDER BY date ASC", (ticker,))
    rows = cur.fetchall()
    daily = [{'date': str(r['date'])[:10], 'open': float(r['open']), 'high': float(r['high']),
              'low': float(r['low']), 'close': float(r['close']), 'volume': float(r['volume'] or 0)} for r in rows]
    
    for tf in ['1wk', '1mo']:
        cfg = TF_CONFIG.get(tf, {})
        data = resample_ohlc(daily, tf)
        swings = detect_swings(data, cfg.get('swing_threshold', 0.04), 20)
        patterns = detect_harmonic_patterns(data, ticker, {}, data[-1]['date'], 0, cfg) if len(data) >= 5 else []
        if patterns:
            print(f"  ✅ {ticker} {tf}: {len(data)} candles, {len(swings)} swings, {len(patterns)} patterns")
            for p in patterns[:2]:
                print(f"     {p['pattern_type']} {p['direction']} D={p['D_date']}")

conn.close()
print("\nDone!")
