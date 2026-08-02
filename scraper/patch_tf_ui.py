#!/usr/bin/env python3
"""Add timeframe selector buttons to the UI."""
FILE = '/var/www/flowtracker/app/signal-scanner/page.tsx'

with open(FILE, 'r') as f:
    content = f.read()

# Insert timeframe selector after the MIN R:R input section, before the search ticker
old_section = '''            <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 14px" }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700 }}>🔍</span>
              <input type="text" placeholder="Search Ticker..." value={searchTicker}'''

new_section = '''            <div style={{ display: "flex", gap: 2, padding: 2, background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 8 }}>
              {(["1d", "1wk", "1mo"] as const).map(tf => (
                <button key={tf} onClick={() => { setTimeframe(tf); setScanResult(null); }} style={{
                  padding: "6px 12px", borderRadius: 6, border: "none", cursor: "pointer",
                  fontSize: 11, fontWeight: 800,
                  background: timeframe === tf ? "rgba(99,102,241,0.8)" : "transparent",
                  color: timeframe === tf ? "#fff" : "var(--text-muted)",
                  transition: "all 0.2s",
                }}>
                  {tf === "1d" ? "📅 Daily" : tf === "1wk" ? "📆 Weekly" : "🗓️ Monthly"}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 14px" }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700 }}>🔍</span>
              <input type="text" placeholder="Search Ticker..." value={searchTicker}'''

if old_section in content:
    content = content.replace(old_section, new_section, 1)
    print("[1] Added timeframe selector buttons")
else:
    print("[1] SKIP: section not found")

# Also show the current timeframe in the scan button text
old_scan_btn = '? "🪙 Scan 25 Crypto" : "Scan 116 IDX Stocks"'
new_scan_btn = '? "🪙 Scan 25 Crypto" : `Scan ${timeframe === "1d" ? "Daily" : timeframe === "1wk" ? "Weekly" : "Monthly"} IDX`'
if old_scan_btn in content:
    content = content.replace(old_scan_btn, new_scan_btn, 1)
    print("[2] Updated scan button label with timeframe")
else:
    print("[2] SKIP")

with open(FILE, 'w') as f:
    f.write(content)
print("Done!")
