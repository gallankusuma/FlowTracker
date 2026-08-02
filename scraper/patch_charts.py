#!/usr/bin/env python3
"""Move XABCD and Bollinger charts into the expanded detail panel."""
FILE = '/var/www/flowtracker/app/signal-scanner/page.tsx'

with open(FILE, 'r') as f:
    content = f.read()

# 1. Remove charts from compact row + adjust grid columns
old_charts = '''                    <XABCDMiniChart data={p.pattern_data} direction={p.direction} />
                    <BollingerSparkline data={p.bb_data} direction={p.direction} />

                    {/* Entry zone & Latest Close */}'''
new_charts = '''                    {/* Entry zone & Latest Close */}'''
if old_charts in content:
    content = content.replace(old_charts, new_charts, 1)
    print("[1] Removed charts from compact row")
else:
    print("[1] SKIP: charts not found in compact row")

# 2. Update grid columns (remove 2 columns for charts: 130px 160px)
old_grid = 'gridTemplateColumns: "90px 120px 130px 160px 130px 120px 70px 60px 100px"'
new_grid = 'gridTemplateColumns: "100px 120px 160px 130px 80px 60px 100px"'
count = content.count(old_grid)
if count > 0:
    content = content.replace(old_grid, new_grid)
    print(f"[2] Updated grid columns ({count} occurrences)")
else:
    print("[2] SKIP: grid columns not found")

# 3. Add charts to the expanded detail panel (before Price Details row)
old_panel = '''                      {/* Row 1: Price Details */}'''
new_panel = '''                      {/* Charts: Pattern + Bollinger (large) */}
                      <div style={{ display: "flex", gap: 24, marginBottom: 20, justifyContent: "center", alignItems: "center",
                        background: "rgba(255,255,255,0.02)", borderRadius: 12, padding: "16px 20px" }}>
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text-muted)", marginBottom: 8, letterSpacing: "0.1em" }}>XABCD PATTERN</div>
                          <div style={{ transform: "scale(1.8)", transformOrigin: "center center", margin: "20px 40px" }}>
                            <XABCDMiniChart data={p.pattern_data} direction={p.direction} />
                          </div>
                        </div>
                        <div style={{ width: 1, height: 80, background: "rgba(255,255,255,0.06)" }} />
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text-muted)", marginBottom: 8, letterSpacing: "0.1em" }}>BOLLINGER BANDS 30D</div>
                          <div style={{ transform: "scale(1.8)", transformOrigin: "center center", margin: "20px 40px" }}>
                            <BollingerSparkline data={p.bb_data} direction={p.direction} />
                          </div>
                        </div>
                      </div>

                      {/* Row 1: Price Details */}'''
if old_panel in content:
    content = content.replace(old_panel, new_panel, 1)
    print("[3] Added large charts to detail panel")
else:
    print("[3] SKIP: Panel marker not found")

with open(FILE, 'w') as f:
    f.write(content)
print("Done!")
