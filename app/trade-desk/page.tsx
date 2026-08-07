'use client';

/**
 * Trade Desk — one screen, so tomorrow does not start with an SSH session.
 *
 * READ-ONLY, AND IT ADDS NOTHING. Every number here already exists behind
 * /api/virtual-portfolio, /api/ihsg and /api/system/health. This page computes
 * no state of its own and writes nothing: a dashboard that derives its own
 * version of the truth is a second source of truth, and the whole point of the
 * ledger is that there is only one.
 *
 * IT IS ALLOWED TO SAY THE SYSTEM IS NOT READY. The failure this replaces is
 * not "the data was hard to find" — it is a green screen that means "nothing
 * objected loudly enough". So the operational banner reports the engine's own
 * refusal reason verbatim, the burn-in shows what STOPPED the streak rather
 * than only its length, and an empty plan has to explain itself.
 */

import { useState, useEffect } from 'react';
import { API_BASE } from '@/lib/apiConfig';

const rp = (n: number | null | undefined) =>
  n === null || n === undefined ? '–' : 'Rp ' + Math.round(Number(n)).toLocaleString('id-ID');

const rpShort = (n: number | null | undefined) => {
  if (n === null || n === undefined) return '–';
  const v = Number(n);
  if (Math.abs(v) >= 1e9) return `Rp ${(v / 1e9).toFixed(2)} M`;
  if (Math.abs(v) >= 1e6) return `Rp ${(v / 1e6).toFixed(1)} jt`;
  return rp(v);
};

const pct = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined ? '–' : `${n >= 0 ? '+' : ''}${Number(n).toFixed(digits)}%`;

const OK = '#3fb950', WARN = '#e3b341', BAD = '#f85149', MUTED = '#8b949e', INFO = '#58a6ff';

const card: React.CSSProperties = {
  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
  borderRadius: 12, padding: 18,
};
const th: React.CSSProperties = {
  textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 800,
  color: 'var(--text-muted)', letterSpacing: '0.05em',
  borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const td: React.CSSProperties = {
  padding: '7px 10px', fontSize: 12, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const label: React.CSSProperties = {
  fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em',
};
const sectionTitle: React.CSSProperties = {
  fontSize: 11, fontWeight: 800, letterSpacing: '0.08em',
  color: 'var(--text-muted)', margin: '0 0 10px',
};

function Dot({ color }: { color: string }) {
  return <span style={{
    display: 'inline-block', width: 8, height: 8, borderRadius: 4,
    background: color, marginRight: 7, verticalAlign: 'middle',
  }} />;
}

function Row({ k, v, color, hint }: { k: string; v: React.ReactNode; color?: string; hint?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '5px 0', gap: 16 }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        {k}
        {hint && <span style={{ display: 'block', fontSize: 10, opacity: 0.7, marginTop: 1 }}>{hint}</span>}
      </span>
      <span style={{ fontSize: 12, fontWeight: 700, color: color || 'var(--text-primary)', textAlign: 'right' }}>{v}</span>
    </div>
  );
}

export default function TradeDeskPage() {
  const [vp, setVp] = useState<any>(null);
  const [ihsg, setIhsg] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`${API_BASE}/api/virtual-portfolio`).then(r => r.json()),
      fetch(`${API_BASE}/api/ihsg?range=1M`).then(r => r.json()).catch(() => null),
      fetch(`${API_BASE}/api/system/health`).then(r => r.json()).catch(() => null),
    ]).then(([v, i, h]) => {
      if (cancelled) return;
      setVp(v); setIhsg(i); setHealth(h); setLoading(false);
    }).catch(e => {
      if (cancelled) return;
      // A desk that cannot reach the engine must say so, not render an empty
      // and therefore reassuring screen.
      setError(String(e?.message || e)); setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div style={{ padding: 28, color: 'var(--text-muted)' }}>loading trade desk…</div>;
  if (error) return (
    <div style={{ padding: 28 }}>
      <div style={{ ...card, borderColor: BAD }}>
        <div style={{ color: BAD, fontWeight: 800, marginBottom: 6 }}>TRADE DESK UNAVAILABLE</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Could not reach the engine: {error}. Nothing below is being shown — an empty
          desk would look like a quiet day.
        </div>
      </div>
    </div>
  );

  const trust = vp?.trust || {};
  const burn = vp?.burnIn || {};
  const accounts = (vp?.accounts || []).filter((a: any) => a.status === 'ACTIVE');
  const regime = ihsg?.regime || null;

  // The operational verdict is the ENGINE's, not this page's. Anything other
  // than an explicit HEALTHY is reported as-is, including UNKNOWN.
  const blocked = trust.marketData === 'BLOCKED';
  const opColor = trust.marketData === 'HEALTHY' ? OK : blocked ? WARN : MUTED;
  const opText = trust.marketData === 'HEALTHY' ? 'HEALTHY'
    : blocked ? `BLOCKED — ${trust.blockedReason || 'reason not given'}`
    : String(trust.marketData || 'UNKNOWN');

  const watchdog = (health?.jobs || []).find((j: any) => j.job_name === 'watchdog') || null;
  const staleFeeds = (health?.freshness || []).filter((f: any) => !f.ok);
  const criticalStale = staleFeeds.filter((f: any) => f.critical);

  const strategy = accounts[0]?.strategy_id || vp?.accounts?.[0]?.strategy_id || '–';
  const allPending = accounts.flatMap((a: any) =>
    (a.pendingOrders || []).filter((o: any) => o.status === 'SCHEDULED')
      .map((o: any) => ({ ...o, account: a.account_code })));
  const allOpen = accounts.flatMap((a: any) =>
    (a.openPositions || []).map((p: any) => ({ ...p, account: a.account_code })));
  const allExits = accounts.flatMap((a: any) =>
    (a.closedTrades || []).slice(0, 8).map((p: any) => ({ ...p, account: a.account_code })))
    .sort((x: any, y: any) => String(y.exit_date).localeCompare(String(x.exit_date)))
    .slice(0, 10);

  return (
    <div style={{ padding: '24px 28px 60px', maxWidth: 1180, margin: '0 auto' }}>

      {/* ── header ─────────────────────────────────────────────────────── */}
      <div style={{ ...card, marginBottom: 16, borderColor: blocked ? WARN : 'var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '0.02em' }}>
              FLOWTRACKER IDX — TRADE DESK
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              Strategy <b style={{ color: 'var(--text-primary)' }}>{strategy}</b>
              {' · '}engine v{trust.engineVersion ?? '?'}
              {' · '}session {trust.sessionCalendar || '–'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
            <div>
              <div style={label}>OPERATIONAL</div>
              <div style={{ fontSize: 13, fontWeight: 800, color: opColor, marginTop: 3 }}>
                <Dot color={opColor} />{opText}
              </div>
            </div>
            <div>
              <div style={label}>BURN-IN</div>
              <div style={{ fontSize: 13, fontWeight: 800, marginTop: 3 }}>
                {burn.streak ?? 0} / {burn.target ?? 10}
              </div>
            </div>
          </div>
        </div>

        {/* The engine refused for a reason. Print the reason, not a colour. */}
        {blocked && (
          <div style={{
            marginTop: 14, padding: '10px 12px', borderRadius: 8,
            background: 'rgba(227,179,65,0.08)', border: `1px solid ${WARN}44`,
            fontSize: 12, lineHeight: 1.55,
          }}>
            <b style={{ color: WARN }}>No new orders will be placed while this holds.</b>{' '}
            The session calendar is at <b>{trust.sessionCalendar || '–'}</b> but prices only reach{' '}
            <b>{trust.latestPriceSession || '–'}</b>. Before the nightly ingest this is the
            expected state, not a fault — the engine refuses to act on a session whose
            prices are not in yet. It becomes a fault if it is still true after the cron
            has run.
          </div>
        )}
      </div>

      {/* ── today ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 14, marginBottom: 16 }}>
        <div style={card}>
          <div style={sectionTitle}>TODAY — MARKET</div>
          <Row k="IHSG" v={ihsg?.price ? Number(ihsg.price).toLocaleString('id-ID') : '–'} />
          <Row k="Change" v={pct(ihsg?.changePct)}
               color={ihsg?.changePct >= 0 ? OK : BAD} />
          <Row k="Regime" v={regime?.label || '–'}
               color={regime?.below ? WARN : OK}
               hint={regime ? `${regime.gapPct >= 0 ? '+' : ''}${Number(regime.gapPct).toFixed(1)}% vs SMA200 (${Number(regime.sma200).toLocaleString('id-ID')})` : undefined} />
          <Row k="Regime exposure" v={regime ? `${Math.round(Number(regime.exposure) * 100)}%` : '–'}
               color={regime && Number(regime.exposure) === 0 ? WARN : OK}
               hint={regime?.since ? `since ${regime.since} · ${regime.sessions} sessions` : undefined} />
          <Row k="Weekly trend" v={ihsg?.weeklyTrend || '–'}
               color={ihsg?.weeklyTrend === 'BULLISH' ? OK : ihsg?.weeklyTrend === 'BEARISH' ? BAD : MUTED} />
        </div>

        <div style={card}>
          <div style={sectionTitle}>TODAY — DATA &amp; CYCLE</div>
          <Row k="Session calendar" v={trust.sessionCalendar || '–'} />
          <Row k="Latest prices" v={trust.latestPriceSession || '–'}
               color={trust.latestPriceSession === trust.sessionCalendar ? OK : WARN} />
          <Row k="Reconciliation" v={trust.reconcile || 'UNKNOWN'}
               color={trust.reconcile === 'CLEAN' ? OK : trust.reconcile === 'PROBLEMS' ? BAD : MUTED} />
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
            <div style={{ ...label, marginBottom: 6 }}>NIGHTLY STAGES</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {['resolve', 'schedule', 'mark'].map(st => {
                const s = trust.stages?.[st] || { status: 'NOT_RUN' };
                const c = s.status === 'DONE' ? OK : s.status === 'FAILED' ? BAD : MUTED;
                return (
                  <span key={st} title={s.reason || ''} style={{
                    fontSize: 10, fontWeight: 800, padding: '4px 9px', borderRadius: 6,
                    border: `1px solid ${c}55`, color: c, letterSpacing: '0.04em',
                  }}>{st.toUpperCase()} · {s.status}</span>
                );
              })}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
              NOT_RUN before the nightly cron is normal. NOT_RUN after it is a missing
              session, and a missing session stops the burn-in streak.
            </div>
          </div>
        </div>
      </div>

      {/* ── tomorrow ───────────────────────────────────────────────────── */}
      <div style={{ ...card, marginBottom: 16 }}>
        <div style={sectionTitle}>TOMORROW — PLAN</div>
        {allPending.length === 0 ? (
          <div style={{ fontSize: 12, lineHeight: 1.65, color: 'var(--text-muted)' }}>
            <b style={{ color: 'var(--text-primary)' }}>Nothing scheduled.</b>{' '}
            {regime && Number(regime.exposure) === 0 ? (
              <>
                The regime gate is at <b>0% exposure</b> — IHSG is {Math.abs(Number(regime.gapPct)).toFixed(1)}%
                below its 200-day average and has been since {regime.since}. The strategy is
                deliberately flat, so an empty plan is the strategy working, not the pipeline
                failing. The two are indistinguishable on a screen that only shows an empty
                table, which is why this sentence is here.
              </>
            ) : blocked ? (
              <>Orders cannot be scheduled while the engine is blocked (see above).</>
            ) : (
              <>No signal cleared the entry rules for the next session.</>
            )}
          </div>
        ) : (
          <>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>TICKER</th><th style={th}>SIDE</th><th style={th}>ACCOUNT</th>
                <th style={th}>RANK</th><th style={th}>NOTIONAL</th><th style={th}>QTY</th>
                <th style={th}>FOR SESSION</th>
              </tr></thead>
              <tbody>
                {allPending.map((o: any, i: number) => (
                  <tr key={i}>
                    <td style={{ ...td, fontWeight: 800 }}>{o.ticker}</td>
                    <td style={{ ...td, color: o.side === 'SELL' ? BAD : OK, fontWeight: 700 }}>{o.side || 'BUY'}</td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{o.account}</td>
                    <td style={td}>{o.target_rank ?? '–'}</td>
                    <td style={td}>{rpShort(o.intended_notional)}</td>
                    <td style={td}>{o.quantity ?? '–'}</td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{o.scheduled_entry_date || o.signal_date || '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
              No entry price is shown because there is not one yet: these fill at the next
              session&apos;s OPEN. A number here would be a guess wearing the clothes of a plan.
            </div>
          </>
        )}
      </div>

      {/* ── open positions ─────────────────────────────────────────────── */}
      <div style={{ ...card, marginBottom: 16 }}>
        <div style={sectionTitle}>OPEN POSITIONS</div>
        {allOpen.length === 0
          ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              No open positions. Both accounts are fully in cash.
            </div>
          : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>TICKER</th><th style={th}>ACCOUNT</th><th style={th}>QTY</th>
                <th style={th}>ENTRY</th><th style={th}>STOP</th><th style={th}>TARGET</th>
                <th style={th}>COST BASIS</th><th style={th}>SINCE</th>
              </tr></thead>
              <tbody>
                {allOpen.map((p: any) => (
                  <tr key={p.id}>
                    <td style={{ ...td, fontWeight: 800 }}>{p.ticker}</td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{p.account}</td>
                    <td style={td}>{Number(p.quantity).toLocaleString('id-ID')}</td>
                    <td style={td}>{rp(p.entry_price)}</td>
                    <td style={{ ...td, color: BAD }}>{rp(p.stop_price)}</td>
                    <td style={{ ...td, color: OK }}>{rp(p.target_price)}</td>
                    <td style={td}>{rpShort(p.cost_basis)}</td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{p.entry_date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {/* ── cash and exposure ──────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 14, marginBottom: 16 }}>
        {accounts.map((a: any) => {
          const isControl = a.charter?.gate?.kind === 'CONTROL';
          const exposure = a.nav > 0 ? ((Number(a.nav) - Number(a.cash)) / Number(a.nav)) * 100 : 0;
          return (
            <div key={a.id} style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 800 }}>{a.account_code}</div>
                <span style={{
                  fontSize: 9, fontWeight: 800, padding: '3px 8px', borderRadius: 5,
                  letterSpacing: '0.05em',
                  border: `1px solid ${isControl ? MUTED : INFO}66`, color: isControl ? MUTED : INFO,
                }}>{a.charter?.gate?.kind || 'NO CHARTER'}</span>
              </div>
              <Row k="NAV" v={rp(a.nav)} />
              <Row k="Cash" v={rp(a.cash)} />
              <Row k="Exposure" v={`${exposure.toFixed(0)}%`} />
              <Row k="Return" v={pct(a.returnPct)} color={a.returnPct >= 0 ? OK : BAD} />
              <Row k="Max drawdown" v={`${Number(a.maxDrawdown).toFixed(2)}%`}
                   color={a.charter?.gate?.maxDrawdown && a.maxDrawdown / 100 > a.charter.gate.maxDrawdown ? BAD : 'var(--text-primary)'} />
              <Row k="Closed trades" v={`${a.stats?.closed ?? 0} / ${a.charter?.gate?.minClosedTrades ?? '–'}`}
                   hint="toward the evaluation gate" />
              {isControl && (
                <div style={{
                  marginTop: 10, fontSize: 10, lineHeight: 1.55, color: 'var(--text-muted)',
                  borderTop: '1px solid var(--border)', paddingTop: 9,
                }}>
                  A <b>control</b>, not a candidate. EXP-019 measured this rule at −0.951%
                  per trade, so it is <b>expected to lose</b>. It succeeds by producing enough
                  clean trades to confirm that forward, and must not be tuned until it profits.
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── recent exits ───────────────────────────────────────────────── */}
      <div style={{ ...card, marginBottom: 16 }}>
        <div style={sectionTitle}>RECENT EXITS</div>
        {allExits.length === 0
          ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              No closed trades yet on the official accounts.
            </div>
          : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>TICKER</th><th style={th}>ACCOUNT</th><th style={th}>ENTRY</th>
                <th style={th}>EXIT</th><th style={th}>REASON</th><th style={th}>P&amp;L</th>
                <th style={th}>RETURN</th><th style={th}>BARS</th>
              </tr></thead>
              <tbody>
                {allExits.map((p: any) => (
                  <tr key={p.id}>
                    <td style={{ ...td, fontWeight: 800 }}>
                      {p.ticker}
                      {/* An ambiguous exit resolved a bar that touched both stop and target.
                          It is not a normal fill and should not read as one. */}
                      {p.ambiguous_exit ? <span title="stop and target both touched in one bar" style={{ color: WARN, marginLeft: 5 }}>*</span> : null}
                    </td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{p.account}</td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{p.entry_date}</td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{p.exit_date}</td>
                    <td style={td}>{p.exit_reason}</td>
                    <td style={{ ...td, color: Number(p.net_pnl) >= 0 ? OK : BAD, fontWeight: 700 }}>{rpShort(p.net_pnl)}</td>
                    <td style={{ ...td, color: Number(p.return_pct) >= 0 ? OK : BAD }}>{pct(p.return_pct)}</td>
                    <td style={td}>{p.holding_bars ?? '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {/* ── system evidence ────────────────────────────────────────────── */}
      <div style={card}>
        <div style={sectionTitle}>SYSTEM EVIDENCE</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 20 }}>
          <div>
            <Row k="Burn-in streak" v={`${burn.streak ?? 0} / ${burn.target ?? 10}`} />
            {/* The length of a streak is half the story. What ended it is the half
                that tells you whether anything is wrong. */}
            <Row k="Stopped by" v={burn.stoppedBy || '–'}
                 color={burn.stoppedBy ? WARN : MUTED} />
            <Row k="Protocol" v={`v${burn.protocolVersion ?? '?'}`} />
          </div>
          <div>
            <Row k="Ledger" v={trust.reconcile || 'UNKNOWN'}
                 color={trust.reconcile === 'CLEAN' ? OK : trust.reconcile === 'PROBLEMS' ? BAD : MUTED} />
            <Row k="Watchdog" v={watchdog ? watchdog.status : 'UNKNOWN'}
                 color={watchdog?.status === 'OK' ? OK : watchdog ? BAD : MUTED}
                 hint={watchdog?.finished_at ? new Date(watchdog.finished_at).toLocaleString('id-ID') : undefined} />
            <Row k="Stale feeds" v={staleFeeds.length ? staleFeeds.map((f: any) => f.key).join(', ') : 'none'}
                 color={criticalStale.length ? BAD : staleFeeds.length ? WARN : OK}
                 hint={staleFeeds.length && !criticalStale.length ? 'none of them critical' : undefined} />
          </div>
          <div>
            <Row k="Burn-in identity" v={<code style={{ fontSize: 11 }}>{burn.identity || '–'}</code>} />
            <Row k="Experiment" v={<code style={{ fontSize: 11 }}>{trust.experimentIdentity || '–'}</code>} />
            <Row k="Cycle" v={<code style={{ fontSize: 11 }}>{trust.cycleIdentity || '–'}</code>} />
          </div>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 14, lineHeight: 1.6, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          Every value on this page is read from the engine — nothing here is recomputed.
          The burn-in streak walks the exchange calendar, so a session with no verdict
          stops it rather than being skipped: silence is not evidence of a clean day.
          {health?.checkedAt && <> Health checked {new Date(health.checkedAt).toLocaleString('id-ID')}.</>}
        </div>
      </div>
    </div>
  );
}
