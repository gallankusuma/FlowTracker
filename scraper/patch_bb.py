#!/usr/bin/env python3
"""Make BollingerSparkline bigger natively and fix detail panel."""
FILE = '/var/www/flowtracker/app/signal-scanner/page.tsx'

with open(FILE, 'r') as f:
    content = f.read()

# 1. Replace BollingerSparkline with a larger version
old_bb = '''function BollingerSparkline({ data, direction }: { data: any[]; direction: string }) {
  if (!data || data.length === 0) return null;
  const W = 160, H = 50, pad = 6;'''

new_bb = '''function BollingerSparkline({ data, direction, large }: { data: any[]; direction: string; large?: boolean }) {
  if (!data || data.length === 0) return null;
  const W = large ? 320 : 160;
  const H = large ? 120 : 50;
  const pad = large ? 12 : 6;'''

if old_bb in content:
    content = content.replace(old_bb, new_bb, 1)
    print("[1] Updated BollingerSparkline for large mode")
else:
    print("[1] SKIP: BollingerSparkline not found")

# 2. Update container width constraint  
old_container = 'display: "flex", flexDirection: "column", alignItems: "center", width: 160, maxWidth: 160, overflow: "hidden", flexShrink: 0'
new_container = 'display: "flex", flexDirection: "column", alignItems: "center", overflow: "hidden", flexShrink: 0'
if old_container in content:
    content = content.replace(old_container, new_container, 1)
    print("[2] Removed fixed width from BB container")
else:
    print("[2] SKIP: container not found")

# 3. Update usage in detail panel: pass large=true and remove scale transform
old_bb_usage = '''<div style={{ transform: "scale(1.8)", transformOrigin: "center center", margin: "20px 40px" }}>
                            <BollingerSparkline data={p.bb_data} direction={p.direction} />'''
new_bb_usage = '''<div style={{ margin: "8px 0" }}>
                            <BollingerSparkline data={p.bb_data} direction={p.direction} large={true} />'''
if old_bb_usage in content:
    content = content.replace(old_bb_usage, new_bb_usage, 1)
    print("[3] Updated BB usage: large mode + removed scale")
else:
    print("[3] SKIP: BB usage not found")

# 4. Add price labels and nicer styling to large BB chart
# Update the SVG rendering part
old_svg = '''    <svg width={W} height={H + 16} viewBox={`0 0 ${W} ${H + 16}`}>'''
new_svg = '''    <svg width={W} height={H + 16} viewBox={`0 0 ${W} ${H + 16}`} style={large ? { background: "rgba(0,0,0,0.3)", borderRadius: 8 } : {}}>'''
if old_svg in content:
    content = content.replace(old_svg, new_svg, 1)
    print("[4] Added background to large BB SVG")
else:
    print("[4] SKIP: SVG tag not found")

with open(FILE, 'w') as f:
    f.write(content)
print("Done!")
