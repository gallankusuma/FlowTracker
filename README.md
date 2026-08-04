# FlowTracker

Broker-flow ("bandarmology") analysis and systematic-strategy research for the
Indonesia Stock Exchange (IDX).

**Status: research. No strategy in this repository has demonstrated a tradeable
edge.** That statement is the point of the project, not an apology for it — see
[Research findings](#research-findings).

---

## Layout

| Path | What it is |
|---|---|
| `app/` | Next.js 16 frontend, all client-rendered. One page per feature. |
| `lib/`, `components/` | Shared frontend helpers; `lib/apiConfig.ts` is the API base wiring. |
| `scraper/` | The backend. `server.js` (~7.3k lines, Express on :3100) plus the AWO factor engine, the optimizer, and every backtest script. |
| `scraper/modules/` | Shared logic: factor formulas, scoring, regime, trade policy, cross-sectional stats, strategy book. |
| `BACKTEST_EXPERIMENTS.md` | **The most important file here.** Append-only registry of every experiment run against real data — including the ones that failed. |

Three documents carry the design history: `AWO Engine.md` (the factor engine spec),
`Advance.md` (process discipline), `Comment.md` (the original external critique).
`scraper/CRONTAB.md` documents the system crontab.

## Running it

The backend needs MySQL and a `.env` (see `scraper/.env.example`). Nothing in this
repository contains credentials.

```bash
cd scraper && npm install && npm test   # 9 files, 165 tests
node server.js                          # :3100
```

```bash
npm install && npm run dev              # frontend, :3000
```

Backtests connect to the database directly and are read-only:

```bash
cd scraper
node backtest_momentum_lookback_ic.js   # factor IC grid
node backtest_broker_veto.js            # the current candidate strategy
```

## Three schedulers, not one

Reading any one of them gives a wrong picture of what this system does:

1. **PM2** keeps the frontend and backend alive.
2. **`scheduleDailyCron()` inside `server.js`** runs the nightly IDX data pull,
   concentration calculation, harmonic scan and the AWO learning pipeline.
3. **The system crontab** runs a Python subsystem — paper trading, a signal
   engine, and a Hong Kong market layer — that neither of the above knows about.
   Documented in `scraper/CRONTAB.md`.

## Research findings

Twenty experiments, most of them negative. The registry records failures at the
same length as successes, because a method that only records what worked cannot
tell you when to stop.

- **The flagship 14-factor AWO composite performs worse than random entry** after
  costs, replicated across two independent periods and 63 parameter combinations
  (EXP-001..004). Live weights have never been changed from the defaults.
- **Proximity to the 52-week high** is the only price factor with consistent
  positive information coefficient (EXP-011), but its edge is very nearly consumed
  by its own turnover (EXP-012) and a walk-forward falsifies any parameter choice
  fitted on the full sample (EXP-013).
- **Persistent broker "accumulation" predicts UNDERperformance** — the strongest
  relationship found anywhere in this project, with the sign inverted from the
  conventional reading (EXP-016). Applied as a veto it passes every mechanical
  control, including a reverse-signal control (EXP-017) — but on the corrected
  point-in-time universe it does **not** produce positive excess in both halves
  of the sample, and its low-dose response is not monotone (EXP-020). It is the
  best candidate here and it is not proven.
- **Per-position stops and inverse-volatility sizing both make things worse.** The
  only risk layer that transfers out of sample is a plain 200-day moving-average
  market filter (EXP-014).
- **Same-day entry and exit is structurally negative on IDX**, at every stop and
  target width tested, and the system's own BUY days are *worse* than the market
  average, not better (EXP-019).
- **The broker veto carries the strategy.** Switching each component off in turn,
  the 52-week-high ranking alone returns −0.88% — close to worthless — while the
  veto adds ~18pp on top of ranking plus timing. The timing layer costs return
  and buys drawdown protection.
- The current candidate is being **forward-tested**, and the live record is
  currently **empty by design**: the forward test has made one frozen plan and
  no live fills. The often-quoted profit factor of **0.72 is a REPLAY figure**,
  produced by seeding the ledger from history, and replayed decisions are now
  excluded from the promotion gate entirely. There is no live number yet, and
  the candidate will not be tuned to produce one.

## Conventions that exist for a reason

- **Append-only registry.** Entries are never edited. A wrong result gets a new
  entry that says so; the old one stays.
- **Costs are always applied**: 0.15% buy + 0.25% sell + 0.10% slippage.
- **No lookahead.** Factors use data through the decision bar only, entries fill at
  the next open, and same-bar stop/target ambiguity resolves to the stop.
- **Score parameter sets by the mean and median across all of them**, never by the
  best one. The best cell is an upper bound chosen with hindsight.
- **Every claimed effect gets a control.** A filter is compared against a random
  filter of the same size; a directional signal against its own reverse.
