"use client";
import Navbar from "@/components/Navbar";
import { API_BASE } from "@/lib/apiConfig";
import TickerDetail from "@/components/TickerDetail";
import { useState, useEffect } from "react";

type FlowRow = {
  ticker: string;
  lastVal: string;
  days: number[];
  dailyChange: number;
  price: number;
};

function pctColor(val: number) {
  if (val > 5) return "#3fb950";
  if (val > 0) return "#57ab5a";
  if (val < -5) return "#f85149";
  if (val < 0) return "#e5534b";
  return "#8b949e";
}

function pctBg(val: number) {
  if (val > 5)  return "rgba(63,185,80,0.12)";
  if (val > 0)  return "rgba(63,185,80,0.06)";
  if (val < -5) return "rgba(248,81,73,0.12)";
  if (val < 0)  return "rgba(248,81,73,0.06)";
  return "transparent";
}

export default function FlowAnalyzer() {
  const [limit, setLimit] = useState(10);
  const [data, setData] = useState<FlowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [meta, setMeta] = useState<{ date?: string; source?: string }>({});
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`${API_BASE}/api/flow-analyzer`)
      .then(r => r.json())
      .then(json => {
        setData(json.data || []);
        setMeta({ date: json.date, source: json.source });
      })
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, []);

  const displayed = data.slice(0, limit);

  return (
    <>
      <Navbar />
      <main style={{ maxWidth: 1400, margin: "0 auto", padding: "32px 24px" }}>

        {/* Page header */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <div style={{ width: 4, height: 32, background: "var(--accent-blue)", borderRadius: 2 }}></div>
            <h1 style={{ fontSize: 26, fontWeight: 900, color: "var(--text-primary)", margin: 0,
              fontFamily: "'Space Grotesk', sans-serif", letterSpacing: "0.04em" }}>
              FLOW ANALYZER
            </h1>
          </div>
          <p style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: 700, lineHeight: 1.6, margin: 0 }}>
            <strong style={{ color: "var(--accent-cyan)" }}>&quot;Deteksi Aliran Dana, Temukan Arah Harga.&quot;</strong>{" "}
            Flow Analyzer adalah fitur pemantauan real-time yang berfungsi membedakan antara saham yang sedang dikumpulkan (akumulasi) atau dilepas (distribusi) oleh pelaku pasar besar.
            <strong style={{ color: "var(--accent-blue)" }}> Klik ticker untuk melihat detail.</strong>
          </p>
        </div>

        {/* Data source badge */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16,
          background: "var(--bg-secondary)", border: "1px solid var(--border)",
          borderRadius: 8, padding: "10px 16px" }}>
          <span className="pulse-dot" style={{ width: 8, height: 8, borderRadius: "50%",
            background: meta.source === "database" ? "var(--accent-green)" : "var(--accent-blue)",
            display: "inline-block", flexShrink: 0 }}></span>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", letterSpacing: "0.06em" }}>
            {loading ? "⏳ LOADING..." : `DATA PER [${(meta.date || "").toUpperCase()}] · SOURCE: ${(meta.source || "N/A").toUpperCase()}`}
          </span>
        </div>

        {/* Main table card */}
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table" style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th>TICKER</th>
                  <th>LAST VAL</th>
                  <th colSpan={5} style={{ textAlign: "center", borderLeft: "1px solid var(--border)" }}>
                    TOP 3 BROKER CONCENTRATION (%)
                  </th>
                  <th style={{ borderLeft: "1px solid var(--border)" }}>DAILY CHANGE</th>
                  <th>MARKET PRICE</th>
                </tr>
                <tr style={{ background: "rgba(255,255,255,0.02)" }}>
                  <th></th><th></th>
                  {["DAY -4","DAY -3","DAY -2","DAY -1","DAY 0"].map(d => (
                    <th key={d} style={{ textAlign: "center", fontWeight: 700, color: "var(--text-muted)", borderLeft: "1px solid var(--border)" }}>{d}</th>
                  ))}
                  <th style={{ borderLeft: "1px solid var(--border)" }}></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={9} style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>
                    ⏳ Loading data from VPS...
                  </td></tr>
                ) : displayed.length === 0 ? (
                  <tr><td colSpan={9} style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>
                    📭 No data available. Upload broker data via Admin panel first.
                  </td></tr>
                ) : (
                  displayed.map((row, i) => (
                    <tr key={row.ticker}
                      onClick={() => setSelectedTicker(selectedTicker === row.ticker ? null : row.ticker)}
                      style={{
                        animation: `slide-up ${0.05 * i + 0.1}s ease both`,
                        cursor: "pointer",
                        background: selectedTicker === row.ticker ? "rgba(47,129,247,0.08)" : undefined,
                        transition: "background 0.2s",
                      }}
                      onMouseEnter={(e) => { if (selectedTicker !== row.ticker) e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
                      onMouseLeave={(e) => { if (selectedTicker !== row.ticker) e.currentTarget.style.background = ""; }}
                    >
                      <td>
                        <span style={{ fontWeight: 800, fontSize: 14, color: selectedTicker === row.ticker ? "var(--accent-blue)" : "var(--text-primary)",
                          fontFamily: "'Space Grotesk', sans-serif", transition: "color 0.2s" }}>
                          {selectedTicker === row.ticker ? "▸ " : ""}{row.ticker}
                        </span>
                      </td>
                      <td style={{ color: "var(--text-secondary)", fontSize: 12 }}>{row.lastVal}</td>
                      {(row.days.length >= 5 ? row.days : [...Array(5 - row.days.length).fill(0), ...row.days]).map((d, di) => (
                        <td key={di} style={{
                          textAlign: "center", fontWeight: 700, fontSize: 13,
                          color: pctColor(d), background: pctBg(d),
                          borderLeft: "1px solid var(--border)",
                        }}>
                          {d > 0 ? "+" : ""}{d.toFixed(2)}%
                        </td>
                      ))}
                      <td style={{ borderLeft: "1px solid var(--border)" }}>
                        <span style={{ fontWeight: 700, fontSize: 13,
                          color: row.dailyChange > 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                          {row.dailyChange > 0 ? "+" : ""}{row.dailyChange.toFixed(2)}%
                        </span>
                      </td>
                      <td>
                        <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                          {row.price > 0 ? `Rp ${row.price.toLocaleString("id-ID")}` : "—"}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination footer */}
          <div style={{ borderTop: "1px solid var(--border)", padding: "12px 20px",
            display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", letterSpacing: "0.06em" }}>VIEW LIMIT:</span>
              <select className="ft-input" value={limit} onChange={e => setLimit(Number(e.target.value))}
                style={{ padding: "4px 10px", fontSize: 12 }}>
                {[5, 10, 20].map(n => (
                  <option key={n} value={n}>{n} Tickers</option>
                ))}
              </select>
            </div>
            <div className="card" style={{ padding: "4px 14px", fontSize: 11, fontWeight: 700,
              color: "var(--accent-blue)", letterSpacing: "0.06em" }}>
              MATRIX SIZE: {data.length} ACTIVE TICKERS
            </div>
          </div>
        </div>

        {/* Legend */}
        <div style={{ marginTop: 16, display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 24 }}>
          {[
            { color: "#3fb950", label: "Akumulasi kuat (>+5%)" },
            { color: "#57ab5a", label: "Akumulasi (0% ~ +5%)" },
            { color: "#e5534b", label: "Distribusi (0% ~ -5%)" },
            { color: "#f85149", label: "Distribusi kuat (<-5%)" },
          ].map(l => (
            <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ width: 12, height: 12, borderRadius: 3, background: l.color }}></div>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{l.label}</span>
            </div>
          ))}
        </div>

        {/* Ticker Detail Section */}
        {selectedTicker && (
          <TickerDetail ticker={selectedTicker} onClose={() => setSelectedTicker(null)} />
        )}
      </main>
    </>
  );
}
