"use client";
import Navbar from "@/components/Navbar";
import { API_BASE } from "@/lib/apiConfig";
import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import { brokerBadgeStyle, getBrokerColors, BROKER_COLORS } from "@/lib/brokerColors";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

type FactorBreakdown = {
  concentration: number;
  trend: number;
  volumeZ: number;
  momentum: number;
  relStrength: number;
  breadth: number;
  alignment: number;
  streak: number;
  rsi: number;
  macd: number;
  bollinger: number;
  emaTrend: number;
  supportResistance: number;
  atr: number;
};

type EngineWeights = Record<string, number>;

const FACTOR_LABELS: { key: keyof FactorBreakdown; label: string; icon: string; weightKey: string }[] = [
  { key: "concentration",      label: "Smart Money",       icon: "🏦", weightKey: "f1" },
  { key: "trend",              label: "Trend Consistency",  icon: "📈", weightKey: "f2" },
  { key: "volumeZ",            label: "Volume Z-Score",    icon: "📊", weightKey: "f3" },
  { key: "momentum",           label: "Price Momentum",    icon: "🚀", weightKey: "f4" },
  { key: "relStrength",        label: "Rel. Strength",     icon: "💪", weightKey: "f5" },
  { key: "breadth",            label: "Buyer Breadth",     icon: "👥", weightKey: "f6" },
  { key: "alignment",          label: "Price-Broker",      icon: "🔗", weightKey: "f7" },
  { key: "streak",             label: "Accum. Streak",     icon: "🔥", weightKey: "f8" },
  { key: "rsi",                label: "RSI",                icon: "📉", weightKey: "f9" },
  { key: "macd",               label: "MACD",               icon: "〰️", weightKey: "f10" },
  { key: "bollinger",          label: "Bollinger %B",       icon: "🎯", weightKey: "f11" },
  { key: "emaTrend",           label: "EMA Trend",          icon: "📐", weightKey: "f12" },
  { key: "supportResistance",  label: "Support/Resistance", icon: "🧱", weightKey: "f13" },
  { key: "atr",                label: "ATR (Volatility)",   icon: "🌊", weightKey: "f14" },
];

function MiniTrend({ days }: { days: number[] }) {
  if (!days || days.length === 0) return <span style={{ color: "#484f58", fontSize: 11 }}>—</span>;
  const max = Math.max(...days.map(Math.abs), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 24 }}>
      {days.map((v, i) => {
        const h = Math.round(Math.abs(v) / max * 20) + 4;
        const color = v > 0 ? "#3fb950" : v < 0 ? "#f85149" : "#30363d";
        const isToday = i === days.length - 1;
        return (
          <div key={i} style={{
            width: isToday ? 7 : 5, height: h, background: color, borderRadius: 2,
            opacity: isToday ? 1 : 0.5 + (i / days.length) * 0.5,
            border: isToday ? `1px solid ${color}` : "none",
          }} title={`D${i - (days.length - 1)}: ${v.toFixed(1)}%`} />
        );
      })}
    </div>
  );
}

function ConfidenceBadge({ confidence, winRate, winRateSample }: { confidence: number; winRate: number; winRateSample: number }) {
  const color = confidence >= 70 ? "#3fb950" : confidence >= 50 ? "#e3b341" : "#8b949e";
  const hasHistory = winRateSample >= 10;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <div style={{
        fontSize: 13, fontWeight: 900, color,
        padding: "2px 8px", borderRadius: 6,
        background: `${color}15`, border: `1px solid ${color}30`,
        letterSpacing: "0.02em",
      }}>
        {confidence}%
      </div>
      {hasHistory && (
        <div style={{ fontSize: 9, color: "#8b949e", whiteSpace: "nowrap" }}
             title={`Historical: ${winRate}% win dari ${winRateSample} signals`}>
          WR {winRate}%
        </div>
      )}
    </div>
  );
}

function FactorBreakdownPanel({ factors, score, weights, engineVersion }: { factors: FactorBreakdown; score: number; weights?: EngineWeights; engineVersion?: string }) {
  return (
    <div style={{
      padding: "16px 24px", background: "rgba(22,27,34,0.6)", borderTop: "1px solid var(--border)",
      display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px 24px",
    }}>
      {FACTOR_LABELS.map(f => {
        const val = factors[f.key] || 0;
        const barColor = val >= 65 ? "#3fb950" : val >= 50 ? "#e3b341" : val >= 35 ? "#f0883e" : "#f85149";
        const w = weights?.[f.weightKey];
        const weightLabel = w != null ? `${Math.round(w * 1000) / 10}%` : "—";
        return (
          <div key={f.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 10, color: "#8b949e", fontWeight: 600 }}>
                {f.icon} {f.label}
              </span>
              <span style={{ fontSize: 10, color: "#484f58" }}>{weightLabel}</span>
            </div>
            <div style={{ height: 5, background: "#21262d", borderRadius: 3, overflow: "hidden" }}>
              <div style={{
                width: `${val}%`, height: "100%", background: barColor,
                borderRadius: 3, transition: "width 0.4s ease",
              }} />
            </div>
            <div style={{ fontSize: 11, fontWeight: 800, color: barColor, textAlign: "right" }}>{val}</div>
          </div>
        );
      })}
      {/* Composite summary */}
      <div style={{
        gridColumn: "1 / -1", marginTop: 4, paddingTop: 8,
        borderTop: "1px solid rgba(48,54,61,0.5)",
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <span style={{ fontSize: 10, color: "#8b949e", fontWeight: 700 }}>
          ENGINE v{engineVersion || "3.0-awo"} · {FACTOR_LABELS.length} Factors · Weighted Composite
        </span>
        <span style={{ fontSize: 13, fontWeight: 900, color: score >= 63 ? "#3fb950" : score <= 40 ? "#f85149" : "#e3b341" }}>
          COMPOSITE: {score}/100
        </span>
      </div>
    </div>
  );
}

function VolumeAnomalyBadge({ zScore }: { zScore: number }) {
  if (!Number.isFinite(zScore) || Math.abs(zScore) < 1.5) return null;
  const isHigh = zScore > 0;
  return (
    <span style={{
      fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 4,
      background: isHigh ? "rgba(227,179,65,0.15)" : "rgba(139,148,158,0.1)",
      color: isHigh ? "#e3b341" : "#8b949e",
      border: `1px solid ${isHigh ? "rgba(227,179,65,0.3)" : "rgba(139,148,158,0.2)"}`,
      whiteSpace: "nowrap",
    }} title={`Volume Z-Score: ${zScore.toFixed(2)} (${zScore > 2 ? 'sangat abnormal' : 'di atas rata-rata'})`}>
      {zScore > 2 ? "🔥" : "📊"} VOL {zScore > 0 ? "+" : ""}{zScore.toFixed(1)}σ
    </span>
  );
}

const SIGNAL_COLS = "40px 90px 100px 72px 68px 130px 80px 140px 80px 100px 100px 1fr";

/* ─── Signal config ───────────────────────────────────────────── */
const SIG: Record<string, { label: string; icon: string; color: string; bg: string; border: string }> = {
  "STRONG BUY":  { label: "STRONG BUY",  icon: "▲▲", color: "#3fb950", bg: "rgba(63,185,80,0.18)",  border: "#238636" },
  "BUY":         { label: "BUY",          icon: "▲",  color: "#56d364", bg: "rgba(86,211,100,0.12)", border: "rgba(86,211,100,0.4)" },
  "WATCH":       { label: "WATCH",        icon: "◈",  color: "#e3b341", bg: "rgba(227,179,65,0.13)", border: "rgba(227,179,65,0.4)" },
  "NEUTRAL":     { label: "NEUTRAL",      icon: "●",  color: "#8b949e", bg: "rgba(139,148,158,0.1)", border: "rgba(139,148,158,0.3)" },
  "SELL":        { label: "SELL",         icon: "▼",  color: "#f85149", bg: "rgba(248,81,73,0.13)",  border: "rgba(248,81,73,0.4)" },
  "STRONG SELL": { label: "STRONG SELL",  icon: "▼▼", color: "#ff4444", bg: "rgba(255,68,68,0.18)",  border: "#da3633" },
};

/* ─── SVG Sparkline ───────────────────────────────────────────── */
function Sparkline({ days }: { days: number[] }) {
  if (!days || days.length < 2) return <span style={{ color: "#484f58", fontSize: 12 }}>—</span>;
  const W = 88, H = 30, px = 3, py = 4;
  const min = Math.min(...days), max = Math.max(...days), rng = (max - min) || 1;
  const pts = days.map((v, i) => {
    const x = px + (i / (days.length - 1)) * (W - px * 2);
    const y = py + (1 - (v - min) / rng) * (H - py * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = days[days.length - 1];
  const col = last > 2 ? "#3fb950" : last < -2 ? "#f85149" : "#8b949e";
  const lastPt = pts[pts.length - 1].split(",");
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: "block", overflow: "visible" }}>
      <polyline points={pts.join(" ")} fill="none" stroke={col} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
      <circle cx={lastPt[0]} cy={lastPt[1]} r={3} fill={col} />
    </svg>
  );
}

/* ─── Score bar ───────────────────────────────────────────────── */
function ScoreBar({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score));
  const col = score >= 65 ? "#3fb950" : score >= 55 ? "#56d364" : score <= 35 ? "#f85149" : score <= 45 ? "#ff7b72" : "#e3b341";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden", maxWidth: "100%" }}>
      <div style={{ width: 72, minWidth: 72, maxWidth: 72, height: 5, background: "#21262d", borderRadius: 3, overflow: "hidden", flexShrink: 0 }}>
        <div style={{ width: `${pct}%`, height: "100%", background: col, borderRadius: 3, transition: "width 0.6s ease" }} />
      </div>
      <span style={{ fontSize: 13, fontWeight: 800, color: col, minWidth: 28 }}>{score}</span>
    </div>
  );
}

/* ─── Flow bar ────────────────────────────────────────────────── */
function FlowBar({ net, total }: { net: number; total: number }) {
  const pct = total > 0 ? Math.abs(net) / total : 0;
  const col = net > 0 ? "#3fb950" : "#f85149";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ width: 60, height: 6, background: "#21262d", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${Math.min(pct * 100, 100)}%`, height: "100%", background: col, borderRadius: 3, transition: "width 0.5s" }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 700, color: col, minWidth: 24 }}>
        {net > 0 ? "+" : ""}{net}
      </span>
    </div>
  );
}

/* ─── Screener: Mini cumulative chart ─────────────────────────── */
function MiniAccumChart({ data }: { data: { date: string; cum: number }[] }) {
  if (!data || data.length < 5) return <span style={{ color: "#484f58", fontSize: 11 }}>—</span>;
  const vals = data.map(d => d.cum);
  const min = Math.min(...vals), max = Math.max(...vals), range = (max - min) || 1;
  const W = 110, H = 36;
  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * W;
    const y = H - ((v - min) / range) * (H - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const last = vals[vals.length - 1];
  const col = last >= 0 ? "#3fb950" : "#f85149";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <polyline points={pts} fill="none" stroke={col} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span style={{ fontSize: 10, fontWeight: 700, color: col }}>
        {last >= 0 ? "+" : ""}{last.toFixed(1)}B
      </span>
    </div>
  );
}

/* ─── Screener: Funnel step ───────────────────────────────────── */
function FunnelStep({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div style={{ textAlign: "center", padding: "14px 10px", background: "var(--bg-secondary)", borderRadius: 10, border: "1px solid var(--border)" }}>
      <div style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 700, letterSpacing: "0.08em", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 900, color, lineHeight: 1, marginBottom: 6 }}>{count}</div>
      <div style={{ height: 3, background: "#21262d", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 2, transition: "width 0.8s ease" }} />
      </div>
      <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>{pct}% pass</div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   HARMONIC PATTERN COMPONENTS
═══════════════════════════════════════════════════════════════ */

const PATTERN_META: Record<string, { color: string; bg: string; border: string; desc: string }> = {
  ABCD:      { color: "#60a5fa", bg: "rgba(96,165,250,0.1)",  border: "rgba(96,165,250,0.3)",  desc: "Basic reversal" },
  GARTLEY:   { color: "#a78bfa", bg: "rgba(167,139,250,0.1)", border: "rgba(167,139,250,0.3)", desc: "0.618 retracement" },
  BAT:       { color: "#34d399", bg: "rgba(52,211,153,0.1)",  border: "rgba(52,211,153,0.3)",  desc: "0.886 deep" },
  BUTTERFLY: { color: "#f59e0b", bg: "rgba(245,158,11,0.1)",  border: "rgba(245,158,11,0.3)",  desc: "Extension" },
  CRAB:      { color: "#f87171", bg: "rgba(248,113,113,0.1)", border: "rgba(248,113,113,0.3)", desc: "1.618 extreme" },
  SHARK:     { color: "#c084fc", bg: "rgba(192,132,252,0.1)", border: "rgba(192,132,252,0.3)", desc: "Counter-trend" },
  CYPHER:    { color: "#38bdf8", bg: "rgba(56,189,248,0.1)",  border: "rgba(56,189,248,0.3)",  desc: "0.786 target" },
};

const STATUS_META: Record<string, { color: string; label: string; emoji: string }> = {
  OPEN:    { color: "#60a5fa", label: "OPEN",      emoji: "🔵" },
  HIT_T1:  { color: "#34d399", label: "HIT T1",    emoji: "✅" },
  HIT_T2:  { color: "#10b981", label: "HIT T2",    emoji: "🎯" },
  STOPPED: { color: "#f87171", label: "STOPPED",   emoji: "🛑" },
  EXPIRED: { color: "#6b7280", label: "EXPIRED",   emoji: "⏰" },
};

// ─── Position Sizing Calculator ───────────────────────────────
const MODAL_TOTAL   = 100_000_000; // Rp 100 juta
const RISK_PER_TRADE = 0.02;        // 2% per trade = Rp 2 juta
const MAX_POS_PCT   = 0.30;         // max 30% per posisi = Rp 30 juta

function calcPosition(rec: any) {
  const entryMin = Number(rec.entry_min) || 0;
  const entryMax = Number(rec.entry_max) || 0;
  const entry    = entryMax > 0 ? (entryMin + entryMax) / 2 : entryMin;
  const sl       = Number(rec.stop_loss) || 0;
  const t1       = Number(rec.target_1) || 0;
  const t2       = Number(rec.target_2) || 0;
  const dir      = rec.direction;
  // Conviction Tier sizing — see modules/conviction.js. Defaults to 1.0 (no
  // change in behavior) when a rec predates this feature and has no tier data.
  const sizeMult = rec.sizeMultiplier !== undefined && rec.sizeMultiplier !== null ? Number(rec.sizeMultiplier) : 1.0;

  if (!entry || !sl || entry === sl || sizeMult === 0) return null;

  const riskPerShare = dir === "BULLISH" ? entry - sl : sl - entry;
  if (riskPerShare <= 0) return null;

  const riskAmount   = MODAL_TOTAL * RISK_PER_TRADE * sizeMult;   // scaled by conviction tier
  const rawShares    = Math.floor(riskAmount / riskPerShare); // continuous
  const lotShares    = Math.max(100, Math.round(rawShares / 100) * 100); // round to lot
  const allocated    = lotShares * entry;
  const maxAlloc     = MODAL_TOTAL * MAX_POS_PCT * sizeMult;
  // Cap position if it exceeds tier-scaled max allocation
  const finalShares  = allocated > maxAlloc
    ? Math.max(100, Math.floor(maxAlloc / entry / 100) * 100)
    : lotShares;
  const finalAlloc   = finalShares * entry;
  const finalLots    = finalShares / 100;

  const gainT1  = dir === "BULLISH" ? (t1 - entry) * finalShares : (entry - t1) * finalShares;
  const gainT2  = dir === "BULLISH" ? (t2 - entry) * finalShares : (entry - t2) * finalShares;
  const maxLoss = dir === "BULLISH" ? (sl - entry) * finalShares : (entry - sl) * finalShares;
  const pctRisk = (Math.abs(maxLoss) / MODAL_TOTAL) * 100;

  return { entry, finalLots, finalShares, finalAlloc, gainT1, gainT2, maxLoss, pctRisk, rr: Number(rec.risk_reward) || 0, sizeMult };
}

function BrokerCodeBadge({ code }: { code: string }) {
  return <span style={{ fontSize: 13, fontWeight: 800, color: getBrokerColors(code).text }}>{code}</span>;
}

const TIER_META: Record<string, { label: string; color: string; bg: string; border: string }> = {
  S:     { label: "S · Smart Money", color: "#f7c948", bg: "rgba(247,201,72,0.12)",  border: "rgba(247,201,72,0.4)" },
  A:     { label: "A",               color: "#34d399", bg: "rgba(52,211,153,0.12)",  border: "rgba(52,211,153,0.4)" },
  B:     { label: "B",               color: "#60a5fa", bg: "rgba(96,165,250,0.12)",  border: "rgba(96,165,250,0.4)" },
  C:     { label: "C · Sized Down",  color: "#f0883e", bg: "rgba(240,136,62,0.12)",  border: "rgba(240,136,62,0.4)" },
  AVOID: { label: "AVOID",           color: "#f87171", bg: "rgba(248,113,113,0.14)", border: "rgba(248,113,113,0.5)" },
};

function ConvictionTierBadge({ tier, reason }: { tier?: string; reason?: string }) {
  if (!tier) return null;
  const m = TIER_META[tier] || TIER_META.B;
  return (
    <span title={reason || ""} style={{
      fontSize: 9, fontWeight: 800, padding: "2px 7px", borderRadius: 5,
      background: m.bg, color: m.color, border: `1px solid ${m.border}`, letterSpacing: "0.05em",
    }}>
      {m.label}
    </span>
  );
}

// ─── CSV export (opens directly in Excel — no library/build dependency) ────
function downloadCSV(filename: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const escape = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // BOM so Excel reads UTF-8 (accented/Indonesian text) correctly instead of mojibake
  const csv = "﻿" + [headers, ...rows].map(r => r.map(escape).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function ExportButton({ onClick, label = "Export Excel" }: { onClick: () => void; label?: string }) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 7,
      background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.35)",
      color: "#34d399", fontSize: 12, fontWeight: 800, cursor: "pointer",
    }}>
      📥 {label}
    </button>
  );
}

function fmtM(val: number) {
  const abs = Math.abs(val);
  if (abs >= 1_000_000) return `${val >= 0 ? "+" : ""}${(val/1_000_000).toFixed(2)}M`;
  if (abs >= 1_000)     return `${val >= 0 ? "+" : ""}${(val/1_000).toFixed(0)}K`;
  return `${val >= 0 ? "+" : ""}${val.toFixed(0)}`;
}

// ─── Conviction Breakdown Tooltip ────────────────────────────
function ConvictionBreakdown({ bd, score }: { bd: any; score: number }) {
  if (!bd) return null;
  const layers = [
    { key: "market_structure", label: "Market Structure", max: 5,  icon: "📊", color: "#60a5fa" },
    { key: "wyckoff",          label: "Wyckoff Phase",    max: 10, icon: "🌊", color: "#a78bfa" },
    { key: "smc",              label: "SMC (OB+FVG+Sweep)",max: 20,icon: "🎯", color: "#f59e0b" },
    { key: "harmonic",         label: "Harmonic Pattern", max: 20, icon: "✨",   color: "#34d399" },
    { key: "volume_profile",   label: "Volume Profile",   max: 20, icon: "📈", color: "#38bdf8" },
    { key: "broker_flow",      label: "Broker Flow",      max: 20, icon: "🏦", color: "#10b981" },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 160 }}>
      <div style={{ fontSize: 9, fontWeight: 800, color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 2 }}>CONVICTION LAYERS</div>
      {layers.map(l => {
        const val = bd[l.key] || 0;
        const pct = (val / l.max) * 100;
        return (
          <div key={l.key} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontSize: 9, width: 12 }}>{l.icon}</span>
            <div style={{ flex: 1, height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ width: `${pct}%`, height: "100%", background: l.color, borderRadius: 2, transition: "width 0.5s" }} />
            </div>
            <span style={{ fontSize: 9, fontWeight: 700, color: l.color, width: 18, textAlign: "right" }}>{val}</span>
          </div>
        );
      })}
      <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 3, marginTop: 2 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 9, color: "var(--text-muted)" }}>TOTAL</span>
          <span style={{ fontSize: 11, fontWeight: 900, color: score >= 70 ? "#10b981" : score >= 50 ? "#f59e0b" : "#f87171" }}>{score}/100</span>
        </div>
      </div>
    </div>
  );
}

// ─── Wyckoff Phase Badge ───────────────────────────────────────
function WyckoffBadge({ wyckoff }: { wyckoff: any }) {
  if (!wyckoff || wyckoff.phase === 'UNKNOWN') return null;
  const phaseConfig: Record<string, { color: string; emoji: string }> = {
    SPRING:       { color: "#10b981", emoji: "🌱" },
    SOS:          { color: "#34d399", emoji: "🚀" },
    LPS:          { color: "#6ee7b7", emoji: "✔️" },
    ACCUMULATION: { color: "#60a5fa", emoji: "💧" },
    MARKUP:       { color: "#a78bfa", emoji: "⬆️" },
    UPTHRUST:     { color: "#f87171", emoji: "⚠️" },
    DISTRIBUTION: { color: "#fb923c", emoji: "📦" },
    RANGING:      { color: "#6b7280", emoji: "⇄" },
  };
  const cfg = phaseConfig[wyckoff.phase] || { color: "#6b7280", emoji: "⬤" };
  return (
    <span style={{ fontSize: 8, fontWeight: 800, padding: "2px 5px", borderRadius: 4,
      color: cfg.color, background: `${cfg.color}18`, border: `1px solid ${cfg.color}30` }}>
      {cfg.emoji} {wyckoff.phase}
    </span>
  );
}

// ─── SMC Badges ───────────────────────────────────────────────
function SMCBadges({ breakdown }: { breakdown: any }) {
  if (!breakdown) return null;
  return (
    <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
      {breakdown.in_order_block && (
        <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 4px", borderRadius: 3,
          color: "#f59e0b", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.25)" }}>
          🎯 OB
        </span>
      )}
      {breakdown.in_fvg && (
        <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 4px", borderRadius: 3,
          color: "#38bdf8", background: "rgba(56,189,248,0.12)", border: "1px solid rgba(56,189,248,0.25)" }}>
          ⚡ FVG
        </span>
      )}
      {breakdown.liquidity_sweep && (
        <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 4px", borderRadius: 3,
          color: "#c084fc", background: "rgba(192,132,252,0.12)", border: "1px solid rgba(192,132,252,0.25)" }}>
          🌀 Sweep
        </span>
      )}
    </div>
  );
}

// ─── Volume Profile Mini Bar ───────────────────────────────────
function VolumeProfileBar({ vp, entry, direction }: { vp: any; entry: number; direction: string }) {
  if (!vp) return null;
  const isNearPOC = vp.at_poc;
  const isNearVA  = vp.at_value_area_edge;
  const aboveVWAP = vp.above_vwap;
  return (
    <div style={{ display: "flex", gap: 3, flexWrap: "wrap", alignItems: "center" }}>
      {isNearPOC && (
        <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 4px", borderRadius: 3,
          color: "#fb923c", background: "rgba(251,146,60,0.12)", border: "1px solid rgba(251,146,60,0.25)" }}>
          🟠 POC
        </span>
      )}
      {isNearVA && (
        <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 4px", borderRadius: 3,
          color: "#fbbf24", background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.25)" }}>
          🟡 VA Edge
        </span>
      )}
      <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 4px", borderRadius: 3,
        color: aboveVWAP ? "#34d399" : "#f87171",
        background: aboveVWAP ? "rgba(52,211,153,0.1)" : "rgba(248,113,113,0.1)",
        border: `1px solid ${aboveVWAP ? "rgba(52,211,153,0.2)" : "rgba(248,113,113,0.2)"}` }}>
        {aboveVWAP ? "⬆ VWAP" : "⬇ VWAP"}
      </span>
      {vp.poc && <span style={{ fontSize: 8, color: "var(--text-muted)" }}>POC:{vp.poc?.toLocaleString("id-ID")}</span>}
    </div>
  );
}

function XABCDMiniChart({ data, direction }: { data: any; direction: string }) {
  if (!data?.X || !data?.D) return null;
  const pts = ["X","A","B","C","D"].map((k: string) => data[k]?.price).filter(Boolean);
  if (pts.length < 5) return null;
  const W = 120, H = 50, pad = 6;
  const min = Math.min(...pts), max = Math.max(...pts), range = max - min || 1;
  const coords = pts.map((p: number, i: number) => ({
    x: pad + (i / 4) * (W - pad * 2),
    y: pad + (1 - (p - min) / range) * (H - pad * 2),
  }));
  const color = direction === "BULLISH" ? "#34d399" : "#f87171";
  const pathD = coords.map((c: any, i: number) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");
  const labels = ["X","A","B","C","D"];
  return (
    <div style={{ width: W, height: H + 16, overflow: "hidden" }}>
      <svg width={W} height={H + 16} viewBox={`0 0 ${W} ${H + 16}`} style={{ overflow: "hidden", display: "block" }}>
        <path d={pathD} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
        {coords.map((c: any, i: number) => (
          <g key={i}>
            <circle cx={c.x} cy={c.y} r={3} fill={color} />
            <text x={c.x} y={c.y - 5} textAnchor="middle" fontSize={8} fill={color} fontWeight="bold">{labels[i]}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function BollingerSparkline({ data, direction }: { data: any[]; direction: string }) {
  // Guard against malformed points (NaN/Infinity from a degenerate stddev, a
  // single-point series dividing by data.length-1===0, etc.) blowing up the
  // coordinate math and rendering way outside the SVG's intended box — seen
  // with certain US tickers' bb_data. Filtering + clamping here means a bad
  // data point just gets dropped instead of stretching the whole chart huge.
  const clean = (data || []).filter(d =>
    Number.isFinite(d?.upper) && Number.isFinite(d?.lower) && Number.isFinite(d?.close) && Number.isFinite(d?.sma)
  );
  if (clean.length < 2) return null;
  data = clean;
  const W = 160, H = 50, pad = 6;

  const min = Math.min(...data.map(d => d.lower));
  const max = Math.max(...data.map(d => d.upper));
  const range = (max - min) > 0.01 ? (max - min) : 1;

  const clampPx = (v: number) => Math.max(-1000, Math.min(1000, v));
  const getX = (i: number) => clampPx(pad + (i / (data.length - 1)) * (W - pad * 2));
  const getY = (v: number) => clampPx(pad + (1 - (v - min) / range) * (H - pad * 2));

  const upperPts = data.map((d, i) => `${getX(i).toFixed(1)},${getY(d.upper).toFixed(1)}`).join(" ");
  // lowerPtsRev goes right-to-left
  const lowerPtsRev = [...data].reverse().map((d, i) => `${getX(data.length - 1 - i).toFixed(1)},${getY(d.lower).toFixed(1)}`).join(" ");
  
  const closePath = "M " + data.map((d, i) => `${getX(i).toFixed(1)} ${getY(d.close).toFixed(1)}`).join(" L ");
  const smaPath = "M " + data.map((d, i) => `${getX(i).toFixed(1)} ${getY(d.sma).toFixed(1)}`).join(" L ");

  const color = direction === "BULLISH" ? "#34d399" : "#f87171";
  const bbFill = "rgba(139,148,158,0.12)";
  const bbStroke = "rgba(139,148,158,0.3)";

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: W, height: H + 16, overflow: "hidden" }}>
      <svg width={W} height={H + 16} viewBox={`0 0 ${W} ${H + 16}`} style={{ overflow: "hidden", display: "block" }}>
        <polygon points={`${upperPts} ${lowerPtsRev}`} fill={bbFill} />
        <path d={"M " + data.map((d, i) => `${getX(i).toFixed(1)} ${getY(d.upper).toFixed(1)}`).join(" L ")} fill="none" stroke={bbStroke} strokeWidth={1} strokeDasharray="2 2" />
        <path d={"M " + data.map((d, i) => `${getX(i).toFixed(1)} ${getY(d.lower).toFixed(1)}`).join(" L ")} fill="none" stroke={bbStroke} strokeWidth={1} strokeDasharray="2 2" />
        <path d={smaPath} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth={1.5} strokeDasharray="4 2" />
        <path d={closePath} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
        <circle cx={getX(data.length - 1)} cy={getY(data[data.length - 1].close)} r={3} fill={color} />
        <text x={W/2} y={H + 14} textAnchor="middle" fontSize={9} fill="var(--text-muted)" fontWeight="700">Bollinger 30D</text>
      </svg>
    </div>
  );
}

function ConvictionRing({ score }: { score: number }) {
  const color = score >= 70 ? "#10b981" : score >= 55 ? "#f59e0b" : "#6b7280";
  const deg = score * 3.6;
  return (
    <div style={{ position: "relative", width: 48, height: 48 }}>
      <svg width={48} height={48} viewBox="0 0 48 48" style={{ transform: "rotate(-90deg)" }}>
        <circle cx={24} cy={24} r={20} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={5} />
        <circle cx={24} cy={24} r={20} fill="none" stroke={color} strokeWidth={5}
          strokeDasharray={`${deg * 125.6 / 360} 125.6`} strokeLinecap="round" />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 12, fontWeight: 800, color }}>
        {score}
      </div>
    </div>
  );
}

function WinRateGauge({ rate }: { rate: number }) {
  const color = rate >= 60 ? "#10b981" : rate >= 45 ? "#f59e0b" : "#f87171";
  const deg = Math.min(rate, 100) * 1.8;
  const ex = 60 + 50 * Math.cos(Math.PI - deg * Math.PI / 180);
  const ey = 60 - 50 * Math.sin(Math.PI - deg * Math.PI / 180);
  return (
    <div style={{ textAlign: "center" }}>
      <svg width={120} height={65} viewBox="0 0 120 65">
        <path d="M 10 60 A 50 50 0 0 1 110 60" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={10} />
        <path d={`M 10 60 A 50 50 0 ${rate > 50 ? 1 : 0} 1 ${ex.toFixed(1)} ${ey.toFixed(1)}`}
          fill="none" stroke={color} strokeWidth={10} strokeLinecap="round" />
        <text x={60} y={52} textAnchor="middle" fontSize={20} fontWeight={800} fill={color}>{rate}%</text>
        <text x={60} y={64} textAnchor="middle" fontSize={9} fill="#6b7280">WIN RATE</text>
      </svg>
    </div>
  );
}

function HarmonicTab({ apiBase }: { apiBase: string }) {
  const [scanResult, setScanResult] = useState<any>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [recs, setRecs] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [recsTab, setRecsTab] = useState<"scan" | "journal" | "stats" | "bot" | "picks" | "backtest">("scan");
  const [picks, setPicks] = useState<any[]>([]);
  const [picksScanDate, setPicksScanDate] = useState("");
  const [picksLoading, setPicksLoading] = useState(false);
  const [picksWinRate, setPicksWinRate] = useState<any>(null);
  const [simStatus, setSimStatus] = useState<any>(null);
  const [btRuns, setBtRuns] = useState<any[]>([]);
  const [btRunning, setBtRunning] = useState(false);
  const [btProgress, setBtProgress] = useState<any>(null);
  const [btMinScore, setBtMinScore] = useState<number>(60);
  const [btResults, setBtResults] = useState<any>(null);
  const [btStats, setBtStats] = useState<any>(null);
  const [btStartDate, setBtStartDate] = useState("2026-05-01");
  const [btEndDate, setBtEndDate] = useState("2026-05-31");
  const [btActiveRunId, setBtActiveRunId] = useState<string|null>(null);
  const [scannerMsg, setScannerMsg] = useState("");
  const [trackedPickTickers, setTrackedPickTickers] = useState<Set<string>>(new Set());
  const [trackingPickTicker, setTrackingPickTicker] = useState<string | null>(null);
  const [simRunning, setSimRunning] = useState(false);
  const [livePrices, setLivePrices] = useState<Record<string, { price: number; marketTime: number | null }>>({});
  const [livePricesAt, setLivePricesAt] = useState<number | null>(null);

  const loadPicks = async () => {
    if (recsTab !== "picks") return;
    setPicksLoading(true);
    try {
      const [pr, wr, sr] = await Promise.all([
        fetch(`${apiBase}/api/daily-picks`).then(r => r.json()),
        fetch(`${apiBase}/api/daily-picks/winrate`).then(r => r.json()),
        fetch(`${apiBase}/api/scanner/simulation-status`).then(r => r.json()),
      ]);
      setPicks(pr.data || []);
      setPicksScanDate(pr.date || "");
      setPicksWinRate(wr);
      setSimStatus(sr);
    } catch (err) {
      console.error("Failed to load picks:", err);
    } finally { setPicksLoading(false); }
  };
  const runScanner = async () => {
    setScannerMsg("🔍 Scanning...");
    try {
      const r = await fetch(`${apiBase}/api/daily-picks/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const j = await r.json();
      setScannerMsg("✅ Done!");
      if (j.total !== undefined) setScannerMsg(`✅ ${j.total} picks for ${j.date}`);
      loadPicks();
    } catch (err) {
      setScannerMsg("❌ Scan gagal");
    }
  };
  const trackPick = async (ticker: string) => {
    if (trackedPickTickers.has(ticker) || trackingPickTicker) return;
    setTrackingPickTicker(ticker);
    try {
      const res = await fetch(`${apiBase}/api/daily-picks/track`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker }),
      });
      const json = await res.json();
      if (json.success) setTrackedPickTickers(prev => new Set(prev).add(ticker));
    } catch (err) {
      console.error("Failed to track pick:", err);
    } finally {
      setTrackingPickTicker(null);
    }
  };
  const runBacktest = async () => {
    setBtRunning(true); setBtResults(null); setBtStats(null);
    try {
      const res = await fetch(`${apiBase}/api/backtest/run`, {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ startDate: btStartDate, endDate: btEndDate, min_score: btMinScore })
      });
      const data = await res.json();
      if (data.run_id) {
        setBtActiveRunId(data.run_id);
        const poll = setInterval(async () => {
          try {
            const sr = await fetch(`${apiBase}/api/backtest/status/${data.run_id}`);
            const st = await sr.json();
            setBtProgress(st.progress);
            if (st.status === 'DONE' || st.status === 'ERROR') {
              clearInterval(poll);
              setBtRunning(false);
              if (st.status === 'DONE') {
                loadBacktestResults(data.run_id);
                loadBacktestRuns();
              }
            }
          } catch { /* ignore poll errors */ }
        }, 3000);
      }
    } catch { setBtRunning(false); }
  };
  const loadBacktestResults = async (runId: string) => {
    try {
      const [rRes, sRes] = await Promise.all([
        fetch(`${apiBase}/api/backtest/results/${runId}`),
        fetch(`${apiBase}/api/backtest/stats/${runId}`)
      ]);
      setBtResults(await rRes.json());
      setBtStats(await sRes.json());
      setBtActiveRunId(runId);
    } catch {}
  };
  const loadBacktestRuns = async () => {
    try {
      const r = await fetch(`${apiBase}/api/backtest/runs`);
      setBtRuns(await r.json());
    } catch {}
  };

  const deleteBacktestRun = async (runId: string) => {
    if (!confirm('Hapus hasil backtest ini?')) return;
    try {
      await fetch(`${apiBase}/api/backtest/${runId}`, { method: 'DELETE' });
      if (btActiveRunId === runId) {
        setBtActiveRunId(null);
        setBtResults([]);
        setBtStats(null);
      }
      loadBacktestRuns();
    } catch (e) {
      alert("Gagal menghapus");
    }
  };
  const [minScore, setMinScore] = useState(50);
  const [minRR, setMinRR] = useState(1.5);
  const [saving, setSaving] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [bulkSaving, setBulkSaving] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [bulkMsg, setBulkMsg] = useState("");
  const [market, setMarket] = useState<"IDX" | "CRYPTO" | "US">("IDX");
  const [journalMarket, setJournalMarket] = useState<"ALL" | "IDX" | "CRYPTO" | "US">("ALL");
  const [selectedRecs, setSelectedRecs] = useState<Set<number>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [openSortCol, setOpenSortCol] = useState<string>("");
  const [openSortAsc, setOpenSortAsc] = useState(true);
  const [searchTicker, setSearchTicker] = useState("");
  const [scanWeights, setScanWeights] = useState<Record<string, number>>({ harmonic: 20, wyckoff: 15, smc: 20, volume_profile: 15, broker_flow: 30 });
  const [defaultWeights, setDefaultWeights] = useState<Record<string, number>>({ harmonic: 20, wyckoff: 15, smc: 20, volume_profile: 15, broker_flow: 30 });
  const [showWeights, setShowWeights] = useState(false);
  const [weightsSaving, setWeightsSaving] = useState(false);
  const [weightsMsg, setWeightsMsg] = useState("");
  const [wrPeriod, setWrPeriod] = useState<"ALL" | "THIS_MONTH" | "LAST_MONTH" | "CUSTOM">("ALL");
  const [wrStart, setWrStart] = useState("");
  const [wrEnd, setWrEnd] = useState("");
  const [botStatus, setBotStatus] = useState<any>(null);
  const [botPicks, setBotPicks] = useState<any[]>([]);
  const [botRunning, setBotRunning] = useState(false);
  const [botMarket, setBotMarket] = useState("IDX");
  const [botWinrate, setBotWinrate] = useState<any>(null);

  const loadBotStatus = useCallback(async () => {
    try {
      const safeJson = async (url: string, fallback: any) => {
        try {
          const r = await fetch(url);
          if (!r.ok) return fallback;
          return await r.json();
        } catch { return fallback; }
      };
      const [s, p, w] = await Promise.all([
        safeJson(`${apiBase}/api/auto-journal/status`, { running: false, enabled: false }),
        safeJson(`${apiBase}/api/auto-journal/picks`,  { picks: [] }),
        safeJson(`${apiBase}/api/auto-journal/winrate`, null),
      ]);
      setBotStatus(s);
      setBotPicks(p.picks || []);
      setBotWinrate(w);
    } catch {}
  }, [apiBase]);

  // Load scan weights on mount
  useEffect(() => {
    fetch(`${apiBase}/api/scan-weights`).then(r => r.json()).then(d => {
      if (d.weights) setScanWeights(d.weights);
      if (d.defaults) setDefaultWeights(d.defaults);
    }).catch(() => {});
  }, [apiBase]);

  const saveScanWeights = async () => {
    setWeightsSaving(true); setWeightsMsg("");
    try {
      const r = await fetch(`${apiBase}/api/scan-weights`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scanWeights),
      });
      const d = await r.json();
      if (d.success) setWeightsMsg("✅ Weights saved!");
      else setWeightsMsg(`❌ ${d.error}`);
    } catch { setWeightsMsg("❌ Failed"); }
    finally { setWeightsSaving(false); setTimeout(() => setWeightsMsg(""), 3000); }
  };

  const runBot = async () => {
    setBotRunning(true);
    try {
      // Trigger full scan and save for the selected market
      await fetch(`${apiBase}/api/scanner/run?market=${botMarket}`, { method: 'POST' });
      // Poll for completion
      const poll = setInterval(async () => {
        const s = await fetch(`${apiBase}/api/auto-journal/status?market=${botMarket}`).then(r => r.json());
        setBotStatus(s);
        if (!s.running && !s.scanning) {
          clearInterval(poll);
          setBotRunning(false);
          await loadBotStatus();
          await loadJournal();
        }
      }, 4000);
    } catch { setBotRunning(false); }
  };


  const loadJournal = useCallback(async () => {
    try {
      const [r1, r2] = await Promise.all([
        fetch(`${apiBase}/api/recommendations?exclude_summary=1&limit=200`).then(r => r.json()),
        fetch(`${apiBase}/api/recommendations/stats`).then(r => r.json()),
      ]);
      setRecs(r1.data || []);
      setStats(r2);
    } catch {}
  }, [apiBase]);

  useEffect(() => {
    loadJournal();
    loadBotStatus();
  }, [loadJournal, loadBotStatus]);

  // Poll live intraday prices for open positions while the Journal tab is visible
  useEffect(() => {
    if (recsTab !== "journal") return;
    const openTickers = [...new Set(
      recs.filter((r: any) => r.ticker !== "SUMMARY" && r.pattern_type !== "MONTHLY" && r.status === "OPEN")
          .map((r: any) => r.ticker)
    )];
    if (openTickers.length === 0) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch(`${apiBase}/api/live-prices?tickers=${openTickers.join(",")}`).then(res => res.json());
        if (!cancelled && r.prices) {
          setLivePrices(prev => ({ ...prev, ...r.prices }));
          setLivePricesAt(Date.now());
        }
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 30000); // every 30s
    return () => { cancelled = true; clearInterval(interval); };
  }, [recsTab, recs, apiBase]);

  const runScan = async () => {
    setScanning(true);
    setScanError("");
    setBulkMsg("");
    setScanResult(null);
    try {
      const endpoint = market === "CRYPTO"
        ? `${apiBase}/api/harmonic-scan-crypto?min_score=${minScore}&min_rr=${minRR}`
        : `${apiBase}/api/harmonic-scan?market=${market}&min_score=${minScore}&min_rr=${minRR}`;
      const r = await fetch(endpoint);
      const d = await r.json();
      
      // If scan is running in background, poll until complete
      if (d.scanning) {
        setScanError(`⏳ ${d.message || 'Scanning in background...'}`);
        const poll = setInterval(async () => {
          try {
            const pr = await fetch(endpoint);
            const pd = await pr.json();
            if (pd.scanning) {
              setScanError(`⏳ Scanning... ${pd.progress || ''}`);
            } else {
              clearInterval(poll);
              setScanResult({ ...pd, market });
              setScanError("");
              setScanning(false);
            }
          } catch { /* ignore poll errors */ }
        }, 10000);
        return; // don't setScanning(false) yet
      }
      
      setScanResult({ ...d, market });
    } catch {
      setScanError("Scan gagal — cek koneksi server");
    } finally {
      if (!scanning) setScanning(false);
    }
  };

  const saveToJournal = async (pattern: any) => {
    const key = `${pattern.ticker}-${pattern.direction}-${pattern.pattern_type}`;
    setSaving(key);
    try {
      await fetch(`${apiBase}/api/recommendations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: pattern.ticker,
          pattern_type: pattern.pattern_type,
          direction: pattern.direction,
          detected_date: pattern.D_date,
          entry_min: pattern.entry_min,
          entry_max: pattern.entry_max,
          stop_loss: pattern.stop_loss,
          target_1: pattern.target_1,
          target_2: pattern.target_2,
          risk_reward: pattern.risk_reward,
          conviction_score: pattern.conviction_score,
          smart_money_confirmed: pattern.smart_money_confirmed,
          foreign_3d_B: pattern.foreign_3d_B,
          pattern_data: pattern.pattern_data,
          market_type: market,
        }),
      });
      setSavedIds(prev => new Set([...prev, key]));
      await loadJournal();
    } finally {
      setSaving(null);
    }
  };

  const bulkSaveAll = async () => {
    if (!scanResult?.results?.length) return;
    setBulkSaving(true);
    setBulkMsg("");
    try {
      const r = await fetch(`${apiBase}/api/recommendations/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patterns: scanResult.results, market_type: market }),
      });
      const d = await r.json();
      setBulkMsg(`✓ Saved ${d.saved} patterns${d.skipped ? `, ${d.skipped} skipped (duplikat)` : ""}`);
      const allKeys = new Set(scanResult.results.map((p: any) => `${p.ticker}-${p.direction}-${p.pattern_type}`));
      setSavedIds(allKeys as Set<string>);
      await loadJournal();
      setRecsTab("journal");
    } finally {
      setBulkSaving(false);
    }
  };

  const triggerStatusUpdate = async () => {
    setUpdatingStatus(true);
    try {
      await fetch(`${apiBase}/api/recommendations/update-statuses`, { method: "POST" });
      await loadJournal();
    } finally {
      setUpdatingStatus(false);
    }
  };

  const updateStatus = async (id: number, status: string) => {
    await fetch(`${apiBase}/api/recommendations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await loadJournal();
  };

  /**
   * Delete rows from the journal.
   *
   * This one is server-side and permanent — there is no undo, unlike the
   * local trade journal. It also edits the denominator of the win rate on the
   * Stats tab, which is why the confirm step says so: deleting the losers is
   * the easiest way in this whole application to make the system look good.
   */
  const deleteRecs = async (ids: number[]) => {
    if (!ids.length) return;

    // A FILE ON DISK BEFORE ANYTHING IS DESTROYED.
    //
    // On 2026-08-07 this table went from 52 rows to 0 within ten minutes of
    // this button shipping, and it was only recoverable because MySQL happened
    // to have ROW binlog enabled. That is luck, not a recovery plan. These rows
    // are the entire forward record of what the engine predicted and what
    // actually happened — there is no backtest that can regenerate them, and
    // re-POSTing would mint new ids and new created_at values, so a restore
    // through the API produces a journal whose timestamps are fiction.
    //
    // So the browser writes a full snapshot of exactly what is about to be
    // deleted, first, and a failure to write it aborts the delete.
    const doomed = recs.filter((r: any) => ids.includes(r.id));
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const blob = new Blob([JSON.stringify(doomed, null, 2)], { type: "application/json" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url;
      a.download = `ft-recommendations-deleted-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e: any) {
      setDeleteError(`Backup gagal dibuat — tidak jadi menghapus. (${e?.message || e})`);
      setConfirmDelete(false);
      return;
    }

    setDeleting(true);
    const failed: number[] = [];
    for (const id of ids) {
      try {
        const r = await fetch(`${apiBase}/api/recommendations/${id}`, { method: "DELETE" });
        if (!r.ok) failed.push(id);
      } catch { failed.push(id); }
    }
    setDeleting(false);
    setConfirmDelete(false);
    // Keep anything that did NOT delete selected, so a partial failure is
    // visible and retryable instead of silently leaving rows behind.
    setSelectedRecs(new Set(failed));
    setDeleteError(failed.length ? `${failed.length} baris gagal dihapus — masih terpilih, coba lagi.` : null);
    await loadJournal();
  };

  return (
    <div>
      {/* ── Workflow Guide Banner ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginBottom: 16 }}>
        {[
          { step: "1", icon: "🌅", time: "Sebelum 09:00", label: "Scan Patterns", desc: "Run scan, pilih conviction tinggi", color: "#6366f1" },
          { step: "2", icon: "💾", time: "09:00 – 09:30", label: "Save ke Journal", desc: "Klik 'Save All' atau pilih manual", color: "#3b82f6" },
          { step: "3", icon: "📈", time: "09:30 – 16:00", label: "Trading", desc: "Entry di zona, pantau SL & T1/T2", color: "#10b981" },
          { step: "4", icon: "📊", time: "Setelah 16:00", label: "Evaluasi", desc: "Klik Update Status → lihat Win Rate", color: "#f59e0b" },
        ].map(s => (
          <div key={s.step} style={{ padding: "10px 14px", background: `${s.color}10`, border: `1px solid ${s.color}30`, borderRadius: 10, borderLeft: `3px solid ${s.color}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: 16 }}>{s.icon}</span>
              <span style={{ fontSize: 9, fontWeight: 800, color: s.color, letterSpacing: "0.06em" }}>STEP {s.step} · {s.time}</span>
            </div>
            <div style={{ fontSize: 11, fontWeight: 800, color: "var(--text-primary)", marginBottom: 2 }}>{s.label}</div>
            <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{s.desc}</div>
          </div>
        ))}
      </div>

      {/* Sub-tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20, background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 10, padding: 3 }}>
        {([
          { key: "scan",    label: "Pattern Scan",  icon: "🔷" },
          { key: "journal", label: "Trade Journal", icon: "📋" },
          { key: "stats",   label: "Win Rate",      icon: "📊" },
          { key: "bot",     label: (botStatus?.running || botRunning) ? "Running..." : "Auto Bot", icon: "🤖" },
          { key: "picks",    label: "Daily Picks",   icon: "🎯" },
          { key: "backtest", label: "Backtest",       icon: "📊" },
        ] as const).map(({ key, label, icon }) => (
          <button key={key} onClick={() => { setRecsTab(key as any); if (key === "bot") loadBotStatus(); if (key === "picks" || key === "backtest") loadPicks(); if (key === "backtest") loadBacktestRuns(); }} style={{
            padding: "7px 10px", borderRadius: 7, border: "none", cursor: "pointer",
            fontSize: 11, fontWeight: 700, flex: 1,
            background: recsTab === key
              ? key === "bot" ? "linear-gradient(135deg,#10b981,#059669)" : "linear-gradient(135deg,#6366f1,#8b5cf6)"
              : "transparent",
            color: recsTab === key ? "#fff" : key === "bot" ? "#10b981" : "var(--text-muted)",
            transition: "all 0.2s",
          }}>{icon} {label}</button>
        ))}
      </div>

      {/* ── BOT TAB ── */}
      {recsTab === "bot" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Bot Market Toggle */}
          <div style={{ display: "flex", gap: 10, marginBottom: -4 }}>
            {(["IDX", "CRYPTO"] as const).map(m => (
              <button key={m} onClick={() => setBotMarket(m)} style={{
                padding: "8px 20px", borderRadius: 20, border: "none", cursor: "pointer",
                fontSize: 12, fontWeight: 800,
                background: botMarket === m ? "linear-gradient(135deg,#10b981,#059669)" : "var(--bg-secondary)",
                color: botMarket === m ? "#fff" : "var(--text-muted)",
              }}>
                {m === "IDX" ? "🇮🇩 IDX Market" : "🌐 Crypto Market"}
              </button>
            ))}
          </div>

          {/* Bot Hero */}
          <div style={{ padding: "20px 24px", background: "linear-gradient(135deg, rgba(16,185,129,0.08), rgba(5,150,105,0.04))",
            border: "1px solid rgba(16,185,129,0.25)", borderRadius: 16, position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: -20, right: -20, fontSize: 80, opacity: 0.05 }}>🤖</div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 18, fontWeight: 900, color: "#10b981", marginBottom: 4 }}>🤖 AutoTrader Bot</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                  Bot jalan <strong style={{ color: "#fff" }}>seolah-olah lo sendiri yang trading</strong>.
                  Setiap hari jam 08:00 WIB, bot scan ~116 saham IDX, pilih top 5 terbaik, dan auto-journal.
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {[["Min Conviction","55+"],["Max Posisi","5 saham"],["Modal","Rp 100 juta"],["Risk/Trade","2% = Rp 2 juta"],["Jadwal","08:00 WIB"]].map(([k,v]) => (
                    <div key={k} style={{ padding: "4px 10px", background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.15)", borderRadius: 6 }}>
                      <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{k}: </span>
                      <span style={{ fontSize: 11, fontWeight: 800, color: "#10b981" }}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ textAlign: "center", flexShrink: 0 }}>
                <div style={{ width: 12, height: 12, borderRadius: "50%",
                  background: botStatus?.running || botRunning ? "#f59e0b" : botStatus?.enabled ? "#10b981" : "#6b7280",
                  boxShadow: botStatus?.running || botRunning ? "0 0 12px #f59e0b" : botStatus?.enabled ? "0 0 12px #10b981" : "none",
                  display: "inline-block", marginBottom: 4 }} />
                <div style={{ fontSize: 9, color: "var(--text-muted)", display: "block" }}>
                  {botStatus?.running || botRunning ? "SCANNING" : botStatus?.enabled ? "AKTIF" : "PAUSED"}
                </div>
              </div>
            </div>
          </div>

          {/* Stats */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <div style={{ padding: "14px", background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 12, textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 700, marginBottom: 4 }}>NEXT AUTO-RUN</div>
              <div style={{ fontSize: 12, fontWeight: 800, color: "#10b981" }}>
                {botStatus?.nextRun ? new Date(botStatus.nextRun).toLocaleString("id-ID", { weekday:"short", hour:"2-digit", minute:"2-digit", timeZone:"Asia/Jakarta" }) + " WIB" : "–"}
              </div>
            </div>
            <div style={{ padding: "14px", background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 12, textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 700, marginBottom: 4 }}>LAST RUN</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-primary)" }}>
                {botStatus?.lastResult ? `${botStatus.lastResult.saved} saved / ${botStatus.lastResult.filtered} filtered` : "Belum run"}
              </div>
            </div>
            <div style={{ padding: "14px", background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 12, textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 700, marginBottom: 4 }}>BOT WIN RATE</div>
              <div style={{ fontSize: 22, fontWeight: 900, color:
                (botWinrate?.overall?.winRate ?? 0) >= 60 ? "#10b981" :
                (botWinrate?.overall?.winRate ?? 0) >= 45 ? "#f59e0b" : "#f87171" }}>
                {botWinrate?.overall?.winRate != null ? `${botWinrate.overall.winRate}%` : "N/A"}
              </div>
              <div style={{ fontSize: 9, color: "var(--text-muted)" }}>{botWinrate?.overall?.closed || 0} closed trades</div>
            </div>
          </div>

          {/* Run Now */}
          <button onClick={runBot} disabled={botRunning || botStatus?.running} style={{
            padding: "12px 20px", borderRadius: 10, border: "none",
            cursor: botRunning || botStatus?.running ? "not-allowed" : "pointer",
            background: botRunning || botStatus?.running ? "rgba(16,185,129,0.2)" : "linear-gradient(135deg,#10b981,#059669)",
            color: "#fff", fontSize: 13, fontWeight: 800,
            display: "flex", alignItems: "center", gap: 10,
            width: "fit-content", opacity: botRunning || botStatus?.running ? 0.7 : 1,
          }}>
            <span style={{ animation: botRunning || botStatus?.running ? "spin 1s linear infinite" : "none", display: "inline-block" }}>⟳</span>
            {botRunning || botStatus?.running ? "Bot sedang scan pasar (~60 detik)..." : "▶ Jalankan Bot Sekarang"}
          </button>

          {botPicks.length > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 800, color: "var(--text-primary)", marginBottom: 10 }}>
                📋 Pilihan Bot Hari Ini — {botPicks.length} saham
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {botPicks.map((p: any, i: number) => {
                  const meta = PATTERN_META[p.pattern_type] || PATTERN_META.ABCD;
                  const smTags = (p.smc_tags || "").split(",").filter(Boolean);
                  const isBull = p.direction === "BULLISH";
                  const accentColor = isBull ? "#34d399" : "#f87171";
                  const borderColor = isBull ? "rgba(52,211,153,0.25)" : "rgba(248,113,113,0.25)";

                  // Position sizing — modal Rp 100 juta, risk 2% = Rp 2 juta
                  const modal = 100_000_000;
                  const riskRp = modal * 0.02;
                  const entryPrice = Number(p.entry_min) || 0;
                  const slPrice   = Number(p.stop_loss)  || 0;
                  const t1Price   = Number(p.target_1)   || 0;
                  const t2Price   = Number(p.target_2)   || 0;
                  const rr        = Number(p.risk_reward) || 0;
                  const riskPerLembar = Math.abs(entryPrice - slPrice);
                  const lotSize = riskPerLembar > 0 ? Math.floor(riskRp / riskPerLembar / 100) : 0;
                  const lembar  = lotSize * 100;
                  const profitT1 = isBull ? (t1Price - entryPrice) * lembar : (entryPrice - t1Price) * lembar;
                  const profitT2 = isBull ? (t2Price - entryPrice) * lembar : (entryPrice - t2Price) * lembar;
                  const pctT1 = entryPrice > 0 ? Math.abs((t1Price - entryPrice) / entryPrice * 100) : 0;
                  const pctT2 = entryPrice > 0 ? Math.abs((t2Price - entryPrice) / entryPrice * 100) : 0;

                  // Signal age
                  const createdAt = p.created_at ? new Date(p.created_at) : null;
                  const ageHours  = createdAt ? Math.round((Date.now() - createdAt.getTime()) / 3600000) : null;
                  const ageLabel  = ageHours !== null ? (ageHours < 1 ? "Baru saja" : ageHours < 24 ? `${ageHours}j lalu` : `${Math.floor(ageHours/24)}h lalu`) : "";

                  const wyIcons: Record<string,string> = { SPRING:"🌱", ACCUMULATION:"📦", MARKUP:"🚀", DISTRIBUTION:"📤", MARKDOWN:"🔻", RANGING:"↔️", SIGN_OF_STRENGTH:"💪" };
                  const wyIcon = wyIcons[p.wyckoff_phase] || "🌊";

                  return (
                    <div key={p.id || i} style={{
                      padding: "16px 18px",
                      background: "var(--bg-secondary)",
                      border: `1px solid ${borderColor}`,
                      borderRadius: 14,
                      borderLeft: `4px solid ${accentColor}`,
                    }}>
                      {/* ROW 1: Header */}
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div>
                            <div style={{ fontSize: 17, fontWeight: 900, color: "var(--text-primary)", lineHeight: 1 }}>🤖 {p.ticker}</div>
                            <div style={{ fontSize: 9, color: accentColor, fontWeight: 800, marginTop: 2 }}>{isBull ? "▲" : "▼"} {p.direction}</div>
                          </div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                            <span style={{ padding: "2px 8px", borderRadius: 5, background: meta.bg, border: `1px solid ${meta.border}`, color: meta.color, fontSize: 10, fontWeight: 800 }}>{p.pattern_type}</span>
                            {p.wyckoff_phase && (
                              <span style={{ padding: "2px 7px", borderRadius: 5, background: "rgba(167,139,250,0.12)", border: "1px solid rgba(167,139,250,0.3)", color: "#a78bfa", fontSize: 9, fontWeight: 700 }}>
                                {wyIcon} {p.wyckoff_phase}
                              </span>
                            )}
                            {smTags.map((t: string) => (
                              <span key={t} style={{ padding: "2px 6px", borderRadius: 4, background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.25)", color: "#f59e0b", fontSize: 8, fontWeight: 800 }}>{t}</span>
                            ))}
                          </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          {ageLabel && <div style={{ fontSize: 9, color: "var(--text-muted)" }}>&#x1F550; {ageLabel}</div>}
                          <div style={{ textAlign: "center" }}>
                            <div style={{ fontSize: 20, fontWeight: 900, lineHeight: 1, color: p.conviction_score >= 70 ? "#10b981" : p.conviction_score >= 55 ? "#f59e0b" : "#94a3b8" }}>{p.conviction_score}</div>
                            <div style={{ fontSize: 8, color: "var(--text-muted)", fontWeight: 600 }}>SCORE</div>
                          </div>
                          <span style={{ fontSize: 9, padding: "3px 8px", borderRadius: 20, background: p.status === "OPEN" ? "rgba(96,165,250,0.12)" : "rgba(52,211,153,0.12)", color: p.status === "OPEN" ? "#60a5fa" : "#34d399", border: "1px solid rgba(96,165,250,0.3)", fontWeight: 800 }}>
                            {p.status}
                          </span>
                        </div>
                      </div>

                      <div style={{ display: "flex", gap: 24 }}>
                        <div>
                          <div style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 700, marginBottom: 2 }}>ENTRY ZONE</div>
                          <div style={{ fontSize: 12, fontWeight: 900, color: "var(--text-primary)" }}>{Number(p.entry_min)?.toLocaleString("id-ID")}</div>
                          <div style={{ fontSize: 9, color: "var(--text-muted)" }}>- {Number(p.entry_max)?.toLocaleString("id-ID")}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 700, marginBottom: 2 }}>LATEST CLOSE</div>
                          <div style={{ fontSize: 12, fontWeight: 900, color: "var(--text-primary)" }}>{Number(p.current_price)?.toLocaleString("id-ID") || "-"}</div>
                          <div style={{ fontSize: 9, fontWeight: 800, color: p.direction === "BULLISH" ? "#3fb950" : "#f85149" }}>
                            {p.current_price && p.entry_min ? 
                              (p.direction === "BULLISH" ? 
                                `+${(((p.target1 || p.target_1) - p.current_price)/p.current_price*100).toFixed(1)}% to TP1` : 
                                `+${((p.entry_min - p.current_price)/p.current_price*100).toFixed(1)}% to Entry`) 
                              : ""}
                          </div>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          {/* Rest of the component continues... */}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {botPicks.length === 0 && !botRunning && (
            <div style={{ textAlign: "center", padding: "40px 20px", background: "var(--bg-secondary)",
              border: "1px solid var(--border)", borderRadius: 12 }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>🤖</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>Bot Belum Run Hari Ini</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Klik tombol di atas untuk jalankan bot secara manual</div>
            </div>
          )}

          {/* Cara baca */}
          <div style={{ padding: "16px 20px", background: "rgba(16,185,129,0.03)",
            border: "1px solid rgba(16,185,129,0.12)", borderRadius: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: "#10b981", marginBottom: 10 }}>📖 CARA BACA HASIL</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {[
                ["🎯 Conviction Score (0-100)", "≥70 = langsung entry | 55-69 = wait konfirmasi | <55 = skip"],
                ["📐 R:R Ratio", "1:X = dapat X× profit vs risk. R:R ≥2 bagus, ≥3 excellent"],
                ["🌊 Wyckoff Phase", "SPRING/SOS = beli terbaik | ACCUMULATION = normal | UPTHRUST/DISTRIBUTION = jual"],
                ["🎯 SMC Badges", "OB = Order Block institusi | FVG = imbalance/gap | Sweep = stop hunt selesai"],
              ].map(([title, desc]) => (
                <div key={title} style={{ padding: "10px 12px", background: "var(--bg-secondary)", borderRadius: 8 }}>
                  <div style={{ fontWeight: 800, color: "var(--text-primary)", marginBottom: 4, fontSize: 11 }}>{title}</div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.4 }}>{desc}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── SCAN TAB ── */}
      {recsTab === "scan" && (
        <>
          {/* Market toggle + scan controls */}
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
            {/* Market selector */}
            <div style={{ display: "flex", background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 8, padding: 3, gap: 2 }}>
              {(["IDX","CRYPTO","US"] as const).map(m => (
                <button key={m} onClick={() => { setMarket(m); setScanResult(null); setBulkMsg(""); }}
                  style={{
                    padding: "6px 16px", borderRadius: 6, border: "none", cursor: "pointer",
                    fontSize: 12, fontWeight: 800,
                    background: market === m
                      ? m === "CRYPTO"
                        ? "linear-gradient(135deg, #f59e0b, #fbbf24)"
                        : m === "US"
                        ? "linear-gradient(135deg, #10b981, #34d399)"
                        : "linear-gradient(135deg, #3b82f6, #6366f1)"
                      : "transparent",
                    color: market === m ? (m === "CRYPTO" ? "#000" : "#fff") : "var(--text-muted)",
                    transition: "all 0.2s",
                  }}>
                  {m === "CRYPTO" ? "🪙 CRYPTO" : m === "US" ? "🇺🇸 US" : "🇮🇩 IDX"}
                </button>
              ))}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 14px" }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700 }}>MIN SCORE</span>
              <input type="number" value={minScore} min={20} max={90} step={5}
                onChange={e => setMinScore(Number(e.target.value))}
                style={{ width: 50, background: "transparent", border: "none", color: "var(--text-primary)", fontSize: 13, fontWeight: 700, outline: "none" }} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 14px" }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700 }}>MIN R:R</span>
              <input type="number" value={minRR} min={0.5} max={5} step={0.5}
                onChange={e => setMinRR(Number(e.target.value))}
                style={{ width: 50, background: "transparent", border: "none", color: "var(--text-primary)", fontSize: 13, fontWeight: 700, outline: "none" }} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 14px" }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700 }}>🔍</span>
              <input type="text" placeholder="Search Ticker..." value={searchTicker}
                onChange={e => setSearchTicker(e.target.value.toUpperCase())}
                style={{ width: 100, background: "transparent", border: "none", color: "var(--text-primary)", fontSize: 13, fontWeight: 700, outline: "none" }} />
            </div>
            <button onClick={runScan} disabled={scanning} style={{
              padding: "9px 24px", borderRadius: 8, border: "none", cursor: scanning ? "not-allowed" : "pointer",
              background: scanning ? "rgba(99,102,241,0.3)"
                : market === "CRYPTO"
                ? "linear-gradient(135deg, #f59e0b, #fbbf24)"
                : market === "US"
                ? "linear-gradient(135deg, #10b981, #34d399)"
                : "linear-gradient(135deg, #6366f1, #8b5cf6)",
              color: market === "CRYPTO" ? "#000" : "#fff",
              fontSize: 12, fontWeight: 800, opacity: scanning ? 0.7 : 1,
              display: "flex", alignItems: "center", gap: 8, transition: "all 0.2s",
            }}>
              <span style={{ display: "inline-block", animation: scanning ? "spin 1s linear infinite" : "none" }}>⟳</span>
              {scanning
                ? `Scanning ${market}...`
                : market === "CRYPTO" ? "🪙 Scan 25 Crypto" : market === "US" ? "🇺🇸 Scan 418 US Stocks" : "Scan 116 IDX Stocks"}
            </button>
            {scanResult?.found > 0 && (
              <button onClick={bulkSaveAll} disabled={bulkSaving} style={{
                padding: "9px 20px", borderRadius: 8, border: "none", cursor: bulkSaving ? "not-allowed" : "pointer",
                background: bulkSaving ? "rgba(16,185,129,0.3)" : "linear-gradient(135deg, #10b981, #34d399)",
                color: "#fff", fontSize: 12, fontWeight: 800, opacity: bulkSaving ? 0.7 : 1,
                display: "flex", alignItems: "center", gap: 6, transition: "all 0.2s",
              }}>
                {bulkSaving ? "⟳ Saving..." : `💾 Save All (${scanResult.found})`}
              </button>
            )}
            {scanResult && (
              <span style={{ fontSize: 11, color: bulkMsg ? "#34d399" : "var(--text-muted)" }}>
                {bulkMsg || `Scanned ${scanResult.scanned} · Found `}
                {!bulkMsg && <strong style={{ color: "var(--text-primary)" }}>{scanResult.found}</strong>}
                {!bulkMsg && " patterns"}
                {!bulkMsg && scanResult.usdIdr && <span style={{ color: "#f59e0b", marginLeft: 8 }}>USD/IDR: {scanResult.usdIdr?.toLocaleString("id-ID")}</span>}
              </span>
            )}
          </div>

          {/* Weights config toggle */}
          <div style={{ marginBottom: 16 }}>
            <button onClick={() => setShowWeights(!showWeights)} style={{
              padding: "7px 16px", borderRadius: 8, border: "1px solid rgba(139,92,246,0.3)",
              background: showWeights ? "rgba(139,92,246,0.15)" : "transparent",
              color: showWeights ? "#a78bfa" : "var(--text-muted)",
              fontSize: 11, fontWeight: 800, cursor: "pointer", transition: "all 0.2s",
              display: "flex", alignItems: "center", gap: 6,
            }}>
              ⚙️ Scoring Weights {showWeights ? "▲" : "▼"}
              <span style={{ fontSize: 10, fontWeight: 600, opacity: 0.7 }}>
                ({Object.values(scanWeights).reduce((a, b) => a + b, 0)}%)
              </span>
            </button>

            {showWeights && (
              <div style={{
                marginTop: 10, padding: "16px 20px", background: "var(--bg-secondary)",
                border: "1px solid rgba(139,92,246,0.2)", borderRadius: 12,
              }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700, marginBottom: 12 }}>
                  Atur bobot setiap layer filter. Total tidak harus 100% — akan di-normalize otomatis.
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
                  {[
                    { key: "harmonic", label: "Harmonic", icon: "🔷", color: "#818cf8" },
                    { key: "wyckoff", label: "Wyckoff", icon: "📊", color: "#f59e0b" },
                    { key: "smc", label: "SMC", icon: "🎯", color: "#10b981" },
                    { key: "volume_profile", label: "Volume", icon: "📈", color: "#3b82f6" },
                    { key: "broker_flow", label: "Broker Flow", icon: "🏦", color: "#f87171" },
                  ].map(f => (
                    <div key={f.key} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                      <div style={{ fontSize: 10, fontWeight: 800, color: f.color }}>{f.icon} {f.label}</div>
                      <input type="range" min={0} max={50} step={1}
                        value={scanWeights[f.key] || 0}
                        onChange={e => setScanWeights(w => ({ ...w, [f.key]: Number(e.target.value) }))}
                        style={{ width: "100%", accentColor: f.color }} />
                      <div style={{
                        fontSize: 14, fontWeight: 900, color: f.color,
                        background: `${f.color}15`, padding: "2px 10px", borderRadius: 6,
                      }}>
                        {scanWeights[f.key]}
                      </div>
                      <div style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 600 }}>
                        default: {defaultWeights[f.key]}
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
                  <button onClick={saveScanWeights} disabled={weightsSaving} style={{
                    padding: "7px 20px", borderRadius: 8, border: "none", cursor: "pointer",
                    background: "linear-gradient(135deg, #8b5cf6, #a78bfa)", color: "#fff",
                    fontSize: 11, fontWeight: 800, opacity: weightsSaving ? 0.6 : 1,
                  }}>
                    {weightsSaving ? "Saving..." : "💾 Save Weights"}
                  </button>
                  <button onClick={() => { setScanWeights({ ...defaultWeights }); }} style={{
                    padding: "7px 16px", borderRadius: 8, border: "1px solid var(--border)",
                    background: "transparent", color: "var(--text-muted)",
                    fontSize: 11, fontWeight: 700, cursor: "pointer",
                  }}>
                    Reset Default
                  </button>
                  {weightsMsg && <span style={{ fontSize: 11, fontWeight: 700, color: weightsMsg.startsWith("✅") ? "#34d399" : "#f87171" }}>{weightsMsg}</span>}
                  <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: "auto" }}>
                    Total: <strong style={{ color: Object.values(scanWeights).reduce((a, b) => a + b, 0) === 100 ? "#34d399" : "#f59e0b" }}>
                      {Object.values(scanWeights).reduce((a, b) => a + b, 0)}%
                    </strong>
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Pattern legend */}
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            {Object.entries(PATTERN_META).map(([name, meta]) => (
              <span key={name} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 6,
                background: meta.bg, border: `1px solid ${meta.border}`, color: meta.color, fontSize: 10, fontWeight: 700 }}>
                {name} <span style={{ opacity: 0.7, fontWeight: 400 }}>{meta.desc}</span>
              </span>
            ))}
          </div>

          {scanError && (
            <div style={{ padding: 16, background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)", borderRadius: 10, color: "#fca5a5", fontSize: 13, marginBottom: 16 }}>
              ⚠️ {scanError}
            </div>
          )}

          {!scanResult && !scanning && (
            <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--text-muted)" }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>{market === "CRYPTO" ? "🪙" : market === "US" ? "🇺🇸" : "🔷"}</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", marginBottom: 8 }}>
                Harmonic Pattern Scanner — {market === "CRYPTO" ? "Crypto Market" : market === "US" ? "S&P 500 (US Stocks)" : "IDX Stocks"}
              </div>
              <div style={{ fontSize: 13, maxWidth: 480, margin: "0 auto", lineHeight: 1.7 }}>
                {market === "CRYPTO" ? (
                  <>
                    Deteksi pola <strong>ABCD, Gartley, Bat, Butterfly, Crab</strong> di <strong>25 top crypto</strong>.<br />
                    Konfirmasi: <span style={{ color: "#f59e0b" }}>Volume Spike</span> + <span style={{ color: "#34d399" }}>MA20 Momentum</span>.<br />
                    Harga tampil dalam <strong>USD</strong> + konversi IDR otomatis.<br />
                    <span style={{ color: "#f59e0b", fontWeight: 700 }}>Scan 25 crypto ~45 detik.</span>
                  </>
                ) : market === "US" ? (
                  <>
                    Deteksi pola <strong>ABCD, Gartley, Bat, Butterfly, Crab</strong> di <strong>418 saham S&amp;P 500</strong>.<br />
                    Gak ada konfirmasi broker flow (gak ada data publiknya buat saham US) — cuma Wyckoff + SMC + Volume Profile.<br />
                    Harga tampil dalam <strong>USD</strong>.<br />
                    <span style={{ color: "#10b981", fontWeight: 700 }}>Scan pertama ~5-8 menit</span> (fetch 6 bulan OHLC untuk 418 ticker).
                  </>
                ) : (
                  <>
                    Deteksi pola <strong>ABCD, Gartley, Bat, Butterfly, Crab</strong> di ~116 saham IDX.<br />
                    Dikonfirmasi dengan data broker flow <strong>Foreign + Big Money</strong>.<br />
                    <span style={{ color: "#6366f1", fontWeight: 700 }}>Scan pertama ~30-60 detik</span> (fetch 6 bulan OHLC).
                  </>
                )}
              </div>
            </div>
          )}

          {scanning && (
            <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--text-muted)" }}>
              <div style={{ fontSize: 36, marginBottom: 12, animation: "spin 1.2s linear infinite", display: "inline-block" }}>⟳</div>
              <div style={{ fontSize: 13 }}>
                {market === "CRYPTO"
                  ? "Menganalisis 25 crypto asset... ~45 detik"
                  : market === "US"
                  ? "Menganalisis 418 saham S&P 500... ~5-8 menit"
                  : "Menganalisis ~116 saham IDX... ~60 detik"}
              </div>
              <div style={{ fontSize: 11, marginTop: 8, color: market === "CRYPTO" ? "#f59e0b" : market === "US" ? "#10b981" : "#6366f1" }}>
                {market === "CRYPTO"
                  ? "Harmonic Patterns • Volume Spike • MA20 Confirmation"
                  : "🧠 Ultra Engine: Harmonic • SMC (OB+FVG+Sweep) • Wyckoff • Volume Profile • Market Structure"}
              </div>
              {market !== "CRYPTO" && (
                <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 12, flexWrap: "wrap" }}>
                  {["📊 Market Structure", "🌊 Wyckoff Phase", "🎯 Order Blocks", "⚡ FVG", "🌀 Liq. Sweep", "📈 Vol. Profile", "✨ Harmonic"].map(l => (
                    <span key={l} style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                      background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.2)", color: "#818cf8" }}>{l}</span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Results */}
          {scanResult?.results?.length === 0 ? (
              <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 14 }}>
                ❌ Tidak ada pola {market === "CRYPTO" ? "Crypto" : market === "US" ? "Saham US" : "Saham IDX"} yang memenuhi syarat.<br/>
                <div style={{ fontSize: 12 }}>Coba turunkan Min Score atau Min R:R</div>
              </div>
            ) : scanResult?.results?.length > 0 && !scanning && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {scanResult.results.filter((p: any) => p.ticker.includes(searchTicker)).map((p: any, i: number) => {
                  const rId = `${p.ticker}-${p.direction}-${p.pattern_type}`;
                  const isBull = p.direction === "BULLISH";
                  const meta = PATTERN_META[p.pattern_type] || PATTERN_META.ABCD;
                  return (
                    <div key={i} style={{ background: "var(--bg-secondary)",
                      border: `1px solid ${meta.border}`,
                      borderRadius: 12, padding: "16px 20px",
                      display: "grid",
                      gridTemplateColumns: "90px 120px 130px 160px 130px 120px 70px 60px 100px",
                      gap: 14, alignItems: "center",
                      borderLeft: `4px solid ${meta.color}` }}>

                    {/* Ticker */}
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 900, color: "var(--text-primary)" }}>
                        {p.ticker}
                      </div>
                      <div style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 7px", borderRadius: 4,
                        background: p.direction === "BULLISH" ? "rgba(52,211,153,0.1)" : "rgba(248,113,113,0.1)",
                        color: p.direction === "BULLISH" ? "#34d399" : "#f87171", fontSize: 9, fontWeight: 800, marginTop: 3 }}>
                        {p.direction === "BULLISH" ? "▲" : "▼"} {p.direction}
                      </div>
                    </div>

                    {/* Pattern + confirmation */}
                    <div>
                      <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 6, background: meta.bg,
                        border: `1px solid ${meta.border}`, color: meta.color, fontSize: 11, fontWeight: 800 }}>
                        {p.pattern_type}
                      </span>
                    </div>

                    <XABCDMiniChart data={p.pattern_data} direction={p.direction} />
                    <BollingerSparkline data={p.bb_data} direction={p.direction} />

                    {/* Entry zone & Latest Close */}
                    <div>
                      <div style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 700, marginBottom: 3 }}>ENTRY ZONE</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", marginBottom: 8 }}>
                          {p.entry_min?.toLocaleString("id-ID")} – {p.entry_max?.toLocaleString("id-ID")}
                        </div>
                      <div style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 700, marginBottom: 3 }}>LATEST CLOSE</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>
                          {p.current_price ? Number(p.current_price).toLocaleString("id-ID") : "-"}
                        </div>
                        {p.current_price && p.entry_min && (
                          <div style={{ fontSize: 9, fontWeight: 800, marginTop: 2, color: p.direction === "BULLISH" ? "#3fb950" : "#f85149" }}>
                            {p.direction === "BULLISH"
                              ? `+${(((p.target_1 || p.target1) - p.current_price) / p.current_price * 100).toFixed(1)}% to TP1`
                              : `+${((p.entry_min - p.current_price) / p.current_price * 100).toFixed(1)}% to Entry`}
                          </div>
                        )}
                    </div>

                    {/* SL / T1 / T2 */}
                    <div style={{ fontSize: 11 }}>
                          <div><span style={{ color: "#f87171", fontWeight: 700 }}>SL: </span><span style={{ color: "var(--text-primary)", fontWeight: 700 }}>{p.stop_loss?.toLocaleString("id-ID")}</span></div>
                          <div><span style={{ color: "#34d399", fontWeight: 700 }}>T1: </span><span style={{ color: "var(--text-primary)", fontWeight: 700 }}>{p.target_1?.toLocaleString("id-ID")}</span></div>
                          <div><span style={{ color: "#10b981", fontWeight: 700 }}>T2: </span><span style={{ color: "var(--text-primary)", fontWeight: 700 }}>{p.target_2?.toLocaleString("id-ID")}</span></div>
                    </div>

                    {/* R:R */}
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 700, marginBottom: 3 }}>R:R</div>
                      <div style={{ fontSize: 18, fontWeight: 900, color: p.risk_reward >= 2 ? "#34d399" : "#f59e0b" }}>
                        1:{p.risk_reward?.toFixed(1)}
                      </div>
                    </div>

                    {/* Conviction */}
                    <div style={{ position: "relative" }}>
                      <ConvictionRing score={p.conviction_score} />
                    </div>

                    <button onClick={() => saveToJournal(p)} disabled={savedIds.has(rId) || saving === rId} style={{
                      padding: "8px 10px", borderRadius: 8, border: `1px solid ${savedIds.has(rId) ? "rgba(52,211,153,0.3)" : "rgba(99,102,241,0.3)"}`,
                      background: savedIds.has(rId) ? "rgba(52,211,153,0.1)" : "rgba(99,102,241,0.1)",
                      color: savedIds.has(rId) ? "#34d399" : "#818cf8",
                      fontSize: 11, fontWeight: 700, cursor: savedIds.has(rId) ? "default" : "pointer", transition: "all 0.2s",
                    }}>
                      {savedIds.has(rId) ? "✓ Saved" : saving === rId ? "..." : "+ Journal"}
                    </button>
                  </div>
                  );
                })}
            </div>
          )}
        </>
      )}

      {/* ── JOURNAL TAB ── */}
      {recsTab === "journal" && (() => {
        const CRYPTO_TICKERS = ['BTC','ETH','BNB','SOL','XRP','ADA','AVAX','DOGE','DOT','LINK','MATIC','SHIB','LTC','UNI','BCH','ATOM','XLM','INJ','RNDR','FET','OP','ARB','SUI','SEI','APT'];
        const filteredRecs = recs.filter((r: any) => {
          if (journalMarket !== "ALL") {
            const isCrypto = CRYPTO_TICKERS.includes(r.ticker);
            if (journalMarket === "CRYPTO" && !isCrypto) return false;
            if (journalMarket === "IDX" && isCrypto) return false;
          }
          if (searchTicker && !r.ticker.toLowerCase().includes(searchTicker.toLowerCase())) {
            return false;
          }
          return true;
        });

        // The same predicate the table below renders with. Selection and the
        // delete button must agree with what is on screen, so they read from
        // one definition rather than each re-deriving it.
        const visibleOpen = filteredRecs.filter((r: any) =>
          r.ticker !== "SUMMARY" && r.pattern_type !== "MONTHLY" && r.status === "OPEN");
        const visibleSelectedIds = visibleOpen.filter((r: any) => selectedRecs.has(r.id)).map((r: any) => r.id);
        const allVisibleSelected = visibleOpen.length > 0 && visibleSelectedIds.length === visibleOpen.length;
        const toggleAllVisible = () => setSelectedRecs(prev => {
          const n = new Set(prev);
          if (allVisibleSelected) visibleOpen.forEach((r: any) => n.delete(r.id));
          else visibleOpen.forEach((r: any) => n.add(r.id));
          return n;
        });
        const toggleRec = (id: number) => setSelectedRecs(prev => {
          const n = new Set(prev);
          n.has(id) ? n.delete(id) : n.add(id);
          return n;
        });

        return (
        <>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
            {/* Journal Market Selector */}
            <div style={{ display: "flex", background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 8, padding: 3, gap: 2 }}>
              {(["ALL","IDX","CRYPTO"] as const).map(m => (
                <button key={m} onClick={() => setJournalMarket(m)}
                  style={{
                    padding: "6px 16px", borderRadius: 6, border: "none", cursor: "pointer",
                    fontSize: 12, fontWeight: 800,
                    background: journalMarket === m ? "linear-gradient(135deg, #3b82f6, #6366f1)" : "transparent",
                    color: journalMarket === m ? "#fff" : "var(--text-muted)",
                    transition: "all 0.2s",
                  }}>
                  {m === "ALL" ? "🌍 ALL" : m === "CRYPTO" ? "🪙 CRYPTO" : "🇮🇩 IDX"}
                </button>
              ))}
            </div>
            {/* Search Ticker */}
            <div style={{ position: "relative", display: "flex", alignItems: "center", marginLeft: "auto" }}>
              <span style={{ position: "absolute", left: 10, fontSize: 14 }}>🔍</span>
              <input type="text" placeholder="Search Ticker..." value={searchTicker} onChange={e => setSearchTicker(e.target.value)}
                style={{ padding: "8px 12px 8px 32px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-secondary)", color: "var(--text-primary)", fontSize: 13, width: 200, outline: "none" }} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
            {Object.entries(STATUS_META).map(([s, m]) => {
              const cnt = filteredRecs.filter((r: any) => r.ticker !== "SUMMARY" && r.pattern_type !== "MONTHLY" && r.status === s).length;
              return (
                <div key={s} style={{ padding: "8px 14px", background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 8, textAlign: "center", minWidth: 70 }}>
                  <div style={{ fontSize: 18, fontWeight: 900, color: m.color }}>{cnt}</div>
                  <div style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 700 }}>{m.label}</div>
                </div>
              );
            })}
            <button onClick={triggerStatusUpdate} disabled={updatingStatus} style={{
              marginLeft: "auto", padding: "9px 18px", borderRadius: 8, border: "none",
              cursor: updatingStatus ? "not-allowed" : "pointer",
              background: updatingStatus ? "rgba(245,158,11,0.3)" : "linear-gradient(135deg, #f59e0b, #fbbf24)",
              color: "#000", fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", gap: 6,
              opacity: updatingStatus ? 0.7 : 1, transition: "all 0.2s",
            }}>
              <span style={{ display: "inline-block", animation: updatingStatus ? "spin 1s linear infinite" : "none" }}>⟳</span>
              {updatingStatus ? "Checking prices..." : "🔔 Update Status Harga"}
            </button>
          </div>

          {/* Modal summary bar */}
          {filteredRecs.length > 0 && (() => {
            const openRecs    = filteredRecs.filter((r: any) => r.ticker !== "SUMMARY" && r.pattern_type !== "MONTHLY" && r.status === "OPEN");
            const positions   = openRecs.map((r: any) => calcPosition(r)).filter(Boolean) as any[];
            const totalAlloc  = positions.reduce((s: number, p: any) => s + p.finalAlloc, 0);
            const totalGainT1 = positions.reduce((s: number, p: any) => s + p.gainT1, 0);
            const totalGainT2 = positions.reduce((s: number, p: any) => s + p.gainT2, 0);
            const totalLoss   = positions.reduce((s: number, p: any) => s + p.maxLoss, 0);
            const openCount   = openRecs.length;
            const usedPct     = (totalAlloc / MODAL_TOTAL) * 100;
            return (
              <div style={{ padding: "14px 20px", background: "linear-gradient(135deg, rgba(99,102,241,0.08), rgba(139,92,246,0.08))",
                border: "1px solid rgba(99,102,241,0.2)", borderRadius: 12, marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                  <span style={{ fontSize: 12, fontWeight: 900, color: "#a78bfa" }}>💼 SIMULASI PORTOFOLIO — MODAL Rp 100 JUTA</span>
                  <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: 8 }}>Risk 2%/trade · Max 30%/posisi · IDX lot = 100 saham</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
                  {[
                    { label: "MODAL DIPAKAI", value: `${(totalAlloc/1e6).toFixed(1)}M`, sub: `${usedPct.toFixed(1)}% dari 100M`, color: "#60a5fa" },
                    { label: "POSISI OPEN",   value: openCount, sub: `${filteredRecs.length} total`, color: "#a78bfa" },
                    { label: "EST PROFIT T1", value: fmtM(totalGainT1), sub: `+${(totalGainT1/MODAL_TOTAL*100).toFixed(1)}% modal`, color: "#34d399" },
                    { label: "EST PROFIT T2", value: fmtM(totalGainT2), sub: `+${(totalGainT2/MODAL_TOTAL*100).toFixed(1)}% modal`, color: "#10b981" },
                    { label: "MAX LOSS",      value: fmtM(totalLoss), sub: `${(totalLoss/MODAL_TOTAL*100).toFixed(1)}% modal`, color: "#f87171" },
                  ].map(s => (
                    <div key={s.label} style={{ textAlign: "center", padding: "10px 8px", background: "var(--bg-secondary)", borderRadius: 8, border: "1px solid var(--border)" }}>
                      <div style={{ fontSize: 18, fontWeight: 900, color: s.color }}>{s.value}</div>
                      <div style={{ fontSize: 9, fontWeight: 800, color: "var(--text-muted)", letterSpacing: "0.07em", marginTop: 2 }}>{s.label}</div>
                      <div style={{ fontSize: 9, color: s.color, opacity: 0.7, marginTop: 1 }}>{s.sub}</div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 10, height: 6, background: "rgba(255,255,255,0.05)", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${Math.min(usedPct, 100)}%`,
                    background: usedPct > 80 ? "#f87171" : usedPct > 60 ? "#f59e0b" : "#6366f1",
                    borderRadius: 3, transition: "width 0.8s" }} />
                </div>
                <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 4 }}>Modal terpakai: {usedPct.toFixed(1)}% · Sisa: Rp {((MODAL_TOTAL-totalAlloc)/1e6).toFixed(1)}M</div>
              </div>
            );
          })()}

          {/* Journal table */}
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
            <ExportButton label="Export Journal" onClick={() => {
              const arr = filteredRecs.filter((r: any) => r.ticker !== "SUMMARY" && r.pattern_type !== "MONTHLY" && r.status === "OPEN");
              downloadCSV(
                `journal-${new Date().toISOString().slice(0,10)}.csv`,
                ["Ticker","Pattern","ConvictionTier","Direction","Entry","SL","T1","T2","R:R","Lot","Modal","EstT1","EstT2","HargaActual","FloatPL","DetectedDate","Status"],
                arr.map((r: any) => {
                  const pos = calcPosition(r);
                  const entryPrice = r.entry_price || r.entry_max || 1;
                  const mPrice = r.market_price || entryPrice;
                  const floatPct = ((mPrice - entryPrice) / entryPrice) * 100;
                  return [
                    r.ticker, r.pattern_type, r.convictionTier ?? "", r.direction,
                    pos ? Math.round(pos.entry) : "", r.stop_loss, r.target_1, r.target_2, r.risk_reward,
                    pos ? pos.finalLots : "", pos ? Math.round(pos.finalAlloc) : "",
                    pos ? Math.round(pos.gainT1) : "", pos ? Math.round(pos.gainT2) : "",
                    r.market_price ?? "", r.market_price ? floatPct.toFixed(2) : "",
                    r.detected_date, r.status,
                  ];
                })
              );
            }} />
          </div>
          {/* Bulk selection — only when there is something to act on */}
          {visibleOpen.length > 0 && (
            <div style={{
              display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
              marginBottom: 12, padding: "9px 14px", borderRadius: 10,
              background: visibleSelectedIds.length ? "rgba(248,81,73,0.05)" : "var(--bg-secondary)",
              border: `1px solid ${visibleSelectedIds.length ? "rgba(248,81,73,0.25)" : "var(--border)"}`,
            }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, fontWeight: 700, color: "var(--text-muted)" }}>
                <input type="checkbox" checked={allVisibleSelected}
                  ref={el => { if (el) el.indeterminate = visibleSelectedIds.length > 0 && !allVisibleSelected; }}
                  onChange={toggleAllVisible}
                  style={{ width: 15, height: 15, accentColor: "#f85149", cursor: "pointer" }} />
                Pilih semua ({visibleOpen.length})
              </label>

              {visibleSelectedIds.length > 0 && (
                <>
                  <span style={{ fontSize: 12, fontWeight: 800, color: "#f85149" }}>{visibleSelectedIds.length} dipilih</span>
                  <button
                    disabled={deleting}
                    onClick={() => confirmDelete ? deleteRecs(visibleSelectedIds) : setConfirmDelete(true)}
                    style={{
                      padding: "6px 14px", borderRadius: 7, cursor: deleting ? "wait" : "pointer",
                      fontSize: 12, fontWeight: 800, opacity: deleting ? 0.6 : 1,
                      border: `1px solid ${confirmDelete ? "#f85149" : "rgba(248,81,73,0.4)"}`,
                      background: confirmDelete ? "#f85149" : "rgba(248,81,73,0.08)",
                      color: confirmDelete ? "#fff" : "#f85149",
                    }}>
                    {deleting ? "Menghapus…"
                      : confirmDelete ? `Yakin? Hapus ${visibleSelectedIds.length} — backup .json diunduh dulu`
                      : `🗑 Hapus ${visibleSelectedIds.length}`}
                  </button>
                  <button onClick={() => { setSelectedRecs(new Set()); setConfirmDelete(false); setDeleteError(null); }}
                    style={{ padding: "6px 12px", borderRadius: 7, border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                    Batal pilih
                  </button>
                </>
              )}

              {selectedRecs.size > visibleSelectedIds.length && (
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  ({selectedRecs.size - visibleSelectedIds.length} terpilih tapi tidak terlihat — tidak ikut terhapus)
                </span>
              )}

              {/* Said once, at the moment it matters: this button edits the
                  denominator of the win rate on the Stats tab. */}
              {confirmDelete && (
                <span style={{ fontSize: 11, color: "#e3b341", fontWeight: 700 }}>
                  Permanen, tidak ada undo — dan ini mengubah Win Rate di tab Stats.
                </span>
              )}
              {deleteError && (
                <span style={{ fontSize: 11, color: "#f85149", fontWeight: 700 }}>{deleteError}</span>
              )}
            </div>
          )}

          <div style={{ background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border)", overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <div style={{ display: "grid",
                gridTemplateColumns: "34px 80px 90px 50px 80px 70px 70px 70px 50px 60px 90px 90px 90px 85px 90px 50px 100px 95px",
                padding: "10px 16px", borderBottom: "1px solid var(--border)", gap: 8, minWidth: 1349 }}>
                <input type="checkbox" checked={allVisibleSelected}
                  ref={el => { if (el) el.indeterminate = visibleSelectedIds.length > 0 && !allVisibleSelected; }}
                  onChange={toggleAllVisible}
                  aria-label="Pilih semua"
                  style={{ width: 15, height: 15, accentColor: "#f85149", cursor: "pointer" }} />
                {["TICKER","PATTERN","DIR","ENTRY","SL","T1","T2","R:R","LOT","MODAL","EST T1","EST T2","HARGA ACTUAL","FLOAT P/L","HOLD","STATUS","DITAMBAHKAN"].map(h => (
                  <span key={h} onClick={() => { if(openSortCol===h) setOpenSortAsc(!openSortAsc); else { setOpenSortCol(h); setOpenSortAsc(true); } }}
                    style={{ fontSize: 12, fontWeight: 800, color: openSortCol===h?"#3b82f6":"var(--text-secondary)", letterSpacing: "0.1em", cursor:"pointer", userSelect:"none" }}>
                    {h} {openSortCol===h ? (openSortAsc?"↑":"↓") : ""}
                  </span>
                ))}
              </div>
              {filteredRecs.length === 0 ? (
                <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                  Belum ada rekomendasi. Jalankan Pattern Scan → klik 💾 Save All.
                </div>
              ) : (() => {
                  let arr = filteredRecs.filter((r: any) => r.ticker !== "SUMMARY" && r.pattern_type !== "MONTHLY" && r.status === "OPEN");
                  if (openSortCol) {
                    arr = [...arr].sort((a,b) => {
                      let valA, valB;
                      if (openSortCol === "TICKER") { valA = a.ticker; valB = b.ticker; }
                      else if (openSortCol === "DIR") { valA = a.direction; valB = b.direction; }
                      else if (openSortCol === "PATTERN") { valA = a.pattern_type; valB = b.pattern_type; }
                      else if (openSortCol === "FLOAT P/L") {
                        const ea = a.entry_price||a.entry_max||1; const ma = a.market_price||ea;
                        valA = a.direction==="BULLISH" ? (ma-ea)/ea : (ea-ma)/ea;
                        const eb = b.entry_price||b.entry_max||1; const mb = b.market_price||eb;
                        valB = b.direction==="BULLISH" ? (mb-eb)/eb : (eb-mb)/eb;
                      }
                      else if (openSortCol === "HOLD") { valA = new Date(a.detected_date).getTime(); valB = new Date(b.detected_date).getTime(); }
                      else if (openSortCol === "DITAMBAHKAN") { valA = new Date(a.created_at || 0).getTime(); valB = new Date(b.created_at || 0).getTime(); }
                      else { return 0; }
                      if (valA < valB) return openSortAsc ? -1 : 1;
                      if (valA > valB) return openSortAsc ? 1 : -1;
                      return 0;
                    });
                  }
                  return arr.map((r: any) => {
                const meta = PATTERN_META[r.pattern_type] || PATTERN_META.ABCD;
                const sm   = STATUS_META[r.status] || STATUS_META.OPEN;
                const pos  = calcPosition(r);
                const isClosed = ["HIT_T1","HIT_T2","STOPPED","EXPIRED"].includes(r.status);
                
                const entryPrice = r.entry_price || r.entry_max || 1;
                const live = livePrices[r.ticker];
                const mPrice = (r.status === "OPEN" && live?.price) ? live.price : (r.market_price || entryPrice);
                const isLive = r.status === "OPEN" && !!live?.price;
                const floatPts = mPrice - entryPrice;
                const floatPct = (floatPts / entryPrice) * 100;
                const floatStr = floatPts > 0 ? `+${floatPts.toFixed(0)} (${floatPct.toFixed(1)}%)` : `${floatPts.toFixed(0)} (${floatPct.toFixed(1)}%)`;
                const floatColor = floatPts > 0 ? "#10b981" : floatPts < 0 ? "#f87171" : "var(--text-muted)";
                
                return (
                  <div key={r.id} style={{
                    display: "grid",
                    gridTemplateColumns: "34px 80px 90px 50px 80px 70px 70px 70px 50px 60px 90px 90px 90px 85px 90px 50px 100px 95px",
                    padding: "11px 16px", borderBottom: "1px solid rgba(48,54,61,0.5)",
                    gap: 8, alignItems: "center", minWidth: 1349,
                    opacity: isClosed ? 0.65 : 1,
                    // Selection wins over the outcome colour: a selected row is
                    // about to be destroyed, which matters more right now than
                    // whether it hit its target.
                    background: selectedRecs.has(r.id) ? "rgba(248,81,73,0.07)" :
                                r.status === "HIT_T2" ? "rgba(16,185,129,0.04)" :
                                r.status === "HIT_T1" ? "rgba(52,211,153,0.03)" :
                                r.status === "STOPPED" ? "rgba(248,113,113,0.04)" : "transparent",
                  }}>
                    <input type="checkbox" checked={selectedRecs.has(r.id)}
                      onChange={() => toggleRec(r.id)}
                      aria-label={`Pilih ${r.ticker}`}
                      style={{ width: 15, height: 15, accentColor: "#f85149", cursor: "pointer" }} />
                    <span style={{ fontSize: 15, fontWeight: 900, color: "var(--text-primary)" }}>{r.ticker}</span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-start" }}>
                      <span style={{ display: "inline-block", padding: "2px 7px", borderRadius: 5, background: meta.bg,
                        border: `1px solid ${meta.border}`, color: meta.color, fontSize: 9, fontWeight: 800 }}>
                        {r.pattern_type}
                      </span>
                      <ConvictionTierBadge tier={r.convictionTier} reason={r.tierReason} />
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 800, color: r.direction === "BULLISH" ? "#34d399" : "#f87171" }}>
                      {r.direction === "BULLISH" ? "▲ B" : "▼ BR"}
                    </span>

                    {/* Price levels */}
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-primary)" }}>
                      {pos ? Math.round(pos.entry).toLocaleString("id-ID") : "–"}
                    </span>
                    <span style={{ fontSize: 11, color: "#f87171", fontWeight: 700 }}>{Number(r.stop_loss).toLocaleString("id-ID")}</span>
                    <span style={{ fontSize: 11, color: "#34d399", fontWeight: 700 }}>{Number(r.target_1).toLocaleString("id-ID")}</span>
                    <span style={{ fontSize: 11, color: "#10b981", fontWeight: 700 }}>{Number(r.target_2).toLocaleString("id-ID")}</span>
                    <span style={{ fontSize: 12, fontWeight: 800, color: Number(r.risk_reward) >= 2 ? "#34d399" : "#f59e0b" }}>
                      1:{Number(r.risk_reward).toFixed(1)}
                    </span>

                    {/* Position sizing */}
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 14, fontWeight: 900, color: "#a78bfa" }}>{pos ? pos.finalLots : "–"}</div>
                      <div style={{ fontSize: 9, color: "var(--text-muted)" }}>lot</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "#60a5fa" }}>
                        {pos ? `${(pos.finalAlloc/1e6).toFixed(1)}M` : "–"}
                      </div>
                      <div style={{ fontSize: 9, color: "#f87171" }}>
                        {pos ? fmtM(pos.maxLoss) : ""}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "#34d399" }}>
                        {pos ? fmtM(pos.gainT1) : "–"}
                      </div>
                      <div style={{ fontSize: 9, color: "var(--text-muted)" }}>
                        {pos ? `+${((pos.gainT1/MODAL_TOTAL)*100).toFixed(1)}%` : ""}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "#10b981" }}>
                        {pos ? fmtM(pos.gainT2) : "–"}
                      </div>
                      <div style={{ fontSize: 9, color: "var(--text-muted)" }}>
                        {pos ? `+${((pos.gainT2/MODAL_TOTAL)*100).toFixed(1)}%` : ""}
                      </div>
                    </div>

                    {/* HARGA ACTUAL */}
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 13, fontWeight: 800, color: "var(--text-primary)", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
                        {mPrice && mPrice !== entryPrice ? Math.round(mPrice).toLocaleString("id-ID") : "–"}
                        {isLive && <span title={`Live · ${live?.marketTime ? new Date(live.marketTime).toLocaleTimeString("id-ID") : ""}`}
                          style={{ width: 6, height: 6, borderRadius: "50%", background: "#34d399", display: "inline-block", animation: "pulse 2s infinite" }} />}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{isLive ? "live" : "actual"}</div>
                    </div>
                    {/* FLOATING P/L */}
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 12, fontWeight: 800, color: floatColor }}>
                        {mPrice && mPrice !== entryPrice ? floatStr : "–"}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--text-muted)" }}>float P/L</div>
                    </div>
                    {/* HOLD DURATION */}
                    <div style={{ textAlign: "center" }}>
                      {(() => {
                        const d1 = r.detected_date ? new Date(r.detected_date) : null;
                        const d2 = r.closed_date ? new Date(r.closed_date) : new Date();
                        const days = d1 ? Math.round((d2.getTime()-d1.getTime())/86400000) : null;
                        return (
                          <div>
                            <div style={{ fontSize: 14, fontWeight: 900,
                              color: days && days <= 3 ? "#34d399" : days && days <= 7 ? "#f59e0b" : "#f87171" }}>
                              {days !== null ? `${days}h` : "–"}
                            </div>
                            <div style={{ fontSize: 8, color: "var(--text-muted)" }}>hold</div>
                          </div>
                        );
                      })()}
                    </div>
                    {/* Status + update */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                        <span style={{ fontSize: 12 }}>{sm.emoji}</span>
                        <span style={{ padding: "2px 5px", borderRadius: 4, fontSize: 9, fontWeight: 800, color: sm.color,
                          background: `${sm.color}18`, border: `1px solid ${sm.color}30` }}>{sm.label}</span>
                      </div>
                      {r.status === "OPEN" && (
                        <select onChange={e => e.target.value && updateStatus(r.id, e.target.value)}
                          defaultValue=""
                          style={{ fontSize: 9, background: "var(--bg-tertiary)", border: "1px solid var(--border)",
                            color: "var(--text-muted)", borderRadius: 4, padding: "2px 4px", cursor: "pointer" }}>
                          <option value="">Update ▾</option>
                          <option value="HIT_T1">✅ Hit T1</option>
                          <option value="HIT_T2">🎯 Hit T2</option>
                          <option value="STOPPED">🛑 Stopped</option>
                          <option value="EXPIRED">⏰ Expired</option>
                        </select>
                      )}
                      {r.result_pct && (
                        <span style={{ fontSize: 10, fontWeight: 800,
                          color: Number(r.result_pct) >= 0 ? "#34d399" : "#f87171" }}>
                          {Number(r.result_pct) >= 0 ? "+" : ""}{Number(r.result_pct).toFixed(2)}%
                        </span>
                      )}
                    </div>
                    {/* Ditambahkan (created_at) — biar keliatan mana yang baru vs lama */}
                    <div>
                      {(() => {
                        if (!r.created_at) return <span style={{ fontSize: 11, color: "var(--text-muted)" }}>–</span>;
                        const created = new Date(r.created_at);
                        const ageMs = Date.now() - created.getTime();
                        const ageH = ageMs / 3600000;
                        const isNew = ageH < 24;
                        return (
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 700, color: isNew ? "#3fb950" : "var(--text-muted)" }}>
                              {created.toLocaleDateString("id-ID", { day: "2-digit", month: "short" })}
                            </div>
                            <div style={{ fontSize: 9, color: isNew ? "#3fb950" : "#484f58", fontWeight: isNew ? 800 : 400 }}>
                              {isNew ? "🆕 baru" : created.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                );
              }); })()}
            </div>
          </div>
        </>
      );})()}

      {/* ── WIN RATE TAB ── */}
      {recsTab === "stats" && (() => {
        // Parse helpers
        const parsePnlRp = (notes: string | null): number | null => {
          if (!notes) return null;
          const m = notes.match(/P&L:\s*([+-]?)Rp\s*([\d.,]+)/i);
          if (!m) return null;
          const raw = m[2].replace(/\./g,'').replace(',','.');
          const v = parseFloat(raw);
          return isNaN(v) ? null : (m[1] === '-' ? -v : v);
        };
        const parseLots = (notes: string | null): number | null => {
          if (!notes) return null;
          const m = notes.match(/Lots:\s*(\d+)/i);
          return m ? parseInt(m[1]) : null;
        };
        // Modal = Lots × entry, with fallback: 2% risk / slAmount per lot
        const calcModal = (r: any): { modal: number|null; lots: number|null } => {
          const entry = Number(r.entry_min || r.entry_price || 0);
          const lots  = parseLots(r.notes);
          if (lots && entry) return { modal: lots * 100 * entry, lots: lots * 100 }; // Convert lot to lembar for display
          // Fallback from 2% risk rule
          const sl = Number(r.stop_loss || 0);
          if (entry > 0) {
            let slAmt = Math.abs(entry - sl);
            if (slAmt === 0) slAmt = entry * 0.02; // Default 2% SL distance if entry == sl
            if (slAmt > 0) {
              const riskBudget = 2_000_000; // 2% of Rp 100M
              let calcShares = Math.floor(riskBudget / slAmt);
              let modalVal = calcShares * entry;
              if (modalVal > 30_000_000) {
                modalVal = 30_000_000;
                calcShares = Math.floor(modalVal / entry);
              }
              if (calcShares > 0) return { modal: modalVal, lots: calcShares };
            }
          }
          return { modal: null, lots: null };
        };

        const realizedTrades = recs.filter((r: any) => {
          if (r.ticker === "SUMMARY" || r.pattern_type === "MONTHLY") return false;
          if (!["WIN","LOSS","HIT_T1","HIT_T2","STOPPED","EXPIRED"].includes(r.status)) return false;
          const rDate = r.closed_date || r.detected_date;
          if (!rDate) return true;
          const d = new Date(rDate);
          const now = new Date();
          if (wrPeriod === "THIS_MONTH") {
            if (d.getMonth() !== now.getMonth() || d.getFullYear() !== now.getFullYear()) return false;
          } else if (wrPeriod === "LAST_MONTH") {
            const lastM = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            if (d.getMonth() !== lastM.getMonth() || d.getFullYear() !== lastM.getFullYear()) return false;
          } else if (wrPeriod === "CUSTOM") {
            if (wrStart && new Date(rDate) < new Date(wrStart)) return false;
            // append time to end date to include the whole day
            if (wrEnd && new Date(rDate) > new Date(wrEnd + "T23:59:59")) return false;
          }
          return true;
        }).sort((a: any, b: any) => (b.closed_date || b.detected_date || "").localeCompare(a.closed_date || a.detected_date || ""));

        const totalWins   = realizedTrades.filter((r: any) => ["WIN","HIT_T1","HIT_T2"].includes(r.status)).length;
        const totalLosses = realizedTrades.filter((r: any) => ["LOSS","STOPPED"].includes(r.status)).length;
        const winRate     = (totalWins + totalLosses) > 0 ? Math.round(totalWins / (totalWins + totalLosses) * 1000) / 10 : 0;
        const totalPnlPct = realizedTrades.reduce((s: number, r: any) => s + Number(r.result_pct || 0), 0);
        const avgPnl      = realizedTrades.length > 0 ? totalPnlPct / realizedTrades.length : 0;
        const totalPnlRp  = realizedTrades.reduce((s: number, r: any) => s + (parsePnlRp(r.notes) || 0), 0);
        const totalModalRp = realizedTrades.reduce((s: number, r: any) => s + (calcModal(r).modal || 0), 0);
        const fmtRp = (v: number) => `${v >= 0 ? '+' : ''}Rp ${Math.abs(Math.round(v)).toLocaleString('id-ID')}`;
        const fmtRpShort = (v: number | null) => {
          if (v === null) return '–';
          const abs = Math.abs(Math.round(v));
          const sign = v >= 0 ? '+' : '-';
          if (abs >= 1_000_000) return `${sign}Rp ${(abs/1_000_000).toFixed(1)}jt`;
          if (abs >= 1_000)    return `${sign}Rp ${Math.round(abs/1_000)}K`;
          return `${sign}Rp ${abs.toLocaleString('id-ID')}`;
        };

        return (
          <>
            {/* Filter Controls */}
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16, background: "var(--bg-secondary)", padding: "10px 16px", borderRadius: 8, border: "1px solid var(--border)", flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 800, color: "var(--text-muted)", marginRight: 8 }}>🗓️ PERIODE:</span>
              {(["ALL","THIS_MONTH","LAST_MONTH","CUSTOM"] as const).map(p => (
                <button key={p} onClick={() => setWrPeriod(p)}
                  style={{
                    padding: "6px 14px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 800,
                    background: wrPeriod === p ? "linear-gradient(135deg, #10b981, #059669)" : "transparent",
                    color: wrPeriod === p ? "#fff" : "var(--text-muted)", transition: "all 0.2s"
                  }}>
                  {p === "ALL" ? "All Time" : p === "THIS_MONTH" ? "Bulan Ini" : p === "LAST_MONTH" ? "Bulan Lalu" : "Custom"}
                </button>
              ))}
              
              {wrPeriod === "CUSTOM" && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: "auto" }}>
                  <input type="date" value={wrStart} onChange={e => setWrStart(e.target.value)}
                    style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 12, outline: "none" }} />
                  <span style={{ color: "var(--text-muted)", fontSize: 12 }}>s/d</span>
                  <input type="date" value={wrEnd} onChange={e => setWrEnd(e.target.value)}
                    style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 12, outline: "none" }} />
                </div>
              )}
            </div>

            {/* Summary Cards */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 8, marginBottom: 16 }}>
              {[
                { label: "WIN RATE", value: `${winRate}%`, sub: `${totalWins}W · ${totalLosses}L`, color: winRate >= 70 ? "#34d399" : winRate >= 50 ? "#f59e0b" : "#f87171" },
                { label: "TOTAL REALIZED", value: realizedTrades.length, sub: "trades closed", color: "#a78bfa" },
                { label: "TOTAL MODAL", value: fmtRpShort(totalModalRp).replace('+',''), sub: "modal diputar", color: "#60a5fa" },
                { label: "AVG P&L", value: `${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}%`, sub: "per trade", color: avgPnl >= 0 ? "#34d399" : "#f87171" },
                { label: "TOTAL RETURN", value: `${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct.toFixed(2)}%`, sub: "all realized", color: totalPnlPct >= 0 ? "#34d399" : "#f87171" },
                { label: "TOTAL P&L (Rp)", value: fmtRpShort(totalPnlRp), sub: "net profit/loss", color: totalPnlRp >= 0 ? "#34d399" : "#f87171" },
              ].map(c => (
                <div key={c.label} style={{ padding: "12px 14px", background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 10, textAlign: "center" }}>
                  <div style={{ fontSize: 18, fontWeight: 900, color: c.color }}>{c.value}</div>
                  <div style={{ fontSize: 8, color: "var(--text-muted)", fontWeight: 700, marginTop: 3, letterSpacing: "0.08em" }}>{c.label}</div>
                  <div style={{ fontSize: 8, color: "var(--text-muted)", marginTop: 1 }}>{c.sub}</div>
                </div>
              ))}
            </div>

            {/* Realized Trades Table */}
            <div style={{ background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border)", overflow: "hidden", marginBottom: 16 }}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 16, fontWeight: 800, color: "var(--text-primary)" }}>📋 Riwayat Realized Trades</span>
                <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: "auto" }}>{realizedTrades.length} trades</span>
              </div>
              {/* Bulk selection.
                  This table is not a list of records that happen to be here —
                  it IS the win rate printed a few centimetres above. Deleting
                  from it is editing the score, so the controls say so. */}
              {(() => {
                const ids = realizedTrades.map((r: any) => r.id);
                const sel = ids.filter((id: number) => selectedRecs.has(id));
                const allSel = ids.length > 0 && sel.length === ids.length;
                const losersSel = realizedTrades.filter((r: any) =>
                  selectedRecs.has(r.id) && ["LOSS","STOPPED"].includes(r.status)).length;
                if (!ids.length) return null;
                return (
                  <div style={{
                    display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
                    margin: "0 0 12px", padding: "9px 14px", borderRadius: 10,
                    background: sel.length ? "rgba(248,81,73,0.05)" : "var(--bg-secondary)",
                    border: `1px solid ${sel.length ? "rgba(248,81,73,0.25)" : "var(--border)"}`,
                  }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, fontWeight: 700, color: "var(--text-muted)" }}>
                      <input type="checkbox" checked={allSel}
                        ref={el => { if (el) el.indeterminate = sel.length > 0 && !allSel; }}
                        onChange={() => setSelectedRecs(prev => {
                          const n = new Set(prev);
                          if (allSel) ids.forEach((id: number) => n.delete(id));
                          else ids.forEach((id: number) => n.add(id));
                          return n;
                        })}
                        style={{ width: 15, height: 15, accentColor: "#f85149", cursor: "pointer" }} />
                      Pilih semua ({ids.length})
                    </label>
                    {sel.length > 0 && (
                      <>
                        <span style={{ fontSize: 12, fontWeight: 800, color: "#f85149" }}>{sel.length} dipilih</span>
                        <button disabled={deleting}
                          onClick={() => confirmDelete ? deleteRecs(sel) : setConfirmDelete(true)}
                          style={{
                            padding: "6px 14px", borderRadius: 7, cursor: deleting ? "wait" : "pointer",
                            fontSize: 12, fontWeight: 800, opacity: deleting ? 0.6 : 1,
                            border: `1px solid ${confirmDelete ? "#f85149" : "rgba(248,81,73,0.4)"}`,
                            background: confirmDelete ? "#f85149" : "rgba(248,81,73,0.08)",
                            color: confirmDelete ? "#fff" : "#f85149",
                          }}>
                          {deleting ? "Menghapus…"
                            : confirmDelete ? `Yakin? Hapus ${sel.length} — backup .json diunduh dulu`
                            : `🗑 Hapus ${sel.length}`}
                        </button>
                        <button onClick={() => { setSelectedRecs(new Set()); setConfirmDelete(false); setDeleteError(null); }}
                          style={{ padding: "6px 12px", borderRadius: 7, border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                          Batal pilih
                        </button>
                      </>
                    )}
                    {/* The specific move worth naming, because it is the one
                        that quietly turns a record into a advertisement. */}
                    {losersSel > 0 && (
                      <span style={{ fontSize: 11, color: "#e3b341", fontWeight: 700 }}>
                        {losersSel} dari yang dipilih adalah LOSS/STOPPED — menghapusnya akan
                        menaikkan Win Rate di atas tanpa satu trade pun berubah.
                      </span>
                    )}
                    {confirmDelete && sel.length > 0 && (
                      <span style={{ fontSize: 11, color: "#f85149", fontWeight: 700 }}>
                        Permanen, tidak ada undo.
                      </span>
                    )}
                    {deleteError && <span style={{ fontSize: 11, color: "#f85149", fontWeight: 700 }}>{deleteError}</span>}
                  </div>
                );
              })()}

              <div style={{ overflowX: "auto" }}>
                {/* Table header - fr units fill full width */}
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "34px 1.1fr 1.4fr 0.4fr 1fr 1fr 1.2fr 1.2fr 0.5fr 0.9fr 1.3fr 1.4fr 1.3fr",
                  gap: 8, padding: "8px 16px",
                  borderBottom: "1px solid rgba(255,255,255,0.05)",
                  width: "100%", boxSizing: "border-box"
                }}>
                  <span />
                  {["TICKER","PATTERN","DIR","ENTRY","CLOSE","TGL MASUK","TGL KELUAR","HOLD","RESULT%","MODAL","P&L (Rp)","STATUS"].map(h => (
                    <span key={h} style={{ fontSize: 12, fontWeight: 800, color: "var(--text-secondary)", letterSpacing: "0.08em" }}>{h}</span>
                  ))}
                </div>
                {realizedTrades.length === 0 ? (
                  <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                    <div style={{ fontSize: 32, marginBottom: 8 }}>📊</div>
                    Belum ada trade yang closed.<br/>
                    <span style={{ fontSize: 11 }}>Buka Trade Journal → update status posisi yang sudah hit target atau stop loss.</span>
                  </div>
                ) : realizedTrades.map((r: any) => {
                  const isWin    = ["WIN","HIT_T1","HIT_T2"].includes(r.status);
                  const pnl      = Number(r.result_pct || 0);
                  const entry    = Number(r.entry_price || r.entry_min || 0);
                  const close    = Number(r.closed_price || 0);
                  const { modal, lots } = calcModal(r);
                  const pnlRp    = parsePnlRp(r.notes) ?? (modal && pnl ? Math.round(modal * pnl / 100) : null);
                  const d1       = r.detected_date ? new Date(r.detected_date) : null;
                  const d2       = r.closed_date   ? new Date(r.closed_date)   : null;
                  const hold     = (d1 && d2) ? Math.max(0, Math.round((d2.getTime()-d1.getTime())/86400000)) : null;
                  const fmtD     = (d: string|null|undefined) => d ? new Date(d).toLocaleDateString("id-ID",{day:"2-digit",month:"short",year:"2-digit"}) : "–";
                  const fmtNum   = (n: number) => n > 0 ? n.toLocaleString("id-ID") : "–";
                  const fmtM     = (v: number | null) => {
                    if (!v) return "–";
                    if (v >= 1_000_000) return `Rp ${(v/1_000_000).toFixed(1)}jt`;
                    return `Rp ${Math.round(v/1_000)}K`;
                  };
                  const sLabel: Record<string,string> = { WIN:"WIN ✅", LOSS:"LOSS ❌", HIT_T1:"HIT T1 🎯", HIT_T2:"HIT T2 🎯", STOPPED:"STOP 🛑", EXPIRED:"EXPIRED ⏰" };
                  const meta     = PATTERN_META[r.pattern_type] || PATTERN_META.ABCD;
                  const COLS     = "34px 1.1fr 1.4fr 0.4fr 1fr 1fr 1.2fr 1.2fr 0.5fr 0.9fr 1.3fr 1.4fr 1.3fr";
                  return (
                    <div key={r.id} style={{
                      display: "grid", gridTemplateColumns: COLS,
                      gap: 8, padding: "14px 16px", borderBottom: "1px solid rgba(48,54,61,0.4)",
                      alignItems: "center", width: "100%", boxSizing: "border-box",
                      background: selectedRecs.has(r.id) ? "rgba(248,81,73,0.09)"
                        : isWin ? "rgba(52,211,153,0.03)" : "rgba(248,113,113,0.03)",
                    }}>
                      <input type="checkbox" checked={selectedRecs.has(r.id)}
                        onChange={() => setSelectedRecs(prev => {
                          const n = new Set(prev);
                          n.has(r.id) ? n.delete(r.id) : n.add(r.id);
                          return n;
                        })}
                        aria-label={`Pilih ${r.ticker}`}
                        style={{ width: 15, height: 15, accentColor: "#f85149", cursor: "pointer" }} />
                      {/* TICKER */}
                      <span style={{ fontSize: 15, fontWeight: 900, color: "var(--text-primary)" }}>{r.ticker}</span>
                      {/* PATTERN */}
                      <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 4,
                        background: meta.bg, color: meta.color, border: `1px solid ${meta.border}` }}>{r.pattern_type}</span>
                      {/* DIR */}
                      <span style={{ fontSize: 13, fontWeight: 800, color: r.direction === "BULLISH" ? "#34d399" : "#f87171" }}>
                        {r.direction === "BULLISH" ? "▲" : "▼"}
                      </span>
                      {/* ENTRY */}
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text-primary)" }}>{fmtNum(entry)}</div>
                        <div style={{ fontSize: 10, color: "var(--text-muted)" }}>entry</div>
                      </div>
                      {/* CLOSE */}
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 800, color: isWin ? "#34d399" : "#f87171" }}>{fmtNum(close)}</div>
                        <div style={{ fontSize: 10, color: "var(--text-muted)" }}>close</div>
                      </div>
                      {/* TGL MASUK */}
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#60a5fa" }}>{fmtD(r.detected_date)}</div>
                        <div style={{ fontSize: 10, color: "var(--text-muted)" }}>masuk</div>
                      </div>
                      {/* TGL KELUAR */}
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: isWin ? "#34d399" : r.status==="STOPPED"?"#f87171":"var(--text-muted)" }}>{fmtD(r.closed_date)}</div>
                        <div style={{ fontSize: 10, color: "var(--text-muted)" }}>keluar</div>
                      </div>
                      {/* HOLD */}
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 14, fontWeight: 900,
                          color: hold!==null&&hold<=3?"#34d399":hold!==null&&hold<=7?"#f59e0b":"#f87171" }}>
                          {hold !== null ? `${hold}h` : "–"}
                        </div>
                      </div>
                      {/* RESULT % */}
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 15, fontWeight: 900, color: pnl>0?"#34d399":pnl<0?"#f87171":"var(--text-muted)" }}>
                          {pnl>0?"+":""}{pnl.toFixed(2)}%
                        </div>
                      </div>
                      {/* MODAL */}
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 800, color: "#c4b5fd" }}>{fmtM(modal)}</div>
                        <div style={{ fontSize: 9, color: "var(--text-muted)" }}>{lots ? `${Math.floor(lots/100)} lot` : "–"}</div>
                      </div>
                      {/* P&L Rp */}
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 900, color: pnlRp !== null ? (pnlRp>=0?"#34d399":"#f87171") : "var(--text-muted)" }}>
                          {fmtRpShort(pnlRp)}
                        </div>
                      </div>
                      {/* STATUS */}
                      <span style={{ padding: "4px 9px", borderRadius: 5, fontSize: 11, fontWeight: 800,
                        background: isWin?"rgba(52,211,153,0.12)":"rgba(248,113,113,0.12)",
                        color: isWin?"#34d399":"#f87171",
                        border: `1px solid ${isWin?"rgba(52,211,153,0.25)":"rgba(248,113,113,0.25)"}` }}>
                        {sLabel[r.status] || r.status}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Win Rate Per Pattern (from API stats) */}
            {stats && (
              <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
                <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", fontSize: 11, fontWeight: 800, color: "var(--text-secondary)", letterSpacing: "0.08em" }}>
                  📈 WIN RATE PER PATTERN (All-time API stats)
                </div>
                {(stats.by_pattern || []).map((p: any) => {
                  const meta = PATTERN_META[p.pattern_type] || PATTERN_META.ABCD;
                  const wr = p.win_rate || 0;
                  return (
                    <div key={p.pattern_type} style={{ display: "grid", gridTemplateColumns: "110px 1fr 60px 60px 80px",
                      padding: "12px 16px", borderBottom: "1px solid rgba(48,54,61,0.5)", gap: 12, alignItems: "center" }}>
                      <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 6, background: meta.bg,
                        border: `1px solid ${meta.border}`, color: meta.color, fontSize: 11, fontWeight: 800 }}>{p.pattern_type}</span>
                      <div style={{ height: 6, background: "rgba(255,255,255,0.05)", borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ width: `${wr}%`, height: "100%", background: meta.color, borderRadius: 3, transition: "width 0.8s" }} />
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 800, color: meta.color }}>{wr}%</span>
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{p.total}x</span>
                      <span style={{ fontSize: 11, color: Number(p.avg_result||0)>=0?"#34d399":"#f87171", fontWeight: 700 }}>
                        {Number(p.avg_result||0)>=0?"+":""}{Number(p.avg_result||0).toFixed(1)}%
                      </span>
                    </div>
                  );
                })}
                {(!stats.by_pattern || stats.by_pattern.length === 0) && (
                  <div style={{ padding: "24px 20px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                    Belum ada data pattern stats.
                  </div>
                )}
              </div>
            )}
          </>
        );
      })()}

      {/* ── DAILY PICKS TAB ── */}
      {recsTab === "picks" && (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          {/* Header + Run Button */}
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10 }}>
            <div>
              <div style={{ fontWeight:800, fontSize:16 }}>🎯 Daily Picks Scanner</div>
              <div style={{ fontSize:12, color:"var(--text-muted)", marginTop:2 }}>Auto-scan saham akumulasi broker · Last Val &gt; Rp10B · Day0 &gt; 0</div>
            </div>
            <div style={{ display:"flex", gap:8, alignItems:"center" }}>
              <button onClick={runScanner} style={{ background:"linear-gradient(135deg,#6366f1,#8b5cf6)", color:"#fff", border:"none", borderRadius:8, padding:"8px 16px", fontWeight:700, cursor:"pointer", fontSize:12 }}>▶ Run Scanner</button>
              {scannerMsg && <span style={{ fontSize:12, color:"#60a5fa" }}>{scannerMsg}</span>}
            </div>
          </div>

          {/* Win Rate Stats */}
          {picksWinRate && (
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))", gap:10 }}>
              {[
                { label:"Win Rate", val: `${picksWinRate.win_rate??0}%`, color:"#4ade80" },
                { label:"Closed", val:picksWinRate.closed??0, color:"#60a5fa" },
                { label:"Wins", val:picksWinRate.wins??0, color:"#4ade80" },
                { label:"Losses", val:picksWinRate.losses??0, color:"#f87171" },
                { label:"Avg P&L", val: `${picksWinRate.avg_pnl??0}%`, color:(picksWinRate.avg_pnl??0)>=0?"#4ade80":"#f87171" },
              ].map(s => (
                <div key={s.label} style={{ background:"var(--bg-secondary)", border:"1px solid var(--border)", borderRadius:10, padding:"12px 14px" }}>
                  <div style={{ fontSize:10, color:"var(--text-muted)", marginBottom:3 }}>{s.label}</div>
                  <div style={{ fontSize:20, fontWeight:800, color:s.color }}>{s.val}</div>
                </div>
              ))}
            </div>
          )}

          {/* Picks Table */}
          <div style={{ background:"var(--bg-secondary)", border:"1px solid var(--border)", borderRadius:12, overflow:"hidden" }}>
            <div style={{ padding:"12px 16px", borderBottom:"1px solid var(--border)", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontWeight:700, fontSize:13 }}>Scanner Results — {picksScanDate}</span>
              <span style={{ fontSize:11, color:"var(--text-muted)" }}>{picks.length} picks</span>
            </div>
            {picksLoading ? (
              <div style={{ textAlign:"center", padding:40, color:"var(--text-muted)" }}>Loading...</div>
            ) : picks.length === 0 ? (
              <div style={{ textAlign:"center", padding:40, color:"var(--text-muted)" }}>
                Belum ada picks — klik <strong>Run Scanner</strong>
              </div>
            ) : (
              <div style={{ overflowX:"auto" }}>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                  <thead>
                    <tr style={{ background:"var(--bg-primary)" }}>
                      {["TICKER","LAST VAL","D-3","D-2","D-1","D 0","+DAYS","SCORE","PRICE","STATUS","ACTION"].map(h=>(
                        <th key={h} style={{ padding:"9px 10px", textAlign:"left", color:"var(--text-muted)", fontWeight:600, fontSize:10, whiteSpace:"nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {picks.map(p => {
                      const concColor = (v:number) => v>0?"#4ade80":v<0?"#f87171":"#6b7280";
                      const statusMap: Record<string,{bg:string,color:string}> = {
                        PENDING:{bg:"#1e293b",color:"#94a3b8"}, WATCHING:{bg:"#1e3a5f",color:"#60a5fa"},
                        ACTIVE:{bg:"#1a3a2a",color:"#34d399"}, WIN:{bg:"#14532d",color:"#4ade80"},
                        LOSS:{bg:"#450a0a",color:"#f87171"}, SKIP:{bg:"#1c1c1c",color:"#6b7280"},
                      };
                      const st = statusMap[p.status]||statusMap.PENDING;
                      const lv = p.last_val_b>=1000?(p.last_val_b/1000).toFixed(1)+"T":p.last_val_b>=1?p.last_val_b.toFixed(1)+"B":(p.last_val_b*1000).toFixed(0)+"M";
                      return (
                        <tr key={p.id} style={{ borderTop:"1px solid var(--border)" }}>
                          <td style={{ padding:"9px 10px", fontWeight:700, color:"var(--text-primary)" }}>{p.ticker}</td>
                          <td style={{ padding:"9px 10px", color:"var(--text-muted)" }}>{lv}</td>
                          <td style={{ padding:"9px 10px", color:concColor(p.day3_conc), fontWeight:600 }}>{p.day3_conc>0?"+":""}{p.day3_conc?.toFixed(1)}%</td>
                          <td style={{ padding:"9px 10px", color:concColor(p.day2_conc), fontWeight:600 }}>{p.day2_conc>0?"+":""}{p.day2_conc?.toFixed(1)}%</td>
                          <td style={{ padding:"9px 10px", color:concColor(p.day1_conc), fontWeight:600 }}>{p.day1_conc>0?"+":""}{p.day1_conc?.toFixed(1)}%</td>
                          <td style={{ padding:"9px 10px", color:concColor(p.day0_conc), fontWeight:700, fontSize:13 }}>{p.day0_conc>0?"+":""}{p.day0_conc?.toFixed(1)}%</td>
                          <td style={{ padding:"9px 10px", color:"#a78bfa", fontWeight:700 }}>{p.positive_days}/4</td>
                          <td style={{ padding:"9px 10px", color:"#fbbf24", fontWeight:700 }}>{p.signal_score}</td>
                          <td style={{ padding:"9px 10px", color:"var(--text-muted)", fontSize:11 }}>{p.market_price?`Rp${Number(p.market_price).toLocaleString()}`:"-"}</td>
                          <td style={{ padding:"9px 10px" }}>
                            <span style={{ background:st.bg, color:st.color, borderRadius:5, padding:"2px 7px", fontSize:10, fontWeight:700 }}>{p.status}</span>
                          </td>
                          <td style={{ padding:"9px 10px" }}>
                            <button
                              onClick={()=>trackPick(p.ticker)}
                              disabled={trackedPickTickers.has(p.ticker) || trackingPickTicker===p.ticker}
                              style={{
                                background: trackedPickTickers.has(p.ticker) ? "rgba(63,185,80,0.12)" : "var(--bg-primary)",
                                color: trackedPickTickers.has(p.ticker) ? "#3fb950" : "#60a5fa",
                                border: "1px solid var(--border)", borderRadius:5, padding:"3px 8px",
                                cursor: trackedPickTickers.has(p.ticker) ? "default" : "pointer", fontSize:10,
                              }}
                            >
                              {trackedPickTickers.has(p.ticker) ? "✓ Tracked" : trackingPickTicker===p.ticker ? "..." : "📌 Track"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── BACKTEST TAB ── */}
      {recsTab === "backtest" && (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          {/* ── Run Panel ──────────────────────────────────────── */}
          <div style={{ background:"var(--bg-secondary)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 20px" }}>
            <div style={{ display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
              <span style={{ fontSize:14, fontWeight:800, color:"var(--text-primary)" }}>🔬 Historical Backtest</span>
              <div style={{ display:"flex", alignItems:"center", gap:6, marginLeft:"auto" }}>
                <label style={{ fontSize:11, color:"var(--text-muted)" }}>From:</label>
                <input type="date" value={btStartDate} onChange={e=>setBtStartDate(e.target.value)}
                  style={{ background:"var(--bg-primary)", border:"1px solid var(--border)", borderRadius:6, padding:"4px 8px", color:"var(--text-primary)", fontSize:12 }} />
                <label style={{ fontSize:11, color:"var(--text-muted)", marginLeft:8 }}>To:</label>
                <input type="date" value={btEndDate} onChange={e=>setBtEndDate(e.target.value)}
                  style={{ background:"var(--bg-primary)", border:"1px solid var(--border)", borderRadius:6, padding:"4px 8px", color:"var(--text-primary)", fontSize:12 }} />
                <div style={{ display:"flex", alignItems:"center", gap:6, marginLeft:8 }}>
                  <label style={{ fontSize:11, color:"var(--text-muted)", whiteSpace:"nowrap" }}>🎯 Min Score:</label>
                  <select value={btMinScore} onChange={e=>setBtMinScore(Number(e.target.value))}
                    style={{ background:"var(--bg-primary)", border:"1px solid var(--border)", borderRadius:6, padding:"4px 8px", color:"var(--text-primary)", fontSize:12, cursor:"pointer" }}>
                    <option value={50}>50 (semua)</option>
                    <option value={60}>60 (filtered)</option>
                    <option value={75}>75 (high only)</option>
                  </select>
                </div>
                <button onClick={()=>{runBacktest(); loadBacktestRuns();}} disabled={btRunning} style={{
                  background: btRunning?"#334155":"linear-gradient(135deg,#7c3aed,#2563eb)",
                  color:"#fff", border:"none", borderRadius:8, padding:"8px 20px",
                  fontWeight:700, cursor:btRunning?"not-allowed":"pointer", fontSize:13, marginLeft:8
                }}>
                  {btRunning ? "⏳ Running..." : "🚀 Run Backtest"}
                </button>
              </div>
            </div>
            {btRunning && btProgress && (
              <div style={{ marginTop:10, fontSize:12, color:"var(--text-muted)" }}>
                📊 Processing day {btProgress.processed}/{btProgress.total} — {btProgress.currentDate}
                <div style={{ height:4, background:"rgba(255,255,255,0.05)", borderRadius:2, marginTop:6, overflow:"hidden" }}>
                  <div style={{ width:`${btProgress.total>0 ? (btProgress.processed/btProgress.total)*100 : 0}%`, height:"100%", background:"linear-gradient(90deg,#7c3aed,#2563eb)", borderRadius:2, transition:"width 0.3s" }} />
                </div>
              </div>
            )}
          </div>

          {/* ── Previous Runs ──────────────────────────────────── */}
          {btRuns.length > 0 && (
            <div style={{ background:"var(--bg-secondary)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 16px" }}>
              <div style={{ fontSize:12, fontWeight:700, color:"var(--text-secondary)", marginBottom:8 }}>📁 Previous Runs</div>
              <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                {btRuns.map((r:any) => (
                  <div key={r.run_id} style={{ position: "relative", display: "inline-block" }}>
                    <button onClick={()=>loadBacktestResults(r.run_id)}
                      style={{ background: btActiveRunId===r.run_id ? "rgba(124,58,237,0.2)" : "var(--bg-primary)",
                        border: btActiveRunId===r.run_id ? "1px solid #7c3aed" : "1px solid var(--border)",
                        borderRadius:8, padding:"8px 12px", cursor:"pointer", color:"var(--text-primary)", fontSize:11, paddingRight: 30 }}>
                      <div style={{ fontWeight:700, textAlign:"left" }}>{String(r.start_date).slice(0,10)} → {String(r.end_date).slice(0,10)}</div>
                      <div style={{ fontSize:10, color:"var(--text-muted)", marginTop:2, textAlign:"left" }}>
                        {r.total_trades} trades · WR: <span style={{ color:Number(r.win_rate||0)>=50?"#4ade80":"#f87171", fontWeight:800 }}>{r.win_rate||0}%</span>
                        {r.min_score && <span style={{ marginLeft:4, color:"#a78bfa" }}>· S≥{r.min_score}</span>}
                      </div>
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); deleteBacktestRun(r.run_id); }}
                      style={{ position: "absolute", top: -5, right: -5, background: "#ef4444", color: "#fff", border: "none", borderRadius: "50%", width: 18, height: 18, fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "bold", zIndex: 10 }}>
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Stats Dashboard ────────────────────────────────── */}
          {btStats?.overall && (
            <>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(130px,1fr))", gap:10 }}>
                {[
                  { label:"Total Patterns", val:btStats.overall.total, color:"#60a5fa" },
                  { label:"Entered", val:btStats.overall.entered, color:"#a78bfa" },
                  { label:"No Entry", val:btStats.overall.no_entry, color:"#6b7280" },
                  { label:"Wins", val:btStats.overall.wins, color:"#4ade80" },
                  { label:"Losses", val:btStats.overall.losses, color:"#f87171" },
                  { label:"Expired", val:btStats.overall.expired, color:"#fbbf24" },
                  { label:"Win Rate", val:`${btStats.overall.win_rate||0}%`, color:Number(btStats.overall.win_rate||0)>=50?"#4ade80":"#f87171" },
                  { label:"Avg Return", val:`${Number(btStats.overall.avg_return||0)>=0?"+":""}${btStats.overall.avg_return||0}%`, color:Number(btStats.overall.avg_return||0)>=0?"#4ade80":"#f87171" },
                  { label:"Total Return", val:`${Number(btStats.overall.total_return||0)>=0?"+":""}${btStats.overall.total_return||0}%`, color:Number(btStats.overall.total_return||0)>=0?"#4ade80":"#f87171" },
                  { label:"Avg Hold", val:`${btStats.overall.avg_hold_days||0}d`, color:"#60a5fa" },
                ].map(s=>(
                  <div key={s.label} style={{ background:"var(--bg-secondary)", border:"1px solid var(--border)", borderRadius:10, padding:"14px 16px" }}>
                    <div style={{ fontSize:11, color:"var(--text-muted)", marginBottom:4, fontWeight:600 }}>{s.label}</div>
                    <div style={{ fontSize:22, fontWeight:900, color:s.color }}>{s.val}</div>
                  </div>
                ))}
              </div>

              {/* ── Win Rate by Pattern ─────────────────────────── */}
              <div style={{ background:"var(--bg-secondary)", border:"1px solid var(--border)", borderRadius:12, overflow:"hidden" }}>
                <div style={{ padding:"12px 16px", borderBottom:"1px solid var(--border)", fontSize:13, fontWeight:800, color:"var(--text-secondary)" }}>
                  📊 Win Rate by Pattern
                </div>
                {(btStats.by_pattern||[]).map((p:any) => {
                  const wr = Number(p.win_rate||0);
                  const meta: Record<string,{bg:string,color:string,border:string}> = {
                    ABCD:      {bg:"rgba(96,165,250,0.12)",color:"#60a5fa",border:"rgba(96,165,250,0.3)"},
                    GARTLEY:   {bg:"rgba(167,139,250,0.12)",color:"#a78bfa",border:"rgba(167,139,250,0.3)"},
                    BAT:       {bg:"rgba(52,211,153,0.12)",color:"#34d399",border:"rgba(52,211,153,0.3)"},
                    BUTTERFLY: {bg:"rgba(251,146,60,0.12)",color:"#fb923c",border:"rgba(251,146,60,0.3)"},
                    CRAB:      {bg:"rgba(248,113,113,0.12)",color:"#f87171",border:"rgba(248,113,113,0.3)"},
                    SHARK:     {bg:"rgba(56,189,248,0.12)",color:"#38bdf8",border:"rgba(56,189,248,0.3)"},
                    CYPHER:    {bg:"rgba(232,121,249,0.12)",color:"#e879f9",border:"rgba(232,121,249,0.3)"},
                  };
                  const m = meta[p.pattern_type] || meta.ABCD;
                  return (
                    <div key={p.pattern_type} style={{ display:"grid", gridTemplateColumns:"110px 1fr 70px 60px 60px 80px",
                      padding:"12px 16px", borderBottom:"1px solid rgba(48,54,61,0.5)", gap:12, alignItems:"center" }}>
                      <span style={{ padding:"4px 10px", borderRadius:6, background:m.bg, border:`1px solid ${m.border}`, color:m.color, fontSize:12, fontWeight:800 }}>{p.pattern_type}</span>
                      <div style={{ height:8, background:"rgba(255,255,255,0.05)", borderRadius:4, overflow:"hidden" }}>
                        <div style={{ width:`${wr}%`, height:"100%", background:m.color, borderRadius:4, transition:"width 0.8s" }} />
                      </div>
                      <span style={{ fontSize:15, fontWeight:900, color:wr>=50?"#4ade80":"#f87171" }}>{wr}%</span>
                      <span style={{ fontSize:12, color:"var(--text-muted)" }}>{p.total}x</span>
                      <span style={{ fontSize:12, color:"#4ade80", fontWeight:700 }}>{p.wins}W</span>
                      <span style={{ fontSize:12, fontWeight:700, color:Number(p.avg_return||0)>=0?"#4ade80":"#f87171" }}>
                        {Number(p.avg_return||0)>=0?"+":""}{Number(p.avg_return||0).toFixed(1)}%
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* ── Win Rate by Direction ───────────────────────── */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                {(btStats.by_direction||[]).map((d:any) => (
                  <div key={d.direction} style={{ background:"var(--bg-secondary)", border:"1px solid var(--border)", borderRadius:12, padding:"16px 20px" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                      <span style={{ fontSize:18 }}>{d.direction==="BULLISH"?"🐂":"🐻"}</span>
                      <span style={{ fontSize:14, fontWeight:800, color:d.direction==="BULLISH"?"#4ade80":"#f87171" }}>{d.direction}</span>
                    </div>
                    <div style={{ fontSize:28, fontWeight:900, color:Number(d.win_rate||0)>=50?"#4ade80":"#f87171" }}>{d.win_rate||0}%</div>
                    <div style={{ fontSize:11, color:"var(--text-muted)", marginTop:4 }}>{d.total} trades · avg {Number(d.avg_return||0)>=0?"+":""}{d.avg_return||0}%</div>
                  </div>
                ))}
              </div>

              {/* ── Top Tickers ─────────────────────────────────── */}
              {btStats.by_ticker && btStats.by_ticker.length > 0 && (
                <div style={{ background:"var(--bg-secondary)", border:"1px solid var(--border)", borderRadius:12, overflow:"hidden" }}>
                  <div style={{ padding:"12px 16px", borderBottom:"1px solid var(--border)", fontSize:13, fontWeight:800, color:"var(--text-secondary)" }}>
                    🏆 Top Tickers by Win Rate
                  </div>
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(160px,1fr))", gap:1, background:"var(--border)" }}>
                    {(btStats.by_ticker||[]).slice(0,12).map((t:any) => (
                      <div key={t.ticker} style={{ background:"var(--bg-secondary)", padding:"12px 14px" }}>
                        <div style={{ fontSize:14, fontWeight:900, color:"var(--text-primary)" }}>{t.ticker}</div>
                        <div style={{ fontSize:20, fontWeight:900, color:Number(t.win_rate||0)>=50?"#4ade80":"#f87171", marginTop:4 }}>{t.win_rate||0}%</div>
                        <div style={{ fontSize:10, color:"var(--text-muted)" }}>{t.total}x · {Number(t.total_return||0)>=0?"+":""}{t.total_return||0}%</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── Trades Table ───────────────────────────────────── */}
          {btResults?.trades && btResults.trades.length > 0 && (
            <div style={{ background:"var(--bg-secondary)", border:"1px solid var(--border)", borderRadius:12, overflow:"hidden" }}>
              <div style={{ padding:"12px 16px", borderBottom:"1px solid var(--border)", display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ fontSize:14, fontWeight:800, color:"var(--text-primary)" }}>📋 All Trades ({btResults.trades.filter((t:any)=>t.status!=='NO_ENTRY').length} entered / {btResults.total} detected)</span>
              </div>
              <div style={{ overflowX:"auto" }}>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1.2fr 0.5fr 0.7fr 0.9fr 0.9fr 0.8fr 0.8fr 1fr 1fr 0.6fr 0.9fr 1.1fr",
                  gap:6, padding:"8px 14px", borderBottom:"1px solid rgba(255,255,255,0.05)", minWidth:1000 }}>
                  {["TICKER","PATTERN","DIR","SCORE","DETECTED","ENTRY","SL","T1","EXIT PRICE","EXIT DATE","HOLD","RESULT","STATUS"].map(h=>(
                    <span key={h} style={{ fontSize:11, fontWeight:700, color:"var(--text-secondary)", letterSpacing:"0.06em" }}>{h}</span>
                  ))}
                </div>
                {btResults.trades.filter((t:any)=>t.status!=='NO_ENTRY').map((t:any,i:number) => {
                  const isWin = ['HIT_T1','HIT_T2'].includes(t.status);
                  const pnl = Number(t.result_pct||0);
                  const patMeta: Record<string,{bg:string,color:string,border:string}> = {
                    ABCD:{bg:"rgba(96,165,250,0.12)",color:"#60a5fa",border:"rgba(96,165,250,0.3)"},
                    GARTLEY:{bg:"rgba(167,139,250,0.12)",color:"#a78bfa",border:"rgba(167,139,250,0.3)"},
                    BAT:{bg:"rgba(52,211,153,0.12)",color:"#34d399",border:"rgba(52,211,153,0.3)"},
                    BUTTERFLY:{bg:"rgba(251,146,60,0.12)",color:"#fb923c",border:"rgba(251,146,60,0.3)"},
                    CRAB:{bg:"rgba(248,113,113,0.12)",color:"#f87171",border:"rgba(248,113,113,0.3)"},
                    SHARK:{bg:"rgba(56,189,248,0.12)",color:"#38bdf8",border:"rgba(56,189,248,0.3)"},
                    CYPHER:{bg:"rgba(232,121,249,0.12)",color:"#e879f9",border:"rgba(232,121,249,0.3)"},
                  };
                  const pm = patMeta[t.pattern_type] || patMeta.ABCD;
                  const fmtD = (d:string) => d ? new Date(d).toLocaleDateString("id-ID",{day:"2-digit",month:"short"}) : "–";
                  const statusLabel: Record<string,string> = { HIT_T1:"HIT T1 🎯", HIT_T2:"HIT T2 🎯🎯", STOPPED:"STOP 🛑", EXPIRED:"EXPIRED ⏰", NO_ENTRY:"NO ENTRY" };
                  return (
                    <div key={i} style={{ display:"grid", gridTemplateColumns:"1fr 1.2fr 0.5fr 0.7fr 0.9fr 0.9fr 0.8fr 0.8fr 1fr 1fr 0.6fr 0.9fr 1.1fr",
                      gap:6, padding:"10px 14px", borderBottom:"1px solid rgba(48,54,61,0.4)", alignItems:"center", minWidth:1000,
                      background: isWin?"rgba(52,211,153,0.03)":"rgba(248,113,113,0.03)" }}>
                      <span style={{ fontSize:13, fontWeight:900, color:"var(--text-primary)" }}>{t.ticker}</span>
                      <span style={{ fontSize:10, fontWeight:700, padding:"3px 7px", borderRadius:5, background:pm.bg, color:pm.color, border:`1px solid ${pm.border}` }}>{t.pattern_type}</span>
                      <span style={{ fontSize:12, fontWeight:800, color:t.direction==="BULLISH"?"#34d399":"#f87171" }}>{t.direction==="BULLISH"?"▲":"▼"}</span>
                      <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                        <span style={{ fontSize:13, fontWeight:900,
                          color: (t.conviction_score||t.confluence_score||0)>=75?"#4ade80":(t.conviction_score||t.confluence_score||0)>=60?"#fbbf24":"#94a3b8" }}>
                          {t.conviction_score||t.confluence_score||0}
                        </span>
                        <div style={{ display:"flex", gap:2 }}>
                          {(() => {
                            try {
                              const pd = typeof t.pattern_data==='string' ? JSON.parse(t.pattern_data) : t.pattern_data;
                              const cf = pd?.confluence || {};
                              return [
                                {k:'L2', v: cf.l2_trend >= 15},
                                {k:'L3', v: cf.l3_volume >= 15},
                                {k:'L4', v: cf.l4_broker >= 15},
                              ].map(({k,v}) => (
                                <span key={k} style={{ fontSize:9, padding:"1px 4px", borderRadius:3,
                                  background: v?"rgba(52,211,153,0.2)":"rgba(100,100,100,0.2)",
                                  color: v?"#34d399":"#6b7280", fontWeight:700 }}>{k}</span>
                              ));
                            } catch { return null; }
                          })()}
                        </div>
                      </div>
                      <span style={{ fontSize:11, color:"#60a5fa", fontWeight:600 }}>{fmtD(t.detected_date)}</span>
                      <span style={{ fontSize:12, fontWeight:800, color:"var(--text-primary)" }}>{t.entry_price ? Number(t.entry_price).toLocaleString("id-ID") : "–"}</span>
                      <span style={{ fontSize:11, color:"#f87171" }}>{Number(t.stop_loss).toLocaleString("id-ID")}</span>
                      <span style={{ fontSize:11, color:"#4ade80" }}>{Number(t.target_1).toLocaleString("id-ID")}</span>
                      <span style={{ fontSize:12, fontWeight:800, color:isWin?"#4ade80":"#f87171" }}>{t.exit_price ? Number(t.exit_price).toLocaleString("id-ID") : "–"}</span>
                      <span style={{ fontSize:11, color:"var(--text-muted)" }}>{fmtD(t.exit_date)}</span>
                      <span style={{ fontSize:12, fontWeight:800, color:t.hold_days<=3?"#4ade80":t.hold_days<=7?"#fbbf24":"#f87171" }}>{t.hold_days !== null ? `${t.hold_days}d` : "–"}</span>
                      <span style={{ fontSize:14, fontWeight:900, color:pnl>0?"#4ade80":pnl<0?"#f87171":"var(--text-muted)" }}>
                        {pnl>0?"+":""}{pnl.toFixed(2)}%
                      </span>
                      <span style={{ padding:"3px 8px", borderRadius:5, fontSize:10, fontWeight:800,
                        background:isWin?"rgba(52,211,153,0.12)":"rgba(248,113,113,0.12)",
                        color:isWin?"#34d399":"#f87171",
                        border:`1px solid ${isWin?"rgba(52,211,153,0.25)":"rgba(248,113,113,0.25)"}` }}>
                        {statusLabel[t.status] || t.status}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Empty State ────────────────────────────────────── */}
          {!btStats?.overall && !btRunning && (
            <div style={{ textAlign:"center", padding:60, color:"var(--text-muted)" }}>
              <div style={{ fontSize:48, marginBottom:12 }}>🔬</div>
              <div style={{ fontWeight:700, fontSize:16, marginBottom:8 }}>Historical Backtest Engine</div>
              <div style={{ fontSize:13, maxWidth:400, margin:"0 auto", lineHeight:1.6 }}>
                Pilih range tanggal dan klik <strong style={{ color:"#a78bfa" }}>Run Backtest</strong> untuk scan semua harmonic patterns secara historical dan simulasi trading otomatis.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Main Page ───────────────────────────────────────────────── */
export default function SignalScannerPage() {
  const [view, setView] = useState<"signals" | "screener" | "harmonic">("signals");

  /* ── Signal Scanner state ── */
  const [rows, setRows]       = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [date, setDate]       = useState("");
  const [filter, setFilter]   = useState("ALL");
  const [sigSortCol, setSigSortCol] = useState("SCORE");
  const [sigSortAsc, setSigSortAsc] = useState(false);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [market, setMarket]   = useState<any>(null);
  const [ihsg, setIhsg] = useState<any>(null);
  const [ihsgFactors, setIhsgFactors] = useState<any>(null);
  const [ihsgHistory, setIhsgHistory] = useState<any[]>([]);
  const [ihsgPatterns, setIhsgPatterns] = useState<any[]>([]);
  const [showIhsgFactors, setShowIhsgFactors] = useState(false);
  const [ihsgRange, setIhsgRange] = useState("1M");
  const [ihsgSortCol, setIhsgSortCol] = useState("TANGGAL");
  const [ihsgSortAsc, setIhsgSortAsc] = useState(false);
  const [ihsgIntraday, setIhsgIntraday] = useState<any[]>([]);
  const [ihsgIntradayLoading, setIhsgIntradayLoading] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/api/ihsg-factors?history=1`)
      .then(r => r.json())
      .then(json => {
        setIhsgFactors(json.current || null);
        setIhsgHistory(json.history || []);
        setIhsgPatterns(json.patterns || []);
      })
      .catch(() => {});
  }, []);

  // "1D" is intraday (5-min bars, today only) — a fundamentally different
  // data source (live-fetched, not the daily idx_ihsg_history table), so it
  // gets its own fetch rather than being derived from ihsgHistory.
  useEffect(() => {
    if (ihsgRange !== "1D" || !showIhsgFactors) return;
    setIhsgIntradayLoading(true);
    fetch(`${API_BASE}/api/ihsg-intraday`)
      .then(r => r.json())
      .then(json => setIhsgIntraday(json.candles || []))
      .catch(() => setIhsgIntraday([]))
      .finally(() => setIhsgIntradayLoading(false));
  }, [ihsgRange, showIhsgFactors]);

  // Live composite score — same 7-factor formula as the daily snapshot, but
  // today's candle comes from live intraday bars and Breadth from a live
  // fetch across all 245 tracked tickers (see computeIHSGFactorsLive), so
  // this only takes effect while the factor panel is actually open.
  useEffect(() => {
    if (!showIhsgFactors) return;
    let cancelled = false;
    const poll = () => {
      fetch(`${API_BASE}/api/ihsg-factors-live`)
        .then(r => r.json())
        .then(json => { if (!cancelled && json.current) setIhsgFactors(json.current); })
        .catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 60000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [showIhsgFactors]);

  const IHSG_RANGES: { key: string; label: string; days: number | null }[] = [
    { key: "1D", label: "1H", days: 1 }, { key: "1W", label: "1M", days: 7 },
    { key: "1M", label: "1B", days: 30 }, { key: "3M", label: "3B", days: 90 },
    { key: "ALL", label: "Semua", days: null },
  ];
  const IHSG_COL_TO_KEY: Record<string, string> = {
    "TANGGAL": "date", "OPEN": "openPrice", "CLOSE": "closePrice", "%CHG": "changePct",
    "SKOR": "composite", "TREND": "trend", "BREADTH": "breadth", "RSI": "rsi",
    "MACD": "macd", "BOLL.": "bollinger", "EMA": "emaTrend", "S/R": "supportResistance", "ATR": "atr",
  };
  const ihsgFilteredHistory = (() => {
    if (!ihsgHistory.length) return [];
    const def = IHSG_RANGES.find(r => r.key === ihsgRange) || IHSG_RANGES[2];
    let list = ihsgHistory;
    if (def.days !== null) {
      const cutoff = new Date(ihsgHistory[ihsgHistory.length - 1].date);
      cutoff.setDate(cutoff.getDate() - def.days);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      list = ihsgHistory.filter(h => h.date >= cutoffStr);
    }
    const dir = ihsgSortAsc ? 1 : -1;
    const key = IHSG_COL_TO_KEY[ihsgSortCol] || "date";
    return [...list].sort((a, b) => {
      const valA = a[key], valB = b[key];
      if (valA === null || valA === undefined) return 1;
      if (valB === null || valB === undefined) return -1;
      if (typeof valA === "string") return dir * String(valA).localeCompare(String(valB));
      return dir * ((valA as number) - (valB as number));
    });
  })();
  const [engineVersion, setEngineVersion] = useState("");
  const [engineWeights, setEngineWeights] = useState<EngineWeights | undefined>(undefined);
  const [savedAwoTickers, setSavedAwoTickers] = useState<Set<string>>(new Set());
  const [savingAwoTicker, setSavingAwoTicker] = useState<string | null>(null);

  /* ── Smart Money Screener state ── */
  const [scData, setScData]     = useState<any>(null);
  const [scLoading, setScLoading] = useState(false);
  const [scSort, setScSort]     = useState<"foreign" | "score" | "turnover">("foreign");
  const [showAllSc, setShowAllSc] = useState(false);
  const [shortedTickers, setShortedTickers] = useState<Set<string>>(new Set());
  const [shortingTicker, setShortingTicker] = useState<string | null>(null);

  /* ── User-defined SL/TP % — applies universally to every journal save
     (AWO signals, WATCH, manual Short) once enabled, instead of relying only
     on the backend's ATR/support-resistance trade plan. Persisted in
     localStorage since this app has no per-user backend auth. ── */
  const [slTpSettings, setSlTpSettings] = useState({ enabled: false, slPct: 3, tp1Pct: 4.5, tp2Pct: 7.5 });
  const [showSlTpPanel, setShowSlTpPanel] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("ft_sltp_settings");
      if (saved) setSlTpSettings(JSON.parse(saved));
    } catch {}
  }, []);

  const saveSlTpSettings = (next: typeof slTpSettings) => {
    setSlTpSettings(next);
    try { localStorage.setItem("ft_sltp_settings", JSON.stringify(next)); } catch {}
  };

  /** Computes SL/T1/T2 from the user's own %, for a given entry price + direction. */
  const computeCustomPlan = (price: number, isBullish: boolean) => {
    const dir = isBullish ? 1 : -1;
    const stopLoss = price - dir * (price * slTpSettings.slPct / 100);
    const target1 = price + dir * (price * slTpSettings.tp1Pct / 100);
    const target2 = price + dir * (price * slTpSettings.tp2Pct / 100);
    const risk = Math.abs(price - stopLoss) || 1;
    const riskReward = Math.round((Math.abs(target1 - price) / risk) * 10) / 10;
    return { entry: price, stopLoss: Math.round(stopLoss), target1: Math.round(target1), target2: Math.round(target2), riskReward };
  };

  /* ── Signal fetch ── */
  const fetch_data = () => {
    setLoading(true);
    fetch(`${API_BASE}/api/signal-scanner`)
      .then(r => r.json())
      .then(json => {
        setRows(json.data || []);
        setDate(json.date || "");
        setMarket(json.market || null);
        setIhsg(json.ihsg || null);
        setEngineVersion(json.engine?.version || "");
        setEngineWeights(json.engine?.weights || undefined);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  /* ── Historical view — idx_signal_history already keeps a daily snapshot
     per ticker (upserted on every live scan), so past dates are real saved
     data, not a recompute. scanDate === "" means live/today. ── */
  const [scanDate, setScanDate] = useState("");
  const [availableDates, setAvailableDates] = useState<string[]>([]);

  useEffect(() => {
    fetch(`${API_BASE}/api/signal-scanner-history`)
      .then(r => r.json())
      .then(json => setAvailableDates(json.dates || []))
      .catch(() => {});
  }, []);

  const fetchHistoryData = (d: string) => {
    setLoading(true);
    fetch(`${API_BASE}/api/signal-scanner-history?date=${d}`)
      .then(r => r.json())
      .then(json => {
        setRows(json.data || []);
        setDate(json.date || d);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  const handleScanDateChange = (d: string) => {
    setScanDate(d);
    if (d === "") fetch_data();
    else fetchHistoryData(d);
  };

  // Same labels/lookback windows as the IHSG panel's range buttons, for a
  // consistent feel — but here each one jumps to the single closest
  // available date within that lookback (availableDates is sorted DESC),
  // rather than filtering a multi-row history table like IHSG's own does.
  const TICKER_TIME_RANGES: { key: string; label: string; days: number }[] = [
    { key: "1D", label: "1H", days: 1 }, { key: "1W", label: "1M", days: 7 },
    { key: "1M", label: "1B", days: 30 }, { key: "3M", label: "3B", days: 90 },
  ];
  const jumpToRange = (days: number | null) => {
    if (!availableDates.length) return;
    if (days === null) {
      handleScanDateChange(availableDates[availableDates.length - 1]); // oldest available
      return;
    }
    const target = new Date();
    target.setDate(target.getDate() - days);
    const targetStr = target.toISOString().slice(0, 10);
    const found = availableDates.find(d => d <= targetStr);
    handleScanDateChange(found || availableDates[availableDates.length - 1]);
  };

  /* ── Save an AWO signal + its trade plan into the shared journal (ft_recommendations) ── */
  const saveAwoToJournal = async (row: any) => {
    if (!row.tradePlan || savingAwoTicker) return;
    setSavingAwoTicker(row.ticker);
    try {
      const isBullish = row.signal === "STRONG BUY" || row.signal === "BUY" || row.signal === "WATCH";
      const plan = slTpSettings.enabled ? computeCustomPlan(row.tradePlan.entry, isBullish) : row.tradePlan;
      const res = await fetch(`${API_BASE}/api/recommendations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: row.ticker,
          pattern_type: "AWO_SIGNAL",
          direction: isBullish ? "BULLISH" : "BEARISH",
          detected_date: date || new Date().toISOString().slice(0, 10),
          entry_min: plan.entry,
          entry_max: plan.entry,
          stop_loss: plan.stopLoss,
          target_1: plan.target1,
          target_2: plan.target2,
          risk_reward: plan.riskReward,
          conviction_score: row.score,
          notes: `AWO ${row.signal} · confidence ${row.confidence}% · engine v${engineVersion || "3.0-awo"}${slTpSettings.enabled ? ` · SL/TP custom ${slTpSettings.slPct}%/${slTpSettings.tp1Pct}%` : ""}`,
        }),
      });
      const json = await res.json();
      if (json.success) {
        setSavedAwoTickers(prev => new Set(prev).add(row.ticker));
      }
    } catch {
      // silently fail — button stays actionable so the user can retry
    } finally {
      setSavingAwoTicker(null);
    }
  };

  /* ── Manual SHORT — available on any row regardless of its own signal,
     since the trader may want to short against the system's own read (e.g.
     short a BUY-signal stock on their own bearish view). Computes its own
     simple bearish plan from the live price (same 3% risk-unit fallback the
     backend uses when no ATR is available) rather than reusing row.tradePlan,
     which is only bullish for BUY/WATCH rows. NOT a check of IDX's official
     short-sell eligibility list — see the SHORT tab's tooltip caveat. ── */
  const shortToJournal = async (row: any) => {
    if (!row.price || row.price <= 0 || shortingTicker) return;
    setShortingTicker(row.ticker);
    try {
      const plan = slTpSettings.enabled
        ? computeCustomPlan(row.price, false)
        : (() => {
            const riskUnit = row.price * 0.03;
            return { entry: row.price, stopLoss: Math.round(row.price + riskUnit), target1: Math.round(row.price - riskUnit * 1.5), target2: Math.round(row.price - riskUnit * 2.5), riskReward: 1.5 };
          })();
      const res = await fetch(`${API_BASE}/api/recommendations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: row.ticker,
          pattern_type: "AWO_SIGNAL",
          direction: "BEARISH",
          detected_date: date || new Date().toISOString().slice(0, 10),
          entry_min: plan.entry,
          entry_max: plan.entry,
          stop_loss: plan.stopLoss,
          target_1: plan.target1,
          target_2: plan.target2,
          risk_reward: plan.riskReward,
          conviction_score: row.score,
          notes: `Manual SHORT · sinyal sistem: ${row.signal} · belum ngecek eligibilitas short-sell resmi IDX${slTpSettings.enabled ? ` · SL/TP custom ${slTpSettings.slPct}%/${slTpSettings.tp1Pct}%` : ""}`,
        }),
      });
      const json = await res.json();
      if (json.success) {
        setShortedTickers(prev => new Set(prev).add(row.ticker));
      }
    } catch {
      // silently fail — button stays actionable so the user can retry
    } finally {
      setShortingTicker(null);
    }
  };

  /* ── Screener fetch ── */
  const fetchScreener = useCallback(() => {
    setScLoading(true);
    fetch(`${API_BASE}/api/screener/smart-money`)
      .then(r => r.json())
      .then(d => setScData(d))
      .catch(() => {})
      .finally(() => setScLoading(false));
  }, []);

  useEffect(() => { fetch_data(); }, []);
  useEffect(() => { if (view === "screener" && !scData) fetchScreener(); }, [view, scData, fetchScreener]);

  /* ── Signal computed ── */
  const counts = useMemo(() => ({
    all: rows.length,
    strong_buy:  rows.filter(r => r.signal === "STRONG BUY").length,
    buy:         rows.filter(r => r.signal === "BUY").length,
    watch:       rows.filter(r => r.signal === "WATCH").length,
    sell:        rows.filter(r => r.signal === "SELL").length,
    strong_sell: rows.filter(r => r.signal === "STRONG SELL").length,
  }), [rows]);

  const filtered = useMemo(() => {
    let data = filter === "ALL" ? rows
      : filter === "SHORT" ? rows.filter(r => r.signal === "SELL" || r.signal === "STRONG SELL")
      : rows.filter(r => r.signal === filter);

    const dir = sigSortAsc ? 1 : -1;
    data = [...data].sort((a, b) => {
      let valA: any, valB: any;
      switch (sigSortCol) {
        case "TICKER":      valA = a.ticker; valB = b.ticker; break;
        case "PRICE":       valA = a.price; valB = b.price; break;
        case "CHG%":        valA = a.dailyChange; valB = b.dailyChange; break;
        case "SIGNAL":      valA = a.score; valB = b.score; break; // signal strength order = score order
        case "SCORE":       valA = a.score; valB = b.score; break;
        case "CONF.":       valA = a.confidence; valB = b.confidence; break;
        case "TOP BUYER":   valA = a.topBuyer || ""; valB = b.topBuyer || ""; break;
        case "TOP SELLER":  valA = a.topSeller || ""; valB = b.topSeller || ""; break;
        default:            valA = a.score; valB = b.score;
      }
      if (typeof valA === "string") return dir * valA.localeCompare(valB);
      return dir * ((valA ?? 0) - (valB ?? 0));
    });
    return data;
  }, [rows, filter, sigSortCol, sigSortAsc]);

  const bullish   = rows.filter(r => r.score >= 56).length;
  const sentiment = rows.length > 0 ? Math.round((bullish / rows.length) * 100) : 50;
  const sentColor = sentiment >= 60 ? "#3fb950" : sentiment <= 40 ? "#f85149" : "#e3b341";

  /* ── Screener computed ── */
  const scResults = useMemo(() => {
    if (!scData?.results) return [];
    return [...scData.results].sort((a: any, b: any) => {
      if (scSort === "foreign")   return b.foreign_3d_B - a.foreign_3d_B;
      if (scSort === "score")     return b.accum_score - a.accum_score;
      return b.turnover_d0_B - a.turnover_d0_B;
    });
  }, [scData, scSort]);

  const scDisplayed = showAllSc ? scResults : scResults.filter((r: any) => r.step3_pass);

  const stats = [
    { label: "SCANNED",       value: rows.length,                   color: "#58a6ff", sub: "stocks" },
    { label: "STRONG BUY",    value: counts.strong_buy,             color: "#3fb950", sub: "signals" },
    { label: "BUY",           value: counts.buy,                    color: "#56d364", sub: "signals" },
    { label: "SELL / S.SELL", value: counts.sell + counts.strong_sell, color: "#f85149", sub: "signals" },
    { label: "SENTIMENT",     value: `${market?.breadthPct ?? sentiment}%`, color: (market?.breadthPct ?? sentiment) >= 60 ? "#3fb950" : (market?.breadthPct ?? sentiment) <= 40 ? "#f85149" : "#e3b341", sub: (market?.breadthPct ?? sentiment) >= 60 ? "BULLISH" : (market?.breadthPct ?? sentiment) <= 40 ? "BEARISH" : "NEUTRAL" },
  ];

  const tabs = [
    { key: "ALL",         label: "ALL",        cnt: counts.all,        col: "#58a6ff" },
    { key: "STRONG BUY",  label: "STRONG BUY", cnt: counts.strong_buy, col: "#3fb950" },
    { key: "BUY",         label: "BUY",        cnt: counts.buy,        col: "#56d364" },
    { key: "WATCH",       label: "WATCH",      cnt: counts.watch,      col: "#e3b341" },
    { key: "SELL",        label: "SELL",       cnt: counts.sell,       col: "#f85149" },
    { key: "STRONG SELL", label: "STRONG SELL",cnt: counts.strong_sell,col: "#ff4444" },
  ];

  const COLS = "40px 88px 112px 72px 152px 100px 160px 108px 108px 88px 1fr";

  const viewTitles: Record<string, string> = {
    signals: "SIGNAL SCANNER",
    screener: "SMART MONEY SCREENER",
    harmonic: "HARMONIC PATTERN SCANNER",
  };
  const viewSubs: Record<string, React.ReactNode> = {
    signals: <>Multi-factor smart money confluence detector{date && <> · <strong style={{ color: "var(--text-secondary)" }}>Data: {date}</strong></>}</>,
    screener: <>4-step filter: Likuiditas → Momentum → Foreign → 6M Akumulasi{scData?.meta?.d0 && <> · <strong style={{ color: "var(--text-secondary)" }}>Data: {scData.meta.d0}</strong></>}</>,
    harmonic: <>ZigZag swing detection + Fibonacci ratio validator · ABCD · Gartley · Bat · Butterfly · Crab</>,
  };

  return (
    <>
      <Navbar />
      <main style={{ maxWidth: 1500, margin: "0 auto", padding: "28px 24px 48px" }}>

        {/* ── Header ── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
              <div style={{ width: 4, height: 34, background: "linear-gradient(180deg, #2f81f7, #39d2f5)", borderRadius: 2 }} />
              <div>
                <h1 style={{ fontSize: 26, fontWeight: 900, color: "var(--text-primary)", letterSpacing: "0.04em", margin: 0 }}>
                  {viewTitles[view]}
                </h1>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3, letterSpacing: "0.02em" }}>
                  {viewSubs[view]}
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* View Toggle */}
            <div style={{ display: "flex", background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 10, padding: 3, gap: 2 }}>
              {[
                { key: "signals",  label: "⚡ Signals" },
                { key: "screener", label: "🔍 Smart Money" },
                { key: "harmonic", label: "🔷 Harmonic" },
              ].map(v => (
                <button key={v.key} onClick={() => setView(v.key as any)} style={{
                  padding: "7px 16px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700,
                  background: view === v.key
                    ? v.key === "harmonic"
                      ? "linear-gradient(135deg, #6366f1, #8b5cf6)"
                      : "linear-gradient(135deg, #2f81f7, #39d2f5)"
                    : "transparent",
                  color: view === v.key ? "#fff" : "var(--text-muted)", transition: "all 0.2s",
                }}>{v.label}</button>
              ))}
            </div>

            {/* Refresh (only for signals & screener) */}
            {view !== "harmonic" && (
              <button onClick={view === "signals" ? fetch_data : fetchScreener}
                disabled={view === "signals" ? loading : scLoading}
                style={{
                  padding: "9px 20px", borderRadius: 8, border: "1px solid var(--border)",
                  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
                  cursor: (view === "signals" ? loading : scLoading) ? "not-allowed" : "pointer",
                  fontSize: 12, fontWeight: 700, opacity: (view === "signals" ? loading : scLoading) ? 0.5 : 1,
                  display: "flex", alignItems: "center", gap: 8, transition: "all 0.2s",
                }}>
                <span style={{ display: "inline-block", animation: (view === "signals" ? loading : scLoading) ? "spin 1s linear infinite" : "none", fontSize: 14 }}>⟳</span>
                {(view === "signals" ? loading : scLoading) ? "Loading..." : "Refresh"}
              </button>
            )}
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════
            VIEW: SIGNAL SCANNER
        ══════════════════════════════════════════════════════════ */}
        {view === "signals" && (
          <>
            {/* Time frame — idx_signal_history has a real daily snapshot per
                ticker (see project memory), so past dates show what the
                scanner actually said that day, not a re-run of today's logic.
                Range buttons mirror the IHSG panel's 1H/1M/1B/3B/Semua style
                — each jumps to the closest available date within that
                lookback (single-snapshot table, so "range" means "which one
                date to jump to," not "show N dates at once" like IHSG's own
                per-instrument history table does). */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)" }}>🕐 TIME FRAME:</span>
              <div style={{ display: "flex", gap: 4 }}>
                <button onClick={() => handleScanDateChange("")} style={{
                  padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700,
                  border: `1px solid ${scanDate === "" ? "#58a6ff" : "var(--border)"}`,
                  background: scanDate === "" ? "rgba(88,166,255,0.12)" : "transparent",
                  color: scanDate === "" ? "#58a6ff" : "var(--text-muted)",
                }}>🔴 LIVE</button>
                {TICKER_TIME_RANGES.map(r => (
                  <button key={r.key} onClick={() => jumpToRange(r.days)} style={{
                    padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700,
                    border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)",
                  }}>{r.label}</button>
                ))}
                <button onClick={() => jumpToRange(null)} style={{
                  padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700,
                  border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)",
                }}>Terlama</button>
              </div>
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>atau pilih tanggal persis:</span>
              <select value={scanDate} onChange={e => handleScanDateChange(e.target.value)} style={{
                padding: "6px 12px", borderRadius: 7, fontSize: 12, fontWeight: 700,
                border: `1px solid ${scanDate === "" ? "#58a6ff" : "var(--border)"}`,
                background: "var(--bg-secondary)", color: scanDate === "" ? "#58a6ff" : "var(--text-primary)",
                cursor: "pointer",
              }}>
                <option value="">🔴 LIVE (hari ini)</option>
                {availableDates.map(d => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
              {scanDate !== "" && (
                <span style={{ fontSize: 10, color: "#e3b341", fontWeight: 700 }}>
                  📌 Histori {scanDate} — data tersimpan asli, bukan recompute. Beberapa kolom (trade plan, tier, weekly trend) gak tersedia untuk histori.
                </span>
              )}
            </div>

            {/* IHSG Macro Context */}
            {ihsg && (
              <div style={{
                display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
                background: "var(--bg-secondary)", border: "1px solid var(--border)",
                borderRadius: 12, padding: "12px 20px", marginBottom: 14,
              }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: "#f7c948", letterSpacing: "0.08em" }}>📊 IHSG</span>
                <span style={{ fontSize: 16, fontWeight: 900, color: "var(--text-primary)" }}>
                  {ihsg.price?.toLocaleString("id-ID")}
                </span>
                <span style={{ fontSize: 13, fontWeight: 800, color: ihsg.changePct >= 0 ? "#3fb950" : "#f85149" }}>
                  {ihsg.changePct >= 0 ? "+" : ""}{ihsg.changePct}%
                </span>
                {ihsg.weeklyTrend && ihsg.weeklyTrend !== "NEUTRAL" && (
                  <span style={{
                    fontSize: 10, fontWeight: 800, padding: "3px 9px", borderRadius: 5,
                    background: ihsg.weeklyTrend === "BULLISH" ? "rgba(63,185,80,0.12)" : "rgba(248,81,73,0.12)",
                    color: ihsg.weeklyTrend === "BULLISH" ? "#3fb950" : "#f85149",
                    border: `1px solid ${ihsg.weeklyTrend === "BULLISH" ? "rgba(63,185,80,0.35)" : "rgba(248,81,73,0.35)"}`,
                  }}>
                    {ihsg.weeklyTrend === "BULLISH" ? "W▲ UPTREND" : "W▼ DOWNTREND"}
                  </span>
                )}
                <span title="Rata-rata perubahan harian 10 hari terakhir — dasar Conviction Tier BUY/SELL"
                  style={{ fontSize: 10, color: "var(--text-muted)" }}>
                  10D avg: {ihsg.avgDailyChange10d >= 0 ? "+" : ""}{ihsg.avgDailyChange10d}%/hari
                </span>
                {/* The 200d SMA regime gate. Shown here because it is the one
                    line that decides whether the strategy engine takes ANY
                    position — a screener full of BUY signals means nothing on a
                    day this gate is shut, and that was invisible until now. */}
                {ihsg.regime && (
                  <span
                    title={`Gerbang regime 200d SMA (rata-rata sederhana, bukan EMA) — sumber: modules/strategy_book.js, fungsi yang sama dipakai mesin strateginya.\nIHSG ${ihsg.price?.toLocaleString("id-ID")} vs SMA200 ${ihsg.regime.sma200?.toLocaleString("id-ID")}.\n${ihsg.regime.below ? "Di BAWAH garis: exposure 0, sistem minggir." : "Di ATAS garis: sistem boleh ambil posisi."}\nSudah ${ihsg.regime.sessions} sesi di sisi ini, sejak ${ihsg.regime.since}.`}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      fontSize: 10, fontWeight: 800, padding: "3px 9px", borderRadius: 5, cursor: "help",
                      background: ihsg.regime.below ? "rgba(248,81,73,0.12)" : "rgba(63,185,80,0.12)",
                      color: ihsg.regime.below ? "#f85149" : "#3fb950",
                      border: `1px solid ${ihsg.regime.below ? "rgba(248,81,73,0.35)" : "rgba(63,185,80,0.35)"}`,
                    }}>
                    {ihsg.regime.below ? "⛔" : "✅"} SMA200 {ihsg.regime.sma200?.toLocaleString("id-ID")}
                    <span style={{ opacity: 0.85, fontWeight: 700 }}>
                      ({ihsg.regime.gapPct >= 0 ? "+" : ""}{ihsg.regime.gapPct}%)
                    </span>
                    <span style={{ opacity: 0.7, fontWeight: 700 }}>
                      · {ihsg.regime.below ? "STAND ASIDE" : "INVESTED"}
                    </span>
                  </span>
                )}
                {ihsgFactors && (
                  <button onClick={() => setShowIhsgFactors(p => !p)} style={{
                    display: "flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 5,
                    cursor: "pointer", fontSize: 10, fontWeight: 800, border: "1px solid var(--border)",
                    background: showIhsgFactors ? "rgba(88,166,255,0.1)" : "transparent",
                    color: ihsgFactors.trend === "BULLISH" ? "#3fb950" : ihsgFactors.trend === "BEARISH" ? "#f85149" : "#e3b341",
                  }}>
                    🧩 Skor Faktor: {ihsgFactors.composite} ({ihsgFactors.trend}) {showIhsgFactors ? "▲" : "▼"}
                  </button>
                )}
                {showIhsgFactors && ihsgFactors?.isLive && (
                  <span title="Skor & breadth di-update live tiap 60 detik selama panel ini kebuka — jam diambil dari timestamp resmi Yahoo Finance, bukan jam server" style={{
                    display: "flex", alignItems: "center", gap: 4, fontSize: 9, fontWeight: 800,
                    padding: "2px 8px", borderRadius: 5, color: "#f85149",
                  }}>
                    <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "#f85149", display: "inline-block" }} />
                    LIVE{ihsgFactors.yahooTime ? ` ${ihsgFactors.yahooTime} WIB` : ""}
                  </span>
                )}
                <span style={{ fontSize: 9, color: "var(--text-muted)", marginLeft: "auto" }}>as of {ihsg.asOf}</span>
                {ihsg.regime?.below && (
                  <div style={{
                    width: "100%", fontSize: 10, lineHeight: 1.5, color: "var(--text-muted)",
                    borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 2,
                  }}>
                    IHSG sudah <b style={{ color: "#f85149" }}>{ihsg.regime.sessions} sesi</b> di bawah SMA200-nya, sejak {ihsg.regime.since}.
                    Selama ini bertahan, mesin strategi memilih <b>tidak ambil posisi sama sekali</b> (exposure 0)
                    — sinyal BUY di bawah tetap dihitung dan ditampilkan, tapi portfolio simulasinya diam.
                  </div>
                )}
              </div>
            )}

            {showIhsgFactors && ihsgFactors && (
              <div style={{
                display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10,
                background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 10,
                padding: 14, marginBottom: 14,
              }}>
                {[
                  { key: "breadth", label: "Market Breadth", icon: "👥", hint: `${ihsgFactors.breadthPct}% saham naik hari ini` },
                  { key: "rsi", label: "RSI", icon: "📉", hint: `raw RSI(14): ${ihsgFactors.indicators?.rsi ?? "–"}` },
                  { key: "macd", label: "MACD", icon: "〰️", hint: "histogram crossover EMA12/26/9" },
                  { key: "bollinger", label: "Bollinger %B", icon: "🎯", hint: `%B: ${ihsgFactors.indicators?.bb?.pctB ?? "–"}` },
                  { key: "emaTrend", label: "EMA Trend", icon: "📐", hint: `EMA9 ${ihsgFactors.indicators?.ema9 ?? "–"} vs EMA21 ${ihsgFactors.indicators?.ema21 ?? "–"}` },
                  { key: "supportResistance", label: "Support/Resist.", icon: "🧱", hint: "jarak ke level S/R 20 hari" },
                  { key: "atr", label: "ATR (Volatility)", icon: "⚡", hint: `ATR(14): ${ihsgFactors.indicators?.atr ?? "–"}` },
                ].map(f => {
                  const v = ihsgFactors.factors?.[f.key];
                  const color = v >= 65 ? "#3fb950" : v >= 50 ? "#e3b341" : v >= 35 ? "#f0883e" : "#f85149";
                  return (
                    <div key={f.key} title={f.hint} style={{ padding: "8px 10px", background: "var(--bg-tertiary)", borderRadius: 8, border: "1px solid var(--border)" }}>
                      <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>{f.icon} {f.label}</div>
                      <div style={{ fontSize: 16, fontWeight: 900, color }}>{v ?? "–"}</div>
                    </div>
                  );
                })}
                <div style={{ gridColumn: "1 / -1", fontSize: 9, color: "var(--text-muted)", marginTop: 2 }}>
                  Skor komposit = rata-rata 7 faktor di atas. Beda dari 14-faktor AWO per-saham — IHSG gak punya data broker/konsentrasi (itu spesifik per-saham), jadi Market Breadth dipakai sebagai gantinya buat "smart money" level index.
                </div>

                {ihsgHistory.length > 0 && (
                  <div style={{ gridColumn: "1 / -1", marginTop: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "var(--text-primary)" }}>
                        Histori Skor IHSG — {ihsgFilteredHistory.length} dari {ihsgHistory.length} hari total ({ihsgHistory[0]?.date} s.d. {ihsgHistory[ihsgHistory.length-1]?.date})
                      </div>
                      <div style={{ display: "flex", gap: 4 }}>
                        {IHSG_RANGES.map(r => (
                          <button key={r.key} onClick={() => setIhsgRange(r.key)} style={{
                            padding: "3px 10px", borderRadius: 5, cursor: "pointer", fontSize: 10, fontWeight: 700,
                            border: `1px solid ${ihsgRange === r.key ? "#58a6ff" : "var(--border)"}`,
                            background: ihsgRange === r.key ? "rgba(88,166,255,0.12)" : "transparent",
                            color: ihsgRange === r.key ? "#58a6ff" : "var(--text-muted)",
                          }}>{r.label}</button>
                        ))}
                      </div>
                    </div>
                    {ihsgRange === "1D" ? (
                      <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "14px 10px", background: "var(--bg-tertiary)" }}>
                        {ihsgIntradayLoading ? (
                          <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)", fontSize: 11 }}>Loading intraday...</div>
                        ) : ihsgIntraday.length === 0 ? (
                          <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)", fontSize: 11 }}>
                            Gak ada data intraday — kemungkinan lagi di luar jam bursa atau data belum tersedia.
                          </div>
                        ) : (
                          <>
                            <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 6 }}>
                              Live intraday (5-menitan) · {ihsgIntraday[0]?.time} – {ihsgIntraday[ihsgIntraday.length - 1]?.time} WIB · live, gak disimpan ke histori
                            </div>
                            <ResponsiveContainer width="100%" height={220}>
                              <LineChart data={ihsgIntraday}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                                <XAxis dataKey="time" tick={{ fontSize: 9, fill: "#6e7681" }} minTickGap={30} />
                                <YAxis tick={{ fontSize: 9, fill: "#6e7681" }} domain={["auto", "auto"]} width={60} />
                                <Tooltip contentStyle={{ background: "#161b22", border: "1px solid #30363d", fontSize: 11 }} />
                                <Line type="monotone" dataKey="close" stroke="#58a6ff" strokeWidth={2} dot={false} />
                              </LineChart>
                            </ResponsiveContainer>
                          </>
                        )}
                      </div>
                    ) : (
                    <div style={{ maxHeight: 320, overflowY: "auto", overflowX: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
                      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 900 }}>
                        <thead>
                          <tr style={{ borderBottom: "1px solid var(--border)", position: "sticky", top: 0, background: "var(--bg-tertiary)" }}>
                            {["TANGGAL", "OPEN", "CLOSE", "%CHG", "SKOR", "TREND", "BREADTH", "RSI", "MACD", "BOLL.", "EMA", "S/R", "ATR"].map(h => {
                              const active = ihsgSortCol === h;
                              return (
                                <th key={h}
                                  onClick={() => { if (active) setIhsgSortAsc(!ihsgSortAsc); else { setIhsgSortCol(h); setIhsgSortAsc(false); } }}
                                  style={{
                                    padding: "6px 8px", textAlign: "left", fontSize: 9, fontWeight: 800,
                                    color: active ? "#58a6ff" : "var(--text-muted)", whiteSpace: "nowrap",
                                    cursor: "pointer", userSelect: "none",
                                  }}>
                                  {h}{active ? (ihsgSortAsc ? " ↑" : " ↓") : ""}
                                </th>
                              );
                            })}
                          </tr>
                        </thead>
                        <tbody>
                          {ihsgFilteredHistory.map((h, i) => (
                            <tr key={h.date} style={{ borderBottom: "1px solid rgba(48,54,61,0.4)", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)" }}>
                              <td style={{ padding: "5px 8px", fontSize: 11, fontWeight: 700, color: "var(--text-primary)", whiteSpace: "nowrap" }}>{h.date}</td>
                              <td style={{ padding: "5px 8px", fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                                {h.openPrice !== null ? h.openPrice.toLocaleString("id-ID") : "–"}
                              </td>
                              <td style={{ padding: "5px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap",
                                color: h.changePct !== null ? (h.changePct >= 0 ? "#3fb950" : "#f85149") : "var(--text-primary)" }}>
                                {h.closePrice !== null ? h.closePrice.toLocaleString("id-ID") : "–"}
                              </td>
                              <td style={{ padding: "5px 8px", fontSize: 11, fontWeight: 800, whiteSpace: "nowrap",
                                color: h.changePct !== null ? (h.changePct >= 0 ? "#3fb950" : "#f85149") : "var(--text-muted)" }}>
                                {h.changePct !== null ? `${h.changePct >= 0 ? "+" : ""}${h.changePct.toFixed(2)}%` : "–"}
                              </td>
                              <td style={{ padding: "5px 8px", fontSize: 11, fontWeight: 800, color: "var(--text-primary)" }}>{h.composite}</td>
                              <td style={{ padding: "5px 8px", fontSize: 9, fontWeight: 800,
                                color: h.trend === "BULLISH" ? "#3fb950" : h.trend === "BEARISH" ? "#f85149" : "#e3b341" }}>{h.trend}</td>
                              <td style={{ padding: "5px 8px", fontSize: 11 }}>{h.breadth}</td>
                              <td style={{ padding: "5px 8px", fontSize: 11 }}>{h.rsi}</td>
                              <td style={{ padding: "5px 8px", fontSize: 11 }}>{h.macd}</td>
                              <td style={{ padding: "5px 8px", fontSize: 11 }}>{h.bollinger}</td>
                              <td style={{ padding: "5px 8px", fontSize: 11 }}>{h.emaTrend}</td>
                              <td style={{ padding: "5px 8px", fontSize: 11 }}>{h.supportResistance}</td>
                              <td style={{ padding: "5px 8px", fontSize: 11 }}>{h.atr}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    )}
                  </div>
                )}

                {ihsgPatterns.length > 0 ? (
                  <div style={{ gridColumn: "1 / -1", marginTop: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: "var(--text-primary)", marginBottom: 8 }}>
                      🔮 Harmonic Pattern IHSG — {ihsgPatterns.length} pattern terdeteksi
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 10 }}>
                      {ihsgPatterns.map((p, i) => (
                        <div key={i} style={{
                          background: "var(--bg-secondary)",
                          border: `1px solid ${p.direction === "BULLISH" ? "rgba(63,185,80,0.35)" : "rgba(248,81,73,0.35)"}`,
                          borderRadius: 10, padding: 12,
                        }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                            <span style={{ fontSize: 12, fontWeight: 800, color: "var(--text-primary)" }}>
                              {p.pattern_type} <span style={{ color: p.direction === "BULLISH" ? "#3fb950" : "#f85149" }}>{p.direction === "BULLISH" ? "▲" : "▼"}</span>
                            </span>
                            <span style={{
                              fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 5,
                              background: p.signal?.includes("BUY") ? "rgba(63,185,80,0.12)" : p.signal?.includes("SELL") ? "rgba(248,81,73,0.12)" : "rgba(227,179,65,0.12)",
                              color: p.signal?.includes("BUY") ? "#3fb950" : p.signal?.includes("SELL") ? "#f85149" : "#e3b341",
                            }}>{p.signal}</span>
                          </div>
                          <div style={{ display: "flex", justifyContent: "center", gap: 10, margin: "6px 0" }}>
                            <XABCDMiniChart data={p.pattern_data} direction={p.direction} />
                            <BollingerSparkline data={p.bb_data} direction={p.direction} />
                          </div>
                          <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>
                            Conviction: <b style={{ color: "var(--text-primary)" }}>{p.conviction_score}</b> · Fib: {p.fib_score} · R:R {p.risk_reward}
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, fontSize: 10 }}>
                            <div><span style={{ color: "var(--text-muted)" }}>Entry</span><br /><b>{p.entry_min?.toLocaleString("id-ID")}–{p.entry_max?.toLocaleString("id-ID")}</b></div>
                            <div><span style={{ color: "var(--text-muted)" }}>SL</span><br /><b style={{ color: "#f85149" }}>{p.stop_loss?.toLocaleString("id-ID")}</b></div>
                            <div><span style={{ color: "var(--text-muted)" }}>TP1/TP2</span><br /><b style={{ color: "#3fb950" }}>{p.target_1?.toLocaleString("id-ID")} / {p.target_2?.toLocaleString("id-ID")}</b></div>
                          </div>
                          <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 6 }}>
                            Wyckoff: {p.wyckoff_phase} · D-point {p.pattern_data?.D?.date}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 8 }}>
                      Sama seperti scanner Harmonic Pattern per-saham (engine sama), tapi khusus IHSG pakai OHLC index sendiri. Gak ada faktor Broker Flow (gak relevan buat index) — bobotnya dipindah ke Harmonic/Wyckoff/SMC/Volume Profile.
                    </div>
                  </div>
                ) : (
                  <div style={{ gridColumn: "1 / -1", marginTop: 14, fontSize: 10, color: "var(--text-muted)" }}>
                    🔮 Harmonic Pattern IHSG — belum ada pattern XABCD yang valid terdeteksi saat ini.
                  </div>
                )}
              </div>
            )}

            {/* Stats Cards */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 20 }}>
              {[
                { label: "TOTAL SCANNED", value: rows.length, color: "#58a6ff", icon: "📊" },
                { label: "STRONG BUY",    value: counts.strong_buy, color: "#3fb950", icon: "▲▲" },
                { label: "BUY SIGNAL",    value: counts.buy, color: "#56d364", icon: "▲" },
                { label: "SELL SIGNAL",   value: counts.sell + counts.strong_sell, color: "#f85149", icon: "▼" },
                { label: "MARKET BREADTH", value: `${market?.breadthPct ?? sentiment}%`, color: (market?.breadthPct ?? sentiment) >= 60 ? "#3fb950" : (market?.breadthPct ?? sentiment) <= 40 ? "#f85149" : "#e3b341", icon: "📈" },
              ].map(s => (
                <div key={s.label} style={{
                  background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border)",
                  padding: "14px 16px",
                }}>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 700, letterSpacing: "0.08em", marginBottom: 6 }}>{s.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 900, color: s.color }}>{s.value}</div>
                </div>
              ))}
            </div>

            {/* Market Context Bar */}
            {market && (
              <div style={{
                background: "var(--bg-secondary)", border: "1px solid var(--border)",
                borderRadius: 12, padding: "14px 20px", marginBottom: 20,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 8 }}>
                  <span style={{ fontSize: 11, color: "#f85149", fontWeight: 700, minWidth: 80 }}>BEARISH {market.bearish}</span>
                  <div style={{ flex: 1, height: 8, background: "#21262d", borderRadius: 4, overflow: "hidden", position: "relative" }}>
                    <div style={{ position: "absolute", left: 0, top: 0, width: `${market.total > 0 ? (market.bearish / market.total) * 100 : 0}%`, height: "100%", background: "linear-gradient(90deg, #da3633, #f85149)", transition: "width 0.6s" }} />
                    <div style={{ position: "absolute", right: 0, top: 0, width: `${market.total > 0 ? (market.bullish / market.total) * 100 : 0}%`, height: "100%", background: "linear-gradient(90deg, #56d364, #3fb950)", transition: "width 0.6s" }} />
                  </div>
                  <span style={{ fontSize: 11, color: "#3fb950", fontWeight: 700, minWidth: 80, textAlign: "right" }}>BULLISH {market.bullish}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#484f58" }}>
                  <span>Avg Market Change: <strong style={{ color: market.avgChange >= 0 ? "#3fb950" : "#f85149" }}>{market.avgChange > 0 ? "+" : ""}{market.avgChange}%</strong></span>
                  <span>Neutral: {market.neutral} · Total: {market.total} stocks</span>
                </div>
              </div>
            )}

            {/* Filter tabs + sort */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {[
                  { key: "ALL",        label: "ALL" },
                  { key: "STRONG BUY", label: "STRONG BUY" },
                  { key: "BUY",        label: "BUY" },
                  { key: "WATCH",      label: "WATCH" },
                  { key: "SELL",       label: "SELL" },
                  { key: "STRONG SELL",label: "STRONG SELL" },
                  { key: "SHORT",      label: "🔻 SHORT" },
                ].map(tab => {
                  const shortColor = { color: "#c084fc", bg: "rgba(192,132,252,0.1)", border: "rgba(192,132,252,0.3)" };
                  const cfg = tab.key === "SHORT" ? shortColor : (SIG[tab.key] || { color: "#58a6ff", bg: "rgba(88,166,255,0.1)", border: "rgba(88,166,255,0.3)" });
                  const active = filter === tab.key;
                  const cnt = tab.key === "ALL" ? counts.all
                    : tab.key === "SHORT" ? rows.filter(r => r.signal === "SELL" || r.signal === "STRONG SELL").length
                    : rows.filter(r => r.signal === tab.key).length;
                  return (
                    <button key={tab.key} onClick={() => setFilter(tab.key)}
                      title={tab.key === "SHORT" ? "Sinyal bearish (SELL + STRONG SELL) yang punya trade plan short. Belum ngecek eligibilitas short-selling resmi IDX (Daftar Efek Short Selling) — cek dulu ke broker kamu apakah sahamnya bisa di-short." : undefined}
                      style={{
                        padding: "6px 14px", borderRadius: 20, border: `1.5px solid ${active ? cfg.color : "var(--border)"}`,
                        background: active ? cfg.bg : "transparent",
                        color: active ? cfg.color : "var(--text-muted)",
                        cursor: "pointer", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", gap: 6,
                      }}>
                      {tab.label}
                      <span style={{
                        fontSize: 10, padding: "1px 6px", borderRadius: 10,
                        background: active ? cfg.color : "var(--bg-tertiary)",
                        color: active ? "#0d1117" : "var(--text-muted)",
                      }}>{cnt}</span>
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Klik header kolom buat sort ↓</span>
                <ExportButton onClick={() => downloadCSV(
                  `signal-scanner-${date || new Date().toISOString().slice(0,10)}.csv`,
                  ["Ticker","Price","Change%","Signal","Score","Confidence","WeeklyTrend","TrendAligned","ForeignDivergence","ConvictionTier","TierReason","TopBuyer","TopSeller","VolumeZScore","Momentum5D",
                   "F1_SmartMoney","F2_TrendConsistency","F3_VolumeZ","F4_PriceMomentum","F5_RelStrength","F6_BuyerBreadth","F7_PriceBroker","F8_AccumStreak","F9_RSI","F10_MACD","F11_BollingerB","F12_EMATrend","F13_SupportResistance","F14_ATR"],
                  filtered.map((r: any) => [
                    r.ticker, r.price, r.dailyChange, r.signal, r.score, r.confidence,
                    r.weeklyTrend ?? "", r.trendAligned === null ? "" : (r.trendAligned ? "ALIGNED" : "COUNTER"),
                    r.foreignDivergence?.label ?? "", r.convictionTier ?? "", r.tierReason ?? "",
                    r.topBuyer ?? "", r.topSeller ?? "", r.volumeZScore, r.momentum5d,
                    r.factors?.concentration, r.factors?.trend, r.factors?.volumeZ, r.factors?.momentum,
                    r.factors?.relStrength, r.factors?.breadth, r.factors?.alignment, r.factors?.streak,
                    r.factors?.rsi, r.factors?.macd, r.factors?.bollinger, r.factors?.emaTrend,
                    r.factors?.supportResistance, r.factors?.atr,
                  ])
                )} />
                <div style={{ position: "relative" }}>
                  <button onClick={() => setShowSlTpPanel(p => !p)} style={{
                    display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 7,
                    background: slTpSettings.enabled ? "rgba(240,136,62,0.1)" : "rgba(255,255,255,0.06)",
                    border: `1px solid ${slTpSettings.enabled ? "rgba(240,136,62,0.4)" : "var(--border)"}`,
                    color: slTpSettings.enabled ? "#f0883e" : "var(--text-muted)", fontSize: 12, fontWeight: 800, cursor: "pointer",
                  }}>
                    ⚙️ SL/TP {slTpSettings.enabled ? `${slTpSettings.slPct}%/${slTpSettings.tp1Pct}%` : "Auto"}
                  </button>
                  {showSlTpPanel && (
                    <div style={{
                      position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 20, width: 280,
                      background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 10,
                      padding: 16, boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                    }}>
                      <div style={{ fontSize: 12, fontWeight: 800, color: "var(--text-primary)", marginBottom: 4 }}>SL/TP Custom</div>
                      <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.4 }}>
                        Kalau aktif, ini dipakai buat SEMUA journal save (AWO, WATCH, Short) — gantiin trade plan otomatis dari sistem (ATR/support-resistance).
                      </div>

                      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, cursor: "pointer" }}>
                        <input type="checkbox" checked={slTpSettings.enabled}
                          onChange={e => saveSlTpSettings({ ...slTpSettings, enabled: e.target.checked })} />
                        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>Pakai SL/TP custom</span>
                      </label>

                      {(["slPct", "tp1Pct", "tp2Pct"] as const).map(field => (
                        <div key={field} style={{ marginBottom: 10 }}>
                          <label style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 700, display: "block", marginBottom: 3 }}>
                            {field === "slPct" ? "Stop Loss (%)" : field === "tp1Pct" ? "Target 1 (%)" : "Target 2 (%)"}
                          </label>
                          <input type="number" step="0.1" min="0.1" value={slTpSettings[field]}
                            onChange={e => saveSlTpSettings({ ...slTpSettings, [field]: parseFloat(e.target.value) || 0 })}
                            style={{
                              width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)",
                              background: "var(--bg-tertiary)", color: "var(--text-primary)", fontSize: 13, fontWeight: 700,
                            }} />
                        </div>
                      ))}

                      <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
                        Contoh BUY di Rp1.000: SL Rp{Math.round(1000 - 1000 * slTpSettings.slPct / 100)},
                        T1 Rp{Math.round(1000 + 1000 * slTpSettings.tp1Pct / 100)},
                        T2 Rp{Math.round(1000 + 1000 * slTpSettings.tp2Pct / 100)}
                      </div>

                      <button onClick={() => setShowSlTpPanel(false)} style={{
                        marginTop: 12, width: "100%", padding: "7px 0", borderRadius: 6, border: "none",
                        background: "#58a6ff", color: "#0d1117", fontSize: 12, fontWeight: 800, cursor: "pointer",
                      }}>Tutup</button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Table */}
            <div style={{ background: "var(--bg-secondary)", borderRadius: 14, border: "1px solid var(--border)", overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <div style={{
                  display: "grid", gridTemplateColumns: SIGNAL_COLS,
                  padding: "11px 20px", borderBottom: "1px solid var(--border)",
                  fontSize: 10, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.08em",
                  minWidth: 1100,
                }}>
                  <span>#</span>
                  {["TICKER","PRICE","CHG%","","SIGNAL","TREND","SCORE","CONF.","TOP BUYER","TOP SELLER"].map(col => {
                    const sortable = col !== "" && col !== "TREND";
                    const active = sigSortCol === col;
                    return (
                      <span key={col || "short-col"}
                        onClick={sortable ? () => { if (active) setSigSortAsc(!sigSortAsc); else { setSigSortCol(col); setSigSortAsc(false); } } : undefined}
                        title={col.startsWith("TOP") ? "Warna kode broker: ungu = Asing, biru = Institusi Lokal, oranye = Ritel" : undefined}
                        style={{
                          cursor: sortable ? "pointer" : "default", userSelect: "none",
                          color: active ? "#58a6ff" : "var(--text-muted)",
                        }}>
                        {col.startsWith("TOP") ? `${col} 🎨` : col}
                        {sortable && active ? (sigSortAsc ? " ↑" : " ↓") : ""}
                      </span>
                    );
                  })}
                  <span>DETAILS</span>
                </div>

                {loading ? (
                  <div style={{ padding: "60px 20px", textAlign: "center", color: "var(--text-muted)" }}>
                    <div style={{ fontSize: 32, marginBottom: 12, animation: "spin 1.5s linear infinite", display: "inline-block" }}>⟳</div>
                    <div style={{ fontSize: 13 }}>Running quantitative analysis on all stocks...</div>
                  </div>
                ) : filtered.length === 0 ? (
                  <div style={{ padding: "60px 20px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                    No signals found for this filter.
                  </div>
                ) : (
                  filtered.map((row, i) => {
                    const cfg = SIG[row.signal] || SIG["NEUTRAL"];
                    const isExpanded = expandedRow === row.ticker;
                    return (
                      <div key={row.ticker}>
                        {/* Main row */}
                        <div style={{
                          display: "grid", gridTemplateColumns: SIGNAL_COLS,
                          padding: "12px 20px", borderBottom: "1px solid rgba(48,54,61,0.5)",
                          alignItems: "center", minWidth: 1100,
                          background: isExpanded ? "rgba(56,139,253,0.06)" : i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)",
                          transition: "background 0.15s",
                          cursor: "pointer",
                        }} className="scanner-row" onClick={() => setExpandedRow(isExpanded ? null : row.ticker)}>
                          <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>{i + 1}</span>

                          <Link href={`/broker-activity?ticker=${row.ticker}`} style={{ textDecoration: "none" }} onClick={e => e.stopPropagation()}>
                            <span style={{ fontSize: 15, fontWeight: 900, color: "#58a6ff", cursor: "pointer", letterSpacing: "0.02em" }}>{row.ticker}</span>
                          </Link>

                          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>
                            Rp {row.price > 0 ? row.price.toLocaleString("id-ID") : "–"}
                          </span>

                          <span style={{
                            fontSize: 13, fontWeight: 800,
                            color: row.dailyChange > 0 ? "#3fb950" : row.dailyChange < 0 ? "#f85149" : "var(--text-muted)",
                          }}>
                            {row.dailyChange === null || row.dailyChange === undefined ? "–" : `${row.dailyChange > 0 ? "+" : ""}${row.dailyChange.toFixed(2)}%`}
                          </span>

                          <button
                            onClick={e => { e.stopPropagation(); shortToJournal(row); }}
                            disabled={shortedTickers.has(row.ticker) || shortingTicker === row.ticker}
                            title="Short manual — buat trade plan bearish sendiri dari harga sekarang, terlepas dari sinyal sistem"
                            style={{
                              fontSize: 10, fontWeight: 800, padding: "4px 8px", borderRadius: 6,
                              border: "1px solid rgba(192,132,252,0.35)",
                              cursor: shortedTickers.has(row.ticker) ? "default" : "pointer",
                              background: shortedTickers.has(row.ticker) ? "rgba(63,185,80,0.12)" : "rgba(192,132,252,0.1)",
                              color: shortedTickers.has(row.ticker) ? "#3fb950" : "#c084fc",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {shortedTickers.has(row.ticker) ? "✓" : shortingTicker === row.ticker ? "..." : "🔻 Short"}
                          </button>

                          <span style={{
                            fontSize: 11, fontWeight: 800, padding: "4px 10px", borderRadius: 6,
                            background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}`,
                            letterSpacing: "0.05em", whiteSpace: "nowrap",
                          }}>
                            {cfg.icon} {cfg.label}
                          </span>

                          <MiniTrend days={row.days || []} />

                          <ScoreBar score={row.score} />

                          <ConfidenceBadge confidence={row.confidence} winRate={row.winRate} winRateSample={row.winRateSample} />

                          {/* TOP BUYER */}
                          <div>
                            {row.topBuyer ? <BrokerCodeBadge code={row.topBuyer} /> : <span style={{ fontSize: 13, color: "var(--text-muted)" }}>–</span>}
                            {row.netBuyers > 1 && <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 500, marginLeft: 4 }}>+{row.netBuyers - 1}</span>}
                          </div>

                          {/* TOP SELLER */}
                          <div>
                            {row.topSeller ? <BrokerCodeBadge code={row.topSeller} /> : <span style={{ fontSize: 13, color: "var(--text-muted)" }}>–</span>}
                            {row.netSellers > 1 && <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 500, marginLeft: 4 }}>+{row.netSellers - 1}</span>}
                          </div>

                          {/* Badges */}
                          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                            <ConvictionTierBadge tier={row.convictionTier} reason={row.tierReason} />
                            <VolumeAnomalyBadge zScore={row.volumeZScore} />
                            {row.momentum5d !== 0 && Math.abs(row.momentum5d) > 3 && (
                              <span style={{
                                fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 4,
                                background: row.momentum5d > 0 ? "rgba(63,185,80,0.1)" : "rgba(248,81,73,0.1)",
                                color: row.momentum5d > 0 ? "#3fb950" : "#f85149",
                                border: `1px solid ${row.momentum5d > 0 ? "rgba(63,185,80,0.3)" : "rgba(248,81,73,0.3)"}`,
                              }}>
                                {row.momentum5d > 0 ? "🚀" : "📉"} {row.momentum5d > 0 ? "+" : ""}{row.momentum5d.toFixed(1)}%
                              </span>
                            )}
                            {row.weeklyTrend && row.weeklyTrend !== "NEUTRAL" && (
                              <span title={`Tren Mingguan: ${row.weeklyTrend}`} style={{
                                fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 4,
                                background: row.weeklyTrend === "BULLISH" ? "rgba(63,185,80,0.08)" : "rgba(248,81,73,0.08)",
                                color: row.weeklyTrend === "BULLISH" ? "#3fb950" : "#f85149",
                                border: `1px solid ${row.weeklyTrend === "BULLISH" ? "rgba(63,185,80,0.25)" : "rgba(248,81,73,0.25)"}`,
                              }}>
                                {row.weeklyTrend === "BULLISH" ? "W▲" : "W▼"}
                              </span>
                            )}
                            {row.trendAligned === false && (
                              <span title="Sinyal ini berlawanan arah dengan tren Mingguan — pertimbangkan risiko tambahan" style={{
                                fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 4,
                                background: "rgba(240,136,62,0.12)", color: "#f0883e", border: "1px solid rgba(240,136,62,0.35)",
                              }}>
                                ⚠️ Counter-trend
                              </span>
                            )}
                            {row.foreignDivergence?.label === "FOREIGN_LEADING" && (
                              <span title={`Asing net ${(row.foreignDivergence.foreignRatio*100).toFixed(0)}% · Domestik net ${(row.foreignDivergence.domesticRatio*100).toFixed(0)}% — asing memimpin akumulasi, belum diikuti ritel`} style={{
                                fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 4,
                                background: "rgba(88,166,255,0.1)", color: "#58a6ff", border: "1px solid rgba(88,166,255,0.3)",
                              }}>
                                🌏 Foreign Leading
                              </span>
                            )}
                            {row.foreignDivergence?.label === "DOMESTIC_FOMO" && (
                              <span title={`Asing net ${(row.foreignDivergence.foreignRatio*100).toFixed(0)}% · Domestik net ${(row.foreignDivergence.domesticRatio*100).toFixed(0)}% — ritel dominan tanpa dukungan asing, waspada FOMO`} style={{
                                fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 4,
                                background: "rgba(240,136,62,0.1)", color: "#f0883e", border: "1px solid rgba(240,136,62,0.3)",
                              }}>
                                🏠 Domestic FOMO
                              </span>
                            )}
                            <span style={{ fontSize: 10, color: "#484f58", cursor: "pointer" }}>
                              {isExpanded ? "▲ hide" : "▼ detail"}
                            </span>
                          </div>
                        </div>

                        {/* Expanded factor breakdown */}
                        {isExpanded && (
                          <div style={{ minWidth: 1100 }}>
                            <FactorBreakdownPanel factors={row.factors} score={row.score} weights={engineWeights} engineVersion={engineVersion} />
                            {row.tradePlan && (
                              <div style={{
                                padding: "12px 24px 16px", background: "rgba(22,27,34,0.6)",
                                borderTop: "1px solid rgba(48,54,61,0.5)",
                                display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap",
                              }}>
                                <span style={{ fontSize: 10, color: "#8b949e", fontWeight: 700, letterSpacing: "0.03em" }}>TRADE PLAN</span>
                                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Entry <b style={{ color: "var(--text-primary)" }}>Rp {row.tradePlan.entry.toLocaleString("id-ID")}</b></span>
                                <span style={{ fontSize: 12, color: "#f85149" }}>SL <b>Rp {row.tradePlan.stopLoss.toLocaleString("id-ID")}</b></span>
                                <span style={{ fontSize: 12, color: "#3fb950" }}>T1 <b>Rp {row.tradePlan.target1.toLocaleString("id-ID")}</b></span>
                                <span style={{ fontSize: 12, color: "#3fb950" }}>T2 <b>Rp {row.tradePlan.target2.toLocaleString("id-ID")}</b></span>
                                {row.tradePlan.riskReward != null && (
                                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>R:R <b style={{ color: "var(--text-primary)" }}>1:{row.tradePlan.riskReward}</b></span>
                                )}
                                <button
                                  onClick={e => { e.stopPropagation(); saveAwoToJournal(row); }}
                                  disabled={savedAwoTickers.has(row.ticker) || savingAwoTicker === row.ticker}
                                  style={{
                                    marginLeft: "auto", fontSize: 11, fontWeight: 800, padding: "6px 14px", borderRadius: 6,
                                    border: "1px solid rgba(88,166,255,0.3)", cursor: savedAwoTickers.has(row.ticker) ? "default" : "pointer",
                                    background: savedAwoTickers.has(row.ticker) ? "rgba(63,185,80,0.12)" : "rgba(88,166,255,0.1)",
                                    color: savedAwoTickers.has(row.ticker) ? "#3fb950" : "#58a6ff",
                                  }}
                                >
                                  {savedAwoTickers.has(row.ticker) ? "✓ Saved" : savingAwoTicker === row.ticker ? "..." : "+ Journal"}
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Footer note */}
            <div style={{ marginTop: 16, fontSize: 11, color: "var(--text-muted)", textAlign: "center", lineHeight: 1.6 }}>
              <div>Quantitative Signal Engine v{engineVersion || "3.0-awo"} · Score 0–100 · 50 = Neutral</div>
              <div style={{ fontSize: 10, color: "#484f58", marginTop: 4 }}>
                {FACTOR_LABELS.length} Factors: {FACTOR_LABELS.map(f => {
                  const w = engineWeights?.[f.weightKey];
                  const pct = w != null ? `${Math.round(w * 1000) / 10}%` : "—";
                  return `${f.label} (${pct})`;
                }).join(" + ")}
              </div>
              <div style={{ fontSize: 10, color: "#484f58", marginTop: 2 }}>
                Confidence = Historical Win Rate × 0.7 + Score Strength × 0.3 · Click row to see factor breakdown
              </div>
            </div>
          </>
        )}

        {/* ══════════════════════════════════════════════════════════
            VIEW: SMART MONEY SCREENER
        ══════════════════════════════════════════════════════════ */}
        {view === "screener" && (
          <>
            {scLoading && (
              <div style={{ padding: "80px 20px", textAlign: "center", color: "var(--text-muted)" }}>
                <div style={{ fontSize: 40, marginBottom: 12, animation: "spin 1.2s linear infinite", display: "inline-block" }}>⟳</div>
                <div style={{ fontSize: 13 }}>Running 4-step screener...</div>
              </div>
            )}

            {!scLoading && scData && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 20 }}>
                  <FunnelStep label="TOTAL DI DB" count={scData.meta.total_in_db} total={scData.meta.total_in_db} color="#58a6ff" />
                  <FunnelStep label={`LIKUIDITAS ≥${scData.meta.min_liquidity_B}B`} count={scData.meta.passed_liq} total={scData.meta.total_in_db} color="#a78bfa" />
                  <FunnelStep label="D0 NET BELI" count={scData.meta.passed_step012} total={scData.meta.passed_liq} color="#f59e0b" />
                  <FunnelStep label="FOREIGN +" count={scData.meta.passed_step012} total={scData.meta.passed_liq} color="#3fb950" />
                  <FunnelStep label="6M AKUMULASI" count={scData.meta.passed_all} total={Math.max(scData.meta.passed_step012, 1)} color="#34d399" />
                </div>

                {scData.meta.passed_step012 === 0 && (
                  <div style={{ background: "rgba(248,81,73,0.08)", border: "1px solid rgba(248,81,73,0.2)", borderRadius: 12, padding: "16px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 14 }}>
                    <span style={{ fontSize: 28 }}>🛡️</span>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#fca5a5", marginBottom: 4 }}>Risk-Off Day — Tidak Ada Sinyal</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        Dari {scData.meta.passed_liq} saham liquid pada {scData.meta.d0}, tidak ada yang menunjukkan akumulasi dengan konfirmasi foreign positif.
                      </div>
                    </div>
                  </div>
                )}

                {scResults.length > 0 && (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700 }}>SORT:</span>
                    {(["foreign", "score", "turnover"] as const).map(s => (
                      <button key={s} onClick={() => setScSort(s)} style={{
                        padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700,
                        border: `1px solid ${scSort === s ? "#2f81f7" : "var(--border)"}`,
                        background: scSort === s ? "rgba(47,129,247,0.12)" : "transparent",
                        color: scSort === s ? "#58a6ff" : "var(--text-muted)", transition: "all 0.15s", textTransform: "capitalize",
                      }}>{s === "foreign" ? "Foreign Net" : s === "score" ? "Accum Score" : "Turnover"}</button>
                    ))}
                    <button onClick={() => setShowAllSc(!showAllSc)} style={{
                      marginLeft: "auto", padding: "5px 14px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700,
                      border: `1px solid ${showAllSc ? "#388bfd" : "var(--border)"}`,
                      background: showAllSc ? "rgba(56,139,253,0.12)" : "transparent",
                      color: showAllSc ? "#58a6ff" : "var(--text-muted)", transition: "all 0.15s",
                    }}>{showAllSc ? "Semua" : "Step 3 Passed Only"}</button>
                  </div>
                )}

                {scDisplayed.length > 0 ? (
                  <div style={{ background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border)", overflow: "hidden" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "100px 100px 100px 120px 130px 70px", gap: 0, padding: "10px 20px", borderBottom: "1px solid var(--border)" }}>
                      {["TICKER", "D0 NET", "3D NET", "FOREIGN 3D", "6M AKUMULASI", "SCORE"].map(h => (
                        <span key={h} style={{ fontSize: 10, fontWeight: 800, color: "var(--text-secondary)", letterSpacing: "0.1em" }}>{h}</span>
                      ))}
                    </div>
                    {scDisplayed.map((r: any, i: number) => (
                      <Link key={r.ticker} href={`/broker-activity?ticker=${r.ticker}`} style={{ textDecoration: "none" }}>
                        <div className="scanner-row" style={{
                          display: "grid", gridTemplateColumns: "100px 100px 100px 120px 130px 70px",
                          padding: "14px 20px", borderBottom: "1px solid rgba(48,54,61,0.6)",
                          alignItems: "center", opacity: !r.step3_pass ? 0.55 : 1,
                          borderLeft: r.step3_pass ? "3px solid #3fb950" : "3px solid rgba(248,81,73,0.4)",
                          background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.012)",
                        }}>
                          <div>
                            <div style={{ fontSize: 15, fontWeight: 900, color: "#58a6ff" }}>{r.ticker}</div>
                            <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>{r.turnover_d0_B.toFixed(1)}B vol</div>
                            <div style={{ display: "flex", gap: 3, marginTop: 4 }}>
                              {["S0","S1","S2"].map(s => <span key={s} style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: "rgba(63,185,80,0.15)", color: "#3fb950", fontWeight: 700 }}>{s}✓</span>)}
                              <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: r.step3_pass ? "rgba(63,185,80,0.15)" : "rgba(248,81,73,0.1)", color: r.step3_pass ? "#3fb950" : "#f85149", fontWeight: 700 }}>S3{r.step3_pass ? "✓" : "✗"}</span>
                            </div>
                          </div>
                          <span style={{ fontSize: 15, fontWeight: 800, color: r.net_d0_B >= 0 ? "#3fb950" : "#f85149" }}>{r.net_d0_B >= 0 ? "+" : ""}{r.net_d0_B.toFixed(1)}B</span>
                          <span style={{ fontSize: 15, fontWeight: 800, color: r.net_3d_B >= 0 ? "#3fb950" : "#f85149" }}>{r.net_3d_B >= 0 ? "+" : ""}{r.net_3d_B.toFixed(1)}B</span>
                          <span style={{ fontSize: 15, fontWeight: 800, color: r.foreign_3d_B >= 0 ? "#3fb950" : "#f85149" }}>{r.foreign_3d_B >= 0 ? "+" : ""}{r.foreign_3d_B.toFixed(1)}B</span>
                          <MiniAccumChart data={r.accum_6m} />
                          <div style={{ textAlign: "center" }}>
                            <div style={{ fontSize: 22, fontWeight: 900, color: r.accum_score >= 60 ? "#3fb950" : r.accum_score >= 40 ? "#f59e0b" : "#f85149" }}>{r.accum_score}</div>
                            <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 2 }}>/ 100</div>
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                ) : scData.results.length === 0 ? null : (
                  <div style={{ padding: "48px 20px", textAlign: "center", color: "var(--text-muted)", background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border)" }}>
                    <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", marginBottom: 8 }}>Tidak ada yang lolos Step 3</div>
                    <div style={{ fontSize: 13 }}>Aktifkan "Semua" untuk melihat kandidat partial yang lolos Step 1+2.</div>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {/* ══════════════════════════════════════════════════════════
            VIEW: HARMONIC PATTERN SCANNER
        ══════════════════════════════════════════════════════════ */}
        {view === "harmonic" && (
          <HarmonicTab apiBase={API_BASE} />
        )}

      </main>

      <style>{`
        .scanner-row:hover { background: rgba(56,139,253,0.05) !important; }
        .ticker-link:hover { border-bottom-color: #58a6ff !important; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </>
  );
}
