"use client";
import { useState, useEffect } from "react";
import { API_BASE } from "@/lib/apiConfig";
import { getBrokerColors, getBrokerCategory, BROKER_COLORS } from "@/lib/brokerColors";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
  LineChart, Line, CartesianGrid, Area, ComposedChart,
} from "recharts";

const COLORS = ["#2f81f7","#39d2f5","#f0883e","#a5d6ff","#d2a8ff"];

function fmtVal(n: number) {
  if (Math.abs(n) >= 1e12) return (n/1e12).toFixed(1)+"T";
  if (Math.abs(n) >= 1e9)  return (n/1e9).toFixed(1)+"B";
  if (Math.abs(n) >= 1e6)  return (n/1e6).toFixed(0)+"M";
  return String(Math.round(n));
}
function shortDate(d: string) { const p=d.split("-"); return `${p[2]}/${p[1]}`; }

function heatColor(val: number) {
  if (val > 5e9)  return "rgba(63,185,80,0.7)";
  if (val > 1e9)  return "rgba(63,185,80,0.45)";
  if (val > 0)    return "rgba(63,185,80,0.2)";
  if (val < -5e9) return "rgba(248,81,73,0.7)";
  if (val < -1e9) return "rgba(248,81,73,0.45)";
  if (val < 0)    return "rgba(248,81,73,0.2)";
  return "transparent";
}

interface TickerDetailProps {
  ticker: string;
  onClose: () => void;
}

// Period presets (trading days)
const PERIODS: Record<string, number> = { "1W": 5, "1M": 22, "3M": 65, "6M": 130 };

function fmtLot(n: number) {
  const a = Math.abs(n);
  if (a >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (a >= 1_000)     return Math.round(n / 1_000) + "K";
  return String(Math.round(n));
}

export default function TickerDetail({ ticker, onClose }: TickerDetailProps) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"heatmap"|"tracker">("tracker");
  const [period, setPeriod] = useState<string>("1M");

  useEffect(() => {
    setLoading(true);
    const days = PERIODS[period] || 22;
    fetch(`${API_BASE}/api/ticker-detail?ticker=${ticker}&days=${days}`)
      .then(r => r.json())
      .then(json => { if (!json.error) setData(json); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [ticker]);

  if (loading) return (
    <div style={{ padding: 48, textAlign: "center", color: "var(--text-muted)" }}>
      ⏳ Loading {ticker} detail...
    </div>
  );
  if (!data) return (
    <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>
      No data for {ticker}
    </div>
  );

  const { fundSummary, brokerAction, candlestick, heatmap, brokerTracker, brokerCodes } = data;

  return (
    <div style={{ animation: "slide-up 0.3s ease" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 4, height: 28, background: "var(--accent-cyan)", borderRadius: 2 }} />
          <h2 style={{ fontSize: 22, fontWeight: 900, color: "var(--text-primary)",
            fontFamily: "'Space Grotesk', sans-serif", margin: 0 }}>{ticker}</h2>
        </div>
        <button onClick={onClose} className="pill-btn"
          style={{ fontSize: 12, padding: "6px 16px" }}>✕ Close</button>
      </div>

      {/* Row 1: Fund Summary + Broker Action */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        {/* Fund Summary */}
        <div className="card" style={{ padding: 20 }}>
          <h3 style={{ fontSize: 13, fontWeight: 800, color: "var(--accent-cyan)",
            letterSpacing: "0.08em", marginBottom: 4 }}>FUND SUMMARY</h3>
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12 }}>
            NET BUY vs SELL · Last {fundSummary.length} days · in IDR
          </p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={fundSummary} barGap={2}>
              <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 10, fill: "#8b949e" }} />
              <YAxis tickFormatter={fmtVal} tick={{ fontSize: 10, fill: "#8b949e" }} width={50} />
              <Tooltip formatter={(v: any) => fmtVal(Number(v))} labelFormatter={(l: any) => shortDate(String(l))}
                contentStyle={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="buy" fill="#3fb950" radius={[3,3,0,0]} name="Buy" />
              <Bar dataKey="sell" fill="#f85149" radius={[3,3,0,0]} name="Sell" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Broker Action */}
        <div className="card" style={{ padding: 20 }}>
          <h3 style={{ fontSize: 13, fontWeight: 800, color: "var(--accent-cyan)",
            letterSpacing: "0.08em", marginBottom: 4 }}>BROKER ACTION</h3>
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12 }}>
            Top {brokerCodes?.length || 5} brokers · Net flow over time
          </p>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={brokerAction}>
              <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
              <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 10, fill: "#8b949e" }} />
              <YAxis tickFormatter={fmtVal} tick={{ fontSize: 10, fill: "#8b949e" }} width={50} />
              <Tooltip formatter={(v: any) => fmtVal(Number(v))} labelFormatter={(l: any) => shortDate(String(l))}
                contentStyle={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 8, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {(brokerCodes || []).map((b: string, i: number) => (
                <Line key={b} type="monotone" dataKey={b} stroke={COLORS[i % COLORS.length]}
                  strokeWidth={2} dot={{ r: 3 }} name={b} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Row 2: Candlestick */}
      {candlestick.length > 0 && (
        <div className="card" style={{ padding: 20, marginBottom: 16 }}>
          <h3 style={{ fontSize: 13, fontWeight: 800, color: "var(--accent-cyan)",
            letterSpacing: "0.08em", marginBottom: 12 }}>PRICE CHART · {ticker}</h3>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={candlestick}>
              <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
              <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 10, fill: "#8b949e" }} />
              <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10, fill: "#8b949e" }} width={55}
                tickFormatter={(v: any) => Number(v).toLocaleString("id-ID")} />
              <Tooltip
                contentStyle={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 8, fontSize: 12 }}
                formatter={(v: any) => `Rp ${Number(v).toLocaleString("id-ID")}`}
                labelFormatter={(l: any) => shortDate(String(l))} />
              {/* Render candles as bars between open/close with wicks */}
              {candlestick.map((c: any, i: number) => {
                const bullish = c.close >= c.open;
                return null; // We'll use Area + custom rendering
              })}
              <Area type="monotone" dataKey="close" stroke="#2f81f7" fill="rgba(47,129,247,0.08)"
                strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="high" stroke="#3fb95066" strokeWidth={1} dot={false} strokeDasharray="2 2" />
              <Line type="monotone" dataKey="low" stroke="#f8514966" strokeWidth={1} dot={false} strokeDasharray="2 2" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Tabs: Heatmap / Tracker */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {(["heatmap","tracker"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className="pill-btn" style={{
              background: tab === t ? "var(--accent-blue)" : "var(--bg-secondary)",
              color: tab === t ? "#fff" : "var(--text-secondary)",
              fontWeight: 700, fontSize: 12, padding: "8px 20px",
              border: tab === t ? "none" : "1px solid var(--border)",
            }}>
            {t === "heatmap" ? `${ticker} BROKER HEATMAP` : `${ticker} BROKER NET TRACKER`}
          </button>
        ))}
      </div>

      {/* Heatmap */}
      {tab === "heatmap" && heatmap && (
        <div className="card" style={{ padding: 20, overflow: "auto" }}>
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12 }}>
            Green = Net Buy · Red = Net Sell · Intensity = Volume
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 700 }}>
              <thead>
                <tr>
                  <th style={{ padding: "6px 10px", fontSize: 11, color: "var(--text-muted)",
                    textAlign: "left", borderBottom: "1px solid var(--border)" }}>BROKER</th>
                  {heatmap.dates.map((d: string) => (
                    <th key={d} style={{ padding: "6px 8px", fontSize: 10, color: "var(--text-muted)",
                      textAlign: "center", borderBottom: "1px solid var(--border)", minWidth: 50 }}>
                      {shortDate(d)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {heatmap.brokers.map((b: string) => (
                  <tr key={b}>
                    <td style={{ padding: "4px 10px", fontSize: 12, fontWeight: 800,
                      color: "var(--text-primary)", fontFamily: "'Space Grotesk', sans-serif",
                      borderBottom: "1px solid var(--border)" }}>{b}</td>
                    {heatmap.dates.map((d: string) => {
                      const val = heatmap.data[b]?.[d] || 0;
                      return (
                        <td key={d} style={{
                          padding: "4px 6px", textAlign: "center", fontSize: 10, fontWeight: 700,
                          background: heatColor(val),
                          color: val > 0 ? "#3fb950" : val < 0 ? "#f85149" : "#8b949e",
                          borderBottom: "1px solid var(--border)",
                        }}>
                          {val !== 0 ? fmtVal(val) : "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* BROKER STATS — ACCUM/DISTRIB (like FT.id) */}
      {tab === "tracker" && brokerTracker && (
        <div className="card" style={{ padding: 20 }}>
          {/* Section title */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-muted)" }}>
              BROKER STATS — {period} PERIOD
            </span>
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
              Net Lot = GROSS Buy Lot − GROSS Sell Lot
            </span>
          </div>

          {/* Broker cards grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10, marginBottom: 20 }}>
            {brokerTracker.map((bt: any) => {
              const isAccum = bt.direction === "ACCUM";
              const accent  = isAccum ? "var(--accent-green)" : "var(--accent-red)";
              const bg      = isAccum ? "rgba(63,185,80,0.08)" : "rgba(248,81,73,0.08)";
              const bdr     = isAccum ? "rgba(63,185,80,0.3)" : "rgba(248,81,73,0.3)";
              const lastPos = bt.lastDayLot >= 0;
              return (
                <div key={bt.broker} style={{
                  padding: "12px 14px", borderRadius: 8, border: `1px solid ${bdr}`,
                  background: bg, display: "flex", flexDirection: "column", gap: 6,
                }}>
                  {/* Top: broker code + badge */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ fontSize: 15, fontWeight: 900, color: getBrokerColors(bt.broker).text,
                        fontFamily: "'Space Grotesk', sans-serif" }}>{bt.broker}</span>
                      <span style={{ fontSize: 8, color: getBrokerColors(bt.broker).text, opacity: 0.7,
                        fontWeight: 700, letterSpacing: "0.05em" }}>
                        {BROKER_COLORS[getBrokerCategory(bt.broker)].label.toUpperCase()}
                      </span>
                    </div>
                    <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 4, fontWeight: 800,
                      letterSpacing: "0.07em", background: isAccum ? "rgba(63,185,80,0.2)" : "rgba(248,81,73,0.2)",
                      color: accent }}>
                      {isAccum ? "ACCUM" : "DISTRIB"}
                    </span>
                  </div>

                  {/* Net Lot value */}
                  <span style={{ fontSize: 20, fontWeight: 800, color: accent, lineHeight: 1 }}>
                    {bt.netLot >= 0 ? "+" : ""}{bt.netLotFmt}
                    <span style={{ fontSize: 10, fontWeight: 500, color: "var(--text-muted)", marginLeft: 4 }}>lot</span>
                  </span>

                  {/* Last day activity */}
                  <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--text-muted)" }}>
                    <span style={{ color: lastPos ? "var(--accent-green)" : "var(--accent-red)", fontWeight: 700 }}>
                      {lastPos ? "▲" : "▼"} {fmtLot(Math.abs(bt.lastDayLot))}
                    </span>
                    <span>last day</span>
                  </div>

                  {/* Gross buy/sell */}
                  <div style={{ display: "flex", gap: 10, fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
                    <span>B: <strong style={{ color: "var(--accent-green)" }}>{bt.totalBuyFmt}</strong></span>
                    <span>S: <strong style={{ color: "var(--accent-red)" }}>{bt.totalSellFmt}</strong></span>
                  </div>

                  {/* Mini sparkline */}
                  {bt.series.length > 1 && (
                    <ResponsiveContainer width="100%" height={44}>
                      <BarChart data={bt.series} barSize={6} margin={{ top: 2, bottom: 0, left: 0, right: 0 }}>
                        <Bar dataKey="net" radius={[2,2,0,0]}
                          // @ts-ignore
                          shape={(props: any) => {
                            const { x, y, width, height, payload } = props;
                            const fill = payload.net > 0 ? "#3fb950" : "#f85149";
                            return <rect x={x} y={y} width={width} height={Math.abs(height)} fill={fill} rx={2} opacity={0.8} />;
                          }} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              );
            })}
          </div>

          {/* Cumulative chart title */}
          <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 10 }}>
            CUMULATIVE NET LOT PER BROKER
          </p>
        </div>
      )}
    </div>
  );
}
