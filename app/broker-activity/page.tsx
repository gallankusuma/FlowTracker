'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface BrokerEntry {
  code: string;
  buy: number;
  sell: number;
  net: number;
}

interface TickerData {
  ticker: string;
  brokerAction?: { broker: string; action: string; net: number }[];
  brokerCodes?: string[];
  brokerTracker?: { date: string; broker: string; net: number; cumNet: number }[];
  summary?: { totalBuy: number; totalSell: number; netFlow: number };
  loading: boolean;
  error?: string;
}

interface ComparisonState {
  tickers: string[];
  days: number;
  data: Record<string, TickerData>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const POPULAR_TICKERS = [
  'BBCA', 'BBRI', 'BMRI', 'TLKM', 'ASII', 'UNVR', 'GOTO', 'BYAN',
  'ANTM', 'PTBA', 'INDF', 'SMGR', 'EXCL', 'ICBP', 'KLBF', 'MIKA',
  'TOWR', 'BSDE', 'CTRA', 'PWON', 'ADRO', 'INCO', 'HRUM', 'ITMG',
];

const TIMEFRAMES = [
  { label: '1W', days: 5 },
  { label: '2W', days: 10 },
  { label: '1M', days: 22 },
  { label: '3M', days: 66 },
];

const TICKER_COLORS = ['#58a6ff', '#3fb950', '#e3b341', '#f85149'];
const TICKER_BG = ['rgba(88,166,255,0.12)', 'rgba(63,185,80,0.12)', 'rgba(227,179,65,0.12)', 'rgba(248,81,73,0.12)'];

// ─── Helper Utilities ────────────────────────────────────────────────────────

function formatBillion(val: number): string {
  const abs = Math.abs(val);
  if (abs >= 1e12) return `${(val / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(val / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(val / 1e6).toFixed(1)}M`;
  return val.toFixed(0);
}

function getNetDirection(net: number): 'ACCUM' | 'DISTRIB' | 'NEUTRAL' {
  if (net > 0) return 'ACCUM';
  if (net < 0) return 'DISTRIB';
  return 'NEUTRAL';
}

// ─── Top Broker Extractor ─────────────────────────────────────────────────────

function extractTopBrokers(data: TickerData, topN = 6): BrokerEntry[] {
  if (!data.brokerAction || data.brokerAction.length === 0) return [];

  const map: Record<string, BrokerEntry> = {};
  for (const item of data.brokerAction) {
    const key = item.broker;
    if (!map[key]) map[key] = { code: key, buy: 0, sell: 0, net: 0 };
    map[key].net += item.net;
    if (item.net > 0) map[key].buy += item.net;
    else map[key].sell += Math.abs(item.net);
  }

  return Object.values(map)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
    .slice(0, topN);
}

// ─── Normalize Chart Data ─────────────────────────────────────────────────────

interface ChartPoint {
  date: string;
  value: number;
}

function buildNormalizedSeries(data: TickerData): ChartPoint[] {
  if (!data.brokerTracker || data.brokerTracker.length === 0) return [];

  // Group by date, sum all brokers' cumNet
  const byDate: Record<string, number> = {};
  for (const item of data.brokerTracker) {
    byDate[item.date] = (byDate[item.date] || 0) + item.cumNet;
  }

  const sorted = Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, value }));

  if (sorted.length === 0) return [];

  const baseline = sorted[0].value || 1;
  return sorted.map((p) => ({
    date: p.date,
    value: baseline !== 0 ? ((p.value - baseline) / Math.abs(baseline)) * 100 : 0,
  }));
}

// ─── SVG Line Chart ───────────────────────────────────────────────────────────

interface LineChartProps {
  series: { label: string; color: string; points: ChartPoint[] }[];
  height?: number;
}

function LineChart({ series, height = 220 }: LineChartProps) {
  const W = 100; // viewBox percentage width
  const H = height;
  const PAD = { top: 16, right: 12, bottom: 28, left: 44 };

  // Collect all values
  const allValues = series.flatMap((s) => s.points.map((p) => p.value));
  if (allValues.length === 0) return null;

  const minV = Math.min(...allValues);
  const maxV = Math.max(...allValues);
  const range = maxV - minV || 1;

  // Collect all dates
  const allDates = [...new Set(series.flatMap((s) => s.points.map((p) => p.date)))].sort();
  const dateIndex = Object.fromEntries(allDates.map((d, i) => [d, i]));
  const N = allDates.length;

  const toX = (i: number) =>
    PAD.left + ((i / Math.max(N - 1, 1)) * (W - PAD.left - PAD.right));
  const toY = (v: number) =>
    PAD.top + ((maxV - v) / range) * (H - PAD.top - PAD.bottom);

  // Y-axis ticks
  const yTicks = 5;
  const tickStep = range / (yTicks - 1);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: `${H}px`, overflow: 'visible' }}
    >
      {/* Grid lines */}
      {Array.from({ length: yTicks }, (_, i) => {
        const v = minV + i * tickStep;
        const y = toY(v);
        return (
          <g key={i}>
            <line
              x1={PAD.left}
              y1={y}
              x2={W - PAD.right}
              y2={y}
              stroke="#21262d"
              strokeWidth="0.3"
              strokeDasharray="1,1"
            />
            <text
              x={PAD.left - 2}
              y={y}
              fontSize="3.5"
              fill="#8b949e"
              textAnchor="end"
              dominantBaseline="middle"
            >
              {v >= 0 ? '+' : ''}{v.toFixed(0)}%
            </text>
          </g>
        );
      })}

      {/* Zero line */}
      {minV < 0 && maxV > 0 && (
        <line
          x1={PAD.left}
          y1={toY(0)}
          x2={W - PAD.right}
          y2={toY(0)}
          stroke="#30363d"
          strokeWidth="0.5"
        />
      )}

      {/* X-axis date labels */}
      {allDates
        .filter((_, i) => i === 0 || i === Math.floor(N / 2) || i === N - 1)
        .map((d) => {
          const i = dateIndex[d];
          const x = toX(i);
          const label = new Date(d).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
          return (
            <text
              key={d}
              x={x}
              y={H - PAD.bottom + 8}
              fontSize="3.2"
              fill="#8b949e"
              textAnchor="middle"
            >
              {label}
            </text>
          );
        })}

      {/* Series lines */}
      {series.map((s) => {
        if (s.points.length === 0) return null;
        const pts = s.points
          .map((p) => `${toX(dateIndex[p.date])},${toY(p.value)}`)
          .join(' ');
        return (
          <g key={s.label}>
            <polyline
              points={pts}
              fill="none"
              stroke={s.color}
              strokeWidth="1"
              strokeLinejoin="round"
              strokeLinecap="round"
              style={{ filter: `drop-shadow(0 0 3px ${s.color}60)` }}
            />
            {/* Area fill */}
            {s.points.length > 1 && (
              <polygon
                points={`${toX(dateIndex[s.points[0].date])},${toY(0)} ${pts} ${toX(dateIndex[s.points[s.points.length - 1].date])},${toY(0)}`}
                fill={s.color}
                fillOpacity="0.06"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ─── Ticker Autocomplete Input ────────────────────────────────────────────────

interface TickerInputProps {
  value: string;
  onChange: (v: string) => void;
  onRemove: () => void;
  colorIndex: number;
  disabled?: boolean;
}

function TickerInput({ value, onChange, onRemove, colorIndex, disabled }: TickerInputProps) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const filtered = POPULAR_TICKERS.filter(
    (t) => t.toLowerCase().startsWith(query.toLowerCase()) && t !== value
  ).slice(0, 8);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const color = TICKER_COLORS[colorIndex];

  return (
    <div ref={ref} style={{ position: 'relative', flex: 1 }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: TICKER_BG[colorIndex],
        border: `1.5px solid ${color}40`,
        borderRadius: 10,
        padding: '8px 12px',
        transition: 'border-color 0.2s',
      }}>
        <div style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          flexShrink: 0,
          boxShadow: `0 0 6px ${color}`,
        }} />
        <input
          type="text"
          value={query}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value.toUpperCase());
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && filtered[0]) {
              onChange(filtered[0]);
              setQuery(filtered[0]);
              setOpen(false);
            }
          }}
          placeholder="TICKER"
          style={{
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: color,
            fontWeight: 700,
            fontSize: 14,
            letterSpacing: 1,
            width: '100%',
          }}
        />
        {!disabled && (
          <button
            onClick={onRemove}
            style={{
              background: 'none',
              border: 'none',
              color: '#8b949e',
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
              padding: 0,
              transition: 'color 0.15s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#f85149')}
            onMouseLeave={(e) => (e.currentTarget.style.color = '#8b949e')}
          >
            ×
          </button>
        )}
      </div>
      {open && filtered.length > 0 && (
        <ul style={{
          position: 'absolute',
          top: '110%',
          left: 0,
          right: 0,
          zIndex: 100,
          background: '#1c2128',
          border: '1px solid #30363d',
          borderRadius: 8,
          listStyle: 'none',
          margin: 0,
          padding: 4,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        }}>
          {filtered.map((t) => (
            <li
              key={t}
              onClick={() => {
                onChange(t);
                setQuery(t);
                setOpen(false);
              }}
              style={{
                padding: '7px 12px',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 600,
                color: '#e6edf3',
                letterSpacing: 0.5,
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#21262d')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              {t}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Broker Matrix Cell ───────────────────────────────────────────────────────

function MatrixCell({ entry, color }: { entry?: BrokerEntry; color: string }) {
  if (!entry) return <td style={{ padding: '8px 12px', textAlign: 'center', color: '#30363d' }}>—</td>;
  const dir = getNetDirection(entry.net);
  return (
    <td style={{ padding: '8px 12px', textAlign: 'center' }}>
      <div style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
      }}>
        <span style={{
          fontWeight: 700,
          fontSize: 12,
          color: dir === 'ACCUM' ? '#3fb950' : dir === 'DISTRIB' ? '#f85149' : '#8b949e',
          background: dir === 'ACCUM' ? 'rgba(63,185,80,0.12)' : dir === 'DISTRIB' ? 'rgba(248,81,73,0.12)' : 'transparent',
          borderRadius: 4,
          padding: '2px 6px',
        }}>
          {dir === 'ACCUM' ? '▲' : dir === 'DISTRIB' ? '▼' : '—'} {formatBillion(entry.net)}
        </span>
      </div>
    </td>
  );
}

// ─── Pattern Alerts ───────────────────────────────────────────────────────────

interface PatternAlert {
  broker: string;
  tickers: string[];
  direction: 'ACCUM' | 'DISTRIB';
  totalNet: number;
}

function findPatternAlerts(
  tickerList: string[],
  dataMap: Record<string, TickerData>
): PatternAlert[] {
  const brokerDirectionMap: Record<string, { tickers: string[]; net: number }[]> = {};

  for (const ticker of tickerList) {
    const td = dataMap[ticker];
    if (!td || td.loading || td.error) continue;
    const topBrokers = extractTopBrokers(td, 10);
    for (const b of topBrokers) {
      const dir = b.net > 0 ? 'ACCUM' : 'DISTRIB';
      const key = `${b.code}::${dir}`;
      if (!brokerDirectionMap[key]) brokerDirectionMap[key] = [];
      brokerDirectionMap[key].push({ tickers: [ticker], net: b.net });
    }
  }

  const alerts: PatternAlert[] = [];
  for (const [key, entries] of Object.entries(brokerDirectionMap)) {
    if (entries.length < 2) continue;
    const [broker, dir] = key.split('::') as [string, 'ACCUM' | 'DISTRIB'];
    alerts.push({
      broker,
      direction: dir,
      tickers: entries.map((e) => e.tickers[0]),
      totalNet: entries.reduce((s, e) => s + e.net, 0),
    });
  }

  return alerts.sort((a, b) => b.tickers.length - a.tickers.length || Math.abs(b.totalNet) - Math.abs(a.totalNet));
}

// ─── Main Comparison Component ────────────────────────────────────────────────

export default function BrokerComparisonPage() {
  const [state, setState] = useState<ComparisonState>({
    tickers: ['BBCA', 'BMRI'],
    days: 5,
    data: {},
  });
  const [fetchKey, setFetchKey] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // Fetch data for all tickers
  const fetchAll = useCallback(async () => {
    const { tickers, days } = state;
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Mark loading
    setState((prev) => ({
      ...prev,
      data: Object.fromEntries(
        tickers.map((t) => [t, { ticker: t, loading: true }])
      ),
    }));

    await Promise.all(
      tickers.map(async (ticker) => {
        try {
          const res = await fetch(
            `/api/ticker-detail?ticker=${ticker}&days=${days}`,
            { signal: ctrl.signal }
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = await res.json();
          setState((prev) => ({
            ...prev,
            data: {
              ...prev.data,
              [ticker]: { ticker, loading: false, ...json },
            },
          }));
        } catch (err: unknown) {
          if ((err as Error).name === 'AbortError') return;
          setState((prev) => ({
            ...prev,
            data: {
              ...prev.data,
              [ticker]: { ticker, loading: false, error: (err as Error).message },
            },
          }));
        }
      })
    );
  }, [state.tickers, state.days, fetchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchAll();
  }, [fetchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const triggerFetch = () => setFetchKey((k) => k + 1);

  // Ticker management
  const setTicker = (index: number, ticker: string) => {
    setState((prev) => {
      const tickers = [...prev.tickers];
      tickers[index] = ticker;
      return { ...prev, tickers };
    });
  };

  const addTicker = () => {
    if (state.tickers.length >= 4) return;
    const available = POPULAR_TICKERS.find((t) => !state.tickers.includes(t)) || 'TLKM';
    setState((prev) => ({ ...prev, tickers: [...prev.tickers, available] }));
  };

  const removeTicker = (index: number) => {
    if (state.tickers.length <= 1) return;
    setState((prev) => {
      const tickers = prev.tickers.filter((_, i) => i !== index);
      return { ...prev, tickers };
    });
  };

  const setDays = (days: number) => {
    setState((prev) => ({ ...prev, days }));
  };

  // Chart data
  const chartSeries = state.tickers.map((ticker, i) => {
    const td = state.data[ticker];
    return {
      label: ticker,
      color: TICKER_COLORS[i % TICKER_COLORS.length],
      points: td && !td.loading ? buildNormalizedSeries(td) : [],
    };
  });

  // Broker matrix
  const allBrokers = [...new Set(
    state.tickers.flatMap((t) => {
      const td = state.data[t];
      if (!td || td.loading) return [];
      return extractTopBrokers(td, 6).map((b) => b.code);
    })
  )];

  // Pattern alerts
  const alerts = findPatternAlerts(state.tickers, state.data);

  const isAnyLoading = state.tickers.some((t) => state.data[t]?.loading);

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0d1117',
      color: '#e6edf3',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      padding: '24px 16px',
      maxWidth: 1400,
      margin: '0 auto',
    }}>
      {/* ─── Header ─── */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <div style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            background: 'linear-gradient(135deg, #58a6ff22, #3fb95022)',
            border: '1px solid #30363d',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 18,
          }}>
            ⚡
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: -0.5 }}>
              Broker Flow Pattern Comparison
            </h1>
            <p style={{ margin: 0, fontSize: 13, color: '#8b949e' }}>
              Compare broker accumulation patterns across multiple stocks simultaneously
            </p>
          </div>
        </div>
      </div>

      {/* ─── Controls Bar ─── */}
      <div style={{
        background: '#161b22',
        border: '1px solid #21262d',
        borderRadius: 14,
        padding: '20px 24px',
        marginBottom: 24,
      }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
          {/* Ticker Inputs */}
          <div style={{ flex: '1 1 auto', display: 'flex', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
            {state.tickers.map((ticker, i) => (
              <TickerInput
                key={i}
                value={ticker}
                colorIndex={i}
                onChange={(v) => setTicker(i, v)}
                onRemove={() => removeTicker(i)}
                disabled={false}
              />
            ))}
            {state.tickers.length < 4 && (
              <button
                onClick={addTicker}
                style={{
                  padding: '8px 16px',
                  background: 'rgba(88,166,255,0.08)',
                  border: '1.5px dashed #30363d',
                  borderRadius: 10,
                  color: '#58a6ff',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                  transition: 'all 0.15s',
                  whiteSpace: 'nowrap',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(88,166,255,0.15)';
                  e.currentTarget.style.borderColor = '#58a6ff';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(88,166,255,0.08)';
                  e.currentTarget.style.borderColor = '#30363d';
                }}
              >
                + Add Ticker
              </button>
            )}
          </div>

          {/* Timeframe */}
          <div style={{ display: 'flex', gap: 4 }}>
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.days}
                onClick={() => setDays(tf.days)}
                style={{
                  padding: '7px 14px',
                  borderRadius: 8,
                  border: state.days === tf.days ? '1px solid #58a6ff' : '1px solid #30363d',
                  background: state.days === tf.days ? 'rgba(88,166,255,0.15)' : 'transparent',
                  color: state.days === tf.days ? '#58a6ff' : '#8b949e',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                  transition: 'all 0.15s',
                }}
              >
                {tf.label}
              </button>
            ))}
          </div>

          {/* Compare Button */}
          <button
            onClick={triggerFetch}
            disabled={isAnyLoading}
            style={{
              padding: '8px 20px',
              background: isAnyLoading
                ? 'rgba(63,185,80,0.1)'
                : 'linear-gradient(135deg, #3fb950, #2ea043)',
              border: 'none',
              borderRadius: 10,
              color: '#fff',
              cursor: isAnyLoading ? 'not-allowed' : 'pointer',
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: 0.3,
              transition: 'all 0.15s',
              boxShadow: isAnyLoading ? 'none' : '0 4px 12px rgba(63,185,80,0.3)',
            }}
          >
            {isAnyLoading ? '⟳ Loading…' : '⚡ Compare'}
          </button>
        </div>
      </div>

      {/* ─── Pattern Alerts ─── */}
      {alerts.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#8b949e', marginBottom: 10, letterSpacing: 0.5 }}>
            🔍 PATTERN ALERTS
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {alerts.slice(0, 6).map((alert, i) => (
              <div
                key={i}
                style={{
                  background: alert.direction === 'ACCUM'
                    ? 'rgba(63,185,80,0.08)'
                    : 'rgba(248,81,73,0.08)',
                  border: `1px solid ${alert.direction === 'ACCUM' ? 'rgba(63,185,80,0.3)' : 'rgba(248,81,73,0.3)'}`,
                  borderRadius: 10,
                  padding: '10px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  transition: 'transform 0.15s, box-shadow 0.15s',
                  cursor: 'default',
                  position: 'relative',
                  overflow: 'hidden',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-1px)';
                  e.currentTarget.style.boxShadow = `0 4px 16px ${alert.direction === 'ACCUM' ? 'rgba(63,185,80,0.2)' : 'rgba(248,81,73,0.2)'}`;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                <span style={{ fontSize: 16 }}>
                  {alert.direction === 'ACCUM' ? '📈' : '📉'}
                </span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#e6edf3' }}>
                    <span style={{
                      color: alert.direction === 'ACCUM' ? '#3fb950' : '#f85149',
                      marginRight: 4,
                    }}>
                      {alert.broker}
                    </span>
                    {alert.direction === 'ACCUM' ? 'accumulating' : 'distributing'} in{' '}
                    {alert.tickers.join(', ')}
                  </div>
                  <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2 }}>
                    Total net: {formatBillion(alert.totalNet)} • {alert.tickers.length} stocks
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── Normalized Chart ─── */}
      <div style={{
        background: '#161b22',
        border: '1px solid #21262d',
        borderRadius: 14,
        padding: '20px 24px',
        marginBottom: 24,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Normalized Flow Pattern</div>
            <div style={{ fontSize: 12, color: '#8b949e' }}>% change in cumulative net flow from period start</div>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            {state.tickers.map((ticker, i) => (
              <div key={ticker} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{
                  width: 24,
                  height: 2,
                  background: TICKER_COLORS[i % TICKER_COLORS.length],
                  borderRadius: 1,
                }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: TICKER_COLORS[i % TICKER_COLORS.length] }}>
                  {ticker}
                </span>
              </div>
            ))}
          </div>
        </div>
        {isAnyLoading ? (
          <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8b949e' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 24, marginBottom: 8, animation: 'spin 1s linear infinite' }}>⟳</div>
              <div>Loading data…</div>
            </div>
          </div>
        ) : chartSeries.every((s) => s.points.length === 0) ? (
          <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8b949e' }}>
            No chart data available. Click Compare to load.
          </div>
        ) : (
          <LineChart series={chartSeries} height={220} />
        )}
      </div>

      {/* ─── Stats Cards Row ─── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${state.tickers.length}, 1fr)`,
        gap: 16,
        marginBottom: 24,
      }}>
        {state.tickers.map((ticker, i) => {
          const td = state.data[ticker];
          const color = TICKER_COLORS[i % TICKER_COLORS.length];
          const topBrokers = td && !td.loading && !td.error ? extractTopBrokers(td, 3) : [];
          const net = td?.summary?.netFlow ?? 0;
          const dir = getNetDirection(net);

          return (
            <div
              key={ticker}
              style={{
                background: '#161b22',
                border: `1px solid ${color}25`,
                borderRadius: 14,
                padding: '18px 20px',
                transition: 'transform 0.2s, box-shadow 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-2px)';
                e.currentTarget.style.boxShadow = `0 8px 24px ${color}18`;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div style={{
                  fontSize: 18,
                  fontWeight: 800,
                  color,
                  letterSpacing: 0.5,
                }}>
                  {ticker}
                </div>
                {td?.loading ? (
                  <span style={{ fontSize: 12, color: '#8b949e' }}>Loading…</span>
                ) : td?.error ? (
                  <span style={{ fontSize: 11, color: '#f85149' }}>Error</span>
                ) : (
                  <span style={{
                    fontSize: 11,
                    fontWeight: 700,
                    padding: '3px 8px',
                    borderRadius: 6,
                    background: dir === 'ACCUM' ? 'rgba(63,185,80,0.15)' : dir === 'DISTRIB' ? 'rgba(248,81,73,0.15)' : 'rgba(139,148,158,0.15)',
                    color: dir === 'ACCUM' ? '#3fb950' : dir === 'DISTRIB' ? '#f85149' : '#8b949e',
                  }}>
                    {dir}
                  </span>
                )}
              </div>

              {!td?.loading && !td?.error && (
                <>
                  <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 4, color: dir === 'ACCUM' ? '#3fb950' : dir === 'DISTRIB' ? '#f85149' : '#8b949e' }}>
                    {net >= 0 ? '+' : ''}{formatBillion(net)}
                  </div>
                  <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 12 }}>Net Flow</div>

                  <div style={{ fontSize: 11, fontWeight: 600, color: '#8b949e', marginBottom: 6, letterSpacing: 0.5 }}>
                    TOP BROKERS
                  </div>
                  {topBrokers.map((b) => {
                    const bd = getNetDirection(b.net);
                    return (
                      <div key={b.code} style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '4px 0',
                        borderBottom: '1px solid #21262d',
                      }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#e6edf3' }}>{b.code}</span>
                        <span style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: bd === 'ACCUM' ? '#3fb950' : '#f85149',
                        }}>
                          {b.net >= 0 ? '+' : ''}{formatBillion(b.net)}
                        </span>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* ─── Broker Matrix Table ─── */}
      {allBrokers.length > 0 && (
        <div style={{
          background: '#161b22',
          border: '1px solid #21262d',
          borderRadius: 14,
          overflow: 'hidden',
          marginBottom: 24,
        }}>
          <div style={{ padding: '18px 24px', borderBottom: '1px solid #21262d' }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Broker Cross-Stock Matrix</div>
            <div style={{ fontSize: 12, color: '#8b949e', marginTop: 2 }}>
              Top brokers across selected stocks — green = accumulation, red = distribution
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 13,
            }}>
              <thead>
                <tr style={{ background: '#0d1117' }}>
                  <th style={{ padding: '10px 16px', textAlign: 'left', color: '#8b949e', fontWeight: 600, fontSize: 11, letterSpacing: 0.5 }}>
                    BROKER
                  </th>
                  {state.tickers.map((ticker, i) => (
                    <th key={ticker} style={{
                      padding: '10px 12px',
                      textAlign: 'center',
                      color: TICKER_COLORS[i % TICKER_COLORS.length],
                      fontWeight: 700,
                      fontSize: 12,
                      letterSpacing: 0.5,
                    }}>
                      {ticker}
                    </th>
                  ))}
                  <th style={{ padding: '10px 12px', textAlign: 'center', color: '#8b949e', fontWeight: 600, fontSize: 11 }}>
                    PRESENCE
                  </th>
                </tr>
              </thead>
              <tbody>
                {allBrokers.map((broker, ri) => {
                  const cells = state.tickers.map((ticker) => {
                    const td = state.data[ticker];
                    if (!td || td.loading || td.error) return undefined;
                    const brokers = extractTopBrokers(td, 6);
                    return brokers.find((b) => b.code === broker);
                  });

                  const presence = cells.filter(Boolean).length;
                  const isMulti = presence >= 2;

                  return (
                    <tr
                      key={broker}
                      style={{
                        borderTop: '1px solid #21262d',
                        background: isMulti
                          ? ri % 2 === 0
                            ? 'rgba(88,166,255,0.03)'
                            : 'rgba(88,166,255,0.05)'
                          : ri % 2 === 0
                          ? 'transparent'
                          : 'rgba(255,255,255,0.015)',
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(88,166,255,0.08)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = isMulti
                        ? ri % 2 === 0 ? 'rgba(88,166,255,0.03)' : 'rgba(88,166,255,0.05)'
                        : ri % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)'
                      )}
                    >
                      <td style={{ padding: '8px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontWeight: 700, fontSize: 13, color: '#e6edf3' }}>{broker}</span>
                          {isMulti && (
                            <span style={{
                              fontSize: 9,
                              fontWeight: 700,
                              padding: '2px 5px',
                              borderRadius: 4,
                              background: 'rgba(227,179,65,0.15)',
                              color: '#e3b341',
                              letterSpacing: 0.5,
                            }}>
                              MULTI
                            </span>
                          )}
                        </div>
                      </td>
                      {cells.map((cell, ci) => (
                        <MatrixCell key={ci} entry={cell} color={TICKER_COLORS[ci % TICKER_COLORS.length]} />
                      ))}
                      <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                        <div style={{
                          display: 'flex',
                          justifyContent: 'center',
                          gap: 3,
                        }}>
                          {state.tickers.map((_, i) => (
                            <div
                              key={i}
                              style={{
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                background: cells[i] ? TICKER_COLORS[i % TICKER_COLORS.length] : '#21262d',
                                boxShadow: cells[i] ? `0 0 4px ${TICKER_COLORS[i % TICKER_COLORS.length]}` : 'none',
                              }}
                            />
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

      {/* ─── Footer ─── */}
      <div style={{ textAlign: 'center', color: '#484f58', fontSize: 12, marginTop: 16 }}>
        Data sourced from broker transaction reports · {new Date().toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
