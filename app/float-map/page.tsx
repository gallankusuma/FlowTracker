'use client';

/**
 * Float Cost Map — where the tradable float was probably acquired.
 *
 * THE RANKING IS ON THE RESIDUAL, AND THAT IS NOT A STYLE CHOICE.
 * EXP-2026-08-07-023 measured the raw cost gap at IC 0.0075 across 414
 * cross-sections — indistinguishable from zero, overlapping 0.61 with 60-day
 * momentum. Residualised against ROC20+ROC60 it reaches IC 0.0378 / IR 0.23,
 * which is the same modest scale as EXP-011's HI52W, a factor this project
 * already recorded as "not a tradeable edge as it stands".
 *
 * So the raw number is shown in a muted column and the residual leads. Sorting
 * a screen by the raw gap and watching it look meaningful is exactly the trap
 * the scanner score fell into: a beautiful monotone chart of the price path.
 */

import Navbar from '@/components/Navbar';
import { useState, useEffect } from 'react';

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
const rp = (n: number) => 'Rp' + Math.round(n).toLocaleString('id-ID');

export default function FloatMapPage() {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/float-map')
      .then(async r => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.detail || j.error || `HTTP ${r.status}`);
        return j;
      })
      .then(j => { setData(j); setSel(j.rows?.[0]?.ticker ?? null); })
      .catch(e => setErr(String(e.message || e)));
  }, []);

  if (err) return (
    <><Navbar />
      <div style={{ padding: 28 }}>
        <div style={{ ...card, borderColor: WARN }}>
          <div style={{ color: WARN, fontWeight: 800, marginBottom: 6 }}>FLOAT MAP UNAVAILABLE</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            {err} — nothing is shown rather than an empty map, because an empty map
            looks like a market with no cost structure and a reader has no way to tell
            the difference.
          </div>
        </div>
      </div>
    </>
  );
  if (!data) return (<><Navbar /><div style={{ padding: 28, color: MUTED }}>loading float map…</div></>);

  const rows = data.rows || [];
  const cur = rows.find((r: any) => r.ticker === sel) || rows[0];
  const maxShare = cur ? Math.max(...cur.dist.map((d: any) => d.share)) : 1;

  return (
    <>
    <Navbar />
    <div style={{ padding: '24px 28px 60px', maxWidth: 1180, margin: '0 auto' }}>

      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>FLOAT COST MAP</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              session {data.session} · {data.universe} tickers with a free float on record
              {data.skippedCorporateAction > 0 && ` · ${data.skippedCorporateAction} excluded for a detected corporate action`}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>CONFIDENCE</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: data.confidence >= 60 ? OK : WARN, marginTop: 3 }}>
              {data.confidence}/100
            </div>
          </div>
        </div>

        {/* Said before the table, not after it. */}
        <div style={{
          marginTop: 14, padding: '11px 13px', borderRadius: 8,
          background: 'rgba(88,166,255,0.07)', border: `1px solid ${INFO}44`,
          fontSize: 12, lineHeight: 1.6,
        }}>
          <b style={{ color: INFO }}>Ranked on the momentum-residualised gap, not the raw one.</b>{' '}
          {data.evidence?.experiment} measured the raw cost gap at IC {data.evidence?.rawIC60D} over
          414 cross-sections — indistinguishable from zero, and 0.61 correlated with 60-day
          momentum. Only after regressing momentum out does it reach IC {data.evidence?.residualIC60D}{' '}
          (IR {data.evidence?.residualIR}), the same modest size as the strongest factor this
          project has ever found, which it also called untradeable. The raw column is kept
          visible and muted so the two can be compared, never so the raw one can be sorted on.
          {data.brokerLagDays > 2 && (
            <> Broker flow is <b>{data.brokerLagDays} days behind</b> prices, which is why
            confidence is not full.</>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px,1fr) minmax(300px,420px)', gap: 14, alignItems: 'start' }}>

        {/* ── ranking ─────────────────────────────────────────────────── */}
        <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px 6px', fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
            RANKED BY RESIDUAL COST GAP
          </div>
          <div style={{ overflowX: 'auto', maxHeight: 620, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>#</th><th style={th}>TICKER</th>
                <th style={th}>RESID</th><th style={th}>raw</th>
                <th style={th}>PRICE</th><th style={th}>EST COST</th>
                <th style={th}>IN PROFIT</th><th style={th}>FLOAT</th>
              </tr></thead>
              <tbody>
                {rows.map((r: any) => (
                  <tr key={r.ticker} onClick={() => setSel(r.ticker)}
                    style={{ cursor: 'pointer', background: r.ticker === sel ? 'rgba(88,166,255,0.08)' : 'transparent' }}>
                    <td style={{ ...td, color: MUTED }}>{r.rank}</td>
                    <td style={{ ...td, fontWeight: 800 }}>{r.ticker}</td>
                    <td style={{ ...td, fontWeight: 800, color: r.avgCostGapResid >= 0 ? OK : BAD }}>
                      {r.avgCostGapResid === null ? '–' : `${r.avgCostGapResid > 0 ? '+' : ''}${r.avgCostGapResid}%`}
                    </td>
                    {/* Muted on purpose: this is the column that measured nothing. */}
                    <td style={{ ...td, color: MUTED, fontSize: 11 }}>
                      {r.avgCostGap > 0 ? '+' : ''}{r.avgCostGap}%
                    </td>
                    <td style={td}>{rp(r.price)}</td>
                    <td style={td}>{rp(r.avgCost)}</td>
                    <td style={{ ...td, color: r.profitSupply >= 50 ? OK : WARN }}>{r.profitSupply}%</td>
                    <td style={{ ...td, color: r.floatPct < 15 ? WARN : 'var(--text-primary)' }}>{r.floatPct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── the map itself ──────────────────────────────────────────── */}
        {cur && (
          <div style={card}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 4 }}>
              ESTIMATED COST DISTRIBUTION
            </div>
            <div style={{ fontSize: 20, fontWeight: 900, marginBottom: 12 }}>{cur.ticker}</div>

            <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, lineHeight: 1.5 }}>
              {cur.dist.map((d: any) => {
                const here = d.price <= cur.price && d.price + (cur.dist[0].price - cur.dist[1]?.price || 1) > cur.price;
                return (
                  <div key={d.price} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ width: 62, textAlign: 'right', color: MUTED }}>{rp(d.price)}</span>
                    <span style={{ flex: 1, background: 'var(--bg-primary)', borderRadius: 3, overflow: 'hidden' }}>
                      <span style={{
                        display: 'block', height: 11,
                        width: `${(d.share / maxShare) * 100}%`,
                        background: d.price < cur.price ? OK : BAD, opacity: 0.65,
                      }} />
                    </span>
                    <span style={{ width: 38, textAlign: 'right' }}>{d.share}%</span>
                  </div>
                );
              })}
            </div>

            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: 12, lineHeight: 1.9 }}>
              <Row k="Current price" v={rp(cur.price)} />
              <Row k="Estimated avg cost" v={rp(cur.avgCost)} />
              <Row k="Residual gap" v={`${cur.avgCostGapResid > 0 ? '+' : ''}${cur.avgCostGapResid}%`}
                   color={cur.avgCostGapResid >= 0 ? OK : BAD} />
              <Row k="Estimated in profit" v={`${cur.profitSupply}%`} color={OK} />
              <Row k="Overhead supply" v={`${cur.overheadSupply}%`}
                   color={cur.overheadSupply > 40 ? BAD : WARN} />
              <Row k="Largest cost cluster" v={`${rp(cur.peakLow)}–${rp(cur.peakHigh)}`} />
              <Row k="Free float" v={`${cur.floatPct}%`} />
              <Row k="Float rotation 20d / 60d" v={`${cur.rotation20}% / ${cur.rotation60}%`} />
            </div>

            <div style={{ marginTop: 12, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              <b>Estimated.</b> Nobody outside KSEI knows the real holders. This is inventory
              accounting over the float: each session a share of it changes hands, the old
              distribution decays proportionally, and the shares that moved are re-assigned
              across that day&apos;s range. The assumption doing the work — that volume replaces
              holders at random — is false in a known direction, since long-term holders churn
              far less than traders, so old cost bases fade faster here than in reality.
              Corporate actions are detected and excluded, not adjusted.
            </div>
          </div>
        )}
      </div>
    </div>
    </>
  );
}

function Row({ k, v, color }: { k: string; v: React.ReactNode; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
      <span style={{ color: 'var(--text-muted)' }}>{k}</span>
      <span style={{ fontWeight: 700, color: color || 'var(--text-primary)' }}>{v}</span>
    </div>
  );
}
