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
  tradePlan: { entry: number; stopLoss: number; target1: number; target2: number; riskReward: number } | null;
  weeklyTrend: string | null;
  trendAligned: boolean | null;
  convictionTier: string | null;
  sizeMultiplier: number | null;
  tierReason: string | null;
};

const SIGNAL_COLOR: Record<string, string> = {
  "STRONG BUY": "#3fb950", "BUY": "#56d364", "WATCH": "#e3b341",
  "NEUTRAL": "#8b949e", "SELL": "#f85149", "STRONG SELL": "#ff4444",
};
const TIER_META: Record<string, { label: string; color: string }> = {
  S: { label: "S", color: "#f7c948" }, A: { label: "A", color: "#34d399" },
  B: { label: "B", color: "#60a5fa" }, C: { label: "C", color: "#f0883e" },
  AVOID: { label: "AVOID", color: "#f87171" },
};
const TABS = ["ALL", "STRONG BUY", "BUY", "WATCH", "SELL", "STRONG SELL"];

function XABCDMiniChart({ data, direction }: { data: any; direction: string }) {
  if (!data?.X || !data?.D) return null;
  const pts = ["X","A","B","C","D"].map((k: string) => data[k]?.price).filter(Boolean);
  if (pts.length < 5) return null;
  const W = 120, H = 50, pad = 6;
  const min = Math.min(...pts), max = Math.max(...pts), range = max - min || 1;
  const coords = pts.map((p: number, i: number) => ({
    x: pad + (i / 4) * (W - pad * 2),
    y: pad + (1 - (p - min) / range) * (H - pad * 2),
  }));
  const color = direction === "BULLISH" ? "#34d399" : "#f87171";
  const pathD = coords.map((c: any, i: number) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");
  const labels = ["X","A","B","C","D"];
  return (
    <div style={{ width: W, height: H + 16, overflow: "hidden" }}>
      <svg width={W} height={H + 16} viewBox={`0 0 ${W} ${H + 16}`} style={{ overflow: "hidden", display: "block" }}>
        <path d={pathD} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
        {coords.map((c: any, i: number) => (
          <g key={i}>
            <circle cx={c.x} cy={c.y} r={3} fill={color} />
            <text x={c.x} y={c.y - 5} textAnchor="middle" fontSize={8} fill={color} fontWeight="bold">{labels[i]}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function BollingerSparkline({ data, direction }: { data: any[]; direction: string }) {
  const clean = (data || []).filter(d =>
    Number.isFinite(d?.upper) && Number.isFinite(d?.lower) && Number.isFinite(d?.close) && Number.isFinite(d?.sma)
  );
  if (clean.length < 2) return null;
  data = clean;
  const W = 160, H = 50, pad = 6;

  const min = Math.min(...data.map(d => d.lower));
  const max = Math.max(...data.map(d => d.upper));
  const range = (max - min) > 0.01 ? (max - min) : 1;

  const clampPx = (v: number) => Math.max(-1000, Math.min(1000, v));
  const getX = (i: number) => clampPx(pad + (i / (data.length - 1)) * (W - pad * 2));
  const getY = (v: number) => clampPx(pad + (1 - (v - min) / range) * (H - pad * 2));

  const upperPts = data.map((d, i) => `${getX(i).toFixed(1)},${getY(d.upper).toFixed(1)}`).join(" ");
  const lowerPtsRev = [...data].reverse().map((d, i) => `${getX(data.length - 1 - i).toFixed(1)},${getY(d.lower).toFixed(1)}`).join(" ");

  const closePath = "M " + data.map((d, i) => `${getX(i).toFixed(1)} ${getY(d.close).toFixed(1)}`).join(" L ");
  const smaPath = "M " + data.map((d, i) => `${getX(i).toFixed(1)} ${getY(d.sma).toFixed(1)}`).join(" L ");

  const color = direction === "BULLISH" ? "#34d399" : "#f87171";
  const bbFill = "rgba(139,148,158,0.12)";
  const bbStroke = "rgba(139,148,158,0.3)";

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: W, height: H + 16, overflow: "hidden" }}>
      <svg width={W} height={H + 16} viewBox={`0 0 ${W} ${H + 16}`} style={{ overflow: "hidden", display: "block" }}>
        <polygon points={`${upperPts} ${lowerPtsRev}`} fill={bbFill} />
        <path d={"M " + data.map((d, i) => `${getX(i).toFixed(1)} ${getY(d.upper).toFixed(1)}`).join(" L ")} fill="none" stroke={bbStroke} strokeWidth={1} strokeDasharray="2 2" />
        <path d={"M " + data.map((d, i) => `${getX(i).toFixed(1)} ${getY(d.lower).toFixed(1)}`).join(" L ")} fill="none" stroke={bbStroke} strokeWidth={1} strokeDasharray="2 2" />
        <path d={smaPath} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth={1.5} strokeDasharray="4 2" />
        <path d={closePath} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
        <circle cx={getX(data.length - 1)} cy={getY(data[data.length - 1].close)} r={3} fill={color} />
        <text x={W/2} y={H + 14} textAnchor="middle" fontSize={9} fill="var(--text-muted)" fontWeight="700">Bollinger 30D</text>
      </svg>
    </div>
  );
}
const fmtUsd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function UsSignalScannerPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState<any>({});
  const [marketDirection, setMarketDirection] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("ALL");
  const [sortCol, setSortCol] = useState("SKOR");
  const [sortAsc, setSortAsc] = useState(false);
  const [savedTickers, setSavedTickers] = useState<Set<string>>(new Set());
  const [savingTicker, setSavingTicker] = useState<string | null>(null);

  const [sp500, setSp500] = useState<any>(null);
  const [sp500Factors, setSp500Factors] = useState<any>(null);
  const [sp500History, setSp500History] = useState<any[]>([]);
  const [sp500Patterns, setSp500Patterns] = useState<any[]>([]);
  const [showSp500Factors, setShowSp500Factors] = useState(false);
  const [sp500Range, setSp500Range] = useState("1M");

  useEffect(() => {
    fetch(`${API_BASE}/api/us-signal-scanner`).then(r => r.json()).then(json => {
      setRows(json.data || []);
      setCounts(json.counts || {});
      setMarketDirection(json.marketDirection || null);
    }).catch(() => {}).finally(() => setLoading(false));

    fetch(`${API_BASE}/api/sp500`).then(r => r.json()).then(setSp500).catch(() => {});
    fetch(`${API_BASE}/api/sp500-factors?history=1`).then(r => r.json()).then(json => {
      setSp500Factors(json.current || null);
      setSp500History(json.history || []);
      setSp500Patterns(json.patterns || []);
    }).catch(() => {});
  }, []);

  const SP500_RANGES: { key: string; label: string; days: number | null }[] = [
    { key: "1D", label: "1H", days: 1 }, { key: "1W", label: "1M", days: 7 },
    { key: "1M", label: "1B", days: 30 }, { key: "3M", label: "3B", days: 90 },
    { key: "ALL", label: "Semua", days: null },
  ];
  const sp500FilteredHistory = (() => {
    if (!sp500History.length) return [];
    const def = SP500_RANGES.find(r => r.key === sp500Range) || SP500_RANGES[2];
    if (def.days === null) return [...sp500History].reverse();
    const cutoff = new Date(sp500History[sp500History.length - 1].date);
    cutoff.setDate(cutoff.getDate() - def.days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return sp500History.filter(h => h.date >= cutoffStr).reverse();
  })();

  const saveToJournal = async (row: Row) => {
    if (!row.tradePlan || savingTicker) return;
    setSavingTicker(row.ticker);
    try {
      const isBullish = row.signal === "STRONG BUY" || row.signal === "BUY" || row.signal === "WATCH";
      const res = await fetch(`${API_BASE}/api/recommendations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: row.ticker,
          pattern_type: "AWO_SIGNAL",
          direction: isBullish ? "BULLISH" : "BEARISH",
          detected_date: new Date().toISOString().slice(0, 10),
          entry_min: row.tradePlan.entry,
          entry_max: row.tradePlan.entry,
          stop_loss: row.tradePlan.stopLoss,
          target_1: row.tradePlan.target1,
          target_2: row.tradePlan.target2,
          risk_reward: row.tradePlan.riskReward,
          conviction_score: row.score,
          notes: `US ${row.signal} · model 9 faktor (gak ada data broker) · tier ${row.convictionTier}`,
          market_type: "US",
        }),
      });
      const json = await res.json();
      if (json.success) setSavedTickers(prev => new Set(prev).add(row.ticker));
    } catch {
      // silently fail — button stays actionable so the user can retry
    } finally {
      setSavingTicker(null);
    }
  };

  const filtered = filter === "ALL" ? rows : rows.filter(r => r.signal === filter);
  const sorted = [...filtered].sort((a, b) => {
    const dir = sortAsc ? 1 : -1;
    const map: Record<string, keyof Row> = { TICKER: "ticker", HARGA: "price", "CHG%": "dailyChange", SKOR: "score", TIER: "convictionTier" };
    const key = map[sortCol] || "score";
    const valA = a[key], valB = b[key];
    if (valA === null || valA === undefined) return 1;
    if (valB === null || valB === undefined) return -1;
    if (typeof valA === "string") return dir * String(valA).localeCompare(String(valB));
    return dir * ((valA as number) - (valB as number));
  });

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-primary)" }}>
      <Navbar />
      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "32px 20px" }}>
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 24, fontWeight: 900, color: "var(--text-primary)", margin: 0 }}>🇺🇸 US Signal Scanner — S&amp;P 500</h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
            Model 9 faktor (Volume Z-Score, Momentum, Rel. Strength, RSI, MACD, Bollinger %B, EMA Trend,
            Support/Resistance, ATR) — dipisah total dari data IDX. Gak ada 5 faktor broker/bandarmology
            (F1, F2, F6, F7, F8 — gak ada data publiknya buat saham US), dan Conviction Tier di sini
            pakai mekanisme yang sama dengan IDX tapi <b>belum divalidasi lewat backtest</b> di market ini.
          </p>
        </div>

        {/* SP500 banner */}
        {sp500 && (
          <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 20px", marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 800, color: "var(--text-primary)" }}>S&amp;P 500</span>
              <span style={{ fontSize: 18, fontWeight: 900, color: "var(--text-primary)" }}>{sp500.price?.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
              <span style={{ fontSize: 13, fontWeight: 800, color: (sp500.changePct ?? 0) >= 0 ? "#3fb950" : "#f85149" }}>
                {sp500.changePct >= 0 ? "+" : ""}{sp500.changePct?.toFixed(2)}%
              </span>
              {sp500.weeklyTrend && sp500.weeklyTrend !== "NEUTRAL" && (
                <span style={{
                  fontSize: 10, fontWeight: 800, padding: "3px 9px", borderRadius: 5,
                  background: sp500.weeklyTrend === "BULLISH" ? "rgba(63,185,80,0.12)" : "rgba(248,81,73,0.12)",
                  color: sp500.weeklyTrend === "BULLISH" ? "#3fb950" : "#f85149",
                }}>{sp500.weeklyTrend === "BULLISH" ? "W▲ UPTREND" : "W▼ DOWNTREND"}</span>
              )}
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>10D avg: {sp500.avgDailyChange10d >= 0 ? "+" : ""}{sp500.avgDailyChange10d}%/hari</span>
              {sp500Factors && (
                <button onClick={() => setShowSp500Factors(p => !p)} style={{
                  display: "flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 5,
                  cursor: "pointer", fontSize: 10, fontWeight: 800, border: "1px solid var(--border)",
                  background: showSp500Factors ? "rgba(88,166,255,0.1)" : "transparent",
                  color: sp500Factors.trend === "BULLISH" ? "#3fb950" : sp500Factors.trend === "BEARISH" ? "#f85149" : "#e3b341",
                }}>🧩 Skor Faktor: {sp500Factors.composite} ({sp500Factors.trend}) {showSp500Factors ? "▲" : "▼"}</button>
              )}
              <span style={{ fontSize: 9, color: "var(--text-muted)", marginLeft: "auto" }}>as of {sp500.asOf}</span>
            </div>

            {showSp500Factors && sp500Factors && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10, marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
                {[
                  { key: "breadth", label: "Market Breadth", icon: "👥", hint: `${sp500Factors.breadthPct}% saham naik hari ini` },
                  { key: "rsi", label: "RSI", icon: "📉", hint: `raw RSI(14): ${sp500Factors.indicators?.rsi ?? "–"}` },
                  { key: "macd", label: "MACD", icon: "〰️", hint: "histogram crossover EMA12/26/9" },
                  { key: "bollinger", label: "Bollinger %B", icon: "🎯", hint: `%B: ${sp500Factors.indicators?.bb?.pctB ?? "–"}` },
                  { key: "emaTrend", label: "EMA Trend", icon: "📐", hint: `EMA9 ${sp500Factors.indicators?.ema9 ?? "–"} vs EMA21 ${sp500Factors.indicators?.ema21 ?? "–"}` },
                  { key: "supportResistance", label: "Support/Resistance", icon: "🧱", hint: "jarak ke level S/R terdekat" },
                  { key: "atr", label: "ATR", icon: "⚡", hint: `raw ATR(14): ${sp500Factors.indicators?.atr ?? "–"}` },
                ].map(f => (
                  <div key={f.key} title={f.hint} style={{ background: "var(--bg-tertiary)", borderRadius: 8, border: "1px solid var(--border)", padding: "8px 10px" }}>
                    <div style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 700 }}>{f.icon} {f.label}</div>
                    <div style={{ fontSize: 16, fontWeight: 900, color: "var(--text-primary)" }}>{sp500Factors.factors?.[f.key] ?? "–"}</div>
                  </div>
                ))}
                <div style={{ gridColumn: "1 / -1", fontSize: 9, color: "var(--text-muted)", marginTop: 2 }}>
                  Skor komposit = rata-rata 7 faktor di atas — sama persis strukturnya dengan model IHSG, cuma dihitung dari data S&amp;P 500 (^GSPC) + breadth 418 saham US yang dilacak.
                </div>

                {sp500History.length > 0 && (
                  <div style={{ gridColumn: "1 / -1", marginTop: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "var(--text-primary)" }}>
                        Histori Skor S&amp;P 500 — {sp500FilteredHistory.length} dari {sp500History.length} hari total
                      </div>
                      <div style={{ display: "flex", gap: 4 }}>
                        {SP500_RANGES.map(r => (
                          <button key={r.key} onClick={() => setSp500Range(r.key)} style={{
                            padding: "3px 10px", borderRadius: 5, cursor: "pointer", fontSize: 10, fontWeight: 700,
                            border: `1px solid ${sp500Range === r.key ? "#58a6ff" : "var(--border)"}`,
                            background: sp500Range === r.key ? "rgba(88,166,255,0.12)" : "transparent",
                            color: sp500Range === r.key ? "#58a6ff" : "var(--text-muted)",
                          }}>{r.label}</button>
                        ))}
                      </div>
                    </div>
                    <div style={{ maxHeight: 280, overflowY: "auto", overflowX: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
                      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 700 }}>
                        <thead>
                          <tr style={{ borderBottom: "1px solid var(--border)", position: "sticky", top: 0, background: "var(--bg-tertiary)" }}>
                            {["TANGGAL", "CLOSE", "%CHG", "SKOR", "TREND", "BREADTH", "RSI"].map(h => (
                              <th key={h} style={{ padding: "6px 8px", textAlign: "left", fontSize: 9, fontWeight: 800, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {sp500FilteredHistory.map((h, i) => (
                            <tr key={h.date} style={{ borderBottom: "1px solid rgba(48,54,61,0.4)", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)" }}>
                              <td style={{ padding: "5px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>{h.date}</td>
                              <td style={{ padding: "5px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>{h.closePrice !== null ? fmtUsd(h.closePrice) : "–"}</td>
                              <td style={{ padding: "5px 8px", fontSize: 11, fontWeight: 800, whiteSpace: "nowrap", color: h.changePct >= 0 ? "#3fb950" : "#f85149" }}>
                                {h.changePct !== null ? `${h.changePct >= 0 ? "+" : ""}${h.changePct.toFixed(2)}%` : "–"}
                              </td>
                              <td style={{ padding: "5px 8px", fontSize: 11, fontWeight: 800 }}>{h.composite}</td>
                              <td style={{ padding: "5px 8px", fontSize: 9, fontWeight: 800, color: h.trend === "BULLISH" ? "#3fb950" : h.trend === "BEARISH" ? "#f85149" : "#e3b341" }}>{h.trend}</td>
                              <td style={{ padding: "5px 8px", fontSize: 11 }}>{h.breadth}</td>
                              <td style={{ padding: "5px 8px", fontSize: 11 }}>{h.rsi}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {sp500Patterns.length > 0 ? (
                  <div style={{ gridColumn: "1 / -1", marginTop: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: "var(--text-primary)", marginBottom: 8 }}>🔮 Harmonic Pattern S&amp;P 500 — {sp500Patterns.length} terdeteksi</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 10 }}>
                      {sp500Patterns.map((p, i) => (
                        <div key={i} style={{ background: "var(--bg-secondary)", border: `1px solid ${p.direction === "BULLISH" ? "rgba(63,185,80,0.35)" : "rgba(248,81,73,0.35)"}`, borderRadius: 10, padding: 12 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                            <span style={{ fontSize: 12, fontWeight: 800 }}>{p.pattern_type} {p.direction === "BULLISH" ? "▲" : "▼"}</span>
                            <span style={{ fontSize: 10, fontWeight: 800, color: p.signal?.includes("BUY") ? "#3fb950" : p.signal?.includes("SELL") ? "#f85149" : "#e3b341" }}>{p.signal}</span>
                          </div>
                          <div style={{ display: "flex", justifyContent: "center", gap: 10, margin: "6px 0" }}>
                            <XABCDMiniChart data={p.pattern_data} direction={p.direction} />
                            <BollingerSparkline data={p.bb_data} direction={p.direction} />
                          </div>
                          <div style={{ fontSize: 10, color: "var(--text-muted)" }}>Conviction: {p.conviction_score} · R:R {p.risk_reward}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div style={{ gridColumn: "1 / -1", marginTop: 14, fontSize: 10, color: "var(--text-muted)" }}>🔮 Belum ada pattern XABCD yang valid terdeteksi di S&amp;P 500 saat ini.</div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Filter tabs */}
        <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
          {TABS.map(t => (
            <button key={t} onClick={() => setFilter(t)} style={{
              padding: "6px 14px", borderRadius: 7, cursor: "pointer", fontSize: 11, fontWeight: 800,
              border: `1px solid ${filter === t ? "#58a6ff" : "var(--border)"}`,
              background: filter === t ? "rgba(88,166,255,0.12)" : "var(--bg-secondary)",
              color: filter === t ? "#58a6ff" : "var(--text-muted)",
            }}>
              {t} {t === "ALL" ? `(${rows.length})` : `(${counts[t.toLowerCase().replace(/ /g, "_")] ?? 0})`}
            </button>
          ))}
        </div>

        {loading ? (
          <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>Loading...</div>
        ) : sorted.length === 0 ? (
          <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>Belum ada data — backfill masih berjalan, coba lagi beberapa menit lagi.</div>
        ) : (
          <div style={{ background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border)", overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 900 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    {["TICKER", "HARGA", "CHG%", "SKOR", "SINYAL", "TREND MINGGUAN", "TIER", ""].map(h => {
                      const sortable = ["TICKER", "HARGA", "CHG%", "SKOR", "TIER"].includes(h);
                      const active = sortCol === h;
                      return (
                        <th key={h}
                          onClick={sortable ? () => { if (active) setSortAsc(!sortAsc); else { setSortCol(h); setSortAsc(false); } } : undefined}
                          style={{
                            padding: "12px 16px", textAlign: "left", fontSize: 10, fontWeight: 800,
                            color: active ? "#58a6ff" : "var(--text-secondary)", letterSpacing: "0.06em",
                            cursor: sortable ? "pointer" : "default", userSelect: "none", whiteSpace: "nowrap",
                          }}>
                          {h}{active ? (sortAsc ? " ↑" : " ↓") : ""}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r, i) => (
                    <tr key={r.ticker} style={{ borderBottom: "1px solid rgba(48,54,61,0.5)", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)" }}>
                      <td style={{ padding: "12px 16px" }}>
                        <Link href={`/us/${r.ticker}`} style={{ fontSize: 14, fontWeight: 900, color: "#58a6ff", textDecoration: "none" }}>{r.ticker}</Link>
                      </td>
                      <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{r.price !== null ? fmtUsd(r.price) : "–"}</td>
                      <td style={{ padding: "12px 16px", fontSize: 12, fontWeight: 800, color: (r.dailyChange ?? 0) >= 0 ? "#3fb950" : "#f85149" }}>
                        {r.dailyChange !== null ? `${r.dailyChange >= 0 ? "+" : ""}${r.dailyChange.toFixed(2)}%` : "–"}
                      </td>
                      <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 800, color: "var(--text-primary)" }}>{r.score ?? "–"}</td>
                      <td style={{ padding: "12px 16px" }}>
                        <span style={{
                          fontSize: 10, fontWeight: 800, padding: "3px 9px", borderRadius: 5,
                          background: `${SIGNAL_COLOR[r.signal || ""] || "#8b949e"}22`, color: SIGNAL_COLOR[r.signal || ""] || "#8b949e",
                        }}>{r.signal || "N/A"}</span>
                      </td>
                      <td style={{ padding: "12px 16px", fontSize: 11, color: r.weeklyTrend === "BULLISH" ? "#3fb950" : r.weeklyTrend === "BEARISH" ? "#f85149" : "var(--text-muted)" }}>
                        {r.weeklyTrend || "–"} {r.trendAligned === false && <span title="Counter-trend vs weekly">⚠️</span>}
                      </td>
                      <td style={{ padding: "12px 16px" }} title={r.tierReason || ""}>
                        <span style={{ fontSize: 10, fontWeight: 800, color: TIER_META[r.convictionTier || ""]?.color || "#8b949e" }}>
                          {TIER_META[r.convictionTier || ""]?.label || r.convictionTier || "–"}
                        </span>
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        {r.tradePlan && (
                          <button
                            disabled={savedTickers.has(r.ticker) || savingTicker === r.ticker}
                            onClick={() => saveToJournal(r)}
                            style={{
                              padding: "5px 10px", borderRadius: 6, fontSize: 10, fontWeight: 800,
                              cursor: savedTickers.has(r.ticker) ? "default" : "pointer",
                              border: "1px solid var(--border)",
                              background: savedTickers.has(r.ticker) ? "rgba(63,185,80,0.12)" : "transparent",
                              color: savedTickers.has(r.ticker) ? "#3fb950" : "var(--text-muted)",
                            }}>
                            {savedTickers.has(r.ticker) ? "✓ Tersimpan" : savingTicker === r.ticker ? "..." : "+ Journal"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
