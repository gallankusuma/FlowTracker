"use client";
import { useState, useEffect, useCallback } from "react";
import { API_BASE } from "@/lib/apiConfig";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area,
  ComposedChart, LineChart, Line, CartesianGrid, Cell, ReferenceLine, ReferenceDot, Brush,
} from "recharts";

// â”€â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const BK_COLORS = [
  "#2f81f7","#39d2f5","#f0883e","#a5d6ff","#d2a8ff",
  "#ffa198","#7ee787","#ff7b72","#79c0ff","#e3b341",
  "#bc8cff","#56d364","#58a6ff","#f78166","#3fb950",
];

// Planetary events 2024-2027 (astronomically accurate)
const PLANETARY_EVENTS = [
  // Mercury Retrograde periods — ☿ orange
  { type:"mercury_rx", start:"2024-04-01", end:"2024-04-25", emoji:"☿", label:"Mercury Rx", color:"#f0883e" },
  { type:"mercury_rx", start:"2024-08-05", end:"2024-08-28", emoji:"☿", label:"Mercury Rx", color:"#f0883e" },
  { type:"mercury_rx", start:"2024-11-26", end:"2024-12-15", emoji:"☿", label:"Mercury Rx", color:"#f0883e" },
  { type:"mercury_rx", start:"2025-03-15", end:"2025-04-07", emoji:"☿", label:"Mercury Rx", color:"#f0883e" },
  { type:"mercury_rx", start:"2025-07-18", end:"2025-08-11", emoji:"☿", label:"Mercury Rx", color:"#f0883e" },
  { type:"mercury_rx", start:"2025-11-09", end:"2025-11-29", emoji:"☿", label:"Mercury Rx", color:"#f0883e" },
  { type:"mercury_rx", start:"2026-02-25", end:"2026-03-20", emoji:"☿", label:"Mercury Rx", color:"#f0883e" },
  { type:"mercury_rx", start:"2026-06-29", end:"2026-07-23", emoji:"☿", label:"Mercury Rx", color:"#f0883e" },
  { type:"mercury_rx", start:"2026-10-23", end:"2026-11-12", emoji:"☿", label:"Mercury Rx", color:"#f0883e" },
  // Saturn Retrograde — ♄ cyan
  { type:"saturn_rx", start:"2024-06-29", end:"2024-11-15", emoji:"♄", label:"Saturn Rx", color:"#39d2f5" },
  { type:"saturn_rx", start:"2025-07-13", end:"2025-11-28", emoji:"♄", label:"Saturn Rx", color:"#39d2f5" },
  { type:"saturn_rx", start:"2026-07-25", end:"2026-12-10", emoji:"♄", label:"Saturn Rx", color:"#39d2f5" },
  // Jupiter sign ingress — ♃ purple
  { type:"jupiter_ingress", start:"2024-05-26", end:"2024-05-26", emoji:"♃", label:"Jupiter→Gemini", color:"#bc8cff" },
  { type:"jupiter_ingress", start:"2025-06-09", end:"2025-06-09", emoji:"♃", label:"Jupiter→Cancer", color:"#bc8cff" },
  { type:"jupiter_ingress", start:"2026-06-30", end:"2026-06-30", emoji:"♃", label:"Jupiter→Leo",    color:"#bc8cff" },
];

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Subcomponents â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Props â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface TickerDetailProps {
  ticker: string;
  onClose: () => void;
}

// â”€â”€â”€ Main Component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function TickerDetail({ ticker, onClose }: TickerDetailProps) {
  const [data, setData]           = useState<any>(null);
  const [loading, setLoading]     = useState(true);
  const [rangeData, setRangeData] = useState<any>(null);
  const [motionTf, setMotionTf]   = useState<"1W"|"1M"|"3M"|"6M"|"ALL">("3M");
  const [activeBks, setActiveBks] = useState<string[]>([]);
  const [trendTf, setTrendTf]     = useState<"ALL"|"1W"|"1M"|"3M">("ALL");
  const [alphaDate, setAlphaDate] = useState("");
  const [betaDate, setBetaDate]   = useState("");
  const [showPrice, setShowPrice] = useState(true);
  const [fibData, setFibData]     = useState<any>(null);
  const [lunarData, setLunarData] = useState<any[]>([]);
  const [showFib, setShowFib]         = useState(true);
  const [showLunar, setShowLunar]     = useState(true);
  const [showVolume, setShowVolume]   = useState(true);
  const [showSR, setShowSR]           = useState(true);
  const [showExtensions, setShowExtensions] = useState(true);
  const [brushRange, setBrushRange]   = useState<{startIndex:number,endIndex:number}|null>(null);
  const [showPlanets, setShowPlanets] = useState(true);
  const [fibLookback, setFibLookback] = useState(60);
  const [agChartDays, setAgChartDays] = useState<"1M"|"3M"|"ALL">("3M");
  const [yahooCandles, setYahooCandles] = useState<any[]>([]);
  const [yahooLoading, setYahooLoading] = useState(false);
  const [hoveredCell, setHoveredCell] = useState<{broker:string,date:string,val:number,lot:number,x:number,y:number}|null>(null);

  // Map motionTf → API query params (calendar-based for 1M/3M/6M)
  const getTfParams = (tf: string): string => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

    // Safe month subtraction: clamp day to last day of target month
    // Avoids JS overflow (e.g. May 31 - 1M = April 31 → May 1 is WRONG, should be April 30)
    const subtractMonths = (months: number): string => {
      const now = new Date();
      const day = now.getDate();
      const targetMonth = now.getMonth() - months;
      // Normalize to valid year/month
      const targetYear  = now.getFullYear() + Math.floor(targetMonth / 12);
      const normMonth   = ((targetMonth % 12) + 12) % 12;
      // Last day of target month
      const lastDay = new Date(targetYear, normMonth + 1, 0).getDate();
      return fmt(new Date(targetYear, normMonth, Math.min(day, lastDay)));
    };

    switch(tf) {
      case '1W':  return 'days=5';
      case '1M':  return `fromDate=${subtractMonths(1)}`;   // e.g. Apr 29/30
      case '3M':  return `fromDate=${subtractMonths(3)}`;   // e.g. Feb 28 → Mar 02
      case '6M':  return `fromDate=${subtractMonths(6)}`;   // e.g. Nov 29/30
      case 'ALL': return 'days=250';
      default:    return 'days=65';
    }
  };

  // Fetch main detail data — re-fires when ticker OR time range changes
  useEffect(() => {
    setLoading(true); setData(null); setRangeData(null);
    const tfParams = getTfParams(motionTf);
    fetch(`${API_BASE}/api/ticker-detail?ticker=${ticker}&${tfParams}&flowDays=10`)
      .then(r => r.json())
      .then(json => {
        if (!json.error) {
          setData(json);
          setActiveBks((json.brokerCodes || []).slice(0, 8));
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
  }, [ticker, motionTf]);

  // Fetch broker range data when alpha/beta dates change
  const fetchRange = useCallback(() => {
    if (!alphaDate || !betaDate) return;
    fetch(`${API_BASE}/api/broker-range?ticker=${ticker}&alphaDate=${alphaDate}&betaDate=${betaDate}`)
      .then(r => r.json())
      .then(json => { if (!json.error) setRangeData(json); })
      .catch(() => {});
  }, [ticker, alphaDate, betaDate]);

  useEffect(() => { fetchRange(); }, [fetchRange]);

  // Fetch Yahoo Finance candles
  useEffect(() => {
    if (!ticker) return;
    const rangeMap: Record<string,string> = { "1M": "1mo", "3M": "3mo", "ALL": "1y" };
    const yfRange = rangeMap[agChartDays] || '3mo';
    setYahooLoading(true);
    fetch(`${API_BASE}/api/yahoo-candles?ticker=${ticker}&range=${yfRange}`)
      .then(r => r.json())
      .then(json => { if (json.candles) setYahooCandles(json.candles); })
      .catch(() => {})
      .finally(() => setYahooLoading(false));
  }, [ticker, agChartDays]);

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
      <div style={{ fontSize: 24, marginBottom: 12 }}>â³</div>
      Loading {ticker} detail...
    </div>
  );

  if (!data) return (
    <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>
      <div style={{ fontSize: 24, marginBottom: 12 }}>ðŸ“­</div>
      No data available for {ticker}
    </div>
  );

  const {
    fundSummary   = [] as any[],
    brokerAction  = [] as any[],
    heatmap,
    brokerTracker = [] as any[],
    brokerCodes   = [] as string[],
    flowSummary   = [] as any[],
  } = data;

  // Use backend-classified flowSummary (foreign / retail / bigMoney per day)
  const foreignFlow  = flowSummary.map((fs: any) => ({ date: fs.date, val: fs.foreign  || 0 }));
  const bigMoneyFlow = flowSummary.map((fs: any) => ({ date: fs.date, val: fs.bigMoney || 0 }));
  const riletFlow    = flowSummary.map((fs: any) => ({ date: fs.date, val: fs.retail   || 0 }));
  let cumNet = 0;
  const netFlow = fundSummary.map((fs: any) => {
    cumNet += fs.net || 0;
    return { date: fs.date, val: cumNet };
  });

  // â”€â”€ Broker Motion â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const tfDaysMap: Record<string, number> = { "1W": 5, "1M": 23, "3M": 66, "6M": 132, "ALL": 9999 }; // approximate, data.dates.length used for precise slice
  // ── Flow Summary analytics ───────────────────────────────────────────────
  const sumForeign  = foreignFlow.reduce((s: number, d: any) => s + d.val, 0);
  const sumRitel    = riletFlow.reduce((s: number, d: any) => s + d.val, 0);
  const sumBigMoney = bigMoneyFlow.reduce((s: number, d: any) => s + d.val, 0);
  // Cumulative overlays
  let cumF = 0, cumR = 0, cumB = 0;
  const foreignCum  = foreignFlow.map((d: any) => { cumF += d.val; return { date: d.date, val: d.val, cum: cumF }; });
  const riletCum    = riletFlow.map((d: any)   => { cumR += d.val; return { date: d.date, val: d.val, cum: cumR }; });
  const bigMoneyCum = bigMoneyFlow.map((d: any) => { cumB += d.val; return { date: d.date, val: d.val, cum: cumB }; });
  // Streak helper
  const calcStreak = (arr: any[]): number => {
    if (!arr.length) return 0;
    const lastPos = arr[arr.length - 1].val >= 0;
    let count = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
      if ((arr[i].val >= 0) === lastPos) count++; else break;
    }
    return lastPos ? count : -count;
  };
  const streakF = calcStreak(foreignFlow);
  const streakR = calcStreak(riletFlow);
  const streakB = calcStreak(bigMoneyFlow);
  // Smart money signal
  const bigMoneyDir  = sumBigMoney >= 0 ? 1 : -1;
  const foreignDir   = sumForeign  >= 0 ? 1 : -1;
  const isDivergence = bigMoneyDir !== foreignDir;
  const flowSignal   = isDivergence
    ? (bigMoneyDir > 0 ? 'ACCUMULATION' : 'DISTRIBUTION')
    : (bigMoneyDir > 0 ? 'BULLISH' : 'BEARISH');
  const flowSignalColor = flowSignal === 'ACCUMULATION' ? '#3fb950'
    : flowSignal === 'DISTRIBUTION' ? '#f85149'
    : flowSignal === 'BULLISH' ? '#58a6ff' : '#e3b341';
  const motionData = brokerAction; // already filtered by fetch days

  // Broker Trend heatmap
  const heatDaysMap: Record<string, number> = { "ALL": 9999, "1W": 7, "1M": 20, "3M": 60 };
  const filteredDates: string[] = heatmap?.dates?.slice(-heatDaysMap[trendTf]) || [];

  // Alpha-Beta broker tables
  const alphaBuyers  = (rangeData?.alpha || []).filter((b: any) => b.netVal > 0).slice(0, 12);
  const alphaSellers = (rangeData?.alpha || []).filter((b: any) => b.netVal < 0).slice(0, 12);
  const betaBuyers   = (rangeData?.beta  || []).filter((b: any) => b.netVal > 0).slice(0, 12);
  const betaSellers  = (rangeData?.beta  || []).filter((b: any) => b.netVal < 0).slice(0, 12);
  const inventory    = (rangeData?.inventory || []).slice(0, 15);

  return (
    <div style={{ padding: "0 20px 24px", fontFamily: "Inter, Space Grotesk, sans-serif" }}>

      {/* ── PAGE HEADER ─────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "20px 0 18px", borderBottom: "1px solid #21262d", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 4, height: 28, background: "#388bfd", borderRadius: 3 }} />
          <div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#e6edf3", letterSpacing: "0.01em" }}>{ticker}</div>
            <div style={{ display: "flex", gap: 16, marginTop: 2, fontSize: 11, color: "#484f58" }}>
              <span>From {data.dataRange?.from}</span>
              <span>To {data.dataRange?.to}</span>
              <span>{data.dataRange?.days} days</span>
              <span>{data.brokerCodes?.length} brokers</span>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {data.price && (
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 20, fontWeight: 900, color: "#e6edf3" }}>Rp {Number(data.price).toLocaleString("id-ID")}</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: (data.change || 0) >= 0 ? "#3fb950" : "#f85149" }}>
                {(data.change || 0) >= 0 ? "+" : ""}{data.change?.toFixed(2)}%
              </div>
            </div>
          )}
          <button onClick={onClose} style={{
            fontSize: 11, fontWeight: 700, padding: "7px 18px", borderRadius: 8, cursor: "pointer",
            background: "transparent", color: "#6e7681", border: "1px solid #30363d",
            letterSpacing: "0.06em",
          }}>CLOSE ANALYSIS</button>
        </div>
      </div>

      {/* ROW 1: FLOW SUMMARY + BROKER ACTION */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.6fr", gap: 16, marginBottom: 16 }}>

        {/* ── FLOW SUMMARY ─────────────────────────────────────────────────── */}
        <div style={{ background: "#0d1117", borderRadius: 14, border: "1px solid #21262d", padding: 20 }}>

          {/* Header + Signal */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#e6edf3", letterSpacing: "0.06em" }}>FLOW SUMMARY</div>
              <div style={{ fontSize: 10, color: "#484f58", marginTop: 2 }}>HISTORICAL FLOW MATRIX (LAST 10 DAYS)</div>
            </div>
            {flowSummary.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                <div style={{
                  fontSize: 10, fontWeight: 800, padding: "3px 10px", borderRadius: 20,
                  background: flowSignalColor + "22", color: flowSignalColor,
                  border: `1px solid ${flowSignalColor}44`, letterSpacing: "0.1em",
                }}>
                  {isDivergence ? "⚡ " : ""}{flowSignal}
                </div>
                {isDivergence && (
                  <div style={{ fontSize: 9, color: "#484f58" }}>
                    BigMoney {bigMoneyDir > 0 ? "BELI" : "JUAL"} vs Foreign {foreignDir > 0 ? "BELI" : "JUAL"}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Period Net Summary Row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 14 }}>
            {[
              { label: "FOREIGN",   sum: sumForeign,  streak: streakF, color: "#a371f7" },
              { label: "RITEL",     sum: sumRitel,    streak: streakR, color: "#f0883e" },
              { label: "BIG MONEY", sum: sumBigMoney, streak: streakB, color: "#58a6ff" },
            ].map(({ label, sum, streak, color }) => (
              <div key={label} style={{
                background: "rgba(255,255,255,0.03)", borderRadius: 8,
                border: `1px solid ${sum >= 0 ? "rgba(63,185,80,0.2)" : "rgba(248,81,73,0.2)"}`,
                padding: "7px 10px",
              }}>
                <div style={{ fontSize: 8, fontWeight: 800, color, letterSpacing: "0.08em", marginBottom: 3 }}>{label}</div>
                <div style={{ fontSize: 12, fontWeight: 900, color: sum >= 0 ? "#3fb950" : "#f85149" }}>
                  {sum >= 0 ? "+" : ""}{fmtVal(sum)}
                </div>
                <div style={{ fontSize: 9, color: "#484f58", marginTop: 2 }}>
                  {streak > 0 ? `▲ ${streak}d buy` : streak < 0 ? `▼ ${Math.abs(streak)}d sell` : "neutral"}
                </div>
              </div>
            ))}
          </div>

          {/* Charts with cumulative overlay */}
          {[
            { label: "FOREIGN FLOW",   cumData: foreignCum,  color: "#a371f7", negColor: "#6e30c4", cumColor: "#d2a8ff" },
            { label: "RITEL FLOW",     cumData: riletCum,    color: "#f0883e", negColor: "#c06020", cumColor: "#ffa657" },
            { label: "BIG MONEY FLOW", cumData: bigMoneyCum, color: "#58a6ff", negColor: "#f85149", cumColor: "#79c0ff" },
          ].map(({ label, cumData, color, negColor, cumColor }) => {
            // Dynamic bar width: fill ~65% of each column
            const dynBar = Math.max(14, Math.min(30, Math.round(320 / Math.max(cumData.length, 1) * 0.65)));

            // Dynamic Y-axis domain: based on bar (val) values only, ignore cumulative line
            // Take last 10 visible bars
            const visibleVals = cumData.slice(-10).map((d: any) => Number(d.val) || 0);
            const barAbsMax   = Math.max(...visibleVals.map(Math.abs), 1);
            const barMin      = Math.min(...visibleVals);
            const barPad      = barAbsMax * 0.12;  // 12% headroom
            const yBarMax     = barAbsMax + barPad;
            const yBarMin     = barMin < 0 ? -(barAbsMax + barPad) : 0;
            const yBarDomain: [number, number] = [yBarMin, yBarMax];

            return (
            <div key={label} style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <div style={{ fontSize: 10, fontWeight: 800, color, letterSpacing: "0.08em" }}>■ {label}</div>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />
              </div>
              <ResponsiveContainer width="100%" height={160}>
                <ComposedChart data={cumData} margin={{ top: 4, right: 12, bottom: 0, left: 38 }}>
                  <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 9, fill: "#6e7681" }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={(v: number) => fmtVal(Number(v))} tick={{ fontSize: 9, fill: "#6e7681" }} axisLine={false} tickLine={false} width={36} yAxisId="bar" domain={yBarDomain} allowDataOverflow={false} />
                  <YAxis yAxisId="line" orientation="right" hide />
                  <ReferenceLine yAxisId="bar" y={0} stroke="#30363d" strokeWidth={1} />
                  <Tooltip
                    cursor={{ fill: "rgba(255,255,255,0.04)" }}
                    content={({ active, payload, label: lbl }: any) => {
                      if (!active || !payload?.length) return null;
                      const daily = payload.find((p: any) => p.dataKey === 'val');
                      const cum   = payload.find((p: any) => p.dataKey === 'cum');
                      return (
                        <div style={{ background: "#161b22", border: `1px solid ${color}55`, borderRadius: 8, padding: "8px 12px", fontSize: 11 }}>
                          <div style={{ color: "#8b949e", marginBottom: 5, fontWeight: 700 }}>{lbl}</div>
                          {daily && <div style={{ color: Number(daily.value) >= 0 ? color : negColor, fontWeight: 800 }}>
                            Daily: {fmtVal(Number(daily.value))}
                          </div>}
                          {cum && <div style={{ color: cumColor, marginTop: 3, fontWeight: 600 }}>
                            Cumulative: {fmtVal(Number(cum.value))}
                          </div>}
                        </div>
                      );
                    }}
                  />
                  <Bar yAxisId="bar" dataKey="val" barSize={dynBar} radius={[3,3,0,0]}>
                    {cumData.map((d: any, i: number) => <Cell key={i} fill={d.val >= 0 ? color : negColor} />)}
                  </Bar>
                  <Line yAxisId="line" type="monotone" dataKey="cum" stroke={cumColor} strokeWidth={2}
                    dot={false} name="cum" strokeDasharray="0" opacity={0.7} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          );
          })}
        </div>

        {/* ── BROKER ACTION ─────────────────────────────────────────────────── */}
        <div style={{ background: "#0d1117", borderRadius: 14, border: "1px solid #21262d", padding: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#e6edf3", letterSpacing: "0.06em" }}>BROKER ACTION</div>
              <div style={{ fontSize: 10, color: "#484f58", marginTop: 2 }}>Cumulative net flow per broker</div>
            </div>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              {(["1W","1M","3M","6M","ALL"] as const).map(tf => (
                <button key={tf} onClick={() => setMotionTf(tf)} style={{
                  fontSize: 10, padding: "3px 10px", borderRadius: 5, cursor: "pointer", fontWeight: 700, border: "none",
                  background: motionTf === tf ? "#e6edf3" : "rgba(255,255,255,0.06)",
                  color: motionTf === tf ? "#0d1117" : "#6e7681",
                }}>{tf}</button>
              ))}
              <button onClick={() => setShowPrice(p => !p)} style={{
                fontSize: 10, padding: "3px 10px", borderRadius: 5, cursor: "pointer", fontWeight: 700,
                background: showPrice ? "rgba(227,179,65,0.15)" : "rgba(255,255,255,0.06)",
                color: showPrice ? "#e3b341" : "#6e7681",
                border: `1px solid ${showPrice ? "#e3b341" : "transparent"}`, marginLeft: 4,
              }}>PRICE</button>
            </div>
          </div>

          {/* Broker pills */}
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
            {brokerCodes.slice(0, 12).map((bk: string, i: number) => {
              const color = BK_COLORS[i % BK_COLORS.length];
              const active = activeBks.includes(bk);
              return (
                <button key={bk} onClick={() => setActiveBks(prev => prev.includes(bk) ? prev.filter(b => b !== bk) : [...prev, bk])} style={{
                  fontSize: 10, padding: "3px 10px", borderRadius: 20, cursor: "pointer", fontWeight: 700,
                  background: active ? color + "20" : "transparent",
                  border: `1.5px solid ${active ? color : "#30363d"}`,
                  color: active ? color : "#484f58",
                  display: "flex", alignItems: "center", gap: 5,
                }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: active ? color : "#30363d", display: "inline-block" }} />
                  {bk}
                </button>
              );
            })}
          </div>

          {/* Main chart */}
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={motionData} margin={{ top: 4, right: 56, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(48,54,61,0.6)" vertical={false} />
              <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 9, fill: "#484f58" }} axisLine={false} tickLine={false} />
              <YAxis yAxisId="flow" tickFormatter={(v: number) => { const a=Math.abs(v); return a>=1e6?`${(v/1e6).toFixed(1)}M`:a>=1e3?`${(v/1e3).toFixed(0)}K`:String(Math.round(v)); }} tick={{ fontSize: 9, fill: "#484f58" }} width={48} axisLine={false} tickLine={false} />
              <YAxis yAxisId="price" orientation="right" tick={{ fontSize: 9, fill: "#e3b341" }}
                tickFormatter={(v: number) => v.toLocaleString('id-ID')} width={52} axisLine={false} tickLine={false} domain={['auto','auto']} />
              <ReferenceLine yAxisId="flow" y={0} stroke="#484f58" strokeWidth={1.5} />
              <Tooltip
                formatter={(v: any, name: any) => name === '__price__'
                  ? [`Rp ${Number(v).toLocaleString('id-ID')}`, 'Price']
                  : [Number(v)>=1e6?`${(Number(v)/1e6).toFixed(2)}M`:Number(v)>=1e3?`${(Number(v)/1e3).toFixed(1)}K`:`${Math.round(Number(v))}`, name]}
                labelFormatter={(l: any) => shortDate(String(l))}
                contentStyle={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 8, fontSize: 11 }} />
              {brokerCodes.filter((b: string) => activeBks.includes(b)).map((b: string) => {
                const idx = brokerCodes.indexOf(b);
                return <Line yAxisId="flow" key={b} type="monotone" dataKey={b}
                  stroke={BK_COLORS[idx % BK_COLORS.length]} strokeWidth={2.5} dot={false} name={b} />;
              })}
              {showPrice && (
                <Line yAxisId="price" type="monotone" dataKey="price" name="__price__"
                  stroke="#e3b341" strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls />
              )}
            </ComposedChart>
          </ResponsiveContainer>

          {/* Broker Stats Table */}
          {motionData.length > 0 && (() => {
            const last  = motionData[motionData.length - 1] || {};
            const prev  = motionData.length > 1 ? motionData[motionData.length - 2] : {};

            // ── brokerTracker lookup map ──────────────────────────────────
            const trackerMap: Record<string, any> = {};
            (data.brokerTracker || []).forEach((t: any) => { trackerMap[t.broker] = t; });

            // ── Reversal detection ────────────────────────────────────────
            // Compare direction in first half vs second half of motionData
            const half = Math.max(1, Math.floor(motionData.length / 2));
            const reversals: string[] = [];
            brokerCodes.forEach((bk: string) => {
              const firstHalfNet = motionData.slice(0, half).reduce((s: number, d: any) => {
                // net per day = cumulative diff between consecutive points
                return s + (Number(d[bk] || 0));
              }, 0);
              const secondHalfNet = motionData.slice(half).reduce((s: number, d: any) => {
                return s + (Number(d[bk] || 0));
              }, 0);
              const wasAccum = firstHalfNet > 0;
              const nowDistrib = secondHalfNet < 0;
              const wasDistrib = firstHalfNet < 0;
              const nowAccum = secondHalfNet > 0;
              if ((wasAccum && nowDistrib) || (wasDistrib && nowAccum)) {
                reversals.push(bk);
              }
            });

            // ── Top buyer / seller ranking (from brokerTracker) ───────────
            const allBrokers = data.brokerTracker || [];
            const topBuyers  = [...allBrokers].sort((a: any, b: any) => b.totalBuyLot - a.totalBuyLot).slice(0, 5);
            const topSellers = [...allBrokers].sort((a: any, b: any) => b.totalSellLot - a.totalSellLot).slice(0, 5);

            return (
              <div style={{ marginTop: 14, borderTop: "1px solid #21262d", paddingTop: 12 }}>

                {/* ── Reversal Alert ───────────────────────────────────── */}
                {reversals.length > 0 && (
                  <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8,
                    background: "rgba(210,160,0,0.08)", border: "1px solid rgba(210,160,0,0.3)" }}>
                    <div style={{ fontSize: 9, fontWeight: 800, color: "#e3b341", letterSpacing: "0.1em", marginBottom: 4 }}>
                      ⚠ REVERSAL ALERT
                    </div>
                    <div style={{ fontSize: 11, color: "#8b949e" }}>
                      Broker{reversals.length > 1 ? "s" : ""} <strong style={{ color: "#e3b341" }}>{reversals.join(", ")}</strong> detected direction flip in {motionTf} window
                    </div>
                  </div>
                )}

                {/* ── Broker Stats Cards ───────────────────────────────── */}
                <div style={{ fontSize: 9, fontWeight: 800, color: "#484f58", letterSpacing: "0.1em", marginBottom: 8 }}>
                  BROKER STATS — {motionTf} PERIOD
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))", gap: 6, marginBottom: 14 }}>
                  {activeBks.map((bk: string) => {
                    const idx      = brokerCodes.indexOf(bk);
                    const color    = BK_COLORS[idx % BK_COLORS.length];
                    const net      = Number(last[bk] || 0);
                    const netPrev  = Number(prev[bk] || 0);
                    const trend    = net - netPrev;
                    const isAccum  = net > 0;
                    const tracker  = trackerMap[bk] || {};
                    const buyLot   = tracker.totalBuyLot  || 0;
                    const sellLot  = tracker.totalSellLot || 0;
                    const totalLot = buyLot + sellLot;
                    const buyPct   = totalLot > 0 ? Math.round(buyLot / totalLot * 100) : 50;
                    const sellPct  = 100 - buyPct;
                    const pctChange = netPrev !== 0 ? ((net - netPrev) / Math.abs(netPrev) * 100) : 0;
                    const isReversal = reversals.includes(bk);
                    return (
                      <div key={bk} style={{
                        background: isAccum ? "rgba(63,185,80,0.05)" : "rgba(248,81,73,0.05)",
                        border: `1px solid ${isReversal ? "rgba(210,160,0,0.5)" : isAccum ? "rgba(63,185,80,0.2)" : "rgba(248,81,73,0.2)"}`,
                        borderRadius: 8, padding: "9px 11px",
                        boxShadow: isReversal ? "0 0 10px rgba(210,160,0,0.1)" : "none",
                      }}>
                        {/* Header */}
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                            <span style={{ fontSize: 12, fontWeight: 800, color }}>{bk}</span>
                            {isReversal && <span style={{ fontSize: 8, color: "#e3b341" }}>⚠</span>}
                          </div>
                          <span style={{ fontSize: 8, fontWeight: 700,
                            color: isAccum ? "#3fb950" : "#f85149",
                            background: isAccum ? "rgba(63,185,80,0.15)" : "rgba(248,81,73,0.15)",
                            padding: "1px 6px", borderRadius: 10 }}>
                            {isAccum ? "ACCUM" : "DISTRIB"}
                          </span>
                        </div>
                        {/* Net value */}
                        <div style={{ fontSize: 14, fontWeight: 900, color: isAccum ? "#3fb950" : "#f85149" }}>
                          {net >= 0 ? "+" : ""}{fmtVal(net)}
                        </div>
                        {/* % change + last day */}
                        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
                          <span style={{ fontSize: 9, color: pctChange >= 0 ? "#3fb950" : "#f85149" }}>
                            {pctChange >= 0 ? "▲" : "▼"} {Math.abs(pctChange).toFixed(0)}%
                          </span>
                          <span style={{ fontSize: 9, color: "#484f58" }}>
                            {trend >= 0 ? "▲" : "▼"} {fmtVal(Math.abs(trend))} yday
                          </span>
                        </div>
                        {/* Buy/Sell lot bar */}
                        {totalLot > 0 && (
                          <div style={{ marginTop: 6 }}>
                            <div style={{ display: "flex", borderRadius: 3, overflow: "hidden", height: 4 }}>
                              <div style={{ width: `${buyPct}%`, background: "#3fb950" }} />
                              <div style={{ width: `${sellPct}%`, background: "#f85149" }} />
                            </div>
                            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3, fontSize: 8, color: "#484f58" }}>
                              <span style={{ color: "#3fb950" }}>B {tracker.totalBuyFmt}</span>
                              <span style={{ color: "#f85149" }}>S {tracker.totalSellFmt}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* ── Top Buyer / Top Seller Ranking ──────────────────── */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
                  {/* Top Buyers */}
                  <div style={{ background: "rgba(63,185,80,0.04)", border: "1px solid rgba(63,185,80,0.15)", borderRadius: 8, padding: "10px 12px" }}>
                    <div style={{ fontSize: 9, fontWeight: 800, color: "#3fb950", letterSpacing: "0.1em", marginBottom: 8 }}>🟢 TOP BUYERS — {motionTf}</div>
                    {topBuyers.map((b: any, i: number) => {
                      const bIdx = brokerCodes.indexOf(b.broker);
                      const bColor = bIdx >= 0 ? BK_COLORS[bIdx % BK_COLORS.length] : "#8b949e";
                      const maxLot = topBuyers[0]?.totalBuyLot || 1;
                      const barW = Math.round(b.totalBuyLot / maxLot * 100);
                      return (
                        <div key={b.broker} style={{ marginBottom: 7 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                            <span style={{ fontSize: 10, fontWeight: 800, color: bColor }}>{i+1}. {b.broker}</span>
                            <span style={{ fontSize: 10, fontWeight: 700, color: "#3fb950" }}>{b.totalBuyFmt}</span>
                          </div>
                          <div style={{ height: 3, borderRadius: 2, background: "rgba(255,255,255,0.06)" }}>
                            <div style={{ height: "100%", width: `${barW}%`, background: "#3fb950", borderRadius: 2, opacity: 0.7 }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {/* Top Sellers */}
                  <div style={{ background: "rgba(248,81,73,0.04)", border: "1px solid rgba(248,81,73,0.15)", borderRadius: 8, padding: "10px 12px" }}>
                    <div style={{ fontSize: 9, fontWeight: 800, color: "#f85149", letterSpacing: "0.1em", marginBottom: 8 }}>🔴 TOP SELLERS — {motionTf}</div>
                    {topSellers.map((b: any, i: number) => {
                      const bIdx = brokerCodes.indexOf(b.broker);
                      const bColor = bIdx >= 0 ? BK_COLORS[bIdx % BK_COLORS.length] : "#8b949e";
                      const maxLot = topSellers[0]?.totalSellLot || 1;
                      const barW = Math.round(b.totalSellLot / maxLot * 100);
                      return (
                        <div key={b.broker} style={{ marginBottom: 7 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                            <span style={{ fontSize: 10, fontWeight: 800, color: bColor }}>{i+1}. {b.broker}</span>
                            <span style={{ fontSize: 10, fontWeight: 700, color: "#f85149" }}>{b.totalSellFmt}</span>
                          </div>
                          <div style={{ height: 3, borderRadius: 2, background: "rgba(255,255,255,0.06)" }}>
                            <div style={{ height: "100%", width: `${barW}%`, background: "#f85149", borderRadius: 2, opacity: 0.7 }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* ── Daily Buy vs Sell Stacked Bar (active brokers) ──── */}
                {activeBks.length > 0 && (
                  <div>
                    <div style={{ fontSize: 9, fontWeight: 800, color: "#484f58", letterSpacing: "0.1em", marginBottom: 8 }}>
                      DAILY BUY vs SELL — ACTIVE BROKERS
                    </div>
                    <ResponsiveContainer width="100%" height={120}>
                      <BarChart
                        data={motionData.map((d: any) => {
                          const row: any = { date: d.date };
                          activeBks.forEach((bk: string) => {
                            const tr = trackerMap[bk];
                            if (tr?.series) {
                              const dayData = tr.series.find((s: any) => s.date === d.date);
                              row[bk + '_net'] = dayData?.net || 0;
                            }
                          });
                          return row;
                        })}
                        margin={{ top: 2, right: 8, bottom: 0, left: 32 }}
                      >
                        <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 8, fill: "#484f58" }} axisLine={false} tickLine={false} />
                        <YAxis tickFormatter={(v: number) => { const a = Math.abs(v); return a >= 1e6 ? `${(v/1e6).toFixed(1)}M` : a >= 1e3 ? `${(v/1e3).toFixed(0)}K` : String(Math.round(v)); }} tick={{ fontSize: 8, fill: "#484f58" }} axisLine={false} tickLine={false} width={30} />
                        <ReferenceLine y={0} stroke="#30363d" strokeWidth={1} />
                        <Tooltip
                          contentStyle={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 8, fontSize: 10 }}
                          formatter={(v: any, name: any) => [fmtVal(Number(v)), String(name || '').replace('_net', '')]}
                          labelFormatter={(l: any) => shortDate(String(l))}
                        />
                        {activeBks.map((bk: string) => {
                          const idx = brokerCodes.indexOf(bk);
                          const color = BK_COLORS[idx % BK_COLORS.length];
                          return <Bar key={bk} dataKey={bk + '_net'} stackId="a" fill={color} opacity={0.8} name={bk} />;
                        })}
                      </BarChart>
                    </ResponsiveContainer>
                    <div style={{ display: "flex", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
                      {activeBks.map((bk: string) => {
                        const idx = brokerCodes.indexOf(bk);
                        const color = BK_COLORS[idx % BK_COLORS.length];
                        return (
                          <div key={bk} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, color: "#8b949e" }}>
                            <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
                            {bk}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {/* ── BROKER SUMMARY TABLE ─────────────────────────────────────────────── */}
      {brokerCodes.length > 0 && motionData.length > 0 && (() => {
        // Build direction map from brokerTracker
        const dirMap: Record<string, string> = {};
        (data.brokerTracker || []).forEach((t: any) => { dirMap[t.broker] = t.direction; });

        // Avg price broker paid (if net buyer) or sold at (if net seller), over the period
        const avgMap: Record<string, number | null> = {};
        (data.brokerTracker || []).forEach((t: any) => {
          avgMap[t.broker] = t.direction === 'ACCUM' ? t.avgBuyPrice : t.avgSellPrice;
        });

        // Format number Indonesian style: 1234567 → "1.234.567"
        const fmtID = (n: number) => {
          const abs = Math.abs(Math.round(n));
          const s = abs.toLocaleString('de-DE'); // uses . as thousands sep
          return (n < 0 ? '-' : '+') + s;
        };

        // Use ALL brokerCodes (not activeBks) so no broker is missed
        const visibleBrokers = brokerCodes.slice(0, 8);

        // Per-row sorted brokers: sort by that day's net lot (positive first)
        // This matches FT.id behavior where order changes per date
        const getSortedBrokersForRow = (row: any) => {
          return [...visibleBrokers].sort((a, b) => {
            const va = Number(row[a] || 0);
            const vb = Number(row[b] || 0);
            return vb - va; // descending: positive (buyers) first
          });
        };

        return (
          <div style={{ marginBottom: 16, background: "#0d1117", borderRadius: 14, border: "1px solid #21262d", overflow: "hidden" }}>
            {/* Header */}
            <div style={{ padding: "14px 20px 10px", borderBottom: "1px solid #21262d", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 4, height: 22, background: "linear-gradient(to bottom, #a371f7, #58a6ff)", borderRadius: 3 }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: "#e6edf3", letterSpacing: "0.04em" }}>BROKER SUMMARY</div>
                  <div style={{ fontSize: 10, color: "#484f58", marginTop: 1 }}>Cumulative net lot per broker · {motionTf} period · {motionData.length} trading days</div>
                </div>
              </div>
              <div style={{ fontSize: 10, color: "#484f58" }}>Unit: Lot</div>
            </div>

            {/* Table */}
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "rgba(255,255,255,0.03)" }}>
                    {/* Date col */}
                    <th style={{ padding: "10px 14px", textAlign: "left", color: "#484f58", fontWeight: 700, fontSize: 10, letterSpacing: "0.08em", borderBottom: "1px solid #21262d", whiteSpace: "nowrap", minWidth: 70 }}>DATE</th>
                    {/* Price col */}
                    <th style={{ padding: "10px 12px", textAlign: "right", color: "#e3b341", fontWeight: 700, fontSize: 10, letterSpacing: "0.08em", borderBottom: "1px solid #21262d", whiteSpace: "nowrap" }}>PRICE</th>
                    {/* Broker cols - sorted by last day net (matches FT.id default) */}
                    {(() => {
                      const lastRow = motionData[motionData.length - 1] || {};
                      const headerBrokers = [...visibleBrokers].sort((a, b) => Number(lastRow[b]||0) - Number(lastRow[a]||0));
                      return headerBrokers.map((bk: string) => {
                        const idx = brokerCodes.indexOf(bk);
                        const color = BK_COLORS[idx % BK_COLORS.length];
                        const dir = dirMap[bk];
                        const isAccum = dir === 'ACCUM';
                        const lastVal = Number(lastRow[bk] || 0);
                        return (
                          <th key={bk} style={{ padding: "8px 12px", textAlign: "right", borderBottom: "1px solid #21262d", whiteSpace: "nowrap" }}>
                            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                              <span style={{ fontSize: 12, fontWeight: 800, color }}>{bk}</span>
                              {dir && (
                                <span style={{
                                  fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 8,
                                  background: isAccum ? "rgba(63,185,80,0.15)" : "rgba(248,81,73,0.15)",
                                  color: isAccum ? "#3fb950" : "#f85149",
                                }}>{dir}</span>
                              )}
                              <span style={{ fontSize: 9, color: lastVal >= 0 ? "#3fb950" : "#f85149", fontWeight: 600 }}>
                                {fmtID(lastVal)}
                              </span>
                              {avgMap[bk] != null && (
                                <span style={{ fontSize: 8, color: "#8b949e", fontWeight: 500 }}>
                                  @{avgMap[bk]!.toLocaleString("id-ID")}
                                </span>
                              )}
                            </div>
                          </th>
                        );
                      });
                    })()}
                  </tr>
                </thead>
                <tbody>
                  {motionData.map((row: any, i: number) => {
                    const isLast = i === motionData.length - 1;
                    const bg = isLast ? "rgba(255,255,255,0.03)" : "transparent";
                    const shortD = row.date ? row.date.slice(5).replace('-', '/') : '';
                    // Sort brokers for this specific row by this day's net lot
                    const lastRow2 = motionData[motionData.length - 1] || {};
                    const rowBrokers = [...visibleBrokers].sort((a, b) => Number(lastRow2[b]||0) - Number(lastRow2[a]||0));
                    return (
                      <tr key={row.date} style={{
                        background: bg,
                        borderBottom: "1px solid rgba(255,255,255,0.04)",
                        transition: "background 0.15s",
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
                      onMouseLeave={e => (e.currentTarget.style.background = bg)}
                      >
                        {/* Date */}
                        <td style={{ padding: "9px 14px", color: isLast ? "#e6edf3" : "#8b949e", fontWeight: isLast ? 700 : 400, whiteSpace: "nowrap" }}>
                          {shortD}
                        </td>
                        {/* Price */}
                        <td style={{ padding: "9px 12px", textAlign: "right", color: "#e3b341", fontWeight: 600, whiteSpace: "nowrap" }}>
                          {row.price ? Number(row.price).toLocaleString('id-ID') : "—"}
                        </td>
                        {/* Net lot per broker - consistent column order (sorted by last day) */}
                        {rowBrokers.map((bk: string) => {
                          const val = Number(row[bk] || 0);
                          const isPos = val > 0;
                          const isZero = val === 0;
                          return (
                            <td key={bk} style={{
                              padding: "9px 12px", textAlign: "right",
                              color: isZero ? "#484f58" : isPos ? "#3fb950" : "#f85149",
                              fontWeight: isLast ? 700 : 500,
                              whiteSpace: "nowrap",
                              fontVariantNumeric: "tabular-nums",
                            }}>
                              {isZero ? "—" : fmtID(val)}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                  {/* Total row */}
                  {(() => {
                    const lastRow = motionData[motionData.length - 1] || {};
                    return (
                      <tr style={{ background: "rgba(255,255,255,0.05)", borderTop: "2px solid rgba(255,255,255,0.1)" }}>
                        <td style={{ padding: "10px 14px", color: "#e6edf3", fontWeight: 800, fontSize: 10, letterSpacing: "0.06em" }}>TOTAL</td>
                        <td style={{ padding: "10px 12px" }} />
                        {[...visibleBrokers].sort((a, b) => Number(lastRow[b]||0) - Number(lastRow[a]||0)).map((bk: string) => {
                          const val = Number(lastRow[bk] || 0);
                          const isPos = val > 0;
                          const isZero = val === 0;
                          const dir = dirMap[bk];
                          return (
                            <td key={bk} style={{
                              padding: "10px 12px", textAlign: "right",
                              color: isZero ? "#484f58" : isPos ? "#3fb950" : "#f85149",
                              fontWeight: 800, whiteSpace: "nowrap",
                            }}>
                              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                                <span>{isZero ? "—" : fmtID(val)}</span>
                                {!isZero && dir && (
                                  <span style={{
                                    fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 8,
                                    background: isPos ? "rgba(63,185,80,0.2)" : "rgba(248,81,73,0.2)",
                                    color: isPos ? "#3fb950" : "#f85149",
                                  }}>{isPos ? "▲ ACCUM" : "▼ DISTRIB"}</span>
                                )}
                                {!isZero && avgMap[bk] != null && (
                                  <span style={{ fontSize: 8, color: "#8b949e", fontWeight: 500 }}>
                                    Avg @{avgMap[bk]!.toLocaleString("id-ID")}
                                  </span>
                                )}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })()}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* TRADINGVIEW PRICE CHART */}
      <div style={{ marginBottom: 16, background: "#0d1117", borderRadius: 14, border: "1px solid #21262d", overflow: "hidden" }}>
        <div style={{ padding: "14px 20px 10px", borderBottom: "1px solid #21262d", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 4, height: 22, background: "#388bfd", borderRadius: 3 }} />
          <div style={{ fontSize: 13, fontWeight: 800, color: "#e6edf3", letterSpacing: "0.04em" }}>{ticker} · PRICE CHART</div>
          <span style={{ fontSize: 10, color: "#484f58", marginLeft: 4 }}>via TradingView</span>
        </div>
        {(() => {
          // Sync TradingView range with motionTf
          const tvRangeMap: Record<string, string> = {
            '1W': '5D',
            '1M': '1M',
            '3M': '3M',
            '6M': '6M',
            'ALL': '12M',
          };
          const tvRange = tvRangeMap[motionTf] || '3M';
          return (
        <iframe
          src={`https://s.tradingview.com/widgetembed/?frameElementId=tv_${ticker}_${tvRange}&symbol=IDX%3A${ticker}&interval=D&range=${tvRange}&hidesidetoolbar=0&symboledit=0&saveimage=0&toolbarbg=0d1117&theme=dark&style=1&timezone=Asia%2FJakarta&withdateranges=1&showpopupbutton=0&studies=%5B%5D&locale=id`}
          style={{ width: "100%", height: 420, border: "none", display: "block" }}
          allowTransparency
          title={`${ticker} Price Chart`}
        />
          );
        })()}
      </div>

      {/* BROKER TREND HEATMAP */}
      {heatmap && (() => {
        const heatSq = (val: number): string => {
          // val = net lot (buy_lot - sell_lot) / 100
          if (val >  50000) return "#2ea043";
          if (val >  10000) return "#3fb950";
          if (val >      0) return "#56d364";
          if (val < -50000) return "#da3633";
          if (val < -10000) return "#f85149";
          if (val <      0) return "#ff7b72";
          return "#21262d";
        };
        return (
          <div style={{ marginBottom: 16, background: "#0d1117", borderRadius: 14, border: "1px solid #21262d", overflow: "hidden" }}>
            {/* Header */}
            <div style={{ padding: "16px 24px 12px", borderBottom: "1px solid #21262d", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 4, height: 24, background: "#388bfd", borderRadius: 3 }} />
                  <span style={{ fontSize: 16, fontWeight: 900, color: "#e6edf3", letterSpacing: "0.02em" }}>{ticker} BROKER TREND</span>
                </div>
                <div style={{ fontSize: 10, color: "#484f58", marginTop: 3, marginLeft: 16 }}>KALENDER 30 HARI BURSA</div>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {(["ALL","1W","1M","3M"] as const).map(tf => (
                  <button key={tf} onClick={() => setTrendTf(tf)} style={{
                    fontSize: 11, padding: "5px 16px", borderRadius: 6, cursor: "pointer", fontWeight: 700, border: "none",
                    background: trendTf === tf ? "#388bfd" : "rgba(255,255,255,0.06)",
                    color: trendTf === tf ? "#fff" : "#6e7681",
                  }}>{tf === "ALL" ? "ALL DAILY" : tf}</button>
                ))}
                <div style={{ width: 1, height: 18, background: "#30363d", margin: "0 4px" }} />
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10 }}>
                  <span style={{ display:"flex", alignItems:"center", gap:5 }}>
                    <span style={{ width:12, height:12, borderRadius:3, background:"#3fb950", display:"inline-block" }} />
                    <span style={{ color:"#3fb950", fontWeight:700 }}>ACCUM</span>
                  </span>
                  <span style={{ display:"flex", alignItems:"center", gap:5 }}>
                    <span style={{ width:12, height:12, borderRadius:3, background:"#30363d", display:"inline-block" }} />
                    <span style={{ color:"#6e7681", fontWeight:700 }}>NEUT</span>
                  </span>
                  <span style={{ display:"flex", alignItems:"center", gap:5 }}>
                    <span style={{ width:12, height:12, borderRadius:3, background:"#f85149", display:"inline-block" }} />
                    <span style={{ color:"#f85149", fontWeight:700 }}>DIST</span>
                  </span>
                </div>
              </div>
            </div>

            {/* Heatmap Grid — full width, dynamic cell size */}
            <div style={{ padding: "12px 20px 16px", overflowX: "auto" }}>
              {/* Date header row */}
              <div style={{ display: "grid", gridTemplateColumns: `80px repeat(${filteredDates.length}, 1fr)`, gap: "3px", marginBottom: 3 }}>
                <div style={{ fontSize: 10, color: "#484f58", fontWeight: 700, letterSpacing: "0.08em", paddingBottom: 4, alignSelf: "end" }}>BROKER</div>
                {filteredDates.map((d: string) => (
                  <div key={d} style={{ fontSize: 8.5, color: "#484f58", textAlign: "center", fontWeight: 600, paddingBottom: 4, alignSelf: "end", lineHeight: 1.2 }}>
                    {shortDate(d)}
                  </div>
                ))}
              </div>
              {/* Broker rows */}
              {heatmap.brokers.map((b: string) => (
                <div key={b} style={{ display: "grid", gridTemplateColumns: `80px repeat(${filteredDates.length}, 1fr)`, gap: "3px", marginBottom: 3 }}>
                  <div style={{ fontSize: 12, fontWeight: 900, color: "#58a6ff", display: "flex", alignItems: "center", paddingRight: 8 }}>{b}</div>
                  {filteredDates.map((d: string) => {
                    const val: number = heatmap.data[b]?.[d] || 0;
                    const bg = heatSq(val);
                    const isEmpty = val === 0;
                    const absVal = Math.abs(val);
                    const label = absVal >= 1e9 ? `${(val/1e9).toFixed(1)}B`
                                : absVal >= 1e6 ? `${(val/1e6).toFixed(0)}M`
                                : absVal >= 1e3 ? `${(val/1e3).toFixed(0)}K`
                                : val !== 0 ? String(Math.round(val)) : "";
                    return (
                      <div
                        key={d}
                        onMouseEnter={e => {
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setHoveredCell({ broker: b, date: d, val, lot: 0, x: r.left, y: r.bottom + 6 });
                        }}
                        onMouseLeave={() => setHoveredCell(null)}
                        style={{
                          height: 26, borderRadius: 5, cursor: "default",
                          background: isEmpty ? "#161b22" : bg,
                          border: isEmpty ? "1px solid #21262d" : "none",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          overflow: "hidden",
                        }}
                      >
                        {!isEmpty && label && (
                          <span style={{
                            fontSize: filteredDates.length > 40 ? 7 : 8,
                            fontWeight: 800, color: "rgba(0,0,0,0.65)",
                            lineHeight: 1, userSelect: "none", letterSpacing: "-0.2px",
                          }}>{label}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* Hover Tooltip */}
            {hoveredCell && (
              <div style={{
                position: "fixed", left: hoveredCell.x, top: hoveredCell.y, zIndex: 9999,
                background: "#0d1117", border: "1px solid #388bfd", borderRadius: 10, padding: "10px 16px",
                pointerEvents: "none", boxShadow: "0 8px 30px rgba(0,0,0,0.5)", minWidth: 160,
              }}>
                <div style={{ fontSize: 10, color: "#6e7681", marginBottom: 4, fontWeight: 700 }}>{hoveredCell.date}</div>
                <div style={{ fontSize: 13, color: "#e6edf3", fontWeight: 900, marginBottom: 8 }}>BROKER {hoveredCell.broker}</div>
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 12px", fontSize: 11 }}>
                  <span style={{ color: "#6e7681" }}>NET VALUE</span>
                  <span style={{ color: hoveredCell.val >= 0 ? "#3fb950" : "#f85149", fontWeight: 700, textAlign: "right" }}>{fmtVal(hoveredCell.val)}</span>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* BROKER TRACKER */}
      <div style={{ marginBottom: 16, background: "#0d1117", borderRadius: 14, border: "1px solid #21262d", overflow: "hidden" }}>
        {/* Header */}
        <div style={{ padding: "18px 24px 14px", borderBottom: "1px solid #21262d", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 4, height: 24, background: "#388bfd", borderRadius: 3 }} />
            <span style={{ fontSize: 16, fontWeight: 900, color: "#e6edf3", letterSpacing: "0.02em", fontFamily: "inherit" }}>{ticker} BROKER TRACKER</span>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button style={{ fontSize: 11, padding: "5px 16px", borderRadius: 7, background: "#e6edf3", color: "#0d1117", border: "none", fontWeight: 800, cursor: "pointer" }}>ALL</button>
            <button style={{ fontSize: 11, padding: "5px 16px", borderRadius: 7, background: "transparent", color: "#8b949e", border: "1px solid #30363d", cursor: "pointer" }}>FOREIGN</button>
            <button style={{ fontSize: 11, padding: "5px 16px", borderRadius: 7, background: "transparent", color: "#8b949e", border: "1px solid #30363d", cursor: "pointer" }}>LOCAL</button>
            <div style={{ width: 1, height: 20, background: "#30363d", margin: "0 2px" }} />
            <button style={{ fontSize: 11, padding: "5px 16px", borderRadius: 7, background: "#388bfd", color: "#fff", border: "none", fontWeight: 700, cursor: "pointer" }}>REGULAR</button>
          </div>
        </div>

        {/* Date Range Selectors */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, padding: "14px 24px", borderBottom: "1px solid #21262d" }}>
          <div style={{ border: "1px solid rgba(88,166,255,0.35)", borderRadius: 10, padding: "10px 16px", background: "rgba(88,166,255,0.04)" }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "#58a6ff", letterSpacing: "0.12em", marginBottom: 8 }}>RANGE ALPHA (OLDER)</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 10, color: "#6e7681", fontWeight: 600 }}>FROM</span>
              <input type="date" value={alphaDate} onChange={e => setAlphaDate(e.target.value)}
                style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #30363d", background: "#161b22", color: "#e6edf3", cursor: "pointer", outline: "none" }} />
              <span style={{ fontSize: 10, color: "#6e7681", fontWeight: 600 }}>TO</span>
              <div style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #30363d", background: "rgba(255,255,255,0.03)", color: "#8b949e" }}>{alphaDate}</div>
            </div>
          </div>
          <div style={{ border: "1px solid rgba(248,81,73,0.35)", borderRadius: 10, padding: "10px 16px", background: "rgba(248,81,73,0.04)" }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "#f85149", letterSpacing: "0.12em", marginBottom: 8 }}>RANGE BETA (NEWER)</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 10, color: "#6e7681", fontWeight: 600 }}>FROM</span>
              <input type="date" value={betaDate} onChange={e => setBetaDate(e.target.value)}
                style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #30363d", background: "#161b22", color: "#e6edf3", cursor: "pointer", outline: "none" }} />
              <span style={{ fontSize: 10, color: "#6e7681", fontWeight: 600 }}>TO</span>
              <div style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #30363d", background: "rgba(255,255,255,0.03)", color: "#8b949e" }}>{betaDate}</div>
            </div>
          </div>
        </div>

        {/* Tables + Inventory */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 240px" }}>
          {/* Alpha Table */}
          <div style={{ borderRight: "1px solid #21262d" }}>
            <div style={{ padding: "8px 16px", borderBottom: "1px solid #21262d", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: "#58a6ff", letterSpacing: "0.1em" }}>ALPHA BUYERS</span>
              <span style={{ fontSize: 10, color: "#6e7681", letterSpacing: "0.08em" }}>SELLERS</span>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "rgba(88,166,255,0.03)" }}>
                  {["BY","Net Val","Lot","Avg","SL","Net Val","Lot","Avg"].map((h,i) => (
                    <th key={i} style={{ padding: "6px 8px", fontSize: 9, color: "#6e7681", textAlign: i<4?"left":"right", fontWeight: 700, letterSpacing: "0.05em", borderBottom: "1px solid #21262d" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: Math.max(alphaBuyers.length, alphaSellers.length) }).map((_, i) => {
                  const b = alphaBuyers[i]; const s = alphaSellers[i];
                  return (
                    <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", background: i%2===0 ? "transparent" : "rgba(255,255,255,0.012)" }}>
                      {b ? (<>
                        <td style={{ padding: "5px 8px", fontSize: 12, fontWeight: 900, color: "#3fb950" }}>{b.broker}</td>
                        <td style={{ padding: "5px 8px", fontSize: 11, color: "#3fb950", textAlign: "right" }}>{fmtVal(b.buyVal)}</td>
                        <td style={{ padding: "5px 8px", fontSize: 10, color: "rgba(63,185,80,0.6)", textAlign: "right" }}>{fmtLot(b.buyLot)}</td>
                        <td style={{ padding: "5px 8px", fontSize: 10, color: "#6e7681", textAlign: "right" }}>{b.buyAvg?.toLocaleString("id-ID")}</td>
                      </>) : <td colSpan={4}/>}
                      {s ? (<>
                        <td style={{ padding: "5px 8px", fontSize: 12, fontWeight: 900, color: "#f85149" }}>{s.broker}</td>
                        <td style={{ padding: "5px 8px", fontSize: 11, color: "#f85149", textAlign: "right" }}>{fmtVal(Math.abs(s.sellVal))}</td>
                        <td style={{ padding: "5px 8px", fontSize: 10, color: "rgba(248,81,73,0.6)", textAlign: "right" }}>{fmtLot(Math.abs(s.sellLot))}</td>
                        <td style={{ padding: "5px 8px", fontSize: 10, color: "#6e7681", textAlign: "right" }}>{s.sellAvg?.toLocaleString("id-ID")}</td>
                      </>) : <td colSpan={4}/>}
                    </tr>
                  );
                })}
                {!rangeData && <tr><td colSpan={8} style={{ padding: 20, textAlign: "center", fontSize: 11, color: "#484f58" }}>Loading...</td></tr>}
              </tbody>
            </table>
          </div>

          {/* Beta Table */}
          <div style={{ borderRight: "1px solid #21262d" }}>
            <div style={{ padding: "8px 16px", borderBottom: "1px solid #21262d", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: "#f0883e", letterSpacing: "0.1em" }}>BETA BUYERS</span>
              <span style={{ fontSize: 10, color: "#6e7681", letterSpacing: "0.08em" }}>SELLERS</span>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "rgba(240,136,62,0.03)" }}>
                  {["BY","Net Val","Lot","Avg","SL","Net Val","Lot","Avg"].map((h,i) => (
                    <th key={i} style={{ padding: "6px 8px", fontSize: 9, color: "#6e7681", textAlign: i<4?"left":"right", fontWeight: 700, letterSpacing: "0.05em", borderBottom: "1px solid #21262d" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: Math.max(betaBuyers.length, betaSellers.length) }).map((_, i) => {
                  const b = betaBuyers[i]; const s = betaSellers[i];
                  return (
                    <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", background: i%2===0 ? "transparent" : "rgba(255,255,255,0.012)" }}>
                      {b ? (<>
                        <td style={{ padding: "5px 8px", fontSize: 12, fontWeight: 900, color: "#3fb950" }}>{b.broker}</td>
                        <td style={{ padding: "5px 8px", fontSize: 11, color: "#3fb950", textAlign: "right" }}>{fmtVal(b.buyVal)}</td>
                        <td style={{ padding: "5px 8px", fontSize: 10, color: "rgba(63,185,80,0.6)", textAlign: "right" }}>{fmtLot(b.buyLot)}</td>
                        <td style={{ padding: "5px 8px", fontSize: 10, color: "#6e7681", textAlign: "right" }}>{b.buyAvg?.toLocaleString("id-ID")}</td>
                      </>) : <td colSpan={4}/>}
                      {s ? (<>
                        <td style={{ padding: "5px 8px", fontSize: 12, fontWeight: 900, color: "#f85149" }}>{s.broker}</td>
                        <td style={{ padding: "5px 8px", fontSize: 11, color: "#f85149", textAlign: "right" }}>{fmtVal(Math.abs(s.sellVal))}</td>
                        <td style={{ padding: "5px 8px", fontSize: 10, color: "rgba(248,81,73,0.6)", textAlign: "right" }}>{fmtLot(Math.abs(s.sellLot))}</td>
                        <td style={{ padding: "5px 8px", fontSize: 10, color: "#6e7681", textAlign: "right" }}>{s.sellAvg?.toLocaleString("id-ID")}</td>
                      </>) : <td colSpan={4}/>}
                    </tr>
                  );
                })}
                {!rangeData && <tr><td colSpan={8} style={{ padding: 20, textAlign: "center", fontSize: 11, color: "#484f58" }}>Loading...</td></tr>}
              </tbody>
            </table>
          </div>

          {/* Inventory Flow */}
          <div style={{ background: "rgba(78,201,176,0.02)" }}>
            <div style={{ padding: "8px 16px", borderBottom: "1px solid #21262d", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: "#4ec9b0", letterSpacing: "0.1em" }}>Inventory Flow</span>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "rgba(255,255,255,0.02)" }}>
                  {["BROKER","ALPHA","BETA D","SIGNAL"].map(h => (
                    <th key={h} style={{ padding: "6px 8px", fontSize: 9, color: "#6e7681", textAlign: "left", fontWeight: 700, letterSpacing: "0.05em", borderBottom: "1px solid #21262d" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {inventory.map((inv: any, i: number) => {
                  const isUp  = inv.betaDelta > 0;
                  const isExt = inv.betaDelta < 0;
                  const dc = isUp ? "#3fb950" : isExt ? "#f85149" : "#6e7681";
                  return (
                    <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", background: i%2===0?"transparent":"rgba(255,255,255,0.012)" }}>
                      <td style={{ padding: "5px 8px", fontSize: 12, fontWeight: 900, color: "#e6edf3" }}>{inv.broker}</td>
                      <td style={{ padding: "5px 8px", fontSize: 10, color: "#6e7681", textAlign: "right" }}>{fmtLot(inv.alphaLot)}</td>
                      <td style={{ padding: "5px 8px", fontSize: 11, textAlign: "right", color: dc, fontWeight: 700 }}>
                        {inv.betaDelta > 0 ? "+" : ""}{fmtLot(inv.betaDelta)}
                      </td>
                      <td style={{ padding: "5px 8px" }}>
                        <span style={{
                          fontSize: 9, color: dc, fontWeight: 800, padding: "2px 6px", borderRadius: 4,
                          background: isUp ? "rgba(63,185,80,0.1)" : isExt ? "rgba(248,81,73,0.1)" : "rgba(110,118,129,0.08)",
                          border: `1px solid ${isUp ? "rgba(63,185,80,0.25)" : isExt ? "rgba(248,81,73,0.25)" : "#30363d"}`,
                        }}>{inv.signal}</span>
                      </td>
                    </tr>
                  );
                })}
                {inventory.length === 0 && <tr><td colSpan={4} style={{ padding: 20, textAlign: "center", fontSize: 11, color: "#484f58" }}>{rangeData?"No data":"Loading..."}</td></tr>}
              </tbody>
            </table>
            <div style={{ padding: "8px 12px", borderTop: "1px solid #21262d" }}>
              <div style={{ fontSize: 9, color: "#484f58" }}>Avg-Up: Re-calculated cost basis.</div>
              <div style={{ fontSize: 9, color: "#484f58" }}>Exit %: Distribution magnitude.</div>
            </div>
          </div>
        </div>
      </div>

      {/* ANTIGRAVITY CHART */}
      {(() => {
        // Use Yahoo Finance candles (real OHLC, proper timeframe)
        const agCandles = yahooCandles.length > 0 ? yahooCandles : (data.candlestick || []);
        const fibLevels = fibData?.levels || [];
        const lunarInRange = agCandles.length > 0
          ? lunarData.filter(e => e.dateStr >= agCandles[0]?.date && e.dateStr <= agCandles[agCandles.length-1]?.date)
          : [];
        // Use brush-visible window for Y-axis (removes dead space below)
        const defaultStart = Math.max(0, agCandles.length - 40);
        const visStart = brushRange?.startIndex ?? defaultStart;
        const visEnd   = brushRange?.endIndex   ?? agCandles.length - 1;
        const visCandles = agCandles.slice(visStart, visEnd + 1);
        const highs = (visCandles.length > 0 ? visCandles : agCandles).map((c:any) => c.high).filter(Boolean);
        const lows  = (visCandles.length > 0 ? visCandles : agCandles).map((c:any) => c.low).filter(Boolean);
        const pMin  = lows.length  ? Math.min(...lows)  * 0.994 : 0;
        const pMax  = highs.length ? Math.max(...highs) * 1.006 : 1;
        const FIB_TOL = 0.022;
        const intersections: any[] = [];
        if (showFib && showLunar) {
          for (const ev of lunarInRange) {
            const candle = agCandles.find((c:any) => c.date === ev.dateStr);
            if (!candle) continue;
            for (const lv of fibLevels) {
              if (!lv.price) continue;
              const pct = Math.abs(candle.close - lv.price) / lv.price;
              if (pct <= FIB_TOL) intersections.push({ date: ev.dateStr, close: candle.close,
                fibLabel: lv.label, fibPrice: lv.price, fibColor: lv.color, lunarType: ev.type, lunarEmoji: ev.emoji });
            }
          }
        }
        // Planetary events in chart range
        const chartStart = agCandles[0]?.date || "";
        const chartEnd   = agCandles[agCandles.length-1]?.date || "";
        const planetsInRange = PLANETARY_EVENTS.filter(p =>
          p.end >= chartStart && p.start <= chartEnd
        );
        // Volume
        const maxVol = Math.max(...agCandles.map((c:any) => c.volume || 0), 1);

        const CandleShape = ({ x, y, width, height, payload }: any) => {
          if (!payload || !height || isNaN(height) || height <= 0) return null;
          const { open, high, low, close } = payload;
          const isGreen = close >= open;
          const color = isGreen ? "#3fb950" : "#f85149";
          const range = high - low; if (range <= 0) return null;
          const pxPer = height / range;
          const cx = Math.round(x + width / 2);
          const bTop = y + (high - Math.max(open, close)) * pxPer;
          const bH = Math.max(Math.abs(open - close) * pxPer, 1);
          const bW = Math.max(width - 2, 2);
          return (<g>
            <line x1={cx} y1={y} x2={cx} y2={y+height} stroke={color} strokeWidth={1} opacity={0.6} />
            <rect x={x+1} y={bTop} width={bW} height={bH} fill={color} stroke={color} strokeWidth={1} opacity={0.9} />
          </g>);
        };
        return (
          <div style={{ marginBottom: 16, background: "#0d1117", borderRadius: 14, border: "1px solid rgba(247,201,72,0.2)", overflow: "hidden" }}>
            {/* AG Header */}
            <div style={{ padding: "14px 20px 10px", borderBottom: "1px solid #21262d", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 4, height: 22, background: "#f7c948", borderRadius: 3 }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 900, color: "#f7c948", letterSpacing: "0.06em" }}>ANTIGRAVITY CHART</div>
                  <div style={{ fontSize: 10, color: "#484f58", marginTop: 1, display: "flex", alignItems: "center", gap: 6 }}>
                    <span>Auto-Fibonacci</span>
                    {fibData?.method && <span style={{ color: "#6e7681" }}>{fibData.method === "pivot" ? "PIVOT" : "ABS"}</span>}
                    {intersections.length > 0 && (
                      <span style={{ color: "#ff7b72", fontWeight: 700 }}>{intersections.length} CONFLUENCE</span>
                    )}
                    {yahooLoading && <span style={{ color: "#f7c948", fontSize: 9, animation: "pulse 1s infinite" }}>● LOADING...</span>}
                    {!yahooLoading && yahooCandles.length > 0 && <span style={{ color: "#3fb950", fontSize: 9 }}>● YAHOO FINANCE · {yahooCandles.length}d</span>}
                  </div>

                </div>
              </div>
              <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                {(["1M","3M","ALL"] as const).map(tf => (
                  <button key={tf} onClick={() => { setAgChartDays(tf); setBrushRange(null); }} style={{
                    fontSize: 10, padding: "3px 10px", borderRadius: 5, cursor: "pointer", fontWeight: 700, border: "none",
                    background: agChartDays===tf ? "#e6edf3" : "rgba(255,255,255,0.06)",
                    color: agChartDays===tf ? "#0d1117" : "#6e7681",
                  }}>{tf}</button>
                ))}
                <div style={{ width:1, height:14, background:"#30363d", margin:"0 2px" }}/>
                <button onClick={() => setShowFib(p => !p)} style={{
                  fontSize: 10, padding: "3px 10px", borderRadius: 5, cursor: "pointer", fontWeight: 700,
                  background: showFib ? "rgba(247,201,72,0.15)" : "rgba(255,255,255,0.06)",
                  color: showFib ? "#f7c948" : "#6e7681", border: `1px solid ${showFib ? "rgba(247,201,72,0.4)" : "transparent"}`,
                }}>FIB</button>
                {showFib && (
                  <select value={fibLookback} onChange={e => setFibLookback(Number(e.target.value))} style={{
                    fontSize: 10, padding: "3px 6px", borderRadius: 5, border: "1px solid #30363d",
                    background: "#161b22", color: "#8b949e", cursor: "pointer",
                  }}>
                    <option value={30}>30d</option><option value={60}>60d</option>
                    <option value={90}>90d</option><option value={120}>120d</option>
                  </select>
                )}
                <button onClick={() => setShowLunar(p => !p)} style={{
                  fontSize: 10, padding: "3px 10px", borderRadius: 5, cursor: "pointer", fontWeight: 700,
                  background: showLunar ? "rgba(78,201,176,0.15)" : "rgba(255,255,255,0.06)",
                  color: showLunar ? "#4ec9b0" : "#6e7681", border: `1px solid ${showLunar ? "rgba(78,201,176,0.4)" : "transparent"}`,
                }}>LUNAR</button>
                <button onClick={() => setShowPlanets(p => !p)} style={{
                  fontSize: 10, padding: "3px 10px", borderRadius: 5, cursor: "pointer", fontWeight: 700,
                  background: showPlanets ? "rgba(240,136,62,0.15)" : "rgba(255,255,255,0.06)",
                  color: showPlanets ? "#f0883e" : "#6e7681", border: `1px solid ${showPlanets ? "rgba(240,136,62,0.4)" : "transparent"}`,
                }}>PLANETS</button>
                <button onClick={() => setShowVolume(p => !p)} style={{
                  fontSize: 10, padding: "3px 10px", borderRadius: 5, cursor: "pointer", fontWeight: 700,
                  background: showVolume ? "rgba(88,166,255,0.15)" : "rgba(255,255,255,0.06)",
                  color: showVolume ? "#58a6ff" : "#6e7681", border: `1px solid ${showVolume ? "rgba(88,166,255,0.3)" : "transparent"}`,
                }}>VOL</button>
                <button onClick={() => setShowExtensions(p => !p)} style={{
                  fontSize: 10, padding: "3px 10px", borderRadius: 5, cursor: "pointer", fontWeight: 700,
                  background: showExtensions ? "rgba(188,140,255,0.15)" : "rgba(255,255,255,0.06)",
                  color: showExtensions ? "#bc8cff" : "#6e7681", border: `1px solid ${showExtensions ? "rgba(188,140,255,0.3)" : "transparent"}`,
                }}>EXT</button>
                <button onClick={() => setShowSR(p => !p)} style={{
                  fontSize: 10, padding: "3px 10px", borderRadius: 5, cursor: "pointer", fontWeight: 700,
                  background: showSR ? "rgba(255,123,114,0.15)" : "rgba(255,255,255,0.06)",
                  color: showSR ? "#ff7b72" : "#6e7681", border: `1px solid ${showSR ? "rgba(255,123,114,0.3)" : "transparent"}`,
                }}>S&R</button>
              </div>
            </div>

            {/* Confluence Signals */}
            {intersections.length > 0 && (
              <div style={{ padding: "8px 20px", borderBottom: "1px solid #21262d", display: "flex", gap: 8, flexWrap: "wrap", background: "rgba(248,81,73,0.03)" }}>
                <span style={{ fontSize: 9, color: "#ff7b72", fontWeight: 800, alignSelf: "center", marginRight: 4 }}>LUNAR x FIB CONFLUENCE:</span>
                {intersections.map((ix, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 6,
                    background: ix.lunarType==="full_moon" ? "rgba(247,201,72,0.08)" : "rgba(110,118,129,0.08)",
                    border: `1px solid ${ix.lunarType==="full_moon" ? "rgba(247,201,72,0.3)" : "#30363d"}` }}>
                    <span style={{ fontSize: 12 }}>{ix.lunarEmoji}</span>
                    <div>
                      <div style={{ fontSize: 9, color: "#6e7681" }}>{ix.date}</div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: ix.fibColor }}>Fib {ix.fibLabel} @ Rp {Number(ix.close).toLocaleString("id-ID")}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Chart body */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", alignItems: "start" }}>
              <div style={{ padding: "12px 0 8px" }}>
                {agCandles.length > 0 ? (
                  <ResponsiveContainer width="100%" height={580}>
                    <ComposedChart data={agCandles} margin={{ top:20, right:4, bottom:0, left:0 }}>
                      <CartesianGrid strokeDasharray="1 10" stroke="rgba(255,255,255,0.025)" vertical={false} />
                      <XAxis dataKey="date"
                        tick={(props: any) => {
                          const { x, y, payload } = props;
                          const ev = lunarInRange.find((e:any) => e.dateStr === payload.value);
                          return (
                            <text x={x} y={y+12} textAnchor="middle"
                              fontSize={ev ? 13 : 8}
                              fill={ev ? (ev.type==="full_moon" ? "#f7c948" : "#8b949e") : "#484f58"}>
                              {ev ? ev.emoji : shortDate(payload.value)}
                            </text>
                          );
                        }}
                        axisLine={false} tickLine={false} interval={Math.ceil(agCandles.length / 18)} />
                      <YAxis domain={[pMin,pMax]} allowDataOverflow tickFormatter={(v:number) => v>=1000?`${(v/1000).toFixed(1)}K`:String(Math.round(v))}
                        tick={{ fontSize: 9, fill: "#484f58" }} axisLine={false} tickLine={false} width={42} />
                      <Tooltip content={({ active, payload, label }:any) => {
                        if (!active || !payload?.[0]) return null;
                        const d = payload[0].payload;
                        const c = d.close >= d.open ? "#3fb950" : "#f85149";
                        const lunarEv = lunarInRange.find((e:any) => e.dateStr === label);
                        const fibHit = intersections.filter((ix:any) => ix.date === label);
                        return (<div style={{ background:"#0d1117", border:"1px solid #30363d", borderRadius:10, padding:"10px 14px", fontSize:11, minWidth:160 }}>
                          <div style={{ color:"#8b949e", marginBottom:6, fontWeight:700, fontSize:10 }}>{label}</div>
                          {lunarEv && <div style={{ fontSize:14, marginBottom:6 }}>{lunarEv.emoji} <span style={{ fontSize:10, color:lunarEv.color, fontWeight:700 }}>{lunarEv.label}</span></div>}
                          <div style={{ display:"grid", gridTemplateColumns:"16px 1fr", gap:"3px 8px" }}>
                            <span style={{ color:"#484f58" }}>O</span><span style={{ color:c }}>{d.open?.toLocaleString("id-ID")}</span>
                            <span style={{ color:"#484f58" }}>H</span><span style={{ color:"#3fb950" }}>{d.high?.toLocaleString("id-ID")}</span>
                            <span style={{ color:"#484f58" }}>L</span><span style={{ color:"#f85149" }}>{d.low?.toLocaleString("id-ID")}</span>
                            <span style={{ color:"#484f58" }}>C</span><span style={{ color:c, fontWeight:900 }}>Rp {d.close?.toLocaleString("id-ID")}</span>
                          </div>
                          {fibHit.length > 0 && (
                            <div style={{ marginTop:6, paddingTop:6, borderTop:"1px solid #21262d" }}>
                              {fibHit.map((ix:any, i:number) => (
                                <div key={i} style={{ fontSize:10, color:ix.fibColor, fontWeight:700 }}>★ Fib {ix.fibLabel} @ {Number(ix.fibPrice).toLocaleString("id-ID")}</div>
                              ))}
                            </div>
                          )}
                        </div>);
                      }} />
                      <Bar dataKey={(d:any) => [d.low ?? d.close, d.high ?? d.close]}
                        shape={(props:any) => <CandleShape {...props} />}
                        isAnimationActive={false} />
                      {showFib && fibLevels.map((lv:any) => {
                        if (lv.type === 'extend' && !showExtensions) return null;
                        const isGolden  = lv.label === "0.618";
                        const isGoldExt = lv.label === "1.618";
                        const isExtend  = lv.type === 'extend';
                        const isKey = ["0.500","0.618","0.786","1.000","0.000"].includes(lv.label);
                        return lv.price >= pMin && lv.price <= pMax ? (
                          <ReferenceLine key={lv.label} y={lv.price}
                            stroke={lv.color}
                            strokeWidth={isGolden||isGoldExt ? 2.5 : isKey ? 1.5 : 1}
                            strokeDasharray={isGolden||isGoldExt ? undefined : isExtend ? "2 5" : isKey ? "6 4" : "3 6"}
                            strokeOpacity={isGolden||isGoldExt ? 1 : isExtend ? 0.55 : isKey ? 0.75 : 0.45}
                            label={{ value: (isExtend?"↓ ":"")+lv.label, position:"insideRight", fontSize:9, fill:lv.color, dx:-4, fontWeight: isGolden||isGoldExt ? 900 : 600 }}
                          />
                        ) : null;
                      })}
                      {/* S&R Lines */}
                      {showSR && (fibData?.srLevels||[]).map((sr:any, i:number) => (
                        sr.price >= pMin && sr.price <= pMax ? (
                          <ReferenceLine key={`sr-${i}`} y={sr.price}
                            stroke={sr.color} strokeWidth={2} strokeDasharray="8 3"
                            strokeOpacity={0.6 + sr.strength * 0.1}
                            label={{ value: `${sr.type==='resistance'?'R':'S'}${sr.strength}`, position:"insideLeft", fontSize:8, fill:sr.color, dx:4 }}
                          />
                        ) : null
                      ))}
                      {showLunar && lunarInRange.map((ev:any, i:number) => (
                        <ReferenceLine key={i} x={ev.dateStr}
                          stroke={ev.type==="full_moon" ? "rgba(247,201,72,0.5)" : "rgba(139,148,158,0.3)"}
                          strokeWidth={1.5} strokeDasharray="3 5" />
                      ))}
                      {intersections.map((ix,i) => (
                        <ReferenceDot key={i} x={ix.date} y={ix.fibPrice}
                          r={7}
                          fill={ix.lunarType==="full_moon" ? "#f7c948" : "#a371f7"}
                          stroke={ix.lunarType==="full_moon" ? "rgba(247,201,72,0.5)" : "rgba(163,113,247,0.5)"}
                          strokeWidth={5} />
                      ))}
                      {/* Planetary period shading */}
                      {showPlanets && planetsInRange.map((p, i) => {
                        // For period events (Rx), draw start + end lines
                        const startDate = p.start >= chartStart ? p.start : chartStart;
                        const endDate   = p.end   <= chartEnd   ? p.end   : chartEnd;
                        return p.start === p.end ? (
                          // Single-day event (Jupiter ingress)
                          <ReferenceLine key={`planet-${i}`} x={startDate}
                            stroke={p.color} strokeWidth={2} strokeDasharray="4 3"
                            label={{ value: p.emoji, position:"top", fontSize:14, fill:p.color }} />
                        ) : (
                          // Period event — draw bracket lines
                          <g key={`planet-${i}`}>
                            <ReferenceLine x={startDate}
                              stroke={p.color} strokeWidth={1.5} strokeDasharray="2 4" strokeOpacity={0.7}
                              label={{ value: p.emoji, position:"top", fontSize:12, fill:p.color }} />
                            <ReferenceLine x={endDate}
                              stroke={p.color} strokeWidth={1.5} strokeDasharray="2 4" strokeOpacity={0.4} />
                          </g>
                        );
                      })}
                      {/* Volume bars — secondary Y-axis stacked at bottom */}
                      {showVolume && (
                        <YAxis yAxisId="vol" hide domain={[0, maxVol * 6]} />
                      )}
                      {showVolume && (
                        <Bar yAxisId="vol" dataKey="volume" isAnimationActive={false} maxBarSize={12}>
                          {agCandles.map((c:any, i:number) => (
                            <Cell key={i}
                              fill={c.close >= c.open ? "rgba(63,185,80,0.45)" : "rgba(248,81,73,0.45)"}
                            />
                          ))}
                        </Bar>
                      )}
                      <Brush
                        dataKey="date"
                        height={28}
                        travellerWidth={8}
                        stroke="#30363d"
                        fill="#0d1117"
                        tickFormatter={shortDate}
                        startIndex={brushRange?.startIndex ?? Math.max(0, agCandles.length - 40)}
                        endIndex={brushRange?.endIndex ?? agCandles.length - 1}
                        onChange={(range: any) => {
                          if (range && range.startIndex !== undefined)
                            setBrushRange({ startIndex: range.startIndex, endIndex: range.endIndex });
                        }}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ height:120, display:"flex", alignItems:"center", justifyContent:"center", color:"#484f58", fontSize:12 }}>No candlestick data</div>
                )}

              </div>

              {/* Fib + Lunar Panel */}
              <div style={{ padding: "14px 14px", borderLeft: "1px solid #21262d", height: "100%" }}>
                {showFib && fibLevels.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 9, color: "#484f58", fontWeight: 800, letterSpacing: "0.1em", marginBottom: 8 }}>FIB LEVELS</div>
                    {fibLevels.map((lv:any) => {
                      const hasSignal = intersections.some(ix => ix.fibLabel === lv.label);
                      return (
                        <div key={lv.label} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
                          padding:"4px 8px", borderRadius:5, marginBottom:3,
                          background: hasSignal?"rgba(248,81,73,0.08)":lv.label==="0.618"?"rgba(247,201,72,0.07)":"rgba(255,255,255,0.02)",
                          border:`1px solid ${hasSignal?"rgba(248,81,73,0.3)":lv.label==="0.618"?"rgba(247,201,72,0.2)":"rgba(255,255,255,0.04)"}` }}>
                          <div style={{ display:"flex", alignItems:"center", gap:5 }}>
                            <div style={{ width:10, height:2, background:lv.color, borderRadius:1 }} />
                            <span style={{ fontSize:9, color:lv.color, fontWeight:lv.label==="0.618"?900:600 }}>{lv.label}</span>
                            {hasSignal && <span style={{ fontSize:8, color:"#ff7b72", fontWeight:800 }}>!</span>}
                          </div>
                          <span style={{ fontSize:9, color:lv.label==="0.618"?"#f7c948":"#6e7681", fontWeight:700 }}>
                            {lv.price>=1000?`${(lv.price/1000).toFixed(1)}K`:lv.price}
                          </span>
                        </div>
                      );
                    })}
                    {fibData && (
                      <div style={{ marginTop:10, paddingTop:8, borderTop:"1px solid #21262d" }}>
                        <div style={{ fontSize:9, color:"#3fb950", fontWeight:700 }}>Hi: {fibData.swingHigh?.price?.toLocaleString("id-ID")}</div>
                        <div style={{ fontSize:9, color:"#f85149", fontWeight:700, marginBottom:6 }}>Lo: {fibData.swingLow?.price?.toLocaleString("id-ID")}</div>
                        <div style={{ fontSize:9, fontWeight:800, padding:"3px 8px", borderRadius:5, textAlign:"center",
                          background:fibData.direction==="uptrend"?"rgba(63,185,80,0.1)":"rgba(248,81,73,0.1)",
                          color:fibData.direction==="uptrend"?"#3fb950":"#f85149",
                          border:`1px solid ${fibData.direction==="uptrend"?"rgba(63,185,80,0.3)":"rgba(248,81,73,0.3)"}` }}>
                          {fibData.direction==="uptrend"?"UP TREND":"DOWN TREND"}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {showLunar && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize:9, color:"#484f58", fontWeight:800, letterSpacing:"0.1em", marginBottom:6 }}>LUNAR EVENTS</div>
                    {lunarInRange.slice(-6).map((ev:any, i:number) => (
                      <div key={i} style={{ fontSize:9, padding:"3px 7px", borderRadius:5, marginBottom:3, fontWeight:600,
                        background:ev.type==="full_moon"?"rgba(247,201,72,0.07)":"rgba(110,118,129,0.06)",
                        color:ev.type==="full_moon"?"#f7c948":"#6e7681",
                        border:`1px solid ${ev.type==="full_moon"?"rgba(247,201,72,0.2)":"#21262d"}` }}>
                        {ev.emoji} {ev.dateStr}
                      </div>
                    ))}
                  </div>
                )}
                {showPlanets && planetsInRange.length > 0 && (
                  <div>
                    <div style={{ fontSize:9, color:"#484f58", fontWeight:800, letterSpacing:"0.1em", marginBottom:6 }}>PLANETARY</div>
                    {planetsInRange.map((p:any, i:number) => (
                      <div key={i} style={{ fontSize:9, padding:"3px 7px", borderRadius:5, marginBottom:3, fontWeight:600,
                        background:`${p.color}18`, color:p.color, border:`1px solid ${p.color}35` }}>
                        {p.emoji} {p.label}
                        <div style={{ fontSize:8, color:"#484f58", marginTop:1 }}>{p.start}{p.start !== p.end ? ` to ${p.end}` : ""}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* â”€â”€ Row 5: Data Quality Summary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="card" style={{ padding: 16, marginBottom: 8, background: "rgba(47,129,247,0.04)", borderColor: "rgba(47,129,247,0.2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent-green)", display: "inline-block" }} />
            <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600, letterSpacing: "0.06em" }}>SOURCE: DATABASE (VPS)</span>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>ðŸ“… Range: <strong style={{ color: "var(--text-secondary)" }}>{data.dataRange?.from} â†’ {data.dataRange?.to}</strong></div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>ðŸ¦ Brokers: <strong style={{ color: "var(--accent-cyan)" }}>{data.brokerCodes?.length}</strong></div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>ðŸ“Š Days: <strong style={{ color: "var(--accent-cyan)" }}>{data.dataRange?.days}</strong></div>
        </div>
      </div>

    </div>
  );
}
