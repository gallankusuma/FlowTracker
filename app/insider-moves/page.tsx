"use client";
import Navbar from "@/components/Navbar";
import { insiderMovesData, TODAY } from "@/lib/mockData";
import { useState } from "react";

export default function InsiderMoves() {
  const [reportDate, setReportDate] = useState(TODAY);
  const [search, setSearch] = useState("");
  const [searchMode, setSearchMode] = useState("ALL");

  const filtered = insiderMovesData.filter(row => {
    if (!search) return true;
    if (searchMode === "TICKER") return row.ticker.toLowerCase().includes(search.toLowerCase());
    if (searchMode === "NAME")   return row.name.toLowerCase().includes(search.toLowerCase());
    return row.ticker.toLowerCase().includes(search.toLowerCase()) ||
           row.name.toLowerCase().includes(search.toLowerCase());
  });

  return (
    <>
      <Navbar />
      <main style={{ maxWidth: 1400, margin: "0 auto", padding: "32px 24px" }}>

        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <div style={{ width: 4, height: 32, background: "var(--accent-purple)", borderRadius: 2 }}></div>
            <h1 style={{ fontSize: 26, fontWeight: 900, color: "var(--text-primary)", margin: 0,
              fontFamily: "'Space Grotesk', sans-serif", letterSpacing: "0.04em" }}>
              INSIDER MOVES
            </h1>
          </div>
          <p style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: 700, lineHeight: 1.6, margin: 0 }}>
            <strong style={{ color: "var(--accent-cyan)" }}>"Ikuti Jejak Keputusan Orang Dalam."</strong>{" "}
            Insider Moves adalah fitur eksklusif yang memantau setiap perubahan kepemilikan saham oleh jajaran Direksi, Komisaris, dan Pemegang Saham Pengendali secara harian berdasarkan data resmi KSEI.
          </p>
        </div>

        {/* Filters */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
          <div>
            <label style={{ fontSize: 11, color: "var(--text-muted)", letterSpacing: "0.08em",
              display: "block", marginBottom: 4 }}>REPORT DATE</label>
            <input type="date" className="ft-input" value={reportDate}
              onChange={e => setReportDate(e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: "var(--text-muted)", letterSpacing: "0.08em",
              display: "block", marginBottom: 4 }}>FILTER RESULTS</label>
            <input className="ft-input" placeholder="Search ticker, name..." value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ width: 220 }} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: "var(--text-muted)", letterSpacing: "0.08em",
              display: "block", marginBottom: 4 }}>SEARCH MODE</label>
            <select className="ft-input" value={searchMode} onChange={e => setSearchMode(e.target.value)}>
              <option value="ALL">SEARCH ALL</option>
              <option value="TICKER">SEARCH TICKER</option>
              <option value="NAME">SEARCH NAME</option>
            </select>
          </div>
        </div>

        {/* Table card */}
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)",
            display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", letterSpacing: "0.06em" }}>
                SID THRESHOLD 5% ANALYSIS
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>· {reportDate}</span>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--accent-green)" }}></div>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--accent-blue)" }}></div>
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table className="data-table" style={{ minWidth: 850 }}>
              <thead>
                <tr>
                  <th style={{ width: 40 }}>NO</th>
                  <th>TICKER</th>
                  <th>SHAREHOLDER NAME</th>
                  <th>REMARKS</th>
                  <th style={{ textAlign: "center" }}>D-2</th>
                  <th style={{ textAlign: "center" }}>D-1</th>
                  <th style={{ textAlign: "center" }}>D-2 (%)</th>
                  <th style={{ textAlign: "center" }}>D-1 (%)</th>
                  <th style={{ textAlign: "center" }}>CHANGE</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{ textAlign: "center", color: "var(--text-muted)", padding: 40 }}>
                      <div style={{ fontSize: 24, marginBottom: 8 }}>🐋</div>
                      No significant whale movements detected.
                    </td>
                  </tr>
                ) : (
                  filtered.map((row, i) => (
                    <tr key={row.no} style={{ animation: `slide-up ${0.05 * i + 0.1}s ease both` }}>
                      <td style={{ color: "var(--text-muted)", fontSize: 12 }}>{i + 1}</td>
                      <td>
                        <span style={{ fontWeight: 800, fontSize: 14, color: "var(--text-primary)",
                          fontFamily: "'Space Grotesk', sans-serif" }}>{row.ticker}</span>
                      </td>
                      <td style={{ fontSize: 12, color: "var(--text-primary)" }}>{row.name}</td>
                      <td>
                        <span style={{ fontSize: 11, fontWeight: 700,
                          padding: "3px 8px", borderRadius: 4,
                          background: row.remarks.includes("Beli") || row.remarks.includes("Pembelian")
                            ? "rgba(63,185,80,0.12)" : "rgba(248,81,73,0.12)",
                          color: row.remarks.includes("Beli") || row.remarks.includes("Pembelian")
                            ? "var(--accent-green)" : "var(--accent-red)",
                          border: `1px solid ${row.remarks.includes("Beli") || row.remarks.includes("Pembelian")
                            ? "rgba(63,185,80,0.3)" : "rgba(248,81,73,0.3)"}`,
                        }}>
                          {row.remarks}
                        </span>
                      </td>
                      <td style={{ textAlign: "center", fontSize: 12, color: "var(--text-secondary)" }}>{row.d2}</td>
                      <td style={{ textAlign: "center", fontSize: 12, color: "var(--text-secondary)" }}>{row.d1}</td>
                      <td style={{ textAlign: "center", fontSize: 12, fontWeight: 700, color: "var(--accent-blue)" }}>
                        {row.d2pct.toFixed(2)}%
                      </td>
                      <td style={{ textAlign: "center", fontSize: 12, fontWeight: 700, color: "var(--accent-cyan)" }}>
                        {row.d1pct.toFixed(2)}%
                      </td>
                      <td style={{ textAlign: "center" }}>
                        <span style={{ fontSize: 12, fontWeight: 800,
                          color: row.change > 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                          {row.change > 0 ? "+" : ""}{row.change.toFixed(2)}%
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Member lock */}
          <div style={{ borderTop: "1px solid var(--border)", padding: "14px 20px", textAlign: "center",
            background: "rgba(47,129,247,0.04)" }}>
            <p style={{ fontSize: 12, color: "var(--accent-blue)", fontWeight: 700,
              letterSpacing: "0.06em", margin: 0 }}>
              🔒 KAMU DAPAT MELIHAT DATA YANG LENGKAP SETELAH MENJADI MEMBER
            </p>
          </div>

          {/* Footer */}
          <div style={{ borderTop: "1px solid var(--border)", padding: "12px 20px",
            display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>VIEW LIMIT:</span>
              <select className="ft-input" style={{ padding: "4px 10px", fontSize: 12 }}>
                <option>50 Rows</option>
                <option>100 Rows</option>
              </select>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button style={{ background: "none", border: "1px solid var(--border)", color: "var(--text-muted)",
                borderRadius: 6, padding: "4px 10px", cursor: "pointer" }}>‹</button>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>1 / 1</span>
              <button style={{ background: "none", border: "1px solid var(--border)", color: "var(--text-muted)",
                borderRadius: 6, padding: "4px 10px", cursor: "pointer" }}>›</button>
            </div>
            <div className="card" style={{ padding: "4px 14px", fontSize: 11, fontWeight: 700,
              color: "var(--accent-blue)", letterSpacing: "0.06em" }}>
              1 DATA PAGES INDEXED
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
