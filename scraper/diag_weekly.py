#!/usr/bin/env python3
"""Quick diagnostic: test weekly backtest to verify patterns get found."""
import sys, time, os
sys.path.insert(0, '/var/www/flowtracker-scraper')
import pymysql

DB_CFG = dict(
    host='localhost', port=3306,
    user='erp_user', password=os.environ.get('DB_PASSWORD'),
    database='erp_manufacturing',
    cursorclass=pymysql.cursors.DictCursor
)

from backtest_runner import resample_ohlc, detect_swings, detect_harmonic_patterns, TF_CONFIG

conn = pymysql.connect(**DB_CFG)
cur = conn.cursor()

cur.execute("""
    SELECT ticker, date, open_price AS `open`, high_price AS high,
           low_price AS low, close_price AS close, volume
    FROM ft_price_ohlc WHERE ticker='BBRI' ORDER BY date ASC
""")
rows = cur.fetchall()
conn.close()

daily = [{'date': str(r['date'])[:10], 'open': float(r['open']), 'high': float(r['high']),
          'low': float(r['low']), 'close': float(r['close']), 'volume': float(r['volume'] or 0)}
         for r in rows]

print(f"BBRI daily: {len(daily)} candles ({daily[0]['date']} to {daily[-1]['date']})")

for tf in ['1d', '1wk', '1mo']:
    cfg = TF_CONFIG.get(tf, {})
    data = resample_ohlc(daily, tf)
    print(f"\n{'='*60}")
    print(f"Timeframe: {tf} -> {len(data)} candles")
    print(f"  Config: d_age={cfg.get('max_d_age')}, swing_th={cfg.get('swing_threshold')}")
    
    swings = detect_swings(data, cfg.get('swing_threshold', 0.04), 20)
    print(f"  Swings found: {len(swings)}")
    
    if len(data) >= 15:
        scan_date = data[-1]['date']
        patterns = detect_harmonic_patterns(data, 'BBRI', {}, scan_date, 0, cfg)
        print(f"  Patterns found (min_score=0): {len(patterns)}")
        for p in patterns[:3]:
            print(f"    {p['pattern_type']} {p['direction']} D={p['D_date']} score={p.get('conviction_score', '?')}")
    else:
        print(f"  Not enough candles")

print("\nDone!")
