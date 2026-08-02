#!/usr/bin/env python3
"""Check bearish in latest backtest results + debug why none appear."""
import pymysql, sys, os
sys.path.insert(0, '/var/www/flowtracker-scraper')

conn = pymysql.connect(host='localhost', port=3306, user='erp_user', password=os.environ.get('DB_PASSWORD'),
                       database='erp_manufacturing', cursorclass=pymysql.cursors.DictCursor)
cur = conn.cursor()

# Check latest runs
cur.execute("SELECT run_id, direction, COUNT(*) as cnt FROM ft_backtest_results GROUP BY run_id, direction ORDER BY run_id DESC LIMIT 10")
for r in cur.fetchall():
    print(f"  {r['run_id'][:12]}... {r['direction']}: {r['cnt']}")

print("\n=== Bearish debug ===")
from backtest_runner import detect_swings, TF_CONFIG, PATTERN_NAMES, validate_pattern, compute_ratios, MIN_RR

cur.execute("SELECT date, open_price AS `open`, high_price AS high, low_price AS low, close_price AS close, volume FROM ft_price_ohlc WHERE ticker='BBRI' ORDER BY date ASC")
rows = cur.fetchall()
ohlc = [{'date': str(r['date'])[:10], 'open': float(r['open']), 'high': float(r['high']),
         'low': float(r['low']), 'close': float(r['close']), 'volume': float(r['volume'] or 0)} for r in rows]

cfg = TF_CONFIG.get('1d', {})
swings = detect_swings(ohlc, cfg.get('swing_threshold', 0.04), 20)
print(f"BBRI: {len(ohlc)} candles, {len(swings)} swings")
print(f"Swing types: {[s['type'] for s in swings]}")

bull = 0; bear = 0; bear_guard = 0; bear_rr = 0

for i in range(len(swings) - 4):
    X, A, B, C, D = swings[i:i+5]
    is_bullish = (X['type']=='L' and A['type']=='H' and B['type']=='L' and C['type']=='H' and D['type']=='L')
    is_bearish = (X['type']=='H' and A['type']=='L' and B['type']=='H' and C['type']=='L' and D['type']=='H')
    
    if not is_bullish and not is_bearish: continue
    
    ratios = compute_ratios(X, A, B, C, D)
    for pat_name in PATTERN_NAMES:
        if not validate_pattern(pat_name, ratios): continue
        
        if is_bullish:
            bull += 1
        else:
            bear += 1
            swing_range = abs(D['price'] - A['price'])
            t1 = D['price'] - swing_range * 0.382
            t2 = D['price'] - swing_range * 0.618
            entry = t2 * 1.05
            sl = t2 * 0.95
            
            print(f"\n  Found BEARISH {pat_name}:")
            print(f"    D={D['price']:.0f} A={A['price']:.0f} range={swing_range:.0f}")
            print(f"    T1={t1:.0f} T2={t2:.0f}")
            print(f"    Entry(T2*1.05)={entry:.0f} SL(T2*0.95)={sl:.0f}")
            
            if entry <= sl:
                bear_guard += 1
                print(f"    ❌ GUARD: entry({entry:.0f}) <= sl({sl:.0f})")
                continue
            if t2 >= t1:
                bear_guard += 1
                print(f"    ❌ GUARD: t2({t2:.0f}) >= t1({t1:.0f})")
                continue
            
            risk = abs(entry - sl)
            reward = abs(D['price'] - entry)
            rr = round(reward / risk, 2) if risk > 0 else 0
            print(f"    Risk={risk:.0f} Reward(to D)={reward:.0f} R:R={rr}")
            if rr < MIN_RR:
                bear_rr += 1
                print(f"    ❌ R:R {rr} < MIN_RR {MIN_RR}")
            else:
                print(f"    ✅ PASSES ALL FILTERS!")

print(f"\nSummary: {bull} bullish, {bear} bearish raw")
print(f"  Bearish guard filtered: {bear_guard}")
print(f"  Bearish R:R filtered: {bear_rr}")
print(f"  Bearish passing: {bear - bear_guard - bear_rr}")
conn.close()
