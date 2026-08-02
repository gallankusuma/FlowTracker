#!/usr/bin/env python3
"""Fix UI labels for bearish patterns to be clearer for IDX long-only investors."""
PAGE = '/var/www/flowtracker/app/signal-scanner/page.tsx'

with open(PAGE, 'r') as f:
    pc = f.read()

changes = 0

# 1. Fix direction badge text (line 2051)
old = '''>{p.direction === "BULLISH" ? "▲ BULLISH" : "▼ BEARISH"}</span>'''
new = '''>{p.direction === "BULLISH" ? "▲ BUY Signal" : "▼ SELL/Avoid"}</span>'''
if old in pc:
    pc = pc.replace(old, new, 1)
    changes += 1
    print("[1] Fixed direction badge: BUY Signal / SELL-Avoid")

# 2. Fix ENTRY ZONE label at line 1591 (scan results card)
old2 = '''<div style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 700, marginBottom: 3 }}>ENTRY ZONE</div>'''
new2 = '''<div style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 700, marginBottom: 3 }}>{p.direction === "BEARISH" ? "SELL ZONE" : "ENTRY ZONE"}</div>'''
if old2 in pc:
    pc = pc.replace(old2, new2, 1)
    changes += 1
    print("[2] Fixed scan card ENTRY label → direction-aware")

# 3. Fix popup Entry Zone label (line 1665)
old3 = '''{ label: "Entry Zone", value: `${p.entry_min?.toLocaleString("id-ID")} - ${p.entry_max?.toLocaleString("id-ID")}`, color: "#818cf8" }'''
new3 = '''{ label: p.direction === "BEARISH" ? "Sell Zone" : "Entry Zone", value: `${p.entry_min?.toLocaleString("id-ID")} - ${p.entry_max?.toLocaleString("id-ID")}`, color: "#818cf8" }'''
if old3 in pc:
    pc = pc.replace(old3, new3, 1)
    changes += 1
    print("[3] Fixed popup Entry Zone label → direction-aware")

# 4. Add bearish context note in the CARA BACA section
old_cara = '''["🎯 Conviction Score (0-100)", "≥70 = langsung entry | 55-69 = wait konfirmasi | <55 = skip"],'''
new_cara = '''["🎯 Conviction Score (0-100)", "≥70 = langsung entry | 55-69 = wait konfirmasi | <55 = skip"],
                ["📉 BEARISH = SELL/Avoid", "Bearish pattern artinya harga berpotensi turun. Jual jika pegang, atau hindari beli."],'''
if old_cara in pc:
    pc = pc.replace(old_cara, new_cara, 1)
    changes += 1
    print("[4] Added bearish explanation to CARA BACA")

print(f"\nTotal changes: {changes}")

with open(PAGE, 'w') as f:
    f.write(pc)
print("Done!")
