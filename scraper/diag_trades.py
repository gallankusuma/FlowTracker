#!/usr/bin/env python3
"""Diagnose why no trades appear: check R:R filter and confluence scores."""
import sys, os
sys.path.insert(0, '/var/www/flowtracker-scraper')
import pymysql
from backtest_runner import (resample_ohlc, detect_swings, detect_harmonic_patterns,
                             TF_CONFIG, PATTERN_NAMES, validate_pattern, compute_ratios,
                             compute_fib_score, calc_confluence, MIN_RR, SWING_THRESHOLD, MAX_SWINGS)

DB_CFG = dict(host='localhost', port=3306, user='erp_user', password=os.environ.get('DB_PASSWORD'),
              database='erp_manufacturing', cursorclass=pymysql.cursors.DictCursor)

conn = pymysql.connect(**DB_CFG)
cur = conn.cursor()
cur.execute("""SELECT ticker, date, open_price AS `open`, high_price AS high,
               low_price AS low, close_price AS close, volume
               FROM ft_price_ohlc ORDER BY ticker, date ASC""")
rows = cur.fetchall()
conn.close()

ohlc_by_ticker = {}
for r in rows:
    t = r['ticker']
    d = str(r['date'])[:10]
    ohlc_by_ticker.setdefault(t, []).append({
        'date': d, 'open': float(r['open']), 'high': float(r['high']),
        'low': float(r['low']), 'close': float(r['close']), 'volume': float(r['volume'] or 0)
    })

print(f"Loaded {len(ohlc_by_ticker)} tickers\n")

# Run with min_score=0 to see ALL patterns without filtering
tf = '1d'
cfg = TF_CONFIG.get(tf, {})
total_found = 0
rr_filtered = 0
score_filtered = 0
bearish_rr_issue = 0

for ticker, daily in list(ohlc_by_ticker.items())[:50]:  # first 50 tickers
    scan_date = daily[-1]['date']
    # Call with min_score=0 to bypass score filter  
    patterns = detect_harmonic_patterns(daily, ticker, {}, scan_date, 0, cfg)
    for p in patterns:
        total_found += 1
        if p.get('conviction_score', 0) < 50:
            score_filtered += 1
        if p.get('risk_reward', 0) < MIN_RR:
            rr_filtered += 1
        if p['direction'] == 'BEARISH':
            bearish_rr_issue += 1
            if total_found <= 5:
                print(f"  {ticker} {p['pattern_type']} {p['direction']}")
                print(f"    Entry={p['entry_price']}, SL={p['stop_loss']}, T1={p['target_1']}, T2={p['target_2']}")
                print(f"    R:R={p.get('risk_reward')}, Score={p.get('conviction_score')}")

print(f"\n=== SUMMARY (50 tickers, daily) ===")
print(f"  Total patterns found (min_score=0): {total_found}")
print(f"  Bearish patterns: {bearish_rr_issue}")
print(f"  R:R < {MIN_RR}: {rr_filtered}")
print(f"  Score < 50: {score_filtered}")
print(f"  MIN_RR = {MIN_RR}")
