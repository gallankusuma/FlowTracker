"use client";
/**
 * Deep Analysis — the top-down read for one ticker.
 *
 * The design constraint that shaped this page: MEASURED and INTERPRETED must
 * never look alike. Everything above the divider is a number this project can
 * defend; everything below it is convention. EXP-016 found the broker
 * "accumulation" signal is inverted and the scanner score turned out to describe
 * the same day rather than forecast the next -- both looked obviously right. A
 * page that styles a hunch like a measurement teaches its reader to trust the
 * wrong half, so the two are separated visually, not just labelled.
 */
import Navbar from "@/components/Navbar";
import { API_BASE } from "@/lib/apiConfig";
import { useState, useEffect, useCallback } from "react";

type Struct = {
  state: string;
  pivots?: number;
  lastSwingHigh?: { price: number; date: string; barsAgo: number };
  lastSwingLow?: { price: number; date: string };
  toConfirmUp?: { status?: string; lastConfirmedHigh?: number; abovePct?: number; needsCloseAbove?: number; distancePct?: number; then?: string };
  invalidation?: { below: number; distancePct: number; meaning: string };
  reason?: string;
};
type Zone = { lo: number; hi: number; volPct: number; turns: number; widthPct: number; broad?: boolean; peak?: { lo: number; hi: number } };
type BrokerRow = { broker: string; name: string | null; netB: number; avgBuy?: number; avgSell?: number; foreignPct: number | null; ownership: string | null; clientBase: string | null };
type Report = {
  ticker: string; asOf: string; lastClose: number; sessions: number;
  coverage: { from: string; to: string };
  cached?: boolean; cachedAgeSec?: number;
  measured: {
    weeklyStructure: Struct; dailyStructure: Struct;
    zones: { zones: Zone[]; poc: { lo: number; hi: number }; valueArea: { lo: number; hi: number } };
    zoneWindow: { sessions: number; from: string; to: string };
    volume: { date: string; volume: number; vs20dAverage: number | null; closePositionInRange: number | null; upperWickPct: number | null; lowerWickPct: number | null; direction: string };
    trend: { ema8: number | null; ema21: number | null; ema50: number | null; ema200: number | null; ema200Note: string | null; bbUpper: number | null; bbMiddle: number | null; bbLower: number | null };
    intraday?: { skipped?: boolean; unavailable?: string; bars?: number; from?: string; to?: string; runningBarDropped?: boolean; structure?: Struct; zones?: { zones: Zone[] } };
    brokerCostBasis: {
      since: string; unavailable?: string;
      netBuyers?: number; netSellers?: number; buyersPaidAvg?: number; sellersGotAvg?: number; lastCloseVsBuyers?: number;
      topBuyers?: BrokerRow[]; topSellers?: BrokerRow[];
      foreignBuyingB?: number; foreignSellingB?: number; retailBuyingB?: number; retailSellingB?: number;
    };
  };
  conventions: string[]; conventionsCaveat: string; notMeasured: string[];
  error?: string;
};

const num = (v: number | null | undefined, d = 0) =>
  v === null || v === undefined || !isFinite(v) ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v: number | null | undefined) =>
  v === null || v === undefined || !isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

/** Structure states are not good/bad, so the colour says CONFIDENCE, not direction. */
function stateColor(state: string) {
  if (state.startsWith("UPTREND")) return "var(--accent-green)";
  if (state.startsWith("DOWNTREND")) return "var(--accent-red)";
  if (state.startsWith("UNDETERMINED")) return "var(--text-muted)";
  return "var(--accent-yellow)";   // both ATTEMPT states: unresolved, not neutral
}

const card: React.CSSProperties = {
  background: "var(--bg-secondary)", border: "1px solid var(--border)",
  borderRadius: 8, padding: "14px 18px",
};
const h: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: "0.08em",
  color: "var(--text-secondary)", marginBottom: 10,
};

function StructureCard({ title, s, note }: { title: string; s?: Struct; note?: string }) {
  if (!s) return null;
  return (
    <div style={{ ...card, flex: "1 1 300px", minWidth: 280 }}>
      <div style={h}>{title}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: stateColor(s.state), marginBottom: 8, lineHeight: 1.3 }}>
        {s.state}
      </div>
      {note && <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>{note}</div>}
      {s.lastSwingHigh ? (
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.9 }}>
          <div>swing high <b style={{ color: "var(--text-primary)" }}>{num(s.lastSwingHigh.price)}</b>{" "}
            <span style={{ color: "var(--text-muted)" }}>({s.lastSwingHigh.date}, {s.lastSwingHigh.barsAgo} bars ago)</span></div>
          <div>swing low <b style={{ color: "var(--text-primary)" }}>{num(s.lastSwingLow?.price)}</b></div>
          {s.toConfirmUp?.status ? (
            <div style={{ color: "var(--accent-yellow)" }}>
              price is {pct(s.toConfirmUp.abovePct)} above the last confirmed high ({num(s.toConfirmUp.lastConfirmedHigh)}) —{" "}
              <span style={{ color: "var(--text-muted)" }}>unconfirmed break, not a higher high</span>
            </div>
          ) : (
            <div>to confirm up: close above <b style={{ color: "var(--text-primary)" }}>{num(s.toConfirmUp?.needsCloseAbove)}</b>{" "}
              <span style={{ color: "var(--text-muted)" }}>({pct(s.toConfirmUp?.distancePct)})</span></div>
          )}
          <div style={{ color: "var(--accent-red)" }}>
            invalidation below <b>{num(s.invalidation?.below)}</b>{" "}
            <span style={{ color: "var(--text-muted)" }}>({pct(s.invalidation?.distancePct)})</span>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{s.reason}</div>
      )}
    </div>
  );
}

function ZoneTable({ zones, lastClose, compact }: { zones: Zone[]; lastClose: number; compact?: boolean }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 460 }}>
        <thead>
          <tr style={{ color: "var(--text-muted)", textAlign: "left", fontSize: 10, letterSpacing: "0.06em" }}>
            <th style={{ padding: "4px 8px" }}>RANGE</th>
            <th style={{ padding: "4px 8px" }}>WIDTH</th>
            <th style={{ padding: "4px 8px" }}>VOL%</th>
            <th style={{ padding: "4px 8px" }}>TURNS</th>
            <th style={{ padding: "4px 8px" }}>POSITION</th>
          </tr>
        </thead>
        <tbody>
          {zones.map((z, i) => {
            const here = lastClose >= z.lo && lastClose <= z.hi;
            return (
              <tr key={i} style={{
                borderTop: "1px solid var(--border)",
                background: here ? "rgba(47,129,247,0.10)" : undefined,
              }}>
                <td style={{ padding: "6px 8px", fontFamily: "ui-monospace, monospace", color: "var(--text-primary)" }}>
                  {num(z.lo)} – {num(z.hi)}
                  {!compact && z.broad && z.peak && (
                    <div style={{ fontSize: 10, color: "var(--text-muted)" }}>densest {num(z.peak.lo)} – {num(z.peak.hi)}</div>
                  )}
                </td>
                <td style={{ padding: "6px 8px", color: "var(--text-muted)" }}>{z.widthPct?.toFixed(1)}%</td>
                <td style={{ padding: "6px 8px", color: "var(--text-secondary)" }}>{z.volPct.toFixed(1)}%</td>
                {/* Descriptive, not a quality filter -- and I built it believing it
                    was one. EXP-036 measured zones-with-turns at +5.315pp against
                    +5.668pp for all zones, slightly WORSE. It stays because "price
                    turned here before" is worth seeing; the claim that it picks
                    better zones is withdrawn. */}
                <td style={{ padding: "6px 8px", fontWeight: 700, color: z.turns === 0 ? "var(--text-muted)" : "var(--accent-cyan)" }}>
                  {z.turns}
                  {z.turns === 0 && <span style={{ fontWeight: 400, fontSize: 10, color: "var(--text-muted)" }}> passed through</span>}
                </td>
                <td style={{ padding: "6px 8px", color: here ? "var(--accent-blue)" : "var(--text-muted)", fontWeight: here ? 700 : 400 }}>
                  {here ? "PRICE IS HERE" : lastClose > z.hi ? "below price" : "above price"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function DeepAnalysisPage() {
  const [ticker, setTicker] = useState("ADMR");
  const [input, setInput] = useState("ADMR");
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback((t: string) => {
    setLoading(true); setErr(null);
    fetch(`${API_BASE}/api/deep-analysis?ticker=${encodeURIComponent(t)}`)
      .then(async r => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        return j;
      })
      .then(j => setData(j))
      .catch(e => { setErr(e.message); setData(null); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(ticker); }, [ticker, load]);

  const m = data?.measured;
  const b = m?.brokerCostBasis;
  const hourly = m?.intraday;

  return (
    <>
      <Navbar />
      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "18px 16px 60px" }}>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
          <h1 style={{ fontSize: 18, fontWeight: 800, color: "var(--text-primary)", margin: 0 }}>Deep Analysis</h1>
          <form onSubmit={e => { e.preventDefault(); setTicker(input.trim().toUpperCase()); }}
                style={{ display: "flex", gap: 6 }}>
            <input value={input} onChange={e => setInput(e.target.value.toUpperCase())}
              placeholder="TICKER" maxLength={10}
              style={{
                width: 110, padding: "6px 10px", fontSize: 13, fontWeight: 700, letterSpacing: "0.05em",
                background: "var(--bg-primary)", color: "var(--text-primary)",
                border: "1px solid var(--border)", borderRadius: 6,
              }} />
            <button type="submit" style={{
              padding: "6px 14px", fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: "pointer",
              background: "rgba(47,129,247,0.15)", color: "var(--accent-blue)", border: "1px solid var(--accent-blue)",
            }}>ANALYSE</button>
          </form>
          {data && (
            <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: "auto" }}>
              {data.sessions} sessions · {data.coverage.from} → {data.coverage.to}
              {data.cached ? ` · cached ${data.cachedAgeSec}s` : ""}
            </span>
          )}
        </div>

        {loading && <div style={{ ...card, color: "var(--text-secondary)" }}>⏳ Computing…</div>}
        {err && <div style={{ ...card, borderColor: "var(--accent-red)", color: "var(--accent-red)" }}>⛔ {err}</div>}

        {data && m && !loading && (
          <>
            <div style={{ ...card, marginBottom: 12, display: "flex", gap: 20, alignItems: "baseline", flexWrap: "wrap" }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: "var(--text-primary)" }}>{data.ticker}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "var(--text-primary)" }}>{num(data.lastClose)}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>as of {data.asOf}</div>
            </div>

            {/* ── STRUCTURE, all three timeframes ─────────────────────────── */}
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
              <StructureCard title="WEEKLY" s={m.weeklyStructure} />
              <StructureCard title="DAILY" s={m.dailyStructure} />
              {hourly && !hourly.skipped && !hourly.unavailable && (
                <StructureCard title="HOURLY (60m)" s={hourly.structure}
                  note={`${hourly.bars} closed bars · Yahoo, a different source from the daily table${hourly.runningBarDropped ? " · running bar dropped" : ""}`} />
              )}
            </div>
            {hourly?.unavailable && (
              <div style={{ ...card, marginBottom: 12, fontSize: 12, color: "var(--text-muted)" }}>
                Hourly unavailable: {hourly.unavailable}
              </div>
            )}

            {/* ── ZONES ───────────────────────────────────────────────────── */}
            <div style={{ ...card, marginBottom: 12 }}>
              <div style={h}>ZONES — WHERE THE SHARES ACTUALLY CHANGED HANDS</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                {m.zoneWindow.sessions} sessions from {m.zoneWindow.from} · point of control {num(m.zones.poc.lo)}–{num(m.zones.poc.hi)} ·
                value area {num(m.zones.valueArea.lo)}–{num(m.zones.valueArea.hi)}
              </div>
              {/* This table has been tested, so it states the measured size rather
                  than leaving a reader to assume. EXP-036 found +5.7pp against
                  arbitrary bands, but only +1.4pp once proximity to the current
                  price is held constant -- the honest number is the second one. */}
              <div style={{ fontSize: 11, color: "var(--accent-cyan)", marginBottom: 4 }}>
                TESTED (EXP-036): future pivots land here <b>+1.4pp</b> more often than in bands matched
                for width and distance from price — real, and modest.
              </div>
              {/* The negative result gets the same prominence as the positive one.
                  A page that shows what worked and buries what did not is how a
                  reader ends up trusting a table that loses money. */}
              <div style={{
                fontSize: 11, color: "var(--accent-red)", marginBottom: 8,
                background: "rgba(248,81,73,0.08)", border: "1px solid rgba(248,81,73,0.25)",
                borderRadius: 6, padding: "6px 10px",
              }}>
                ALSO TESTED (EXP-037): <b>buying these zones loses.</b> Entering on a close into a support
                zone and holding 20 sessions returned <b>1.6% less</b> than simply holding the same stock —
                before costs, and before survivorship. A zone catches more turns in <i>either</i> direction;
                it is not a place where buying pays.
              </div>
              <ZoneTable zones={m.zones.zones} lastClose={data.lastClose} />
              {hourly?.zones?.zones?.length ? (
                <>
                  <div style={{ ...h, marginTop: 16 }}>HOURLY ZONES</div>
                  <ZoneTable zones={hourly.zones.zones.slice(0, 6)} lastClose={data.lastClose} compact />
                </>
              ) : null}
            </div>

            {/* ── TREND + VOLUME ──────────────────────────────────────────── */}
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
              <div style={{ ...card, flex: "1 1 320px" }}>
                <div style={h}>TREND / VOLATILITY</div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 2 }}>
                  <div>EMA8 <b style={{ color: "var(--text-primary)" }}>{num(m.trend.ema8)}</b> · EMA21 <b style={{ color: "var(--text-primary)" }}>{num(m.trend.ema21)}</b></div>
                  <div>EMA50 <b style={{ color: "var(--text-primary)" }}>{num(m.trend.ema50)}</b> · EMA200 <b style={{ color: "var(--text-primary)" }}>{num(m.trend.ema200)}</b></div>
                  {/* A withheld EMA200 is a statement, not a gap: too little history
                      leaves the value mostly its SMA seed, so it is not shown. */}
                  {m.trend.ema200Note && <div style={{ fontSize: 11, color: "var(--accent-yellow)" }}>{m.trend.ema200Note}</div>}
                  <div>BB20 {num(m.trend.bbLower)} · {num(m.trend.bbMiddle)} · {num(m.trend.bbUpper)}</div>
                </div>
              </div>
              <div style={{ ...card, flex: "1 1 320px" }}>
                <div style={h}>VOLUME — LAST CLOSED SESSION {m.volume.date}</div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 2 }}>
                  <div><b style={{ color: "var(--text-primary)" }}>{num(m.volume.volume)}</b> = <b style={{ color: (m.volume.vs20dAverage ?? 0) > 1.5 ? "var(--accent-yellow)" : "var(--text-primary)" }}>{m.volume.vs20dAverage}x</b> its 20-session average</div>
                  <div>close sat <b style={{ color: "var(--text-primary)" }}>{Math.round((m.volume.closePositionInRange ?? 0) * 100)}%</b> up the bar&apos;s range</div>
                  <div>upper wick {m.volume.upperWickPct}% · lower wick {m.volume.lowerWickPct}%</div>
                </div>
              </div>
            </div>

            {/* ── BROKER COST BASIS ───────────────────────────────────────── */}
            <div style={{ ...card, marginBottom: 20 }}>
              <div style={h}>BROKER COST BASIS SINCE {b?.since} — NOT VISIBLE ON ANY CHART</div>
              {b?.unavailable ? (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{b.unavailable}</div>
              ) : (
                <>
                  <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 10 }}>
                    {b?.netBuyers} net buyers paid <b style={{ color: "var(--text-primary)" }}>{num(b?.buyersPaidAvg)}</b>
                    {" "}(last close is <b style={{ color: (b?.lastCloseVsBuyers ?? 0) >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>{pct(b?.lastCloseVsBuyers)}</b> vs that)
                    {" · "}{b?.netSellers} net sellers received <b style={{ color: "var(--text-primary)" }}>{num(b?.sellersGotAvg)}</b>
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 520 }}>
                      <tbody>
                        {[...(b?.topBuyers || []).map(x => ({ ...x, side: "buy" as const })),
                          ...(b?.topSellers || []).map(x => ({ ...x, side: "sell" as const }))].map((x, i) => (
                          <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
                            <td style={{ padding: "6px 8px", fontWeight: 800, color: x.side === "buy" ? "var(--accent-green)" : "var(--accent-red)" }}>
                              {x.side === "buy" ? "+" : "−"} {x.broker}
                            </td>
                            <td style={{ padding: "6px 8px", fontFamily: "ui-monospace, monospace", color: "var(--text-primary)" }}>
                              {Math.abs(x.netB)} B
                            </td>
                            <td style={{ padding: "6px 8px", color: "var(--text-secondary)" }}>at {num(x.avgBuy ?? x.avgSell)}</td>
                            <td style={{ padding: "6px 8px", color: "var(--text-secondary)" }}>{x.name || "—"}</td>
                            {/* Ownership and flow side by side on purpose: Mirae is
                                foreign-OWNED with 1.1% foreign flow, and collapsing
                                the two would read as foreign money arriving. */}
                            <td style={{ padding: "6px 8px", textAlign: "right" }}>
                              <span style={{
                                fontSize: 11, fontWeight: 700,
                                color: (x.foreignPct ?? 0) >= 50 ? "var(--accent-blue)" : "var(--text-muted)",
                              }}>
                                {x.foreignPct === null ? "? " : x.foreignPct}% foreign flow
                              </span>
                              {x.clientBase === "RETAIL_PLATFORM" && <span style={{ fontSize: 10, color: "var(--text-muted)" }}> · retail app</span>}
                              {x.ownership === "FOREIGN_OWNED" && <span style={{ fontSize: 10, color: "var(--text-muted)" }}> · fgn-owned</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-secondary)" }}>
                    By <b>measured</b> flow origin (≥50% foreign), not by the stored label:{" "}
                    foreign-flow brokers net{" "}
                    <b style={{ color: ((b?.foreignBuyingB ?? 0) + (b?.foreignSellingB ?? 0)) >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                      {((b?.foreignBuyingB ?? 0) + (b?.foreignSellingB ?? 0)).toFixed(1)} B
                    </b>{" · "}retail platforms net{" "}
                    <b style={{ color: ((b?.retailBuyingB ?? 0) + (b?.retailSellingB ?? 0)) >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                      {((b?.retailBuyingB ?? 0) + (b?.retailSellingB ?? 0)).toFixed(1)} B
                    </b>
                  </div>
                </>
              )}
            </div>

            {/* ── THE DIVIDER. Everything below is NOT a measurement. ─────── */}
            <div style={{
              borderTop: "2px dashed var(--border)", paddingTop: 16, marginTop: 4,
              opacity: 0.82,
            }}>
              <div style={{ ...h, color: "var(--accent-yellow)" }}>
                CONVENTIONAL READINGS — NOT MEASURED, NOT EVIDENCE
              </div>
              <ul style={{ margin: "0 0 10px", paddingLeft: 18, fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.9 }}>
                {data.conventions.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
              <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.7, marginBottom: 14 }}>
                {data.conventionsCaveat}
              </div>
              <div style={{ ...h }}>NOT COVERED</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.8 }}>
                {data.notMeasured.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          </>
        )}
      </div>
    </>
  );
}
