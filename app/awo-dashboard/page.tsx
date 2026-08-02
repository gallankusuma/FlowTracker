"use client";
import Navbar from "@/components/Navbar";
import { API_BASE } from "@/lib/apiConfig";
import { useState, useEffect, useCallback } from "react";

type FactorAnalysisItem = {
  label: string; short: string;
  winRateHigh: number; winRateLow: number;
  sampleHigh: number; sampleLow: number;
  lift: number; median: number;
  informationCoeff: number;
  isPredictive: boolean; isMonotonic: boolean;
  quintiles: { quintile: number; label: string; count: number; winRate: number; avgScore: number; avgReturn: number | null }[];
};

type AWOStatus = {
  weights: Record<string, number>;
  thresholds: { strongBuy: number; buy: number; watch: number; neutral: number; sell: number };
  isOptimized: boolean;
  regime: { regime: string; confidence: number; date: string; details: Record<string, unknown> };
  defaultWeights: Record<string, number>;
  lastOptimization: { date: string; improvement: number; adopted: boolean; trainWR: number; validateWR: number } | null;
  factorStats: Record<string, unknown>;
};

type AnalysisData = {
  summary: { totalSignals: number; totalWins: number; totalLosses: number; totalNeutral: number; overallWinRate: number; dateRange: { from: string; to: string } };
  factorAnalysis: Record<string, FactorAnalysisItem>;
  factorRanking: { key: string; label: string; score: number; lift: number; ic: number; isPredictive: boolean }[];
  bySignalType: Record<string, { total: number; wins: number; losses: number; winRate: number }>;
  byRegime: Record<string, { total: number; wins: number; losses: number; winRate: number }>;
  recommendations: { type: string; priority: string; message: string; factors?: string[] }[];
  error?: string;
  message?: string;
};

type OptimizeResult = {
  status: string; adopted: boolean; elapsed_ms: number;
  totalSignals: number; trainSize: number; validateSize: number;
  baseline: { weights: Record<string, number>; trainWinRate: number; validateWinRate: number };
  optimized: { weights: Record<string, number>; trainWinRate: number; validateWinRate: number; improvement: number };
  weightChanges: { factor: string; old: number; new: number; change: number; direction: string }[];
  thresholds: Record<string, unknown>;
  error?: string;
  message?: string;
};

const FACTOR_LABELS: Record<string, { label: string; icon: string }> = {
  f1: { label: "Smart Money", icon: "🏦" },
  f2: { label: "Trend", icon: "📈" },
  f3: { label: "Volume Z", icon: "📊" },
  f4: { label: "Momentum", icon: "🚀" },
  f5: { label: "Rel. Strength", icon: "💪" },
  f6: { label: "Breadth", icon: "👥" },
  f7: { label: "Alignment", icon: "🔗" },
  f8: { label: "Streak", icon: "🔥" },
  f9: { label: "RSI Zone", icon: "📉" },
  f10: { label: "MACD Signal", icon: "🔀" },
  f11: { label: "Bollinger", icon: "📐" },
  f12: { label: "EMA Trend", icon: "📏" },
  f13: { label: "S/R Proximity", icon: "🎯" },
  f14: { label: "ATR Volatility", icon: "📊" },
};

const REGIME_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  TRENDING:  { bg: "rgba(63,185,80,0.12)", text: "#3fb950", border: "rgba(63,185,80,0.3)" },
  RANGING:   { bg: "rgba(227,179,65,0.12)", text: "#e3b341", border: "rgba(227,179,65,0.3)" },
  VOLATILE:  { bg: "rgba(248,81,73,0.12)", text: "#f85149", border: "rgba(248,81,73,0.3)" },
  DEFAULT:   { bg: "rgba(139,148,158,0.12)", text: "#8b949e", border: "rgba(139,148,158,0.3)" },
};

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: "var(--bg-secondary, #161b22)",
      border: "1px solid var(--border, #30363d)",
      borderRadius: 12, padding: 20, ...style,
    }}>{children}</div>
  );
}

function SectionTitle({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted, #8b949e)",
      letterSpacing: "0.1em", marginBottom: 16, display: "flex", alignItems: "center", gap: 6 }}>
      <span>{icon}</span> {children}
    </div>
  );
}

function StatBox({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div style={{ padding: "12px 16px", borderRadius: 8,
      background: "var(--bg-primary, #0d1117)", border: "1px solid var(--border, #30363d)" }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted, #8b949e)", letterSpacing: "0.08em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 900, color: color || "var(--text-primary, #f0f6fc)", fontFamily: "'Space Grotesk', sans-serif" }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--text-muted, #8b949e)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function FactorHeatmap({ analysis }: { analysis: AnalysisData }) {
  const factors = Object.entries(analysis.factorAnalysis);
  return (
    <Card>
      <SectionTitle icon="🗺️">FACTOR HEATMAP — Predictive Power</SectionTitle>
      <div style={{ display: "grid", gap: 8 }}>
        {factors.sort((a, b) => b[1].lift - a[1].lift).map(([key, f]) => {
          const short = f.short as keyof typeof FACTOR_LABELS;
          const info = FACTOR_LABELS[short] || { label: key, icon: "?" };
          const liftColor = f.lift > 10 ? "#3fb950" : f.lift > 5 ? "#e3b341" : f.lift > 0 ? "#8b949e" : "#f85149";
          const icColor = Math.abs(f.informationCoeff) > 0.15 ? "#3fb950" : Math.abs(f.informationCoeff) > 0.05 ? "#e3b341" : "#8b949e";
          return (
            <div key={key} style={{
              display: "grid", gridTemplateColumns: "160px 80px 80px 80px 60px 1fr",
              alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8,
              background: f.isPredictive ? "rgba(63,185,80,0.04)" : "transparent",
              border: `1px solid ${f.isPredictive ? "rgba(63,185,80,0.15)" : "var(--border, #30363d)"}`,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 14 }}>{info.icon}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary, #f0f6fc)" }}>{info.label}</span>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 10, color: "var(--text-muted, #8b949e)" }}>WR High</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#3fb950" }}>{f.winRateHigh}%</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 10, color: "var(--text-muted, #8b949e)" }}>WR Low</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#f85149" }}>{f.winRateLow}%</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 10, color: "var(--text-muted, #8b949e)" }}>Lift</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: liftColor }}>+{f.lift}%</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 10, color: "var(--text-muted, #8b949e)" }}>IC</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: icColor }}>{f.informationCoeff}</div>
              </div>
              {/* Mini bar showing lift magnitude */}
              <div style={{ height: 6, borderRadius: 3, background: "var(--border, #30363d)", overflow: "hidden" }}>
                <div style={{
                  height: "100%", borderRadius: 3,
                  width: `${Math.min(Math.abs(f.lift) * 3, 100)}%`,
                  background: f.lift > 0 ? `linear-gradient(90deg, ${liftColor}60, ${liftColor})` : `linear-gradient(90deg, ${liftColor}, ${liftColor}60)`,
                }} />
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: "var(--text-muted, #8b949e)", marginTop: 12 }}>
        Lift = WR difference when factor is HIGH vs LOW. IC = Information Coefficient (correlation with returns). Higher = more predictive.
      </div>
    </Card>
  );
}

function WeightComparison({ status }: { status: AWOStatus }) {
  const keys = Object.keys(status.defaultWeights);
  return (
    <Card>
      <SectionTitle icon="⚖️">WEIGHT COMPARISON — Default vs Active</SectionTitle>
      <div style={{ display: "grid", gap: 6 }}>
        {keys.map(k => {
          const short = k as keyof typeof FACTOR_LABELS;
          const info = FACTOR_LABELS[short] || { label: k, icon: "?" };
          const def = status.defaultWeights[k];
          const active = status.weights[k];
          const diff = active - def;
          const diffColor = diff > 0.02 ? "#3fb950" : diff < -0.02 ? "#f85149" : "#8b949e";
          return (
            <div key={k} style={{
              display: "grid", gridTemplateColumns: "140px 70px 70px 70px 1fr",
              alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 6,
              background: Math.abs(diff) > 0.02 ? `${diffColor}08` : "transparent",
            }}>
              <div style={{ fontSize: 12, color: "var(--text-secondary, #c9d1d9)" }}>{info.icon} {info.label}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted, #8b949e)", textAlign: "center" }}>{(def * 100).toFixed(0)}%</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary, #f0f6fc)", textAlign: "center" }}>{(active * 100).toFixed(0)}%</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: diffColor, textAlign: "center" }}>
                {diff > 0 ? "+" : ""}{(diff * 100).toFixed(1)}%
              </div>
              <div style={{ height: 4, borderRadius: 2, background: "var(--border, #30363d)", overflow: "hidden" }}>
                <div style={{
                  height: "100%", borderRadius: 2,
                  width: `${active * 100 * 3}%`,
                  background: `linear-gradient(90deg, #58a6ff60, #58a6ff)`,
                }} />
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 16, marginTop: 12, fontSize: 10, color: "var(--text-muted, #8b949e)" }}>
        <span>Gray = Default</span>
        <span style={{ fontWeight: 700, color: "var(--text-primary, #f0f6fc)" }}>Bold = Active</span>
        <span>Diff = Change from default</span>
      </div>
    </Card>
  );
}

export default function AWODashboard() {
  const [status, setStatus] = useState<AWOStatus | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [optimizeResult, setOptimizeResult] = useState<OptimizeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [optimizing, setOptimizing] = useState(false);
  const [error, setError] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, analysisRes] = await Promise.all([
        fetch(`${API_BASE}/api/awo/status`).then(r => r.json()),
        fetch(`${API_BASE}/api/awo/analyze`).then(r => r.json()),
      ]);
      setStatus(statusRes);
      setAnalysis(analysisRes);
    } catch (e) {
      setError("Failed to load AWO data");
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const runOptimize = async () => {
    setOptimizing(true);
    try {
      const res = await fetch(`${API_BASE}/api/awo/optimize/run`, { method: "POST" });
      const data = await res.json();
      setOptimizeResult(data);
      // Reload status after optimization
      const statusRes = await fetch(`${API_BASE}/api/awo/status`).then(r => r.json());
      setStatus(statusRes);
    } catch (e) {
      setError("Optimization failed");
    }
    setOptimizing(false);
  };

  const resetWeights = async () => {
    await fetch(`${API_BASE}/api/awo/reset`, { method: "POST" });
    await loadData();
    setOptimizeResult(null);
  };

  const regimeStyle = status?.regime
    ? REGIME_COLORS[status.regime.regime] || REGIME_COLORS.DEFAULT
    : REGIME_COLORS.DEFAULT;

  return (
    <>
      <Navbar />
      <main style={{ maxWidth: 1400, margin: "0 auto", padding: "32px 24px" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <div>
            <h1 style={{
              fontSize: 28, fontWeight: 900, color: "var(--text-primary, #f0f6fc)",
              fontFamily: "'Space Grotesk', sans-serif", margin: 0,
            }}>
              🧠 Adaptive Weight Optimizer
            </h1>
            <p style={{ fontSize: 13, color: "var(--text-muted, #8b949e)", margin: "4px 0 0" }}>
              Self-learning signal engine • Data-driven weight optimization • Market regime detection
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={runOptimize}
              disabled={optimizing}
              style={{
                padding: "10px 20px", borderRadius: 8, border: "none", cursor: optimizing ? "not-allowed" : "pointer",
                background: optimizing ? "#30363d" : "linear-gradient(135deg, #238636, #2ea043)",
                color: "#fff", fontWeight: 700, fontSize: 13,
                opacity: optimizing ? 0.6 : 1,
              }}
            >
              {optimizing ? "⏳ Optimizing..." : "🚀 Run Optimizer"}
            </button>
            <button
              onClick={resetWeights}
              style={{
                padding: "10px 16px", borderRadius: 8, border: "1px solid var(--border, #30363d)",
                background: "transparent", color: "var(--text-secondary, #c9d1d9)",
                cursor: "pointer", fontSize: 12, fontWeight: 500,
              }}
            >
              Reset to Default
            </button>
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted, #8b949e)" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
            Loading AWO data...
          </div>
        ) : error ? (
          <Card style={{ textAlign: "center", padding: 40 }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>⚠️</div>
            <div style={{ color: "#f85149" }}>{error}</div>
          </Card>
        ) : (
          <>
            {/* Top Stats Row */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 24 }}>
              <StatBox
                label="OVERALL WIN RATE"
                value={`${analysis?.summary?.overallWinRate ?? "—"}%`}
                sub={`${analysis?.summary?.totalWins ?? 0}W / ${analysis?.summary?.totalLosses ?? 0}L`}
                color={(analysis?.summary?.overallWinRate ?? 0) >= 55 ? "#3fb950" : "#e3b341"}
              />
              <StatBox
                label="TOTAL SIGNALS"
                value={analysis?.summary?.totalSignals ?? "—"}
                sub={analysis?.summary?.dateRange ? `${analysis.summary.dateRange.from} → ${analysis.summary.dateRange.to}` : ""}
              />
              <StatBox
                label="ENGINE VERSION"
                value={status?.isOptimized ? "v3 AWO" : "v3 Default"}
                sub={status?.isOptimized ? "Optimized weights active" : "Using default weights"}
                color={status?.isOptimized ? "#3fb950" : "#8b949e"}
              />
              <div style={{
                padding: "12px 16px", borderRadius: 8,
                background: regimeStyle.bg, border: `1px solid ${regimeStyle.border}`,
              }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted, #8b949e)", letterSpacing: "0.08em", marginBottom: 4 }}>MARKET REGIME</div>
                <div style={{ fontSize: 22, fontWeight: 900, color: regimeStyle.text, fontFamily: "'Space Grotesk', sans-serif" }}>
                  {status?.regime?.regime ?? "—"}
                </div>
                <div style={{ fontSize: 10, color: "var(--text-muted, #8b949e)", marginTop: 2 }}>
                  Confidence: {status?.regime?.confidence ?? 0}%
                </div>
              </div>
              <StatBox
                label="LAST OPTIMIZATION"
                value={
                  !status?.lastOptimization ? "Never"
                  : status.lastOptimization.adopted ? `+${status.lastOptimization.improvement}%`
                  : "Not adopted"
                }
                sub={
                  !status?.lastOptimization ? "Run optimizer to improve"
                  : status.lastOptimization.adopted ? new Date(status.lastOptimization.date).toLocaleDateString()
                  : `Best candidate (+${status.lastOptimization.improvement}%) failed safety checks — weights unchanged`
                }
                color={status?.lastOptimization?.adopted ? "#3fb950" : "#8b949e"}
              />
            </div>

            {/* Optimization Result Banner */}
            {optimizeResult && (
              <Card style={{
                marginBottom: 24,
                background: optimizeResult.adopted
                  ? "rgba(63,185,80,0.06)"
                  : "rgba(227,179,65,0.06)",
                border: `1px solid ${optimizeResult.adopted ? "rgba(63,185,80,0.3)" : "rgba(227,179,65,0.3)"}`,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                  <span style={{ fontSize: 24 }}>{optimizeResult.adopted ? "✅" : "📊"}</span>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: optimizeResult.adopted ? "#3fb950" : "#e3b341" }}>
                      {optimizeResult.adopted ? "New weights adopted!" : "No improvement found"}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted, #8b949e)" }}>
                      Tested {optimizeResult.totalSignals} signals • {optimizeResult.elapsed_ms}ms
                      • Train: {optimizeResult.trainSize} / Validate: {optimizeResult.validateSize}
                    </div>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted, #8b949e)", marginBottom: 6 }}>BASELINE</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: "#8b949e" }}>
                      {optimizeResult.baseline.validateWinRate}% WR
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted, #8b949e)", marginBottom: 6 }}>OPTIMIZED</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: "#3fb950" }}>
                      {optimizeResult.optimized.validateWinRate}% WR
                      <span style={{ fontSize: 13, marginLeft: 8, color: optimizeResult.optimized.improvement > 0 ? "#3fb950" : "#f85149" }}>
                        ({optimizeResult.optimized.improvement > 0 ? "+" : ""}{optimizeResult.optimized.improvement}%)
                      </span>
                    </div>
                  </div>
                </div>
                {/* Weight Changes */}
                {optimizeResult.weightChanges && optimizeResult.weightChanges.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted, #8b949e)", marginBottom: 8 }}>WEIGHT CHANGES</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {optimizeResult.weightChanges.map(wc => {
                        const short = wc.factor as keyof typeof FACTOR_LABELS;
                        const info = FACTOR_LABELS[short] || { label: wc.factor, icon: "?" };
                        const isUp = wc.change > 0;
                        return (
                          <span key={wc.factor} style={{
                            fontSize: 11, padding: "3px 8px", borderRadius: 6,
                            background: isUp ? "rgba(63,185,80,0.1)" : "rgba(248,81,73,0.1)",
                            color: isUp ? "#3fb950" : "#f85149",
                            border: `1px solid ${isUp ? "rgba(63,185,80,0.2)" : "rgba(248,81,73,0.2)"}`,
                          }}>
                            {info.icon} {info.label}: {isUp ? "+" : ""}{(wc.change * 100).toFixed(1)}%
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
              </Card>
            )}

            {/* Main Content Grid */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 24 }}>
              {/* Factor Heatmap */}
              {analysis && !analysis.error && <FactorHeatmap analysis={analysis} />}

              {/* Weight Comparison */}
              {status && <WeightComparison status={status} />}
            </div>

            {/* Recommendations */}
            {analysis?.recommendations && analysis.recommendations.length > 0 && (
              <Card style={{ marginBottom: 24 }}>
                <SectionTitle icon="💡">AI RECOMMENDATIONS</SectionTitle>
                <div style={{ display: "grid", gap: 10 }}>
                  {analysis.recommendations.map((rec, i) => (
                    <div key={i} style={{
                      padding: "12px 16px", borderRadius: 8,
                      background: rec.priority === "HIGH" ? "rgba(248,81,73,0.06)" : "rgba(227,179,65,0.06)",
                      border: `1px solid ${rec.priority === "HIGH" ? "rgba(248,81,73,0.2)" : "rgba(227,179,65,0.2)"}`,
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                        <span style={{
                          fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                          background: rec.type === "INCREASE_WEIGHT" ? "rgba(63,185,80,0.15)" : "rgba(248,81,73,0.15)",
                          color: rec.type === "INCREASE_WEIGHT" ? "#3fb950" : "#f85149",
                        }}>{rec.type.replace(/_/g, " ")}</span>
                        <span style={{
                          fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                          background: "rgba(139,148,158,0.15)", color: "#8b949e",
                        }}>{rec.priority}</span>
                      </div>
                      <div style={{ fontSize: 13, color: "var(--text-secondary, #c9d1d9)" }}>{rec.message}</div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Signal Type + Regime Breakdown */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 24 }}>
              {/* By Signal Type */}
              {analysis?.bySignalType && (
                <Card>
                  <SectionTitle icon="📊">WIN RATE BY SIGNAL TYPE</SectionTitle>
                  <div style={{ display: "grid", gap: 6 }}>
                    {Object.entries(analysis.bySignalType)
                      .sort((a, b) => b[1].winRate - a[1].winRate)
                      .map(([type, data]) => (
                        <div key={type} style={{
                          display: "grid", gridTemplateColumns: "130px 60px 60px 60px 1fr",
                          alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 6,
                        }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary, #f0f6fc)" }}>{type}</div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: data.winRate >= 55 ? "#3fb950" : data.winRate >= 45 ? "#e3b341" : "#f85149", textAlign: "center" }}>
                            {data.winRate}%
                          </div>
                          <div style={{ fontSize: 11, color: "#3fb950", textAlign: "center" }}>{data.wins}W</div>
                          <div style={{ fontSize: 11, color: "#f85149", textAlign: "center" }}>{data.losses}L</div>
                          <div style={{ height: 4, borderRadius: 2, background: "var(--border, #30363d)", overflow: "hidden" }}>
                            <div style={{
                              height: "100%", borderRadius: 2,
                              width: `${data.winRate}%`,
                              background: data.winRate >= 55 ? "#3fb950" : data.winRate >= 45 ? "#e3b341" : "#f85149",
                            }} />
                          </div>
                        </div>
                      ))}
                  </div>
                </Card>
              )}

              {/* By Regime */}
              {analysis?.byRegime && (
                <Card>
                  <SectionTitle icon="🌡️">WIN RATE BY MARKET REGIME</SectionTitle>
                  <div style={{ display: "grid", gap: 8 }}>
                    {Object.entries(analysis.byRegime).map(([regime, data]) => {
                      const rc = REGIME_COLORS[regime] || REGIME_COLORS.DEFAULT;
                      return (
                        <div key={regime} style={{
                          padding: "12px 16px", borderRadius: 8,
                          background: rc.bg, border: `1px solid ${rc.border}`,
                          display: "grid", gridTemplateColumns: "100px 1fr 80px", alignItems: "center", gap: 12,
                        }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: rc.text }}>{regime}</div>
                          <div style={{ fontSize: 12, color: "var(--text-muted, #8b949e)" }}>
                            {data.total} signals • {data.wins}W / {data.losses}L
                          </div>
                          <div style={{ fontSize: 18, fontWeight: 800, color: rc.text, textAlign: "right" }}>
                            {data.winRate}%
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              )}
            </div>

            {/* Active Thresholds */}
            {status?.thresholds && (
              <Card>
                <SectionTitle icon="🎚️">ACTIVE SIGNAL THRESHOLDS</SectionTitle>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {[
                    { label: "STRONG BUY", value: status.thresholds.strongBuy, color: "#3fb950" },
                    { label: "BUY", value: status.thresholds.buy, color: "#56d364" },
                    { label: "WATCH", value: status.thresholds.watch, color: "#e3b341" },
                    { label: "NEUTRAL", value: status.thresholds.neutral, color: "#8b949e" },
                    { label: "SELL", value: status.thresholds.sell, color: "#f85149" },
                  ].map(t => (
                    <div key={t.label} style={{
                      padding: "8px 16px", borderRadius: 8,
                      background: `${t.color}10`, border: `1px solid ${t.color}30`,
                      textAlign: "center", minWidth: 100,
                    }}>
                      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", color: t.color, marginBottom: 4 }}>{t.label}</div>
                      <div style={{ fontSize: 18, fontWeight: 800, color: t.color }}>≥ {t.value}</div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Insufficient Data Notice */}
            {analysis?.error && (
              <Card style={{ textAlign: "center", padding: 40, marginTop: 24 }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>📉</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#e3b341", marginBottom: 8 }}>
                  Insufficient Data
                </div>
                <div style={{ fontSize: 13, color: "var(--text-muted, #8b949e)", maxWidth: 500, margin: "0 auto" }}>
                  {(analysis as Record<string, unknown>).message as string || analysis.error}. The AWO system needs at least 20 signals with tracked outcomes to begin analysis. Run the signal scanner daily and trigger outcome updates to build your dataset.
                </div>
              </Card>
            )}
          </>
        )}
      </main>
    </>
  );
}
