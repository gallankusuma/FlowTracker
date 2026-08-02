#!/usr/bin/env python3
"""Fix escaped triple quotes in backtest_runner.py"""
RUNNER = '/var/www/flowtracker-scraper/backtest_runner.py'
with open(RUNNER, 'r') as f:
    rc = f.read()

# Replace escaped triple quotes with real ones
rc = rc.replace('\\"\\"\\"\n            SELECT ticker', '"""\n            SELECT ticker')
rc = rc.replace('\\"\\"\\", (end_date,))', '""", (end_date,))')

with open(RUNNER, 'w') as f:
    f.write(rc)

# Verify
import subprocess
r = subprocess.run(['python3', '-m', 'py_compile', RUNNER], capture_output=True, text=True)
if r.returncode == 0:
    print("✅ Python syntax OK!")
else:
    print(f"❌ Still broken: {r.stderr}")
    # Show the problematic area
    with open(RUNNER, 'r') as f:
        lines = f.readlines()
    for i, line in enumerate(lines, 1):
        if '\\' in line and i > 530 and i < 560:
            print(f"  Line {i}: {line.rstrip()}")
