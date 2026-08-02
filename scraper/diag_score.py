#!/usr/bin/env python3
"""
DIAGNOSIS + FIX: 5-layer scoring too strict, almost everything scores < 50.
Root cause: Wyckoff, SMC, Volume Profile layers rarely give full points.
Fix: Recalibrate scoring to be more generous while keeping the 5-layer structure.
"""
import sys, os
sys.path.insert(0, '/var/www/flowtracker-scraper')
import pymysql

DB_CFG = dict(host='localhost', port=3306, user='erp_user', password=os.environ.get('DB_PASSWORD'),
              database='erp_manufacturing', cursorclass=pymysql.cursors.DictCursor)

# First, let's see what scores patterns are getting
from backtest_runner import (resample_ohlc, detect_swings, TF_CONFIG,
                             PATTERN_NAMES, validate_pattern, compute_ratios,
                             compute_fib_score, calc_confluence,
                             detect_wyckoff_phase, detect_order_blocks,
                             detect_fair_value_gaps, detect_liquidity_sweeps,
                             build_volume_profile, check_volume_spike, check_broker_flow)

conn = pymysql.connect(**DB_CFG)
cur = conn.cursor()
cur.execute("SELECT ticker, date, open_price AS `open`, high_price AS high, low_price AS low, close_price AS close, volume FROM ft_price_ohlc WHERE ticker='BBRI' ORDER BY date ASC")
rows = cur.fetchall()
conn.close()

ohlc = [{'date': str(r['date'])[:10], 'open': float(r['open']), 'high': float(r['high']),
         'low': float(r['low']), 'close': float(r['close']), 'volume': float(r['volume'] or 0)} for r in rows]

print(f"BBRI: {len(ohlc)} candles")

# Test each layer individually
wy = detect_wyckoff_phase(ohlc)
obs = detect_order_blocks(ohlc)
fvgs = detect_fair_value_gaps(ohlc)
sweeps = detect_liquidity_sweeps(ohlc)
vp = build_volume_profile(ohlc)
vol_score, vol_detail = check_volume_spike(ohlc)
last_close = ohlc[-1]['close']

print(f"\nLayer scores for BBRI (BULLISH direction):")
print(f"  L2 Wyckoff: phase={wy.get('phase','?')}")
print(f"  L3 SMC: {len(obs)} order blocks, {len(fvgs)} FVGs, sweeps={sweeps}")

in_ob = any(min(o['high'],o['low']) <= last_close <= max(o['high'],o['low']) for o in obs) if obs else False
in_fvg = any(min(f.get('top',0),f.get('bot',0)) <= last_close <= max(f.get('top',0),f.get('bot',0)) for f in fvgs) if fvgs else False
liq = bool(sweeps.get('swept_low') or sweeps.get('swept_high'))
print(f"  L3 detail: in_OB={in_ob}, in_FVG={in_fvg}, liq_sweep={liq}")
print(f"  L4 Volume: spike={vol_detail.get('spike')}, score={vol_score}")
print(f"  L4 VP: poc={vp.get('poc','?')}, VA={vp.get('value_area_low','?')}-{vp.get('value_area_high','?')}")

# Now calc full confluence with fib_score=80
score, detail = calc_confluence(ohlc, 'BBRI', ohlc[-1]['date'], 'BULLISH', {}, 80)
print(f"\n  TOTAL SCORE: {score}")
for k, v in detail.items():
    if k != 'total' and not k.endswith('detail'):
        print(f"    {k}: {v}")
