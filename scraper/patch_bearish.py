#!/usr/bin/env python3
"""
Fix bearish pattern calculations:
1. SL for bearish must be ABOVE D (not above X)
2. Add 'action' field: BUY for bullish, SELL/AVOID for bearish
3. Fix display labels in frontend
"""

# ── PART 1: Fix harmonicEngine.js bearish SL ──
ENGINE = '/var/www/flowtracker-scraper/harmonicEngine.js'
with open(ENGINE, 'r') as f:
    ec = f.read()

# Fix stop loss calculation
old_sl = """      // Stop loss beyond X
      const stop_loss = direction === 'BULLISH'
        ? Math.round(X.price * 0.97)
        : Math.round(X.price * 1.03);"""

new_sl = """      // Stop loss: Bullish = below lowest of X,D; Bearish = above highest of X,D
      const stop_loss = direction === 'BULLISH'
        ? Math.round(Math.min(X.price, D.price) * 0.97)
        : Math.round(Math.max(X.price, D.price) * 1.03);"""

if old_sl in ec:
    ec = ec.replace(old_sl, new_sl, 1)
    print("[E1] Fixed bearish SL: now above max(X,D)")
else:
    print("[E1] SKIP")

# Fix targets to be more intuitive
# For bullish: T1,T2 = above D (go up to B, then C area)  
# For bearish: T1,T2 = below D (drop to B, then C area)
# Current targets using AD retracement are OK for direction
# But let's add entry_action field

old_push = """      results.push({
        ticker,
        pattern_type: patName,
        direction,"""

new_push = """      results.push({
        ticker,
        pattern_type: patName,
        direction,
        action: direction === 'BULLISH' ? 'BUY' : 'SELL/AVOID',"""

if old_push in ec:
    ec = ec.replace(old_push, new_push, 1)
    print("[E2] Added action field (BUY / SELL/AVOID)")
else:
    print("[E2] SKIP")

# Fix risk_reward: ensure it makes sense for both directions
old_rr = """      // Risk:Reward
      const risk = Math.abs(entry_price - stop_loss) || 1;
      const reward = Math.abs(target_1 - entry_price);
      const risk_reward = Math.round((reward / risk) * 10) / 10;"""

new_rr = """      // Risk:Reward (always positive ratio)
      const risk = Math.abs(entry_price - stop_loss) || 1;
      const reward = Math.abs(target_1 - entry_price);
      const risk_reward = Math.round((reward / risk) * 10) / 10;

      // Sanity check: for bearish, SL must be > entry; for bullish, SL must be < entry
      if (direction === 'BULLISH' && stop_loss >= entry_price) continue;
      if (direction === 'BEARISH' && stop_loss <= entry_price) continue;"""

if old_rr in ec:
    ec = ec.replace(old_rr, new_rr, 1)
    print("[E3] Added SL sanity check")
else:
    print("[E3] SKIP")

# Also fix ABCD bearish SL
old_abcd_sl = """    const stop_loss = direction === 'BULLISH'
      ? Math.round(sD.price * 0.97)
      : Math.round(sD.price * 1.03);"""

new_abcd_sl = """    const stop_loss = direction === 'BULLISH'
      ? Math.round(Math.min(sA.price, sD.price) * 0.97)
      : Math.round(Math.max(sA.price, sD.price) * 1.03);"""

if old_abcd_sl in ec:
    ec = ec.replace(old_abcd_sl, new_abcd_sl, 1)
    print("[E4] Fixed ABCD bearish SL")
else:
    print("[E4] SKIP")

with open(ENGINE, 'w') as f:
    f.write(ec)

# ── PART 2: Fix frontend display for bearish ──
PAGE = '/var/www/flowtracker/app/signal-scanner/page.tsx'
with open(PAGE, 'r') as f:
    pc = f.read()

# Find the entry/SL/T1/T2 display section and make labels direction-aware
# Look for the display labels
import re

# Fix entry label
old_entry_label = '>Entry<'
new_entry_label_check = ">{p.direction === 'BEARISH' ? 'Sell Zone' : 'Entry'}<"
# This might be tricky in TSX, let me search for the exact pattern
entry_matches = re.findall(r'>\s*Entry\s*<', pc)
print(f"[F] Found {len(entry_matches)} 'Entry' labels in page.tsx")

# Let's look for the card info display
sl_matches = re.findall(r'>\s*SL\s*<', pc)
t1_matches = re.findall(r'>\s*T1\s*<', pc)
print(f"[F] Found {len(sl_matches)} 'SL' labels, {len(t1_matches)} 'T1' labels")

# Instead of complex regex, let's add a helper note for bearish patterns
# Find where direction badge is displayed and add a tooltip/note

# Look for the bearish/bullish badge rendering
bearish_badge = pc.find("BEARISH")
print(f"[F] BEARISH found at position {bearish_badge}")

# Add a note below the entry/SL section for bearish patterns
# Find pattern: something like <div>Entry</div> ... numbers
# Let's search for the info row
info_search = re.search(r"(Entry.*?SL.*?T1.*?T2)", pc[:5000] if len(pc) > 5000 else pc, re.DOTALL)
if info_search:
    print(f"[F] Found info row pattern")
else:
    print(f"[F] Info row not found in first 5000 chars, searching wider...")

# Add a simple bearish explanation div after the pattern cards
# Find the action/direction display and add context
old_direction_display = "direction === 'BULLISH' ? '▲ BULLISH' : '▼ BEARISH'"
if old_direction_display in pc:
    new_direction_display = "direction === 'BULLISH' ? '▲ BUY Signal' : '▼ SELL/Avoid'"
    pc = pc.replace(old_direction_display, new_direction_display, 1)
    print("[F1] Updated direction label: BUY Signal / SELL-Avoid")
else:
    # Try other patterns
    found = False
    for pattern in ["'▲ BULLISH'", "'BULLISH'", '"BULLISH"', "BULLISH"]:
        if f"? {pattern}" in pc or f"? '{pattern}'" in pc:
            print(f"[F1] Found direction pattern: {pattern}")
            found = True
            break
    if not found:
        print("[F1] SKIP: direction display not found")

with open(PAGE, 'w') as f:
    f.write(pc)

print("\nDone!")
