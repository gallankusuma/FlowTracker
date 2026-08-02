#!/usr/bin/env python3
"""Add delete button to trade journal."""
PAGE = '/var/www/flowtracker/app/signal-scanner/page.tsx'

with open(PAGE, 'r') as f:
    pc = f.read()

changes = 0

# 1. Add deleteTrade function after updateStatus function
old_update = """  const updateStatus = async (id: number, status: string) => {"""

# Find the full updateStatus function to insert after it
import re
match = re.search(r'(  const updateStatus = async \(id: number, status: string\) => \{.*?\n  \};)', pc, re.DOTALL)
if match:
    full_fn = match.group(1)
    delete_fn = """

  const deleteTrade = async (id: number) => {
    if (!confirm("Hapus trade ini dari journal?")) return;
    try {
      await fetch(`${apiBase}/api/recommendations/${id}`, { method: "DELETE" });
      await loadJournal();
    } catch (e) { console.error("Delete failed:", e); }
  };"""
    
    if 'deleteTrade' not in pc:
        pc = pc.replace(full_fn, full_fn + delete_fn, 1)
        changes += 1
        print("[1] Added deleteTrade function")
    else:
        print("[1] SKIP: already exists")
else:
    print("[1] SKIP: updateStatus not found")

# 2. Add delete button next to status dropdown in journal table
# Find the status column area and add delete button
old_status_area = """                      {r.result_pct && (
                        <span style={{ fontSize: 10, fontWeight: 800,
                          color: Number(r.result_pct) >= 0 ? "#34d399" : "#f87171" }}>
                          {Number(r.result_pct) >= 0 ? "+" : ""}{Number(r.result_pct).toFixed(2)}%
                        </span>
                      )}
                    </div>"""

new_status_area = """                      {r.result_pct && (
                        <span style={{ fontSize: 10, fontWeight: 800,
                          color: Number(r.result_pct) >= 0 ? "#34d399" : "#f87171" }}>
                          {Number(r.result_pct) >= 0 ? "+" : ""}{Number(r.result_pct).toFixed(2)}%
                        </span>
                      )}
                      <button onClick={() => deleteTrade(r.id)} title="Hapus trade"
                        style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, cursor: "pointer",
                          background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)",
                          color: "#f87171", fontWeight: 700, marginTop: 2 }}>
                        🗑️
                      </button>
                    </div>"""

if old_status_area in pc:
    pc = pc.replace(old_status_area, new_status_area, 1)
    changes += 1
    print("[2] Added delete button to journal table")
else:
    print("[2] SKIP: status area not found")

# 3. Add delete column header ("DEL" column) — actually let's keep it in the STATUS column
# The delete button is inside the STATUS column, no need for extra column

print(f"\nTotal changes: {changes}")

with open(PAGE, 'w') as f:
    f.write(pc)
print("Done!")
