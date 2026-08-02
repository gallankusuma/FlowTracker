#!/usr/bin/env python3
"""Fix resample_ohlc to return sorted results and restart scraper."""
RUNNER = '/var/www/flowtracker-scraper/backtest_runner.py'
with open(RUNNER, 'r') as f:
    rc = f.read()

old_return = "    return [v for v in buckets.values()]"
new_return = "    return sorted(buckets.values(), key=lambda x: x['date'])"

if old_return in rc:
    rc = rc.replace(old_return, new_return, 1)
    with open(RUNNER, 'w') as f:
        f.write(rc)
    print("[1] ✅ Fixed resample_ohlc to sort by date")
else:
    print("[1] ⚠️ return statement not found")

import subprocess
r = subprocess.run(['python3', '-m', 'py_compile', RUNNER], capture_output=True, text=True)
print(f"[PY] {'✅ Syntax OK' if r.returncode == 0 else '❌ ' + r.stderr[:200]}")

# Restart scraper
subprocess.run(['pm2', 'restart', 'flowtracker-scraper'], capture_output=True)
print("[2] ✅ PM2 restart")

# Quick test: run a mini backtest with weekly to verify it works
print("\n[3] Quick test: Weekly resample on 1 ticker...")
# Import the function
import sys
sys.path.insert(0, '/var/www/flowtracker-scraper')
try:
    from backtest_runner import resample_ohlc
    # Fake 30 days of daily data
    from datetime import datetime, timedelta
    fake_ohlc = []
    base = datetime(2026, 5, 1)
    for i in range(60):
        d = base + timedelta(days=i)
        if d.weekday() < 5:  # skip weekends
            fake_ohlc.append({
                'date': d.strftime('%Y-%m-%d'),
                'open': 100 + i*0.5,
                'high': 102 + i*0.5,
                'low': 98 + i*0.5,
                'close': 101 + i*0.5,
                'volume': 1000000
            })
    
    weekly = resample_ohlc(fake_ohlc, '1wk')
    monthly = resample_ohlc(fake_ohlc, '1mo')
    
    print(f"   Daily: {len(fake_ohlc)} candles")
    print(f"   Weekly: {len(weekly)} candles")
    print(f"   Monthly: {len(monthly)} candles")
    print(f"   Weekly dates: {[w['date'] for w in weekly[:5]]}...")
    print(f"   Monthly dates: {[m['date'] for m in monthly]}")
    print("   ✅ Resampling works!")
except Exception as e:
    print(f"   ❌ Error: {e}")
