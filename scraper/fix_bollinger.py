#!/usr/bin/env python3
"""Fix BollingerSparkline overflow issue."""
FILE = '/var/www/flowtracker/app/signal-scanner/page.tsx'

with open(FILE, 'r') as f:
    content = f.read()

# Fix 1: BollingerSparkline container - add width constraint and overflow hidden
old = '''<div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <svg width={W} height={H + 16} viewBox={`0 0 ${W} ${H + 16}`} style={{ overflow: "visible" }}>'''
new = '''<div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 160, maxWidth: 160, overflow: "hidden", flexShrink: 0 }}>
      <svg width={W} height={H + 16} viewBox={`0 0 ${W} ${H + 16}`}>'''

if old in content:
    content = content.replace(old, new, 1)
    print("[1] Fixed BollingerSparkline container overflow")
else:
    # Try alternate: maybe already partially fixed
    old2 = 'style={{ overflow: "visible" }}>'
    # Only fix line 472 (BollingerSparkline SVG)
    lines = content.split('\n')
    fixed = False
    for i in range(len(lines)):
        if 'BollingerSparkline' in lines[max(0,i-30):i+1].__repr__() or (i >= 468 and i <= 475):
            if 'overflow: "visible"' in lines[i]:
                lines[i] = lines[i].replace('overflow: "visible"', 'overflow: "hidden"')
                fixed = True
                print(f"[1] Fixed overflow on line {i+1}")
                break
    if not fixed:
        print("[1] SKIP: BollingerSparkline overflow pattern not found")
    else:
        content = '\n'.join(lines)

# Fix 2: Add width constraint to the BollingerSparkline wrapper div
old_wrap = 'display: "flex", flexDirection: "column", alignItems: "center" }}'
# Find the one that's inside BollingerSparkline function (around line 470)
idx = content.find('function BollingerSparkline')
if idx >= 0:
    next_wrap = content.find(old_wrap, idx)
    if next_wrap >= 0 and next_wrap < idx + 1500:
        new_wrap = 'display: "flex", flexDirection: "column", alignItems: "center", width: 160, maxWidth: 160, overflow: "hidden", flexShrink: 0 }}'
        content = content[:next_wrap] + new_wrap + content[next_wrap + len(old_wrap):]
        print("[2] Added width constraints to BollingerSparkline container")
    else:
        print("[2] SKIP: wrapper div not found near BollingerSparkline")
else:
    print("[2] SKIP: BollingerSparkline function not found")

with open(FILE, 'w') as f:
    f.write(content)
print("Done!")
