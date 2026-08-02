'use client';

import { useState, useEffect, useCallback } from 'react';
import DataFreshnessBanner from '@/components/DataFreshnessBanner';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://76.13.22.155:3100';

interface ScreenerResult {
  ticker: string;
  turnover_d0_B: number;
  net_d0_B: number;
  net_3d_B: number;
  foreign_3d_B: number;
  accum_score: number;
  accum_6m: { date: string; cum: number }[];
  step3_pass: boolean;
  data_days_6m: number;
}

interface ScreenerMeta {
  d0: string;
  d3_start: string;
  total_in_db: number;
  passed_liq: number;
  passed_step012: number;
  passed_all: number;
  min_liquidity_B: number;
}

function MiniChart({ data }: { data: { date: string; cum: number }[] }) {
  if (!data || data.length < 2) return <div className="mini-chart-empty">No data</div>;
  const vals = data.map(d => d.cum);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const w = 120, h = 40;
  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x},${y}`;
  }).join(' ');
  const lastVal = vals[vals.length - 1];
  const isPositive = lastVal > 0;
  const color = isPositive ? '#10b981' : '#ef4444';

  return (
    <div className="mini-chart">
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        <defs>
          <linearGradient id={`grad-${data[0]?.date}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <polyline
          points={pts}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Zero line */}
        {min < 0 && max > 0 && (
          <line
            x1="0" y1={h - ((0 - min) / range) * h}
            x2={w} y2={h - ((0 - min) / range) * h}
            stroke="rgba(255,255,255,0.15)" strokeWidth="0.5" strokeDasharray="2,2"
          />
        )}
      </svg>
      <span className="chart-value" style={{ color }}>{lastVal > 0 ? '+' : ''}{lastVal.toFixed(1)}B</span>
    </div>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 70 ? '#10b981' : score >= 50 ? '#f59e0b' : score >= 40 ? '#f97316' : '#6b7280';
  return (
    <div className="score-badge" style={{ borderColor: color, color }}>
      <div className="score-ring" style={{ background: `conic-gradient(${color} ${score * 3.6}deg, rgba(255,255,255,0.05) 0deg)` }}>
        <span>{score}</span>
      </div>
    </div>
  );
}

function FunnelStep({ step, label, count, total, active }: {
  step: number; label: string; count: number; total: number; active: boolean;
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className={`funnel-step ${active ? 'active' : ''}`}>
      <div className="funnel-step-num">Step {step}</div>
      <div className="funnel-step-label">{label}</div>
      <div className="funnel-step-count">{count}</div>
      <div className="funnel-step-bar">
        <div className="funnel-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="funnel-step-pct">{pct}%</div>
    </div>
  );
}

export default function SmartMoneyScreener() {
  const [data, setData] = useState<{ meta: ScreenerMeta; results: ScreenerResult[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [sortBy, setSortBy] = useState<'foreign' | 'score' | 'turnover'>('foreign');
  const [minLiq, setMinLiq] = useState(30);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await fetch(`${API_BASE}/api/screener/smart-money?min_liquidity=${minLiq}`);
      const d = await r.json();
      setData(d);
      setLastRefresh(new Date());
    } catch (e) {
      setError('Failed to load screener data');
    } finally {
      setLoading(false);
    }
  }, [minLiq]);

  useEffect(() => { load(); }, [load]);

  const sorted = data ? [...data.results].sort((a, b) => {
    if (sortBy === 'foreign') return b.foreign_3d_B - a.foreign_3d_B;
    if (sortBy === 'score')   return b.accum_score - a.accum_score;
    return b.turnover_d0_B - a.turnover_d0_B;
  }) : [];

  const displayed = showAll ? sorted : sorted.filter(r => r.step3_pass);

  return (
    <div className="screener-page">
      <style>{`
        .screener-page {
          min-height: 100vh;
          background: linear-gradient(135deg, #0a0e1a 0%, #0d1220 50%, #0a0e1a 100%);
          color: #e2e8f0;
          font-family: 'Inter', -apple-system, sans-serif;
          padding: 24px;
        }
        .screener-header {
          margin-bottom: 32px;
        }
        .screener-title {
          font-size: 28px;
          font-weight: 800;
          background: linear-gradient(135deg, #60a5fa, #a78bfa, #34d399);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          margin: 0 0 4px 0;
          letter-spacing: -0.5px;
        }
        .screener-subtitle {
          color: #64748b;
          font-size: 13px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .refresh-btn {
          background: rgba(99,102,241,0.15);
          border: 1px solid rgba(99,102,241,0.3);
          color: #818cf8;
          border-radius: 6px;
          padding: 4px 10px;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.2s;
        }
        .refresh-btn:hover { background: rgba(99,102,241,0.25); }

        /* FUNNEL */
        .funnel-card {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 16px;
          padding: 24px;
          margin-bottom: 24px;
        }
        .funnel-label {
          font-size: 12px;
          font-weight: 600;
          color: #475569;
          text-transform: uppercase;
          letter-spacing: 1px;
          margin-bottom: 16px;
        }
        .funnel-grid {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: 12px;
          align-items: start;
        }
        .funnel-step {
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 12px;
          padding: 16px 12px;
          text-align: center;
          transition: all 0.3s;
        }
        .funnel-step.active {
          border-color: rgba(99,102,241,0.4);
          background: rgba(99,102,241,0.05);
        }
        .funnel-step-num {
          font-size: 10px;
          color: #475569;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 4px;
        }
        .funnel-step-label {
          font-size: 11px;
          color: #94a3b8;
          margin-bottom: 12px;
          line-height: 1.3;
          min-height: 30px;
        }
        .funnel-step-count {
          font-size: 32px;
          font-weight: 800;
          color: #e2e8f0;
          line-height: 1;
          margin-bottom: 8px;
        }
        .funnel-step-bar {
          height: 3px;
          background: rgba(255,255,255,0.05);
          border-radius: 2px;
          overflow: hidden;
          margin-bottom: 4px;
        }
        .funnel-bar-fill {
          height: 100%;
          background: linear-gradient(90deg, #6366f1, #8b5cf6);
          border-radius: 2px;
          transition: width 0.8s ease;
        }
        .funnel-step-pct { font-size: 11px; color: #475569; }

        /* CONTROLS */
        .controls-row {
          display: flex;
          gap: 12px;
          align-items: center;
          margin-bottom: 20px;
          flex-wrap: wrap;
        }
        .control-group {
          display: flex;
          align-items: center;
          gap: 8px;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 10px;
          padding: 8px 14px;
        }
        .control-group label { font-size: 12px; color: #64748b; white-space: nowrap; }
        .control-group select, .control-group input {
          background: transparent;
          border: none;
          color: #e2e8f0;
          font-size: 13px;
          outline: none;
          cursor: pointer;
        }
        .toggle-btn {
          margin-left: auto;
          background: rgba(99,102,241,0.1);
          border: 1px solid rgba(99,102,241,0.2);
          color: #818cf8;
          border-radius: 8px;
          padding: 6px 14px;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.2s;
        }
        .toggle-btn:hover { background: rgba(99,102,241,0.2); }
        .toggle-btn.active { background: rgba(99,102,241,0.3); border-color: rgba(99,102,241,0.5); }

        /* EMPTY STATE */
        .empty-state {
          text-align: center;
          padding: 64px 24px;
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 16px;
        }
        .empty-icon { font-size: 48px; margin-bottom: 16px; }
        .empty-title { font-size: 20px; font-weight: 700; color: #e2e8f0; margin-bottom: 8px; }
        .empty-desc { color: #64748b; font-size: 14px; line-height: 1.6; max-width: 420px; margin: 0 auto; }

        /* RESULTS TABLE */
        .results-grid {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .result-card {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 14px;
          padding: 16px 20px;
          display: grid;
          grid-template-columns: 90px 1fr 1fr 1fr 100px 140px;
          gap: 16px;
          align-items: center;
          cursor: pointer;
          transition: all 0.2s;
        }
        .result-card:hover {
          border-color: rgba(99,102,241,0.35);
          background: rgba(99,102,241,0.05);
          transform: translateX(2px);
        }
        .result-card.step3-fail {
          opacity: 0.55;
          border-style: dashed;
        }
        .ticker-col { }
        .ticker-code {
          font-size: 18px;
          font-weight: 800;
          color: #e2e8f0;
          letter-spacing: 0.5px;
        }
        .ticker-tv {
          font-size: 11px;
          color: #64748b;
          margin-top: 2px;
        }
        .metric-col { }
        .metric-label { font-size: 10px; color: #475569; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
        .metric-value {
          font-size: 16px;
          font-weight: 700;
        }
        .metric-value.pos { color: #10b981; }
        .metric-value.neg { color: #ef4444; }

        /* Mini chart */
        .mini-chart {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
        }
        .mini-chart-empty { color: #475569; font-size: 11px; }
        .chart-value { font-size: 11px; font-weight: 600; }

        /* Score badge */
        .score-badge { display: flex; align-items: center; justify-content: center; }
        .score-ring {
          width: 52px;
          height: 52px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
        }
        .score-ring::before {
          content: '';
          position: absolute;
          inset: 3px;
          background: #0d1220;
          border-radius: 50%;
        }
        .score-ring span {
          position: relative;
          font-size: 15px;
          font-weight: 800;
          z-index: 1;
        }

        /* Step badges */
        .step-badges { display: flex; gap: 4px; flex-wrap: wrap; }
        .step-badge {
          font-size: 10px;
          padding: 2px 6px;
          border-radius: 4px;
          font-weight: 600;
        }
        .step-badge.pass { background: rgba(16,185,129,0.15); color: #10b981; }
        .step-badge.fail { background: rgba(239,68,68,0.1); color: #ef4444; }

        /* Loading */
        .loading-state {
          text-align: center;
          padding: 80px;
          color: #64748b;
        }
        .loading-spinner {
          width: 36px;
          height: 36px;
          border: 3px solid rgba(99,102,241,0.1);
          border-top-color: #6366f1;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
          margin: 0 auto 16px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* Risk-off banner */
        .risk-off-banner {
          background: rgba(239,68,68,0.08);
          border: 1px solid rgba(239,68,68,0.2);
          border-radius: 12px;
          padding: 16px 20px;
          margin-bottom: 20px;
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .risk-off-icon { font-size: 24px; }
        .risk-off-text h4 { font-size: 14px; font-weight: 700; color: #fca5a5; margin: 0 0 2px; }
        .risk-off-text p { font-size: 12px; color: #94a3b8; margin: 0; }

        @media (max-width: 900px) {
          .funnel-grid { grid-template-columns: repeat(3, 1fr); }
          .result-card { grid-template-columns: 80px 1fr 1fr; }
        }
      `}</style>

      {/* Header */}
      <div className="screener-header">
        <h1 className="screener-title">🔍 Smart Money Screener</h1>
        <div className="screener-subtitle">
          <span>Kompas seleksi emiten — 4-step systematic filter</span>
          {lastRefresh && <span>· Updated {lastRefresh.toLocaleTimeString('id-ID')}</span>}
          <button className="refresh-btn" onClick={load} disabled={loading}>
            {loading ? '⟳ Loading...' : '↺ Refresh'}
          </button>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="loading-state">
          <div className="loading-spinner" />
          <p>Running 4-step screener across {data?.meta?.total_in_db || '...'} stocks...</p>
        </div>
      )}

      {!loading && error && (
        <div className="empty-state">
          <div className="empty-icon">⚠️</div>
          <div className="empty-title">Connection Error</div>
          <div className="empty-desc">{error}</div>
        </div>
      )}

      {!loading && data && (
        <>
          <DataFreshnessBanner d0={data.meta.d0} />

          {/* Funnel */}
          <div className="funnel-card">
            <div className="funnel-label">Screening Funnel — {data.meta.d0}</div>
            <div className="funnel-grid">
              <FunnelStep step={0} label="All Stocks in DB" count={data.meta.total_in_db}
                total={data.meta.total_in_db} active={false} />
              <FunnelStep step={0} label={`Liquidity ≥ ${data.meta.min_liquidity_B}B`}
                count={data.meta.passed_liq} total={data.meta.total_in_db} active={false} />
              <FunnelStep step={1} label="D0 Net Beli + 3D Momentum"
                count={data.meta.passed_step012} total={data.meta.passed_liq} active={true} />
              <FunnelStep step={2} label="Foreign Akumulasi (3D)"
                count={data.meta.passed_step012} total={data.meta.passed_liq} active={true} />
              <FunnelStep step={3} label="6M Akumulasi Signifikan"
                count={data.meta.passed_all} total={data.meta.passed_step012 || 1} active={true} />
            </div>
          </div>

          {/* Risk-off day notice */}
          {data.meta.passed_step012 === 0 && (
            <div className="risk-off-banner">
              <div className="risk-off-icon">🛡️</div>
              <div className="risk-off-text">
                <h4>Risk-Off Day — Tidak Ada Sinyal</h4>
                <p>
                  Pada {data.meta.d0}, dari {data.meta.passed_liq} saham liquid,
                  tidak ada yang menunjukkan akumulasi dengan konfirmasi foreign positif.
                  Ini sinyal kehati-hatian — pasar sedang dalam mode distribusi/sell-off.
                </p>
              </div>
            </div>
          )}

          {/* Controls */}
          {data.results.length > 0 && (
            <div className="controls-row">
              <div className="control-group">
                <label>Sort by:</label>
                <select value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)}>
                  <option value="foreign">Foreign Net 3D</option>
                  <option value="score">Accum Score</option>
                  <option value="turnover">Turnover</option>
                </select>
              </div>
              <div className="control-group">
                <label>Min Liq (B):</label>
                <input type="number" value={minLiq} min={5} max={500} step={5}
                  onChange={e => setMinLiq(Number(e.target.value))}
                  style={{ width: 60 }} />
                <button className="refresh-btn" onClick={load}>Apply</button>
              </div>
              <button className={`toggle-btn ${showAll ? 'active' : ''}`}
                onClick={() => setShowAll(!showAll)}>
                {showAll ? 'Semua Hasil' : 'Step 3 Passed Only'}
              </button>
            </div>
          )}

          {/* Results */}
          {displayed.length > 0 ? (
            <div className="results-grid">
              {displayed.map(r => (
                <div
                  key={r.ticker}
                  className={`result-card ${!r.step3_pass ? 'step3-fail' : ''}`}
                  onClick={() => window.open(`/?ticker=${r.ticker}`, '_blank')}
                >
                  {/* Ticker */}
                  <div className="ticker-col">
                    <div className="ticker-code">{r.ticker}</div>
                    <div className="ticker-tv">{r.turnover_d0_B.toFixed(1)}B vol</div>
                    <div className="step-badges" style={{ marginTop: 4 }}>
                      <span className="step-badge pass">S0✓</span>
                      <span className="step-badge pass">S1✓</span>
                      <span className="step-badge pass">S2✓</span>
                      <span className={`step-badge ${r.step3_pass ? 'pass' : 'fail'}`}>
                        S3{r.step3_pass ? '✓' : '✗'}
                      </span>
                    </div>
                  </div>

                  {/* D0 Net */}
                  <div className="metric-col">
                    <div className="metric-label">D0 Net</div>
                    <div className={`metric-value ${r.net_d0_B >= 0 ? 'pos' : 'neg'}`}>
                      {r.net_d0_B >= 0 ? '+' : ''}{r.net_d0_B.toFixed(1)}B
                    </div>
                  </div>

                  {/* 3D Net */}
                  <div className="metric-col">
                    <div className="metric-label">Net 3 Hari</div>
                    <div className={`metric-value ${r.net_3d_B >= 0 ? 'pos' : 'neg'}`}>
                      {r.net_3d_B >= 0 ? '+' : ''}{r.net_3d_B.toFixed(1)}B
                    </div>
                  </div>

                  {/* Foreign 3D */}
                  <div className="metric-col">
                    <div className="metric-label">Foreign 3D</div>
                    <div className={`metric-value ${r.foreign_3d_B >= 0 ? 'pos' : 'neg'}`}>
                      {r.foreign_3d_B >= 0 ? '+' : ''}{r.foreign_3d_B.toFixed(1)}B
                    </div>
                  </div>

                  {/* 6M Chart */}
                  <MiniChart data={r.accum_6m} />

                  {/* Score */}
                  <ScoreBadge score={r.accum_score} />
                </div>
              ))}
            </div>
          ) : data.results.length === 0 ? null : (
            <div className="empty-state">
              <div className="empty-icon">📋</div>
              <div className="empty-title">Tidak ada yang lolos Step 3</div>
              <div className="empty-desc">
                Beberapa saham lolos Step 1+2 tapi belum memiliki pola akumulasi 6 bulan yang kuat.
                Aktifkan "Semua Hasil" untuk melihat kandidat partial.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
