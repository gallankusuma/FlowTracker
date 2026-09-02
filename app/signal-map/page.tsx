"use client";
/**
 * Signal Map — which of our factors are actually different from each other.
 *
 * This page exists because of one measurement that reframed the project:
 * fourteen factors are about FOUR distinct things. F1 and F8 correlate 0.91;
 * F11 and F12 correlate -0.83. Those are not related measurements, they are the
 * same measurement under different names, and no amount of adding oscillators
 * changes that.
 *
 * So the page is not a dashboard, it is a question-answering tool: before adding
 * any indicator, which cluster does it land in?
 *
 * The colouring rule that matters: the heatmap is shaded by |rho|, NOT by sign.
 * A -0.83 pair is exactly as redundant as a +0.83 pair -- one is simply the
 * other inverted -- and shading red-vs-green by sign would invite reading a
 * redundancy map as a good/bad map.
 */
import Navbar from "@/components/Navbar";
import { API_BASE } from "@/lib/apiConfig";
import { useState, useEffect } from "react";

type Factor = { key: string; short: string; label: string; index: number; ic: number | null; ir: number | null; t: number | null; dates: number };
type Map = {
  asOf: string; target: string; redundantAbove: number; cached?: boolean;
  meta: { rows: number; dates: number; from: string; to: string; regimeWarning: string };
  factors: Factor[];
  corr: (number | null)[][];
  independent: { short: string; label: string; ic: number | null }[];
  redundantFactors: { short: string; label: string; ic: number | null; redundantWith: string; rho: number }[];
  carriers: number;
  error?: string;
};

const card: React.CSSProperties = {
  background: "var(--bg-secondary)", border: "1px solid var(--border)",
  borderRadius: 8, padding: "14px 18px",
};
const h: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: "0.08em",
  color: "var(--text-secondary)", marginBottom: 10,
};

/** Shaded by MAGNITUDE only. -0.83 is as redundant as +0.83. */
function cellStyle(v: number | null, self: boolean): React.CSSProperties {
  if (self) return { background: "var(--bg-card)", color: "var(--text-muted)" };
  if (v === null) return { color: "var(--text-muted)" };
  const a = Math.min(1, Math.abs(v));
  return {
    background: a > 0.5 ? `rgba(188,140,255,${0.10 + a * 0.35})` : a > 0.3 ? `rgba(188,140,255,${a * 0.18})` : undefined,
    color: a > 0.5 ? "var(--text-primary)" : "var(--text-secondary)",
    fontWeight: a > 0.5 ? 700 : 400,
  };
}

export default function SignalMapPage() {
  const [data, setData] = useState<Map | null>(null);
  const [target, setTarget] = useState<"return_10d" | "return_5d">("return_10d");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true); setErr(null);
    fetch(`${API_BASE}/api/signal-map?target=${target}`)
      .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; })
      .then(setData)
      .catch(e => { setErr(e.message); setData(null); })
      .finally(() => setLoading(false));
  }, [target]);

  const byT = data ? data.factors.slice().sort((a, b) => Math.abs(b.t ?? 0) - Math.abs(a.t ?? 0)) : [];

  return (
    <>
      <Navbar />
      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "18px 16px 60px" }}>

        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
          <h1 style={{ fontSize: 18, fontWeight: 800, color: "var(--text-primary)", margin: 0 }}>Signal Map</h1>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            which factors are actually different from each other
          </span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            {(["return_10d", "return_5d"] as const).map(t => (
              <button key={t} onClick={() => setTarget(t)} style={{
                fontSize: 11, fontWeight: 700, padding: "4px 12px", borderRadius: 6, cursor: "pointer",
                background: target === t ? "rgba(47,129,247,0.15)" : "var(--bg-primary)",
                color: target === t ? "var(--accent-blue)" : "var(--text-secondary)",
                border: `1px solid ${target === t ? "var(--accent-blue)" : "var(--border)"}`,
              }}>{t.replace("return_", "").toUpperCase()}</button>
            ))}
          </div>
        </div>

        {loading && <div style={{ ...card, color: "var(--text-secondary)" }}>⏳ Computing…</div>}
        {err && <div style={{ ...card, borderColor: "var(--accent-red)", color: "var(--accent-red)" }}>⛔ {err}</div>}

        {data && !loading && (
          <>
            <div style={{ ...card, marginBottom: 12, display: "flex", gap: 24, flexWrap: "wrap", alignItems: "baseline" }}>
              <div>
                <div style={{ fontSize: 26, fontWeight: 800, color: "var(--accent-purple)" }}>
                  {data.independent.length}<span style={{ fontSize: 15, color: "var(--text-muted)" }}> / {data.factors.length}</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>independent factors</div>
              </div>
              <div>
                <div style={{ fontSize: 26, fontWeight: 800, color: "var(--accent-cyan)" }}>{data.carriers}</div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>…that also carry |IC| ≥ 0.02</div>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", maxWidth: 520, lineHeight: 1.6 }}>
                Both conditions matter. Copies of one signal are one signal, and independent zeros
                are still zero. {data.meta.rows.toLocaleString()} stored rows over {data.meta.dates} cross-sections,
                {" "}{data.meta.from} → {data.meta.to}.
              </div>
            </div>

            {/* The caveat rides with the data rather than being a footnote, because
                the IC column is the half a reader will want to act on. */}
            <div style={{
              ...card, marginBottom: 12, borderColor: "rgba(210,153,34,0.35)",
              background: "rgba(210,153,34,0.06)", fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.7,
            }}>
              ⚠ {data.meta.regimeWarning}
            </div>

            <div style={{ ...card, marginBottom: 12 }}>
              <div style={h}>REDUNDANCY — CROSS-SECTIONAL RANK CORRELATION, SHADED BY MAGNITUDE</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10 }}>
                Shaded by |ρ|, not by sign: −0.83 is exactly as redundant as +0.83, one being the other
                inverted. These factors <i>rank</i> tickers against each other, so the correlation is
                computed within each date and averaged — never across the pooled panel.
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", fontSize: 11, fontFamily: "ui-monospace, monospace" }}>
                  <thead>
                    <tr>
                      <th style={{ padding: "4px 6px" }} />
                      {data.factors.map(f => (
                        <th key={f.key} title={f.label} style={{ padding: "4px 6px", color: "var(--text-muted)", fontWeight: 600 }}>{f.short}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.factors.map((f, i) => (
                      <tr key={f.key}>
                        <td title={f.label} style={{ padding: "4px 8px", color: "var(--text-secondary)", fontWeight: 700, whiteSpace: "nowrap" }}>{f.short}</td>
                        {data.factors.map((_, j) => (
                          <td key={j} style={{ padding: "4px 6px", textAlign: "right", ...cellStyle(data.corr[i][j], i === j) }}>
                            {i === j ? "1.00" : data.corr[i][j] === null ? "·" : data.corr[i][j]!.toFixed(2)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
              <div style={{ ...card, flex: "1 1 420px" }}>
                <div style={h}>WHAT EACH ONE CARRIES — vs {data.target}</div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
                  Read <b>t</b> before IC: it is what says whether a number is distinguishable from zero at all.
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: "var(--text-muted)", fontSize: 10, letterSpacing: "0.06em", textAlign: "left" }}>
                      <th style={{ padding: "4px 6px" }}>FACTOR</th>
                      <th style={{ padding: "4px 6px", textAlign: "right" }}>IC</th>
                      <th style={{ padding: "4px 6px", textAlign: "right" }}>IR</th>
                      <th style={{ padding: "4px 6px", textAlign: "right" }}>t</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byT.map(f => (
                      <tr key={f.key} style={{ borderTop: "1px solid var(--border)" }}>
                        <td style={{ padding: "5px 6px", color: "var(--text-primary)" }}>
                          <b>{f.short}</b> <span style={{ color: "var(--text-secondary)" }}>{f.label}</span>
                        </td>
                        <td style={{ padding: "5px 6px", textAlign: "right", fontFamily: "ui-monospace, monospace",
                          color: (f.ic ?? 0) < 0 ? "var(--accent-red)" : "var(--accent-green)" }}>
                          {f.ic === null ? "—" : f.ic.toFixed(4)}
                        </td>
                        <td style={{ padding: "5px 6px", textAlign: "right", color: "var(--text-muted)", fontFamily: "ui-monospace, monospace" }}>
                          {f.ir === null ? "—" : f.ir.toFixed(2)}
                        </td>
                        <td style={{ padding: "5px 6px", textAlign: "right", fontFamily: "ui-monospace, monospace",
                          fontWeight: Math.abs(f.t ?? 0) > 2 ? 700 : 400,
                          color: Math.abs(f.t ?? 0) > 2 ? "var(--text-primary)" : "var(--text-muted)" }}>
                          {f.t === null ? "—" : f.t.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ ...card, flex: "1 1 320px" }}>
                <div style={h}>THE INDEPENDENT SET (|ρ| ≤ {data.redundantAbove})</div>
                <div style={{ fontSize: 12, lineHeight: 2 }}>
                  {data.independent.map(k => (
                    <div key={k.short} style={{ color: "var(--text-primary)" }}>
                      <span style={{ color: "var(--accent-green)", fontWeight: 700 }}>keep</span>{" "}
                      <b>{k.short}</b> <span style={{ color: "var(--text-secondary)" }}>{k.label}</span>
                    </div>
                  ))}
                </div>
                <div style={{ ...h, marginTop: 14 }}>SAME SIGNAL, DIFFERENT NAME</div>
                <div style={{ fontSize: 12, lineHeight: 2 }}>
                  {data.redundantFactors.map(d => (
                    <div key={d.short} style={{ color: "var(--text-muted)" }}>
                      <span style={{ color: "var(--accent-red)", fontWeight: 700 }}>drop</span>{" "}
                      <b>{d.short}</b> {d.label} — ρ {d.rho.toFixed(2)} with <b>{d.redundantWith}</b>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ ...card, fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.8 }}>
              <div style={h}>HOW TO USE THIS</div>
              Before adding an indicator, ask which cluster it lands in. Another oscillator adds nothing to a
              system that already holds five of them under different names. The value is in the empty
              quadrants — a signal structurally unlike anything on this grid is worth more than a better
              momentum measure, even when its IC is smaller.
              <div style={{ marginTop: 8, color: "var(--text-muted)" }}>
                Measured in EXP-040; the broker price/identity axes were checked against this grid in
                EXP-041. Neither is a trading result and neither licenses a position.
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
