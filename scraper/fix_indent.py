#!/usr/bin/env python3
"""Fix indentation in fetch_yahoo_ohlc"""
RUNNER = '/var/www/flowtracker-scraper/backtest_runner.py'
with open(RUNNER, 'r') as f:
    rc = f.read()

old = """    # Need more history for weekly/monthly backtests
        extra_days = 730 if interval == '1mo' else 500 if interval == '1wk' else 365
        start_dt = datetime.strptime(start_date, '%Y-%m-%d') - timedelta(days=extra_days)"""

new = """    # Need more history for weekly/monthly backtests
    extra_days = 730 if interval == '1mo' else 500 if interval == '1wk' else 365
    start_dt = datetime.strptime(start_date, '%Y-%m-%d') - timedelta(days=extra_days)"""

if old in rc:
    rc = rc.replace(old, new, 1)
    with open(RUNNER, 'w') as f:
        f.write(rc)
    print("[1] ✅ Fixed indentation")
else:
    print("[1] ⚠️ Not found")

import subprocess
r = subprocess.run(['python3', '-m', 'py_compile', RUNNER], capture_output=True, text=True)
print(f"[PY] {'✅ Syntax OK' if r.returncode == 0 else '❌ ' + r.stderr[:200]}")
