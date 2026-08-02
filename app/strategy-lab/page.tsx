'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

type ConditionType =
  | 'broker_net_lot_gt'
  | 'broker_net_lot_lt'
  | 'price_change_gt'
  | 'price_change_lt'
  | 'volume_gt';

type Timeframe = '1W' | '1M' | '3M';
type Logic = 'AND' | 'OR';

interface Condition {
  id: string;
  type: ConditionType;
  value: number;
  brokerCode?: string;
  timeframe: Timeframe;
}

interface Strategy {
  id: string;
  name: string;
  conditions: Condition[];
  logic: Logic;
  createdAt: string;
  signalCount?: number;
}

interface SignalScannerItem {
  ticker: string;
  broker_code: string;
  net_lot: number;
  signal: string;
  price?: number;
  price_change_pct?: number;
  volume?: number;
}

interface BacktestResult {
  ticker: string;
  matchedConditions: number;
  signal: 'BUY' | 'SELL' | 'WATCH';
  broker_code?: string;
  net_lot?: number;
  price_change_pct?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CONDITION_LABELS: Record<ConditionType, string> = {
  broker_net_lot_gt: 'Broker Net Lot >',
  broker_net_lot_lt: 'Broker Net Lot <',
  price_change_gt: 'Price Change % >',
  price_change_lt: 'Price Change % <',
  volume_gt: 'Volume >',
};

const CONDITION_COLORS: Record<ConditionType, { bg: string; border: string; text: string }> = {
  broker_net_lot_gt: { bg: 'rgba(63,185,80,0.15)', border: '#3fb950', text: '#3fb950' },
  broker_net_lot_lt: { bg: 'rgba(248,81,73,0.15)', border: '#f85149', text: '#f85149' },
  price_change_gt: { bg: 'rgba(227,179,65,0.15)', border: '#e3b341', text: '#e3b341' },
  price_change_lt: { bg: 'rgba(248,81,73,0.15)', border: '#f85149', text: '#f85149' },
  volume_gt: { bg: 'rgba(88,166,255,0.15)', border: '#58a6ff', text: '#58a6ff' },
};

const CONDITION_ICONS: Record<ConditionType, string> = {
  broker_net_lot_gt: '📈',
  broker_net_lot_lt: '📉',
  price_change_gt: '🚀',
  price_change_lt: '⬇️',
  volume_gt: '🔊',
};

const DEFAULT_VALUES: Record<ConditionType, number> = {
  broker_net_lot_gt: 100,
  broker_net_lot_lt: 100,
  price_change_gt: 2,
  price_change_lt: 2,
  volume_gt: 1000000,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateId(): string {
  return Math.random().toString(36).slice(2, 9);
}

function formatNumber(n: number): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function conditionLabel(c: Condition): string {
  const base = CONDITION_LABELS[c.type];
  const val = formatNumber(c.value);
  if (c.type === 'broker_net_lot_gt' || c.type === 'broker_net_lot_lt') {
    const broker = c.brokerCode ? ` [${c.brokerCode}]` : '';
    const sign = c.type === 'broker_net_lot_lt' ? '-' : '';
    return `${base} ${sign}${val} lot${broker} (${c.timeframe})`;
  }
  if (c.type === 'price_change_gt' || c.type === 'price_change_lt') {
    return `${base} ${val}% (${c.timeframe})`;
  }
  return `${base} ${val} (${c.timeframe})`;
}

function loadStrategies(): Strategy[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem('flowtracker_strategies') || '[]');
  } catch {
    return [];
  }
}

function saveStrategies(strategies: Strategy[]): void {
  localStorage.setItem('flowtracker_strategies', JSON.stringify(strategies));
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ConditionPill({
  condition,
  onRemove,
  index,
}: {
  condition: Condition;
  onRemove: () => void;
  index: number;
}) {
  const color = CONDITION_COLORS[condition.type];
  const icon = CONDITION_ICONS[condition.type];

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 14px',
        borderRadius: '12px',
        border: `1px solid ${color.border}`,
        background: color.bg,
        backdropFilter: 'blur(8px)',
        animation: 'slideIn 0.3s ease',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `radial-gradient(ellipse at left, ${color.bg} 0%, transparent 70%)`,
          pointerEvents: 'none',
        }}
      />
      <span style={{ fontSize: '18px', zIndex: 1 }}>{icon}</span>
      <span
        style={{
          fontSize: '13px',
          fontWeight: 600,
          color: color.text,
          fontFamily: 'monospace',
          zIndex: 1,
        }}
      >
        {conditionLabel(condition)}
      </span>
      <button
        onClick={onRemove}
        style={{
          marginLeft: 'auto',
          background: 'rgba(248,81,73,0.2)',
          border: '1px solid rgba(248,81,73,0.4)',
          borderRadius: '6px',
          color: '#f85149',
          cursor: 'pointer',
          padding: '2px 8px',
          fontSize: '12px',
          fontWeight: 700,
          zIndex: 1,
          transition: 'all 0.2s',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = 'rgba(248,81,73,0.4)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = 'rgba(248,81,73,0.2)';
        }}
      >
        ✕
      </button>
    </div>
  );
}

function LogicToggle({ value, onChange }: { value: Logic; onChange: (v: Logic) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center' }}>
      <div
        style={{
          display: 'flex',
          background: '#0d1117',
          borderRadius: '8px',
          border: '1px solid #21262d',
          padding: '2px',
          gap: '2px',
        }}
      >
        {(['AND', 'OR'] as Logic[]).map((opt) => (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            style={{
              padding: '4px 16px',
              borderRadius: '6px',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 700,
              fontSize: '11px',
              letterSpacing: '0.05em',
              transition: 'all 0.2s',
              background: value === opt
                ? opt === 'AND'
                  ? 'linear-gradient(135deg, #3fb950, #2ea043)'
                  : 'linear-gradient(135deg, #58a6ff, #1f6feb)'
                : 'transparent',
              color: value === opt ? '#fff' : '#8b949e',
            }}
          >
            {opt}
          </button>
        ))}
      </div>
      <span style={{ fontSize: '12px', color: '#8b949e' }}>
        {value === 'AND' ? 'All conditions must match' : 'Any condition must match'}
      </span>
    </div>
  );
}

function StatCard({ label, value, color, icon }: { label: string; value: string | number; color?: string; icon?: string }) {
  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid #21262d',
        borderRadius: '12px',
        padding: '16px',
        textAlign: 'center',
        flex: 1,
        minWidth: '120px',
      }}
    >
      {icon && <div style={{ fontSize: '24px', marginBottom: '6px' }}>{icon}</div>}
      <div style={{ fontSize: '24px', fontWeight: 700, color: color || '#e6edf3' }}>{value}</div>
      <div style={{ fontSize: '12px', color: '#8b949e', marginTop: '4px' }}>{label}</div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function StrategyLabPage() {
  const [strategyName, setStrategyName] = useState('My Strategy');
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [logic, setLogic] = useState<Logic>('AND');
  const [newCondType, setNewCondType] = useState<ConditionType>('broker_net_lot_gt');
  const [newCondValue, setNewCondValue] = useState<number>(100);
  const [newCondBroker, setNewCondBroker] = useState('');
  const [newCondTimeframe, setNewCondTimeframe] = useState<Timeframe>('1M');

  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [activeStrategyId, setActiveStrategyId] = useState<string | null>(null);

  const [scannerData, setScannerData] = useState<SignalScannerItem[]>([]);
  const [backtestResults, setBacktestResults] = useState<BacktestResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<'builder' | 'signals' | 'backtest'>('builder');
  const [nameEditing, setNameEditing] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setStrategies(loadStrategies()); }, []);
  useEffect(() => { setNewCondValue(DEFAULT_VALUES[newCondType]); }, [newCondType]);
  useEffect(() => { fetchScannerData(); }, []);

  const fetchScannerData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/signal-scanner');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setScannerData(Array.isArray(data) ? data : data.data || []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  };

  const addCondition = () => {
    if (newCondValue <= 0) return;
    const newCond: Condition = {
      id: generateId(),
      type: newCondType,
      value: newCondValue,
      brokerCode: ['broker_net_lot_gt', 'broker_net_lot_lt'].includes(newCondType) ? newCondBroker || undefined : undefined,
      timeframe: newCondTimeframe,
    };
    setConditions((prev) => [...prev, newCond]);
  };

  const removeCondition = (id: string) => setConditions((prev) => prev.filter((c) => c.id !== id));

  const runBacktest = useCallback(async () => {
    if (conditions.length === 0) return;
    setScanning(true);
    setError(null);
    try {
      const results: BacktestResult[] = [];
      const seenTickers = new Set<string>();
      const byTicker: Record<string, SignalScannerItem[]> = {};
      for (const item of scannerData) {
        if (!byTicker[item.ticker]) byTicker[item.ticker] = [];
        byTicker[item.ticker].push(item);
      }
      for (const ticker of Object.keys(byTicker)) {
        if (seenTickers.has(ticker)) continue;
        const items = byTicker[ticker];
        let matchCount = 0;
        for (const cond of conditions) {
          let matched = false;
          if (cond.type === 'broker_net_lot_gt') {
            const relevant = cond.brokerCode ? items.filter((i) => i.broker_code === cond.brokerCode) : items;
            matched = relevant.reduce((s, i) => s + (i.net_lot || 0), 0) > cond.value;
          } else if (cond.type === 'broker_net_lot_lt') {
            const relevant = cond.brokerCode ? items.filter((i) => i.broker_code === cond.brokerCode) : items;
            matched = relevant.reduce((s, i) => s + (i.net_lot || 0), 0) < -cond.value;
          } else if (cond.type === 'price_change_gt') {
            matched = (items[0]?.price_change_pct ?? 0) > cond.value;
          } else if (cond.type === 'price_change_lt') {
            matched = (items[0]?.price_change_pct ?? 0) < -cond.value;
          } else if (cond.type === 'volume_gt') {
            matched = (items[0]?.volume ?? 0) > cond.value;
          }
          if (matched) matchCount++;
        }
        const passes = logic === 'AND' ? matchCount === conditions.length : matchCount > 0;
        if (passes) {
          const netLot = items.reduce((s, i) => s + (i.net_lot || 0), 0);
          seenTickers.add(ticker);
          results.push({
            ticker,
            matchedConditions: matchCount,
            signal: netLot > 0 ? 'BUY' : netLot < 0 ? 'SELL' : 'WATCH',
            broker_code: items[0]?.broker_code,
            net_lot: netLot,
            price_change_pct: items[0]?.price_change_pct,
          });
        }
      }
      results.sort((a, b) => b.matchedConditions - a.matchedConditions || Math.abs(b.net_lot || 0) - Math.abs(a.net_lot || 0));
      setBacktestResults(results);
      setTab('signals');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Backtest failed');
    } finally {
      setScanning(false);
    }
  }, [conditions, logic, scannerData]);

  const saveStrategy = () => {
    const strat: Strategy = {
      id: activeStrategyId || generateId(),
      name: strategyName,
      conditions,
      logic,
      createdAt: new Date().toISOString(),
      signalCount: backtestResults.length,
    };
    const updated = [strat, ...strategies.filter((s) => s.id !== strat.id)];
    setStrategies(updated);
    saveStrategies(updated);
    setActiveStrategyId(strat.id);
  };

  const loadStrategy = (s: Strategy) => {
    setStrategyName(s.name);
    setConditions(s.conditions);
    setLogic(s.logic);
    setActiveStrategyId(s.id);
    setBacktestResults([]);
    setTab('builder');
  };

  const deleteStrategy = (id: string) => {
    const updated = strategies.filter((s) => s.id !== id);
    setStrategies(updated);
    saveStrategies(updated);
    if (activeStrategyId === id) { setActiveStrategyId(null); setConditions([]); setStrategyName('My Strategy'); }
  };

  const newStrategy = () => {
    setStrategyName('My Strategy'); setConditions([]); setLogic('AND');
    setActiveStrategyId(null); setBacktestResults([]); setTab('builder');
  };

  const buySignals = backtestResults.filter((r) => r.signal === 'BUY');
  const sellSignals = backtestResults.filter((r) => r.signal === 'SELL');
  const watchSignals = backtestResults.filter((r) => r.signal === 'WATCH');
  const uniqueTickers = new Set(scannerData.map((d) => d.ticker)).size;

  return (
    <div style={{ minHeight: '100vh', background: '#0d1117', fontFamily: 'system-ui,-apple-system,sans-serif', color: '#e6edf3' }}>
      <style>{`
        @keyframes slideIn { from{opacity:0;transform:translateY(-8px)} to{opacity:1;transform:translateY(0)} }
        @keyframes fadeIn { from{opacity:0} to{opacity:1} }
        @keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        .strat-item:hover { background:rgba(255,255,255,0.06)!important; border-color:#30363d!important; }
        .sig-row:hover { background:rgba(255,255,255,0.04)!important; }
        .pill-btn:hover { filter:brightness(1.15); }
      `}</style>

      {/* ── Header ── */}
      <div style={{ borderBottom:'1px solid #21262d', background:'rgba(22,27,34,0.95)', backdropFilter:'blur(12px)', position:'sticky', top:0, zIndex:100, padding:'0 24px' }}>
        <div style={{ maxWidth:'1400px', margin:'0 auto', display:'flex', alignItems:'center', justifyContent:'space-between', height:'64px' }}>
          <div style={{ display:'flex', alignItems:'center', gap:'12px' }}>
            <div style={{ width:'38px', height:'38px', borderRadius:'10px', background:'linear-gradient(135deg,#3fb950,#58a6ff)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'20px' }}>🧪</div>
            <div>
              <div style={{ fontSize:'18px', fontWeight:700 }}>Strategy Lab</div>
              <div style={{ fontSize:'12px', color:'#8b949e' }}>No-code signal strategy builder</div>
            </div>
          </div>
          <div style={{ display:'flex', gap:'8px', alignItems:'center' }}>
            {loading && (
              <span style={{ fontSize:'12px', color:'#8b949e', display:'flex', alignItems:'center', gap:'6px' }}>
                <span style={{ width:'12px', height:'12px', border:'2px solid #58a6ff', borderTopColor:'transparent', borderRadius:'50%', animation:'spin 0.8s linear infinite', display:'inline-block' }} />
                Loading…
              </span>
            )}
            <button onClick={fetchScannerData} style={{ padding:'6px 14px', background:'rgba(88,166,255,0.1)', border:'1px solid rgba(88,166,255,0.3)', borderRadius:'8px', color:'#58a6ff', cursor:'pointer', fontSize:'13px', fontWeight:600 }}>↻ Refresh</button>
            <button onClick={newStrategy} style={{ padding:'6px 14px', background:'linear-gradient(135deg,#3fb950,#2ea043)', border:'none', borderRadius:'8px', color:'#fff', cursor:'pointer', fontSize:'13px', fontWeight:600 }}>+ New Strategy</button>
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ maxWidth:'1400px', margin:'0 auto', padding:'24px', display:'grid', gridTemplateColumns:'280px 1fr', gap:'24px' }}>

        {/* ── Left Sidebar ── */}
        <div style={{ display:'flex', flexDirection:'column', gap:'16px' }}>

          {/* Saved Strategies */}
          <div style={{ background:'#161b22', border:'1px solid #21262d', borderRadius:'16px', overflow:'hidden' }}>
            <div style={{ padding:'16px 20px', borderBottom:'1px solid #21262d', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <span style={{ fontSize:'14px', fontWeight:700 }}>📁 Saved Strategies</span>
              <span style={{ background:'rgba(88,166,255,0.15)', color:'#58a6ff', fontSize:'11px', fontWeight:700, padding:'2px 8px', borderRadius:'99px', border:'1px solid rgba(88,166,255,0.3)' }}>{strategies.length}</span>
            </div>
            {strategies.length === 0 ? (
              <div style={{ padding:'32px 20px', textAlign:'center' }}>
                <div style={{ fontSize:'32px', marginBottom:'8px' }}>🗂️</div>
                <p style={{ fontSize:'13px', color:'#8b949e', margin:0 }}>No saved strategies yet.<br/>Build one and save it!</p>
              </div>
            ) : (
              <div style={{ maxHeight:'400px', overflowY:'auto' }}>
                {strategies.map((s) => (
                  <div key={s.id} className="strat-item" onClick={() => loadStrategy(s)}
                    style={{ padding:'14px 20px', borderBottom:'1px solid #21262d', cursor:'pointer', background:activeStrategyId===s.id?'rgba(63,185,80,0.08)':'transparent', borderLeft:activeStrategyId===s.id?'3px solid #3fb950':'3px solid transparent', transition:'all 0.2s' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:'13px', fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginBottom:'4px' }}>{s.name}</div>
                        <div style={{ display:'flex', gap:'6px', flexWrap:'wrap' }}>
                          <span style={{ fontSize:'10px', color:s.logic==='AND'?'#3fb950':'#58a6ff', background:s.logic==='AND'?'rgba(63,185,80,0.1)':'rgba(88,166,255,0.1)', padding:'1px 6px', borderRadius:'4px', fontWeight:700 }}>{s.logic}</span>
                          <span style={{ fontSize:'11px', color:'#8b949e' }}>{s.conditions.length} rule{s.conditions.length!==1?'s':''}</span>
                          {s.signalCount !== undefined && <span style={{ fontSize:'11px', color:'#e3b341' }}>{s.signalCount} signals</span>}
                        </div>
                      </div>
                      <button onClick={(e)=>{e.stopPropagation();deleteStrategy(s.id);}} style={{ background:'none', border:'none', color:'#8b949e', cursor:'pointer', fontSize:'14px', padding:'2px 4px', marginLeft:'8px' }}>🗑️</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Data Status */}
          <div style={{ background:'#161b22', border:'1px solid #21262d', borderRadius:'16px', padding:'16px 20px' }}>
            <div style={{ fontSize:'11px', color:'#8b949e', marginBottom:'12px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.08em' }}>Data Status</div>
            {[
              { label:'Scanner records', value:scannerData.length, color:'#e6edf3' },
              { label:'Unique tickers', value:uniqueTickers, color:'#e6edf3' },
              { label:'Active conditions', value:conditions.length, color:conditions.length>0?'#3fb950':'#8b949e' },
              { label:'Last backtest signals', value:backtestResults.length, color:backtestResults.length>0?'#e3b341':'#8b949e' },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ display:'flex', justifyContent:'space-between', fontSize:'13px', marginBottom:'8px' }}>
                <span style={{ color:'#8b949e' }}>{label}</span>
                <span style={{ color, fontWeight:600 }}>{value}</span>
              </div>
            ))}
            {error && <div style={{ marginTop:'10px', padding:'8px 12px', background:'rgba(248,81,73,0.1)', border:'1px solid rgba(248,81,73,0.3)', borderRadius:'8px', fontSize:'12px', color:'#f85149' }}>⚠️ {error}</div>}
          </div>
        </div>

        {/* ── Main Panel ── */}
        <div>
          <div style={{ background:'#161b22', border:'1px solid #21262d', borderRadius:'16px', overflow:'hidden' }}>

            {/* Top bar: name + actions */}
            <div style={{ padding:'16px 24px', borderBottom:'1px solid #21262d', display:'flex', alignItems:'center', justifyContent:'space-between', gap:'16px' }}>
              <div style={{ display:'flex', alignItems:'center', gap:'10px', flex:1 }}>
                {nameEditing ? (
                  <input ref={nameRef} value={strategyName} onChange={(e)=>setStrategyName(e.target.value)}
                    onBlur={()=>setNameEditing(false)} onKeyDown={(e)=>{if(e.key==='Enter')setNameEditing(false);}} autoFocus
                    style={{ background:'transparent', border:'none', borderBottom:'2px solid #3fb950', color:'#e6edf3', fontSize:'20px', fontWeight:700, outline:'none', width:'280px' }} />
                ) : (
                  <h2 onClick={()=>setNameEditing(true)} style={{ margin:0, fontSize:'20px', fontWeight:700, cursor:'pointer', padding:'2px 8px', borderRadius:'6px' }} title="Click to rename">
                    {strategyName} <span style={{ fontSize:'14px', color:'#8b949e' }}>✏️</span>
                  </h2>
                )}
                {activeStrategyId && <span style={{ fontSize:'11px', padding:'2px 8px', background:'rgba(63,185,80,0.1)', border:'1px solid rgba(63,185,80,0.3)', borderRadius:'99px', color:'#3fb950' }}>saved</span>}
              </div>
              <div style={{ display:'flex', gap:'8px' }}>
                <button onClick={saveStrategy} disabled={conditions.length===0}
                  style={{ padding:'8px 18px', background:conditions.length===0?'rgba(255,255,255,0.05)':'rgba(63,185,80,0.15)', border:`1px solid ${conditions.length===0?'#21262d':'rgba(63,185,80,0.5)'}`, borderRadius:'8px', color:conditions.length===0?'#8b949e':'#3fb950', cursor:conditions.length===0?'not-allowed':'pointer', fontSize:'13px', fontWeight:600 }}>
                  💾 Save
                </button>
                <button onClick={runBacktest} disabled={conditions.length===0||scanning||scannerData.length===0}
                  style={{ padding:'8px 18px', background:conditions.length===0||scanning?'rgba(255,255,255,0.05)':'linear-gradient(135deg,#e3b341,#d4971f)', border:'none', borderRadius:'8px', color:conditions.length===0||scanning?'#8b949e':'#0d1117', cursor:conditions.length===0||scanning?'not-allowed':'pointer', fontSize:'13px', fontWeight:700, display:'flex', alignItems:'center', gap:'6px' }}>
                  {scanning ? (<><span style={{ width:'12px', height:'12px', border:'2px solid #0d1117', borderTopColor:'transparent', borderRadius:'50%', animation:'spin 0.8s linear infinite', display:'inline-block' }}/>Scanning…</>) : '⚡ Run Backtest'}
                </button>
              </div>
            </div>

            {/* Tabs */}
            <div style={{ display:'flex', padding:'0 24px', borderBottom:'1px solid #21262d', gap:'4px' }}>
              {[
                { key:'builder', label:'🏗️ Builder', count:conditions.length },
                { key:'signals', label:'📡 Signals', count:backtestResults.length },
                { key:'backtest', label:'📊 Stats', count:null },
              ].map(({ key, label, count }) => (
                <button key={key} onClick={()=>setTab(key as typeof tab)}
                  style={{ padding:'12px 16px', background:'none', border:'none', borderBottom:tab===key?'2px solid #3fb950':'2px solid transparent', color:tab===key?'#3fb950':'#8b949e', cursor:'pointer', fontSize:'13px', fontWeight:tab===key?700:400, display:'flex', alignItems:'center', gap:'6px', transition:'all 0.2s' }}>
                  {label}
                  {count!==null && count>0 && <span style={{ background:tab===key?'rgba(63,185,80,0.2)':'rgba(255,255,255,0.08)', color:tab===key?'#3fb950':'#8b949e', fontSize:'10px', fontWeight:700, padding:'1px 6px', borderRadius:'99px' }}>{count}</span>}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div style={{ padding:'24px' }}>

              {/* ── BUILDER TAB ── */}
              {tab === 'builder' && (
                <div style={{ display:'flex', flexDirection:'column', gap:'24px', animation:'fadeIn 0.3s ease' }}>

                  {/* Logic */}
                  <div>
                    <div style={{ fontSize:'11px', color:'#8b949e', marginBottom:'10px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.08em' }}>Combine Rules With</div>
                    <LogicToggle value={logic} onChange={setLogic} />
                  </div>

                  {/* Active conditions */}
                  <div>
                    <div style={{ fontSize:'11px', color:'#8b949e', marginBottom:'12px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.08em', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                      <span>Active Conditions</span>
                      {conditions.length > 0 && <button onClick={()=>setConditions([])} style={{ background:'none', border:'none', color:'#f85149', cursor:'pointer', fontSize:'11px' }}>Clear all</button>}
                    </div>
                    {conditions.length === 0 ? (
                      <div style={{ border:'2px dashed #21262d', borderRadius:'12px', padding:'32px', textAlign:'center', color:'#8b949e' }}>
                        <div style={{ fontSize:'28px', marginBottom:'8px' }}>🎯</div>
                        <p style={{ margin:0, fontSize:'14px' }}>No conditions yet.</p>
                        <p style={{ margin:'4px 0 0', fontSize:'12px' }}>Add conditions below to build your strategy.</p>
                      </div>
                    ) : (
                      <div style={{ display:'flex', flexDirection:'column', gap:'8px' }}>
                        {conditions.map((cond, idx) => (
                          <div key={cond.id}>
                            {idx > 0 && (
                              <div style={{ textAlign:'center', fontSize:'11px', fontWeight:700, color:logic==='AND'?'#3fb950':'#58a6ff', letterSpacing:'0.1em', padding:'4px' }}>{logic}</div>
                            )}
                            <ConditionPill condition={cond} onRemove={()=>removeCondition(cond.id)} index={idx} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Add condition panel */}
                  <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid #21262d', borderRadius:'16px', padding:'20px' }}>
                    <div style={{ fontSize:'13px', fontWeight:700, marginBottom:'16px' }}>➕ Add New Condition</div>

                    {/* Type buttons */}
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))', gap:'8px', marginBottom:'16px' }}>
                      {(Object.keys(CONDITION_LABELS) as ConditionType[]).map((type) => {
                        const color = CONDITION_COLORS[type];
                        const sel = newCondType === type;
                        return (
                          <button key={type} onClick={()=>setNewCondType(type)}
                            style={{ padding:'10px 12px', borderRadius:'10px', border:`1px solid ${sel?color.border:'#30363d'}`, background:sel?color.bg:'transparent', color:sel?color.text:'#8b949e', cursor:'pointer', fontSize:'12px', fontWeight:sel?700:400, textAlign:'left', display:'flex', alignItems:'center', gap:'8px', transition:'all 0.2s' }}>
                            <span>{CONDITION_ICONS[type]}</span>
                            <span>{CONDITION_LABELS[type]}</span>
                          </button>
                        );
                      })}
                    </div>

                    {/* Inputs row */}
                    <div style={{ display:'flex', gap:'12px', flexWrap:'wrap', alignItems:'flex-end' }}>
                      <div style={{ flex:'0 0 160px' }}>
                        <label style={{ display:'block', fontSize:'11px', color:'#8b949e', marginBottom:'6px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.05em' }}>
                          {newCondType==='price_change_gt'||newCondType==='price_change_lt'?'Threshold %':newCondType==='volume_gt'?'Min Volume':'Net Lot Threshold'}
                        </label>
                        <input type="number" value={newCondValue} min={1} onChange={(e)=>setNewCondValue(parseFloat(e.target.value)||0)}
                          style={{ width:'100%', background:'#0d1117', border:'1px solid #30363d', borderRadius:'8px', color:'#e6edf3', padding:'8px 12px', fontSize:'14px', outline:'none', boxSizing:'border-box' }} />
                      </div>

                      {(newCondType==='broker_net_lot_gt'||newCondType==='broker_net_lot_lt') && (
                        <div style={{ flex:'0 0 130px' }}>
                          <label style={{ display:'block', fontSize:'11px', color:'#8b949e', marginBottom:'6px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.05em' }}>Broker (opt.)</label>
                          <input type="text" value={newCondBroker} onChange={(e)=>setNewCondBroker(e.target.value.toUpperCase())} placeholder="e.g. YP" maxLength={6}
                            style={{ width:'100%', background:'#0d1117', border:'1px solid #30363d', borderRadius:'8px', color:'#e6edf3', padding:'8px 12px', fontSize:'14px', outline:'none', boxSizing:'border-box' }} />
                        </div>
                      )}

                      <div style={{ flex:'0 0 140px' }}>
                        <label style={{ display:'block', fontSize:'11px', color:'#8b949e', marginBottom:'6px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.05em' }}>Timeframe</label>
                        <div style={{ display:'flex', gap:'4px' }}>
                          {(['1W','1M','3M'] as Timeframe[]).map((tf) => (
                            <button key={tf} onClick={()=>setNewCondTimeframe(tf)}
                              style={{ flex:1, padding:'8px 4px', borderRadius:'8px', border:`1px solid ${newCondTimeframe===tf?'#58a6ff':'#30363d'}`, background:newCondTimeframe===tf?'rgba(88,166,255,0.15)':'transparent', color:newCondTimeframe===tf?'#58a6ff':'#8b949e', cursor:'pointer', fontSize:'12px', fontWeight:newCondTimeframe===tf?700:400, transition:'all 0.2s' }}>
                              {tf}
                            </button>
                          ))}
                        </div>
                      </div>

                      <button onClick={addCondition}
                        style={{ padding:'9px 20px', background:'linear-gradient(135deg,#58a6ff,#1f6feb)', border:'none', borderRadius:'8px', color:'#fff', cursor:'pointer', fontSize:'14px', fontWeight:700, alignSelf:'flex-end', whiteSpace:'nowrap' }}>
                        Add Condition
                      </button>
                    </div>
                  </div>

                  {/* Strategy preview */}
                  {conditions.length > 0 && (
                    <div style={{ background:'linear-gradient(135deg,rgba(63,185,80,0.05),rgba(88,166,255,0.05))', border:'1px solid rgba(63,185,80,0.2)', borderRadius:'16px', padding:'16px 20px' }}>
                      <div style={{ fontSize:'12px', color:'#8b949e', marginBottom:'8px', fontWeight:700 }}>📋 Strategy Preview</div>
                      <p style={{ margin:0, fontSize:'14px', lineHeight:1.6 }}>
                        Signal when{' '}
                        <strong style={{ color:logic==='AND'?'#3fb950':'#58a6ff' }}>{logic==='AND'?'ALL':'ANY'}</strong>
                        {' '}of these conditions are met:{' '}
                        {conditions.map((c, i) => (
                          <span key={c.id}>
                            {i > 0 && <span style={{ color:logic==='AND'?'#3fb950':'#58a6ff' }}> {logic} </span>}
                            <span style={{ background:CONDITION_COLORS[c.type].bg, color:CONDITION_COLORS[c.type].text, padding:'1px 6px', borderRadius:'4px', fontSize:'12px', fontFamily:'monospace' }}>
                              {conditionLabel(c)}
                            </span>
                          </span>
                        ))}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* ── SIGNALS TAB ── */}
              {tab === 'signals' && (
                <div style={{ animation:'fadeIn 0.3s ease' }}>
                  {backtestResults.length === 0 ? (
                    <div style={{ textAlign:'center', padding:'48px 24px' }}>
                      <div style={{ fontSize:'48px', marginBottom:'12px' }}>📡</div>
                      <h3 style={{ margin:'0 0 8px' }}>No signals yet</h3>
                      <p style={{ color:'#8b949e', fontSize:'14px' }}>Build conditions, then click ⚡ Run Backtest</p>
                    </div>
                  ) : (
                    <>
                      <div style={{ display:'flex', gap:'12px', marginBottom:'20px', flexWrap:'wrap' }}>
                        <StatCard label="Total Signals" value={backtestResults.length} icon="📡" />
                        <StatCard label="BUY" value={buySignals.length} color="#3fb950" icon="📈" />
                        <StatCard label="SELL" value={sellSignals.length} color="#f85149" icon="📉" />
                        <StatCard label="WATCH" value={watchSignals.length} color="#e3b341" icon="👁️" />
                      </div>
                      <div style={{ overflowX:'auto' }}>
                        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'13px' }}>
                          <thead>
                            <tr style={{ borderBottom:'1px solid #21262d' }}>
                              {['Ticker','Signal','Net Lot','Price Chg%','Broker','Conditions'].map((h) => (
                                <th key={h} style={{ padding:'8px 12px', textAlign:'left', color:'#8b949e', fontWeight:700, fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', whiteSpace:'nowrap' }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {backtestResults.map((r) => (
                              <tr key={r.ticker} className="sig-row" style={{ borderBottom:'1px solid rgba(33,38,45,0.5)', transition:'background 0.15s' }}>
                                <td style={{ padding:'10px 12px', fontWeight:700, color:'#58a6ff', fontFamily:'monospace' }}>{r.ticker}</td>
                                <td style={{ padding:'10px 12px' }}>
                                  <span style={{ padding:'3px 10px', borderRadius:'99px', fontSize:'11px', fontWeight:700,
                                    background:r.signal==='BUY'?'rgba(63,185,80,0.15)':r.signal==='SELL'?'rgba(248,81,73,0.15)':'rgba(227,179,65,0.15)',
                                    color:r.signal==='BUY'?'#3fb950':r.signal==='SELL'?'#f85149':'#e3b341',
                                    border:`1px solid ${r.signal==='BUY'?'rgba(63,185,80,0.3)':r.signal==='SELL'?'rgba(248,81,73,0.3)':'rgba(227,179,65,0.3)'}` }}>
                                    {r.signal==='BUY'?'▲ ':r.signal==='SELL'?'▼ ':'● '}{r.signal}
                                  </span>
                                </td>
                                <td style={{ padding:'10px 12px', fontFamily:'monospace', color:(r.net_lot??0)>=0?'#3fb950':'#f85149' }}>
                                  {r.net_lot!==undefined?(r.net_lot>=0?'+':'')+formatNumber(r.net_lot):'—'}
                                </td>
                                <td style={{ padding:'10px 12px', fontFamily:'monospace', color:(r.price_change_pct??0)>=0?'#3fb950':'#f85149' }}>
                                  {r.price_change_pct!==undefined?(r.price_change_pct>=0?'+':'')+r.price_change_pct.toFixed(2)+'%':'—'}
                                </td>
                                <td style={{ padding:'10px 12px', color:'#8b949e', fontFamily:'monospace', fontSize:'12px' }}>{r.broker_code||'—'}</td>
                                <td style={{ padding:'10px 12px' }}>
                                  <div style={{ display:'flex', alignItems:'center', gap:'3px' }}>
                                    {Array.from({length:conditions.length}).map((_,i)=>(
                                      <div key={i} style={{ width:'8px', height:'8px', borderRadius:'50%', background:i<r.matchedConditions?'#3fb950':'#30363d' }} />
                                    ))}
                                    <span style={{ fontSize:'11px', color:'#8b949e', marginLeft:'4px' }}>{r.matchedConditions}/{conditions.length}</span>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* ── BACKTEST STATS TAB ── */}
              {tab === 'backtest' && (
                <div style={{ animation:'fadeIn 0.3s ease' }}>
                  {backtestResults.length === 0 ? (
                    <div style={{ textAlign:'center', padding:'48px 24px' }}>
                      <div style={{ fontSize:'48px', marginBottom:'12px' }}>📊</div>
                      <h3 style={{ margin:'0 0 8px' }}>No backtest data</h3>
                      <p style={{ color:'#8b949e', fontSize:'14px' }}>Run a backtest to see stats here</p>
                    </div>
                  ) : (
                    <div style={{ display:'flex', flexDirection:'column', gap:'20px' }}>
                      <div style={{ display:'flex', gap:'12px', flexWrap:'wrap' }}>
                        <StatCard label="Signal Hit Rate" value={`${Math.round((backtestResults.length/Math.max(uniqueTickers,1))*100)}%`} color="#e3b341" icon="🎯" />
                        <StatCard label="Tickers Scanned" value={uniqueTickers} icon="🔍" />
                        <StatCard label="BUY Ratio" value={`${backtestResults.length>0?Math.round((buySignals.length/backtestResults.length)*100):0}%`} color="#3fb950" icon="📈" />
                        <StatCard label="SELL Ratio" value={`${backtestResults.length>0?Math.round((sellSignals.length/backtestResults.length)*100):0}%`} color="#f85149" icon="📉" />
                      </div>

                      {/* Config */}
                      <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid #21262d', borderRadius:'12px', padding:'16px 20px' }}>
                        <div style={{ fontSize:'13px', fontWeight:700, marginBottom:'12px' }}>Strategy Configuration</div>
                        {[['Name',strategyName,'#e6edf3'],['Logic',logic,logic==='AND'?'#3fb950':'#58a6ff'],['Conditions',String(conditions.length),'#e6edf3']].map(([k,v,c])=>(
                          <div key={k} style={{ display:'flex', justifyContent:'space-between', fontSize:'13px', marginBottom:'8px' }}>
                            <span style={{ color:'#8b949e' }}>{k}</span>
                            <span style={{ color:c, fontWeight:600 }}>{v}</span>
                          </div>
                        ))}
                      </div>

                      {/* Conditions breakdown */}
                      <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid #21262d', borderRadius:'12px', padding:'16px 20px' }}>
                        <div style={{ fontSize:'13px', fontWeight:700, marginBottom:'12px' }}>Condition Breakdown</div>
                        {conditions.map((cond, idx) => {
                          const color = CONDITION_COLORS[cond.type];
                          return (
                            <div key={cond.id} style={{ display:'flex', alignItems:'center', gap:'10px', marginBottom:'8px' }}>
                              <span style={{ color:'#8b949e', fontSize:'12px', minWidth:'20px' }}>#{idx+1}</span>
                              <div style={{ flex:1, padding:'6px 12px', borderRadius:'8px', background:color.bg, border:`1px solid ${color.border}`, fontSize:'12px', color:color.text, fontFamily:'monospace' }}>{conditionLabel(cond)}</div>
                            </div>
                          );
                        })}
                      </div>

                      {/* Top signals */}
                      <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid #21262d', borderRadius:'12px', padding:'16px 20px' }}>
                        <div style={{ fontSize:'13px', fontWeight:700, marginBottom:'12px' }}>🏆 Top Signals (by Confidence)</div>
                        {backtestResults.slice(0,10).map((r, idx) => (
                          <div key={r.ticker} style={{ display:'flex', alignItems:'center', gap:'10px', padding:'8px 0', borderBottom:idx<9?'1px solid rgba(33,38,45,0.5)':'none' }}>
                            <span style={{ fontSize:'12px', color:'#8b949e', minWidth:'24px' }}>#{idx+1}</span>
                            <span style={{ fontSize:'14px', fontWeight:700, color:'#58a6ff', fontFamily:'monospace', minWidth:'80px' }}>{r.ticker}</span>
                            <span style={{ fontSize:'11px', fontWeight:700, padding:'2px 8px', borderRadius:'99px', background:r.signal==='BUY'?'rgba(63,185,80,0.15)':r.signal==='SELL'?'rgba(248,81,73,0.15)':'rgba(227,179,65,0.15)', color:r.signal==='BUY'?'#3fb950':r.signal==='SELL'?'#f85149':'#e3b341' }}>{r.signal}</span>
                            <div style={{ flex:1 }}>
                              <div style={{ height:'4px', borderRadius:'99px', background:'#21262d', overflow:'hidden' }}>
                                <div style={{ height:'100%', width:`${(r.matchedConditions/conditions.length)*100}%`, background:r.signal==='BUY'?'#3fb950':r.signal==='SELL'?'#f85149':'#e3b341', borderRadius:'99px', transition:'width 0.6s ease' }} />
                              </div>
                            </div>
                            <span style={{ fontSize:'11px', color:'#8b949e', minWidth:'36px', textAlign:'right' }}>{r.matchedConditions}/{conditions.length}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
