#!/usr/bin/env python3
"""Fix the broken argv section in backtest_runner.py"""
RUNNER = '/var/www/flowtracker-scraper/backtest_runner.py'
with open(RUNNER, 'r') as f:
    rc = f.read()

old = """    min_score  = int(sys.argv[4]
market = sys.argv[5] if len(sys.argv) > 5 else 'IDX') if len(sys.argv) > 4 else DEFAULT_MIN_SCORE"""

new = """    min_score  = int(sys.argv[4]) if len(sys.argv) > 4 else DEFAULT_MIN_SCORE
    market = sys.argv[5] if len(sys.argv) > 5 else 'IDX'"""

if old in rc:
    rc = rc.replace(old, new)
    with open(RUNNER, 'w') as f:
        f.write(rc)
    print("[1] Fixed argv syntax")
else:
    print("[1] SKIP: pattern not found")
    # Try alternate
    import re
    m = re.search(r"min_score.*sys\.argv\[4\].*market.*sys\.argv\[5\].*DEFAULT_MIN_SCORE", rc, re.DOTALL)
    if m:
        rc = rc.replace(m.group(), new.lstrip())
        with open(RUNNER, 'w') as f:
            f.write(rc)
        print("[1b] Fixed via regex")

# Verify
import subprocess
r = subprocess.run(['python3', '-m', 'py_compile', RUNNER], capture_output=True, text=True)
if r.returncode == 0:
    print("[2] ✅ Python syntax OK")
else:
    print(f"[2] ❌ {r.stderr}")
