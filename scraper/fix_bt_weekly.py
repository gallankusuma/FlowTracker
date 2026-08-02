#!/usr/bin/env python3
"""Fix weekly/monthly backtest: trading_days must come from resampled data, not raw daily."""

RUNNER = '/var/www/flowtracker-scraper/backtest_runner.py'
with open(RUNNER, 'r') as f:
    rc = f.read()

# The bug: trading_days is built from all_rows (daily) even after resampling
# Fix: rebuild trading_days from resampled ohlc_by_ticker when interval != 1d

old_trading = """    # ── 3. Get trading days in range ──────────────────────────
    trading_days = sorted(set(
        str(r['date'])[:10] for r in all_rows
        if start_date <= str(r['date'])[:10] <= end_date
    ))
    print(f'   📆 {len(trading_days)} trading days, {len(tickers)} tickers')"""

new_trading = """    # ── 3. Get trading days in range ──────────────────────────
    if interval != '1d':
        # For weekly/monthly: use dates from resampled candles
        all_dates = set()
        for t, candles in ohlc_by_ticker.items():
            for c in candles:
                d = str(c['date'])[:10]
                if start_date <= d <= end_date:
                    all_dates.add(d)
        trading_days = sorted(all_dates)
        print(f'   📆 {len(trading_days)} {interval} periods, {len(tickers)} tickers')
    else:
        trading_days = sorted(set(
            str(r['date'])[:10] for r in all_rows
            if start_date <= str(r['date'])[:10] <= end_date
        ))
        print(f'   📆 {len(trading_days)} trading days, {len(tickers)} tickers')"""

if old_trading in rc:
    rc = rc.replace(old_trading, new_trading, 1)
    print("[1] ✅ Fixed trading_days to use resampled dates")
else:
    print("[1] ⚠️ trading_days section not found exactly")

# Also fix MIN_OHLC_BARS — for weekly we need fewer bars
old_min_bars = "            if len(ohlc_cut) < MIN_OHLC_BARS: continue"
new_min_bars = "            min_bars = 15 if interval != '1d' else MIN_OHLC_BARS\n            if len(ohlc_cut) < min_bars: continue"
if old_min_bars in rc:
    rc = rc.replace(old_min_bars, new_min_bars, 1)
    print("[2] ✅ Reduced MIN_OHLC_BARS for weekly/monthly")
else:
    print("[2] ⚠️ MIN_OHLC_BARS check not found")

# Also: for US market with weekly/monthly, the Yahoo fetch also needs resampling
# Currently fetch_yahoo_ohlc always uses interval=1d
# Let's make sure resampling happens for US too
# Check if US path has resampling
if "market == 'US'" in rc:
    # The resampling step at line 922-927 runs AFTER both IDX and US data load,
    # so it should work for both. But let's verify the US data fetch
    # The issue might be that for US+weekly, range is too small
    # Let's also expand the date range for Yahoo fetch when using weekly/monthly
    old_yahoo_range = "start_dt = datetime.strptime(start_date, '%Y-%m-%d') - timedelta(days=365)"
    new_yahoo_range = """# Need more history for weekly/monthly backtests
        extra_days = 730 if interval == '1mo' else 500 if interval == '1wk' else 365
        start_dt = datetime.strptime(start_date, '%Y-%m-%d') - timedelta(days=extra_days)"""
    if old_yahoo_range in rc:
        rc = rc.replace(old_yahoo_range, new_yahoo_range, 1)
        print("[3] ✅ Extended Yahoo fetch range for weekly/monthly")
    else:
        print("[3] ⚠️ Yahoo range not found")

# For IDX DB fetch, also need more history for weekly/monthly
old_db_fetch = "        FROM ft_price_ohlc WHERE date <= %s ORDER BY ticker, date ASC"
# This already fetches ALL data up to end_date, which should be enough
print("[4] ℹ️ IDX DB fetch already gets all historical data")

with open(RUNNER, 'w') as f:
    f.write(rc)

import subprocess
r = subprocess.run(['python3', '-m', 'py_compile', RUNNER], capture_output=True, text=True)
print(f"[PY] {'✅ Syntax OK' if r.returncode == 0 else '❌ ' + r.stderr[:300]}")
