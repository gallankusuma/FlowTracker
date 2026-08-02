"use client";
import React, { useState, useEffect, useCallback } from "react";
import Navbar from "../../components/Navbar";

type Pick = {
  id: number;
  scan_date: string;
  ticker: string;
  last_val_b: number;
  day0_conc: number;
  day1_conc: number;
  day2_conc: number;
  day3_conc: number;
  positive_days: number;
  signal_score: number;
  market_price: number;
  status: "PENDING" | "WATCHING" | "ACTIVE" | "WIN" | "LOSS" | "SKIP";
  entry_price: number | null;
  close_price: number | null;
  pnl_pct: number | null;
  notes: string | null;
  created_at: string;
};

type WinRate = {
  total: number;
  closed: number;
  wins: number;
  losses: number;
  win_rate: number;
  avg_pnl: number;
  avg_win_pnl: number;
  avg_loss_pnl: number;
  weekly: { week: string; week_start: string; wins: number; losses: number; win_rate: number }[];
  best: { ticker: string; pnl: number; scan_date: string }[];
  worst: { ticker: string; pnl: number; scan_date: string }[];
};

type SimStatus = {
  summary: {
    total: number; wins: number; losses: number; win_rate: number;
    avg_pnl: number; avg_win_pnl: number; avg_loss_pnl: number;
    from_date: string; to_date: string;
  };
  byDate: { scan_date: string; picks: number; wins: number; losses: number; win_rate: number; avg_pnl: number }[];
};

const API = "http://76.13.22.155:3100";

function formatVal(b: number) {
  if (b >= 1000) return (b / 1000).toFixed(1) + "T";
  if (b >= 1)    return b.toFixed(1) + "B";
  return (b * 1000).toFixed(0) + "M";
}

function ConcBadge({ val }: { val: number }) {
  const color = val > 0 ? "#22c55e" : val < 0 ? "#ef4444" : "#6b7280";
  return (
    <span style={{ color, fontWeight: 600, fontSize: 13 }}>
      {val > 0 ? "+" : ""}{val?.toFixed(1)}%
    </span>
  );
}

function StatusBadge({ status }: { status: Pick["status"] }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    PENDING:  { bg: "#1e293b", color: "#94a3b8", label: "PENDING" },
    WATCHING: { bg: "#1e3a5f", color: "#60a5fa", label: "WATCHING" },
    ACTIVE:   { bg: "#1a3a2a", color: "#34d399", label: "ACTIVE" },
    WIN:      { bg: "#14532d", color: "#4ade80", label: "✅ WIN" },
    LOSS:     { bg: "#450a0a", color: "#f87171", label: "❌ LOSS" },
    SKIP:     { bg: "#1c1c1c", color: "#6b7280", label: "SKIP" },
  };
  const s = map[status] || map.PENDING;
  return (
    <span style={{ background: s.bg, color: s.color, borderRadius: 6, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>
      {s.label}
    </span>
  );
}

export default function DailyPicksPage() {
  const [tab, setTab]           = useState<"picks" | "sim">("picks");
  const [picks, setPicks]       = useState<Pick[]>([]);
  const [winRate, setWinRate]   = useState<WinRate | null>(null);
  const [simStatus, setSimStatus] = useState<SimStatus | null>(null);
  const [loading, setLoading]   = useState(false);
  const [scanDate, setScanDate] = useState("");
  const [editId, setEditId]     = useState<number | null>(null);
  const [editData, setEditData] = useState<{ entry_price?: string; close_price?: string; status?: string; notes?: string }>({});
  const [simRunning, setSimRunning] = useState(false);
  const [simFrom, setSimFrom]   = useState("2026-01-01");
  const [simTo, setSimTo]       = useState(new Date().toISOString().slice(0, 10));
  const [scannerMsg, setScannerMsg] = useState("");

  const fetchPicks = useCallback(async (date?: string) => {
    setLoading(true);
    try {
      const url = date ? `${API}/api/scanner/picks?date=${date}` : `${API}/api/scanner/picks`;
      const r = await fetch(url);
      const j = await r.json();
      setPicks(j.data || []);
      if (j.date) setScanDate(j.date);
    } finally { setLoading(false); }
  }, []);

  const fetchWinRate = useCallback(async () => {
    const r = await fetch(`${API}/api/scanner/winrate`);
    setWinRate(await r.json());
  }, []);

  const fetchSimStatus = useCallback(async () => {
    const r = await fetch(`${API}/api/scanner/simulation-status`);
    setSimStatus(await r.json());
  }, []);

  useEffect(() => { fetchPicks(); fetchWinRate(); fetchSimStatus(); }, [fetchPicks, fetchWinRate, fetchSimStatus]);

  const runScanner = async () => {
    setScannerMsg("🔍 Running scanner...");
    const r = await fetch(`${API}/api/scanner/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const j = await r.json();
    setScannerMsg(`✅ Done! ${j.total} picks found for ${j.date}`);
    fetchPicks();
    fetchWinRate();
  };

  const runSimulation = async () => {
    setSimRunning(true);
    await fetch(`${API}/api/scanner/simulate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_date: simFrom, to_date: simTo, target_pct: 5, stop_pct: 3, hold_days: 5 }),
    });
    setTimeout(() => { fetchSimStatus(); setSimRunning(false); }, 5000);
  };

  const updatePick = async (id: number) => {
    const body: Record<string, unknown> = {};
    if (editData.status)      body.status      = editData.status;
    if (editData.entry_price) body.entry_price = Number(editData.entry_price);
    if (editData.close_price) body.close_price = Number(editData.close_price);
    if (editData.notes)       body.notes       = editData.notes;
    if (editData.close_price && body.close_price) {
      const entry = picks.find(p => p.id === id)?.entry_price || Number(editData.entry_price) || 1;
      body.status = Number(editData.close_price) > entry ? "WIN" : "LOSS";
    }
    await fetch(`${API}/api/scanner/picks/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    setEditId(null); setEditData({});
    fetchPicks(); fetchWinRate();
  };

  const pendingPicks  = picks.filter(p => p.status === "PENDING" || p.status === "WATCHING");
  const activePicks   = picks.filter(p => p.status === "ACTIVE");
  const closedPicks   = picks.filter(p => p.status === "WIN" || p.status === "LOSS");

  return (
    <div style={{ minHeight: "100vh", background: "#0a0f1a", color: "#e2e8f0", fontFamily: "'Inter', sans-serif" }}>
      <Navbar />
      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "24px 16px" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0, background: "linear-gradient(135deg, #60a5fa, #a78bfa)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              🎯 Daily Picks
            </h1>
            <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: 13 }}>
              Auto-scanner · Broker accumulation + TA confirmation · Win rate tracking
            </p>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={runScanner} style={{ background: "linear-gradient(135deg, #2563eb, #7c3aed)", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", fontWeight: 700, cursor: "pointer", fontSize: 13 }}>
              ▶ Run Scanner
            </button>
            {scannerMsg && <span style={{ fontSize: 12, color: "#60a5fa" }}>{scannerMsg}</span>}
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, marginBottom: 24, borderBottom: "1px solid #1e293b" }}>
          {(["picks", "sim"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: tab === t ? "#1e293b" : "none", border: "none", color: tab === t ? "#60a5fa" : "#64748b",
              padding: "8px 20px", borderRadius: "8px 8px 0 0", cursor: "pointer", fontWeight: 700, fontSize: 13
            }}>
              {t === "picks" ? "📋 Picks & Journal" : "📊 Backtest Simulation"}
            </button>
          ))}
        </div>

        {tab === "picks" && (
          <>
            {/* Win Rate Summary */}
            {winRate && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 24 }}>
                {[
                  { label: "Win Rate", val: `${winRate.win_rate ?? 0}%`, color: "#4ade80" },
                  { label: "Total Closed", val: winRate.closed ?? 0, color: "#60a5fa" },
                  { label: "Wins", val: winRate.wins ?? 0, color: "#4ade80" },
                  { label: "Losses", val: winRate.losses ?? 0, color: "#f87171" },
                  { label: "Avg P&L", val: `${winRate.avg_pnl ?? 0}%`, color: (winRate.avg_pnl ?? 0) >= 0 ? "#4ade80" : "#f87171" },
                ].map(s => (
                  <div key={s.label} style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 10, padding: "14px 16px" }}>
                    <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>{s.label}</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: s.color }}>{s.val}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Scanner Picks Table */}
            <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12, marginBottom: 24, overflow: "hidden" }}>
              <div style={{ padding: "14px 18px", borderBottom: "1px solid #1e293b", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>🔍 Scanner Picks</span>
                <span style={{ fontSize: 12, color: "#64748b" }}>DATA PER [{scanDate}]</span>
                <span style={{ marginLeft: "auto", fontSize: 12, color: "#94a3b8" }}>{pendingPicks.length} pending</span>
              </div>
              {loading ? (
                <div style={{ textAlign: "center", padding: 40, color: "#64748b" }}>Loading...</div>
              ) : pendingPicks.length === 0 ? (
                <div style={{ textAlign: "center", padding: 40, color: "#64748b" }}>
                  No picks yet — click <strong>Run Scanner</strong> to generate today&apos;s picks
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: "#0a0f1a" }}>
                        {["TICKER", "LAST VAL", "D-3", "D-2", "D-1", "D 0", "+DAYS", "SCORE", "PRICE", "STATUS", "ACTION"].map(h => (
                          <th key={h} style={{ padding: "10px 12px", textAlign: h === "ACTION" ? "center" : "left", color: "#64748b", fontWeight: 600, fontSize: 11, whiteSpace: "nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {pendingPicks.map(p => (
                        <tr key={p.id} style={{ borderTop: "1px solid #1e293b" }}>
                          <td style={{ padding: "10px 12px", fontWeight: 700, color: "#e2e8f0" }}>{p.ticker}</td>
                          <td style={{ padding: "10px 12px", color: "#94a3b8" }}>{formatVal(p.last_val_b)}</td>
                          <td style={{ padding: "10px 12px" }}><ConcBadge val={p.day3_conc} /></td>
                          <td style={{ padding: "10px 12px" }}><ConcBadge val={p.day2_conc} /></td>
                          <td style={{ padding: "10px 12px" }}><ConcBadge val={p.day1_conc} /></td>
                          <td style={{ padding: "10px 12px" }}><ConcBadge val={p.day0_conc} /></td>
                          <td style={{ padding: "10px 12px", color: "#a78bfa", fontWeight: 700 }}>{p.positive_days}/4</td>
                          <td style={{ padding: "10px 12px", color: "#fbbf24", fontWeight: 700 }}>{p.signal_score}</td>
                          <td style={{ padding: "10px 12px", color: "#94a3b8" }}>{p.market_price ? `Rp${p.market_price.toLocaleString()}` : "-"}</td>
                          <td style={{ padding: "10px 12px" }}><StatusBadge status={p.status} /></td>
                          <td style={{ padding: "10px 12px", textAlign: "center" }}>
                            {editId === p.id ? (
                              <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 160 }}>
                                <select value={editData.status || p.status} onChange={e => setEditData(d => ({ ...d, status: e.target.value }))}
                                  style={{ background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 6, padding: "4px 6px", fontSize: 12 }}>
                                  {["PENDING", "WATCHING", "ACTIVE", "WIN", "LOSS", "SKIP"].map(s => <option key={s} value={s}>{s}</option>)}
                                </select>
                                <input placeholder="Entry price" value={editData.entry_price || ""} onChange={e => setEditData(d => ({ ...d, entry_price: e.target.value }))}
                                  style={{ background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 6, padding: "4px 6px", fontSize: 12 }} />
                                <div style={{ display: "flex", gap: 4 }}>
                                  <button onClick={() => updatePick(p.id)} style={{ flex: 1, background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, padding: "4px", cursor: "pointer", fontSize: 11 }}>Save</button>
                                  <button onClick={() => { setEditId(null); setEditData({}); }} style={{ flex: 1, background: "#374151", color: "#fff", border: "none", borderRadius: 6, padding: "4px", cursor: "pointer", fontSize: 11 }}>Cancel</button>
                                </div>
                              </div>
                            ) : (
                              <button onClick={() => setEditId(p.id)} style={{ background: "#1e293b", color: "#60a5fa", border: "1px solid #334155", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 11 }}>
                                📌 Track
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Active Trades */}
            {activePicks.length > 0 && (
              <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12, marginBottom: 24, overflow: "hidden" }}>
                <div style={{ padding: "14px 18px", borderBottom: "1px solid #1e293b", fontWeight: 700, fontSize: 14 }}>
                  🟢 Active Trades ({activePicks.length})
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: "#0a0f1a" }}>
                        {["TICKER", "SCAN DATE", "ENTRY PRICE", "CLOSE PRICE", "P&L %", "STATUS", "ACTION"].map(h => (
                          <th key={h} style={{ padding: "10px 12px", textAlign: "left", color: "#64748b", fontWeight: 600, fontSize: 11 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {activePicks.map(p => (
                        <tr key={p.id} style={{ borderTop: "1px solid #1e293b" }}>
                          <td style={{ padding: "10px 12px", fontWeight: 700, color: "#e2e8f0" }}>{p.ticker}</td>
                          <td style={{ padding: "10px 12px", color: "#64748b" }}>{p.scan_date}</td>
                          <td style={{ padding: "10px 12px", color: "#94a3b8" }}>{p.entry_price ? `Rp${p.entry_price.toLocaleString()}` : "-"}</td>
                          <td style={{ padding: "10px 12px", color: "#94a3b8" }}>{p.close_price ? `Rp${p.close_price.toLocaleString()}` : "-"}</td>
                          <td style={{ padding: "10px 12px", fontWeight: 700, color: (p.pnl_pct ?? 0) >= 0 ? "#4ade80" : "#f87171" }}>
                            {p.pnl_pct != null ? `${p.pnl_pct > 0 ? "+" : ""}${p.pnl_pct}%` : "-"}
                          </td>
                          <td style={{ padding: "10px 12px" }}><StatusBadge status={p.status} /></td>
                          <td style={{ padding: "10px 12px" }}>
                            {editId === p.id ? (
                              <div style={{ display: "flex", gap: 4 }}>
                                <input placeholder="Close price" value={editData.close_price || ""} onChange={e => setEditData(d => ({ ...d, close_price: e.target.value }))}
                                  style={{ background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 6, padding: "4px 8px", fontSize: 12, width: 100 }} />
                                <button onClick={() => updatePick(p.id)} style={{ background: "#16a34a", color: "#fff", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 11 }}>Close</button>
                                <button onClick={() => { setEditId(null); setEditData({}); }} style={{ background: "#374151", color: "#fff", border: "none", borderRadius: 6, padding: "4px 8px", cursor: "pointer", fontSize: 11 }}>✕</button>
                              </div>
                            ) : (
                              <button onClick={() => setEditId(p.id)} style={{ background: "#1e293b", color: "#f87171", border: "1px solid #334155", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 11 }}>
                                💰 Close Position
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

            {/* Closed Trades */}
            {closedPicks.length > 0 && (
              <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12, overflow: "hidden" }}>
                <div style={{ padding: "14px 18px", borderBottom: "1px solid #1e293b", fontWeight: 700, fontSize: 14 }}>
                  📁 Closed Today ({closedPicks.length})
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: "#0a0f1a" }}>
                        {["TICKER", "ENTRY", "CLOSE", "P&L %", "STATUS"].map(h => (
                          <th key={h} style={{ padding: "10px 12px", textAlign: "left", color: "#64748b", fontWeight: 600, fontSize: 11 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {closedPicks.map(p => (
                        <tr key={p.id} style={{ borderTop: "1px solid #1e293b" }}>
                          <td style={{ padding: "10px 12px", fontWeight: 700, color: "#e2e8f0" }}>{p.ticker}</td>
                          <td style={{ padding: "10px 12px", color: "#94a3b8" }}>{p.entry_price ? `Rp${p.entry_price.toLocaleString()}` : "-"}</td>
                          <td style={{ padding: "10px 12px", color: "#94a3b8" }}>{p.close_price ? `Rp${p.close_price.toLocaleString()}` : "-"}</td>
                          <td style={{ padding: "10px 12px", fontWeight: 800, fontSize: 15, color: (p.pnl_pct ?? 0) >= 0 ? "#4ade80" : "#f87171" }}>
                            {p.pnl_pct != null ? `${p.pnl_pct > 0 ? "+" : ""}${p.pnl_pct}%` : "-"}
                          </td>
                          <td style={{ padding: "10px 12px" }}><StatusBadge status={p.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        {tab === "sim" && (
          <>
            {/* Simulation Controls */}
            <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12, padding: 20, marginBottom: 24 }}>
              <h3 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 700, color: "#a78bfa" }}>📊 Historical Backtest Simulation</h3>
              <p style={{ margin: "0 0 16px", fontSize: 13, color: "#64748b", lineHeight: 1.6 }}>
                Jalankan simulasi otomatis pada data historis. Scanner criteria (Day0 &gt; 0%, Last Val &gt; Rp10B) diterapkan pada setiap tanggal, lalu outcome dihitung berdasarkan target +5% / stop -3% dalam 5 hari.
              </p>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
                <div>
                  <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>FROM DATE</div>
                  <input type="date" value={simFrom} onChange={e => setSimFrom(e.target.value)}
                    style={{ background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 8, padding: "8px 12px", fontSize: 13 }} />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>TO DATE</div>
                  <input type="date" value={simTo} onChange={e => setSimTo(e.target.value)}
                    style={{ background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 8, padding: "8px 12px", fontSize: 13 }} />
                </div>
                <button onClick={runSimulation} disabled={simRunning} style={{
                  background: simRunning ? "#334155" : "linear-gradient(135deg, #7c3aed, #2563eb)",
                  color: "#fff", border: "none", borderRadius: 8, padding: "10px 24px",
                  fontWeight: 700, cursor: simRunning ? "not-allowed" : "pointer", fontSize: 13
                }}>
                  {simRunning ? "⏳ Running..." : "🚀 Run Backtest"}
                </button>
                <button onClick={fetchSimStatus} style={{ background: "#1e293b", color: "#60a5fa", border: "1px solid #334155", borderRadius: 8, padding: "10px 16px", cursor: "pointer", fontSize: 13 }}>
                  🔄 Refresh
                </button>
              </div>
            </div>

            {/* Simulation Results */}
            {simStatus?.summary && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 24 }}>
                  {[
                    { label: "Win Rate", val: `${simStatus.summary.win_rate ?? 0}%`, color: "#4ade80" },
                    { label: "Total Trades", val: simStatus.summary.total ?? 0, color: "#60a5fa" },
                    { label: "Wins", val: simStatus.summary.wins ?? 0, color: "#4ade80" },
                    { label: "Losses", val: simStatus.summary.losses ?? 0, color: "#f87171" },
                    { label: "Avg P&L", val: `${simStatus.summary.avg_pnl ?? 0}%`, color: (simStatus.summary.avg_pnl ?? 0) >= 0 ? "#4ade80" : "#f87171" },
                    { label: "Avg Win", val: `+${simStatus.summary.avg_win_pnl ?? 0}%`, color: "#4ade80" },
                    { label: "Avg Loss", val: `${simStatus.summary.avg_loss_pnl ?? 0}%`, color: "#f87171" },
                  ].map(s => (
                    <div key={s.label} style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 10, padding: "14px 16px" }}>
                      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>{s.label}</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: s.color }}>{s.val}</div>
                    </div>
                  ))}
                </div>

                <div style={{ fontSize: 12, color: "#64748b", marginBottom: 16 }}>
                  Periode: {simStatus.summary.from_date} → {simStatus.summary.to_date}
                </div>

                {/* By Date Table */}
                <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12, overflow: "hidden" }}>
                  <div style={{ padding: "14px 18px", borderBottom: "1px solid #1e293b", fontWeight: 700, fontSize: 14 }}>
                    📅 Hasil per Tanggal
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: "#0a0f1a" }}>
                          {["SCAN DATE", "PICKS", "WINS", "LOSSES", "WIN RATE", "AVG P&L"].map(h => (
                            <th key={h} style={{ padding: "10px 14px", textAlign: "left", color: "#64748b", fontWeight: 600, fontSize: 11 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(simStatus.byDate || []).map(d => (
                          <tr key={d.scan_date} style={{ borderTop: "1px solid #1e293b" }}>
                            <td style={{ padding: "10px 14px", color: "#94a3b8" }}>{d.scan_date}</td>
                            <td style={{ padding: "10px 14px", color: "#e2e8f0" }}>{d.picks}</td>
                            <td style={{ padding: "10px 14px", color: "#4ade80", fontWeight: 700 }}>{d.wins}</td>
                            <td style={{ padding: "10px 14px", color: "#f87171", fontWeight: 700 }}>{d.losses}</td>
                            <td style={{ padding: "10px 14px" }}>
                              <span style={{ color: (d.win_rate ?? 0) >= 50 ? "#4ade80" : "#f87171", fontWeight: 800 }}>
                                {d.win_rate ?? 0}%
                              </span>
                            </td>
                            <td style={{ padding: "10px 14px", fontWeight: 700, color: (d.avg_pnl ?? 0) >= 0 ? "#4ade80" : "#f87171" }}>
                              {(d.avg_pnl ?? 0) >= 0 ? "+" : ""}{d.avg_pnl ?? 0}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}

            {!simStatus?.summary?.total && (
              <div style={{ textAlign: "center", padding: 60, color: "#64748b" }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>Belum ada data simulasi</div>
                <div style={{ fontSize: 13 }}>Klik <strong style={{ color: "#a78bfa" }}>Run Backtest</strong> untuk mulai simulasi historis</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
