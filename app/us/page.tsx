"use client";
import Navbar from "@/components/Navbar";
import { API_BASE } from "@/lib/apiConfig";
import { useState, useEffect } from "react";
import Link from "next/link";

type Row = {
  ticker: string;
  price: number | null;
  dailyChange: number | null;
  score: number | null;
  signal: string | null;
  convictionTier: string | null;
};

const SIGNAL_COLOR: Record<string, string> = {
  "STRONG BUY": "#3fb950", "BUY": "#56d364", "WATCH": "#e3b341",
  "NEUTRAL": "#8b949e", "SELL": "#f85149", "STRONG SELL": "#ff4444",
};
const TIER_COLOR: Record<string, string> = {
  S: "#f7c948", A: "#34d399", B: "#60a5fa", C: "#f0883e", AVOID: "#f87171",
};

export default function UsMarketPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [marketDirection, setMarketDirection] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/api/us-signal-scanner`)
      .then(r => r.json())
      .then(json => {
        setRows(json.data || []);
        setMarketDirection(json.marketDirection || null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-primary)" }}>
      <Navbar />
      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "32px 20px" }}>
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 900, color: "var(--text-primary)", margin: 0 }}>US Market — S&amp;P 500</h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
            Model 9 faktor (Volume Z-Score, Momentum, Rel. Strength, RSI, MACD, Bollinger %B, EMA Trend,
            Support/Resistance, ATR) — saham US gak punya data broker/bandarmology publik seperti IDX,
            jadi 5 faktor smart-money-nya (F1, F2, F6, F7, F8) gak dipakai di sini.
            {marketDirection && <> Regime pasar saat ini: <b style={{ color: "var(--text-primary)" }}>{marketDirection}</b> (dari S&amp;P 500).</>}
          </p>
        </div>

        {loading ? (
          <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>Loading...</div>
        ) : rows.length === 0 ? (
          <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>
            Belum ada data — backfill harga US masih berjalan, coba lagi beberapa menit lagi.
          </div>
        ) : (
          <div style={{ background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border)", overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "50px 100px 1fr 100px 100px 130px 90px", padding: "12px 20px", borderBottom: "1px solid var(--border)" }}>
              {["#", "TICKER", "HARGA", "CHG%", "SKOR", "SINYAL", "TIER"].map(h => (
                <span key={h} style={{ fontSize: 11, fontWeight: 800, color: "var(--text-secondary)", letterSpacing: "0.08em" }}>{h}</span>
              ))}
            </div>
            {rows.map((r, i) => (
              <Link key={r.ticker} href={`/us/${r.ticker}`} style={{ textDecoration: "none" }}>
                <div style={{
                  display: "grid", gridTemplateColumns: "50px 100px 1fr 100px 100px 130px 90px",
                  padding: "14px 20px", borderBottom: "1px solid rgba(48,54,61,0.5)", alignItems: "center",
                  cursor: "pointer", transition: "background 0.15s",
                }}
                  onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.03)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>{i + 1}</span>
                  <span style={{ fontSize: 15, fontWeight: 900, color: "#58a6ff" }}>{r.ticker}</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>
                    {r.price ? `$${r.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "–"}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 800, color: (r.dailyChange ?? 0) >= 0 ? "#3fb950" : "#f85149" }}>
                    {r.dailyChange !== null ? `${r.dailyChange >= 0 ? "+" : ""}${r.dailyChange.toFixed(2)}%` : "–"}
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 800, color: "var(--text-primary)" }}>{r.score ?? "–"}</span>
                  <span style={{
                    fontSize: 10, fontWeight: 800, padding: "3px 9px", borderRadius: 5, width: "fit-content",
                    background: `${SIGNAL_COLOR[r.signal || ""] || "#8b949e"}22`,
                    color: SIGNAL_COLOR[r.signal || ""] || "#8b949e",
                    border: `1px solid ${SIGNAL_COLOR[r.signal || ""] || "#8b949e"}55`,
                  }}>
                    {r.signal || "N/A"}
                  </span>
                  <span style={{
                    fontSize: 10, fontWeight: 800, padding: "3px 9px", borderRadius: 5, width: "fit-content",
                    color: TIER_COLOR[r.convictionTier || ""] || "#8b949e",
                  }}>
                    {r.convictionTier || "–"}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
