#!/usr/bin/env python3
"""Add expandable detail panel to scan result rows."""
FILE = '/var/www/flowtracker/app/signal-scanner/page.tsx'

with open(FILE, 'r') as f:
    content = f.read()

# 1. Add expandedScanRow state near other scan states
anchor = '  const [searchTicker, setSearchTicker] = useState("");'
state_line = '  const [expandedScanRow, setExpandedScanRow] = useState<string | null>(null);'
if 'expandedScanRow' not in content:
    content = content.replace(anchor, anchor + '\n' + state_line)
    print("[1] Added expandedScanRow state")
else:
    print("[1] SKIP: expandedScanRow already exists")

# 2. Replace the scan result row to make it clickable and add detail panel
old_row_start = '''                  return (
                    <div key={i} style={{ background: "var(--bg-secondary)",
                      border: `1px solid ${meta.border}`,
                      borderRadius: 12, padding: "16px 20px",
                      display: "grid",
                      gridTemplateColumns: "90px 120px 130px 160px 130px 120px 70px 60px 100px",
                      gap: 14, alignItems: "center",
                      borderLeft: `4px solid ${meta.color}` }}>'''

new_row_start = '''                  const isExpanded = expandedScanRow === rId;
                  return (
                    <div key={i} style={{ borderRadius: 12, borderLeft: `4px solid ${meta.color}`, overflow: "hidden" }}>
                    <div onClick={() => setExpandedScanRow(isExpanded ? null : rId)}
                      style={{ background: isExpanded ? "rgba(56,139,253,0.06)" : "var(--bg-secondary)",
                      border: `1px solid ${meta.border}`,
                      borderRadius: isExpanded ? "12px 12px 0 0" : "12px", padding: "16px 20px",
                      display: "grid",
                      gridTemplateColumns: "90px 120px 130px 160px 130px 120px 70px 60px 100px",
                      gap: 14, alignItems: "center",
                      cursor: "pointer", transition: "background 0.2s" }}>'''

if old_row_start in content:
    content = content.replace(old_row_start, new_row_start, 1)
    print("[2] Made row clickable")
else:
    print("[2] SKIP: row start pattern not found")

# 3. Add the detail panel after the closing </div> of the row, before the ");"
old_row_end = '''                      {savedIds.has(rId) ? "✓ Saved" : saving === rId ? "..." : "+ Journal"}
                    </button>
                  </div>
                  );'''

detail_panel = '''                      {savedIds.has(rId) ? "\\u2713 Saved" : saving === rId ? "..." : "+ Journal"}
                    </button>
                  </div>

                  {/* Expanded Detail Panel */}
                  {isExpanded && (
                    <div style={{
                      background: "rgba(13,17,23,0.95)", border: `1px solid ${meta.border}`, borderTop: "none",
                      borderRadius: "0 0 12px 12px", padding: "20px 24px",
                    }}>
                      {/* Row 1: Price Details */}
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 16, marginBottom: 20 }}>
                        {[
                          { label: "Entry Zone", value: `${p.entry_min?.toLocaleString("id-ID")} - ${p.entry_max?.toLocaleString("id-ID")}`, color: "#818cf8" },
                          { label: "Stop Loss", value: p.stop_loss?.toLocaleString("id-ID"), color: "#f87171" },
                          { label: "Target 1", value: p.target_1?.toLocaleString("id-ID"), color: "#34d399" },
                          { label: "Target 2", value: p.target_2?.toLocaleString("id-ID"), color: "#10b981" },
                          { label: "Latest Close", value: p.current_price ? Number(p.current_price).toLocaleString("id-ID") : "-", color: "#f59e0b" },
                        ].map((item, idx) => (
                          <div key={idx} style={{ background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: "12px 14px", textAlign: "center" }}>
                            <div style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 700, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>{item.label}</div>
                            <div style={{ fontSize: 18, fontWeight: 900, color: item.color }}>{item.value}</div>
                          </div>
                        ))}
                      </div>

                      {/* Row 2: Score Breakdown */}
                      <div style={{ marginBottom: 6 }}>
                        <div style={{ fontSize: 11, fontWeight: 800, color: "var(--text-muted)", marginBottom: 10, letterSpacing: "0.1em" }}>
                          \\u2699\\ufe0f CONVICTION SCORE BREAKDOWN
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
                          {[
                            { key: "harmonic", label: "Harmonic", icon: "\\ud83d\\udd37", color: "#818cf8" },
                            { key: "wyckoff", label: "Wyckoff", icon: "\\ud83d\\udcca", color: "#f59e0b" },
                            { key: "smc", label: "SMC", icon: "\\ud83c\\udfaf", color: "#10b981" },
                            { key: "volume_profile", label: "Volume", icon: "\\ud83d\\udcc8", color: "#3b82f6" },
                            { key: "broker_flow", label: "Broker Flow", icon: "\\ud83c\\udfe6", color: "#f87171" },
                          ].map(f => {
                            const val = p.conviction_breakdown?.[f.key] ?? 0;
                            const maxVal = f.key === "harmonic" ? 20 : f.key === "wyckoff" ? 15 : f.key === "smc" ? 20 : f.key === "volume_profile" ? 15 : 30;
                            const pct = Math.min(100, Math.max(0, (val / maxVal) * 100));
                            return (
                              <div key={f.key} style={{ background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: "12px 10px", textAlign: "center" }}>
                                <div style={{ fontSize: 9, fontWeight: 800, color: f.color, marginBottom: 6 }}>{f.icon} {f.label}</div>
                                <div style={{ fontSize: 22, fontWeight: 900, color: val > 0 ? f.color : "var(--text-muted)", lineHeight: 1 }}>
                                  {typeof val === 'number' ? val.toFixed(1) : val}
                                </div>
                                <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 4 }}>/ {maxVal} pts</div>
                                <div style={{ height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2, marginTop: 6, overflow: "hidden" }}>
                                  <div style={{ height: "100%", width: `${pct}%`, background: f.color, borderRadius: 2, transition: "width 0.5s" }} />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {/* Row 3: Additional Info */}
                      <div style={{ display: "flex", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          <span style={{ fontWeight: 700 }}>Fib Score:</span> <span style={{ color: "#f59e0b", fontWeight: 800 }}>{p.fib_score ?? "-"}</span>
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          <span style={{ fontWeight: 700 }}>Wyckoff:</span> <span style={{ color: "#818cf8", fontWeight: 800 }}>{p.wyckoff_phase || "-"}</span>
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          <span style={{ fontWeight: 700 }}>SMC:</span> <span style={{ color: "#10b981", fontWeight: 800 }}>{p.smc_tags || "-"}</span>
                        </div>
                        {p.foreign_3d_B !== undefined && (
                          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                            <span style={{ fontWeight: 700 }}>Foreign 3D:</span> <span style={{ color: p.foreign_3d_B >= 0 ? "#34d399" : "#f87171", fontWeight: 800 }}>{p.foreign_3d_B}B</span>
                          </div>
                        )}
                        {p.smart_money_confirmed && (
                          <div style={{ fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 4, background: "rgba(52,211,153,0.1)", color: "#34d399" }}>
                            \\u2705 Smart Money Confirmed
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  </div>
                  );'''

if old_row_end in content:
    content = content.replace(old_row_end, detail_panel, 1)
    print("[3] Added expandable detail panel")
else:
    print("[3] SKIP: row end pattern not found, trying alternate...")
    # Try with unicode checkmark
    old_row_end2 = '''                      {savedIds.has(rId) ? "\u2713 Saved" : saving === rId ? "..." : "+ Journal"}
                    </button>
                  </div>
                  );'''
    if old_row_end2 in content:
        content = content.replace(old_row_end2, detail_panel, 1)
        print("[3] Added expandable detail panel (alt match)")
    else:
        print("[3] SKIP: no match found at all")

with open(FILE, 'w') as f:
    f.write(content)
print("Done!")
