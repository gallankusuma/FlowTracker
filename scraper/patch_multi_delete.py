#!/usr/bin/env python3
"""Add multi-select delete to trade journal:
1. Checkbox per row
2. Select All checkbox
3. "Delete Selected" button
"""
import re

PAGE = '/var/www/flowtracker/app/signal-scanner/page.tsx'
with open(PAGE, 'r') as f:
    pc = f.read()

changes = 0

# 1. Add selectedTrades state near other journal states
old_state = 'const [journalMarket, setJournalMarket] = useState<"ALL" | "IDX" | "CRYPTO" | "US">("ALL");'
new_state = '''const [journalMarket, setJournalMarket] = useState<"ALL" | "IDX" | "CRYPTO" | "US">("ALL");
  const [selectedTrades, setSelectedTrades] = useState<Set<number>>(new Set());'''

if 'selectedTrades' not in pc:
    pc = pc.replace(old_state, new_state, 1)
    changes += 1
    print("[1] Added selectedTrades state")
else:
    print("[1] SKIP: already exists")

# 2. Add bulk delete function after deleteTrade
old_delete = '''  const deleteTrade = async (id: number) => {
    if (!confirm("Hapus trade ini dari journal?")) return;
    try {
      await fetch(`${apiBase}/api/recommendations/${id}`, { method: "DELETE" });
      await loadJournal();
    } catch (e) { console.error("Delete failed:", e); }
  };'''

new_delete = '''  const deleteTrade = async (id: number) => {
    if (!confirm("Hapus trade ini dari journal?")) return;
    try {
      await fetch(`${apiBase}/api/recommendations/${id}`, { method: "DELETE" });
      await loadJournal();
      setSelectedTrades(prev => { const n = new Set(prev); n.delete(id); return n; });
    } catch (e) { console.error("Delete failed:", e); }
  };

  const deleteSelected = async () => {
    if (selectedTrades.size === 0) return;
    if (!confirm(`Hapus ${selectedTrades.size} trade yang dipilih?`)) return;
    try {
      await Promise.all(
        Array.from(selectedTrades).map(id =>
          fetch(`${apiBase}/api/recommendations/${id}`, { method: "DELETE" })
        )
      );
      setSelectedTrades(new Set());
      await loadJournal();
    } catch (e) { console.error("Bulk delete failed:", e); }
  };

  const toggleSelect = (id: number) => {
    setSelectedTrades(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const toggleSelectAll = (ids: number[]) => {
    setSelectedTrades(prev => {
      const allSelected = ids.every(id => prev.has(id));
      if (allSelected) return new Set();
      return new Set(ids);
    });
  };'''

if 'deleteSelected' not in pc:
    pc = pc.replace(old_delete, new_delete, 1)
    changes += 1
    print("[2] Added deleteSelected + toggleSelect functions")
else:
    print("[2] SKIP: already exists")

# 3. Add checkbox column to table header + "Delete Selected" button
# Current header: gridTemplateColumns has 16 columns
# Add checkbox column (30px) at the start
old_grid = 'gridTemplateColumns: "80px 90px 50px 80px 70px 70px 70px 50px 60px 90px 90px 90px 85px 90px 50px 100px",'
new_grid = 'gridTemplateColumns: "30px 80px 90px 50px 80px 70px 70px 70px 50px 60px 90px 90px 90px 85px 90px 50px 100px",'

# This appears multiple times (header + rows), replace all
count = pc.count(old_grid)
if count > 0:
    pc = pc.replace(old_grid, new_grid)
    changes += 1
    print(f"[3] Updated grid columns ({count} locations)")
else:
    print("[3] SKIP")

# 4. Add "Delete Selected" button + Select All checkbox before table headers
old_header_row = '''                {["TICKER","PATTERN","DIR","ENTRY","SL","T1","T2","R:R","LOT","MODAL","EST T1","EST T2","HARGA ACTUAL","FLOAT P/L","HOLD","STATUS"].map(h => (
                  <span key={h} onClick={() => { if(openSortCol===h) setOpenSortAsc(!openSortAsc); else { setOpenSortCol(h); setOpenSortAsc(true); } }}
                    style={{ fontSize: 12, fontWeight: 800, color: openSortCol===h?"#3b82f6":"var(--text-secondary)", letterSpacing: "0.1em", cursor:"pointer", userSelect:"none" }}>
                    {h} {openSortCol===h ? (openSortAsc?"↑":"↓") : ""}
                  </span>
                ))}'''

# We need to know the visible trade IDs for select all. Let's insert a computed var.
# Actually, let's add the checkbox as the first element and reference the filtered data

new_header_row = '''                <span style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <input type="checkbox" title="Select All"
                    onChange={() => {
                      const visibleIds = filteredRecs
                        .filter((r: any) => r.ticker !== "SUMMARY" && r.pattern_type !== "MONTHLY" && r.status === "OPEN")
                        .map((r: any) => r.id);
                      toggleSelectAll(visibleIds);
                    }}
                    checked={(() => {
                      const visibleIds = filteredRecs
                        .filter((r: any) => r.ticker !== "SUMMARY" && r.pattern_type !== "MONTHLY" && r.status === "OPEN")
                        .map((r: any) => r.id);
                      return visibleIds.length > 0 && visibleIds.every((id: number) => selectedTrades.has(id));
                    })()}
                    style={{ width: 14, height: 14, cursor: "pointer", accentColor: "#6366f1" }} />
                </span>
                {["TICKER","PATTERN","DIR","ENTRY","SL","T1","T2","R:R","LOT","MODAL","EST T1","EST T2","HARGA ACTUAL","FLOAT P/L","HOLD","STATUS"].map(h => (
                  <span key={h} onClick={() => { if(openSortCol===h) setOpenSortAsc(!openSortAsc); else { setOpenSortCol(h); setOpenSortAsc(true); } }}
                    style={{ fontSize: 12, fontWeight: 800, color: openSortCol===h?"#3b82f6":"var(--text-secondary)", letterSpacing: "0.1em", cursor:"pointer", userSelect:"none" }}>
                    {h} {openSortCol===h ? (openSortAsc?"↑":"↓") : ""}
                  </span>
                ))}'''

if old_header_row in pc:
    pc = pc.replace(old_header_row, new_header_row, 1)
    changes += 1
    print("[4] Added Select All checkbox to header")
else:
    print("[4] SKIP")

# 5. Add checkbox to each row (before TICKER)
old_ticker = '''                    <span style={{ fontSize: 15, fontWeight: 900, color: "var(--text-primary)" }}>{r.ticker}</span>'''
new_ticker = '''                    <span style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <input type="checkbox" checked={selectedTrades.has(r.id)}
                        onChange={() => toggleSelect(r.id)}
                        style={{ width: 14, height: 14, cursor: "pointer", accentColor: "#6366f1" }} />
                    </span>
                    <span style={{ fontSize: 15, fontWeight: 900, color: "var(--text-primary)" }}>{r.ticker}</span>'''

if old_ticker in pc:
    pc = pc.replace(old_ticker, new_ticker, 1)
    changes += 1
    print("[5] Added checkbox to each row")
else:
    print("[5] SKIP")

# 6. Add "Delete Selected" button above the table
old_table_start = '''          {/* Journal table */}
          <div style={{ background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border)", overflow: "hidden" }}>'''

new_table_start = '''          {/* Delete Selected button */}
          {selectedTrades.size > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
              <button onClick={deleteSelected}
                style={{ padding: "8px 16px", borderRadius: 8, cursor: "pointer",
                  background: "linear-gradient(135deg, #dc2626, #b91c1c)", border: "none",
                  color: "#fff", fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", gap: 6 }}>
                🗑️ Delete Selected ({selectedTrades.size})
              </button>
              <button onClick={() => setSelectedTrades(new Set())}
                style={{ padding: "8px 12px", borderRadius: 8, cursor: "pointer",
                  background: "transparent", border: "1px solid var(--border)",
                  color: "var(--text-muted)", fontSize: 11, fontWeight: 700 }}>
                Clear Selection
              </button>
            </div>
          )}

          {/* Journal table */}
          <div style={{ background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border)", overflow: "hidden" }}>'''

if old_table_start in pc:
    pc = pc.replace(old_table_start, new_table_start, 1)
    changes += 1
    print("[6] Added 'Delete Selected' button above table")
else:
    print("[6] SKIP")

# Also need to update minWidth to account for new column
old_minw = 'minWidth: 1220'
new_minw = 'minWidth: 1250'
pc = pc.replace(old_minw, new_minw)
print(f"[7] Updated minWidth ({pc.count(new_minw)} locations)")

print(f"\nTotal changes: {changes}")

with open(PAGE, 'w') as f:
    f.write(pc)
print("Done!")
