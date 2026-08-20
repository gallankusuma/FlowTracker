"use client";
import { API_BASE } from "@/lib/apiConfig";
import { useState, useEffect } from "react";

/**
 * Market context from ft_macro_data.
 *
 * DELIBERATELY NOT PRESENTED AS SIGNAL. EXP-030 tested 80 hypotheses across these
 * indicators against forward IHSG returns and none survived correction; EXP-031
 * then pre-registered the single most plausible one (currency weakness) and
 * falsified it across nine emerging markets. So this panel shows what the world
 * is doing — useful for reading a situation — and makes no claim about what
 * happens next. Colour follows the raw move, never an implied "good" or "bad",
 * because we have no evidence for the interpretation that would justify it.
 *
 * Failure is rendered, not simulated: an unreachable API says so and keeps
 * whatever was last shown. An empty grid would read as "the market is quiet",
 * which is a claim about the market rather than about the connection.
 */

type Row = {
  indicator: string;
  value: string;
  previous_value: string | null;
  direction: "UP" | "DOWN" | "FLAT" | null;
  date: string;
  source: string;
};

/** Display name, and a note where the series is a stand-in for something else. */
const META: Record<string, { label: string; note?: string; dp?: number }> = {
  USDIDR:       { label: "USD / IDR", note: "up = rupiah weaker", dp: 0 },
  JKSE:         { label: "IHSG", dp: 0 },
  EIDO:         { label: "EIDO", note: "Indonesia ETF — foreign flow proxy" },
  COAL_BTU:     { label: "Coal", note: "BTU proxy — Newcastle not available" },
  PALM_PROXY:   { label: "Palm oil", note: "soybean-oil proxy — CPO trades on Bursa Malaysia" },
  NICKEL_PROXY: { label: "Nickel", note: "VALE proxy — not the LME contract" },
  WTI:          { label: "WTI crude" },
  GOLD:         { label: "Gold" },
  COPPER:       { label: "Copper" },
  SILVER:       { label: "Silver" },
  NATURAL_GAS:  { label: "Natural gas" },
  VIX:          { label: "VIX", note: "up = more fear" },
  DXY:          { label: "Dollar index" },
  SPY:          { label: "S&P 500 ETF" },
  QQQ:          { label: "Nasdaq 100 ETF" },
  EM_EEM:       { label: "EM equities" },
  CHINA_FXI:    { label: "China large-cap" },
  YIELD_10Y:    { label: "US 10Y yield", dp: 3 },
  YIELD_3M:     { label: "US 3M yield", dp: 3 },
  YIELD_CURVE:  { label: "10Y − 3M spread", dp: 3 },
};

const GROUPS: { title: string; keys: string[] }[] = [
  { title: "INDONESIA", keys: ["USDIDR", "JKSE", "EIDO"] },
  { title: "COMMODITIES", keys: ["COAL_BTU", "PALM_PROXY", "NICKEL_PROXY", "WTI", "COPPER", "GOLD", "SILVER", "NATURAL_GAS"] },
  { title: "GLOBAL RISK", keys: ["VIX", "DXY", "SPY", "QQQ", "EM_EEM", "CHINA_FXI"] },
  { title: "US RATES", keys: ["YIELD_10Y", "YIELD_3M", "YIELD_CURVE"] },
];

function pct(cur: number, prev: number | null): number | null {
  if (prev === null || !Number.isFinite(prev) || prev === 0) return null;
  return (cur / prev - 1) * 100;
}

function Tile({ row }: { row: Row }) {
  const meta = META[row.indicator] || { label: row.indicator };
  const cur = Number(row.value);
  const prev = row.previous_value === null ? null : Number(row.previous_value);
  const change = pct(cur, prev);
  const dp = meta.dp ?? 2;

  // Colour states the MOVE, not a judgement. Up is green only because that is
  // the universal convention for a rising number, and "up = rupiah weaker" is
  // spelled out in the note rather than encoded in a colour nobody can read.
  const colour =
    row.direction === "UP" ? "var(--accent-green)" :
    row.direction === "DOWN" ? "var(--accent-red)" :
    "var(--text-muted)";

  return (
    <div className="card" style={{ padding: "10px 12px", background: "var(--bg-primary)" }} title={meta.note || undefined}>
      <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 3, whiteSpace: "nowrap",
        overflow: "hidden", textOverflow: "ellipsis" }}>
        {meta.label}{meta.note ? " *" : ""}
      </div>
      <div style={{ fontSize: 15, fontWeight: 800, color: "var(--text-primary)",
        fontFamily: "'Space Grotesk', sans-serif", lineHeight: 1.2 }}>
        {Number.isFinite(cur) ? cur.toLocaleString("id-ID", { minimumFractionDigits: dp, maximumFractionDigits: dp }) : "—"}
      </div>
      <div style={{ fontSize: 11, fontWeight: 600, color: colour }}>
        {change === null
          ? <span style={{ color: "var(--text-muted)" }}>no prior</span>
          : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}
      </div>
    </div>
  );
}

export default function MacroPanel() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string>("");
  const [asOf, setAsOf] = useState<string>("");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`${API_BASE}/api/signals/macro`, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!alive) return;
        // Previous rows are kept on failure; only a SUCCESSFUL read replaces them.
        setRows(j.macro || []);
        setAsOf(j.updated_at || "");
        setError("");
      } catch (e: any) {
        if (alive) setError(e?.message || "unreachable");
      }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const byKey = new Map((rows || []).map(r => [r.indicator, r]));
  const newest = (rows || []).reduce<string>((m, r) => (r.date > m ? r.date : m), "");

  return (
    <div className="card" style={{ padding: 20, marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <h2 style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.1em",
          textTransform: "uppercase", margin: 0 }}>🌍 Market Context</h2>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {newest ? new Date(newest).toLocaleDateString("id-ID") : (rows === null && !error ? "Loading…" : "—")}
        </span>
      </div>

      <p style={{ fontSize: 10, color: "var(--text-muted)", margin: "0 0 14px", lineHeight: 1.5 }}>
        Kondisi pasar global dan penggerak IDX. <strong>Bukan sinyal beli/jual</strong> — pengujian
        EXP-030 dan EXP-031 tidak menemukan satu pun indikator ini punya nilai prediktif
        terhadap IHSG. Warna menunjukkan arah pergerakan, bukan penilaian bagus/buruk.
      </p>

      {error && (
        <div role="alert" style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, fontSize: 11,
          background: "rgba(248,81,73,0.12)", color: "var(--accent-red, #f85149)",
          border: "1px solid rgba(248,81,73,0.35)" }}>
          ⚠️ Data makro tidak dapat diambil ({error}).{rows ? " Angka di bawah adalah pembacaan terakhir yang berhasil." : ""}
        </div>
      )}

      {rows === null && !error && (
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Memuat…</div>
      )}

      {rows !== null && rows.length === 0 && !error && (
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
          Belum ada data makro tersimpan.
        </div>
      )}

      {rows !== null && rows.length > 0 && GROUPS.map(g => {
        const present = g.keys.map(k => byKey.get(k)).filter(Boolean) as Row[];
        if (!present.length) return null;
        return (
          <div key={g.title} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: "var(--text-muted)",
              letterSpacing: "0.1em", marginBottom: 8 }}>{g.title}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8 }}>
              {present.map(r => <Tile key={r.indicator} row={r} />)}
            </div>
          </div>
        );
      })}

      {rows !== null && rows.length > 0 && (
        <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.5 }}>
          * Proksi, bukan harga aslinya — arahkan kursor untuk keterangan.
          {asOf ? ` Diperbarui ${new Date(asOf).toLocaleTimeString("id-ID")}.` : ""}
        </div>
      )}
    </div>
  );
}
