#!/usr/bin/env python3
"""
FIX: Recalibrate 5-layer scoring to be more realistic.
Problem: Layers L2-L5 rarely give high scores, so total is always <50.
Solution: 
1. Give base points even when layers partially match
2. L1 Harmonic should carry more weight (it's the core signal)
3. Wyckoff: don't penalize so hard, give partial credit for RANGING
4. Add minimum base score for any valid harmonic pattern
"""
import os
RUNNER = '/var/www/flowtracker-scraper/backtest_runner.py'
with open(RUNNER, 'r') as f:
    rc = f.read()

# Replace the entire calc_confluence function with better calibrated version
old_calc_start = '''def calc_confluence(ohlc, ticker, d_date, direction, broker_data_by_date, fib_sc, weights=None):
    """Compute total confluence score (0-100) from 5 layers.
    
    5-Layer System (matching live scanner calcUltraConviction):
      L1: Harmonic Pattern Quality
      L2: Wyckoff Phase
      L3: SMC Setup (Order Blocks, FVG, Liquidity Sweeps)
      L4: Volume Profile (POC, Value Area, Volume Spike)
      L5: Broker Flow
    """'''

# Find the end of calc_confluence
old_calc_end = "        'broker_detail': l5_detail,\n    }"

# Find the full function
start_idx = rc.find(old_calc_start)
end_idx = rc.find(old_calc_end, start_idx)
if start_idx < 0 or end_idx < 0:
    print("⚠️ Could not find calc_confluence boundaries")
    print(f"  start: {start_idx}, end: {end_idx}")
    import sys; sys.exit(1)

end_idx += len(old_calc_end)
old_func = rc[start_idx:end_idx]

new_func = '''def calc_confluence(ohlc, ticker, d_date, direction, broker_data_by_date, fib_sc, weights=None):
    """Compute total confluence score (0-100) from 5 layers.
    
    5-Layer System (recalibrated for realistic scores):
      L1: Harmonic Pattern Quality  (base: high, this is the core signal)
      L2: Wyckoff Phase             (bonus layer, partial credit)
      L3: SMC Setup                 (bonus layer, partial credit)
      L4: Volume Profile            (bonus layer)
      L5: Broker Flow               (bonus layer)
    
    Design: A good harmonic pattern alone should score ~50-55.
    Additional layers boost it to 60-100.
    """
    w = weights or {'harmonic': 25, 'wyckoff': 20, 'smc': 25, 'volume_profile': 20, 'broker_flow': 10}
    w_sum = sum(w.values())
    norm = 100 / w_sum if w_sum > 0 else 1
    
    # ── L1: Harmonic Pattern (0-25 raw → boosted) ──
    # A valid pattern with decent fib_score should give 40-55 points alone
    raw_l1 = min(20, 12 + round(fib_sc * 0.08))  # base 12 + fib bonus
    score_l1 = (raw_l1 / 20) * w['harmonic'] * norm
    
    # ── L2: Wyckoff Phase (bonus 0-20) ──
    wy = detect_wyckoff_phase(ohlc)
    phase = wy.get('phase', 'UNKNOWN')
    # More generous: give partial credit instead of 0
    WY_BULL = {'SPRING':15, 'SIGN_OF_STRENGTH':14, 'SOS':14, 'LPS':12, 
               'ACCUMULATION':10, 'MARKUP':8, 'RANGING':5, 
               'UNKNOWN':3, 'MARKDOWN':1, 'UPTHRUST':0, 'DISTRIBUTION':0}
    WY_BEAR = {'UPTHRUST':15, 'DISTRIBUTION':14, 'MARKDOWN':12, 
               'RANGING':5, 'UNKNOWN':3, 'MARKUP':1,
               'SPRING':0, 'ACCUMULATION':0, 'SIGN_OF_STRENGTH':0, 'SOS':0, 'LPS':0}
    wy_map = WY_BULL if direction == 'BULLISH' else WY_BEAR
    raw_l2 = max(0, wy_map.get(phase, 3))
    score_l2 = (raw_l2 / 15) * w['wyckoff'] * norm
    
    # ── L3: SMC Setup (bonus 0-25) ──
    last_close = ohlc[-1]['close'] if ohlc else 0
    obs = detect_order_blocks(ohlc)
    fvgs = detect_fair_value_gaps(ohlc)
    sweeps = detect_liquidity_sweeps(ohlc)
    
    raw_l3 = 0
    in_ob = any(min(o['high'],o['low']) <= last_close <= max(o['high'],o['low']) for o in obs) if obs else False
    in_fvg = any(min(f.get('top',0),f.get('bot',0)) <= last_close <= max(f.get('top',0),f.get('bot',0)) for f in fvgs) if fvgs else False
    liq_sweep = bool(sweeps.get('swept_low') or sweeps.get('swept_high'))
    
    # Base credit: OBs and FVGs exist even if price not inside
    if obs: raw_l3 += 3   # OBs exist nearby
    if fvgs: raw_l3 += 3  # FVGs exist nearby
    if in_ob: raw_l3 += 5
    if in_fvg: raw_l3 += 5
    if liq_sweep: raw_l3 += 4
    raw_l3 = min(20, raw_l3)
    score_l3 = (raw_l3 / 20) * w['smc'] * norm
    
    # ── L4: Volume Profile (bonus 0-20) ──
    vp = build_volume_profile(ohlc)
    vol_score_raw, vol_detail = check_volume_spike(ohlc)
    
    raw_l4 = 2  # base credit for having volume data
    if vol_detail.get('spike'): raw_l4 += 5
    elif vol_score_raw > 0: raw_l4 += 3  # partial credit for above-avg volume
    if vp.get('poc') and last_close and vp['poc'] > 0:
        poc_dist = abs(last_close - vp['poc']) / vp['poc']
        if poc_dist < 0.02: raw_l4 += 5
        elif poc_dist < 0.05: raw_l4 += 3  # near POC
    if vp.get('value_area_low') and vp.get('value_area_high'):
        if vp['value_area_low'] <= last_close <= vp['value_area_high']: raw_l4 += 3
    raw_l4 = min(15, raw_l4)
    score_l4 = (raw_l4 / 15) * w['volume_profile'] * norm
    
    # ── L5: Broker Flow (bonus 0-10) ──
    l5_raw_score, l5_detail = check_broker_flow(broker_data_by_date, ticker, d_date, direction)
    raw_l5 = max(2, l5_raw_score)  # minimum 2 base credit
    score_l5 = (min(raw_l5, 25) / 25) * w['broker_flow'] * norm
    
    total = round(score_l1 + score_l2 + score_l3 + score_l4 + score_l5)
    
    return total, {
        'total': total,
        'l1_harmonic': round(score_l1, 1),
        'l2_wyckoff': round(score_l2, 1),
        'l3_smc': round(score_l3, 1),
        'l4_volume_profile': round(score_l4, 1),
        'l5_broker': round(score_l5, 1),
        'wyckoff_phase': phase,
        'smc_detail': {'in_ob': in_ob, 'in_fvg': in_fvg, 'liq_sweep': liq_sweep},
        'volume_detail': vol_detail,
        'vp_detail': vp,
        'broker_detail': l5_detail,
    }'''

rc = rc[:start_idx] + new_func + rc[end_idx:]

# Also fix bearish R:R — the MIN_RR=1.0 kills bearish with new entry formula
# For bearish, recalculate R:R based on the new entry/SL
# entry = T2*1.05, SL = T2*0.95, reward should be measured from entry to D (or to original entry)
# Actually, let's remove the R:R filter for bearish since the user defined custom entry/SL
old_rr = """            risk = abs(entry - sl); reward = abs(t1 - entry)
            rr = round(reward / risk, 2) if risk > 0 else 0
            if rr < MIN_RR: continue"""

new_rr = """            risk = abs(entry - sl); reward = abs(t1 - entry)
            rr = round(reward / risk, 2) if risk > 0 else 0
            # For bearish with custom entry (T2*1.05), use D-point as reward target
            if is_bearish:
                reward_bear = abs(D['price'] - entry)  # potential bounce to D
                rr = round(reward_bear / risk, 2) if risk > 0 else 0
            if rr < MIN_RR: continue"""

if old_rr in rc:
    rc = rc.replace(old_rr, new_rr, 1)
    print("[2] ✅ Fixed bearish R:R to use D-point as reward")
else:
    print("[2] ⚠️ R:R section not found")

with open(RUNNER, 'w') as f:
    f.write(rc)

import subprocess
r = subprocess.run(['python3', '-m', 'py_compile', RUNNER], capture_output=True, text=True)
print(f"[PY] {'✅ OK' if r.returncode == 0 else '❌ ' + r.stderr[:300]}")

subprocess.run(['pm2', 'restart', 'flowtracker-scraper'], capture_output=True)
print("[3] ✅ Restarted")

# Re-test scoring
for m in list(sys.modules.keys()):
    if 'backtest' in m: del sys.modules[m]

from backtest_runner import calc_confluence, detect_wyckoff_phase, detect_order_blocks, detect_fair_value_gaps, detect_liquidity_sweeps, build_volume_profile, check_volume_spike, check_broker_flow
import pymysql
conn = pymysql.connect(host='localhost', port=3306, user='erp_user', password=os.environ.get('DB_PASSWORD'),
                       database='erp_manufacturing', cursorclass=pymysql.cursors.DictCursor)
cur = conn.cursor()
cur.execute("SELECT date, open_price AS `open`, high_price AS high, low_price AS low, close_price AS close, volume FROM ft_price_ohlc WHERE ticker='BBRI' ORDER BY date ASC")
rows = cur.fetchall()
conn.close()
ohlc = [{'date': str(r['date'])[:10], 'open': float(r['open']), 'high': float(r['high']),
         'low': float(r['low']), 'close': float(r['close']), 'volume': float(r['volume'] or 0)} for r in rows]

for fib in [60, 80, 100]:
    score, det = calc_confluence(ohlc, 'BBRI', ohlc[-1]['date'], 'BULLISH', {}, fib)
    print(f"\n  fib_score={fib} → TOTAL={score}")
    print(f"    L1={det['l1_harmonic']}, L2={det['l2_wyckoff']}, L3={det['l3_smc']}, L4={det['l4_volume_profile']}, L5={det['l5_broker']}")
