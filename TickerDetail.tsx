"use client";
import { useState, useEffect, useCallback } from "react";
import { API_BASE } from "@/lib/apiConfig";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area,
  ComposedChart, LineChart, Line, CartesianGrid, Cell, ReferenceLine,
} from "recharts";

// ─── Constants ────────────────────────────────────────────────────────────────
const BK_COLORS = [
  "#2f81f7","#39d2f5","#f0883e","#a5d6ff","#d2a8ff",
  "#ffa198","#7ee787","#ff7b72","#79c0ff","#e3b341",
  "#bc8cff","#56d364","#58a6ff","#f78166","#3fb950",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtVal(n: number) {
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(1) + "T";
  if (abs >= 1e9)  return (n / 1e9).toFixed(1) + "B";
  if (abs >= 1e6)  return (n / 1e6).toFixed(0) + "M";
  if (abs >= 1e3)  return (n / 1e3).toFixed(0) + "K";
  return String(Math.round(n));
}

function fmtLot(n: number) {
  const abs = Math.abs(n);
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

function shortDate(d: string) {
  if (!d) return "";
  const p = d.split("-");
  return p.length >= 3 ? `${p[2]}/${p[1]}` : d;
}

function heatColor(val: number) {
  if (val >  5e9) return "rgba(63,185,80,0.85)";
  if (val >  1e9) return "rgba(63,185,80,0.55)";
  if (val >     0) return "rgba(63,185,80,0.25)";
  if (val < -5e9) return "rgba(248,81,73,0.85)";
  if (val < -1e9) return "rgba(248,81,73,0.55)";
  if (val <     0) return "rgba(248,81,73,0.25)";
  return "transparent";
}

// ─── Subcomponents ────────────────────────────────────────────────────────────
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{
      fontSize: 13, fontWeight: 800, color: "var(--accent-cyan)",
      letterSpacing: "0.08em", margin: 0,
      fontFamily: "'Space Grotesk', sans-serif",
    }}>
      {children}
    </h3>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      fontSize: 10, padding: "3px 10px", borderRadius: 4, cursor: "pointer", fontWeight: 700,
      background: active ? "var(--accent-blue)" : "var(--bg-primary)",
      color: active ? "#fff" : "var(--text-muted)",
      border: `1px solid ${active ? "var(--accent-blue)" : "var(--border)"}`,
      transition: "all 0.15s",
    }}>
      {children}
    </button>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────
interface TickerDetailProps {
  ticker: string;
  onClose: () => void;
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function TickerDetail({ ticker, onClose }: TickerDetailProps) {
  const [data, setData]           = useState<any>(null);
  const [loading, setLoading]     = useState(true);
  const [rangeData, setRangeData] = useState<any>(null);
  const [motionTf, setMotionTf]   = useState<"1W"|"1M"|"3M"|"ALL">("1M");
  const [activeBks, setActiveBks] = useState<string[]>([]);
  const [trendTf, setTrendTf]     = useState<"ALL"|"1W"|"1M"|"3M">("ALL");
  const [alphaDate, setAlphaDate] = useState("");
  const [betaDate, setBetaDate]   = useState("");
  const [showPrice, setShowPrice] = useState(true);
  const [fibData, setFibData]     = useState<any>(null);
  const [lunarData, setLunarData] = useState<any[]>([]);
  const [showFib, setShowFib]     = useState(true);
  const [showLunar, setShowLunar] = useState(true);
  const [fibLookback, setFibLookback] = useState(60);
  const [agChartDays, setAgChartDays] = useState<"1M"|"3M"|"ALL">("1M");

  // Fetch main detail data
  useEffect(() => {
    setLoading(true); setData(null); setRangeData(null);
    fetch(`${API_BASE}/api/ticker-detail?ticker=${ticker}&days=30`)
      .then(r => r.json())
      .then(json => {
        if (!json.error) {
          setData(json);
          setActiveBks((json.brokerCodes || []).slice(0, 5));
          // Auto-set alpha = second last date, beta = last date
          const dates = json.dates || [];
          if (dates.length >= 2) {
            setAlphaDate(dates[dates.length - 2]);
            setBetaDate(dates[dates.length - 1]);
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [ticker]);

  // Fetch broker range data when alpha/beta dates change
  const fetchRange = useCallback(() => {
    if (!alphaDate || !betaDate) return;
    fetch(`${API_BASE}/api/broker-range?ticker=${ticker}&alphaDate=${alphaDate}&betaDate=${betaDate}`)
      .then(r => r.json())
      .then(json => { if (!json.error) setRangeData(json); })
      .catch(() => {});
  }, [ticker, alphaDate, betaDate]);

  useEffect(() => { fetchRange(); }, [fetchRange]);

  // Fetch Fibonacci data
  useEffect(() => {
    if (!ticker) return;
    setFibData(null);
    fetch(`${API_BASE}/api/fibonacci?ticker=${ticker}&lookback=${fibLookback}`)
      .then(r => r.json())
      .then(json => { if (!json.error) setFibData(json); })
      .catch(() => {});
  }, [ticker, fibLookback]);

  // Fetch Lunar events
  useEffect(() => {
    const from = new Date(Date.now() - 120 * 86400000).toISOString().split('T')[0];
    const to   = new Date(Date.now() +  30 * 86400000).toISOString().split('T')[0];
    fetch(`${API_BASE}/api/lunar?from=${from}&to=${to}`)
      .then(r => r.json())
      .then(json => { if (json.events) setLunarData(json.events); })
      .catch(() => {});
  }, [ticker]);

  if (loading) return (
    <div style={{ padding: 48, textAlign: "center", color: "var(--text-muted)" }}>
      <div style={{ fontSize: 24, marginBottom: 12 }}>⏳</div>
      Loading {ticker} detail...
    </div>
  );

  if (!data) return (
    <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>
      <div style={{ fontSize: 24, marginBottom: 12 }}>📭</div>
      No data available for {ticker}
    </div>
  );

  const {
    fundSummary   = [] as any[],
    brokerAction  = [] as any[],
    heatmap,
    brokerTracker = [] as any[],
    brokerCodes   = [] as string[],
  } = data;

  // ── Compute Big Money vs Ritel split from broker series ─────────────────────
  const TOP_N = 5;
  const topBkCodes = brokerCodes.slice(0, TOP_N);
  const bigMoneyFlow = fundSummary.map((fs: any) => {
    let bm = 0;
    topBkCodes.forEach((code: string) => {
      const bt = brokerTracker.find((b: any) => b.broker === code);
      const entry = bt?.series?.find((s: any) => s.date === fs.date);
      bm += entry?.net || 0;
    });
    return { date: fs.date, val: bm };
  });
  const riletFlow = fundSummary.map((fs: any, i: number) => ({
    date: fs.date, val: fs.net - bigMoneyFlow[i].val,
  }));
  let cumNet = 0;
  const netFlow = fundSummary.map((fs: any) => {
    cumNet += fs.net || 0;
    return { date: fs.date, val: cumNet };
  });

  // ── Broker Motion ────────────────────────────────────────────────────────────
  const tfDaysMap: Record<string, number> = { "1W": 7, "1M": 20, "3M": 60, "ALL": 9999 };
  const motionData = brokerAction.slice(-tfDaysMap[motionTf]);

  // ── Broker Trend heatmap ─────────────────────────────────────────────────────
  const heatDaysMap: Record<string, number> = { "ALL": 9999, "1W": 7, "1M": 20, "3M": 60 };
  const filteredDates: string[] = heatmap?.dates?.slice(-heatDaysMap[trendTf]) || [];

  // ── Broker Tracker Alpha-Beta ─────────────────────────────────────────────────
  const alphaBuyers  = (rangeData?.alpha || []).filter((b: any) => b.netVal > 0).slice(0, 12);
  const alphaSellers = (rangeData?.alpha || []).filter((b: any) => b.netVal < 0).slice(0, 12);
  const betaBuyers   = (rangeData?.beta  || []).filter((b: any) => b.netVal > 0).slice(0, 12);
  const betaSellers  = (rangeData?.beta  || []).filter((b: any) => b.netVal < 0).slice(0, 12);
  const inventory    = (rangeData?.inventory || []).slice(0, 15);

  const toggleBroker = (bk: string) =>
    setActiveBks(prev => prev.includes(bk) ? prev.filter(b => b !== bk) : [...prev, bk]);

  const cell = (v: number, color: string) => (
    <span style={{ color, fontWeight: 700, fontSize: 11 }}>{fmtVal(v)}</span>
  );

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ animation: "slide-up 0.3s ease" }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "flex-start",
        marginBottom: 20, paddingBottom: 16, borderBottom: "1px solid var(--border)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 5, height: 36, background: "var(--accent-cyan)", borderRadius: 3 }} />
          <div>
            <h2 style={{
              fontSize: 32, fontWeight: 900, color: "var(--text-primary)", margin: 0,
              fontFamily: "'Space Grotesk', sans-serif", letterSpacing: "0.02em",
            }}>
              {ticker}
            </h2>
            {data.dataRange && (
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3, letterSpacing: "0.06em", display: "flex", gap: 10 }}>
                <span>📅 {data.dataRange.from} → {data.dataRange.to}</span>
                <span>· {data.dataRange.days} hari</span>
                <span>· {data.brokerCodes?.length} broker</span>
              </div>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          {data.price > 0 && (
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 26, fontWeight: 900, color: "var(--text-primary)", fontFamily: "'Space Grotesk', sans-serif", lineHeight: 1.1 }}>
                Rp {data.price.toLocaleString("id-ID")}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, marginTop: 2,
                color: data.changePct > 0 ? "var(--accent-green)" : data.changePct < 0 ? "var(--accent-red)" : "var(--text-muted)" }}>
                {data.changePct > 0 ? "▲" : data.changePct < 0 ? "▼" : ""} {Math.abs(data.changePct).toFixed(2)}%
              </div>
            </div>
          )}
          <button onClick={onClose} className="pill-btn" style={{ fontSize: 11, padding: "8px 18px", fontWeight: 700, letterSpacing: "0.05em" }}>
            ✕ TERMINATE ANALYSIS
          </button>
        </div>
      </div>

      {/* ── Row 1: Flow Summary + Broker Motion ────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.6fr", gap: 16, marginBottom: 16 }}>

        {/* Flow Summary */}
        <div className="card" style={{ padding: 20 }}>
          <SectionTitle>FLOW SUMMARY</SectionTitle>
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "2px 0 16px" }}>
            HISTORICAL FLOW MATRIX (LAST {fundSummary.length} DAYS)
          </p>

          {/* FOREIGN FLOW */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#a371f7", letterSpacing: "0.06em", marginBottom: 4 }}>
              ■ FOREIGN FLOW
            </div>
            <ResponsiveContainer width="100%" height={90}>
              <BarChart data={fundSummary.map((d: any) => ({ date: d.date, val: d.net }))} barSize={7} margin={{ top: 4, right: 8, bottom: 0, left: 30 }}>
                <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 8, fill: "#8b949e" }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={(v) => fmtVal(Number(v))} tick={{ fontSize: 8, fill: "#8b949e" }} axisLine={false} tickLine={false} width={28} />
                <ReferenceLine y={0} stroke="#30363d" strokeWidth={1} />
                <Tooltip formatter={(v: any) => fmtVal(Number(v))} labelFormatter={(l: any) => shortDate(String(l))}
                  contentStyle={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 8, fontSize: 11 }} />
                <Bar dataKey="val" radius={[3,3,0,0]}>
                  {fundSummary.map((d: any, i: number) => <Cell key={i} fill={d.net >= 0 ? "#a371f7" : "#6e30c4"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* RITEL FLOW */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#f0883e", letterSpacing: "0.06em", marginBottom: 4 }}>
              ■ RITEL FLOW
            </div>
            <ResponsiveContainer width="100%" height={90}>
              <BarChart data={riletFlow} barSize={7} margin={{ top: 4, right: 8, bottom: 0, left: 30 }}>
                <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 8, fill: "#8b949e" }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={(v) => fmtVal(Number(v))} tick={{ fontSize: 8, fill: "#8b949e" }} axisLine={false} tickLine={false} width={28} />
                <ReferenceLine y={0} stroke="#30363d" strokeWidth={1} />
                <Tooltip formatter={(v: any) => fmtVal(Number(v))} labelFormatter={(l: any) => shortDate(String(l))}
                  contentStyle={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 8, fontSize: 11 }} />
                <Bar dataKey="val" radius={[3,3,0,0]}>
                  {riletFlow.map((d: any, i: number) => <Cell key={i} fill={d.val >= 0 ? "#f0883e" : "#c06020"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* BIG MONEY FLOW */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#58a6ff", letterSpacing: "0.06em", marginBottom: 4 }}>
              ■ BIG MONEY FLOW
            </div>
            <ResponsiveContainer width="100%" height={90}>
              <BarChart data={bigMoneyFlow} barSize={7} margin={{ top: 4, right: 8, bottom: 0, left: 30 }}>
                <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 8, fill: "#8b949e" }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={(v) => fmtVal(Number(v))} tick={{ fontSize: 8, fill: "#8b949e" }} axisLine={false} tickLine={false} width={28} />
                <ReferenceLine y={0} stroke="#30363d" strokeWidth={1} />
                <Tooltip formatter={(v: any) => fmtVal(Number(v))} labelFormatter={(l: any) => shortDate(String(l))}
                  contentStyle={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 8, fontSize: 11 }} />
                <Bar dataKey="val" radius={[3,3,0,0]}>
                  {bigMoneyFlow.map((d: any, i: number) => <Cell key={i} fill={d.val >= 0 ? "#58a6ff" : "#f85149"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Broker Action */}
        <div className="card" style={{ padding: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
            <div>
              <SectionTitle>BROKER ACTION</SectionTitle>
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "4px 0 0" }}>Cumulative net flow per broker</p>
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {(["1W","1M","3M","ALL"] as const).map(tf => (
                <TabBtn key={tf} active={motionTf === tf} onClick={() => setMotionTf(tf)}>{tf}</TabBtn>
              ))}
              <button
                onClick={() => setShowPrice(p => !p)}
                style={{
                  fontSize: 10, padding: "3px 9px", borderRadius: 4, cursor: "pointer", fontWeight: 700,
                  background: showPrice ? "rgba(227,179,65,0.15)" : "var(--bg-primary)",
                  color: showPrice ? "#e3b341" : "var(--text-muted)",
                  border: `1px solid ${showPrice ? "#e3b341" : "var(--border)"}`,
                  marginLeft: 4,
                }}
              >
                📈 PRICE
              </button>
            </div>
          </div>

          {/* Broker toggle pills */}
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 12 }}>
            {brokerCodes.slice(0, 12).map((bk: string, i: number) => {
              const color = BK_COLORS[i % BK_COLORS.length];
              const active = activeBks.includes(bk);
              return (
                <button key={bk} onClick={() => toggleBroker(bk)} style={{
                  fontSize: 11, padding: "3px 10px", borderRadius: 20, cursor: "pointer", fontWeight: 700,
                  background: active ? color + "20" : "transparent",
                  border: `1.5px solid ${active ? color : "var(--border)"}`,
                  color: active ? color : "var(--text-muted)",
                  transition: "all 0.15s",
                  display: "flex", alignItems: "center", gap: 5,
                }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: active ? color : "var(--border)", display: "inline-block", flexShrink: 0 }} />
                  {bk}
                </button>
              );
            })}
          </div>

          <ResponsiveContainer width="100%" height={290}>
            <ComposedChart data={motionData} margin={{ top: 4, right: 56, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(48,54,61,0.8)" vertical={true} />
              <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 9, fill: "#8b949e" }} axisLine={false} tickLine={false} />
              {/* Left axis: broker cumulative flow */}
              <YAxis yAxisId="flow" tickFormatter={fmtVal} tick={{ fontSize: 9, fill: "#8b949e" }} width={48} axisLine={false} tickLine={false} />
              {/* Right axis: stock price */}
              <YAxis
                yAxisId="price"
                orientation="right"
                tick={{ fontSize: 9, fill: "#e3b341" }}
                tickFormatter={(v) => `${(v/1000).toFixed(0)}K`}
                width={44}
                axisLine={false}
                tickLine={false}
                domain={['auto', 'auto']}
              />
              <ReferenceLine yAxisId="flow" y={0} stroke="#484f58" strokeWidth={1.5} />
              <Tooltip
                formatter={(v: any, name: any) => {
                  if (name === '__price__') return [`Rp ${Number(v).toLocaleString('id-ID')}`, 'Harga'];
                  return [fmtVal(Number(v)), name];
                }}
                labelFormatter={(l: any) => shortDate(String(l))}
                contentStyle={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 8, fontSize: 11 }}
              />
              {brokerCodes
                .filter((b: string) => activeBks.includes(b))
                .map((b: string) => {
                  const idx = brokerCodes.indexOf(b);
                  return <Line yAxisId="flow" key={b} type="monotone" dataKey={b} stroke={BK_COLORS[idx % BK_COLORS.length]} strokeWidth={2.5} dot={false} name={b} />;
                })}
              {/* Reference price line */}
              {showPrice && (
                <Line
                  yAxisId="price"
                  type="monotone"
                  dataKey="close"
                  name="__price__"
                  stroke="#e3b341"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  dot={false}
                  connectNulls
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Row 2: TradingView Chart ─────────────────────────────────────────── */}
      <div className="card" style={{ padding: 0, marginBottom: 16, overflow: "hidden" }}>
        <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16 }}>📈</span>
          <SectionTitle>{ticker} · PRICE CHART</SectionTitle>
          <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 4 }}>via TradingView</span>
        </div>
        <iframe
          src={`https://s.tradingview.com/widgetembed/?frameElementId=tv_${ticker}&symbol=IDX%3A${ticker}&interval=D&hidesidetoolbar=0&symboledit=0&saveimage=0&toolbarbg=161b22&theme=dark&style=1&timezone=Asia%2FJakarta&withdateranges=1&showpopupbutton=0&studies=%5B%5D&locale=id`}
          style={{ width: "100%", height: 380, border: "none", display: "block" }}
          allowTransparency scrolling="no" title={`${ticker} Price Chart`}
        />
      </div>

      {/* ── Row 3: Broker Trend Heatmap ──────────────────────────────────────── */}
      {heatmap && (
        <div className="card" style={{ padding: 20, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <SectionTitle>{ticker} BROKER TREND</SectionTitle>
            <div style={{ display: "flex", gap: 4 }}>
              {(["ALL","1W","1M","3M"] as const).map(tf => (
                <TabBtn key={tf} active={trendTf === tf} onClick={() => setTrendTf(tf)}>
                  {tf === "ALL" ? "ALL DAILY" : tf}
                </TabBtn>
              ))}
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 700 }}>
              <thead>
                <tr>
                  <th style={{ padding: "6px 10px", fontSize: 11, color: "var(--text-muted)", textAlign: "left", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>BROKER</th>
                  {filteredDates.map((d: string) => (
                    <th key={d} style={{ padding: "6px 6px", fontSize: 10, color: "var(--text-muted)", textAlign: "center", borderBottom: "1px solid var(--border)", minWidth: 52 }}>
                      {shortDate(d)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {heatmap.brokers.map((b: string) => (
                  <tr key={b}>
                    <td style={{ padding: "4px 10px", fontSize: 12, fontWeight: 800, color: "var(--text-primary)", fontFamily: "'Space Grotesk', sans-serif", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>
                      {b}
                    </td>
                    {filteredDates.map((d: string) => {
                      const val = heatmap.data[b]?.[d] || 0;
                      return (
                        <td key={d} style={{ padding: "5px 6px", textAlign: "center", fontSize: 10, fontWeight: 700, background: heatColor(val), color: val !== 0 ? "#ffffff" : "#8b949e", borderBottom: "1px solid var(--border)", borderRadius: 2 }}>
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

      {/* ── Row 4: BBCA BROKER TRACKER — Alpha-Beta Style ───────────────────── */}
      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <SectionTitle>{ticker} BROKER TRACKER</SectionTitle>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>ALL</span>
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>FOREIGN</span>
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>LOCAL</span>
            <button className="pill-btn" style={{ fontSize: 10, padding: "3px 12px" }}>REGULAR</button>
          </div>
        </div>

        {/* Date selectors */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          {/* Alpha */}
          <div style={{ background: "rgba(47,129,247,0.06)", border: "1px solid rgba(47,129,247,0.2)", borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "#58a6ff", letterSpacing: "0.08em", marginBottom: 8 }}>RANGE ALPHA (OLDER)</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ fontSize: 10, color: "var(--text-muted)" }}>FROM</label>
              <input type="date" value={alphaDate} onChange={e => setAlphaDate(e.target.value)}
                style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", cursor: "pointer" }} />
              <label style={{ fontSize: 10, color: "var(--text-muted)" }}>TO</label>
              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{alphaDate}</span>
            </div>
          </div>
          {/* Beta */}
          <div style={{ background: "rgba(248,81,73,0.06)", border: "1px solid rgba(248,81,73,0.2)", borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "#f85149", letterSpacing: "0.08em", marginBottom: 8 }}>RANGE BETA (NEWER)</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ fontSize: 10, color: "var(--text-muted)" }}>FROM</label>
              <input type="date" value={betaDate} onChange={e => setBetaDate(e.target.value)}
                style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", cursor: "pointer" }} />
              <label style={{ fontSize: 10, color: "var(--text-muted)" }}>TO</label>
              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{betaDate}</span>
            </div>
          </div>
        </div>

        {/* Alpha-Beta Broker Tables + Inventory Flow */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 220px", gap: 12 }}>

          {/* Alpha Table */}
          <div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th colSpan={4} style={{ fontSize: 10, fontWeight: 800, color: "#58a6ff", textAlign: "left", padding: "4px 6px", borderBottom: "1px solid var(--border)", letterSpacing: "0.06em" }}>
                    ▲ ALPHA BUYERS
                  </th>
                  <th colSpan={4} style={{ fontSize: 10, fontWeight: 800, color: "#8b949e", textAlign: "right", padding: "4px 6px", borderBottom: "1px solid var(--border)", letterSpacing: "0.06em" }}>
                    SELLERS ▼
                  </th>
                </tr>
                <tr>
                  {["BY","Net Val","Lot","Avg","SL","Net Val","Lot","Avg"].map((h, i) => (
                    <th key={i} style={{ padding: "3px 5px", fontSize: 9, color: "var(--text-muted)", textAlign: i < 2 ? "left" : "right", borderBottom: "1px solid var(--border)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: Math.max(alphaBuyers.length, alphaSellers.length) }).map((_, i) => {
                  const b = alphaBuyers[i];
                  const s = alphaSellers[i];
                  return (
                    <tr key={i} style={{ background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)" }}>
                      {b ? (<>
                        <td style={{ padding: "3px 5px", fontSize: 11, fontWeight: 900, color: "#3fb950", fontFamily: "'Space Grotesk',sans-serif" }}>{b.broker}</td>
                        <td style={{ padding: "3px 5px", fontSize: 10, color: "#3fb950", textAlign: "right" }}>{fmtVal(b.buyVal)}</td>
                        <td style={{ padding: "3px 5px", fontSize: 10, color: "#3fb950", textAlign: "right" }}>{fmtLot(b.buyLot)}</td>
                        <td style={{ padding: "3px 5px", fontSize: 10, color: "var(--text-muted)", textAlign: "right" }}>{b.buyAvg?.toLocaleString("id-ID")}</td>
                      </>) : <><td colSpan={4}/></>}
                      {s ? (<>
                        <td style={{ padding: "3px 5px", fontSize: 11, fontWeight: 900, color: "#f85149", fontFamily: "'Space Grotesk',sans-serif" }}>{s.broker}</td>
                        <td style={{ padding: "3px 5px", fontSize: 10, color: "#f85149", textAlign: "right" }}>{fmtVal(Math.abs(s.sellVal))}</td>
                        <td style={{ padding: "3px 5px", fontSize: 10, color: "#f85149", textAlign: "right" }}>{fmtLot(Math.abs(s.sellLot))}</td>
                        <td style={{ padding: "3px 5px", fontSize: 10, color: "var(--text-muted)", textAlign: "right" }}>{s.sellAvg?.toLocaleString("id-ID")}</td>
                      </>) : <><td colSpan={4}/></>}
                    </tr>
                  );
                })}
                {!rangeData && <tr><td colSpan={8} style={{ textAlign: "center", padding: 20, fontSize: 11, color: "var(--text-muted)" }}>Loading...</td></tr>}
              </tbody>
            </table>
          </div>

          {/* Beta Table */}
          <div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th colSpan={4} style={{ fontSize: 10, fontWeight: 800, color: "#f0883e", textAlign: "left", padding: "4px 6px", borderBottom: "1px solid var(--border)", letterSpacing: "0.06em" }}>
                    ▲ BETA BUYERS
                  </th>
                  <th colSpan={4} style={{ fontSize: 10, fontWeight: 800, color: "#8b949e", textAlign: "right", padding: "4px 6px", borderBottom: "1px solid var(--border)", letterSpacing: "0.06em" }}>
                    SELLERS ▼
                  </th>
                </tr>
                <tr>
                  {["BY","Net Val","Lot","Avg","SL","Net Val","Lot","Avg"].map((h, i) => (
                    <th key={i} style={{ padding: "3px 5px", fontSize: 9, color: "var(--text-muted)", textAlign: i < 2 ? "left" : "right", borderBottom: "1px solid var(--border)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: Math.max(betaBuyers.length, betaSellers.length) }).map((_, i) => {
                  const b = betaBuyers[i];
                  const s = betaSellers[i];
                  return (
                    <tr key={i} style={{ background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)" }}>
                      {b ? (<>
                        <td style={{ padding: "3px 5px", fontSize: 11, fontWeight: 900, color: "#3fb950", fontFamily: "'Space Grotesk',sans-serif" }}>{b.broker}</td>
                        <td style={{ padding: "3px 5px", fontSize: 10, color: "#3fb950", textAlign: "right" }}>{fmtVal(b.buyVal)}</td>
                        <td style={{ padding: "3px 5px", fontSize: 10, color: "#3fb950", textAlign: "right" }}>{fmtLot(b.buyLot)}</td>
                        <td style={{ padding: "3px 5px", fontSize: 10, color: "var(--text-muted)", textAlign: "right" }}>{b.buyAvg?.toLocaleString("id-ID")}</td>
                      </>) : <><td colSpan={4}/></>}
                      {s ? (<>
                        <td style={{ padding: "3px 5px", fontSize: 11, fontWeight: 900, color: "#f85149", fontFamily: "'Space Grotesk',sans-serif" }}>{s.broker}</td>
                        <td style={{ padding: "3px 5px", fontSize: 10, color: "#f85149", textAlign: "right" }}>{fmtVal(Math.abs(s.sellVal))}</td>
                        <td style={{ padding: "3px 5px", fontSize: 10, color: "#f85149", textAlign: "right" }}>{fmtLot(Math.abs(s.sellLot))}</td>
                        <td style={{ padding: "3px 5px", fontSize: 10, color: "var(--text-muted)", textAlign: "right" }}>{s.sellAvg?.toLocaleString("id-ID")}</td>
                      </>) : <><td colSpan={4}/></>}
                    </tr>
                  );
                })}
                {!rangeData && <tr><td colSpan={8} style={{ textAlign: "center", padding: 20, fontSize: 11, color: "var(--text-muted)" }}>Loading...</td></tr>}
              </tbody>
            </table>
          </div>

          {/* Inventory Flow */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-cyan)", letterSpacing: "0.06em", marginBottom: 8 }}>
              Inventory Flow
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["BROKER","ALPHA","BETA Δ","SIGNAL"].map(h => (
                    <th key={h} style={{ padding: "3px 5px", fontSize: 9, color: "var(--text-muted)", textAlign: "left", borderBottom: "1px solid var(--border)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {inventory.map((inv: any, i: number) => {
                  const isUp  = inv.betaDelta > 0;
                  const isExt = inv.betaDelta < 0;
                  const sigColor = isUp ? "#3fb950" : isExt ? "#f85149" : "var(--text-muted)";
                  return (
                    <tr key={i} style={{ background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)" }}>
                      <td style={{ padding: "4px 5px", fontSize: 11, fontWeight: 900, color: "var(--text-primary)", fontFamily: "'Space Grotesk',sans-serif" }}>{inv.broker}</td>
                      <td style={{ padding: "4px 5px", fontSize: 10, color: "var(--text-muted)", textAlign: "right" }}>{fmtLot(inv.alphaLot)}</td>
                      <td style={{ padding: "4px 5px", fontSize: 10, textAlign: "right", color: isUp ? "#3fb950" : "#f85149", fontWeight: 700 }}>
                        {inv.betaDelta > 0 ? "+" : ""}{fmtLot(inv.betaDelta)}
                      </td>
                      <td style={{ padding: "4px 5px", fontSize: 9, color: sigColor, fontWeight: 700 }}>{inv.signal}</td>
                    </tr>
                  );
                })}
                {inventory.length === 0 && (
                  <tr><td colSpan={4} style={{ textAlign: "center", padding: 20, fontSize: 11, color: "var(--text-muted)" }}>
                    {rangeData ? "No data" : "Loading..."}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── ANTIGRAVITY CHART ───────────────────────────────────────────────── */}
      {(() => {
        const agDaysMap: Record<string,number> = { "1M": 22, "3M": 66, "ALL": 9999 };
        const agCandles = (data.candlestick || []).slice(-agDaysMap[agChartDays]);
        const fibLevels = fibData?.levels || [];
        const lunarInRange = lunarData.filter(e =>
          agCandles.some((c: any) => c.date >= e.dateStr) && agCandles.some((c: any) => c.date <= e.dateStr) ||
          agCandles.some((c: any) => c.date === e.dateStr)
        );
        const prices = agCandles.map((c: any) => c.close).filter(Boolean);
        const pMin = prices.length ? Math.min(...prices) * 0.99 : 0;
        const pMax = prices.length ? Math.max(...prices) * 1.01 : 1;

        return (
          <div style={{ padding: 20, marginBottom: 16, background: "#0d1117", borderRadius: 12, border: "1px solid rgba(247,201,72,0.2)" }}>
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 16 }}>✨</span>
                  <h3 style={{ fontSize: 13, fontWeight: 800, color: "#f7c948", letterSpacing: "0.08em", margin: 0, fontFamily: "'Space Grotesk', sans-serif" }}>ANTIGRAVITY CHART</h3>
                  {fibData?.method && (
                    <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 10, background: "rgba(247,201,72,0.08)", color: "#f7c948aa", border: "1px solid rgba(247,201,72,0.2)" }}>
                      {fibData.method === 'pivot' ? '⬆ PIVOT' : '▦ ABS'}
                    </span>
                  )}
                </div>
                <p style={{ fontSize: 11, color: "#484f58", margin: "3px 0 0" }}>Auto-Fibonacci · Lunar Astro Timing</p>
              </div>
              <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                {(["1M","3M","ALL"] as const).map(tf => (
                  <TabBtn key={tf} active={agChartDays === tf} onClick={() => setAgChartDays(tf)}>{tf}</TabBtn>
                ))}
                <div style={{ width: 1, height: 14, background: "#21262d", margin: "0 2px" }} />
                <button onClick={() => setShowFib(p => !p)} style={{
                  fontSize: 10, padding: "3px 10px", borderRadius: 4, cursor: "pointer", fontWeight: 700,
                  background: showFib ? "rgba(247,201,72,0.12)" : "transparent",
                  color: showFib ? "#f7c948" : "#484f58",
                  border: `1px solid ${showFib ? "rgba(247,201,72,0.35)" : "#21262d"}`,
                }}>FIB</button>
                {showFib && (
                  <select value={fibLookback} onChange={e => setFibLookback(Number(e.target.value))} style={{
                    fontSize: 10, padding: "3px 6px", borderRadius: 4, border: "1px solid #21262d",
                    background: "#161b22", color: "#8b949e", cursor: "pointer",
                  }}>
                    <option value={30}>30d</option><option value={60}>60d</option>
                    <option value={90}>90d</option><option value={120}>120d</option>
                  </select>
                )}
                <button onClick={() => setShowLunar(p => !p)} style={{
                  fontSize: 10, padding: "3px 10px", borderRadius: 4, cursor: "pointer", fontWeight: 700,
                  background: showLunar ? "rgba(78,201,176,0.12)" : "transparent",
                  color: showLunar ? "#4ec9b0" : "#484f58",
                  border: `1px solid ${showLunar ? "rgba(78,201,176,0.35)" : "#21262d"}`,
                }}>🌙 LUNAR</button>
              </div>
            </div>

            {/* Lunar pills */}
            {showLunar && lunarInRange.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                {lunarInRange.map((ev: any, i: number) => (
                        strokeDasharray={lv.dash ? "5 3" : undefined} strokeOpacity={0.75}
                        label={{ value: lv.label, position: 'insideTopRight', fontSize: 9, fill: lv.color }}
                      />
                    ) : null
                  ))}

                  {/* Lunar vertical markers */}
                  {showLunar && lunarInRange.map((ev: any, i: number) => (
                    <ReferenceLine
                      key={i} x={ev.dateStr}
                      stroke={ev.type === 'full_moon' ? '#f7c948' : '#6e7681'}
                      strokeWidth={1} strokeDasharray="3 3" strokeOpacity={0.6}
                      label={{ value: ev.emoji, position: 'top', fontSize: 11 }}
                    />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ height: 100, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12 }}>
                No candlestick data available
              </div>
            )}

            {/* Swing High/Low info */}
            {fibData && (
              <div style={{ display: "flex", gap: 16, marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                  Swing <span style={{ color: "#3fb950", fontWeight: 700 }}>HIGH</span>:
                  <span style={{ color: "#3fb950", fontWeight: 900, marginLeft: 4 }}>
                    Rp {fibData.swingHigh?.price?.toLocaleString('id-ID')}
                  </span>
                  <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>@ {fibData.swingHigh?.time}</span>
                </div>
                <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                  Swing <span style={{ color: "#f85149", fontWeight: 700 }}>LOW</span>:
                  <span style={{ color: "#f85149", fontWeight: 900, marginLeft: 4 }}>
                    Rp {fibData.swingLow?.price?.toLocaleString('id-ID')}
                  </span>
                  <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>@ {fibData.swingLow?.time}</span>
                </div>
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: "auto" }}>
                  Trend: <span style={{ fontWeight: 700, color: fibData.direction === 'uptrend' ? '#3fb950' : '#f85149' }}>
                    {fibData.direction === 'uptrend' ? '▲ UPTREND' : '▼ DOWNTREND'}
                  </span>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Row 5: Data Quality Summary ──────────────────────────────────────── */}
      <div className="card" style={{ padding: 16, marginBottom: 8, background: "rgba(47,129,247,0.04)", borderColor: "rgba(47,129,247,0.2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent-green)", display: "inline-block" }} />
            <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600, letterSpacing: "0.06em" }}>SOURCE: DATABASE (VPS)</span>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>📅 Range: <strong style={{ color: "var(--text-secondary)" }}>{data.dataRange?.from} → {data.dataRange?.to}</strong></div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>🏦 Brokers: <strong style={{ color: "var(--accent-cyan)" }}>{data.brokerCodes?.length}</strong></div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>📊 Days: <strong style={{ color: "var(--accent-cyan)" }}>{data.dataRange?.days}</strong></div>
        </div>
      </div>

    </div>
  );
}
