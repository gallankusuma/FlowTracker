#!/usr/bin/env python3
"""Patch backtest_runner.py to bypass MIN_RR filter for BEARISH patterns."""
RUNNER = '/var/www/flowtracker-scraper/backtest_runner.py'
with open(RUNNER, 'r') as f:
    rc = f.read()

old_rr = """            risk = abs(entry - sl); reward = abs(t1 - entry)
            rr = round(reward / risk, 2) if risk > 0 else 0
            # For bearish with custom entry (T2*1.05), use D-point as reward target
            if is_bearish:
                reward_bear = abs(D['price'] - entry)  # potential bounce to D
                rr = round(reward_bear / risk, 2) if risk > 0 else 0
            if rr < MIN_RR: continue"""

new_rr = """            risk = abs(entry - sl); reward = abs(t1 - entry)
            rr = round(reward / risk, 2) if risk > 0 else 0
            # For bearish with custom entry (T2*1.05), use D-point as reward target
            if is_bearish:
                reward_bear = abs(D['price'] - entry)  # potential bounce to D
                rr = round(reward_bear / risk, 2) if risk > 0 else 0
                # Bypass MIN_RR for bearish because the static 5% buffer often creates R:R < 1.0
                if rr < 0.1: continue # Just a tiny sanity check
            else:
                if rr < MIN_RR: continue"""

if old_rr in rc:
    rc = rc.replace(old_rr, new_rr, 1)
    with open(RUNNER, 'w') as f:
        f.write(rc)
    print("[1] ✅ Patched MIN_RR filter for BEARISH")
else:
    print("[1] ⚠️ RR block not found")

import subprocess
r = subprocess.run(['python3', '-m', 'py_compile', RUNNER], capture_output=True, text=True)
print(f"[PY] {'✅ Syntax OK' if r.returncode == 0 else '❌ ' + r.stderr[:200]}")

subprocess.run(['pm2', 'restart', 'flowtracker-scraper'], capture_output=True)
print("[2] ✅ PM2 restarted")
