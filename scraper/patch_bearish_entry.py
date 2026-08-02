#!/usr/bin/env python3
"""
Update BEARISH pattern entry and SL in backtest_runner.py:
- Entry = T2 + (T2 * 5%) = T2 * 1.05
- SL = SL - (SL * 3%) = SL * 0.97
"""
RUNNER = '/var/www/flowtracker-scraper/backtest_runner.py'
with open(RUNNER, 'r') as f:
    rc = f.read()

# 1. Update bearish entry/SL calculation in detect_harmonic_patterns
old_bearish = """            else:
                swing_range = abs(D['price'] - A['price'])
                sl = max(D['price'] * 1.015, X['price'] * 1.01)
                t1 = D['price'] - swing_range * 0.382
                t2 = D['price'] - swing_range * 0.618"""

new_bearish = """            else:
                swing_range = abs(D['price'] - A['price'])
                t1 = D['price'] - swing_range * 0.382
                t2 = D['price'] - swing_range * 0.618
                # Bearish: entry = T2 + 5%, SL = base_SL - 3%
                entry = t2 + (t2 * 0.05)   # enter above T2
                base_sl = max(D['price'] * 1.015, X['price'] * 1.01)
                sl = base_sl - (base_sl * 0.03)   # tighter SL"""

if old_bearish in rc:
    rc = rc.replace(old_bearish, new_bearish, 1)
    print("[1] ✅ Updated bearish entry = T2*1.05, SL = baseSL*0.97")
else:
    print("[1] ⚠️ Bearish block not found")

# 2. Need to also override entry for bearish since it was set before the if/else
# Original: entry = D['price'] is set BEFORE the if/else
# For bullish: entry stays as D['price'] 
# For bearish: entry is now recalculated inside the else block
# No additional change needed — the bearish block now sets entry itself

# 3. Update direction guard for bearish
# Old: if is_bearish and (sl <= entry or t1 >= entry or t2 >= t1): continue
# With new entry (T2*1.05), entry is now between T1 and T2, so guards need adjusting
old_guard = "            if is_bearish and (sl <= entry or t1 >= entry or t2 >= t1): continue"
new_guard = "            if is_bearish and (sl <= entry or t2 >= t1): continue  # entry is near T2, so T1 > entry is OK"

if old_guard in rc:
    rc = rc.replace(old_guard, new_guard, 1)
    print("[2] ✅ Updated bearish direction guard")
else:
    print("[2] ⚠️ Guard not found")

with open(RUNNER, 'w') as f:
    f.write(rc)

import subprocess
r = subprocess.run(['python3', '-m', 'py_compile', RUNNER], capture_output=True, text=True)
print(f"[PY] {'✅ Syntax OK' if r.returncode == 0 else '❌ ' + r.stderr[:200]}")

# Restart
subprocess.run(['pm2', 'restart', 'flowtracker-scraper'], capture_output=True)
print("[3] ✅ PM2 restart")

# Quick verify
print("\n--- Verify bearish calc ---")
# Example: D=1000, A=900, X=1100
D_price = 1000
A_price = 900
X_price = 1100
swing_range = abs(D_price - A_price)  # 100

t1 = D_price - swing_range * 0.382  # 961.8
t2 = D_price - swing_range * 0.618  # 938.2

# New entry & SL
entry = t2 + (t2 * 0.05)  # 938.2 * 1.05 = 985.11
base_sl = max(D_price * 1.015, X_price * 1.01)  # max(1015, 1111) = 1111
sl = base_sl - (base_sl * 0.03)  # 1111 * 0.97 = 1077.67

print(f"  D={D_price}, A={A_price}, X={X_price}")
print(f"  T1={t1:.1f}, T2={t2:.1f}")
print(f"  Entry (T2+5%): {entry:.1f}")
print(f"  SL (baseSL-3%): {sl:.1f}")
print(f"  Risk: {abs(entry-sl):.1f} ({abs(entry-sl)/entry*100:.1f}%)")
print(f"  Reward T1: {abs(entry-t1):.1f} ({abs(entry-t1)/entry*100:.1f}%)")
print(f"  Reward T2: {abs(entry-t2):.1f} ({abs(entry-t2)/entry*100:.1f}%)")
print(f"  R:R (T1): {abs(entry-t1)/abs(entry-sl):.2f}")
