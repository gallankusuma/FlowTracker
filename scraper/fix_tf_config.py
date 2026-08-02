#!/usr/bin/env python3
"""Add TF_CONFIG to backtest_runner.py constants"""
RUNNER = '/var/www/flowtracker-scraper/backtest_runner.py'
with open(RUNNER, 'r') as f:
    rc = f.read()

old = "DEFAULT_MIN_SCORE  = 60   # minimum confluence score to keep a signal"
new = """DEFAULT_MIN_SCORE  = 60   # minimum confluence score to keep a signal

# Timeframe-specific config (matching live scanner TF_CONFIG)
TF_CONFIG = {
    '1d':  { 'max_d_age': 5,  'swing_threshold': 0.04, 'max_pattern_span': 60,  'swing_left': 5, 'swing_right': 3 },
    '1wk': { 'max_d_age': 3,  'swing_threshold': 0.06, 'max_pattern_span': 40,  'swing_left': 4, 'swing_right': 2 },
    '1mo': { 'max_d_age': 2,  'swing_threshold': 0.08, 'max_pattern_span': 30,  'swing_left': 3, 'swing_right': 2 },
}"""

if old in rc:
    rc = rc.replace(old, new, 1)
    with open(RUNNER, 'w') as f:
        f.write(rc)
    print("✅ Added TF_CONFIG")
else:
    print("⚠️ Not found")

import subprocess
r = subprocess.run(['python3', '-m', 'py_compile', RUNNER], capture_output=True, text=True)
print(f"Syntax: {'✅ OK' if r.returncode == 0 else '❌ ' + r.stderr[:200]}")
