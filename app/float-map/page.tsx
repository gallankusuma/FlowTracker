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
import React, { useState, useEffect, useRef } from 'react';

const OK = '#3fb950', WARN = '#e3b341', BAD = '#f85149', MUTED = '#8b949e', INFO = '#58a6ff';

const card: React.CSSProperties = {
  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
  borderRadius: 12, padding: 18,
};
const th: React.CSSProperties = {
  textAlign: 'left', padding: '7px 10px', fontSize: 13, fontWeight: 800,
  color: 'var(--text-muted)', letterSpacing: '0.05em',
  borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const td: React.CSSProperties = {
  padding: '7px 10px', fontSize: 15, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const rp = (n: number) => 'Rp' + Math.round(n).toLocaleString('id-ID');

export default function FloatMapPage() {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);

  /**
   * Match the list's height to the detail panel beside it.
   *
   * A fixed height cannot work: the panel's height depends on how many
   * distribution buckets the selected ticker has, so it changes on every click.
   * A viewport-based height cannot work either — at 1600x900 the panel is
   * 1265px tall against a 900px viewport, so the list stopped less than
   * halfway down and read as truncated.
   *
   * Only applied when the two are actually side by side. On a narrow screen the
   * grid stacks them, and forcing a tall scroller there would strand the detail
   * panel below a screenful of empty list.
   */
  const leftCardRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState<number | null>(null);

  useEffect(() => {
    const sync = () => {
      const leftCard = leftCardRef.current, detail = detailRef.current;
      if (!leftCard || !detail) return;
      // Compare the two CARDS. Comparing the scroller instead was off by the
      // height of the heading above it, so this test never once passed.
      const sideBySide = Math.abs(leftCard.getBoundingClientRect().top - detail.getBoundingClientRect().top) < 40;
      if (!sideBySide) { setListHeight(null); return; }
      // Minus the section heading that sits above the scroll area.
      // The scroller is the card minus its heading; match the detail card's
      // total height so the two columns end level.
      const heading = leftCard.offsetHeight - (listRef.current?.offsetHeight ?? 0);
      setListHeight(Math.max(420, detail.offsetHeight - heading));
    };
    sync();
    const ro = new ResizeObserver(sync);
    if (detailRef.current) ro.observe(detailRef.current);
    window.addEventListener('resize', sync);
    return () => { ro.disconnect(); window.removeEventListener('resize', sync); };
  }, [sel, data]);

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
          <div style={{ fontSize: 15, color: 'var(--text-muted)', lineHeight: 1.6 }}>
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

  /**
   * A snapshot that stopped being regenerated still returns HTTP 200 and still
   * looks like today's ranking. That is more dangerous than a missing file:
   * missing is obvious, stale-but-valid is not. So the age of the underlying
   * session is measured here and the ranking is DISABLED past the threshold,
   * not merely annotated.
   *
   * Counted in weekdays, because a Friday snapshot read on Monday morning is
   * one session old, not three days old. IDX holidays will occasionally make
   * this read stale when it is not — a false STALE is the safe direction.
   */
  const weekdaysBetween = (fromISO: string) => {
    const a = new Date(fromISO + 'T00:00:00Z'), b = new Date();
    let n = 0;
    // Start the day AFTER the session: the session itself is not elapsed time,
    // and counting it made a same-day snapshot read as "1 weekday ago".
    for (const d = new Date(a); d < b; d.setUTCDate(d.getUTCDate() + 1)) {
      if (d.getTime() === a.getTime()) continue;
      const wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6) n++;
    }
    return n;
  };
  const sessionAge = data.session ? weekdaysBetween(String(data.session).slice(0, 10)) : 99;
  const STALE_AFTER = 2;                       // one missed nightly run is tolerated; two is not
  const stale = sessionAge > STALE_AFTER;

  const dateStatus = (label: string, value: string | null, expected?: string) => {
    if (!value) return { label, value: '–', tone: WARN, note: 'not recorded' };
    const v = String(value).slice(0, 10);
    if (expected && v !== expected) {
      const lag = weekdaysBetween(v);
      return { label, value: v, tone: lag > 2 ? BAD : WARN, note: `${lag} session(s) behind` };
    }
    return { label, value: v, tone: OK, note: 'current' };
  };
  const sessionStr = String(data.session).slice(0, 10);
  const statuses = [
    dateStatus('Price', data.priceMaxDate ?? data.session, sessionStr),
    // Counted on idx_ihsg_history server-side, so an IDX holiday no longer
    // reads as staleness the way a Monday-to-Friday count did.
    data.brokerMaxDate
      ? { label: 'Broker flow', value: String(data.brokerMaxDate).slice(0, 10),
          tone: (data.brokerLagSessions ?? 99) <= 1 ? OK : (data.brokerLagSessions ?? 99) <= 3 ? WARN : BAD,
          note: `${data.brokerLagSessions ?? '?'} session(s) behind` }
      : { label: 'Broker flow', value: '-', tone: WARN, note: 'not recorded' },
    // Coverage, not one date: MAX(fetched_at) reported CURRENT when a single
    // ticker refreshed and the rest still carried month-old numbers.
    data.freeFloat
      ? { label: 'Free float', value: `${data.freeFloat.fresh}/${data.freeFloat.total} fresh`,
          tone: data.freeFloat.coveragePct >= 90 ? OK : data.freeFloat.coveragePct >= 70 ? WARN : BAD,
          note: `${data.freeFloat.stale} stale, ${data.freeFloat.rejected} rejected` }
      : { label: 'Free float', value: '-', tone: WARN, note: 'not recorded' },
  ];

  return (
    <>
    <Navbar />
    <div style={{ padding: '24px 32px 60px', maxWidth: 'none' }}>

      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14 }}>
          <div>
            <div style={{ fontSize: 23, fontWeight: 800 }}>FLOAT COST MAP</div>
            <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 4 }}>
              session {data.session} · {data.universe} tickers ({data.ranked} ranked, {data.notRanked} not converged)
              {(data.skipped?.CORPORATE_ACTION ?? 0) > 0 && ` · ${data.skipped.CORPORATE_ACTION} excluded for a detected corporate action`}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>MEDIAN CONFIDENCE</div>
            <div style={{ fontSize: 19, fontWeight: 800, color: (data.confidence?.medianOverall ?? 0) >= 60 ? OK : WARN, marginTop: 3 }}>
              {data.confidence?.medianOverall ?? '-'}/100
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>per ticker, not global</div>
          </div>
        </div>

        {/* ── data status ─────────────────────────────────────────────── */}
        <div style={{
          marginTop: 14, display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'flex-start',
          padding: '11px 13px', borderRadius: 8,
          background: stale ? 'rgba(248,81,73,0.07)' : 'var(--bg-primary)',
          border: `1px solid ${stale ? BAD + '55' : 'var(--border)'}`,
        }}>
          {statuses.map(s => (
            <div key={s.label}>
              <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                {s.label.toUpperCase()}
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: s.tone, marginTop: 2 }}>{s.value}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.note}</div>
            </div>
          ))}
          <div>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.05em' }}>SNAPSHOT</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: stale ? BAD : OK, marginTop: 2 }}>
              {data.generatedAt ? new Date(data.generatedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '–'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              session {sessionStr} · {sessionAge} weekday(s) ago
            </div>
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.05em' }}>MODEL</div>
            <div style={{ fontSize: 14, fontWeight: 700, marginTop: 2 }}>{data.modelVersion || '–'}</div>
            <div style={{ fontSize: 11, color: data.modelCommit ? 'var(--text-muted)' : WARN }}>
              {data.modelCommit
                ? <>commit <code>{data.modelCommit}</code> · k={data.turnoverCoefficient}</>
                : 'commit NOT STAMPED — output cannot be traced to source'}
            </div>
          </div>
        </div>

        {/* The ranking is switched off, not annotated. A stale ordering that
            still sorts looks exactly like a fresh one. */}
        {stale && (
          <div style={{
            marginTop: 12, padding: '12px 14px', borderRadius: 8,
            background: 'rgba(248,81,73,0.1)', border: `1px solid ${BAD}`,
            fontSize: 15, lineHeight: 1.6,
          }}>
            <b style={{ color: BAD }}>⚠ STALE SNAPSHOT — RANKING DISABLED.</b>{' '}
            The most recent snapshot is built on session <b>{sessionStr}</b>, {sessionAge}{' '}
            weekdays ago. The nightly job has not produced a current one, so the ordering below would be
            yesterday&apos;s answer wearing today&apos;s date. Values are shown greyed for
            reference only. Check <code>/var/log/float-map.log</code> on the VPS.
          </div>
        )}

        {/* Said before the table, not after it. */}
        <div style={{
          marginTop: 14, padding: '11px 13px', borderRadius: 8,
          background: 'rgba(88,166,255,0.07)', border: `1px solid ${INFO}44`,
          fontSize: 15, lineHeight: 1.6,
        }}>
          <b style={{ color: INFO }}>Ranked on the momentum-residualised gap, not the raw one.</b>{' '}
          {(data.notRanked ?? 0) > 0 && (
            <><b style={{ color: WARN }}>{data.notRanked} names are shown but NOT ranked</b> — more than{' '}
            {data.rankableMaxSeed}% of their estimated distribution is still the model&apos;s day-one
            assumption, so a residual computed on it would not be measuring anything. Mostly large,
            quietly traded names.{' '}</>
          )}
          {data.evidence?.experiment} measured the raw cost gap at IC {data.evidence?.rawIC60D} over
          414 cross-sections — indistinguishable from zero, and 0.61 correlated with 60-day
          momentum. Only after regressing momentum out does it reach IC {data.evidence?.residualIC60D}{' '}
          (IR {data.evidence?.residualIR}), the same modest size as the strongest factor this
          project has ever found, which it also called untradeable. The raw column is kept
          visible and muted so the two can be compared, never so the raw one can be sorted on.
          {(data.brokerLagSessions ?? 0) > 1 && (
            <> Broker flow is <b>{data.brokerLagSessions} sessions behind</b> prices, which is why
            confidence is not full.</>
          )}
        </div>
      </div>

      {/* Two fixed minimums summed to 634px, which is wider than any phone, so
          the page pushed sideways instead of wrapping. auto-fit with a min()
          floor gives two columns when there is room and one when there is not. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 14, alignItems: 'start' }}>

        {/* ── ranking ─────────────────────────────────────────────────── */}
        <div ref={leftCardRef} style={{ ...card, padding: 0, overflow: 'hidden', opacity: stale ? 0.45 : 1, filter: stale ? 'grayscale(1)' : 'none' }}>
          <div style={{ padding: '14px 18px 6px', fontSize: 14, fontWeight: 800, letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
            RANKED BY RESIDUAL COST GAP{stale && ' — DISABLED'}
          </div>
          {/* Was a flat 620px, which stopped short of the bottom on any normal
              screen and left the column looking truncated next to the detail
              panel. Tied to the viewport instead so it reaches the fold, with a
              floor so it stays usable on a short window. */}
          <div ref={listRef} style={{
            overflowX: 'auto', overflowY: 'auto',
            height: listHeight ?? 620, minHeight: 420,
          }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>#</th><th style={th}>TICKER</th>
                <th style={th}>RESID</th><th style={th}>raw</th>
                <th style={th}>PRICE</th><th style={th}>EST COST</th>
                <th style={th}>IN PROFIT</th><th style={th}>FLOAT</th>
                <th style={th}>CONF</th><th style={th}>SEED LEFT</th>
              </tr></thead>
              <tbody>
                {rows.map((r: any, i: number) => (
                  <React.Fragment key={r.ticker}>
                  {/* The ranked list simply stopped and the rows below went dim
                      with a dash, which reads as a rendering fault rather than
                      a decision. Say what changed, where it changes. */}
                  {!r.rank && rows[i - 1]?.rank ? (
                    <tr>
                      <td colSpan={10} style={{
                        padding: '12px 12px', borderTop: `2px solid ${WARN}55`,
                        borderBottom: '1px solid var(--border)',
                        background: 'rgba(227,179,65,0.06)', fontSize: 13, lineHeight: 1.55,
                      }}>
                        <b style={{ color: WARN }}>▼ BELOW HERE: NOT RANKED ({data.notRanked})</b>{' '}
                        <span style={{ color: 'var(--text-muted)' }}>
                          More than {data.rankableMaxSeed}% of these distributions is still the
                          model&apos;s day-one assumption, so a residual computed on them would not
                          be measuring anything. Their numbers are shown; their position is not
                          meaningful, so they have no rank.
                        </span>
                      </td>
                    </tr>
                  ) : null}
                  <tr onClick={() => setSel(r.ticker)}
                    title={r.notRanked ? 'Not ranked: the model has not converged — most of this distribution is still the day-one assumption' : undefined}
                    style={{ cursor: 'pointer',
                      background: r.ticker === sel ? 'rgba(88,166,255,0.08)' : 'transparent',
                      // Unranked rows keep their numbers and lose their standing.
                      opacity: r.notRanked ? 0.5 : 1 }}>
                    <td style={{ ...td, color: MUTED }}>{r.rank ?? '–'}</td>
                    <td style={{ ...td, fontWeight: 800 }}>{r.ticker}</td>
                    <td style={{ ...td, fontWeight: 800, color: r.avgCostGapResid >= 0 ? OK : BAD }}>
                      {r.avgCostGapResid === null ? '–' : `${r.avgCostGapResid > 0 ? '+' : ''}${r.avgCostGapResid}%`}
                    </td>
                    {/* Muted on purpose: this is the column that measured nothing. */}
                    <td style={{ ...td, color: MUTED, fontSize: 14 }}>
                      {r.avgCostGap > 0 ? '+' : ''}{r.avgCostGap}%
                    </td>
                    <td style={td}>{rp(r.price)}</td>
                    <td style={td}>{rp(r.avgCost)}</td>
                    <td style={{ ...td, color: r.profitSupply >= 50 ? OK : WARN }}>{r.profitSupply}%</td>
                    <td style={{ ...td, color: r.floatPct < 15 ? WARN : 'var(--text-primary)' }}>{r.floatPct}%</td>
                    <td style={{ ...td, color: r.confidence >= 60 ? OK : r.confidence >= 40 ? WARN : BAD }}>{r.confidence}</td>
                    {/* How much of the map is still the arbitrary day-one seed.
                        Above ~20% the "estimated cost basis" is largely a
                        statement about a date somebody picked. */}
                    <td style={{ ...td, color: r.seedRemaining <= 5 ? OK : r.seedRemaining <= 20 ? WARN : BAD }}>
                      {r.seedRemaining}%
                    </td>
                  </tr>
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── the map itself ──────────────────────────────────────────── */}
        {cur && (
          <div ref={detailRef} style={card}>
            <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 4 }}>
              ESTIMATED COST DISTRIBUTION
            </div>
            <div style={{ fontSize: 25, fontWeight: 900, marginBottom: 12 }}>{cur.ticker}</div>

            <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 14, lineHeight: 1.5 }}>
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

            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: 15, lineHeight: 1.9 }}>
              <Row k="Current price" v={rp(cur.price)} />
              <Row k="Estimated avg cost" v={rp(cur.avgCost)} />
              <Row k="Residual gap" v={`${cur.avgCostGapResid > 0 ? '+' : ''}${cur.avgCostGapResid}%`}
                   color={cur.avgCostGapResid >= 0 ? OK : BAD} />
              {/* The number the whole page ranks on, and it was never defined
                  anywhere on it. */}
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55, margin: '2px 0 8px' }}>
                Price is <b>{cur.avgCostGap > 0 ? '+' : ''}{cur.avgCostGap}%</b> from the estimated
                average cost. A stock that rose is above its holders&apos; cost automatically, so that
                raw figure is mostly just the recent move — it measured IC 0.0075, indistinguishable
                from nothing. The <b>residual</b> is what is left after the rest of today&apos;s
                cross-section explains that gap from 20- and 60-day returns: how far this name sits
                from the line, above or below what its own move accounts for. That leftover is the
                only part that sorted forward returns.
              </div>
              <Row k="Estimated in profit" v={`${cur.profitSupply}%`} color={OK} desc />
              <Row k="Overhead supply" v={`${cur.overheadSupply}%`}
                   color={cur.overheadSupply > 40 ? BAD : WARN} desc />
              <Row k="Largest cost cluster" v={`${rp(cur.peakLow)}–${rp(cur.peakHigh)}`} desc />
              <Row k="Free float" v={`${cur.floatPct}%`} />
              <Row k="Confidence (data / convergence)"
                   v={`${cur.confidence} (${cur.confidenceData} / ${cur.confidenceConvergence})`}
                   color={cur.confidence >= 60 ? OK : cur.confidence >= 40 ? WARN : BAD} />
              <Row k="Day-one seed still in the map" v={`${cur.seedRemaining}%`}
                   color={cur.seedRemaining <= 5 ? OK : cur.seedRemaining <= 20 ? WARN : BAD} />
              <Row k="Float rotation 20d / 60d" v={`${cur.rotation20}% / ${cur.rotation60}%`} desc />
            </div>

            {/* The badge was explained only in a title tooltip, which does not
                exist on touch and was not found on desktop either — it had to
                be asked about. A legend costs one line. */}
            <div style={{
              marginTop: 12, padding: '9px 11px', borderRadius: 7,
              background: 'var(--bg-primary)', border: '1px solid var(--border)',
              fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6,
            }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: '#8b949e',
                border: '1px solid #8b949e55', borderRadius: 4, padding: '0 5px', marginRight: 6 }}>DESC</span>
              <b>Descriptive only — not validated as a trading signal.</b> EXP-023 measured these
              at residual IC 0.022 or lower, and float rotation at ~0.01, not significant. Useful
              for seeing where supply sits; not for deciding to buy. Only the{' '}
              <b style={{ color: 'var(--text-primary)' }}>residual gap</b> sorted forward returns,
              and only at IC 0.038 — the same modest size EXP-011 already called untradeable.
            </div>

            <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
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

/**
 *  marks a metric that is DESCRIPTIVE ONLY. EXP-023 measured
 * profitSupply at residual IC 0.022 and rotation at ~0.01 (not significant);
 * only the residualised avgCostGap sorted forward returns. Colouring these
 * green and red without saying so reads as a validated signal.
 */
function Row({ k, v, color, desc }: { k: string; v: React.ReactNode; color?: string; desc?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
      <span style={{ color: 'var(--text-muted)' }}>
        {k}
        {desc && <span title="Descriptive estimate — not independently validated as a trading signal"
          style={{ marginLeft: 5, fontSize: 10, fontWeight: 800, color: '#8b949e',
                   border: '1px solid #8b949e55', borderRadius: 4, padding: '0 4px' }}>DESC</span>}
      </span>
      <span style={{ fontWeight: 700, color: color || 'var(--text-primary)' }}>{v}</span>
    </div>
  );
}
