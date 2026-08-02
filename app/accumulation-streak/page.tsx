"use client";
import Navbar from "@/components/Navbar";
import { API_BASE } from "@/lib/apiConfig";
import { useState, useEffect } from "react";

type AccRow = {
  stockCode: string;
  lastPrice: number;
  lastValue: string;
  buyers: { code: string; bVal: string; bLot: string; avg: number; gainPct: number }[];
  sellers: { code: string; sVal: string; sLot: string; avg: number }[];
};

const DAY_TABS = [2, 3, 4, 5];

export default function AccumulationStreak() {
  const [days, setDays] = useState(2);
  const [retailToggle, setRetailToggle] = useState(false);
  const [data, setData] = useState<AccRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [meta, setMeta] = useState<{ source?: string; dates?: string[] }>({});

  useEffect(() => {
    setLoading(true);
    fetch(`${API_BASE}/api/accumulation-streak?days=${days}`)
      .then(r => r.json())
      .then(json => {
        setData(json.data || []);
        setMeta({ source: json.source, dates: json.dates });
      })
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [days]);

  return (
    <>
      <Navbar />
      <main style={{ maxWidth: 1400, margin: "0 auto", padding: "32px 24px" }}>
        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <div style={{ width: 4, height: 32, background: "var(--accent-green)", borderRadius: 2 }}></div>
            <h1 style={{ fontSize: 26, fontWeight: 900, color: "var(--text-primary)", margin: 0,
              fontFamily: "'Space Grotesk', sans-serif", letterSpacing: "0.04em" }}>
              ACCUMULATION STREAK
            </h1>
          </div>
          <p style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: 760, lineHeight: 1.6, margin: 0 }}>
            <strong style={{ color: "var(--accent-cyan)" }}>&quot;Temukan Saham yang Sedang Dikumpulkan Secara Diam-diam.&quot;</strong>{" "}
            Accumulation Streak dirancang khusus untuk mendeteksi strategi akumulasi halus yang dilakukan oleh broker tertentu dalam rentang waktu 2 hingga 5 hari berturut-turut.
          </p>
        </div>

        {/* Filters */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)", letterSpacing: "0.08em" }}>
              SOURCE: {(meta.source || "loading").toUpperCase()}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", letterSpacing: "0.06em", marginRight: 4 }}>LAST:</span>
              {DAY_TABS.map(d => (
                <button key={d} className={`pill-btn ${days === d ? "active" : ""}`}
                  onClick={() => setDays(d)}>
                  {d} DAYS
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.08em" }}>
              RETAIL AS SELLER STREAK
            </span>
            <div onClick={() => setRetailToggle(!retailToggle)}
              style={{ width: 40, height: 22, borderRadius: 11,
                background: retailToggle ? "var(--accent-blue)" : "var(--border)",
                position: "relative", cursor: "pointer", transition: "background 0.2s" }}>
              <div style={{ width: 16, height: 16, borderRadius: "50%", background: "#fff",
                position: "absolute", top: 3, left: retailToggle ? 21 : 3, transition: "left 0.2s" }}></div>
            </div>
          </div>
        </div>

        {/* Main table */}
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table" style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th style={{ width: 140 }}>STOCK CODE</th>
                  <th>LAST PRICE</th>
                  <th>LAST VALUE ↓</th>
                  <th>TOP BUYER</th>
                  <th>B. VAL</th>
                  <th>B. LOT</th>
                  <th>AVG</th>
                  <th>BUYER % GAIN</th>
                  <th style={{ borderLeft: "1px solid var(--border)" }}>TOP SELLER</th>
                  <th>S. VAL</th>
                  <th>S. LOT</th>
                  <th>AVG</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={12} style={{ textAlign: "center", color: "var(--text-muted)", padding: 40 }}>
                    ⏳ Analyzing {days}-day accumulation patterns...
                  </td></tr>
                ) : data.length === 0 ? (
                  <tr><td colSpan={12} style={{ textAlign: "center", color: "var(--text-muted)", padding: 32 }}>
                    📭 Tidak ada data akumulasi untuk {days} hari berturut-turut. Upload lebih banyak data via Admin.
                  </td></tr>
                ) : (
                  data.map((stock, si) =>
                    stock.buyers.map((buyer, bi) => {
                      const seller = stock.sellers[bi];
                      const isFirst = bi === 0;
                      return (
                        <tr key={`${stock.stockCode}-${bi}`} style={{
                          animation: `slide-up ${0.05 * (si + bi) + 0.1}s ease both`,
                          borderTop: isFirst ? "2px solid rgba(47,129,247,0.2)" : undefined,
                        }}>
                          {isFirst && (
                            <>
                              <td rowSpan={stock.buyers.length} style={{ verticalAlign: "middle" }}>
                                <span style={{ fontSize: 16, fontWeight: 900, color: "var(--text-primary)",
                                  fontFamily: "'Space Grotesk', sans-serif" }}>{stock.stockCode}</span>
                              </td>
                              <td rowSpan={stock.buyers.length} style={{ verticalAlign: "middle" }}>
                                <span style={{ fontWeight: 700 }}>
                                  {stock.lastPrice > 0 ? stock.lastPrice.toLocaleString("id-ID") : "—"}
                                </span>
                              </td>
                              <td rowSpan={stock.buyers.length} style={{ verticalAlign: "middle" }}>
                                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{stock.lastValue}</span>
                              </td>
                            </>
                          )}
                          <td><span className="broker-buy">{buyer.code}</span></td>
                          <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>{buyer.bVal}</td>
                          <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>{buyer.bLot}</td>
                          <td style={{ fontSize: 12 }}>{buyer.avg > 0 ? buyer.avg.toLocaleString("id-ID") : "—"}</td>
                          <td>
                            <span style={{ fontWeight: 700, fontSize: 12,
                              color: buyer.gainPct >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                              {buyer.gainPct >= 0 ? "+" : ""}{buyer.gainPct.toFixed(2)}%
                            </span>
                          </td>
                          {seller ? (
                            <>
                              <td style={{ borderLeft: "1px solid var(--border)" }}>
                                <span className="broker-sell">{seller.code}</span>
                              </td>
                              <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>{seller.sVal}</td>
                              <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>{seller.sLot}</td>
                              <td style={{ fontSize: 12 }}>{seller.avg > 0 ? seller.avg.toLocaleString("id-ID") : "—"}</td>
                            </>
                          ) : (
                            <td colSpan={4} style={{ borderLeft: "1px solid var(--border)",
                              color: "var(--text-muted)", fontSize: 12, textAlign: "center" }}>—</td>
                          )}
                        </tr>
                      );
                    })
                  )
                )}
              </tbody>
            </table>
          </div>

          {/* Footer */}
          <div style={{ borderTop: "1px solid var(--border)", padding: "12px 20px",
            display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {data.length} stocks with {days}-day streak detected
            </span>
            <div className="card" style={{ padding: "4px 14px", fontSize: 11, fontWeight: 700,
              color: meta.source === "database" ? "var(--accent-green)" : "var(--accent-blue)",
              letterSpacing: "0.06em" }}>
              {meta.source === "database" ? "🟢 LIVE DATA" : "🔵 MOCK DATA"}
            </div>
          </div>
        </div>

        {/* Legend */}
        <div style={{ marginTop: 16, display: "flex", gap: 24, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 28, height: 16, borderRadius: 4, background: "rgba(188,140,255,0.2)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 10, fontWeight: 800, color: "#bc8cff" }}>AK</span>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Foreign / Institusi</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 28, height: 16, borderRadius: 4, background: "rgba(240,136,62,0.2)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 10, fontWeight: 800, color: "#f0883e" }}>MG</span>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Domestik</span>
          </div>
        </div>
      </main>
    </>
  );
}
