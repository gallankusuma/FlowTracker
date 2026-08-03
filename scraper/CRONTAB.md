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

## Log files

`/var/log/ft-pull.log`, `/var/log/signal_engine.log`, `/var/log/flowtracker-intel.log`,
`/var/log/flowtracker-hk.log`, `/var/log/paper-trader.log`

## Note on "paper trading"

This is the **third** distinct thing in the project called paper trading, and they are
unrelated:

| name | table | driver |
|---|---|---|
| `paper_trader.py` | `ft_virtual_trades` | this crontab |
| AWO challenger paper trading | `awo_paper_trades` | `server.js` nightly cron |
| auto-journal | `ft_recommendations` | `server.js` nightly cron |

Do not read a metric from one and attribute it to another.
