"use client";
import Navbar from "@/components/Navbar";
import { API_BASE } from "@/lib/apiConfig";
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

type WatchItem = {
  ticker: string;
  addedAt: string;
  note?: string;
};

type LiveData = {
  ticker: string;
  price: number;
  dailyChange: number;
  days: number[];
  score: number;
  signal: string;
  topBuyer: string | null;
  topSeller: string | null;
  netBuyers: number;
  netSellers: number;
};

const SIGNAL_CFG: Record<string, { color: string; bg: string; border: string; icon: string }> = {
  "STRONG BUY":  { color: "#3fb950", bg: "rgba(63,185,80,0.12)",   border: "rgba(63,185,80,0.4)",  icon: "▲▲" },
  "BUY":         { color: "#56d364", bg: "rgba(86,211,100,0.08)",  border: "rgba(86,211,100,0.3)", icon: "▲" },
  "WATCH":       { color: "#e3b341", bg: "rgba(227,179,65,0.1)",   border: "rgba(227,179,65,0.3)", icon: "◆" },
  "NEUTRAL":     { color: "#8b949e", bg: "rgba(139,148,158,0.08)", border: "rgba(139,148,158,0.2)",icon: "─" },
  "SELL":        { color: "#f85149", bg: "rgba(248,81,73,0.08)",   border: "rgba(248,81,73,0.3)",  icon: "▼" },
  "STRONG SELL": { color: "#da3633", bg: "rgba(218,54,51,0.12)",   border: "rgba(218,54,51,0.4)",  icon: "▼▼" },
};

function ScoreRing({ score }: { score: number }) {
  const color = score >= 80 ? "#3fb950" : score >= 65 ? "#56d364" : score >= 56 ? "#e3b341" :
                score >= 35 ? "#8b949e" : score >= 20 ? "#f85149" : "#da3633";
  const r = 20, circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  return (
    <div style={{ position: "relative", width: 52, height: 52, flexShrink: 0 }}>
      <svg width={52} height={52} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={26} cy={26} r={r} fill="none" stroke="#21262d" strokeWidth={4} />
        <circle cx={26} cy={26} r={r} fill="none" stroke={color} strokeWidth={4}
          strokeDasharray={`${dash} ${circ - dash}`} strokeLinecap="round" />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontSize: 13, fontWeight: 900, color, lineHeight: 1 }}>{score}</span>
      </div>
    </div>
  );
}

function MiniSparkline({ days }: { days: number[] }) {
  const max = Math.max(...days.map(Math.abs), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 28 }}>
      {days.map((v, i) => {
        const h = Math.round(Math.abs(v) / max * 24) + 4;
        const isToday = i === days.length - 1;
        const color = v > 0 ? "#3fb950" : v < 0 ? "#f85149" : "#30363d";
        return (
          <div key={i} style={{
            width: isToday ? 8 : 6, height: h, background: color,
            borderRadius: 2, opacity: isToday ? 1 : 0.4 + (i / days.length) * 0.5,
            boxShadow: isToday ? `0 0 6px ${color}60` : "none",
          }} />
        );
      })}
    </div>
  );
}

const POPULAR = ["BBCA", "BBRI", "BMRI", "ASII", "TLKM", "ANTM", "GOTO", "BRIS", "ADRO", "PTBA"];

export default function WatchlistPage() {
  const [watchlist, setWatchlist] = useState<WatchItem[]>([]);
  const [liveData, setLiveData]   = useState<Record<string, LiveData>>({});
  const [input, setInput]         = useState("");
  const [loading, setLoading]     = useState(false);
  const [scanDate, setScanDate]   = useState("");
  const [noteEdit, setNoteEdit]   = useState<string | null>(null);
  const [noteVal, setNoteVal]     = useState("");

  // Load watchlist from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem("ft-watchlist");
      if (saved) setWatchlist(JSON.parse(saved));
    } catch {}
  }, []);

  // Save to localStorage whenever watchlist changes
  useEffect(() => {
    localStorage.setItem("ft-watchlist", JSON.stringify(watchlist));
  }, [watchlist]);

  // Fetch live signal data
  const fetchLive = useCallback(async (tickers: string[]) => {
    if (!tickers.length) return;
    setLoading(true);
    try {
      const res  = await fetch(`${API_BASE}/api/signal-scanner`);
      const json = await res.json();
      setScanDate(json.date || "");
      const map: Record<string, LiveData> = {};
      for (const row of (json.data || [])) {
        if (tickers.includes(row.ticker)) map[row.ticker] = row;
      }
      setLiveData(map);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    if (watchlist.length) fetchLive(watchlist.map(w => w.ticker));
  }, [watchlist.length, fetchLive]);

  const addTicker = (raw: string) => {
    const t = raw.toUpperCase().trim().replace(/[^A-Z0-9]/g, "");
    if (!t || watchlist.some(w => w.ticker === t)) return;
    setWatchlist(prev => [...prev, { ticker: t, addedAt: new Date().toISOString() }]);
    setInput("");
  };

  const remove = (ticker: string) => setWatchlist(prev => prev.filter(w => w.ticker !== ticker));

  const saveNote = (ticker: string) => {
    setWatchlist(prev => prev.map(w => w.ticker === ticker ? { ...w, note: noteVal } : w));
    setNoteEdit(null);
  };

  const bullish  = Object.values(liveData).filter(d => d.score >= 56).length;
  const bearish  = Object.values(liveData).filter(d => d.score <= 44).length;
  const avgScore = watchlist.length
    ? Math.round(Object.values(liveData).reduce((a, d) => a + d.score, 0) / Math.max(Object.values(liveData).length, 1))
    : 0;

  return (
    <>
      <Navbar />
      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "28px 24px" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 4, height: 32, background: "linear-gradient(180deg,#e3b341,#f0883e)", borderRadius: 2 }} />
            <div>
              <h1 style={{ fontSize: 24, fontWeight: 900, color: "var(--text-primary)", letterSpacing: "0.04em", margin: 0 }}>
                WATCHLIST
              </h1>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                Pantau saham incaran lo · Live score update · Data per <strong>{scanDate || "–"}</strong>
              </div>
            </div>
          </div>
          <button onClick={() => fetchLive(watchlist.map(w => w.ticker))} disabled={loading || !watchlist.length}
            style={{
              padding: "8px 18px", borderRadius: 8, border: "1px solid var(--border)",
              background: "var(--bg-tertiary)", color: "var(--text-secondary)",
              cursor: "pointer", fontSize: 12, fontWeight: 700, opacity: loading ? 0.5 : 1,
              display: "flex", alignItems: "center", gap: 8,
            }}>
            <span style={{ display: "inline-block", animation: loading ? "spin 1s linear infinite" : "none" }}>⟳</span>
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>

        {/* Stats */}
        {watchlist.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 20 }}>
            {[
              { label: "TOTAL WATCHED",   value: watchlist.length,  color: "#58a6ff" },
              { label: "BULLISH SIGNAL",  value: bullish,           color: "#3fb950" },
              { label: "BEARISH SIGNAL",  value: bearish,           color: "#f85149" },
              { label: "AVG SCORE",       value: avgScore || "–",   color: avgScore >= 56 ? "#3fb950" : avgScore <= 44 ? "#f85149" : "#e3b341" },
            ].map(s => (
              <div key={s.label} style={{ background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border)", padding: "14px 18px" }}>
                <div style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 700, letterSpacing: "0.08em", marginBottom: 6 }}>{s.label}</div>
                <div style={{ fontSize: 26, fontWeight: 900, color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Add ticker input */}
        <div style={{ background: "var(--bg-secondary)", borderRadius: 14, border: "1px solid var(--border)", padding: 20, marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", marginBottom: 12, letterSpacing: "0.06em" }}>
            TAMBAH SAHAM KE WATCHLIST
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === "Enter" && addTicker(input)}
              placeholder="Ketik kode saham... (e.g. BBCA)"
              style={{
                flex: 1, minWidth: 200, padding: "10px 16px", borderRadius: 8,
                border: "1px solid var(--border)", background: "var(--bg-primary)",
                color: "var(--text-primary)", fontSize: 14, fontWeight: 700,
                outline: "none", letterSpacing: "0.08em",
              }}
            />
            <button onClick={() => addTicker(input)} style={{
              padding: "10px 24px", borderRadius: 8, border: "none",
              background: "linear-gradient(135deg,#2f81f7,#39d2f5)",
              color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer",
            }}>+ TAMBAH</button>
          </div>
          {/* Quick add popular */}
          <div style={{ marginTop: 12, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600 }}>Quick add:</span>
            {POPULAR.map(t => (
              <button key={t} onClick={() => addTicker(t)}
                disabled={watchlist.some(w => w.ticker === t)}
                style={{
                  fontSize: 10, padding: "3px 10px", borderRadius: 12,
                  border: "1px solid var(--border)", background: "transparent",
                  color: watchlist.some(w => w.ticker === t) ? "var(--text-muted)" : "var(--text-secondary)",
                  cursor: watchlist.some(w => w.ticker === t) ? "default" : "pointer",
                  opacity: watchlist.some(w => w.ticker === t) ? 0.4 : 1,
                  fontWeight: 700,
                }}>{t}</button>
            ))}
          </div>
        </div>

        {/* Empty state */}
        {watchlist.length === 0 && (
          <div style={{
            background: "var(--bg-secondary)", borderRadius: 14, border: "1px dashed var(--border)",
            padding: "60px 24px", textAlign: "center",
          }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>📋</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "var(--text-primary)", marginBottom: 8 }}>Watchlist masih kosong</div>
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
              Tambahkan saham di atas atau temukan saham dari{" "}
              <Link href="/signal-scanner" style={{ color: "#58a6ff", textDecoration: "none", fontWeight: 700 }}>Signal Scanner</Link>
            </div>
          </div>
        )}

        {/* Watchlist cards */}
        {watchlist.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {watchlist.map((item, idx) => {
              const live = liveData[item.ticker];
              const cfg  = live ? (SIGNAL_CFG[live.signal] || SIGNAL_CFG["NEUTRAL"]) : null;
              const isUp = (live?.dailyChange || 0) > 0;
              const isDown = (live?.dailyChange || 0) < 0;

              return (
                <div key={item.ticker} style={{
                  background: "var(--bg-secondary)", borderRadius: 14,
                  border: `1px solid ${live && live.score >= 65 ? "rgba(63,185,80,0.25)" : live && live.score <= 35 ? "rgba(248,81,73,0.2)" : "var(--border)"}`,
                  padding: "18px 22px", transition: "border-color 0.3s",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>

                    {/* Score ring */}
                    {live ? <ScoreRing score={live.score} /> : (
                      <div style={{ width: 52, height: 52, borderRadius: "50%", background: "#21262d", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <span style={{ fontSize: 18 }}>{loading ? "⟳" : "?"}</span>
                      </div>
                    )}

                    {/* Ticker + price */}
                    <div style={{ flex: 1, minWidth: 120 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                        <Link href={`/broker-activity?ticker=${item.ticker}`} style={{ textDecoration: "none" }}>
                          <span style={{ fontSize: 18, fontWeight: 900, color: "#58a6ff" }}>{item.ticker}</span>
                        </Link>
                        {live && cfg && (
                          <span style={{
                            fontSize: 9, fontWeight: 800, padding: "2px 8px", borderRadius: 5,
                            background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}`,
                            letterSpacing: "0.06em",
                          }}>{cfg.icon} {live.signal}</span>
                        )}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 16, fontWeight: 800, color: "var(--text-primary)" }}>
                          {live?.price ? `Rp ${live.price.toLocaleString("id-ID")}` : "–"}
                        </span>
                        {live && (
                          <span style={{
                            fontSize: 13, fontWeight: 700,
                            color: isUp ? "#3fb950" : isDown ? "#f85149" : "var(--text-muted)",
                          }}>
                            {live.dailyChange > 0 ? "+" : ""}{live.dailyChange.toFixed(2)}%
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Sparkline */}
                    {live && (
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                        <MiniSparkline days={live.days} />
                        <span style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 600 }}>5D TREND</span>
                      </div>
                    )}

                    {/* Broker info */}
                    {live && (
                      <div style={{ display: "flex", gap: 16 }}>
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 700, marginBottom: 3 }}>TOP BUYER</div>
                          <div style={{ fontSize: 14, fontWeight: 900, color: "#3fb950" }}>{live.topBuyer || "–"}</div>
                        </div>
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 700, marginBottom: 3 }}>TOP SELLER</div>
                          <div style={{ fontSize: 14, fontWeight: 900, color: "#f85149" }}>{live.topSeller || "–"}</div>
                        </div>
                      </div>
                    )}

                    {/* Actions */}
                    <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                      <Link href={`/broker-activity?ticker=${item.ticker}`}>
                        <button style={{
                          padding: "6px 14px", borderRadius: 7, border: "1px solid var(--border)",
                          background: "rgba(56,139,253,0.08)", color: "#58a6ff",
                          cursor: "pointer", fontSize: 11, fontWeight: 700,
                        }}>Detail</button>
                      </Link>
                      <button onClick={() => { setNoteEdit(item.ticker); setNoteVal(item.note || ""); }}
                        style={{
                          padding: "6px 14px", borderRadius: 7, border: "1px solid var(--border)",
                          background: item.note ? "rgba(227,179,65,0.08)" : "transparent",
                          color: item.note ? "#e3b341" : "var(--text-muted)",
                          cursor: "pointer", fontSize: 11, fontWeight: 700,
                        }}>📝 Note</button>
                      <button onClick={() => remove(item.ticker)}
                        style={{
                          padding: "6px 12px", borderRadius: 7, border: "1px solid rgba(248,81,73,0.3)",
                          background: "rgba(248,81,73,0.06)", color: "#f85149",
                          cursor: "pointer", fontSize: 11, fontWeight: 700,
                        }}>✕</button>
                    </div>
                  </div>

                  {/* Note display */}
                  {item.note && noteEdit !== item.ticker && (
                    <div style={{ marginTop: 12, padding: "8px 12px", borderRadius: 8, background: "rgba(227,179,65,0.06)", border: "1px solid rgba(227,179,65,0.2)", fontSize: 12, color: "#e3b341" }}>
                      📝 {item.note}
                    </div>
                  )}

                  {/* Note editor */}
                  {noteEdit === item.ticker && (
                    <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                      <input value={noteVal} onChange={e => setNoteVal(e.target.value)}
                        placeholder="Tulis catatan trading lo..."
                        autoFocus
                        style={{
                          flex: 1, padding: "8px 12px", borderRadius: 7,
                          border: "1px solid var(--border)", background: "var(--bg-primary)",
                          color: "var(--text-primary)", fontSize: 12,
                        }}
                      />
                      <button onClick={() => saveNote(item.ticker)}
                        style={{ padding: "8px 16px", borderRadius: 7, border: "none", background: "#e3b341", color: "#0d1117", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>Save</button>
                      <button onClick={() => setNoteEdit(null)}
                        style={{ padding: "8px 12px", borderRadius: 7, border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", fontSize: 12, cursor: "pointer" }}>Cancel</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {watchlist.length > 0 && (
          <div style={{ marginTop: 12, textAlign: "center", fontSize: 11, color: "var(--text-muted)" }}>
            Watchlist disimpan di browser lo · {watchlist.length} saham terpantau
          </div>
        )}
      </main>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        input::placeholder { color: var(--text-muted); }
      `}</style>
    </>
  );
}
