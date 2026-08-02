'use client';
import Navbar from '@/components/Navbar';
import { API_BASE } from '@/lib/apiConfig';
import { useState, useEffect, useCallback } from 'react';

const fmt = (n: number) => `Rp ${Math.round(n).toLocaleString('id-ID')}`;
const pct = (n: number) => `${n >= 0 ? '+' : ''}${Number(n).toFixed(1)}%`;

function StatCard({ label, value, color, sub }: { label: string; value: any; color?: string; sub?: string }) {
  return (
    <div style={{ padding: '14px 16px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 12 }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.08em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 900, color: color || 'var(--text-primary)', lineHeight: 1 }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function WinBar({ wr, label }: { wr: number; label: string }) {
  const col = wr >= 65 ? '#10b981' : wr >= 50 ? '#f59e0b' : '#f87171';
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: 'var(--text-primary)' }}>{label}</span>
        <span style={{ fontSize: 11, fontWeight: 800, color: col }}>{wr}%</span>
      </div>
      <div style={{ height: 5, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${wr}%`, height: '100%', background: col, borderRadius: 3, transition: 'width 0.6s ease' }} />
      </div>
    </div>
  );
}

export default function BacktestPage() {
  const [status, setStatus] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [period, setPeriod] = useState(30);
  const [minScore, setMinScore] = useState(50);
  const [minRR, setMinRR] = useState(1.5);
  const [tab, setTab] = useState<'overview' | 'pattern' | 'signals'>('overview');
  const [msg, setMsg] = useState('');

  const checkStatus = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/backtest/status`);
      const d = await r.json();
      setStatus(d);
      return d;
    } catch { return null; }
  }, []);

  const loadResult = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/backtest/result`);
      const d = await r.json();
      if (d.status === 'ok') setResult(d);
    } catch {}
  }, []);

  useEffect(() => {
    checkStatus();
    loadResult();
  }, [checkStatus, loadResult]);

  const runBacktest = async () => {
    setRunning(true);
    setMsg('Memulai backtest...');
    try {
      const r = await fetch(`${API_BASE}/api/backtest/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period, min_score: minScore, min_rr: minRR }),
      });
      const d = await r.json();
      setMsg(d.message || 'Berjalan...');
      // Poll until done
      const poll = setInterval(async () => {
        const s = await checkStatus();
        if (s && !s.running) {
          clearInterval(poll);
          await loadResult();
          setRunning(false);
          setMsg('');
        }
      }, 3000);
    } catch (e) {
      setRunning(false);
      setMsg('Gagal memulai backtest');
    }
  };

  const ov = result?.overall;
  const ovColor = ov && ov.wr >= 60 ? '#10b981' : ov && ov.wr >= 45 ? '#f59e0b' : '#f87171';

  return (
    <>
      <Navbar />
      <main style={{ maxWidth: 1300, margin: '0 auto', padding: '28px 24px' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 16 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-primary)', margin: 0, fontFamily: "'Space Grotesk', sans-serif" }}>
              🧪 Backtest Engine
            </h1>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
              Validasi sistem sinyal dengan data historis IDX · Master Conviction Score (5 Layer)
            </p>
          </div>

          {/* Config Panel */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            {[
              { label: 'Periode (hari)', value: period, min: 5, max: 365, step: 5, set: setPeriod },
              { label: 'Min Score', value: minScore, min: 30, max: 90, step: 5, set: setMinScore },
            ].map(({ label, value, min, max, step, set }) => (
              <div key={label}>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, marginBottom: 4 }}>{label}</div>
                <input
                  type="number" value={value} min={min} max={max} step={step}
                  onChange={e => set(Number(e.target.value))}
                  style={{ width: 80, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 700 }}
                />
              </div>
            ))}
            <div>
              <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, marginBottom: 4 }}>Min R:R</div>
              <input type="number" value={minRR} min={1} max={5} step={0.5}
                onChange={e => setMinRR(Number(e.target.value))}
                style={{ width: 70, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 700 }}
              />
            </div>

            <button
              onClick={runBacktest}
              disabled={running}
              style={{
                padding: '8px 20px', borderRadius: 10, border: 'none', cursor: running ? 'not-allowed' : 'pointer',
                background: running ? 'rgba(99,102,241,0.3)' : 'linear-gradient(135deg,#6366f1,#8b5cf6)',
                color: '#fff', fontSize: 13, fontWeight: 800,
                display: 'flex', alignItems: 'center', gap: 8, opacity: running ? 0.7 : 1,
              }}
            >
              <span style={{ display: 'inline-block', animation: running ? 'spin 1s linear infinite' : 'none' }}>⟳</span>
              {running ? 'Scanning...' : '▶ Run Backtest'}
            </button>
          </div>
        </div>

        {/* Running indicator */}
        {(running || msg) && (
          <div style={{ padding: '12px 16px', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: 10, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10 }}>
            {running && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#6366f1', boxShadow: '0 0 8px #6366f1', animation: 'pulse 1s ease-in-out infinite' }} />}
            <span style={{ fontSize: 12, color: '#a5b4fc' }}>{msg || 'Backtest berjalan... (~60-120 detik)'}</span>
          </div>
        )}

        {!result && !running && (
          <div style={{ textAlign: 'center', padding: '60px 20px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 16 }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🧪</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>Belum Ada Hasil Backtest</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20 }}>
              Set parameter di atas lalu klik <strong style={{ color: '#a5b4fc' }}>Run Backtest</strong> untuk mulai validasi sistem
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, maxWidth: 500, margin: '0 auto' }}>
              {[
                { icon: '📊', label: 'Layer 1', desc: 'Harmonic Pattern (ABCD, BAT, Gartley...)' },
                { icon: '🌊', label: 'Layer 2', desc: 'Wyckoff + SMC + Volume Profile' },
                { icon: '🏦', label: 'Layer 3', desc: 'Broker Flow (BigMoney + Foreign)' },
              ].map(l => (
                <div key={l.label} style={{ padding: 12, background: 'var(--bg-primary)', borderRadius: 10, border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 20, marginBottom: 6 }}>{l.icon}</div>
                  <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-primary)' }}>{l.label}</div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>{l.desc}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {result && (
          <>
            {/* Meta info */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, fontSize: 10, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
              <span>📅 Generated: {result.meta?.generated ? new Date(result.meta.generated).toLocaleString('id-ID') : '—'}</span>
              <span>·</span>
              <span>📋 {result.meta?.tickers_scanned} tickers</span>
              <span>·</span>
              <span>🕐 {result.meta?.period_days}d lookback</span>
              <span>·</span>
              <span>⏩ {result.meta?.lookforward_days}d lookforward</span>
              <span>·</span>
              <span>🎯 Min score: {result.meta?.min_score} | Min R:R: {result.meta?.min_rr}</span>
            </div>

            {/* Overall banner */}
            {ov && (
              <div style={{
                padding: '20px 24px', borderRadius: 16, marginBottom: 20,
                background: `linear-gradient(135deg, ${ovColor}12, ${ovColor}04)`,
                border: `1px solid ${ovColor}35`,
                display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'center', justifyContent: 'space-between',
              }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700, marginBottom: 6 }}>OVERALL BACKTEST RESULT</div>
                  <div style={{ fontSize: 42, fontWeight: 900, color: ovColor, lineHeight: 1 }}>{ov.wr}%</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Win Rate · EV: <strong style={{ color: ovColor }}>{ov.ev >= 0 ? '+' : ''}{ov.ev}R</strong>/trade</div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
                  {[
                    { label: 'TOTAL SIGNALS', value: ov.total, color: 'var(--text-primary)' },
                    { label: 'CLOSED', value: ov.closed, color: '#60a5fa' },
                    { label: 'WIN', value: ov.wins, color: '#10b981' },
                    { label: 'LOSS', value: ov.losses, color: '#f87171' },
                  ].map(s => (
                    <div key={s.label} style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 24, fontWeight: 900, color: s.color }}>{s.value}</div>
                      <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700 }}>{s.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Tabs */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 10, padding: 3 }}>
              {([['overview','📊 Breakdown'],['pattern','🎯 By Pattern'],['signals','📋 Signals']] as const).map(([key, label]) => (
                <button key={key} onClick={() => setTab(key as any)} style={{
                  flex: 1, padding: '7px 12px', borderRadius: 7, border: 'none', cursor: 'pointer',
                  fontSize: 11, fontWeight: 700,
                  background: tab === key ? 'linear-gradient(135deg,#6366f1,#8b5cf6)' : 'transparent',
                  color: tab === key ? '#fff' : 'var(--text-muted)',
                  transition: 'all 0.2s',
                }}>{label}</button>
              ))}
            </div>

            {/* TAB: Overview */}
            {tab === 'overview' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
                {/* By Direction */}
                <div style={{ padding: '16px 18px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 14 }}>▲▼ By Direction</div>
                  {Object.entries(result.by_direction || {}).map(([dir, s]: any) => (
                    <div key={dir} style={{ marginBottom: 14 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ fontSize: 11, color: dir === 'BULLISH' ? '#10b981' : '#f87171', fontWeight: 700 }}>
                          {dir === 'BULLISH' ? '▲' : '▼'} {dir}
                        </span>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{s.closed} closed</span>
                      </div>
                      <WinBar wr={s.wr} label="" />
                      <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>EV: {s.ev >= 0 ? '+' : ''}{s.ev}R · {s.wins}W/{s.losses}L</div>
                    </div>
                  ))}
                </div>

                {/* By Wyckoff */}
                <div style={{ padding: '16px 18px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 14 }}>🌊 By Wyckoff Phase</div>
                  {Object.entries(result.by_wyckoff || {})
                    .sort((a: any, b: any) => b[1].wr - a[1].wr)
                    .slice(0, 6)
                    .map(([ph, s]: any) => (
                      <div key={ph} style={{ marginBottom: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                          <span style={{ fontSize: 10, color: 'var(--text-primary)' }}>{ph}</span>
                          <span style={{ fontSize: 10, fontWeight: 700, color: s.wr >= 65 ? '#10b981' : s.wr >= 50 ? '#f59e0b' : '#f87171' }}>{s.wr}% ({s.closed})</span>
                        </div>
                        <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ width: `${s.wr}%`, height: '100%', background: s.wr >= 65 ? '#10b981' : s.wr >= 50 ? '#f59e0b' : '#f87171', borderRadius: 2 }} />
                        </div>
                      </div>
                    ))}
                </div>

                {/* By SMC + Conviction */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={{ padding: '16px 18px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 14 }}>🎯 By SMC Setup</div>
                    {Object.entries(result.by_smc || {}).map(([key, s]: any) => (
                      <div key={key} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 11 }}>
                        <span style={{ color: 'var(--text-muted)' }}>{key}</span>
                        <span style={{ fontWeight: 800, color: s.wr >= 65 ? '#10b981' : s.wr >= 50 ? '#f59e0b' : '#f87171' }}>{s.wr}% <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({s.closed})</span></span>
                      </div>
                    ))}
                  </div>
                  <div style={{ padding: '16px 18px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 14 }}>💡 By Conviction</div>
                    {Object.entries(result.by_conviction || {}).map(([key, s]: any) => (
                      <div key={key} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 11 }}>
                        <span style={{ color: 'var(--text-muted)' }}>{key}</span>
                        <span style={{ fontWeight: 800, color: s.wr >= 65 ? '#10b981' : s.wr >= 50 ? '#f59e0b' : '#f87171' }}>{s.wr}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* TAB: By Pattern */}
            {tab === 'pattern' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
                {Object.entries(result.by_pattern || {}).map(([pt, s]: any) => {
                  const col = s.wr >= 65 ? '#10b981' : s.wr >= 50 ? '#f59e0b' : '#f87171';
                  return (
                    <div key={pt} style={{ padding: '16px 18px', background: 'var(--bg-secondary)', border: `1px solid ${col}30`, borderRadius: 14, borderTop: `3px solid ${col}` }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <span style={{ fontSize: 14, fontWeight: 900, color: 'var(--text-primary)' }}>{pt}</span>
                        <span style={{ fontSize: 22, fontWeight: 900, color: col }}>{s.wr}%</span>
                      </div>
                      <div style={{ height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden', marginBottom: 12 }}>
                        <div style={{ width: `${s.wr}%`, height: '100%', background: col, borderRadius: 3 }} />
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                        {[
                          ['Total', s.total],
                          ['Closed', s.closed],
                          ['Win', s.wins],
                          ['Loss', s.losses],
                          ['Expired', s.expired],
                          ['EV', `${s.ev >= 0 ? '+' : ''}${s.ev}R`],
                        ].map(([l, v]) => (
                          <div key={l as string} style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                            {l}: <strong style={{ color: 'var(--text-primary)' }}>{v}</strong>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* TAB: Signals */}
            {tab === 'signals' && (
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
                  Menampilkan {Math.min(result.signals?.length || 0, 100)} dari {result.signals?.length || 0} signals
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        {['Ticker','Date','Pattern','Dir','Wyckoff','Score','SMC','R:R','Outcome','P&L (R)'].map(h => (
                          <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 700, fontSize: 10, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(result.signals || []).slice(0, 100).map((s: any, i: number) => {
                        const isWin = s.outcome?.startsWith('WIN');
                        const isLoss = s.outcome === 'LOSS';
                        return (
                          <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                            <td style={{ padding: '7px 10px', fontWeight: 800, color: 'var(--text-primary)' }}>{s.ticker}</td>
                            <td style={{ padding: '7px 10px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{s.date?.slice(0, 10)}</td>
                            <td style={{ padding: '7px 10px' }}>
                              <span style={{ padding: '1px 6px', borderRadius: 4, background: 'rgba(167,139,250,0.12)', color: '#a78bfa', fontSize: 9, fontWeight: 700 }}>{s.pattern_type}</span>
                            </td>
                            <td style={{ padding: '7px 10px', color: s.direction === 'BULLISH' ? '#10b981' : '#f87171', fontWeight: 700 }}>
                              {s.direction === 'BULLISH' ? '▲' : '▼'} {s.direction?.slice(0, 4)}
                            </td>
                            <td style={{ padding: '7px 10px', color: 'var(--text-muted)', fontSize: 10 }}>{s.wyckoff_phase}</td>
                            <td style={{ padding: '7px 10px', fontWeight: 800, color: s.conviction >= 70 ? '#10b981' : s.conviction >= 55 ? '#f59e0b' : '#94a3b8' }}>{s.conviction}</td>
                            <td style={{ padding: '7px 10px', fontSize: 9 }}>
                              {[s.in_order_block && 'OB', s.in_fvg && 'FVG', s.liquidity_sweep && 'Sweep'].filter(Boolean).map((tag: any) => (
                                <span key={tag} style={{ marginRight: 3, padding: '1px 4px', borderRadius: 3, background: 'rgba(245,158,11,0.12)', color: '#f59e0b' }}>{tag}</span>
                              ))}
                            </td>
                            <td style={{ padding: '7px 10px', color: 'var(--text-muted)' }}>1:{Number(s.risk_reward || 0).toFixed(1)}</td>
                            <td style={{ padding: '7px 10px' }}>
                              <span style={{ padding: '2px 7px', borderRadius: 5, fontSize: 9, fontWeight: 800,
                                background: isWin ? 'rgba(16,185,129,0.12)' : isLoss ? 'rgba(248,113,113,0.12)' : 'rgba(148,163,184,0.12)',
                                color: isWin ? '#10b981' : isLoss ? '#f87171' : '#94a3b8' }}>
                                {s.outcome}
                              </span>
                            </td>
                            <td style={{ padding: '7px 10px', fontWeight: 800, color: isWin ? '#10b981' : isLoss ? '#f87171' : '#94a3b8' }}>
                              {s.pnlR >= 0 ? '+' : ''}{s.pnlR}R
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </main>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
      `}</style>
    </>
  );
}
