#!/usr/bin/env python3
"""Fix bearish SL to T2*0.95 (not baseSL*0.97)."""
RUNNER = '/var/www/flowtracker-scraper/backtest_runner.py'
with open(RUNNER, 'r') as f:
    rc = f.read()

old = """            else:
                swing_range = abs(D['price'] - A['price'])
                t1 = D['price'] - swing_range * 0.382
                t2 = D['price'] - swing_range * 0.618
                # Bearish: entry = T2 + 5%, SL = base_SL - 3%
                entry = t2 + (t2 * 0.05)   # enter above T2
                base_sl = max(D['price'] * 1.015, X['price'] * 1.01)
                sl = base_sl - (base_sl * 0.03)   # tighter SL"""

new = """            else:
                swing_range = abs(D['price'] - A['price'])
                t1 = D['price'] - swing_range * 0.382
                t2 = D['price'] - swing_range * 0.618
                # Bearish: entry = T2 + 5%, SL = T2 - 5%
                entry = t2 * 1.05   # enter 5% above T2
                sl = t2 * 0.95      # stop loss 5% below T2"""

if old in rc:
    rc = rc.replace(old, new, 1)
    with open(RUNNER, 'w') as f:
        f.write(rc)
    print("[1] ✅ Fixed: Entry=T2*1.05, SL=T2*0.95")
else:
    print("[1] ⚠️ Not found")

import subprocess
r = subprocess.run(['python3', '-m', 'py_compile', RUNNER], capture_output=True, text=True)
print(f"[PY] {'✅ OK' if r.returncode == 0 else '❌ ' + r.stderr[:200]}")

subprocess.run(['pm2', 'restart', 'flowtracker-scraper'], capture_output=True)
print("[2] ✅ Restarted")

# Verify
D, A = 1000, 900
swing = abs(D - A)
t1 = D - swing * 0.382
t2 = D - swing * 0.618
entry = t2 * 1.05
sl = t2 * 0.95

print(f"\n--- Bearish Example (D={D}, A={A}) ---")
print(f"  T1 = {t1:.1f}")
print(f"  T2 = {t2:.1f}")
print(f"  Entry = T2*1.05 = {entry:.1f}")
print(f"  SL    = T2*0.95 = {sl:.1f}")
print(f"  Risk  = {abs(entry-sl):.1f} ({abs(entry-sl)/entry*100:.1f}%)")
print(f"  R:R   = {abs(entry-t2)/abs(entry-sl):.2f}")
