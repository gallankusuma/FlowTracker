#!/usr/bin/env python3
"""Add chart popup modal when clicking XABCD or Bollinger chart."""
FILE = '/var/www/flowtracker/app/signal-scanner/page.tsx'

with open(FILE, 'r') as f:
    content = f.read()

# 1. Add modal state
anchor = '  const [expandedScanRow, setExpandedScanRow] = useState<string | null>(null);'
modal_state = '  const [chartModal, setChartModal] = useState<{ pattern: any; type: "xabcd" | "bollinger" } | null>(null);'
if 'chartModal' not in content:
    content = content.replace(anchor, anchor + '\n' + modal_state)
    print("[1] Added chartModal state")
else:
    print("[1] SKIP: chartModal already exists")

# 2. Add the modal component JSX right before the closing of the scan tab
# Find the scan tab section and add modal at the end of the component (before final return closing)
# We'll add it right after the recsTab === "scan" section

# Find a good place - add right before the closing </> of the scan tab
# Let's find the pattern: the charts section in the detail panel
old_chart_section = '''                      <div style={{ display: "flex", gap: 24, marginBottom: 20, justifyContent: "center", alignItems: "center",
                        background: "rgba(255,255,255,0.02)", borderRadius: 12, padding: "16px 20px" }}>
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text-muted)", marginBottom: 8, letterSpacing: "0.1em" }}>XABCD PATTERN</div>
                          <div style={{ margin: "8px 0px" }}>
                            <XABCDMiniChart data={p.pattern_data} direction={p.direction} ratios={p.ratios} entryMin={p.entry_min} entryMax={p.entry_max} stopLoss={p.stop_loss} target1={p.target_1} target2={p.target_2} candles={p.ohlc_candles} />
                          </div>
                        </div>
                        <div style={{ width: 1, height: 80, background: "rgba(255,255,255,0.06)" }} />
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text-muted)", marginBottom: 8, letterSpacing: "0.1em" }}>BOLLINGER BANDS 30D</div>
                          <div style={{ margin: "8px 0" }}>
                            <BollingerSparkline data={p.bb_data} direction={p.direction} large={true} />
                          </div>
                        </div>
                      </div>'''

new_chart_section = '''                      <div style={{ display: "flex", gap: 24, marginBottom: 20, justifyContent: "center", alignItems: "center",
                        background: "rgba(255,255,255,0.02)", borderRadius: 12, padding: "16px 20px" }}>
                        <div style={{ textAlign: "center", cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); setChartModal({ pattern: p, type: "xabcd" }); }}>
                          <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text-muted)", marginBottom: 8, letterSpacing: "0.1em" }}>XABCD PATTERN <span style={{ color: "#818cf8", fontSize: 9 }}>(click to enlarge)</span></div>
                          <div style={{ margin: "8px 0px" }}>
                            <XABCDMiniChart data={p.pattern_data} direction={p.direction} ratios={p.ratios} entryMin={p.entry_min} entryMax={p.entry_max} stopLoss={p.stop_loss} target1={p.target_1} target2={p.target_2} candles={p.ohlc_candles} />
                          </div>
                        </div>
                        <div style={{ width: 1, height: 80, background: "rgba(255,255,255,0.06)" }} />
                        <div style={{ textAlign: "center", cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); setChartModal({ pattern: p, type: "bollinger" }); }}>
                          <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text-muted)", marginBottom: 8, letterSpacing: "0.1em" }}>BOLLINGER BANDS 30D <span style={{ color: "#818cf8", fontSize: 9 }}>(click to enlarge)</span></div>
                          <div style={{ margin: "8px 0" }}>
                            <BollingerSparkline data={p.bb_data} direction={p.direction} large={true} />
                          </div>
                        </div>
                      </div>'''

if old_chart_section in content:
    content = content.replace(old_chart_section, new_chart_section, 1)
    print("[2] Made charts clickable for popup")
else:
    print("[2] SKIP: chart section not found")

# 3. Now we need to make the XABCDMiniChart and BollingerSparkline accept a "fullscreen" prop
# For XABCDMiniChart, update the candlestick W/H when fullscreen
old_xabcd_sizes = '''  const hasCandles = candles && candles.length > 5;
  const W = hasCandles ? 520 : 280;
  const H = hasCandles ? 200 : 140;'''
new_xabcd_sizes = '''  const hasCandles = candles && candles.length > 5;
  const W = hasCandles ? 520 : 280;
  const H = hasCandles ? 200 : 140;'''
# Keep same for now, the modal will use CSS transform scale

# 4. Add the modal overlay JSX
# Insert right before the closing of the main component return
# Find the end of the scan tab section
scan_tab_end_marker = '      {recsTab === "stats" && (() => {'
modal_jsx = '''      {/* ── Chart Popup Modal ── */}
      {chartModal && (() => {
        const p = chartModal.pattern;
        return (
          <div onClick={() => setChartModal(null)} style={{
            position: "fixed", inset: 0, zIndex: 9999, 
            background: "rgba(0,0,0,0.85)", backdropFilter: "blur(8px)",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer",
          }}>
            <div onClick={(e) => e.stopPropagation()} style={{
              background: "rgba(13,17,23,0.98)", border: "1px solid rgba(99,102,241,0.3)",
              borderRadius: 16, padding: "24px 32px", maxWidth: "90vw", maxHeight: "90vh",
              overflow: "auto", cursor: "default", position: "relative",
            }}>
              {/* Close button */}
              <button onClick={() => setChartModal(null)} style={{
                position: "absolute", top: 12, right: 16, background: "none", border: "none",
                color: "var(--text-muted)", fontSize: 20, cursor: "pointer",
              }}>✕</button>

              {/* Header */}
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
                <span style={{ fontSize: 22, fontWeight: 900, color: "var(--text-primary)" }}>{p.ticker}</span>
                <span style={{ padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 800,
                  background: p.direction === "BULLISH" ? "rgba(52,211,153,0.15)" : "rgba(248,113,113,0.15)",
                  color: p.direction === "BULLISH" ? "#34d399" : "#f87171",
                }}>{p.direction === "BULLISH" ? "▲ BULLISH" : "▼ BEARISH"}</span>
                <span style={{ padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 800,
                  background: "rgba(99,102,241,0.15)", color: "#818cf8",
                }}>{p.pattern_type}</span>
                <span style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 700 }}>
                  {chartModal.type === "xabcd" ? "XABCD Pattern" : "Bollinger Bands 30D"}
                </span>
              </div>

              {/* Chart - scaled up */}
              <div style={{ display: "flex", justifyContent: "center", transform: "scale(1.5)", transformOrigin: "top center", 
                marginBottom: chartModal.type === "xabcd" ? 180 : 100 }}>
                {chartModal.type === "xabcd" ? (
                  <XABCDMiniChart data={p.pattern_data} direction={p.direction} ratios={p.ratios} 
                    entryMin={p.entry_min} entryMax={p.entry_max} stopLoss={p.stop_loss} 
                    target1={p.target_1} target2={p.target_2} candles={p.ohlc_candles} />
                ) : (
                  <BollingerSparkline data={p.bb_data} direction={p.direction} large={true} />
                )}
              </div>

              {/* Price info bar */}
              <div style={{ display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap", marginTop: 12 }}>
                {[
                  { label: "Entry", value: `${p.entry_min?.toLocaleString("id-ID")} - ${p.entry_max?.toLocaleString("id-ID")}`, color: "#818cf8" },
                  { label: "SL", value: p.stop_loss?.toLocaleString("id-ID"), color: "#f87171" },
                  { label: "T1", value: p.target_1?.toLocaleString("id-ID"), color: "#34d399" },
                  { label: "T2", value: p.target_2?.toLocaleString("id-ID"), color: "#10b981" },
                  { label: "Close", value: p.current_price ? Number(p.current_price).toLocaleString("id-ID") : "-", color: "#f59e0b" },
                  { label: "R:R", value: `1:${p.risk_reward?.toFixed(1)}`, color: p.risk_reward >= 2 ? "#34d399" : "#f59e0b" },
                  { label: "Score", value: p.conviction_score, color: p.conviction_score >= 70 ? "#10b981" : p.conviction_score >= 55 ? "#f59e0b" : "#6b7280" },
                ].map((item, i) => (
                  <div key={i} style={{ textAlign: "center", padding: "8px 14px", background: "rgba(255,255,255,0.03)", borderRadius: 8 }}>
                    <div style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 700, marginBottom: 4 }}>{item.label}</div>
                    <div style={{ fontSize: 15, fontWeight: 900, color: item.color }}>{item.value}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

'''

if scan_tab_end_marker in content and 'chartModal' in content and '/* Chart Popup Modal */' not in content:
    content = content.replace(scan_tab_end_marker, modal_jsx + '      ' + scan_tab_end_marker)
    print("[3] Added chart popup modal")
else:
    if '/* Chart Popup Modal */' in content:
        print("[3] SKIP: modal already exists")
    else:
        print("[3] SKIP: insertion point not found")

with open(FILE, 'w') as f:
    f.write(content)
print("Done!")
