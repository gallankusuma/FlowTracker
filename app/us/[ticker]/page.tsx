"use client";
import Navbar from "@/components/Navbar";
import { API_BASE } from "@/lib/apiConfig";
import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";

type PriceBar = { date: string; open: number; high: number; low: number; close: number; volume: number };
type FactorPoint = {
  date: string; composite: number; signal: string;
  volumeZ: number; momentum: number; relStrength: number;
  rsi: number; macd: number; bollinger: number; emaTrend: number; supportResistance: number; atr: number;
  closePrevDay: number | null; closeToday: number | null;
};

const FACTORS: { key: keyof FactorPoint; label: string; icon: string; desc: string; formula: string }[] = [
  { key: "volumeZ", label: "Volume Z-Score", icon: "📊",
    desc: "Seberapa gak biasa volume hari ini dibanding rata-rata 30 hari, dikonfirmasi arah harga.",
    formula: "Z-score(volume) × 12.5 + bonus konfirmasi arah harga" },
  { key: "momentum", label: "Price Momentum", icon: "🚀",
    desc: "Kombinasi rate-of-change 5 & 3 hari, disesuaikan kondisi oversold/overbought (RSI).",
    formula: "0.6×ROC(5) + 0.4×ROC(3), ±bonus reversal RSI" },
  { key: "relStrength", label: "Rel. Strength", icon: "💪",
    desc: "Selisih return saham ini vs rata-rata return seluruh 418 saham US yang dilacak hari itu.",
    formula: "sigmoid(return saham − return rata-rata universe US)" },
  { key: "rsi", label: "RSI", icon: "📉",
    desc: "Relative Strength Index 14 hari — indikator momentum klasik oversold/overbought.",
    formula: "RSI(14) = 100 − 100/(1+RS)" },
  { key: "macd", label: "MACD", icon: "〰️",
    desc: "Konvergensi/divergensi EMA 12 & 26 hari, dibandingkan sinyal EMA 9 dari histogramnya.",
    formula: "MACD(12,26,9), skor dari crossover histogram" },
  { key: "bollinger", label: "Bollinger %B", icon: "🎯",
    desc: "Posisi harga sekarang relatif terhadap Bollinger Band (20 hari, 2 standar deviasi).",
    formula: "%B = (harga − lower band) / (upper − lower band)" },
  { key: "emaTrend", label: "EMA Trend", icon: "📐",
    desc: "Arah tren dari posisi harga terhadap EMA9/EMA21 dan crossover-nya.",
    formula: "Posisi harga vs EMA9 & EMA21, deteksi crossover" },
  { key: "supportResistance", label: "Support/Resistance", icon: "🧱",
    desc: "Jarak harga sekarang ke level support/resistance terdekat (dari 20 hari terakhir).",
    formula: "Jarak relatif ke level S/R terdekat" },
  { key: "atr", label: "ATR (Volatility)", icon: "⚡",
    desc: "Rata-rata true range 14 hari — ukuran volatilitas.",
    formula: "ATR(14) relatif terhadap harga" },
];

const SIGNAL_COLOR: Record<string, string> = {
  "STRONG BUY": "#3fb950", "BUY": "#56d364", "WATCH": "#e3b341",
  "NEUTRAL": "#8b949e", "SELL": "#f85149", "STRONG SELL": "#ff4444",
};
const TIER_META: Record<string, { label: string; color: string }> = {
  S: { label: "S · Smart Money", color: "#f7c948" },
  A: { label: "A", color: "#34d399" },
  B: { label: "B", color: "#60a5fa" },
  C: { label: "C · Sized Down", color: "#f0883e" },
  AVOID: { label: "AVOID", color: "#f87171" },
};

function factorColor(v: number) {
  if (v >= 65) return "#3fb950";
  if (v >= 50) return "#e3b341";
  if (v >= 35) return "#f0883e";
  return "#f85149";
}

const RANGES: { key: string; label: string; days: number | null }[] = [
  { key: "1D", label: "1 Hari",   days: 1 },
  { key: "1W", label: "1 Minggu", days: 7 },
  { key: "1M", label: "1 Bulan",  days: 30 },
  { key: "3M", label: "3 Bulan",  days: 90 },
  { key: "ALL", label: "Semua",   days: null },
];

const fmtUsd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function UsTickerDeepDive() {
  const params = useParams();
  const ticker = String(params.ticker || "").toUpperCase();
  const [data, setData] = useState<{
    ticker: string; priceHistory: PriceBar[]; factorHistory: FactorPoint[];
    latest: FactorPoint | null; convictionTier: { tier: string; sizeMultiplier: number; reason: string } | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState("1M");
  const [sortCol, setSortCol] = useState("TANGGAL");
  const [sortAsc, setSortAsc] = useState(false);
  const [showFactorInfo, setShowFactorInfo] = useState(false);

  useEffect(() => {
    if (!ticker) return;
    setLoading(true);
    fetch(`${API_BASE}/api/us-deepdive/${ticker}`)
      .then(r => r.json())
      .then(json => setData(json))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [ticker]);

  const priceLast90 = data?.priceHistory.slice(-90) || [];
  const lastPrice = priceLast90[priceLast90.length - 1];
  const prevPrice = priceLast90[priceLast90.length - 2];
  const changePct = lastPrice && prevPrice ? ((lastPrice.close - prevPrice.close) / prevPrice.close) * 100 : 0;
  const tier = data?.convictionTier;

  const rangeDef = RANGES.find(r => r.key === range) || RANGES[2];
  const rangedHistory = (() => {
    if (!data?.factorHistory.length) return [];
    if (rangeDef.days === null) return data.factorHistory;
    const cutoff = new Date(data.factorHistory[data.factorHistory.length - 1].date);
    cutoff.setDate(cutoff.getDate() - rangeDef.days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return data.factorHistory.filter(f => f.date >= cutoffStr);
  })();

  const COL_TO_KEY: Record<string, keyof FactorPoint> = {
    "TANGGAL": "date", "H-1": "closePrevDay", "CLOSE": "closeToday", "SKOR": "composite", "SINYAL": "signal",
    ...Object.fromEntries(FACTORS.map(f => [f.label, f.key])),
  };
  const pctChange = (row: FactorPoint) =>
    row.closePrevDay && row.closeToday ? ((row.closeToday - row.closePrevDay) / row.closePrevDay) * 100 : null;

  const filteredHistory = [...rangedHistory].sort((a, b) => {
    const dir = sortAsc ? 1 : -1;
    if (sortCol === "%CHG") {
      const valA = pctChange(a), valB = pctChange(b);
      if (valA === null) return 1;
      if (valB === null) return -1;
      return dir * (valA - valB);
    }
    const key = COL_TO_KEY[sortCol] || "date";
    const valA = a[key], valB = b[key];
    if (valA === null || valA === undefined) return 1;
    if (valB === null || valB === undefined) return -1;
    if (typeof valA === "string") return dir * String(valA).localeCompare(String(valB));
    return dir * ((valA as number) - (valB as number));
  });

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-primary)" }}>
      <Navbar />
      <div style={{ maxWidth: 1800, margin: "0 auto", padding: "32px 20px" }}>
        <Link href="/us" style={{ fontSize: 12, color: "var(--text-muted)", textDecoration: "none" }}>← US Market — S&amp;P 500</Link>

        {loading ? (
          <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>Loading...</div>
        ) : !data || data.factorHistory.length === 0 ? (
          <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>Belum ada data historis buat {ticker}.</div>
        ) : (
          <>
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", margin: "12px 0 20px" }}>
              <h1 style={{ fontSize: 28, fontWeight: 900, color: "var(--text-primary)", margin: 0 }}>{ticker}</h1>
              <span style={{ fontSize: 20, fontWeight: 800, color: "var(--text-primary)" }}>
                {lastPrice ? fmtUsd(lastPrice.close) : "–"}
              </span>
              <span style={{ fontSize: 14, fontWeight: 800, color: changePct >= 0 ? "#3fb950" : "#f85149" }}>
                {changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%
              </span>
              {data.latest && (
                <span style={{
                  fontSize: 11, fontWeight: 800, padding: "4px 10px", borderRadius: 6,
                  background: `${SIGNAL_COLOR[data.latest.signal] || "#8b949e"}22`,
                  color: SIGNAL_COLOR[data.latest.signal] || "#8b949e",
                  border: `1px solid ${SIGNAL_COLOR[data.latest.signal] || "#8b949e"}55`,
                }}>
                  {data.latest.signal} · skor {data.latest.composite}
                </span>
              )}
              {tier && (
                <span title={tier.reason} style={{
                  fontSize: 11, fontWeight: 800, padding: "4px 10px", borderRadius: 6,
                  background: `${TIER_META[tier.tier]?.color || "#8b949e"}22`,
                  color: TIER_META[tier.tier]?.color || "#8b949e",
                  border: `1px solid ${TIER_META[tier.tier]?.color || "#8b949e"}55`,
                }}>
                  Tier {TIER_META[tier.tier]?.label || tier.tier}
                </span>
              )}
            </div>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: -14, marginBottom: 20 }}>
              Model 9 faktor (harga/volume) — gak ada data broker/bandarmology publik buat saham US, jadi 5 faktor smart-money (F1, F2, F6, F7, F8) gak dipakai.
            </div>

            {/* Price chart */}
            <div style={{ background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border)", padding: "16px 20px", marginBottom: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 10 }}>
                HARGA — 90 HARI TERAKHIR
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={priceLast90}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#6e7681" }} tickFormatter={d => d.slice(5)} minTickGap={30} />
                  <YAxis tick={{ fontSize: 9, fill: "#6e7681" }} domain={["auto", "auto"]} width={60} />
                  <Tooltip contentStyle={{ background: "#161b22", border: "1px solid #30363d", fontSize: 11 }} />
                  <Line type="monotone" dataKey="close" stroke="#58a6ff" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* 6-factor history table */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: "var(--text-primary)" }}>Histori 9 Faktor</span>
                  <button onClick={() => setShowFactorInfo(p => !p)} style={{
                    fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10, cursor: "pointer",
                    border: "1px solid var(--border)", background: showFactorInfo ? "rgba(88,166,255,0.12)" : "transparent",
                    color: showFactorInfo ? "#58a6ff" : "var(--text-muted)",
                  }}>ℹ️ {showFactorInfo ? "Sembunyikan" : "Penjelasan"} faktor</button>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  {filteredHistory.length} dari {data.factorHistory.length} titik data total — {data.factorHistory[0]?.date} s.d. {data.factorHistory[data.factorHistory.length - 1]?.date}
                </div>
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                {RANGES.map(r => (
                  <button key={r.key} onClick={() => setRange(r.key)} style={{
                    padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700,
                    border: `1px solid ${range === r.key ? "#58a6ff" : "var(--border)"}`,
                    background: range === r.key ? "rgba(88,166,255,0.12)" : "transparent",
                    color: range === r.key ? "#58a6ff" : "var(--text-muted)",
                  }}>{r.label}</button>
                ))}
              </div>
            </div>

            {showFactorInfo && (
              <div style={{
                display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10,
                background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 10,
                padding: 16, marginBottom: 14,
              }}>
                {FACTORS.map(f => (
                  <div key={f.key} style={{ padding: "10px 12px", background: "var(--bg-tertiary)", borderRadius: 8, border: "1px solid var(--border)" }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: "var(--text-primary)", marginBottom: 4 }}>
                      {f.icon} {f.label}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.4, marginBottom: 6 }}>{f.desc}</div>
                    <div style={{ fontSize: 10, color: "#58a6ff", fontFamily: "monospace", background: "rgba(88,166,255,0.08)", padding: "4px 6px", borderRadius: 4 }}>
                      {f.formula}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {filteredHistory.length === 0 ? (
              <div style={{ padding: 30, textAlign: "center", color: "var(--text-muted)", fontSize: 12, background: "var(--bg-secondary)", borderRadius: 10, border: "1px solid var(--border)" }}>
                Gak ada data di rentang ini — coba pilih rentang lebih panjang.
              </div>
            ) : (
              <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ borderCollapse: "collapse", width: "100%", tableLayout: "auto" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid var(--border)" }}>
                        {["TANGGAL", "H-1", "CLOSE", "%CHG", "SKOR", "SINYAL", ...FACTORS.map(f => f.label)].map(h => {
                          const active = sortCol === h;
                          return (
                            <th key={h}
                              onClick={() => { if (active) setSortAsc(!sortAsc); else { setSortCol(h); setSortAsc(false); } }}
                              style={{
                                position: "sticky", top: 0, background: "var(--bg-secondary)",
                                padding: "9px 7px", textAlign: "left", fontSize: 10, fontWeight: 800,
                                color: active ? "#58a6ff" : "var(--text-muted)", letterSpacing: "0.05em", whiteSpace: "nowrap",
                                cursor: "pointer", userSelect: "none",
                              }}>
                              {h}{active ? (sortAsc ? " ↑" : " ↓") : ""}
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredHistory.map((row, i) => (
                        <tr key={row.date} style={{ borderBottom: "1px solid rgba(48,54,61,0.4)", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)" }}>
                          <td style={{ padding: "8px 7px", fontSize: 12, fontWeight: 700, color: "var(--text-primary)", whiteSpace: "nowrap" }}>{row.date}</td>
                          <td style={{ padding: "8px 7px", fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                            {row.closePrevDay !== null ? fmtUsd(row.closePrevDay) : "–"}
                          </td>
                          <td style={{ padding: "8px 7px", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap",
                            color: row.closeToday !== null && row.closePrevDay !== null
                              ? (row.closeToday >= row.closePrevDay ? "#3fb950" : "#f85149")
                              : "var(--text-primary)" }}>
                            {row.closeToday !== null ? fmtUsd(row.closeToday) : "–"}
                          </td>
                          {(() => {
                            const pct = pctChange(row);
                            return (
                              <td style={{ padding: "8px 7px", fontSize: 12, fontWeight: 800, whiteSpace: "nowrap",
                                color: pct === null ? "var(--text-muted)" : pct >= 0 ? "#3fb950" : "#f85149" }}>
                                {pct === null ? "–" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}
                              </td>
                            );
                          })()}
                          <td style={{ padding: "8px 7px", fontSize: 12, fontWeight: 800, color: "var(--text-primary)" }}>{row.composite}</td>
                          <td style={{ padding: "8px 7px" }}>
                            <span style={{
                              fontSize: 9, fontWeight: 800, padding: "2px 7px", borderRadius: 4, whiteSpace: "nowrap",
                              background: `${SIGNAL_COLOR[row.signal] || "#8b949e"}22`, color: SIGNAL_COLOR[row.signal] || "#8b949e",
                            }}>{row.signal}</span>
                          </td>
                          {FACTORS.map(f => (
                            <td key={f.key} style={{ padding: "8px 7px", fontSize: 12, fontWeight: 700, color: factorColor(Number(row[f.key])) }}>
                              {row[f.key]}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
