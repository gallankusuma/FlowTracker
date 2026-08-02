"use client";
import Navbar from "@/components/Navbar";
import { API_BASE } from "@/lib/apiConfig";
import { useState, useEffect } from "react";
import Link from "next/link";

type Row = {
  ticker: string;
  price: number | null;
  changePct: number | null;
  compositeScore: number | null;
  signal: string | null;
  confidence: number | null;
};

const SIGNAL_COLOR: Record<string, string> = {
  "STRONG BUY": "#3fb950", "BUY": "#56d364", "WATCH": "#e3b341",
  "NEUTRAL": "#8b949e", "SELL": "#f85149", "STRONG SELL": "#ff4444",
};

export default function IdxTop20Page() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/api/idx-deepdive`)
      .then(r => r.json())
      .then(json => setRows(json.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-primary)" }}>
      <Navbar />
      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "32px 20px" }}>
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 900, color: "var(--text-primary)", margin: 0 }}>IDX Big Caps</h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
            Deep-dive per ticker — histori 14 faktor AWO lengkap dengan timeframe. TOP 100 big-cap IDX (ranking turnover 30 hari).
          </p>
        </div>

        {loading ? (
          <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>Loading...</div>
        ) : (
          <div style={{ background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border)", overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "50px 100px 1fr 100px 100px 130px 100px", padding: "12px 20px", borderBottom: "1px solid var(--border)" }}>
              {["#", "TICKER", "HARGA", "CHG%", "SKOR", "SINYAL", "CONF."].map(h => (
                <span key={h} style={{ fontSize: 11, fontWeight: 800, color: "var(--text-secondary)", letterSpacing: "0.08em" }}>{h}</span>
              ))}
            </div>
            {rows.map((r, i) => (
              <Link key={r.ticker} href={`/idx/${r.ticker}`} style={{ textDecoration: "none" }}>
                <div style={{
                  display: "grid", gridTemplateColumns: "50px 100px 1fr 100px 100px 130px 100px",
                  padding: "14px 20px", borderBottom: "1px solid rgba(48,54,61,0.5)", alignItems: "center",
                  cursor: "pointer", transition: "background 0.15s",
                }}
                  onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.03)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>{i + 1}</span>
                  <span style={{ fontSize: 15, fontWeight: 900, color: "#58a6ff" }}>{r.ticker}</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>
                    {r.price ? `Rp ${r.price.toLocaleString("id-ID")}` : "–"}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 800, color: (r.changePct ?? 0) >= 0 ? "#3fb950" : "#f85149" }}>
                    {r.changePct !== null ? `${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}%` : "–"}
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 800, color: "var(--text-primary)" }}>{r.compositeScore ?? "–"}</span>
                  <span style={{
                    fontSize: 10, fontWeight: 800, padding: "3px 9px", borderRadius: 5, width: "fit-content",
                    background: `${SIGNAL_COLOR[r.signal || ""] || "#8b949e"}22`,
                    color: SIGNAL_COLOR[r.signal || ""] || "#8b949e",
                    border: `1px solid ${SIGNAL_COLOR[r.signal || ""] || "#8b949e"}55`,
                  }}>
                    {r.signal || "N/A"}
                  </span>
                  <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{r.confidence !== null ? `${r.confidence}%` : "–"}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
