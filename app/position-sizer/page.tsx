"use client";
import Navbar from "@/components/Navbar";
import { useState, useMemo } from "react";

const RISK_PRESETS = [0.5, 1, 1.5, 2, 3];
const LOT_SIZE = 100; // 1 lot = 100 shares IDX

function fmt(n: number) {
  if (n >= 1e9)  return `Rp ${(n/1e9).toFixed(2)}M`;
  if (n >= 1e6)  return `Rp ${(n/1e6).toFixed(1)}jt`;
  if (n >= 1e3)  return `Rp ${(n/1e3).toFixed(0)}rb`;
  return `Rp ${Math.round(n).toLocaleString("id-ID")}`;
}

function InputRow({
  label, sub, value, onChange, prefix = "Rp", suffix = "", type = "number"
}: {
  label: string; sub?: string; value: string;
  onChange: (v: string) => void; prefix?: string; suffix?: string; type?: string;
}) {
  return (
    <div>
      <div style={{ marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", letterSpacing: "0.04em" }}>{label}</span>
        {sub && <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 8 }}>{sub}</span>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
        {prefix && (
          <div style={{
            padding: "10px 14px", background: "var(--bg-tertiary)", borderRadius: "8px 0 0 8px",
            border: "1px solid var(--border)", borderRight: "none",
            fontSize: 13, fontWeight: 700, color: "var(--text-muted)", whiteSpace: "nowrap",
          }}>{prefix}</div>
        )}
        <input
          type={type} value={value}
          onChange={e => onChange(e.target.value)}
          style={{
            flex: 1, padding: "10px 14px",
            borderRadius: prefix ? "0" : suffix ? "8px 0 0 8px" : "8px",
            border: "1px solid var(--border)",
            background: "var(--bg-primary)", color: "var(--text-primary)",
            fontSize: 14, fontWeight: 700, outline: "none",
          }}
        />
        {suffix && (
          <div style={{
            padding: "10px 14px", background: "var(--bg-tertiary)", borderRadius: "0 8px 8px 0",
            border: "1px solid var(--border)", borderLeft: "none",
            fontSize: 13, fontWeight: 700, color: "var(--text-muted)",
          }}>{suffix}</div>
        )}
      </div>
    </div>
  );
}

function ResultCard({ label, value, sub, color = "var(--text-primary)", highlight = false }: {
  label: string; value: string; sub?: string; color?: string; highlight?: boolean;
}) {
  return (
    <div style={{
      background: highlight ? "rgba(47,129,247,0.06)" : "var(--bg-secondary)",
      borderRadius: 12, border: `1px solid ${highlight ? "rgba(47,129,247,0.3)" : "var(--border)"}`,
      padding: "16px 20px",
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 900, color, lineHeight: 1, marginBottom: sub ? 4 : 0 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

export default function PositionSizer() {
  const [modal, setModal]   = useState("100000000");   // 100jt
  const [riskPct, setRiskPct] = useState("1");
  const [entry, setEntry]   = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [ticker, setTicker] = useState("");

  const calc = useMemo(() => {
    const M  = parseFloat(modal)     || 0;
    const R  = parseFloat(riskPct)   || 0;
    const E  = parseFloat(entry)     || 0;
    const SL = parseFloat(stopLoss)  || 0;
    const TP = parseFloat(takeProfit)|| 0;

    if (!M || !R || !E || !SL || E <= SL) return null;

    const maxLoss      = M * (R / 100);
    const riskPerShare = E - SL;
    const shares       = Math.floor(maxLoss / riskPerShare);
    const lots         = Math.floor(shares / LOT_SIZE);
    const actualShares = lots * LOT_SIZE;
    const actualLoss   = actualShares * riskPerShare;
    const capitalUsed  = actualShares * E;
    const capitalPct   = (capitalUsed / M) * 100;
    const slPct        = ((E - SL) / E) * 100;

    let rrRatio = 0, potentialProfit = 0, tpPct = 0;
    if (TP > E) {
      const gainPerShare = TP - E;
      potentialProfit    = actualShares * gainPerShare;
      rrRatio            = gainPerShare / riskPerShare;
      tpPct              = ((TP - E) / E) * 100;
    }

    // Scenario table: 0.5x, 1x, 1.5x, 2x risk
    const scenarios = [0.5, 1, 1.5, 2, 3].map(mult => {
      const loss    = M * (R * mult / 100);
      const sh      = Math.floor(loss / riskPerShare);
      const lt      = Math.floor(sh / LOT_SIZE);
      const cap     = lt * LOT_SIZE * E;
      return { label: `${mult}x Risk (${(R * mult).toFixed(1)}%)`, lots: lt, capital: cap, loss: lt * LOT_SIZE * riskPerShare };
    });

    return { maxLoss, lots, actualShares, actualLoss, capitalUsed, capitalPct, slPct, rrRatio, potentialProfit, tpPct, riskPerShare, scenarios };
  }, [modal, riskPct, entry, stopLoss, takeProfit]);

  return (
    <>
      <Navbar />
      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 24px" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 28 }}>
          <div style={{ width: 4, height: 32, background: "linear-gradient(180deg,#f0883e,#e3b341)", borderRadius: 2 }} />
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 900, color: "var(--text-primary)", letterSpacing: "0.04em", margin: 0 }}>
              POSITION SIZER
            </h1>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
              Kalkulasi lot optimal berdasarkan risk management · Lindungi modal lo
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>

          {/* Input panel */}
          <div>
            <div style={{ background: "var(--bg-secondary)", borderRadius: 14, border: "1px solid var(--border)", padding: 24, marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: "var(--text-primary)", marginBottom: 18, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 4, height: 16, background: "#2f81f7", borderRadius: 2, display: "inline-block" }} />
                PARAMETER MODAL
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <InputRow label="Kode Saham" sub="opsional" value={ticker} onChange={setTicker} prefix="" suffix="" />
                <InputRow label="Total Modal" sub="modal trading lo" value={modal} onChange={setModal} />
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", marginBottom: 8, letterSpacing: "0.04em" }}>
                    MAX RISK PER TRADE
                    <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 8 }}>% dari modal</span>
                  </div>
                  <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                    {RISK_PRESETS.map(p => (
                      <button key={p} onClick={() => setRiskPct(String(p))} style={{
                        padding: "6px 14px", borderRadius: 8,
                        border: `1px solid ${riskPct === String(p) ? "#2f81f7" : "var(--border)"}`,
                        background: riskPct === String(p) ? "rgba(47,129,247,0.15)" : "transparent",
                        color: riskPct === String(p) ? "#58a6ff" : "var(--text-muted)",
                        cursor: "pointer", fontSize: 12, fontWeight: 800,
                      }}>{p}%</button>
                    ))}
                  </div>
                  <InputRow label="" value={riskPct} onChange={setRiskPct} prefix="" suffix="%" />
                </div>
              </div>
            </div>

            <div style={{ background: "var(--bg-secondary)", borderRadius: 14, border: "1px solid var(--border)", padding: 24 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: "var(--text-primary)", marginBottom: 18, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 4, height: 16, background: "#e3b341", borderRadius: 2, display: "inline-block" }} />
                LEVEL HARGA
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <InputRow label="Harga Entry" sub="harga beli" value={entry} onChange={setEntry} />
                <InputRow label="Stop Loss" sub="batas maksimal rugi" value={stopLoss} onChange={setStopLoss} />
                <InputRow label="Take Profit" sub="target harga (opsional)" value={takeProfit} onChange={setTakeProfit} />
              </div>

              {/* Visual price levels */}
              {calc && (
                <div style={{ marginTop: 18, padding: 14, background: "var(--bg-primary)", borderRadius: 10, border: "1px solid var(--border)" }}>
                  <div style={{ position: "relative", height: 80 }}>
                    {/* TP level */}
                    {parseFloat(takeProfit) > 0 && (
                      <div style={{ position: "absolute", top: 0, left: 0, right: 0, display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ height: 2, flex: 1, background: "#3fb950", borderRadius: 1 }} />
                        <span style={{ fontSize: 10, color: "#3fb950", fontWeight: 700, whiteSpace: "nowrap" }}>TP {fmt(parseFloat(takeProfit))} (+{calc.tpPct.toFixed(1)}%)</span>
                      </div>
                    )}
                    {/* Entry level */}
                    <div style={{ position: "absolute", top: "40%", left: 0, right: 0, display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ height: 2, flex: 1, background: "#58a6ff", borderRadius: 1 }} />
                      <span style={{ fontSize: 10, color: "#58a6ff", fontWeight: 700, whiteSpace: "nowrap" }}>ENTRY {fmt(parseFloat(entry))}</span>
                    </div>
                    {/* SL level */}
                    <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ height: 2, flex: 1, background: "#f85149", borderRadius: 1 }} />
                      <span style={{ fontSize: 10, color: "#f85149", fontWeight: 700, whiteSpace: "nowrap" }}>SL {fmt(parseFloat(stopLoss))} (-{calc.slPct.toFixed(1)}%)</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Result panel */}
          <div>
            {!calc ? (
              <div style={{ background: "var(--bg-secondary)", borderRadius: 14, border: "1px dashed var(--border)", padding: 60, textAlign: "center", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 12 }}>
                <div style={{ fontSize: 48 }}>🎯</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "var(--text-primary)" }}>Isi parameter di kiri</div>
                <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Masukkan modal, risk %, entry, dan stop loss</div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

                {/* Main result */}
                <div style={{
                  background: "linear-gradient(135deg, rgba(47,129,247,0.1), rgba(57,210,245,0.05))",
                  borderRadius: 14, border: "1px solid rgba(47,129,247,0.3)",
                  padding: 24, textAlign: "center",
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#58a6ff", letterSpacing: "0.1em", marginBottom: 8 }}>JUMLAH LOT OPTIMAL</div>
                  <div style={{ fontSize: 64, fontWeight: 900, color: "#e6edf3", lineHeight: 1 }}>{calc.lots}</div>
                  <div style={{ fontSize: 14, color: "#8b949e", marginTop: 4 }}>lot = {calc.actualShares.toLocaleString("id-ID")} saham</div>
                  {ticker && <div style={{ marginTop: 8, fontSize: 13, fontWeight: 700, color: "#58a6ff" }}>{ticker.toUpperCase()}</div>}
                </div>

                {/* Key metrics */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <ResultCard label="MAX LOSS (BUDGET RISK)" value={fmt(calc.actualLoss)}
                    sub={`${((calc.actualLoss / parseFloat(modal)) * 100).toFixed(2)}% dari modal`}
                    color="#f85149" />
                  <ResultCard label="CAPITAL DIPAKAI" value={fmt(calc.capitalUsed)}
                    sub={`${calc.capitalPct.toFixed(1)}% dari modal`}
                    color="#e3b341" />
                  <ResultCard label="RISK PER SAHAM" value={`Rp ${calc.riskPerShare.toLocaleString("id-ID")}`}
                    sub={`SL ${calc.slPct.toFixed(1)}% dari entry`}
                    color="#8b949e" />
                  {calc.rrRatio > 0 ? (
                    <ResultCard label="RISK/REWARD RATIO" value={`1 : ${calc.rrRatio.toFixed(1)}`}
                      sub={`Potensi profit ${fmt(calc.potentialProfit)}`}
                      color={calc.rrRatio >= 2 ? "#3fb950" : calc.rrRatio >= 1 ? "#e3b341" : "#f85149"}
                      highlight />
                  ) : (
                    <ResultCard label="RISK/REWARD RATIO" value="– : –" sub="Isi Take Profit dulu" color="#484f58" />
                  )}
                </div>

                {/* RR quality indicator */}
                {calc.rrRatio > 0 && (
                  <div style={{
                    padding: "12px 16px", borderRadius: 10,
                    background: calc.rrRatio >= 2 ? "rgba(63,185,80,0.08)" : calc.rrRatio >= 1 ? "rgba(227,179,65,0.08)" : "rgba(248,81,73,0.08)",
                    border: `1px solid ${calc.rrRatio >= 2 ? "rgba(63,185,80,0.3)" : calc.rrRatio >= 1 ? "rgba(227,179,65,0.3)" : "rgba(248,81,73,0.3)"}`,
                    display: "flex", alignItems: "center", gap: 10,
                  }}>
                    <span style={{ fontSize: 20 }}>{calc.rrRatio >= 2 ? "✅" : calc.rrRatio >= 1 ? "⚠️" : "❌"}</span>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 800, color: calc.rrRatio >= 2 ? "#3fb950" : calc.rrRatio >= 1 ? "#e3b341" : "#f85149" }}>
                        {calc.rrRatio >= 3 ? "Setup Excellent — Layak dieksekusi" :
                         calc.rrRatio >= 2 ? "Setup Bagus — RR minimal terpenuhi" :
                         calc.rrRatio >= 1 ? "Setup Marginal — Pertimbangkan ulang" :
                         "Setup Buruk — RR < 1, hindari trade ini"}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        RR ideal minimum 1:2 · Sekarang 1:{calc.rrRatio.toFixed(1)}
                      </div>
                    </div>
                  </div>
                )}

                {/* Scenario table */}
                <div style={{ background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border)", overflow: "hidden" }}>
                  <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", fontSize: 11, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.08em" }}>
                    SKENARIO RISK
                  </div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: "var(--bg-tertiary)" }}>
                        {["Risk", "Lot", "Capital", "Max Loss"].map(h => (
                          <th key={h} style={{ padding: "8px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.06em" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {calc.scenarios.map((s, i) => (
                        <tr key={i} style={{
                          borderTop: "1px solid rgba(48,54,61,0.5)",
                          background: s.lots === calc.lots ? "rgba(47,129,247,0.06)" : "transparent",
                        }}>
                          <td style={{ padding: "8px 14px", color: s.lots === calc.lots ? "#58a6ff" : "var(--text-secondary)", fontWeight: s.lots === calc.lots ? 800 : 400 }}>{s.label}</td>
                          <td style={{ padding: "8px 14px", fontWeight: 800, color: "var(--text-primary)" }}>{s.lots} lot</td>
                          <td style={{ padding: "8px 14px", color: "var(--text-secondary)" }}>{fmt(s.capital)}</td>
                          <td style={{ padding: "8px 14px", color: "#f85149", fontWeight: 700 }}>{fmt(s.loss)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

              </div>
            )}
          </div>
        </div>

        <div style={{ marginTop: 20, fontSize: 11, color: "var(--text-muted)", textAlign: "center" }}>
          1 lot IDX = 100 saham · Hasil kalkulasi berdasarkan prinsip fixed fractional risk management
        </div>
      </main>
    </>
  );
}
