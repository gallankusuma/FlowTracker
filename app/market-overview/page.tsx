"use client";
import { useState, useEffect, useCallback } from "react";
import { API_BASE } from "@/lib/apiConfig";

// IDX Sector mapping
const IDX_SECTORS: Record<string, string[]> = {
  "Banking": ["BBCA","BBRI","BMRI","BBNI","BNGA","BNII","BDMN","BJBR","BJTM","BBTN"],
  "Mining & Energy": ["ADRO","PTBA","ITMG","INCO","ANTM","MDKA","AMMN","BUMI","MEDC","INDY"],
  "Consumer": ["ICBP","MYOR","UNVR","KLBF","SIDO","CPIN","JPFA","HRUM","GGRM","HMSP"],
  "Infrastructure": ["TLKM","EXCL","ISAT","JSMR","WIKA","WSKT","PTPP","ADHI","TOWR"],
  "Property & Finance": ["SMRA","LPKR","BSDE","PWON","ASII","AALI","LSIP","BRPT","TPIA"],
  "Others": ["GOTO","BREN","EMTK","DMMX","FILM"],
};

const ALL_TRACKED = Object.values(IDX_SECTORS).flat();

function signalColor(days: number[]): string {
  if (!days || days.length === 0) return "#484f58";
  const sum = days.reduce((a, b) => a + b, 0);
  const avg = sum / days.length;
  if (avg > 8)  return "#2ea043";
  if (avg > 3)  return "#3fb950";
  if (avg > 0)  return "#4ec9b0";
  if (avg > -3) return "#e06c75";
  if (avg > -8) return "#f85149";
  return "#ff0000";
}

function signalBg(days: number[]): string {
  const col = signalColor(days);
  return col + "22";
}

function flowLabel(days: number[]): string {
  if (!days || days.length === 0) return "—";
  const sum = days.reduce((a, b) => a + b, 0);
  const avg = sum / days.length;
  if (avg > 8)  return "STRONG BUY";
  if (avg > 3)  return "ACCUM";
  if (avg > 0)  return "MILD BUY";
  if (avg > -3) return "MILD SELL";
  if (avg > -8) return "DISTRIB";
  return "STRONG SELL";
}

export default function MarketOverviewPage() {
  const [flowData, setFlowData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<string>("");
  const [sortBy, setSortBy] = useState<"flow"|"price"|"change">("flow");
  const [viewMode, setViewMode] = useState<"sector"|"list">("sector");
  const [filter, setFilter] = useState<"all"|"buy"|"sell">("all");

  const fetchData = useCallback(() => {
    setLoading(true);
    fetch(`${API_BASE}/api/flow-analyzer`)
      .then(r => r.json())
      .then(json => {
        if (json.data) {
          setFlowData(json.data);
          setLastUpdate(new Date().toLocaleTimeString("id-ID"));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => {
    const interval = setInterval(fetchData, 5 * 60 * 1000); // refresh every 5min
    return () => clearInterval(interval);
  }, [fetchData]);

  const dataMap: Record<string, any> = {};
  flowData.forEach(d => { dataMap[d.ticker] = d; });

  const filteredFlow = flowData.filter(d => {
    if (filter === "all") return true;
    const avg = d.days ? d.days.reduce((a: number, b: number) => a + b, 0) / d.days.length : 0;
    if (filter === "buy")  return avg > 0;
    if (filter === "sell") return avg < 0;
    return true;
  });

  const sorted = [...filteredFlow].sort((a, b) => {
    if (sortBy === "flow") {
      const aAvg = a.days ? a.days.reduce((s: number, v: number) => s + v, 0) / a.days.length : 0;
      const bAvg = b.days ? b.days.reduce((s: number, v: number) => s + v, 0) / b.days.length : 0;
      return bAvg - aAvg;
    }
    if (sortBy === "change") return (b.dailyChange || 0) - (a.dailyChange || 0);
    return (b.price || 0) - (a.price || 0);
  });

  const totalAccum = flowData.filter(d => {
    const avg = d.days ? d.days.reduce((a: number, b: number) => a + b, 0) / d.days.length : 0;
    return avg > 0;
  }).length;

  return (
    <div style={{ minHeight: "100vh", background: "#0d1117", fontFamily: "'Inter', sans-serif", padding: "20px 24px" }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 900, color: "#e6edf3", margin: 0, letterSpacing: "-0.5px" }}>
              IDX Market Overview
            </h1>
            <div style={{ fontSize: 11, color: "#484f58", marginTop: 4 }}>
              Broker flow heatmap · {flowData.length} stocks tracked
              {lastUpdate && <span style={{ marginLeft: 10, color: "#3fb950" }}>● Updated {lastUpdate}</span>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {/* Market Sentiment */}
            <div style={{ padding: "8px 16px", borderRadius: 10, border: "1px solid #21262d", background: "#161b22", textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "#484f58", fontWeight: 700, letterSpacing: "0.06em" }}>ACCUM</div>
              <div style={{ fontSize: 20, fontWeight: 900, color: "#3fb950" }}>{totalAccum}</div>
            </div>
            <div style={{ padding: "8px 16px", borderRadius: 10, border: "1px solid #21262d", background: "#161b22", textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "#484f58", fontWeight: 700, letterSpacing: "0.06em" }}>DISTRIB</div>
              <div style={{ fontSize: 20, fontWeight: 900, color: "#f85149" }}>{flowData.length - totalAccum}</div>
            </div>
            <button onClick={fetchData} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #30363d", background: "rgba(255,255,255,0.06)", color: "#8b949e", fontSize: 11, cursor: "pointer", fontWeight: 700 }}>
              ↻ Refresh
            </button>
          </div>
        </div>

        {/* Controls */}
        <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap", alignItems: "center" }}>
          {/* View toggle */}
          <div style={{ display: "flex", gap: 4, background: "#161b22", borderRadius: 8, padding: 3, border: "1px solid #21262d" }}>
            {(["sector","list"] as const).map(v => (
              <button key={v} onClick={() => setViewMode(v)} style={{
                padding: "4px 12px", borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: "pointer", border: "none",
                background: viewMode === v ? "#21262d" : "transparent",
                color: viewMode === v ? "#e6edf3" : "#6e7681",
              }}>{v === "sector" ? "⊞ SECTOR" : "≡ LIST"}</button>
            ))}
          </div>
          {/* Filter */}
          <div style={{ display: "flex", gap: 4, background: "#161b22", borderRadius: 8, padding: 3, border: "1px solid #21262d" }}>
            {(["all","buy","sell"] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)} style={{
                padding: "4px 12px", borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: "pointer", border: "none",
                background: filter === f ? (f==="buy"?"rgba(63,185,80,0.2)":f==="sell"?"rgba(248,81,73,0.2)":"#21262d") : "transparent",
                color: filter === f ? (f==="buy"?"#3fb950":f==="sell"?"#f85149":"#e6edf3") : "#6e7681",
              }}>{f.toUpperCase()}</button>
            ))}
          </div>
          {/* Sort */}
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "#484f58", fontWeight: 700 }}>SORT:</span>
            {(["flow","change","price"] as const).map(s => (
              <button key={s} onClick={() => setSortBy(s)} style={{
                padding: "4px 10px", borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: "pointer",
                background: sortBy === s ? "#2f81f7" : "rgba(255,255,255,0.05)",
                color: sortBy === s ? "#fff" : "#6e7681", border: "none",
              }}>{s.toUpperCase()}</button>
            ))}
          </div>
        </div>
      </div>

      {loading && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 200, color: "#484f58", fontSize: 13 }}>
          Loading market data...
        </div>
      )}

      {/* SECTOR VIEW */}
      {!loading && viewMode === "sector" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {Object.entries(IDX_SECTORS).map(([sector, tickers]) => {
            const sectorData = tickers.map(t => dataMap[t]).filter(Boolean);
            if (sectorData.length === 0) return null;
            const sectorAvg = sectorData.length > 0
              ? sectorData.reduce((s, d) => s + (d.days ? d.days.reduce((a: number, b: number) => a + b, 0) / d.days.length : 0), 0) / sectorData.length
              : 0;
            return (
              <div key={sector} style={{ background: "#161b22", borderRadius: 14, border: "1px solid #21262d", overflow: "hidden" }}>
                {/* Sector header */}
                <div style={{ padding: "12px 20px", borderBottom: "1px solid #21262d", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 4, height: 18, borderRadius: 2, background: sectorAvg > 0 ? "#3fb950" : "#f85149" }} />
                    <span style={{ fontSize: 13, fontWeight: 800, color: "#e6edf3" }}>{sector}</span>
                    <span style={{ fontSize: 10, color: "#484f58" }}>{sectorData.length} stocks</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: sectorAvg > 0 ? "#3fb950" : "#f85149" }}>
                      {sectorAvg > 0 ? "+" : ""}{sectorAvg.toFixed(1)}% avg flow
                    </span>
                    <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 5, fontWeight: 700,
                      background: sectorAvg > 0 ? "rgba(63,185,80,0.15)" : "rgba(248,81,73,0.15)",
                      color: sectorAvg > 0 ? "#3fb950" : "#f85149" }}>
                      {sectorAvg > 0 ? "ACCUMULATION" : "DISTRIBUTION"}
                    </span>
                  </div>
                </div>
                {/* Stock grid */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 1, background: "#21262d" }}>
                  {tickers.map(ticker => {
                    const d = dataMap[ticker];
                    if (!d) return (
                      <div key={ticker} style={{ background: "#161b22", padding: "10px 12px", opacity: 0.3 }}>
                        <div style={{ fontSize: 11, fontWeight: 800, color: "#484f58" }}>{ticker}</div>
                        <div style={{ fontSize: 9, color: "#484f58" }}>No data</div>
                      </div>
                    );
                    const avg = d.days ? d.days.reduce((a: number, b: number) => a + b, 0) / d.days.length : 0;
                    const chg = d.dailyChange || 0;
                    return (
                      <a key={ticker} href={`/ticker/${ticker}`} style={{ textDecoration: "none" }}>
                        <div style={{
                          background: signalBg(d.days),
                          padding: "12px 14px",
                          cursor: "pointer",
                          transition: "all 0.15s",
                          borderLeft: `3px solid ${signalColor(d.days)}`,
                        }}
                          onMouseEnter={e => (e.currentTarget.style.filter = "brightness(1.3)")}
                          onMouseLeave={e => (e.currentTarget.style.filter = "brightness(1)")}
                        >
                          <div style={{ fontSize: 12, fontWeight: 900, color: "#e6edf3", marginBottom: 2 }}>{ticker}</div>
                          <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>
                            Rp {(d.price || 0).toLocaleString("id-ID")}
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span style={{ fontSize: 9, fontWeight: 700, color: signalColor(d.days) }}>
                              {flowLabel(d.days)}
                            </span>
                            <span style={{ fontSize: 9, fontWeight: 700, color: chg >= 0 ? "#3fb950" : "#f85149" }}>
                              {chg >= 0 ? "+" : ""}{chg.toFixed(1)}%
                            </span>
                          </div>
                          {/* Mini 5-day flow bar */}
                          <div style={{ display: "flex", gap: 1, marginTop: 5 }}>
                            {(d.days || []).map((v: number, i: number) => (
                              <div key={i} style={{
                                flex: 1, height: 3, borderRadius: 2,
                                background: v > 0 ? `rgba(63,185,80,${Math.min(Math.abs(v)/20, 1)})` : `rgba(248,81,73,${Math.min(Math.abs(v)/20, 1)})`,
                              }} />
                            ))}
                          </div>
                        </div>
                      </a>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* LIST VIEW */}
      {!loading && viewMode === "list" && (
        <div style={{ background: "#161b22", borderRadius: 14, border: "1px solid #21262d", overflow: "hidden" }}>
          {/* Table header */}
          <div style={{ display: "grid", gridTemplateColumns: "100px 90px 80px 80px 1fr 100px", gap: 0, padding: "10px 20px", borderBottom: "1px solid #21262d", background: "#0d1117" }}>
            {["TICKER","PRICE","CHG%","FLOW","5D TREND","SIGNAL"].map(h => (
              <div key={h} style={{ fontSize: 9, color: "#484f58", fontWeight: 800, letterSpacing: "0.08em" }}>{h}</div>
            ))}
          </div>
          {sorted.map((d, i) => {
            const avg = d.days ? d.days.reduce((a: number, b: number) => a + b, 0) / d.days.length : 0;
            const chg = d.dailyChange || 0;
            return (
              <a key={d.ticker} href={`/ticker/${d.ticker}`} style={{ textDecoration: "none" }}>
                <div style={{
                  display: "grid", gridTemplateColumns: "100px 90px 80px 80px 1fr 100px",
                  padding: "10px 20px", borderBottom: "1px solid rgba(33,38,45,0.5)",
                  background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)",
                  transition: "background 0.1s", cursor: "pointer",
                  alignItems: "center",
                }}
                  onMouseEnter={e => (e.currentTarget.style.background = "rgba(47,129,247,0.05)")}
                  onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)")}
                >
                  <div style={{ fontSize: 12, fontWeight: 800, color: "#e6edf3" }}>{d.ticker}</div>
                  <div style={{ fontSize: 11, color: "#8b949e" }}>Rp {(d.price||0).toLocaleString("id-ID")}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: chg >= 0 ? "#3fb950" : "#f85149" }}>
                    {chg >= 0 ? "+" : ""}{chg.toFixed(2)}%
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: avg >= 0 ? "#3fb950" : "#f85149" }}>
                    {avg >= 0 ? "+" : ""}{avg.toFixed(1)}%
                  </div>
                  {/* 5D mini bars */}
                  <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 20 }}>
                    {(d.days || []).map((v: number, j: number) => {
                      const h = Math.max(Math.min(Math.abs(v) * 1.2, 20), 2);
                      return (
                        <div key={j} style={{
                          width: 6, height: h, borderRadius: 2,
                          background: v > 0 ? "#3fb950" : "#f85149",
                          opacity: 0.7 + j * 0.06,
                        }} />
                      );
                    })}
                  </div>
                  <div style={{
                    fontSize: 9, fontWeight: 800, padding: "3px 8px", borderRadius: 5,
                    background: signalBg(d.days), color: signalColor(d.days),
                    border: `1px solid ${signalColor(d.days)}40`,
                    display: "inline-block",
                  }}>{flowLabel(d.days)}</div>
                </div>
              </a>
            );
          })}
        </div>
      )}

      {/* Legend */}
      <div style={{ marginTop: 20, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 10, color: "#484f58", fontWeight: 700 }}>FLOW LEGEND:</span>
        {[
          { label: "STRONG BUY", color: "#2ea043" },
          { label: "ACCUM", color: "#3fb950" },
          { label: "MILD BUY", color: "#4ec9b0" },
          { label: "MILD SELL", color: "#e06c75" },
          { label: "DISTRIB", color: "#f85149" },
          { label: "STRONG SELL", color: "#ff0000" },
        ].map(({ label, color }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
            <span style={{ fontSize: 9, color: "#6e7681", fontWeight: 700 }}>{label}</span>
          </div>
        ))}
        <span style={{ fontSize: 9, color: "#484f58", marginLeft: "auto" }}>Data: Broker flow via flowtracker · Refreshes every 5 min</span>
      </div>
    </div>
  );
}
