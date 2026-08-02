#!/usr/bin/env python3
"""Fix X-axis date format and Y-axis price clipping."""
FILE_WORKER = '/var/www/flowtracker-scraper/harmonic-scan-worker.js'
FILE_PAGE = '/var/www/flowtracker/app/signal-scanner/page.tsx'

# ── Fix 1: Worker date format ──
with open(FILE_WORKER, 'r') as f:
    wc = f.read()

# The current date slice cuts off month names. Replace with proper format
old_date = "d: c.date?.slice(5, 10) || '',"
new_date = """d: (() => { try { const dt = new Date(c.date); return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch { return c.date?.slice(5,10) || ''; } })(),"""

if old_date in wc:
    wc = wc.replace(old_date, new_date, 1)
    print("[W1] Fixed date format to 'MMM D' (e.g. 'Feb 13')")
else:
    print("[W1] SKIP: date slice not found")

with open(FILE_WORKER, 'w') as f:
    f.write(wc)

# ── Fix 2: Page - increase padX for Y-axis labels ──
with open(FILE_PAGE, 'r') as f:
    pc = f.read()

# Increase padX so prices don't clip
old_pad = '''  const W = hasCandles ? 560 : 280;
  const H = hasCandles ? 220 : 140;
  const padX = hasCandles ? 50 : 30;
  const padY = 22;
  const padBottom = hasCandles ? 28 : 0;'''
new_pad = '''  const W = hasCandles ? 600 : 280;
  const H = hasCandles ? 230 : 140;
  const padX = hasCandles ? 65 : 30;
  const padY = 22;
  const padBottom = hasCandles ? 30 : 0;'''
if old_pad in pc:
    pc = pc.replace(old_pad, new_pad, 1)
    print("[F1] Increased chart width/padX for Y-axis labels")
else:
    print("[F1] SKIP: pad not found")

# Also improve Y-axis label font size and add thousands separator
old_ylabel = '''textAnchor="end" fontSize={8} fill="rgba(255,255,255,0.45)" fontWeight="700">{fmtP(price)}</text>'''
new_ylabel = '''textAnchor="end" fontSize={9} fill="rgba(255,255,255,0.5)" fontWeight="700" fontFamily="monospace">{fmtP(price)}</text>'''
if old_ylabel in pc:
    pc = pc.replace(old_ylabel, new_ylabel, 1)
    print("[F2] Improved Y-axis label style")
else:
    print("[F2] SKIP: ylabel not found")

# Improve X-axis label style
old_xlabel = '''textAnchor="middle" fontSize={8} fill="rgba(255,255,255,0.4)" fontWeight="600">{d}</text>'''
new_xlabel = '''textAnchor="middle" fontSize={8} fill="rgba(255,255,255,0.5)" fontWeight="700">{d}</text>'''
if old_xlabel in pc:
    pc = pc.replace(old_xlabel, new_xlabel, 1)
    print("[F3] Improved X-axis label style")
else:
    print("[F3] SKIP: xlabel not found")

# Fix Y-axis label x position (more left margin)  
old_ypos = '''<text x={padX - 5} y={y + 3} textAnchor="end"'''
new_ypos = '''<text x={padX - 6} y={y + 3} textAnchor="end"'''
if old_ypos in pc:
    pc = pc.replace(old_ypos, new_ypos, 1)
    print("[F4] Adjusted Y-axis label position")
else:
    print("[F4] SKIP: ypos not found")

with open(FILE_PAGE, 'w') as f:
    f.write(pc)

print("Done!")
