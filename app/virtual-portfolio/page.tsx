'use client';

/**
 * Virtual Portfolio — the two simulated Rp100 juta accounts.
 *
 * Read-only. Everything here is written by `virtual_portfolio.js` on cron, in
 * one transaction per order; this page only shows the ledger.
 *
 * The two accounts are DELIBERATELY not comparable to anything else and only
 * barely to each other: same recommendations, different exit policy, separate
 * cash, separate execution_policy_hash. INTRADAY_EOD_100M is expected to lose,
 * and the page says so rather than presenting it as a strategy on trial.
 */

import { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { API_BASE } from '@/lib/apiConfig';

const rp = (n: number | null | undefined) =>
  n === null || n === undefined ? '–' : 'Rp ' + Math.round(Number(n)).toLocaleString('id-ID');

const pct = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined ? '–' : `${n >= 0 ? '+' : ''}${Number(n).toFixed(digits)}%`;

const EXIT_COLORS: Record<string, string> = {
  STOP: '#f85149',
  TARGET: '#3fb950',
  EOD_CLOSE: '#e3b341',
  TIME_EXIT: '#58a6ff',
  REGIME_EXIT: '#a371f7',
  MANUAL: '#8b949e',
};

const card: React.CSSProperties = {
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 18,
};

const th: React.CSSProperties = {
  textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 800,
  color: 'var(--text-muted)', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
};
const td: React.CSSProperties = {
  padding: '7px 10px', fontSize: 12, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};

export default function VirtualPortfolioPage() {
  const [data, setData] = useState<any>(null);
  const [ihsg, setIhsg] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Record<string, 'open' | 'closed' | 'orders'>>({});

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`${API_BASE}/api/virtual-portfolio`).then(r => r.json()),
      fetch(`${API_BASE}/api/ihsg`).then(r => r.json()).catch(() => null),
    ])
      .then(([vp, ih]) => {
        if (cancelled) return;
        if (vp?.error) setError(vp.error); else setData(vp);
        setIhsg(ih);
      })
      .catch(e => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const accounts: any[] = data?.accounts || [];

  // One chart with both accounts on it, aligned by mark date. They share a
  // recommendation source, so the interesting quantity is the DIFFERENCE
  // between the two curves, which separate charts would hide.
  const navChart = (() => {
    const byDate = new Map<string, any>();
    for (const a of accounts) {
      for (const p of a.navSeries || []) {
        if (!byDate.has(p.date)) byDate.set(p.date, { date: p.date });
        byDate.get(p.date)[a.account_code] = p.nav;
      }
    }
    return [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date));
  })();

  const anyTrades = accounts.some(a => (a.stats?.closed || 0) > 0 || (a.openPositions?.length || 0) > 0);

  return (
    <div style={{ padding: '22px 26px', maxWidth: 1500, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <h1 style={{ fontSize: 21, fontWeight: 900, color: 'var(--text-primary)', margin: 0 }}>
          💼 Virtual Portfolio
        </h1>
        <span style={{
          fontSize: 10, fontWeight: 800, padding: '3px 9px', borderRadius: 5,
          background: 'rgba(88,166,255,0.12)', color: '#58a6ff', border: '1px solid rgba(88,166,255,0.35)',
        }}>
          SIMULASI — tidak ada order yang dikirim ke mana pun
        </span>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, marginBottom: 18, lineHeight: 1.6, maxWidth: 900 }}>
        Dua akun Rp100 juta yang digerakkan rekomendasi sistem ini sendiri, dengan kas, lot, fee dan slippage yang
        benar-benar dihitung. Sumber rekomendasinya sama; yang beda cuma aturan keluarnya. Track record keduanya
        <b> tidak boleh dicampur</b> — itu dua pertanyaan yang berbeda.
      </p>

      {/* The regime gate. A flat NAV curve is meaningless without it: the
          engine standing aside looks identical to the engine being broken. */}
      {ihsg?.regime && (
        <div style={{
          ...card, marginBottom: 16, padding: '12px 18px',
          display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
          borderColor: ihsg.regime.below ? 'rgba(248,81,73,0.35)' : 'rgba(63,185,80,0.35)',
        }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: '#f7c948', letterSpacing: '0.08em' }}>📊 GERBANG REGIME</span>
          <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' }}>
            IHSG {Number(ihsg.price).toLocaleString('id-ID')}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            vs SMA200 {Number(ihsg.regime.sma200).toLocaleString('id-ID')} ({pct(ihsg.regime.gapPct)})
          </span>
          <span style={{
            fontSize: 10, fontWeight: 800, padding: '3px 9px', borderRadius: 5,
            background: ihsg.regime.below ? 'rgba(248,81,73,0.12)' : 'rgba(63,185,80,0.12)',
            color: ihsg.regime.below ? '#f85149' : '#3fb950',
            border: `1px solid ${ihsg.regime.below ? 'rgba(248,81,73,0.35)' : 'rgba(63,185,80,0.35)'}`,
          }}>
            {ihsg.regime.below ? '⛔ STAND ASIDE' : '✅ INVESTED'}
          </span>
          {ihsg.regime.below && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              sudah <b style={{ color: '#f85149' }}>{ihsg.regime.sessions} sesi</b> sejak {ihsg.regime.since} —
              selama ini bertahan, <b>kurva NAV memang akan datar</b>. Itu keputusan, bukan kerusakan.
            </span>
          )}
        </div>
      )}

      {loading && <div style={{ ...card, color: 'var(--text-muted)', fontSize: 13 }}>Memuat ledger…</div>}
      {error && (
        <div style={{ ...card, borderColor: 'rgba(248,81,73,0.35)', color: '#f85149', fontSize: 13 }}>
          Gagal memuat: {error}
        </div>
      )}
      {!loading && !error && !accounts.length && (
        <div style={{ ...card, color: 'var(--text-muted)', fontSize: 13 }}>
          Belum ada akun virtual. <code>virtual_portfolio.js</code> belum pernah jalan di server ini.
        </div>
      )}

      {/* ── account cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14, marginBottom: 16 }}>
        {accounts.map(a => {
          const up = a.returnPct >= 0;
          return (
            <div key={a.id} style={{ ...card, opacity: a.status === 'CLOSED' ? 0.62 : 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 900, color: 'var(--text-primary)' }}>{a.account_code}</span>
                <span style={{
                  fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 4,
                  background: 'rgba(139,148,158,0.14)', color: 'var(--text-muted)',
                }}>
                  exit {a.exit_policy}
                </span>
                {a.status === 'CLOSED' && (
                  <span title="Kontrak eksekusinya berubah (fee, slippage, atau lapisan risiko), jadi akun ini dipensiunkan. Riwayatnya tetap disimpan dan tidak boleh digabung dengan yang aktif."
                    style={{
                      fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 4, cursor: 'help',
                      background: 'rgba(163,113,247,0.14)', color: '#a371f7',
                    }}>
                    PENSIUN
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 2 }}>
                <span style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-primary)' }}>{rp(a.nav)}</span>
                <span style={{ fontSize: 14, fontWeight: 800, color: a.returnPct === 0 ? 'var(--text-muted)' : up ? '#3fb950' : '#f85149' }}>
                  {pct(a.returnPct)}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
                dari {rp(a.startingCash)} · kas {rp(a.cash)} · {a.openPositions?.length || 0} posisi terbuka
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 10 }}>
                {[
                  { label: 'Trade selesai', value: String(a.stats.closed) },
                  { label: 'Win rate', value: a.stats.winRate === null ? '–' : `${a.stats.winRate}%` },
                  {
                    label: 'Profit factor',
                    value: a.stats.profitFactor === null ? '–' : a.stats.profitFactor.toFixed(2),
                    hint: a.stats.profitFactor === null
                      ? 'Belum ada trade rugi, jadi profit factor belum terdefinisi. Sengaja dikosongkan, bukan ditulis tak-hingga.'
                      : undefined,
                  },
                ].map(s => (
                  <div key={s.label} title={s.hint} style={{
                    background: 'var(--bg-primary, rgba(0,0,0,0.15))', borderRadius: 8, padding: '8px 10px',
                    cursor: s.hint ? 'help' : undefined,
                  }}>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700 }}>{s.label}</div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-primary)' }}>{s.value}</div>
                  </div>
                ))}
              </div>

              {a.stats.closed > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {Object.entries(a.stats.exits).filter(([, v]) => Number(v) > 0).map(([k, v]) => (
                    <span key={k} style={{
                      fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 4,
                      background: `${EXIT_COLORS[k] || '#8b949e'}22`, color: EXIT_COLORS[k] || '#8b949e',
                    }}>
                      {k} {String(v)}
                    </span>
                  ))}
                </div>
              )}

              {a.stats.ambiguousExits > 0 && (
                <div style={{ fontSize: 10, color: '#e3b341', lineHeight: 1.5, marginBottom: 8 }}>
                  ⚠ {a.stats.ambiguousExits} exit kena stop <i>dan</i> target di candle yang sama. Data harian tidak bisa
                  memastikan mana duluan, jadi diambil STOP — asumsi konservatif, bukan fakta.
                </div>
              )}

              {a.expectation && (
                <div style={{
                  fontSize: 10, lineHeight: 1.55, color: '#f85149',
                  background: 'rgba(248,81,73,0.08)', border: '1px solid rgba(248,81,73,0.25)',
                  borderRadius: 8, padding: '8px 10px',
                }}>
                  <b>Akun ini diharapkan RUGI.</b> EXP-019 mengukur aturan ini di −0,951%/trade pada hari-hari BUY
                  sistem ini sendiri (n=2.204, t=−18,5), lebih buruk dari base rate −0,673%. Dijalankan untuk
                  mengonfirmasi itu ke depan — <b>jangan disetel sampai berhenti rugi</b>.
                </div>
              )}

              <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 10, fontFamily: 'monospace' }}>
                policy {a.execution_policy_hash}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── NAV curve ── */}
      {navChart.length > 0 && (
        <div style={{ ...card, marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 2 }}>
            Kurva NAV
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 12 }}>
            {navChart.length} hari mark. Kedua akun di satu grafik on purpose — yang menarik adalah selisihnya.
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={navChart}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
              <YAxis
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                domain={['auto', 'auto']}
                tickFormatter={(v: number) => (v / 1_000_000).toFixed(1) + 'jt'}
              />
              <Tooltip
                formatter={(v: any) => rp(v)}
                contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {accounts.map((a, i) => (
                <Line key={a.id} type="monotone" dataKey={a.account_code} dot={false} strokeWidth={2}
                  stroke={i === 0 ? '#58a6ff' : '#e3b341'} />
              ))}
            </LineChart>
          </ResponsiveContainer>
          {!anyTrades && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.55 }}>
              Belum ada satu pun trade. Kurvanya datar di modal awal karena gerbang regime di atas sedang menutup —
              bukan karena job-nya mati.
            </div>
          )}
        </div>
      )}

      {/* ── per-account tables ── */}
      {accounts.map(a => {
        const active = tab[a.account_code] || 'open';
        const tabs: { key: 'open' | 'closed' | 'orders'; label: string; n: number }[] = [
          { key: 'open', label: 'Posisi terbuka', n: a.openPositions?.length || 0 },
          { key: 'closed', label: 'Trade selesai', n: a.closedTrades?.length || 0 },
          { key: 'orders', label: 'Order menunggu / ditolak', n: a.pendingOrders?.length || 0 },
        ];
        return (
          <div key={`t-${a.id}`} style={{ ...card, marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              <span style={{ fontSize: 12, fontWeight: 900, color: 'var(--text-primary)' }}>{a.account_code}</span>
              {tabs.map(t => (
                <button key={t.key} onClick={() => setTab(p => ({ ...p, [a.account_code]: t.key }))} style={{
                  padding: '3px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 10, fontWeight: 800,
                  border: `1px solid ${active === t.key ? '#58a6ff' : 'var(--border)'}`,
                  background: active === t.key ? 'rgba(88,166,255,0.12)' : 'transparent',
                  color: active === t.key ? '#58a6ff' : 'var(--text-muted)',
                }}>
                  {t.label} ({t.n})
                </button>
              ))}
            </div>

            <div style={{ overflowX: 'auto' }}>
              {active === 'open' && (
                a.openPositions?.length ? (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>
                      {['TICKER', 'LOT', 'MASUK', 'HARGA MASUK', 'STOP', 'TARGET', 'MODAL'].map(h => <th key={h} style={th}>{h}</th>)}
                    </tr></thead>
                    <tbody>
                      {a.openPositions.map((p: any) => (
                        <tr key={p.id}>
                          <td style={{ ...td, fontWeight: 800, color: 'var(--text-primary)' }}>{p.ticker}</td>
                          <td style={td}>{(p.quantity / 100).toLocaleString('id-ID')}</td>
                          <td style={{ ...td, color: 'var(--text-muted)' }}>{String(p.entry_date).slice(0, 10)}</td>
                          <td style={td}>{Number(p.entry_price).toLocaleString('id-ID')}</td>
                          <td style={{ ...td, color: '#f85149' }}>{Number(p.stop_price).toLocaleString('id-ID')}</td>
                          <td style={{ ...td, color: '#3fb950' }}>{Number(p.target_price).toLocaleString('id-ID')}</td>
                          <td style={td}>{rp(p.cost_basis)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Tidak ada posisi terbuka.</div>
              )}

              {active === 'closed' && (
                a.closedTrades?.length ? (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>
                      {['TICKER', 'MASUK', 'KELUAR', 'HARGA', 'ALASAN KELUAR', 'BAR', 'P&L BERSIH', 'RETURN'].map(h => <th key={h} style={th}>{h}</th>)}
                    </tr></thead>
                    <tbody>
                      {a.closedTrades.map((p: any) => {
                        const win = Number(p.net_pnl) > 0;
                        return (
                          <tr key={p.id}>
                            <td style={{ ...td, fontWeight: 800, color: 'var(--text-primary)' }}>{p.ticker}</td>
                            <td style={{ ...td, color: 'var(--text-muted)' }}>{String(p.entry_date).slice(0, 10)}</td>
                            <td style={{ ...td, color: 'var(--text-muted)' }}>{String(p.exit_date).slice(0, 10)}</td>
                            <td style={td}>
                              {Number(p.entry_price).toLocaleString('id-ID')} → {Number(p.exit_price).toLocaleString('id-ID')}
                            </td>
                            <td style={td}>
                              <span style={{
                                fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 4,
                                background: `${EXIT_COLORS[p.exit_reason] || '#8b949e'}22`,
                                color: EXIT_COLORS[p.exit_reason] || '#8b949e',
                              }}>
                                {p.exit_reason}
                              </span>
                              {!!p.ambiguous_exit && (
                                <span title="Stop dan target kena di candle yang sama; data harian tidak bisa memastikan urutannya, jadi diambil STOP."
                                  style={{ marginLeft: 5, fontSize: 10, color: '#e3b341', cursor: 'help' }}>⚠</span>
                              )}
                            </td>
                            <td style={{ ...td, color: 'var(--text-muted)' }}>{p.holding_bars}</td>
                            <td style={{ ...td, fontWeight: 800, color: win ? '#3fb950' : '#f85149' }}>{rp(p.net_pnl)}</td>
                            <td style={{ ...td, fontWeight: 800, color: win ? '#3fb950' : '#f85149' }}>{pct(p.return_pct)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Belum ada trade yang selesai.</div>
              )}

              {active === 'orders' && (
                a.pendingOrders?.length ? (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>
                      {['TICKER', 'TANGGAL SINYAL', 'STATUS', 'ALASAN'].map(h => <th key={h} style={th}>{h}</th>)}
                    </tr></thead>
                    <tbody>
                      {a.pendingOrders.map((o: any, i: number) => (
                        <tr key={`${o.ticker}-${o.signal_date}-${i}`}>
                          <td style={{ ...td, fontWeight: 800, color: 'var(--text-primary)' }}>{o.ticker}</td>
                          <td style={{ ...td, color: 'var(--text-muted)' }}>{String(o.signal_date).slice(0, 10)}</td>
                          <td style={td}>{o.status}</td>
                          <td style={{ ...td, color: 'var(--text-muted)' }}>{o.reject_reason || '–'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Tidak ada order menunggu atau ditolak.</div>
              )}
            </div>
          </div>
        );
      })}

      <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.7, marginTop: 18, maxWidth: 900 }}>
        <b>Ini simulasi EOD, bukan eksekusi real-time.</b> Entry dipakai di open T+1, stop/target dihitung dari harga
        fill sebenarnya, dan fee beli 0,15% + fee jual 0,25% + slippage 0,10% ikut dihitung. Data harian cuma tahu
        sebuah level tersentuh, bukan urutannya — kalau stop dan target kena di candle yang sama, sistem mengambil
        STOP. Tidak ada order yang pernah dikirim ke broker mana pun.
      </div>
    </div>
  );
}
