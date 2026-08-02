#!/usr/bin/env python3
"""Fix Y-axis clipping in both detail panel and popup modal."""
FILE = '/var/www/flowtracker/app/signal-scanner/page.tsx'

with open(FILE, 'r') as f:
    content = f.read()

# 1. Increase padX to 80 so Y-axis labels fit inside SVG
old_pad = '''  const W = hasCandles ? 600 : 280;
  const H = hasCandles ? 230 : 140;
  const padX = hasCandles ? 65 : 30;'''
new_pad = '''  const W = hasCandles ? 640 : 280;
  const H = hasCandles ? 230 : 140;
  const padX = hasCandles ? 80 : 30;'''
if old_pad in content:
    content = content.replace(old_pad, new_pad, 1)
    print("[1] Increased W to 640, padX to 80")
else:
    print("[1] SKIP")

# 2. Fix popup modal - remove scale(1.5) transform which causes clipping, 
#    use bigger container instead
old_popup_chart = '''<div style={{ display: "flex", justifyContent: "center", transform: "scale(1.5)", transformOrigin: "top center", 
                marginBottom: chartModal.type === "xabcd" ? 180 : 100 }}>'''
new_popup_chart = '''<div style={{ display: "flex", justifyContent: "center", padding: "0 10px",
                marginBottom: 16 }}>'''
if old_popup_chart in content:
    content = content.replace(old_popup_chart, new_popup_chart, 1)
    print("[2] Removed scale transform from popup, using native size")
else:
    print("[2] SKIP")

# 3. Make popup modal wider to fit the chart
old_popup_style = '''background: "rgba(13,17,23,0.98)", border: "1px solid rgba(99,102,241,0.3)",
              borderRadius: 16, padding: "24px 32px", maxWidth: "90vw", maxHeight: "90vh",'''
new_popup_style = '''background: "rgba(13,17,23,0.98)", border: "1px solid rgba(99,102,241,0.3)",
              borderRadius: 16, padding: "24px 32px", maxWidth: "95vw", maxHeight: "90vh", minWidth: "700px",'''
if old_popup_style in content:
    content = content.replace(old_popup_style, new_popup_style, 1)
    print("[3] Updated popup modal width")
else:
    print("[3] SKIP")

# 4. Fix the detail panel chart container to not clip
old_chart_container = '''background: "rgba(255,255,255,0.02)", borderRadius: 12, padding: "16px 20px" }}>'''
new_chart_container = '''background: "rgba(255,255,255,0.02)", borderRadius: 12, padding: "16px 10px", overflow: "visible" }}>'''
if old_chart_container in content:
    content = content.replace(old_chart_container, new_chart_container, 1)
    print("[4] Fixed detail panel chart container overflow")
else:
    print("[4] SKIP")

with open(FILE, 'w') as f:
    f.write(content)
print("Done!")
