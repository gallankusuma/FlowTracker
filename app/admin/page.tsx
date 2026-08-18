"use client";
import Navbar from "@/components/Navbar";
import SectorsApiPanel from "@/components/SectorsApiPanel";
import TampermonkeyPanel from "@/components/TampermonkeyPanel";
import { API_BASE } from "@/lib/apiConfig";
import { opFetch, opJson, OpError, whoami, login, logout, type OperatorState } from "@/lib/operatorSession";
import { useState, useEffect, useRef } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────
type BrokerConfig = { code: string; name: string; category: "FOREIGN"|"BIG_MONEY"|"RITEL"; active: number; notes: string };
type WatchItem    = { ticker: string; active: number; display_order: number; sector: string };

const CAT_COLORS: Record<string, string> = {
  FOREIGN:   "rgba(47,129,247,0.15)",
  BIG_MONEY: "rgba(248,166,73,0.15)",
  RITEL:     "rgba(63,185,80,0.15)",
};
const CAT_TEXT: Record<string, string> = {
  FOREIGN:   "var(--accent-blue)",
  BIG_MONEY: "#f8a649",
  RITEL:     "var(--accent-green)",
};
const CAT_LABELS: Record<string, string> = {
  FOREIGN: "FOREIGN", BIG_MONEY: "BIG MONEY", RITEL: "RITEL"
};

export default function AdminDataHub() {
  const [tab, setTab] = useState<"upload"|"broker"|"watchlist"|"sectors"|"tampermonkey">("upload");

  // ── Upload tab state ────────────────────────────────────────────────────────
  const [mode, setMode]             = useState<"csv"|"json"|"paste">("paste");
  const [brokerCode, setBrokerCode] = useState("");
  const [date, setDate]             = useState(new Date().toISOString().split("T")[0]);
  const [textData, setTextData]     = useState("");
  const [loading, setLoading]       = useState(false);
  const [result, setResult]         = useState<any>(null);
  const [health, setHealth]         = useState<any>(null);

  // ── Broker Config tab state ─────────────────────────────────────────────────
  const [brokerCfg, setBrokerCfg]       = useState<BrokerConfig[]>([]);
  const [brokerFilter, setBrokerFilter] = useState<string>("ALL");
  const [brokerSearch, setBrokerSearch] = useState("");
  const [brokerSaving, setBrokerSaving] = useState(false);
  const [brokerDirty, setBrokerDirty]   = useState<Record<string, string>>({});

  // ── Watchlist tab state ─────────────────────────────────────────────────────
  const [watchlist, setWatchlist]       = useState<WatchItem[]>([]);
  const [newTicker, setNewTicker]       = useState("");
  const [newSector, setNewSector]       = useState("");
  const [watchSaving, setWatchSaving]   = useState(false);
  const [reloadMsg, setReloadMsg]       = useState("");

  // ── Operator session (FT-P0-01A) ────────────────────────────────────────────
  const [op, setOp]           = useState<OperatorState | null>(null);  // null = still checking
  const [opKey, setOpKey]     = useState("");
  const [opError, setOpError] = useState("");
  const [opBusy, setOpBusy]   = useState(false);
  const [dataError, setDataError] = useState("");

  // A refused or unavailable read leaves the previous data in place and raises a
  // banner. Overwriting it with [] would render "no brokers configured", which is
  // a claim about the DATA rather than about the connection.
  const handleOpFailure = (e: unknown, what: string) => {
    const err = e instanceof OpError ? e : new OpError("error", 0, String(e));
    if (err.kind === "auth") { setOp({ authenticated: false }); setDataError(""); return; }
    setDataError(
      err.kind === "forbidden"   ? `${what}: not permitted for this operator (${err.status})` :
      err.kind === "unavailable" ? `${what}: backend unavailable (${err.status || "no response"}) - data shown may be stale` :
                                   `${what}: ${err.message}`
    );
  };

  const loadOperatorData = async () => {
    setDataError("");
    try {
      const d = await opJson<{ data: BrokerConfig[] }>(`/api/admin/broker-config`);
      setBrokerCfg(d.data || []);
    } catch (e) { handleOpFailure(e, "Broker config"); }
    try {
      const d = await opJson<{ data: WatchItem[] }>(`/api/admin/watchlist`);
      setWatchlist(d.data || []);
    } catch (e) { handleOpFailure(e, "Watchlist"); }
  };

  // API health, RE-CHECKED. It was fetched once on mount and never again, so the
  // badge kept reporting "API ONLINE" long after the upstream had gone -- a cached
  // success with no stale label, which is the exact shape FT-P0-02 exists to remove.
  // It also called .json() without looking at r.ok, so a JSON-shaped error body
  // read as health.
  const checkHealth = async () => {
    try {
      const r = await fetch(`${API_BASE}/api/health`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setHealth({ ...(await r.json()), checkedAt: Date.now() });
    } catch {
      // Unreachable is a state of its own; it must not inherit the last good one.
      setHealth({ status: "offline", checkedAt: Date.now() });
    }
  };

  useEffect(() => {
    checkHealth();
    const healthTimer = setInterval(checkHealth, 30_000);
    // Protected data is requested only AFTER a session is confirmed. Firing it
    // unconditionally would spray 401s and write a denial into the audit trail on
    // every page load, burying the denials that actually matter.
    whoami().then(state => {
      setOp(state);
      if (state.authenticated) loadOperatorData();
    });
    // Without this the interval outlives the component and keeps polling a page
    // nobody is looking at.
    return () => clearInterval(healthTimer);
  }, []);

  const handleOperatorLogin = async () => {
    setOpBusy(true); setOpError("");
    try {
      const r = await login(opKey);
      if (!r.ok) { setOpError(r.error || "login failed"); return; }
      setOpKey("");                     // never keep the key around after the exchange
      const state = await whoami();
      setOp(state);
      if (state.authenticated) await loadOperatorData();
    } catch (e: any) {
      // Transport failure previously left opBusy true forever, disabling the
      // form with no way back except a page reload.
      setOpError(e?.message || "could not reach the server");
    } finally {
      setOpBusy(false);
    }
  };

  const handleOperatorLogout = async () => {
    await logout();
    setOp({ authenticated: false });
    setBrokerCfg([]); setWatchlist([]);
  };

  // ── Broker Config helpers ───────────────────────────────────────────────────
  const getBrokerCat = (code: string) => brokerDirty[code] || (brokerCfg.find(b => b.code === code)?.category || "RITEL");

  const handleCatChange = (code: string, cat: string) => {
    setBrokerDirty(prev => ({ ...prev, [code]: cat }));
  };

  const handleSaveBrokers = async () => {
    const updates = Object.entries(brokerDirty).map(([code, category]) => ({ code, category }));
    if (!updates.length) return;
    setBrokerSaving(true);
    try {
      await opJson(`/api/admin/broker-config/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      const d = await opJson<{ data: BrokerConfig[] }>(`/api/admin/broker-config`);
      setBrokerCfg(d.data || []);
      setBrokerDirty({});               // cleared only after the write really succeeded
      await opJson(`/api/admin/reload-config`, { method: "POST" });
      setReloadMsg("✅ Broker config saved & server reloaded!");
      setTimeout(() => setReloadMsg(""), 3000);
    } catch (e) {
      // Pending edits are DELIBERATELY kept: a rejected write must not read as a
      // save that produced no change, and the operator must not lose work.
      const err = e instanceof OpError ? e : null;
      setReloadMsg(err?.kind === "auth" ? "🔒 Session expired - sign in again"
                 : err?.kind === "forbidden" ? "⛔ Not permitted"
                 : `❌ Save failed - ${err?.message || "unknown error"}`);
      if (err?.kind === "auth") setOp({ authenticated: false });
    } finally {
      setBrokerSaving(false);
    }
  };

  const filteredBrokers = brokerCfg.filter(b => {
    const cat = getBrokerCat(b.code);
    const matchCat = brokerFilter === "ALL" || cat === brokerFilter;
    const matchSearch = !brokerSearch || b.code.includes(brokerSearch.toUpperCase()) || b.name.toLowerCase().includes(brokerSearch.toLowerCase());
    return matchCat && matchSearch;
  });

  // ── Watchlist helpers ───────────────────────────────────────────────────────
  const handleToggleWatch = async (ticker: string, active: number) => {
    setWatchSaving(true);
    try {
      await opJson(`/api/admin/watchlist/${ticker}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: active ? 0 : 1 }),
      });
      const d = await opJson<{ data: WatchItem[] }>(`/api/admin/watchlist`);
      setWatchlist(d.data || []);
    } catch (e) { handleOpFailure(e, `Toggle ${ticker}`); }
    finally { setWatchSaving(false); }
  };

  const handleAddTicker = async () => {
    if (!newTicker.trim()) return;
    setWatchSaving(true);
    try {
      await opJson(`/api/admin/watchlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: newTicker.trim().toUpperCase(), sector: newSector }),
      });
      const d = await opJson<{ data: WatchItem[] }>(`/api/admin/watchlist`);
      setWatchlist(d.data || []);
      setNewTicker(""); setNewSector("");   // cleared only on a real success
    } catch (e) { handleOpFailure(e, `Add ${newTicker.trim().toUpperCase()}`); }
    finally { setWatchSaving(false); }
  };

  const handleReloadConfig = async () => {
    try {
      const r = await opJson<any>(`/api/admin/reload-config`, { method: "POST" });
      setReloadMsg(`✅ Reloaded — ${r.watchlist} saham, ${r.foreign?.length || 0} foreign, ${r.bigMoney?.length || 0} bigMoney`);
    } catch (e) {
      const err = e instanceof OpError ? e : null;
      setReloadMsg(`❌ Reload failed - ${err?.message || "unknown error"}`);
      if (err?.kind === "auth") setOp({ authenticated: false });
    }
    setTimeout(() => setReloadMsg(""), 5000);
  };

  // ── Upload tab handlers ─────────────────────────────────────────────────────
  const SAMPLE_CSV = `stockcode,buyval,buylot,sellval,selllot\nBBCA,15200000000,2533333,8300000000,1383333\nBBRI,28500000000,9284000,12100000000,3941000`;
  const handleUpload = async () => {
    if (!brokerCode || brokerCode.length < 2) { setResult({ error: "Broker code harus 2 huruf" }); return; }
    if (!textData.trim()) { setResult({ error: "Data tidak boleh kosong" }); return; }
    setLoading(true); setResult(null);
    try {
      const body = { brokerCode: brokerCode.toUpperCase(), date, data: textData };
      const r = await fetch(`${API_BASE}/api/broker-summary/paste`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) });
      setResult(await r.json());
    } catch(e: any) { setResult({ error: e.message }); }
    setLoading(false);
  };

  const tabs: { key: typeof tab; label: string; emoji: string }[] = [
    { key: "upload",      label: "Data Upload",    emoji: "📤" },
    { key: "broker",      label: "Broker Config",  emoji: "🏦" },
    { key: "watchlist",   label: "Watchlist",      emoji: "📋" },
    { key: "sectors",     label: "Sectors API",    emoji: "🗂️" },
    { key: "tampermonkey",label: "Tampermonkey",   emoji: "🔧" },
  ];

  const dirtyCount = Object.keys(brokerDirty).length;

  // ── Operator gate ───────────────────────────────────────────────────────────
  // Rendered INSTEAD of the panel, not alongside it. The server refuses either
  // way — this exists so an unauthenticated operator sees why the panel is empty
  // rather than a working-looking screen with no data in it, which is the
  // fail-closed UI rule the review asked for elsewhere.
  if (op === null || !op.authenticated) {
    return (
      <>
        <Navbar />
        <main style={{ maxWidth: 460, margin: "0 auto", padding: "64px 16px" }}>
          <h1 style={{ fontSize: 22, fontWeight: 900, fontFamily: "'Space Grotesk', sans-serif", marginBottom: 8 }}>
            🔐 Operator sign-in
          </h1>
          {op === null ? (
            <div style={{ fontSize: 13, opacity: 0.7 }}>Checking session…</div>
          ) : (
            <>
              <p style={{ fontSize: 13, opacity: 0.75, marginBottom: 18, lineHeight: 1.6 }}>
                The Admin panel changes broker classification and the tracked watchlist,
                so it needs an operator session. Your key is exchanged for a session
                cookie and is never stored in this browser.
              </p>
              <input
                type="password"
                value={opKey}
                onChange={e => setOpKey(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && opKey && !opBusy) handleOperatorLogin(); }}
                placeholder="Operator key"
                autoComplete="off"
                style={{ width: "100%", padding: "10px 12px", borderRadius: 8, fontSize: 14,
                  border: "1px solid var(--border, #30363d)", background: "var(--bg-elevated, #161b22)",
                  color: "inherit", marginBottom: 10 }}
              />
              <button
                onClick={handleOperatorLogin}
                disabled={!opKey || opBusy}
                style={{ width: "100%", padding: "10px 12px", borderRadius: 8, fontWeight: 700,
                  fontSize: 14, cursor: opKey && !opBusy ? "pointer" : "not-allowed",
                  background: "var(--accent-blue, #2f81f7)", color: "#fff", border: "none",
                  opacity: opKey && !opBusy ? 1 : 0.5 }}
              >
                {opBusy ? "Signing in…" : "Sign in"}
              </button>
              {opError && (
                <div style={{ marginTop: 12, fontSize: 12, color: "var(--accent-red, #f85149)" }}>
                  {opError}
                </div>
              )}
            </>
          )}
        </main>
      </>
    );
  }

  return (
    <>
      <Navbar />
      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 16px" }}>
        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 26, fontWeight: 900, fontFamily: "'Space Grotesk', sans-serif", marginBottom: 6 }}>
            ⚙️ Admin Panel
          </h1>
          {dataError && (
            <div role="alert" style={{ marginBottom: 10, padding: "8px 12px", borderRadius: 8, fontSize: 12,
              background: "rgba(248,81,73,0.12)", color: "var(--accent-red, #f85149)",
              border: "1px solid rgba(248,81,73,0.35)" }}>
              ⚠️ {dataError}
            </div>
          )}
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 20, fontWeight: 700,
              background: "rgba(63,185,80,0.15)", color: "var(--accent-green, #3fb950)" }}>
              operator: {op.actor}
            </span>
            <button onClick={handleOperatorLogout}
              style={{ fontSize: 11, padding: "3px 10px", borderRadius: 20, fontWeight: 700,
                cursor: "pointer", background: "transparent", color: "inherit",
                border: "1px solid var(--border, #30363d)" }}>
              sign out
            </button>
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            {(() => {
              // Three states, not two. "Not checked yet" is not "online", and a
              // reading that has gone stale says so rather than standing in for a
              // fresh one.
              const stale = health?.status === "ok" && health?.checkedAt && Date.now() - health.checkedAt > 90_000;
              const good = health?.status === "ok" && !stale;
              const unknown = !health || stale;
              const label = !health ? "● API CHECKING…"
                : health.status === "ok" ? (stale ? "● API LAST OK >90s AGO" : "● API ONLINE")
                : "● API OFFLINE";
              return (
                <span title={health?.checkedAt ? `last checked ${new Date(health.checkedAt).toLocaleTimeString()}` : undefined}
                  style={{ fontSize: 11, padding: "3px 10px", borderRadius: 20, fontWeight: 700,
                    background: good ? "rgba(63,185,80,0.15)" : unknown ? "rgba(210,153,34,0.15)" : "rgba(248,81,73,0.15)",
                    color: good ? "var(--accent-green)" : unknown ? "#d29922" : "var(--accent-red)" }}>
                  {label}
                </span>
              );
            })()}
            {reloadMsg && (
              <span style={{ fontSize: 11, color: "var(--accent-green)", fontWeight: 700 }}>{reloadMsg}</span>
            )}
          </div>
        </div>

        {/* Tab Bar */}
        <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          {tabs.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              padding: "8px 18px", borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: "pointer",
              border: "none", transition: "all 0.15s",
              background: tab === t.key ? "var(--accent-blue)" : "var(--bg-secondary)",
              color: tab === t.key ? "#fff" : "var(--text-secondary)",
              outline: tab === t.key ? "none" : "1px solid var(--border)",
            }}>
              {t.emoji} {t.label}
              {t.key === "broker" && dirtyCount > 0 && (
                <span style={{ marginLeft: 6, background: "#f85149", color: "#fff", borderRadius: 10, padding: "1px 6px", fontSize: 10 }}>
                  {dirtyCount}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ── BROKER CONFIG TAB ── */}
        {tab === "broker" && (
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            {/* Toolbar */}
            <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 13, fontWeight: 800, color: "var(--text-primary)" }}>
                🏦 BROKER KATEGORI
              </span>
              <input
                placeholder="Cari kode/nama..."
                value={brokerSearch}
                onChange={e => setBrokerSearch(e.target.value)}
                className="ft-input"
                style={{ padding: "6px 12px", fontSize: 12, width: 160 }}
              />
              {(["ALL","FOREIGN","BIG_MONEY","RITEL"] as const).map(f => (
                <button key={f} onClick={() => setBrokerFilter(f)} style={{
                  padding: "5px 14px", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer",
                  border: "none",
                  background: brokerFilter === f
                    ? (f === "ALL" ? "var(--accent-blue)" : CAT_COLORS[f] || "var(--bg-secondary)")
                    : "var(--bg-secondary)",
                  color: brokerFilter === f
                    ? (f === "ALL" ? "#fff" : CAT_TEXT[f] || "var(--text-primary)")
                    : "var(--text-muted)",
                  outline: "1px solid var(--border)",
                }}>
                  {f === "ALL" ? `All (${brokerCfg.length})` : `${CAT_LABELS[f]} (${brokerCfg.filter(b => getBrokerCat(b.code) === f).length})`}
                </button>
              ))}
              <div style={{ flex: 1 }} />
              {dirtyCount > 0 && (
                <button onClick={handleSaveBrokers} disabled={brokerSaving} style={{
                  padding: "8px 20px", borderRadius: 8, fontWeight: 800, fontSize: 13, cursor: "pointer",
                  background: "var(--accent-blue)", color: "#fff", border: "none",
                  opacity: brokerSaving ? 0.7 : 1,
                }}>
                  {brokerSaving ? "Saving..." : `💾 Save ${dirtyCount} changes`}
                </button>
              )}
              <button onClick={handleReloadConfig} style={{
                padding: "7px 16px", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer",
                background: "rgba(63,185,80,0.12)", color: "var(--accent-green)", border: "1px solid rgba(63,185,80,0.3)",
              }}>
                🔄 Reload Config
              </button>
            </div>

            {/* Broker Table */}
            <div style={{ overflowX: "auto", maxHeight: 600, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead style={{ position: "sticky", top: 0, background: "var(--bg-secondary)", zIndex: 2 }}>
                  <tr>
                    {["Code","Nama Sekuritas","Kategori","Ubah Kategori"].map(h => (
                      <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontSize: 11,
                        fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.07em",
                        borderBottom: "1px solid var(--border)" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredBrokers.map((b, i) => {
                    const currentCat = getBrokerCat(b.code);
                    const isDirty = b.code in brokerDirty;
                    return (
                      <tr key={b.code} style={{
                        background: isDirty ? "rgba(47,129,247,0.06)" : (i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)"),
                        borderLeft: isDirty ? "3px solid var(--accent-blue)" : "3px solid transparent",
                      }}>
                        <td style={{ padding: "10px 16px", fontWeight: 900, fontSize: 14,
                          fontFamily: "'Space Grotesk', sans-serif", color: "var(--text-primary)" }}>
                          {b.code}
                        </td>
                        <td style={{ padding: "10px 16px", fontSize: 13, color: "var(--text-secondary)" }}>
                          {b.name || "—"}
                        </td>
                        <td style={{ padding: "10px 16px" }}>
                          <span style={{
                            fontSize: 10, padding: "3px 10px", borderRadius: 4, fontWeight: 700,
                            background: CAT_COLORS[currentCat] || "transparent",
                            color: CAT_TEXT[currentCat] || "var(--text-muted)",
                          }}>
                            {CAT_LABELS[currentCat] || currentCat}
                          </span>
                        </td>
                        <td style={{ padding: "10px 16px" }}>
                          <div style={{ display: "flex", gap: 6 }}>
                            {(["FOREIGN","BIG_MONEY","RITEL"] as const).map(cat => (
                              <button key={cat} onClick={() => handleCatChange(b.code, cat)} style={{
                                padding: "4px 10px", borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: "pointer",
                                border: "none",
                                background: currentCat === cat
                                  ? (CAT_COLORS[cat] || "var(--bg-secondary)")
                                  : "var(--bg-secondary)",
                                color: currentCat === cat
                                  ? (CAT_TEXT[cat] || "var(--text-primary)")
                                  : "var(--text-muted)",
                                outline: currentCat === cat ? `1px solid ${CAT_TEXT[cat]}` : "1px solid var(--border)",
                              }}>
                                {CAT_LABELS[cat]}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── WATCHLIST TAB ── */}
        {tab === "watchlist" && (
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            {/* Toolbar */}
            <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 13, fontWeight: 800, color: "var(--text-primary)" }}>
                📋 WATCHLIST SAHAM ({watchlist.filter(w => w.active).length} aktif / {watchlist.length} total)
              </span>
              <div style={{ flex: 1 }} />
              <input placeholder="Ticker (e.g. BBCA)" value={newTicker} onChange={e => setNewTicker(e.target.value.toUpperCase())}
                className="ft-input" style={{ padding: "6px 12px", fontSize: 12, width: 120, textTransform: "uppercase" }} />
              <input placeholder="Sektor (opsional)" value={newSector} onChange={e => setNewSector(e.target.value)}
                className="ft-input" style={{ padding: "6px 12px", fontSize: 12, width: 140 }} />
              <button onClick={handleAddTicker} disabled={watchSaving || !newTicker} style={{
                padding: "7px 18px", borderRadius: 8, fontWeight: 800, fontSize: 13, cursor: "pointer",
                background: "var(--accent-blue)", color: "#fff", border: "none", opacity: !newTicker ? 0.5 : 1,
              }}>
                + Tambah
              </button>
              <button onClick={handleReloadConfig} style={{
                padding: "7px 16px", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer",
                background: "rgba(63,185,80,0.12)", color: "var(--accent-green)", border: "1px solid rgba(63,185,80,0.3)",
              }}>
                🔄 Reload Scraper
              </button>
            </div>

            {/* Watchlist Table */}
            <div style={{ overflowX: "auto", maxHeight: 600, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead style={{ position: "sticky", top: 0, background: "var(--bg-secondary)", zIndex: 2 }}>
                  <tr>
                    {["#","Ticker","Sektor","Status","Aksi"].map(h => (
                      <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontSize: 11,
                        fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.07em",
                        borderBottom: "1px solid var(--border)" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {watchlist.map((w, i) => (
                    <tr key={w.ticker} style={{
                      background: !w.active ? "rgba(248,81,73,0.04)" : (i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)"),
                      opacity: w.active ? 1 : 0.5,
                    }}>
                      <td style={{ padding: "8px 16px", fontSize: 12, color: "var(--text-muted)" }}>{w.display_order}</td>
                      <td style={{ padding: "8px 16px", fontWeight: 900, fontSize: 14,
                        fontFamily: "'Space Grotesk', sans-serif",
                        color: w.active ? "var(--text-primary)" : "var(--text-muted)" }}>
                        {w.ticker}
                      </td>
                      <td style={{ padding: "8px 16px", fontSize: 12, color: "var(--text-muted)" }}>
                        {w.sector || "—"}
                      </td>
                      <td style={{ padding: "8px 16px" }}>
                        <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, fontWeight: 700,
                          background: w.active ? "rgba(63,185,80,0.15)" : "rgba(248,81,73,0.15)",
                          color: w.active ? "var(--accent-green)" : "var(--accent-red)" }}>
                          {w.active ? "● AKTIF" : "○ NONAKTIF"}
                        </span>
                      </td>
                      <td style={{ padding: "8px 16px" }}>
                        <button onClick={() => handleToggleWatch(w.ticker, w.active)} disabled={watchSaving} style={{
                          padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer", border: "none",
                          background: w.active ? "rgba(248,81,73,0.12)" : "rgba(63,185,80,0.12)",
                          color: w.active ? "var(--accent-red)" : "var(--accent-green)",
                        }}>
                          {w.active ? "Nonaktifkan" : "Aktifkan"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── UPLOAD TAB ── */}
        {tab === "upload" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div className="card" style={{ padding: 20 }}>
              <h3 style={{ fontSize: 14, fontWeight: 800, marginBottom: 16 }}>📤 Upload Broker Data</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <label style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700 }}>BROKER CODE</label>
                  <input value={brokerCode} onChange={e => setBrokerCode(e.target.value.toUpperCase())}
                    placeholder="e.g. MG" className="ft-input" maxLength={2}
                    style={{ width: "100%", padding: "8px 12px", fontSize: 13, marginTop: 4, textTransform: "uppercase" }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700 }}>TANGGAL</label>
                  <input type="date" value={date} onChange={e => setDate(e.target.value)}
                    className="ft-input" style={{ width: "100%", padding: "8px 12px", fontSize: 13, marginTop: 4 }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700 }}>DATA (CSV PASTE)</label>
                  <textarea value={textData} onChange={e => setTextData(e.target.value)}
                    placeholder={SAMPLE_CSV} rows={8}
                    className="ft-input" style={{ width: "100%", padding: "8px 12px", fontSize: 11, marginTop: 4, fontFamily: "monospace", resize: "vertical" }} />
                </div>
                <button onClick={handleUpload} disabled={loading} style={{
                  padding: "10px", borderRadius: 8, fontWeight: 800, fontSize: 14, cursor: "pointer",
                  background: "var(--accent-blue)", color: "#fff", border: "none", opacity: loading ? 0.7 : 1,
                }}>
                  {loading ? "Uploading..." : "📤 Upload Data"}
                </button>
                {result && (
                  <div style={{ padding: 12, borderRadius: 8, fontSize: 12, fontFamily: "monospace",
                    background: result.error ? "rgba(248,81,73,0.1)" : "rgba(63,185,80,0.1)",
                    color: result.error ? "var(--accent-red)" : "var(--accent-green)",
                    border: `1px solid ${result.error ? "rgba(248,81,73,0.3)" : "rgba(63,185,80,0.3)"}` }}>
                    {JSON.stringify(result, null, 2)}
                  </div>
                )}
              </div>
            </div>
            <div className="card" style={{ padding: 20 }}>
              <h3 style={{ fontSize: 14, fontWeight: 800, marginBottom: 12 }}>📊 API Status</h3>
              {health && (
                <pre style={{ fontSize: 11, color: "var(--text-secondary)", fontFamily: "monospace" }}>
                  {JSON.stringify(health, null, 2)}
                </pre>
              )}
            </div>
          </div>
        )}

        {/* ── SECTORS + TAMPERMONKEY TABS ── */}
        {tab === "sectors"     && <SectorsApiPanel />}
        {tab === "tampermonkey"&& <TampermonkeyPanel />}
      </main>
    </>
  );
}
