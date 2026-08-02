"use client";
import Navbar from "@/components/Navbar";
import TickerDetail from "@/TickerDetail_vps";
import { API_BASE } from "@/lib/apiConfig";
import { useState, useEffect, useRef, useMemo } from "react";

type FlowRow = {
  ticker: string;
  lastVal: string;
  days: number[];
  dailyChange: number;
  price: number;
};

type SortKey = "ticker" | "lastVal" | "day4" | "day3" | "day2" | "day1" | "day0" | "dailyChange" | "price";
type SortDir = "asc" | "desc";

// Parse lastVal strings like "1.7T", "807.9B", "23.4M" -> number (in billions)
function parseLastVal(s: string): number {
  if (!s) return 0;
  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  const u = s.slice(-1).toUpperCase();
  if (u === "T") return n * 1000;
  if (u === "B") return n;
  if (u === "M") return n / 1000;
  return n;
}

function pctColor(val: number) {
  if (val > 5)  return "#3fb950";
  if (val > 0)  return "#57ab5a";
  if (val < -5) return "#f85149";
  if (val < 0)  return "#e5534b";
  return "#8b949e";
}

function pctBg(val: number) {
  if (val > 5)  return "rgba(63,185,80,0.12)";
  if (val > 0)  return "rgba(63,185,80,0.06)";
  if (val < -5) return "rgba(248,81,73,0.12)";
  if (val < 0)  return "rgba(248,81,73,0.06)";
  return "transparent";
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <span style={{ opacity: 0.25, fontSize: 9, marginLeft: 3 }}>⇅</span>;
  return <span style={{ fontSize: 9, marginLeft: 3, color: "var(--accent-blue)" }}>{dir === "asc" ? "▲" : "▼"}</span>;
}

export default function FlowAnalyzer() {
  const [limit, setLimit]           = useState(20);
  const [data, setData]             = useState<FlowRow[]>([]);
  const [loading, setLoading]       = useState(true);
  const [meta, setMeta]             = useState<{ date?: string; source?: string }>({});
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  // Sort
  const [sortKey, setSortKey] = useState<SortKey>("day0");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Filters
  const [showFilters, setShowFilters]     = useState(false);
  const [filterTicker, setFilterTicker]   = useState("");
  const [filterMinVal, setFilterMinVal]   = useState("");
  const [filterMaxVal, setFilterMaxVal]   = useState("");
  const [filterMinDay0, setFilterMinDay0] = useState("");
  const [filterMaxDay0, setFilterMaxDay0] = useState("");
  const [filterMinChg, setFilterMinChg]   = useState("");
  const [filterMaxChg, setFilterMaxChg]   = useState("");

  useEffect(() => {
    setLoading(true);
    fetch(`${API_BASE}/api/flow-analyzer`)
      .then(r => r.json())
      .then(json => { setData(json.data || []); setMeta({ date: json.date, source: json.source }); })
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, []);

  const handleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  };

  const processed = useMemo(() => {
    let rows = [...data];
    if (filterTicker.trim()) rows = rows.filter(r => r.ticker.includes(filterTicker.trim().toUpperCase()));
    const mnV = parseFloat(filterMinVal), mxV = parseFloat(filterMaxVal);
    const mn0 = parseFloat(filterMinDay0), mx0 = parseFloat(filterMaxDay0);
    const mnC = parseFloat(filterMinChg),  mxC = parseFloat(filterMaxChg);
    if (!isNaN(mnV)) rows = rows.filter(r => parseLastVal(r.lastVal) >= mnV);
    if (!isNaN(mxV)) rows = rows.filter(r => parseLastVal(r.lastVal) <= mxV);
    if (!isNaN(mn0)) rows = rows.filter(r => (r.days[4] ?? 0) >= mn0);
    if (!isNaN(mx0)) rows = rows.filter(r => (r.days[4] ?? 0) <= mx0);
    if (!isNaN(mnC)) rows = rows.filter(r => r.dailyChange >= mnC);
    if (!isNaN(mxC)) rows = rows.filter(r => r.dailyChange <= mxC);

    const dayIdx: Record<string, number> = { day0: 4, day1: 3, day2: 2, day3: 1, day4: 0 };
    rows.sort((a, b) => {
      let va: number | string = 0, vb: number | string = 0;
      if (sortKey === "ticker")      { va = a.ticker;      vb = b.ticker; }
      else if (sortKey === "lastVal"){ va = parseLastVal(a.lastVal); vb = parseLastVal(b.lastVal); }
      else if (sortKey in dayIdx)    { va = a.days[dayIdx[sortKey]] ?? 0; vb = b.days[dayIdx[sortKey]] ?? 0; }
      else if (sortKey === "dailyChange") { va = a.dailyChange; vb = b.dailyChange; }
      else if (sortKey === "price")  { va = a.price;       vb = b.price; }
      if (va < vb) return sortDir === "asc" ? -1 : 1;
      if (va > vb) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return rows;
  }, [data, sortKey, sortDir, filterTicker, filterMinVal, filterMaxVal, filterMinDay0, filterMaxDay0, filterMinChg, filterMaxChg]);

  const displayed    = processed.slice(0, limit);
  const activeCount  = [filterTicker, filterMinVal, filterMaxVal, filterMinDay0, filterMaxDay0, filterMinChg, filterMaxChg].filter(Boolean).length;

  const clearFilters = () => { setFilterTicker(""); setFilterMinVal(""); setFilterMaxVal(""); setFilterMinDay0(""); setFilterMaxDay0(""); setFilterMinChg(""); setFilterMaxChg(""); };

  const handleRowClick = (ticker: string) => {
    if (selectedTicker === ticker) { setSelectedTicker(null); return; }
    setSelectedTicker(ticker);
    setTimeout(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  };

  // Sortable TH helper
  const Th = ({ k, children, style }: { k: SortKey; children: React.ReactNode; style?: React.CSSProperties }) => (
    <th
      onClick={() => handleSort(k)}
      style={{
        cursor: "pointer", userSelect: "none", whiteSpace: "nowrap",
        background: sortKey === k ? "rgba(47,129,247,0.1)" : undefined,
        transition: "background 0.15s", ...style,
      }}
    >
      {children} <SortIcon active={sortKey === k} dir={sortDir} />
    </th>
  );

  const dayKeys: SortKey[] = ["day4", "day3", "day2", "day1", "day0"];
  const dayLabels = ["DAY -4", "DAY -3", "DAY -2", "DAY -1", "DAY 0"];

  return (
    <>
      <Navbar />
      <main style={{ maxWidth: 1400, margin: "0 auto", padding: "32px 24px" }}>

        {/* Header */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <div style={{ width: 4, height: 32, background: "var(--accent-blue)", borderRadius: 2 }} />
            <h1 style={{ fontSize: 26, fontWeight: 900, color: "var(--text-primary)", margin: 0, fontFamily: "'Space Grotesk', sans-serif", letterSpacing: "0.04em" }}>
              FLOW ANALYZER
            </h1>
          </div>
          <p style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: 700, lineHeight: 1.6, margin: 0 }}>
            <strong style={{ color: "var(--accent-cyan)" }}>&quot;Deteksi Aliran Dana, Temukan Arah Harga.&quot;</strong>{" "}
            Flow Analyzer adalah fitur pemantauan real-time yang berfungsi membedakan antara saham yang sedang dikumpulkan (akumulasi) atau dilepas (distribusi) oleh pelaku pasar besar.
          </p>
        </div>

        {/* Status bar */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10, marginBottom: 10,
          background: "var(--bg-secondary)", border: "1px solid var(--border)",
          borderRadius: 8, padding: "10px 16px", flexWrap: "wrap",
        }}>
          <span className="pulse-dot" style={{
            width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
            background: meta.source === "database" ? "var(--accent-green)" : "var(--accent-blue)", display: "inline-block",
          }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", letterSpacing: "0.06em" }}>
            {loading ? "⏳ LOADING..." : `DATA PER [${(meta.date||"").toUpperCase()}] · SOURCE: ${(meta.source||"N/A").toUpperCase()}`}
          </span>
          {selectedTicker && (
            <span style={{ fontSize: 11, color: "var(--accent-cyan)", fontWeight: 700 }}>🔍 {selectedTicker}</span>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button onClick={() => setShowFilters(f => !f)} style={{
              fontSize: 11, fontWeight: 700, padding: "4px 14px", borderRadius: 6, cursor: "pointer",
              background: showFilters ? "rgba(47,129,247,0.15)" : "var(--bg-primary)",
              color: activeCount > 0 ? "var(--accent-blue)" : "var(--text-secondary)",
              border: `1px solid ${activeCount > 0 ? "var(--accent-blue)" : "var(--border)"}`,
            }}>
              🔽 FILTER {activeCount > 0 ? `(${activeCount})` : ""}
            </button>
            {activeCount > 0 && (
              <button onClick={clearFilters} style={{
                fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 6, cursor: "pointer",
                background: "rgba(248,81,73,0.1)", color: "var(--accent-red)", border: "1px solid rgba(248,81,73,0.3)",
              }}>✕ Clear</button>
            )}
          </div>
        </div>

        {/* Filter panel */}
        {showFilters && (
          <div style={{
            background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 8,
            padding: "14px 18px", marginBottom: 10,
            display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-end",
            animation: "slide-up 0.15s ease",
          }}>
            {[
              { label: "SEARCH TICKER",    val: filterTicker,   set: (v: string) => setFilterTicker(v.toUpperCase()),  ph: "BBCA",  w: 110, type: "text"   },
              { label: "LAST VAL MIN (B)", val: filterMinVal,   set: setFilterMinVal,   ph: "e.g. 10",  w: 105, type: "number", hint: "1B=1" },
              { label: "LAST VAL MAX (B)", val: filterMaxVal,   set: setFilterMaxVal,   ph: "e.g. 999", w: 105, type: "number" },
              { label: "DAY 0 MIN (%)",    val: filterMinDay0,  set: setFilterMinDay0,  ph: "-100", w: 90,  type: "number" },
              { label: "DAY 0 MAX (%)",    val: filterMaxDay0,  set: setFilterMaxDay0,  ph: "100",  w: 90,  type: "number" },
              { label: "DAILY CHG MIN (%)",val: filterMinChg,   set: setFilterMinChg,   ph: "-20",  w: 100, type: "number" },
              { label: "DAILY CHG MAX (%)",val: filterMaxChg,   set: setFilterMaxChg,   ph: "20",   w: 100, type: "number" },
            ].map(f => (
              <div key={f.label} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.08em" }}>{f.label}</label>
                <input
                  className="ft-input"
                  type={f.type}
                  placeholder={f.ph}
                  value={f.val}
                  onChange={e => f.set(e.target.value)}
                  style={{ padding: "5px 10px", fontSize: 12, width: f.w }}
                />
              </div>
            ))}
            <div style={{ fontSize: 11, color: "var(--text-muted)", paddingBottom: 4 }}>
              <div>→ <strong style={{ color: "var(--accent-blue)" }}>{processed.length}</strong> / {data.length} tickers</div>
              <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>Last Val: T=×1000B, B=×1, M=×0.001B</div>
            </div>
          </div>
        )}

        {/* Table */}
        <div className="card" style={{ overflow: "hidden", marginBottom: selectedTicker ? 0 : 16 }}>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table" style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <Th k="ticker">TICKER</Th>
                  <Th k="lastVal">LAST VAL</Th>
                  <th colSpan={5} style={{ textAlign: "center", borderLeft: "1px solid var(--border)" }}>
                    TOP 3 BROKER CONCENTRATION (%)
                  </th>
                  <Th k="dailyChange" style={{ borderLeft: "1px solid var(--border)" }}>DAILY CHANGE</Th>
                  <Th k="price">MARKET PRICE</Th>
                  <th style={{ textAlign: "center" }}>DETAIL</th>
                </tr>
                <tr style={{ background: "rgba(255,255,255,0.02)" }}>
                  <th /><th />
                  {dayKeys.map((k, i) => (
                    <th key={k} onClick={() => handleSort(k)} style={{
                      textAlign: "center", fontWeight: 700, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap",
                      color: sortKey === k ? "var(--accent-blue)" : "var(--text-muted)",
                      background: sortKey === k ? "rgba(47,129,247,0.1)" : undefined,
                      borderLeft: "1px solid var(--border)", transition: "background 0.15s",
                    }}>
                      {dayLabels[i]} <SortIcon active={sortKey === k} dir={sortDir} />
                    </th>
                  ))}
                  <th style={{ borderLeft: "1px solid var(--border)" }} /><th /><th />
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={10} style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>⏳ Loading data...</td></tr>
                ) : displayed.length === 0 ? (
                  <tr><td colSpan={10} style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>
                    {activeCount > 0 ? "🔍 No results match your filter." : "📭 No data available."}
                  </td></tr>
                ) : (
                  displayed.map((row, i) => {
                    const isSelected = selectedTicker === row.ticker;
                    const days5 = row.days.length >= 5 ? row.days : [...Array(5 - row.days.length).fill(0), ...row.days];
                    return (
                      <tr key={row.ticker} onClick={() => handleRowClick(row.ticker)} style={{
                        animation: `slide-up ${0.05 * i + 0.1}s ease both`,
                        background: isSelected ? "rgba(47,129,247,0.08)" : undefined,
                        cursor: "pointer", transition: "background 0.15s",
                        borderLeft: isSelected ? "3px solid var(--accent-blue)" : "3px solid transparent",
                      }}>
                        <td>
                          <span style={{ fontWeight: 800, fontSize: 14, fontFamily: "'Space Grotesk', sans-serif", color: isSelected ? "var(--accent-blue)" : "var(--text-primary)" }}>
                            {row.ticker}
                          </span>
                        </td>
                        <td style={{ color: "var(--text-secondary)", fontSize: 12 }}>{row.lastVal}</td>
                        {days5.map((d, di) => (
                          <td key={di} style={{ textAlign: "center", fontWeight: 700, fontSize: 13, color: pctColor(d), background: pctBg(d), borderLeft: "1px solid var(--border)" }}>
                            {d > 0 ? "+" : ""}{d.toFixed(2)}%
                          </td>
                        ))}
                        <td style={{ borderLeft: "1px solid var(--border)" }}>
                          <span style={{ fontWeight: 700, fontSize: 13, color: row.dailyChange > 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                            {row.dailyChange > 0 ? "+" : ""}{row.dailyChange.toFixed(2)}%
                          </span>
                        </td>
                        <td>
                          <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                            {row.price > 0 ? `Rp ${row.price.toLocaleString("id-ID")}` : "—"}
                          </span>
                        </td>
                        <td style={{ textAlign: "center" }}>
                          <span style={{
                            fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 4, whiteSpace: "nowrap",
                            background: isSelected ? "var(--accent-blue)" : "var(--bg-primary)",
                            color: isSelected ? "#fff" : "var(--accent-blue)",
                            border: `1px solid ${isSelected ? "var(--accent-blue)" : "var(--border)"}`,
                          }}>
                            {isSelected ? "▲ OPEN" : "▼ DETAIL"}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Footer */}
          <div style={{
            borderTop: "1px solid var(--border)", padding: "12px 20px",
            display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", letterSpacing: "0.06em" }}>VIEW LIMIT:</span>
              <select className="ft-input" value={limit} onChange={e => setLimit(Number(e.target.value))} style={{ padding: "4px 10px", fontSize: 12 }}>
                {[10, 20, 50, 100, 999].map(n => <option key={n} value={n}>{n === 999 ? "All" : `${n} Tickers`}</option>)}
              </select>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                Showing <strong style={{ color: "var(--text-primary)" }}>{displayed.length}</strong> of{" "}
                <strong style={{ color: "var(--accent-blue)" }}>{processed.length}</strong>
                {processed.length !== data.length && <span style={{ color: "var(--accent-blue)" }}> (filtered from {data.length})</span>}
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {selectedTicker && (
                <button onClick={() => setSelectedTicker(null)} style={{
                  fontSize: 11, padding: "4px 12px", borderRadius: 4, cursor: "pointer",
                  background: "rgba(248,81,73,0.12)", color: "var(--accent-red)",
                  border: "1px solid rgba(248,81,73,0.3)", fontWeight: 700,
                }}>✕ Close Detail</button>
              )}
              <div className="card" style={{ padding: "4px 14px", fontSize: 11, fontWeight: 700, color: "var(--accent-blue)", letterSpacing: "0.06em" }}>
                SORTED: {sortKey.toUpperCase()} {sortDir === "desc" ? "▼" : "▲"} · {data.length} TICKERS
              </div>
            </div>
          </div>
        </div>

        {/* Detail panel */}
        {selectedTicker && (
          <div ref={detailRef} className="card" style={{
            padding: 24, marginTop: 16,
            borderColor: "rgba(47,129,247,0.3)",
            background: "rgba(47,129,247,0.03)",
            animation: "slide-up 0.25s ease",
          }}>
            <TickerDetail ticker={selectedTicker} onClose={() => setSelectedTicker(null)} />
          </div>
        )}

        {/* Legend */}
        {!selectedTicker && (
          <div style={{ marginTop: 16, display: "flex", gap: 20, flexWrap: "wrap" }}>
            {[
              { color: "#3fb950", label: "Akumulasi kuat (>+5%)" },
              { color: "#57ab5a", label: "Akumulasi (0% ~ +5%)" },
              { color: "#e5534b", label: "Distribusi (0% ~ -5%)" },
              { color: "#f85149", label: "Distribusi kuat (<-5%)" },
            ].map(l => (
              <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 12, height: 12, borderRadius: 3, background: l.color }} />
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{l.label}</span>
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
