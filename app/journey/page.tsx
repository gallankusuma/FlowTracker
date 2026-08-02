'use client';

import { useEffect, useState, useMemo, useRef, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Strategy {
  id: number;
  name: string;
  signal_count?: number;
  win_count?: number;
  loss_count?: number;
  total_signals?: number;
  win_rate?: number;
  avg_pnl?: number;
  best_pnl?: number;
  worst_pnl?: number;
  description?: string;
}

interface Signal {
  id: number;
  ticker: string;
  signal_type?: string;
  action?: string;
  entry_price?: number;
  exit_price?: number;
  pnl?: number;
  pnl_percent?: number;
  duration_days?: number;
  created_at?: string;
  exit_date?: string;
  strategy_name?: string;
  status?: string;
}

interface HeroStats {
  totalPnL: number;
  winRate: number;
  totalTrades: number;
  bestTrade: number;
  worstTrade: number;
  streak: { count: number; type: 'W' | 'L' | null };
  portfolioValue: number;
  initialCapital: number;
}

interface EquityPoint {
  date: string;
  value: number;
  drawdown: number;
}

interface CalendarData {
  [dateKey: string]: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const API_BASE = 'http://localhost:3100';
const INITIAL_CAPITAL = 100_000_000; // 100 juta IDR

const formatRp = (val: number, compact = false): string => {
  const abs = Math.abs(val);
  const sign = val < 0 ? '-' : '';
  if (compact) {
    if (abs >= 1_000_000_000) return `${sign}Rp ${(abs / 1_000_000_000).toFixed(1)}B`;
    if (abs >= 1_000_000) return `${sign}Rp ${(abs / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${sign}Rp ${(abs / 1_000).toFixed(0)}K`;
    return `${sign}Rp ${abs.toFixed(0)}`;
  }
  return `${sign}Rp ${abs.toLocaleString('id-ID')}`;
};

const formatPct = (val: number | undefined | null): string => {
  if (val == null || isNaN(val)) return '0.00%';
  return `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;
};

const pnlColor = (val: number | undefined | null): string => {
  if (!val) return '#8b949e';
  return val >= 0 ? '#3fb950' : '#f85149';
};

// ─── Circular Gauge ────────────────────────────────────────────────────────────

function CircularGauge({ value, size = 90 }: { value: number; size?: number }) {
  const r = (size - 12) / 2;
  const circumference = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, value));
  const offset = circumference - (pct / 100) * circumference;
  const color = pct >= 60 ? '#3fb950' : pct >= 45 ? '#e3b341' : '#f85149';

  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#21262d" strokeWidth={8} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={8}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(0.4,0,0.2,1)', filter: `drop-shadow(0 0 6px ${color}80)` }}
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        style={{ transform: 'rotate(90deg)', transformOrigin: '50% 50%', fill: color, fontSize: '14px', fontWeight: 700, fontFamily: 'system-ui' }}
      >
        {pct.toFixed(0)}%
      </text>
    </svg>
  );
}

// ─── Equity Curve SVG ─────────────────────────────────────────────────────────

function EquityCurve({ points }: { points: EquityPoint[] }) {
  const W = 900;
  const H = 220;
  const PAD = { top: 20, right: 20, bottom: 30, left: 70 };

  if (!points.length) {
    return (
      <div style={{ height: H, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8b949e', fontSize: 14 }}>
        No equity data yet — make some trades!
      </div>
    );
  }

  const minV = Math.min(...points.map(p => p.value));
  const maxV = Math.max(...points.map(p => p.value));
  const range = maxV - minV || 1;

  const xScale = (i: number) => PAD.left + (i / (points.length - 1 || 1)) * (W - PAD.left - PAD.right);
  const yScale = (v: number) => PAD.top + (1 - (v - minV) / range) * (H - PAD.top - PAD.bottom);

  // Build path
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i).toFixed(1)} ${yScale(p.value).toFixed(1)}`).join(' ');

  // Area fill path (close to bottom)
  const areaPath = linePath + ` L ${xScale(points.length - 1).toFixed(1)} ${(H - PAD.bottom).toFixed(1)} L ${xScale(0).toFixed(1)} ${(H - PAD.bottom).toFixed(1)} Z`;

  // Drawdown areas
  const drawdownSegments: { x1: number; x2: number }[] = [];
  let segStart: number | null = null;
  points.forEach((p, i) => {
    if (p.drawdown < -2) {
      if (segStart === null) segStart = i;
    } else {
      if (segStart !== null) {
        drawdownSegments.push({ x1: xScale(segStart), x2: xScale(i) });
        segStart = null;
      }
    }
  });
  if (segStart !== null) drawdownSegments.push({ x1: xScale(segStart), x2: xScale(points.length - 1) });

  // Y-axis labels
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    val: minV + t * range,
    y: yScale(minV + t * range),
  }));

  // X-axis labels (every ~5 points or monthly)
  const step = Math.max(1, Math.floor(points.length / 6));
  const xTicks = points.filter((_, i) => i % step === 0 || i === points.length - 1);

  const baselineY = yScale(INITIAL_CAPITAL);
  const showBaseline = INITIAL_CAPITAL >= minV && INITIAL_CAPITAL <= maxV;

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxHeight: H + 10, display: 'block' }}>
        <defs>
          <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3fb950" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#3fb950" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f85149" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#f85149" stopOpacity="0.04" />
          </linearGradient>
        </defs>

        {/* Grid lines */}
        {yTicks.map((t, i) => (
          <line key={i} x1={PAD.left} y1={t.y} x2={W - PAD.right} y2={t.y} stroke="#21262d" strokeWidth={1} />
        ))}

        {/* Drawdown zones */}
        {drawdownSegments.map((seg, i) => (
          <rect
            key={i}
            x={seg.x1}
            y={PAD.top}
            width={seg.x2 - seg.x1}
            height={H - PAD.top - PAD.bottom}
            fill="url(#ddGrad)"
          />
        ))}

        {/* Baseline (initial capital) */}
        {showBaseline && (
          <line x1={PAD.left} y1={baselineY} x2={W - PAD.right} y2={baselineY}
            stroke="#e3b341" strokeWidth={1} strokeDasharray="5,4" opacity={0.6} />
        )}

        {/* Area fill */}
        <path d={areaPath} fill="url(#equityGrad)" />

        {/* Line */}
        <path d={linePath} fill="none" stroke="#3fb950" strokeWidth={2}
          style={{ filter: 'drop-shadow(0 0 4px #3fb95060)' }} />

        {/* Y-axis labels */}
        {yTicks.map((t, i) => (
          <text key={i} x={PAD.left - 6} y={t.y + 4} textAnchor="end"
            style={{ fill: '#8b949e', fontSize: 10, fontFamily: 'system-ui' }}>
            {formatRp(t.val, true)}
          </text>
        ))}

        {/* X-axis labels */}
        {xTicks.map((p, i) => {
          const idx = points.indexOf(p);
          return (
            <text key={i} x={xScale(idx)} y={H - 4} textAnchor="middle"
              style={{ fill: '#8b949e', fontSize: 10, fontFamily: 'system-ui' }}>
              {p.date.slice(5)}
            </text>
          );
        })}

        {/* Current value dot */}
        {points.length > 0 && (
          <circle
            cx={xScale(points.length - 1)}
            cy={yScale(points[points.length - 1].value)}
            r={4} fill="#3fb950"
            style={{ filter: 'drop-shadow(0 0 6px #3fb950)' }}
          />
        )}
      </svg>
    </div>
  );
}

// ─── Heatmap Calendar ─────────────────────────────────────────────────────────

function HeatmapCalendar({ data }: { data: CalendarData }) {
  const months = useMemo(() => {
    const keys = Object.keys(data).sort();
    if (!keys.length) return [];
    const start = new Date(keys[0]);
    const end = new Date(keys[keys.length - 1]);
    const result: { year: number; month: number; label: string; days: { date: string; val: number | null }[] }[] = [];

    const cur = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cur <= end) {
      const y = cur.getFullYear();
      const m = cur.getMonth();
      const label = cur.toLocaleString('default', { month: 'short', year: '2-digit' });
      const days: { date: string; val: number | null }[] = [];
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      for (let d = 1; d <= daysInMonth; d++) {
        const dateKey = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        days.push({ date: dateKey, val: data[dateKey] ?? null });
      }
      result.push({ year: y, month: m, label, days });
      cur.setMonth(cur.getMonth() + 1);
    }
    return result;
  }, [data]);

  const allVals = Object.values(data).filter(v => v !== 0);
  const maxAbs = allVals.length ? Math.max(...allVals.map(Math.abs)) : 1;

  const cellColor = (val: number | null): string => {
    if (val === null) return 'transparent';
    if (val === 0) return '#21262d';
    const intensity = Math.min(1, Math.abs(val) / maxAbs);
    if (val > 0) {
      const g = Math.round(185 * intensity + 40 * (1 - intensity));
      return `rgba(63, ${g}, 80, ${0.3 + 0.7 * intensity})`;
    } else {
      const r = Math.round(248 * intensity + 100 * (1 - intensity));
      return `rgba(${r}, 81, 73, ${0.3 + 0.7 * intensity})`;
    }
  };

  if (!months.length) {
    return (
      <div style={{ padding: '40px 0', textAlign: 'center', color: '#8b949e', fontSize: 14 }}>
        No trading data yet — your calendar will fill up as you trade!
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, marginTop: 8 }}>
      {months.map(mo => (
        <div key={`${mo.year}-${mo.month}`} style={{ minWidth: 140 }}>
          <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 6, fontWeight: 600 }}>{mo.label}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 16px)', gap: 2 }}>
            {/* Weekday labels */}
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
              <div key={i} style={{ fontSize: 9, color: '#8b949e', textAlign: 'center', height: 16, lineHeight: '16px' }}>{d}</div>
            ))}
            {/* Empty offset for first day */}
            {Array.from({ length: (new Date(mo.year, mo.month, 1).getDay() + 6) % 7 }).map((_, i) => (
              <div key={`e-${i}`} style={{ width: 16, height: 16 }} />
            ))}
            {mo.days.map(day => (
              <div
                key={day.date}
                title={day.val !== null ? `${day.date}: ${formatRp(day.val, true)}` : day.date}
                style={{
                  width: 16, height: 16, borderRadius: 3,
                  backgroundColor: cellColor(day.val),
                  border: `1px solid ${day.val !== null ? 'rgba(255,255,255,0.06)' : 'transparent'}`,
                  cursor: day.val !== null ? 'pointer' : 'default',
                  transition: 'transform 0.15s',
                }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Sortable Table ────────────────────────────────────────────────────────────

type SortKey = 'name' | 'total_signals' | 'win_rate' | 'avg_pnl' | 'best_pnl' | 'worst_pnl';

function StrategyTable({ strategies }: { strategies: Strategy[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('win_rate');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  const sorted = useMemo(() => {
    return [...strategies].sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      if (typeof va === 'string' && typeof vb === 'string') return va.localeCompare(vb) * sortDir;
      return ((Number(va) ?? 0) - (Number(vb) ?? 0)) * sortDir;
    });
  }, [strategies, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 1 ? -1 : 1);
    else { setSortKey(key); setSortDir(-1); }
  };

  const headerStyle: React.CSSProperties = {
    padding: '10px 14px', color: '#8b949e', fontSize: 11, fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.06em', cursor: 'pointer',
    userSelect: 'none', whiteSpace: 'nowrap',
    borderBottom: '1px solid #21262d',
  };

  const arrow = (key: SortKey) => sortKey === key ? (sortDir === -1 ? ' ↓' : ' ↑') : '';

  if (!strategies.length) {
    return (
      <div style={{ padding: '40px 0', textAlign: 'center', color: '#8b949e', fontSize: 14 }}>
        No strategies found. Create strategies to see performance here.
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
            {[
              { key: 'name' as SortKey, label: 'Strategy' },
              { key: 'total_signals' as SortKey, label: 'Trades' },
              { key: 'win_rate' as SortKey, label: 'Win Rate' },
              { key: 'avg_pnl' as SortKey, label: 'Avg P&L%' },
              { key: 'best_pnl' as SortKey, label: 'Best' },
              { key: 'worst_pnl' as SortKey, label: 'Worst' },
            ].map(col => (
              <th key={col.key} style={headerStyle} onClick={() => toggleSort(col.key)}>
                {col.label}{arrow(col.key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((s, i) => {
            const wr = s.win_rate ?? 0;
            const wrColor = wr >= 60 ? '#3fb950' : wr >= 45 ? '#e3b341' : '#f85149';
            return (
              <tr
                key={s.id}
                style={{
                  borderBottom: '1px solid #21262d',
                  background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)')}
              >
                <td style={{ padding: '11px 14px', color: '#e6edf3', fontWeight: 500 }}>{s.name}</td>
                <td style={{ padding: '11px 14px', color: '#8b949e', textAlign: 'center' }}>
                  {s.total_signals ?? s.signal_count ?? 0}
                </td>
                <td style={{ padding: '11px 14px', textAlign: 'center' }}>
                  <span style={{
                    padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 700,
                    background: `${wrColor}20`, color: wrColor, border: `1px solid ${wrColor}40`,
                  }}>
                    {wr.toFixed(0)}%
                  </span>
                </td>
                <td style={{ padding: '11px 14px', color: pnlColor(s.avg_pnl), textAlign: 'right', fontWeight: 600 }}>
                  {formatPct(s.avg_pnl)}
                </td>
                <td style={{ padding: '11px 14px', color: '#3fb950', textAlign: 'right' }}>
                  {formatPct(s.best_pnl)}
                </td>
                <td style={{ padding: '11px 14px', color: '#f85149', textAlign: 'right' }}>
                  {formatPct(s.worst_pnl)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Trade Journal ─────────────────────────────────────────────────────────────

function TradeJournal({ signals }: { signals: Signal[] }) {
  if (!signals.length) {
    return (
      <div style={{ padding: '40px 0', textAlign: 'center', color: '#8b949e', fontSize: 14 }}>
        No recent trades found. Signals will appear here once you start trading.
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
            {['Ticker', 'Strategy', 'Entry', 'Exit', 'P&L%', 'Duration', 'Result'].map(h => (
              <th key={h} style={{
                padding: '10px 14px', color: '#8b949e', fontSize: 11, fontWeight: 600,
                textTransform: 'uppercase', letterSpacing: '0.06em',
                borderBottom: '1px solid #21262d', whiteSpace: 'nowrap',
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {signals.slice(0, 10).map((s, i) => {
            const pnl = s.pnl_percent ?? s.pnl ?? 0;
            const isWin = pnl > 0;
            return (
              <tr
                key={s.id}
                style={{
                  borderBottom: '1px solid #21262d',
                  background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
                  transition: 'background 0.15s',
                  cursor: 'default',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)')}
              >
                <td style={{ padding: '11px 14px' }}>
                  <span style={{ fontWeight: 700, color: '#e6edf3', letterSpacing: '0.03em' }}>{s.ticker}</span>
                </td>
                <td style={{ padding: '11px 14px', color: '#8b949e', fontSize: 12 }}>
                  {s.strategy_name ?? '—'}
                </td>
                <td style={{ padding: '11px 14px', color: '#e6edf3', fontFamily: 'monospace' }}>
                  {s.entry_price ? `Rp ${s.entry_price.toLocaleString('id-ID')}` : '—'}
                </td>
                <td style={{ padding: '11px 14px', color: '#e6edf3', fontFamily: 'monospace' }}>
                  {s.exit_price ? `Rp ${s.exit_price.toLocaleString('id-ID')}` : '—'}
                </td>
                <td style={{ padding: '11px 14px', color: pnlColor(pnl), fontWeight: 700, textAlign: 'right', fontFamily: 'monospace' }}>
                  {formatPct(pnl)}
                </td>
                <td style={{ padding: '11px 14px', color: '#8b949e', textAlign: 'center' }}>
                  {s.duration_days != null ? `${s.duration_days}d` : '—'}
                </td>
                <td style={{ padding: '11px 14px', textAlign: 'center' }}>
                  <span style={{
                    padding: '3px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                    background: isWin ? 'rgba(63,185,80,0.15)' : 'rgba(248,81,73,0.15)',
                    color: isWin ? '#3fb950' : '#f85149',
                    border: `1px solid ${isWin ? '#3fb95040' : '#f8514940'}`,
                    letterSpacing: '0.06em',
                  }}>
                    {isWin ? 'WIN' : pnl === 0 ? 'EVEN' : 'LOSS'}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({
  label, value, sub, color, icon, children,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  icon?: string;
  children?: React.ReactNode;
}) {
  return (
    <div style={{
      background: 'rgba(22,27,34,0.8)',
      border: '1px solid #21262d',
      borderRadius: 12,
      padding: '18px 20px',
      backdropFilter: 'blur(12px)',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      flex: 1,
      minWidth: 140,
      position: 'relative',
      overflow: 'hidden',
      transition: 'border-color 0.2s, transform 0.2s',
    }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLDivElement).style.borderColor = color ?? '#3fb95040';
        (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLDivElement).style.borderColor = '#21262d';
        (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)';
      }}
    >
      {icon && (
        <div style={{ position: 'absolute', top: 14, right: 16, fontSize: 20, opacity: 0.25 }}>{icon}</div>
      )}
      <div style={{ color: '#8b949e', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
        {label}
      </div>
      <div style={{ color: color ?? '#e6edf3', fontSize: 22, fontWeight: 800, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      {sub && <div style={{ color: '#8b949e', fontSize: 12 }}>{sub}</div>}
      {children}
    </div>
  );
}

// ─── Section Card ─────────────────────────────────────────────────────────────

function SectionCard({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: '#161b22',
      border: '1px solid #21262d',
      borderRadius: 14,
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '16px 22px',
        borderBottom: '1px solid #21262d',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        background: 'rgba(255,255,255,0.02)',
      }}>
        <span style={{ fontSize: 16 }}>{icon}</span>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#e6edf3', letterSpacing: '0.01em' }}>{title}</h2>
      </div>
      <div style={{ padding: '20px 22px' }}>{children}</div>
    </div>
  );
}

// ─── Loading Skeleton ─────────────────────────────────────────────────────────

function Skeleton({ width = '100%', height = 16, borderRadius = 6 }: { width?: string | number; height?: number; borderRadius?: number }) {
  return (
    <div style={{
      width, height, borderRadius,
      background: 'linear-gradient(90deg, #21262d 25%, #2d333b 50%, #21262d 75%)',
      backgroundSize: '200% 100%',
      animation: 'shimmer 1.5s infinite',
    }} />
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function JourneyPage() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch data
  useEffect(() => {
    const fetchAll = async () => {
      setLoading(true);
      setError(null);
      try {
        const [stratRes, sigRes] = await Promise.allSettled([
          fetch(`${API_BASE}/api/strategies`).then(r => r.json()),
          fetch(`${API_BASE}/api/signals?limit=100`).then(r => r.json()),
        ]);

        if (stratRes.status === 'fulfilled') {
          const data = stratRes.value;
          setStrategies(Array.isArray(data) ? data : (data.strategies ?? data.data ?? []));
        }
        if (sigRes.status === 'fulfilled') {
          const data = sigRes.value;
          setSignals(Array.isArray(data) ? data : (data.signals ?? data.data ?? []));
        }
      } catch (e) {
        setError('Failed to load data. Please check your connection.');
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
  }, []);

  // Derive hero stats from signals
  const heroStats: HeroStats = useMemo(() => {
    const closed = signals.filter(s => s.pnl_percent != null || s.pnl != null);
    const wins = closed.filter(s => (s.pnl_percent ?? s.pnl ?? 0) > 0);
    const pnls = closed.map(s => s.pnl_percent ?? 0);
    const totalPnL = closed.reduce((acc, s) => acc + (s.pnl ?? 0), 0);
    const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;
    const best = pnls.length ? Math.max(...pnls) : 0;
    const worst = pnls.length ? Math.min(...pnls) : 0;

    // Calculate current streak
    let streak: HeroStats['streak'] = { count: 0, type: null };
    if (closed.length) {
      const sorted = [...closed].sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime());
      const type: 'W' | 'L' = (sorted[0].pnl_percent ?? 0) > 0 ? 'W' : 'L';
      let count = 0;
      for (const s of sorted) {
        const w = (s.pnl_percent ?? 0) > 0;
        if ((type === 'W' && w) || (type === 'L' && !w)) count++;
        else break;
      }
      streak = { count, type };
    }

    // Portfolio value estimate from cumulative PnL
    const cumulativePnLPct = pnls.reduce((acc, p) => acc * (1 + p / 100), 1);
    const portfolioValue = INITIAL_CAPITAL * cumulativePnLPct;

    return { totalPnL, winRate, totalTrades: closed.length, bestTrade: best, worstTrade: worst, streak, portfolioValue, initialCapital: INITIAL_CAPITAL };
  }, [signals]);

  // Build equity curve from signals
  const equityPoints: EquityPoint[] = useMemo(() => {
    const sorted = [...signals]
      .filter(s => s.created_at && s.pnl_percent != null)
      .sort((a, b) => new Date(a.created_at!).getTime() - new Date(b.created_at!).getTime());

    let value = INITIAL_CAPITAL;
    let peak = INITIAL_CAPITAL;
    return sorted.map(s => {
      value *= (1 + (s.pnl_percent ?? 0) / 100);
      if (value > peak) peak = value;
      const drawdown = ((value - peak) / peak) * 100;
      return {
        date: (s.created_at ?? '').slice(0, 10),
        value,
        drawdown,
      };
    });
  }, [signals]);

  // Build calendar data from signals
  const calendarData: CalendarData = useMemo(() => {
    const map: CalendarData = {};
    signals.forEach(s => {
      const date = (s.exit_date ?? s.created_at ?? '').slice(0, 10);
      if (!date) return;
      map[date] = (map[date] ?? 0) + (s.pnl ?? 0);
    });
    return map;
  }, [signals]);

  const portfolioDiff = heroStats.portfolioValue - heroStats.initialCapital;
  const portfolioDiffPct = (portfolioDiff / heroStats.initialCapital) * 100;
  const streakLabel = heroStats.streak.type
    ? `${heroStats.streak.count}${heroStats.streak.type}`
    : '—';
  const streakColor = heroStats.streak.type === 'W' ? '#3fb950' : heroStats.streak.type === 'L' ? '#f85149' : '#8b949e';

  return (
    <>
      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .journey-fade {
          animation: fadeInUp 0.5s ease both;
        }
      `}</style>

      <div style={{
        minHeight: '100vh',
        background: '#0d1117',
        padding: '28px 24px 60px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: '#e6edf3',
      }}>

        {/* ── Page Header ── */}
        <div className="journey-fade" style={{ marginBottom: 28, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{
              margin: 0, fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em',
              background: 'linear-gradient(135deg, #e6edf3 0%, #8b949e 100%)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
            }}>
              Journey Overview
            </h1>
            <p style={{ margin: '4px 0 0', color: '#8b949e', fontSize: 13 }}>
              Your complete trading performance dashboard
            </p>
          </div>
          <div style={{
            padding: '8px 16px', borderRadius: 8,
            background: 'rgba(227,179,65,0.1)', border: '1px solid rgba(227,179,65,0.25)',
            color: '#e3b341', fontSize: 12, fontWeight: 600,
          }}>
            📅 {new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}
          </div>
        </div>

        {error && (
          <div style={{
            background: 'rgba(248,81,73,0.1)', border: '1px solid rgba(248,81,73,0.3)',
            borderRadius: 10, padding: '12px 18px', color: '#f85149', fontSize: 13, marginBottom: 24,
          }}>
            ⚠️ {error}
          </div>
        )}

        {/* ── Hero Stats ── */}
        <div className="journey-fade" style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginBottom: 22, animationDelay: '0.05s' }}>
          {loading ? (
            Array.from({ length: 6 }).map((_, i) => (
              <div key={i} style={{ flex: 1, minWidth: 140, height: 90, background: '#161b22', borderRadius: 12, border: '1px solid #21262d' }}>
                <div style={{ padding: 18 }}><Skeleton height={12} width="60%" /><div style={{ marginTop: 10 }}><Skeleton height={22} width="80%" /></div></div>
              </div>
            ))
          ) : (
            <>
              <StatCard
                label="Total P&L"
                value={formatRp(heroStats.totalPnL, true)}
                sub={formatPct(portfolioDiffPct) + ' overall'}
                color={pnlColor(heroStats.totalPnL)}
                icon="💰"
              />
              <div style={{
                background: 'rgba(22,27,34,0.8)', border: '1px solid #21262d', borderRadius: 12,
                padding: '18px 20px', backdropFilter: 'blur(12px)', flex: 1, minWidth: 140,
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
              }}>
                <div style={{ color: '#8b949e', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', alignSelf: 'flex-start' }}>
                  Win Rate
                </div>
                <CircularGauge value={heroStats.winRate} size={72} />
              </div>
              <StatCard
                label="Total Trades"
                value={heroStats.totalTrades.toString()}
                sub={`${Math.round(heroStats.winRate * heroStats.totalTrades / 100)} wins`}
                icon="📊"
              />
              <StatCard
                label="Best / Worst"
                value={`${formatPct(heroStats.bestTrade)}`}
                sub={`Worst: ${formatPct(heroStats.worstTrade)}`}
                color="#3fb950"
                icon="🏆"
              />
              <StatCard
                label="Current Streak"
                value={streakLabel}
                sub={heroStats.streak.type === 'W' ? 'Winning streak 🔥' : heroStats.streak.type === 'L' ? 'Losing streak' : 'No data yet'}
                color={streakColor}
                icon="⚡"
              />
              <StatCard
                label="Portfolio Value"
                value={formatRp(heroStats.portfolioValue, true)}
                sub={`Initial: ${formatRp(INITIAL_CAPITAL, true)}`}
                color={pnlColor(portfolioDiff)}
                icon="🏦"
              />
            </>
          )}
        </div>

        {/* ── Equity Curve ── */}
        <div className="journey-fade" style={{ marginBottom: 22, animationDelay: '0.1s' }}>
          <SectionCard title="Equity Curve" icon="📈">
            {loading ? (
              <Skeleton height={220} />
            ) : (
              <>
                <div style={{ display: 'flex', gap: 20, marginBottom: 14, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#8b949e' }}>
                    <div style={{ width: 24, height: 2, background: '#3fb950', borderRadius: 1 }} />
                    Portfolio Value
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#8b949e' }}>
                    <div style={{ width: 24, height: 2, background: '#e3b341', borderRadius: 1, borderTop: '1px dashed #e3b341' }} />
                    Initial Capital
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#8b949e' }}>
                    <div style={{ width: 24, height: 10, background: 'rgba(248,81,73,0.18)', borderRadius: 2 }} />
                    Drawdown Zone
                  </div>
                </div>
                <EquityCurve points={equityPoints} />
              </>
            )}
          </SectionCard>
        </div>

        {/* ── Strategy Performance + Trade Journal ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 22, marginBottom: 22 }}>
          <div className="journey-fade" style={{ animationDelay: '0.15s' }}>
            <SectionCard title="Strategy Performance" icon="🎯">
              {loading ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} height={36} />)}
                </div>
              ) : (
                <StrategyTable strategies={strategies} />
              )}
            </SectionCard>
          </div>

          <div className="journey-fade" style={{ animationDelay: '0.2s' }}>
            <SectionCard title="Recent Trade Journal" icon="📋">
              {loading ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} height={36} />)}
                </div>
              ) : (
                <TradeJournal signals={signals} />
              )}
            </SectionCard>
          </div>
        </div>

        {/* ── Heatmap Calendar ── */}
        <div className="journey-fade" style={{ animationDelay: '0.25s' }}>
          <SectionCard title="Daily P&L Heatmap" icon="🗓️">
            {loading ? (
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} width={140} height={100} />)}
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 20, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: '#8b949e' }}>Less</span>
                  {[0.1, 0.3, 0.6, 0.85, 1.0].map((intensity, i) => (
                    <div key={i} style={{ width: 16, height: 16, borderRadius: 3, background: `rgba(63,185,80,${0.2 + 0.7 * intensity})` }} />
                  ))}
                  <span style={{ fontSize: 12, color: '#8b949e' }}>More Profit</span>
                  <span style={{ margin: '0 8px', color: '#21262d' }}>|</span>
                  {[1.0, 0.85, 0.6, 0.3, 0.1].map((intensity, i) => (
                    <div key={i} style={{ width: 16, height: 16, borderRadius: 3, background: `rgba(248,81,73,${0.2 + 0.7 * intensity})` }} />
                  ))}
                  <span style={{ fontSize: 12, color: '#8b949e' }}>More Loss</span>
                </div>
                <HeatmapCalendar data={calendarData} />
              </>
            )}
          </SectionCard>
        </div>

        {/* ── Footer ── */}
        <div style={{ marginTop: 40, textAlign: 'center', color: '#8b949e', fontSize: 12 }}>
          FlowTracker Journey · Data refreshes on page load · All values in IDR
        </div>
      </div>
    </>
  );
}
