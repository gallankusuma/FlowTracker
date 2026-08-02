#!/usr/bin/env python3
"""
PART 3: Add weight sliders to backtest UI in page.tsx
"""
import re

PAGE = '/var/www/flowtracker/app/signal-scanner/page.tsx'
with open(PAGE, 'r') as f:
    pc = f.read()

# 1. Add btWeights state after btMarket
old_state = 'const [btMarket, setBtMarket] = useState<"IDX" | "US">("IDX");'
new_state = '''const [btMarket, setBtMarket] = useState<"IDX" | "US">("IDX");
  const [btWeights, setBtWeights] = useState({ harmonic: 25, wyckoff: 20, smc: 25, volume_profile: 20, broker_flow: 10 });
  const [showBtWeights, setShowBtWeights] = useState(false);'''

if old_state in pc:
    pc = pc.replace(old_state, new_state, 1)
    print("[1] ✅ Added btWeights state")
else:
    print("[1] ⚠️ btMarket state not found")

# 2. Pass weights to API call
old_body = 'body: JSON.stringify({ startDate: btStartDate, endDate: btEndDate, min_score: btMinScore, market: btMarket })'
new_body = 'body: JSON.stringify({ startDate: btStartDate, endDate: btEndDate, min_score: btMinScore, market: btMarket, weights: btWeights })'
if old_body in pc:
    pc = pc.replace(old_body, new_body, 1)
    print("[2] ✅ Pass weights to API")
else:
    print("[2] ⚠️ API body not found")

# 3. Add weight sliders UI after the market toggle buttons
# Find where the Min Score dropdown ends and add weights after it
old_min_score_end = '''{btRunning ? "⏳ Running..." : "🚀 Run Backtest"}
                </button>'''

weights_ui = '''{btRunning ? "⏳ Running..." : "🚀 Run Backtest"}
                </button>
                <button onClick={() => setShowBtWeights(!showBtWeights)} style={{
                  background: showBtWeights ? "rgba(124,58,237,0.2)" : "transparent",
                  border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px",
                  cursor: "pointer", color: "var(--text-muted)", fontSize: 11, fontWeight: 700
                }}>
                  ⚙️ Weights
                </button>'''

if old_min_score_end in pc:
    pc = pc.replace(old_min_score_end, weights_ui, 1)
    print("[3] ✅ Added weights toggle button")
else:
    print("[3] ⚠️ Run Backtest button not found")

# 4. Add the weights panel (collapsible) after the run panel closing div
# Find the progress bar section end and add weights panel after it
old_progress_end = '''          </div>

          {/* ── Previous Runs'''

weights_panel = '''          </div>

          {/* ── Weight Sliders ──────────────────────────────── */}
          {showBtWeights && (
            <div style={{ background:"var(--bg-secondary)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 20px" }}>
              <div style={{ fontSize:13, fontWeight:800, color:"var(--text-primary)", marginBottom:12 }}>
                ⚙️ Layer Weights (total: {Object.values(btWeights).reduce((a,b)=>a+b,0)})
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(200px, 1fr))", gap:12 }}>
                {([
                  { key: "harmonic", label: "📐 Harmonic Pattern", color: "#818cf8" },
                  { key: "wyckoff", label: "🔄 Wyckoff Phase", color: "#34d399" },
                  { key: "smc", label: "💰 SMC Setup", color: "#fbbf24" },
                  { key: "volume_profile", label: "📊 Volume Profile", color: "#f472b6" },
                  { key: "broker_flow", label: "🏦 Broker Flow", color: "#60a5fa" },
                ] as const).map(({ key, label, color }) => (
                  <div key={key} style={{ display:"flex", flexDirection:"column", gap:4 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                      <span style={{ fontSize:11, color:"var(--text-muted)" }}>{label}</span>
                      <span style={{ fontSize:13, fontWeight:800, color, minWidth:30, textAlign:"right" }}>
                        {btWeights[key as keyof typeof btWeights]}
                      </span>
                    </div>
                    <input type="range" min={0} max={50} step={5}
                      value={btWeights[key as keyof typeof btWeights]}
                      onChange={e => setBtWeights(prev => ({ ...prev, [key]: Number(e.target.value) }))}
                      style={{ width:"100%", accentColor: color, cursor:"pointer" }}
                    />
                  </div>
                ))}
              </div>
              <div style={{ display:"flex", gap:8, marginTop:12 }}>
                <button onClick={() => setBtWeights({ harmonic: 25, wyckoff: 20, smc: 25, volume_profile: 20, broker_flow: 10 })}
                  style={{ background:"transparent", border:"1px solid var(--border)", borderRadius:6, padding:"4px 12px", fontSize:10, color:"var(--text-muted)", cursor:"pointer" }}>
                  🔄 Reset Default
                </button>
                <button onClick={() => setBtWeights({ harmonic: 30, wyckoff: 25, smc: 25, volume_profile: 20, broker_flow: 0 })}
                  style={{ background:"transparent", border:"1px solid var(--border)", borderRadius:6, padding:"4px 12px", fontSize:10, color:"var(--text-muted)", cursor:"pointer" }}>
                  🇺🇸 US Mode (no broker)
                </button>
                <button onClick={() => setBtWeights({ harmonic: 20, wyckoff: 20, smc: 20, volume_profile: 20, broker_flow: 20 })}
                  style={{ background:"transparent", border:"1px solid var(--border)", borderRadius:6, padding:"4px 12px", fontSize:10, color:"var(--text-muted)", cursor:"pointer" }}>
                  ⚖️ Equal Weight
                </button>
              </div>
            </div>
          )}

          {/* ── Previous Runs'''

if old_progress_end in pc:
    pc = pc.replace(old_progress_end, weights_panel, 1)
    print("[4] ✅ Added weights panel UI")
else:
    print("[4] ⚠️ Previous Runs section not found")

with open(PAGE, 'w') as f:
    f.write(pc)

print("\nDone with UI!")
