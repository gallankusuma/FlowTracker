# System crontab on the production VPS

**Captured 2026-08-02 from `root@76.13.22.155` (`crontab -l`).** Committed here because
it was previously undocumented anywhere, and a schedule that exists only inside a
server's crontab is one reinstall away from being lost silently.

## Why this matters

There are **three** independent schedulers on this box, and reading any one of them
gives a wrong picture of what the system does:

1. **PM2** — keeps `flowtracker` (Next.js, :3201) and `flowtracker-scraper` (Express, :3100) alive.
2. **`scheduleDailyCron()` inside `server.js`** — a 30-second `setInterval` that fires once
   per weekday after 12:30 UTC (19:30 WIB) and runs the IDX data pull, concentration
   calculation, harmonic scan and the 5-step AWO learning pipeline.
3. **This system crontab** — a Python subsystem that neither of the above knows about.

A 2026-08-02 code study that examined only PM2 and `server.js` reached two conclusions
that this file disproves:

- *"`paper_trader.py` is orphaned — the `/api/paper-trading/*` endpoints have no frontend
  consumer."* It is not orphaned. It runs **eight times a day**, on cron, for both IDX and
  US, through a full plan → open → check → settle lifecycle.
- *"Nothing in the repo writes `ft_signals`; the generator lives outside this codebase."*
  The generator is `run_signals.py`, and it runs here twice daily.

There is also an entire **Hong Kong market layer** (`hk_fetcher.py`, `signal_engine.py hk`)
that appears nowhere else in the codebase or its documentation.

All Python runs under `/var/www/flowtracker-scraper/.venv/bin/python3` — a virtualenv that
exists only on the VPS.

## Schedule (times are UTC; WIB = UTC+7)

### flowtracker.id concentration pull — REMOVED 2026-08-03
Two entries used to call `ft_pull.sh` (→ `/api/ft-pull`) at 17:30 and 18:00 WIB.
Both are gone, for two independent reasons:

1. The flowtracker.id account was banned, so the pull cannot succeed.
2. They were never doing useful work anyway. On failure `/api/ft-pull` fell
   through to `autoCalculateConcentration()`, but 17:30/18:00 WIB is *before*
   the 19:30 WIB IDX data pull, so there was nothing to calculate from — every
   run returned `stocks: 0`, and returned it as `success: true`. Concentration
   has always actually been produced by the nightly job below, which calls
   `autoCalculateConcentration()` as its PRIMARY step after the data lands.

Concentration needs no replacement entry. `POST /api/calc-concentration` is the
manual equivalent if a specific date ever needs recomputing.

### Signal engine — writes `ft_signals`
```
 0  0 * * 1-5   run_signals.py morning                          # 07:00 WIB
30 12 * * 1-5   run_signals.py evening                          # 19:30 WIB
```

### Market intel — sentiment + macro (US)
```
30 12    * * 1-5   market_intel_fetcher.py us                   # pre-market refresh
*/15 13-21 * * 1-5 market_intel_fetcher.py us                   # every 15min, US hours
```

### Hong Kong layer
```
30  1 * * 1-5   hk_fetcher.py macro                             # 09:30 HKT
 0  8 * * 1-5   signal_engine.py hk --hk                        # 16:00 HKT
30  8 * * 1-5   hk_fetcher.py scan                              # 16:30 HKT close scan
```

### Paper trading lifecycle — `ft_virtual_trades`
```
# US
30 12    * * 1-5   paper_trader.py plan us                      # 19:30 WIB
30 14    * * 1-5   paper_trader.py open us                      # 21:30 WIB
*/30 14-21 * * 1-5 paper_trader.py check us
15 21    * * 1-5   paper_trader.py settle us                    # 04:15 WIB

# IDX
 0  0   * * 1-5   paper_trader.py plan idx                      # 07:00 WIB
 0  2   * * 1-5   paper_trader.py open idx                      # 09:00 WIB
*/30 2-9 * * 1-5  paper_trader.py check idx
 0  9   * * 1-5   paper_trader.py settle idx                    # 16:00 WIB
```

### IHSG index history — `idx_ihsg_history`
```
 5 13 * * 1-5   node refresh_ihsg.js                           # 20:05 WIB
```
**Moved from 20:10 to 20:05 on 2026-08-05, and the five minutes matter.**
`virtual_portfolio.js loadBars()` now takes its session axis from this table, so
it must be current BEFORE `resolve` runs. It was not: resolve sat at 20:00 and
this at 20:10, so on any evening the index had not refreshed, today's session was
not on the axis, every order silently went unfilled, and the trade was booked a
day late with a NAV history that never showed the position on the day it was
actually held. `cmdResolve` now also refuses outright with
`SESSION_CALENDAR_STALE` rather than trusting the schedule — an ordering that
exists only in a crontab is one edit away from being wrong, silently.
Added 2026-08-04, and it runs BEFORE the forward cycle below on purpose: the
200-day SMA regime filter reads this table, and a plan decided on a stale index
is a plan decided on the wrong regime.

Until this existed the series had no scheduled refresh at all. `fetchAndCacheIHSG()`
lived in server.js and ran only when someone hit `/api/ihsg`, `/api/ihsg-factors`,
`/api/signal-scanner` or POSTed `/api/sectors/pull-broker` — and no cron entry
calls an HTTP endpoint, so freshness depended on a human opening a page.

It was worse than that. The function compared `String(dateColumn).split('T')[0]`
— which on a Date yields `"Fri Jul 31 2026 07:00:00 GM"`, with no `T` to split
on — against an ISO date. Weekday names start with letters, letters sort above
digits, so the guard was true for any existing row and the function returned
`{ skipped: true }` every time it was called. The data in the table came from a
manual backfill, which is why it stopped on the day that backfill ran.

A separate process rather than a step inside server.js's nightly job,
deliberately: that job would carry it fine right up until the PM2 process is
unhealthy, which is exactly when a stale regime filter does the most damage.
The script exits non-zero if the series is still behind `idx_stock_prices`.

### EXP-017 forward paper test — `ft_strategy_plan` / `ft_strategy_positions` / `ft_strategy_log` / `ft_strategy_nav`
```
15 13 * * 1-5   node strategy_forward.js fill                  # 20:15 WIB
20 13 * * 1-5   node strategy_forward.js plan                  # 20:20 WIB
25 13 * * 1-5   node strategy_forward.js mark                  # 20:25 WIB
```
Split into three stages 2026-08-03 (review P0.3). Each is independently
observable and independently retryable, and the order is load-bearing: `fill`
settles the previous plan into real positions first, so `plan` decides against
the true book rather than a stale one. Running `node strategy_forward.js` with
no subcommand does all three in that order, which is the safe fallback.

**Why all three run in the evening rather than plan-after-close and
fill-after-open.** The review asked for `fill` to run after the next market
open, and with a live price feed that would be right. This system holds
end-of-day data only: the T+1 open does not enter `idx_stock_prices` until that
evening's 19:30 WIB pull. A `fill` scheduled for 10:00 WIB would find no new
data and do nothing — the same shape of mistake as the retired `ft-pull` cron,
which ran at 17:30 WIB, before the data it needed existed, and reported success
anyway. So `fill` runs the evening AFTER the plan it settles, once the bar has
genuinely landed.

That preserves the property the split exists for: the plan is written to the
database before the price that executes it is observable anywhere in this
system. What it cannot establish is real intraday slippage, queue position or
broker rejection — those need a live feed and a broker, and this system has
neither. The `implementation shortfall` figure `fill` reports is
decision-close-to-execution-open, not a fill-quality measurement.

Runs **daily on purpose** even though the strategy rebalances
biweekly: `strategy_forward.js` owns its own cadence internally (it refuses to
decide until `REBAL_BARS` trading days have passed since the last recorded
decision), so a missed day is simply retried the next morning and the strategy
being tested is unaffected. Leaving the cadence to the cron schedule would have
meant a weekly cron silently running a weekly-rebalance strategy — a *different*
strategy from the one EXP-017 tested, with different turnover and costs.

Records intentions only. It places no orders and touches no broker.

### Virtual portfolio — `virtual_accounts` / `virtual_orders` / `virtual_positions` / `virtual_trade_events` / `virtual_nav`
```
10 13 * * 1-5   node virtual_portfolio.js resolve               # 20:10 WIB
30 13 * * 1-5   node virtual_portfolio.js schedule              # 20:30 WIB
35 13 * * 1-5   node virtual_portfolio.js mark                  # 20:35 WIB
40 13 * * 1-5   node virtual_portfolio.js reconcile             # 20:40 WIB
```

**The whole nightly chain, in dependency order (WIB):**
```
19:30  prices land (server.js nightly cron)
20:05  refresh_ihsg      writes the session calendar
20:10  virtual resolve   READS that calendar - must come after it
20:15  forward fill
20:20  forward plan      writes ft_strategy_plan
20:25  forward mark
20:30  virtual schedule  READS that plan - must come after it
20:35  virtual mark
20:40  virtual reconcile
20:50  watchdog          checks what all of the above actually produced
```
Added 2026-08-04. Two simulated Rp100 juta accounts, `POSITION_100M` and
`INTRADAY_EOD_100M`, driven by the same recommendations under different exit
policies. Logs to `/var/log/virtual-portfolio.log`.

**The order is load-bearing, and it is not the order the design proposed.** The
design asked for `resolve` at 20:00 and the orders created at 20:20. But
`schedule` reads the latest row in `ft_strategy_plan`, which the existing
`strategy_forward.js plan` entry does not write until 20:20 — scheduling at
20:20 would race it, and scheduling earlier would freeze *yesterday's* plan a
second time. So `schedule` sits at 20:30, after the plan it consumes exists.
`resolve` stays at 20:00 because it depends only on the 19:30 price pull, and
today's orders must be settled before tomorrow's are created.

`reconcile` is not a printout. It checks that cash equals starting capital minus
open cost plus realized P&L, that the last NAV mark equals cash + market value,
that exposure and the position count are inside their caps, and that no FILLED
order lacks a position or belongs to another account. It exits non-zero when any
of that stops being true.

**A changed execution contract retires the old account rather than running
beside it.** `execution_policy_hash` covers the fees, slippage, exit rule and the
whole risk layer, and the unique key is `(account_code, execution_policy_hash)`,
so changing any of them inserts a NEW account row next to the old one. Both were
ACTIVE on the first day this ran and every stage executed twice against four
accounts. `setup()` now closes any account whose contract is no longer current —
CLOSED, never deleted, because its orders and NAV history are the record of what
that contract did.

`INTRADAY_EOD_100M` is **expected to lose**: EXP-019 measured that rule at
-0.951% per trade on this system's own BUY days (n=2,204, t=-18.5) against a
-0.673% unconditional base rate. It runs to confirm that forward and must not be
tuned until it stops losing.

Simulated accounts. No orders are placed anywhere.

### Watchdog — `ft_system_health`
```
50 13 * * 1-5   node watchdog.js                                # 20:50 WIB
```
Added 2026-08-04, and it runs LAST on purpose: it checks what the other stages
actually produced, not whether they reported producing it. **A job that crashes
cannot report that it crashed** — `strategy_forward.js fill` died at `setup()`
that same evening while the two later stages ran clean, and nothing looked wrong
the next morning. Logs to `/var/log/watchdog.log`.

It repairs only what is idempotent, sourced from real upstream data, and
verifiable afterwards — an IHSG refetch qualifies; interpolating a missing bar
does not, because a fabricated close makes the regime filter confident about a
session that never happened.

**A fault that self-heals every night is a bug in hiding.** Repairs are recorded,
and one that fires on 3 of the last 7 days is reported as `RECURRING` — a
failure, even though the repair itself worked. A watchdog that quietly patches
the same thing forever has converted a loud bug into a silent one, which is the
disease it exists to treat.

What it found on its first run:

- **Holes behind the latest bar.** `idx_ihsg_history` was missing sessions in the
  middle while `MAX(date)` was perfectly current, so every freshness check stayed
  green. Worse, `refreshIHSG` skipped whenever `MAX(date)` reached the last closed
  session, which made each hole **permanent**. The guard now asks about holes too.
- **72 dates in `idx_stock_prices` that cannot be trading sessions** — 10 weekends
  and the rest IDX public holidays carrying `open=high=low=close` with zero volume,
  several of them verbatim copies of the previous date. Every rolling window here
  counts BARS (ADV20, ATR14, the 252-day high, the 200-day SMA), so each phantom
  shifts all of them and the return across one is 0% by construction. Reported,
  never auto-deleted: dropping production price rows is irreversible and
  re-ingesting the range may be the better fix. That is a decision, not a repair.

**The index source is the trading calendar.** `^JKSE` is the exchange's own index,
so a date it has no bar for was not a session. Without that rule the gap check
demanded an index close for every public holiday, no refetch could ever supply
one, and it would have failed every night forever — which is how a monitor
teaches people to ignore it.

## Log files

`/var/log/ft-pull.log`, `/var/log/signal_engine.log`, `/var/log/flowtracker-intel.log`,
`/var/log/flowtracker-hk.log`, `/var/log/paper-trader.log,
`/var/log/strategy-forward.log`, `/var/log/virtual-portfolio.log`, `/var/log/watchdog.log`

## Note on "paper trading"

This is the **third** distinct thing in the project called paper trading, and they are
unrelated:

| name | table | driver |
|---|---|---|
| `paper_trader.py` | `ft_virtual_trades` | this crontab |
| AWO challenger paper trading | `awo_paper_trades` | `server.js` nightly cron |
| auto-journal | `ft_recommendations` | `server.js` nightly cron |

Do not read a metric from one and attribute it to another.
