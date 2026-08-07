"use client";
import Navbar from "@/components/Navbar";
import { useState, useEffect, useMemo } from "react";

type Trade = {
  id: string;
  ticker: string;
  date: string;
  exitDate?: string;
  type: "BUY" | "SELL_SHORT";
  entry: number;
  exit?: number;
  stopLoss?: number;
  lot: number;
  reason: string;
  tags: string[];
  status: "OPEN" | "WIN" | "LOSS" | "BREAKEVEN";
  note?: string;
};

const TAG_OPTIONS = ["Bandarmologi","Fibonacci","Breakout","Support","Akumulasi","Distribusi","Reversal","Momentum","Swing","Scalping"];
const REASONS = ["Broker akumulasi kuat","Fibonacci level","Support terbukti","Breakout volume","Insider moves","Trend following","Signal Scanner"];

function fmt(n: number) {
  if (Math.abs(n) >= 1e9)  return `${(n/1e9).toFixed(2)}M`;
  if (Math.abs(n) >= 1e6)  return `${(n/1e6).toFixed(1)}jt`;
  if (Math.abs(n) >= 1e3)  return `${(n/1e3).toFixed(0)}rb`;
  return Math.round(n).toLocaleString("id-ID");
}

function calcPnL(t: Trade) {
  if (!t.exit) return null;
  const dir = t.type === "BUY" ? 1 : -1;
  return dir * (t.exit - t.entry) * t.lot * 100;
}

function calcRR(t: Trade) {
  if (!t.exit || !t.stopLoss) return null;
  const risk   = Math.abs(t.entry - t.stopLoss) * t.lot * 100;
  const reward = Math.abs(t.exit  - t.entry)    * t.lot * 100;
  return risk > 0 ? (reward / risk) * (t.exit > t.entry ? 1 : -1) : null;
}

const STATUS_CFG = {
  OPEN:      { color: "#58a6ff", bg: "rgba(88,166,255,0.1)",  border: "rgba(88,166,255,0.3)",  label: "OPEN" },
  WIN:       { color: "#3fb950", bg: "rgba(63,185,80,0.1)",   border: "rgba(63,185,80,0.3)",   label: "WIN ✓" },
  LOSS:      { color: "#f85149", bg: "rgba(248,81,73,0.1)",   border: "rgba(248,81,73,0.3)",   label: "LOSS ✗" },
  BREAKEVEN: { color: "#e3b341", bg: "rgba(227,179,65,0.1)",  border: "rgba(227,179,65,0.3)",  label: "EVEN ─" },
};

const DEFAULT_FORM: Omit<Trade, "id"> = {
  ticker: "", date: new Date().toISOString().split("T")[0], exitDate: "",
  type: "BUY", entry: 0, exit: undefined, stopLoss: undefined,
  lot: 1, reason: "", tags: [], status: "OPEN", note: "",
};

export default function TradeJournal() {
  const [trades, setTrades]   = useState<Trade[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId]   = useState<string | null>(null);
  const [form, setForm]       = useState<Omit<Trade,"id">>(DEFAULT_FORM);
  const [filterStatus, setFilterStatus] = useState("ALL");
  const [filterTicker, setFilterTicker] = useState("");
  const [tab, setTab]         = useState<"journal"|"stats">("journal");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  const [undo, setUndo] = useState<{ trades: Trade[]; at: number } | null>(null);

  // Persist
  useEffect(() => {
    try { const s = localStorage.getItem("ft-journal"); if (s) setTrades(JSON.parse(s)); } catch {}
  }, []);
  useEffect(() => { localStorage.setItem("ft-journal", JSON.stringify(trades)); }, [trades]);

  const save = () => {
    if (!form.ticker || !form.entry || !form.lot) return;
    const ticker = form.ticker.toUpperCase().trim();
    const pnl = form.exit ? (form.type === "BUY" ? 1 : -1) * (form.exit - form.entry) * form.lot * 100 : null;
    let status: Trade["status"] = "OPEN";
    if (form.exit) {
      if (pnl! > 0) status = "WIN";
      else if (pnl! < 0) status = "LOSS";
      else status = "BREAKEVEN";
    }
    if (editId) {
      setTrades(prev => prev.map(t => t.id === editId ? { ...form, ticker, status, id: editId } : t));
      setEditId(null);
    } else {
      setTrades(prev => [{ ...form, ticker, status, id: Date.now().toString() }, ...prev]);
    }
    setForm(DEFAULT_FORM); setShowForm(false);
  };

  /**
   * Deleting is the only irreversible thing this page does.
   *
   * The journal lives in localStorage and nowhere else — no server copy, no
   * backup, no export unless you took one. So every delete keeps the removed
   * rows around long enough to put them back, and the single-row ✕ goes through
   * the same path it always did rather than dropping a trade instantly on a
   * misclick.
   */
  const removeTrades = (ids: string[]) => {
    if (!ids.length) return;
    const idSet = new Set(ids);
    const removed = trades.filter(t => idSet.has(t.id));
    if (!removed.length) return;
    setTrades(prev => prev.filter(t => !idSet.has(t.id)));
    setSelected(prev => { const n = new Set(prev); ids.forEach(i => n.delete(i)); return n; });
    setConfirmingBulk(false);
    setUndo({ trades: removed, at: Date.now() });
  };

  const deleteTrade = (id: string) => removeTrades([id]);

  const restoreUndo = () => {
    if (!undo) return;
    // Re-inserted by date so a restored row lands back where it belongs rather
    // than at the end of the list.
    setTrades(prev => [...prev, ...undo.trades].sort((a, b) => b.date.localeCompare(a.date)));
    setUndo(null);
  };

  const startEdit = (t: Trade) => {
    setForm({ ticker: t.ticker, date: t.date, exitDate: t.exitDate, type: t.type, entry: t.entry,
      exit: t.exit, stopLoss: t.stopLoss, lot: t.lot, reason: t.reason, tags: t.tags, status: t.status, note: t.note });
    setEditId(t.id); setShowForm(true);
  };

  const filtered = useMemo(() => {
    let d = trades;
    if (filterStatus !== "ALL") d = d.filter(t => t.status === filterStatus);
    if (filterTicker) d = d.filter(t => t.ticker.includes(filterTicker.toUpperCase()));
    return d;
  }, [trades, filterStatus, filterTicker]);

  /**
   * Only ever delete what is on screen.
   *
   * Selecting rows, then narrowing the filter, then hitting delete is the
   * obvious way to lose trades you were not looking at. So the bulk action
   * operates on selected ∩ visible, and the button prints that number — if it
   * disagrees with what you can see, the number is what happens.
   */
  const visibleSelected = useMemo(
    () => filtered.filter(t => selected.has(t.id)).map(t => t.id),
    [filtered, selected]);
  const allVisibleSelected = filtered.length > 0 && visibleSelected.length === filtered.length;

  const toggleOne = (id: string) => setSelected(prev => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const toggleAllVisible = () => setSelected(prev => {
    const n = new Set(prev);
    if (allVisibleSelected) filtered.forEach(t => n.delete(t.id));
    else filtered.forEach(t => n.add(t.id));
    return n;
  });

  // A confirmation that survives the thing it was asked about is a trap: change
  // the selection and the armed button now means something else.
  useEffect(() => { setConfirmingBulk(false); }, [visibleSelected.length]);

  // The undo offer expires, so it cannot sit there for an hour looking live.
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 15000);
    return () => clearTimeout(t);
  }, [undo]);

  const stats = useMemo(() => {
    const closed = trades.filter(t => t.status !== "OPEN");
    const wins   = trades.filter(t => t.status === "WIN");
    const losses = trades.filter(t => t.status === "LOSS");
    const totalPnL  = closed.reduce((a, t) => a + (calcPnL(t) || 0), 0);
    const winRate   = closed.length ? (wins.length / closed.length) * 100 : 0;
    const rrs       = closed.map(t => calcRR(t)).filter(Boolean) as number[];
    const avgRR     = rrs.length ? rrs.reduce((a,v) => a+v, 0) / rrs.length : 0;
    const bestTrade = [...closed].sort((a,b) => (calcPnL(b)||0) - (calcPnL(a)||0))[0];
    const worstTrade= [...closed].sort((a,b) => (calcPnL(a)||0) - (calcPnL(b)||0))[0];
    const avgWin    = wins.length  ? wins.reduce((a,t)   => a + (calcPnL(t)||0), 0) / wins.length  : 0;
    const avgLoss   = losses.length? losses.reduce((a,t) => a + (calcPnL(t)||0), 0) / losses.length: 0;
    // Equity curve
    let eq = 0;
    const equity = closed.map(t => { eq += (calcPnL(t)||0); return eq; });
    return { closed: closed.length, wins: wins.length, losses: losses.length, totalPnL, winRate, avgRR, bestTrade, worstTrade, avgWin, avgLoss, equity };
  }, [trades]);

  const f = (k: keyof typeof form, v: any) => setForm(prev => ({ ...prev, [k]: v }));
  const toggleTag = (tag: string) => {
    const tags = form.tags.includes(tag) ? form.tags.filter(t => t !== tag) : [...form.tags, tag];
    f("tags", tags);
  };

  // Mini equity curve SVG
  const EquityCurve = () => {
    if (stats.equity.length < 2) return <div style={{fontSize:11,color:"var(--text-muted)",textAlign:"center",padding:20}}>Belum ada data</div>;
    const min = Math.min(0, ...stats.equity);
    const max = Math.max(0, ...stats.equity);
    const range = max - min || 1;
    const W = 400, H = 80;
    const pts = stats.equity.map((v, i) => `${(i/(stats.equity.length-1))*W},${H - ((v-min)/range)*H}`).join(" ");
    const isPos = stats.totalPnL >= 0;
    return (
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: 80 }}>
        <polyline points={pts} fill="none" stroke={isPos ? "#3fb950" : "#f85149"} strokeWidth={2} />
        <line x1={0} y1={H - ((0-min)/range)*H} x2={W} y2={H - ((0-min)/range)*H}
          stroke="#484f58" strokeWidth={1} strokeDasharray="4 3" />
      </svg>
    );
  };

  return (
    <>
      <Navbar />
      <main style={{ maxWidth: 1300, margin: "0 auto", padding: "28px 24px" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 4, height: 32, background: "linear-gradient(180deg,#388bfd,#56d364)", borderRadius: 2 }} />
            <div>
              <h1 style={{ fontSize: 24, fontWeight: 900, color: "var(--text-primary)", letterSpacing: "0.04em", margin: 0 }}>TRADE JOURNAL</h1>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>Catat, evaluasi, dan improve · {trades.length} trade tercatat</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {trades.length > 0 && (
              <button onClick={() => {
                const csv = ["ID,Ticker,Date,Type,Entry,Exit,Lot,PnL,Status,Reason",
                  ...trades.map(t => `${t.id},${t.ticker},${t.date},${t.type},${t.entry},${t.exit||""},${t.lot},${calcPnL(t)||""},${t.status},"${t.reason}"`)
                ].join("\n");
                const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv]));
                a.download = "trade-journal.csv"; a.click();
              }} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                ↓ Export CSV
              </button>
            )}
            <button onClick={() => { setShowForm(true); setEditId(null); setForm(DEFAULT_FORM); }} style={{
              padding: "8px 20px", borderRadius: 8, border: "none",
              background: "linear-gradient(135deg,#2f81f7,#39d2f5)", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 800,
            }}>+ Catat Trade</button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 0, marginBottom: 20, borderBottom: "1px solid var(--border)" }}>
          {(["journal","stats"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: "10px 24px", background: "transparent", border: "none", borderBottom: `2px solid ${tab===t ? "#388bfd" : "transparent"}`,
              color: tab===t ? "#388bfd" : "var(--text-muted)", cursor: "pointer", fontSize: 13, fontWeight: 700, textTransform: "uppercase",
            }}>{t === "journal" ? "📋 Journal" : "📊 Statistik"}</button>
          ))}
        </div>

        {/* STATS TAB */}
        {tab === "stats" && (
          <div>
            {stats.closed === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--text-muted)" }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
                <div style={{ fontSize: 14 }}>Belum ada trade yang ditutup</div>
              </div>
            ) : (
              <>
                {/* Key stats */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 20 }}>
                  {[
                    { label: "TOTAL P&L", value: `${stats.totalPnL >= 0 ? "+" : ""}${fmt(stats.totalPnL)}`, sub: `${stats.closed} trade ditutup`, color: stats.totalPnL >= 0 ? "#3fb950" : "#f85149" },
                    { label: "WIN RATE",  value: `${stats.winRate.toFixed(1)}%`, sub: `${stats.wins}W / ${stats.losses}L`, color: stats.winRate >= 60 ? "#3fb950" : stats.winRate >= 40 ? "#e3b341" : "#f85149" },
                    { label: "AVG R:R",   value: `${stats.avgRR >= 0 ? "" : ""}${stats.avgRR.toFixed(2)}x`, sub: "rata-rata reward/risk", color: stats.avgRR >= 1.5 ? "#3fb950" : stats.avgRR >= 0 ? "#e3b341" : "#f85149" },
                    { label: "OPEN TRADE",value: trades.filter(t=>t.status==="OPEN").length, sub: "posisi masih aktif", color: "#58a6ff" },
                  ].map(s => (
                    <div key={s.label} style={{ background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border)", padding: "16px 20px" }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>{s.label}</div>
                      <div style={{ fontSize: 26, fontWeight: 900, color: s.color as string }}>{s.value}</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>{s.sub}</div>
                    </div>
                  ))}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16, marginBottom: 16 }}>
                  {/* Equity curve */}
                  <div style={{ background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border)", padding: "16px 20px" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 12 }}>EQUITY CURVE</div>
                    <EquityCurve />
                  </div>
                  {/* Win/Loss breakdown */}
                  <div style={{ background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border)", padding: "16px 20px" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 12 }}>BREAKDOWN</div>
                    {[
                      { label: "Avg Win",  value: fmt(stats.avgWin),  color: "#3fb950" },
                      { label: "Avg Loss", value: fmt(stats.avgLoss), color: "#f85149" },
                      { label: "Best",     value: stats.bestTrade ? `${stats.bestTrade.ticker} +${fmt(calcPnL(stats.bestTrade)||0)}` : "–", color: "#56d364" },
                      { label: "Worst",    value: stats.worstTrade ? `${stats.worstTrade.ticker} ${fmt(calcPnL(stats.worstTrade)||0)}` : "–", color: "#f85149" },
                    ].map(r => (
                      <div key={r.label} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid rgba(48,54,61,0.5)" }}>
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{r.label}</span>
                        <span style={{ fontSize: 12, fontWeight: 800, color: r.color }}>{r.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* JOURNAL TAB */}
        {tab === "journal" && (
          <>
            {/* Filters */}
            <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
              <input value={filterTicker} onChange={e => setFilterTicker(e.target.value)}
                placeholder="Filter ticker..."
                style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 13, fontWeight: 700, width: 160, outline: "none" }} />
              {["ALL","OPEN","WIN","LOSS","BREAKEVEN"].map(s => {
                const cfg = s === "ALL" ? null : STATUS_CFG[s as keyof typeof STATUS_CFG];
                return (
                  <button key={s} onClick={() => setFilterStatus(s)} style={{
                    padding: "7px 16px", borderRadius: 20,
                    border: `1.5px solid ${filterStatus===s ? (cfg?.border || "#388bfd") : "var(--border)"}`,
                    background: filterStatus===s ? (cfg?.bg || "rgba(56,139,253,0.1)") : "transparent",
                    color: filterStatus===s ? (cfg?.color || "#388bfd") : "var(--text-muted)",
                    cursor: "pointer", fontSize: 11, fontWeight: 700,
                  }}>{s === "ALL" ? `ALL (${trades.length})` : `${STATUS_CFG[s as keyof typeof STATUS_CFG].label} (${trades.filter(t=>t.status===s).length})`}</button>
                );
              })}
            </div>

            {/* Selection bar — only appears when there is something to act on */}
            {filtered.length > 0 && (
              <div style={{
                display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
                marginBottom: 12, padding: "9px 14px", borderRadius: 10,
                background: visibleSelected.length ? "rgba(248,81,73,0.05)" : "var(--bg-secondary)",
                border: `1px solid ${visibleSelected.length ? "rgba(248,81,73,0.25)" : "var(--border)"}`,
              }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, fontWeight: 700, color: "var(--text-muted)" }}>
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    ref={el => { if (el) el.indeterminate = visibleSelected.length > 0 && !allVisibleSelected; }}
                    onChange={toggleAllVisible}
                    style={{ width: 15, height: 15, accentColor: "#f85149", cursor: "pointer" }} />
                  Pilih semua ({filtered.length})
                </label>

                {visibleSelected.length > 0 && (
                  <>
                    <span style={{ fontSize: 12, fontWeight: 800, color: "#f85149" }}>
                      {visibleSelected.length} dipilih
                    </span>
                    {/* Two-step rather than a browser dialog: the button states
                        the count it is about to destroy, and you have to mean it
                        twice. */}
                    <button
                      onClick={() => confirmingBulk ? removeTrades(visibleSelected) : setConfirmingBulk(true)}
                      style={{
                        padding: "6px 14px", borderRadius: 7, cursor: "pointer",
                        fontSize: 12, fontWeight: 800,
                        border: `1px solid ${confirmingBulk ? "#f85149" : "rgba(248,81,73,0.4)"}`,
                        background: confirmingBulk ? "#f85149" : "rgba(248,81,73,0.08)",
                        color: confirmingBulk ? "#fff" : "#f85149",
                      }}>
                      {confirmingBulk
                        ? `Yakin? Hapus ${visibleSelected.length} trade`
                        : `🗑 Hapus ${visibleSelected.length}`}
                    </button>
                    <button onClick={() => { setSelected(new Set()); setConfirmingBulk(false); }}
                      style={{ padding: "6px 12px", borderRadius: 7, border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                      Batal pilih
                    </button>
                  </>
                )}

                {/* Selected-but-hidden rows are NOT going to be deleted, and
                    that is worth saying out loud rather than leaving as a
                    surprise either way. */}
                {selected.size > visibleSelected.length && (
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    ({selected.size - visibleSelected.length} lagi dipilih tapi tersembunyi oleh filter — tidak ikut terhapus)
                  </span>
                )}
              </div>
            )}

            {/* Undo — the journal has no server copy, so this is the only way back */}
            {undo && (
              <div style={{
                display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
                marginBottom: 12, padding: "10px 14px", borderRadius: 10,
                background: "rgba(227,179,65,0.08)", border: "1px solid rgba(227,179,65,0.35)",
              }}>
                <span style={{ fontSize: 12, fontWeight: 700 }}>
                  {undo.trades.length} trade dihapus
                  <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>
                    {" "}({undo.trades.map(t => t.ticker).slice(0, 6).join(", ")}
                    {undo.trades.length > 6 ? `, +${undo.trades.length - 6}` : ""})
                  </span>
                </span>
                <button onClick={restoreUndo} style={{
                  padding: "5px 14px", borderRadius: 7, border: "1px solid #e3b341",
                  background: "rgba(227,179,65,0.15)", color: "#e3b341",
                  cursor: "pointer", fontSize: 12, fontWeight: 800,
                }}>↩ Kembalikan</button>
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                  Journal cuma tersimpan di browser ini — kalau bar ini hilang, datanya tidak bisa dikembalikan.
                </span>
              </div>
            )}

            {/* Empty state */}
            {trades.length === 0 && (
              <div style={{ background: "var(--bg-secondary)", borderRadius: 14, border: "1px dashed var(--border)", padding: "60px 24px", textAlign: "center" }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>📓</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: "var(--text-primary)", marginBottom: 8 }}>Journal masih kosong</div>
                <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Mulai catat trade pertama lo dengan tombol <strong>+ Catat Trade</strong></div>
              </div>
            )}

            {/* Trade list */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {filtered.map(t => {
                const pnl = calcPnL(t);
                const rr  = calcRR(t);
                const cfg = STATUS_CFG[t.status];
                return (
                  <div key={t.id} style={{
                    background: selected.has(t.id) ? "rgba(248,81,73,0.05)" : "var(--bg-secondary)",
                    borderRadius: 12,
                    // A selected row is about to be destroyed, so selection wins
                    // over the status colour rather than blending with it.
                    border: `1px solid ${selected.has(t.id) ? "rgba(248,81,73,0.5)"
                      : t.status==="WIN" ? "rgba(63,185,80,0.2)"
                      : t.status==="LOSS" ? "rgba(248,81,73,0.15)" : "var(--border)"}`,
                    padding: "14px 20px",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                      {/* Row checkbox */}
                      <input
                        type="checkbox"
                        checked={selected.has(t.id)}
                        onChange={() => toggleOne(t.id)}
                        aria-label={`Pilih ${t.ticker}`}
                        style={{ width: 15, height: 15, accentColor: "#f85149", cursor: "pointer", flexShrink: 0 }} />

                      {/* Status badge */}
                      <span style={{ fontSize: 10, fontWeight: 800, padding: "3px 10px", borderRadius: 6, background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}`, whiteSpace: "nowrap" }}>
                        {cfg.label}
                      </span>

                      {/* Ticker + date */}
                      <div>
                        <div style={{ fontSize: 16, fontWeight: 900, color: "#58a6ff" }}>{t.ticker}</div>
                        <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{t.date}{t.exitDate ? ` → ${t.exitDate}` : ""}</div>
                      </div>

                      {/* Type */}
                      <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 5, background: t.type==="BUY" ? "rgba(63,185,80,0.1)" : "rgba(248,81,73,0.1)", color: t.type==="BUY" ? "#3fb950" : "#f85149" }}>
                        {t.type}
                      </span>

                      {/* Prices */}
                      <div style={{ display: "flex", gap: 16 }}>
                        <div><div style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 700 }}>ENTRY</div><div style={{ fontSize: 14, fontWeight: 800, color: "var(--text-primary)" }}>Rp {t.entry.toLocaleString("id-ID")}</div></div>
                        {t.exit && <div><div style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 700 }}>EXIT</div><div style={{ fontSize: 14, fontWeight: 800, color: "var(--text-primary)" }}>Rp {t.exit.toLocaleString("id-ID")}</div></div>}
                        <div><div style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 700 }}>LOT</div><div style={{ fontSize: 14, fontWeight: 800, color: "var(--text-primary)" }}>{t.lot}</div></div>
                      </div>

                      {/* P&L */}
                      {pnl !== null && (
                        <div style={{ marginLeft: "auto" }}>
                          <div style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 700 }}>P&L</div>
                          <div style={{ fontSize: 18, fontWeight: 900, color: pnl >= 0 ? "#3fb950" : "#f85149" }}>
                            {pnl >= 0 ? "+" : ""}{fmt(pnl)}
                          </div>
                        </div>
                      )}
                      {rr !== null && (
                        <div>
                          <div style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 700 }}>R:R</div>
                          <div style={{ fontSize: 14, fontWeight: 800, color: rr >= 1.5 ? "#3fb950" : rr >= 0 ? "#e3b341" : "#f85149" }}>
                            {rr >= 0 ? "+" : ""}{rr.toFixed(1)}R
                          </div>
                        </div>
                      )}

                      {/* Actions */}
                      <div style={{ display: "flex", gap: 6 }}>
                        <button onClick={() => startEdit(t)} style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>Edit</button>
                        <button onClick={() => deleteTrade(t.id)} style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid rgba(248,81,73,0.3)", background: "rgba(248,81,73,0.06)", color: "#f85149", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>✕</button>
                      </div>
                    </div>

                    {/* Tags + reason */}
                    <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                      {t.reason && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>📌 {t.reason}</span>}
                      {t.tags.map(tag => (
                        <span key={tag} style={{ fontSize: 9, padding: "2px 7px", borderRadius: 10, background: "rgba(88,166,255,0.1)", color: "#58a6ff", border: "1px solid rgba(88,166,255,0.2)" }}>{tag}</span>
                      ))}
                      {t.note && <span style={{ fontSize: 10, color: "#e3b341" }}>📝 {t.note}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* Form modal */}
        {showForm && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
            onClick={e => { if (e.target === e.currentTarget) { setShowForm(false); setEditId(null); } }}>
            <div style={{ background: "var(--bg-secondary)", borderRadius: 16, border: "1px solid var(--border)", width: "100%", maxWidth: 620, maxHeight: "90vh", overflow: "auto", padding: 28 }}>
              <div style={{ fontSize: 18, fontWeight: 900, color: "var(--text-primary)", marginBottom: 20 }}>{editId ? "Edit Trade" : "Catat Trade Baru"}</div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                {/* Ticker */}
                <div><label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 6 }}>TICKER *</label>
                  <input value={form.ticker} onChange={e => f("ticker", e.target.value.toUpperCase())} placeholder="BBCA"
                    style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 14, fontWeight: 800, outline: "none", boxSizing: "border-box" }} /></div>
                {/* Date */}
                <div><label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 6 }}>TGL ENTRY *</label>
                  <input type="date" value={form.date} onChange={e => f("date", e.target.value)}
                    style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 13, outline: "none", boxSizing: "border-box" }} /></div>
                {/* Type */}
                <div><label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 6 }}>TIPE</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    {(["BUY","SELL_SHORT"] as const).map(tp => (
                      <button key={tp} onClick={() => f("type", tp)} style={{
                        flex: 1, padding: "10px 0", borderRadius: 8,
                        border: `1px solid ${form.type===tp ? (tp==="BUY" ? "rgba(63,185,80,0.5)" : "rgba(248,81,73,0.5)") : "var(--border)"}`,
                        background: form.type===tp ? (tp==="BUY" ? "rgba(63,185,80,0.1)" : "rgba(248,81,73,0.1)") : "transparent",
                        color: form.type===tp ? (tp==="BUY" ? "#3fb950" : "#f85149") : "var(--text-muted)",
                        cursor: "pointer", fontSize: 12, fontWeight: 800,
                      }}>{tp === "BUY" ? "BUY" : "SHORT"}</button>
                    ))}</div></div>
                {/* Lot */}
                <div><label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 6 }}>LOT *</label>
                  <input type="number" value={form.lot || ""} onChange={e => f("lot", parseFloat(e.target.value))}
                    style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 14, fontWeight: 800, outline: "none", boxSizing: "border-box" }} /></div>
                {/* Entry */}
                <div><label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 6 }}>HARGA ENTRY *</label>
                  <input type="number" value={form.entry || ""} onChange={e => f("entry", parseFloat(e.target.value))}
                    style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 14, fontWeight: 800, outline: "none", boxSizing: "border-box" }} /></div>
                {/* Stop Loss */}
                <div><label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 6 }}>STOP LOSS</label>
                  <input type="number" value={form.stopLoss || ""} onChange={e => f("stopLoss", parseFloat(e.target.value))}
                    style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 14, fontWeight: 800, outline: "none", boxSizing: "border-box" }} /></div>
                {/* Exit */}
                <div><label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 6 }}>HARGA EXIT <span style={{color:"var(--text-muted)",fontWeight:400}}>(kosongkan jika masih open)</span></label>
                  <input type="number" value={form.exit || ""} onChange={e => f("exit", e.target.value ? parseFloat(e.target.value) : undefined)}
                    style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 14, fontWeight: 800, outline: "none", boxSizing: "border-box" }} /></div>
                {/* Exit date */}
                <div><label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 6 }}>TGL EXIT</label>
                  <input type="date" value={form.exitDate || ""} onChange={e => f("exitDate", e.target.value)}
                    style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 13, outline: "none", boxSizing: "border-box" }} /></div>
              </div>

              {/* Reason */}
              <div style={{ marginTop: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 6 }}>ALASAN ENTRY</label>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                  {REASONS.map(r => (
                    <button key={r} onClick={() => f("reason", r)} style={{
                      padding: "4px 10px", borderRadius: 12, fontSize: 10, fontWeight: 700, cursor: "pointer",
                      border: `1px solid ${form.reason===r ? "rgba(88,166,255,0.5)" : "var(--border)"}`,
                      background: form.reason===r ? "rgba(88,166,255,0.1)" : "transparent",
                      color: form.reason===r ? "#58a6ff" : "var(--text-muted)",
                    }}>{r}</button>
                  ))}
                </div>
              </div>

              {/* Tags */}
              <div style={{ marginTop: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 6 }}>TAGS</label>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {TAG_OPTIONS.map(tag => (
                    <button key={tag} onClick={() => toggleTag(tag)} style={{
                      padding: "4px 10px", borderRadius: 12, fontSize: 10, fontWeight: 700, cursor: "pointer",
                      border: `1px solid ${form.tags.includes(tag) ? "rgba(88,166,255,0.5)" : "var(--border)"}`,
                      background: form.tags.includes(tag) ? "rgba(88,166,255,0.1)" : "transparent",
                      color: form.tags.includes(tag) ? "#58a6ff" : "var(--text-muted)",
                    }}>{tag}</button>
                  ))}
                </div>
              </div>

              {/* Note */}
              <div style={{ marginTop: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 6 }}>CATATAN</label>
                <textarea value={form.note || ""} onChange={e => f("note", e.target.value)} rows={2}
                  placeholder="Apa yang lo pelajari dari trade ini?"
                  style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 13, outline: "none", resize: "vertical", boxSizing: "border-box", fontFamily: "inherit" }} />
              </div>

              <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
                <button onClick={save} style={{ flex: 1, padding: "12px 0", borderRadius: 8, border: "none", background: "linear-gradient(135deg,#2f81f7,#39d2f5)", color: "#fff", fontSize: 14, fontWeight: 800, cursor: "pointer" }}>
                  {editId ? "Update Trade" : "Simpan Trade"}
                </button>
                <button onClick={() => { setShowForm(false); setEditId(null); }} style={{ padding: "12px 20px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 14, fontWeight: 700 }}>Cancel</button>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
