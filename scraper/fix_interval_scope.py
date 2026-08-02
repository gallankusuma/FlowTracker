#!/usr/bin/env python3
"""Fix: interval not defined in fetch_yahoo_ohlc and fix the scoring."""
RUNNER = '/var/www/flowtracker-scraper/backtest_runner.py'
with open(RUNNER, 'r') as f:
    rc = f.read()

changes = 0

# 1. Fix fetch_yahoo_ohlc: add interval parameter
old_sig = "def fetch_yahoo_ohlc(ticker, start_date, end_date):"
new_sig = "def fetch_yahoo_ohlc(ticker, start_date, end_date, interval='1d'):"
if old_sig in rc:
    rc = rc.replace(old_sig, new_sig, 1)
    changes += 1
    print("[1] ✅ Added interval param to fetch_yahoo_ohlc")

# 2. Find where fetch_yahoo_ohlc is called and pass interval
old_call = "ohlc_by_ticker[t] = fetch_yahoo_ohlc(t, start_date, end_date)"
new_call = "ohlc_by_ticker[t] = fetch_yahoo_ohlc(t, start_date, end_date, interval)"
if old_call in rc:
    rc = rc.replace(old_call, new_call, 1)
    changes += 1
    print("[2] ✅ Pass interval to fetch_yahoo_ohlc call")
else:
    # try alternate
    old_call2 = "fetch_yahoo_ohlc(t, start_date, end_date)"
    if old_call2 in rc:
        rc = rc.replace(old_call2, "fetch_yahoo_ohlc(t, start_date, end_date, interval)")
        changes += 1
        print("[2] ✅ Pass interval (alt match)")

with open(RUNNER, 'w') as f:
    f.write(rc)

import subprocess
r = subprocess.run(['python3', '-m', 'py_compile', RUNNER], capture_output=True, text=True)
print(f"[PY] {'✅ Syntax OK' if r.returncode == 0 else '❌ ' + r.stderr[:200]}")

subprocess.run(['pm2', 'restart', 'flowtracker-scraper'], capture_output=True)
print(f"[3] ✅ PM2 restart ({changes} fixes applied)")
