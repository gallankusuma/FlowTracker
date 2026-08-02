#!/usr/bin/env python3
"""
MAJOR UPDATE: Upgrade backtest_runner.py from 4-layer to 5-layer scoring
to match the live scanner (harmonicEngine.js calcUltraConviction).

New 5-Layer System:
  L1: Harmonic Pattern Quality (weight: editable, default 25)
  L2: Wyckoff Phase            (weight: editable, default 20)
  L3: SMC Setup                (weight: editable, default 25)
  L4: Volume Profile           (weight: editable, default 20)
  L5: Broker Flow              (weight: editable, default 10)

Changes:
1. backtest_runner.py: Replace old calc_confluence with 5-layer version
2. backtest_runner.py: Accept weights from argv
3. server.js: Accept weights in /api/backtest/run
4. page.tsx: Add weight sliders to backtest UI
"""
import re, json

# ═══════════════════════════════════════════════════
# PART 1: Update backtest_runner.py
# ═══════════════════════════════════════════════════
RUNNER = '/var/www/flowtracker-scraper/backtest_runner.py'
with open(RUNNER, 'r') as f:
    rc = f.read()

# 1a. Add Wyckoff, SMC, Volume Profile detection functions
# These are Python ports of the JS functions in harmonicEngine.js

new_functions = '''
# ═══════════════════════════════════════════════════════════════
# LAYER 2 — WYCKOFF PHASE DETECTION (port of harmonicEngine.js)
# ═══════════════════════════════════════════════════════════════

def detect_wyckoff_phase(ohlc, lookback=50):
    """Detect Wyckoff accumulation/distribution phase."""
    if len(ohlc) < lookback:
        return {'phase': 'UNKNOWN'}
    
    recent = ohlc[-lookback:]
    closes = [c['close'] for c in recent]
    volumes = [c['volume'] for c in recent]
    highs = [c['high'] for c in recent]
    lows = [c['low'] for c in recent]
    
    avg_vol = sum(volumes) / len(volumes) if volumes else 1
    price_range = max(highs) - min(lows) if highs else 1
    mid_price = (max(highs) + min(lows)) / 2
    last_close = closes[-1]
    
    # Check for ranging (low volatility)
    recent_range = max(closes[-10:]) - min(closes[-10:]) if len(closes) >= 10 else price_range
    is_ranging = recent_range / mid_price < 0.05  # < 5% range
    
    # Volume analysis
    recent_vol = sum(volumes[-5:]) / 5 if len(volumes) >= 5 else avg_vol
    vol_expanding = recent_vol > avg_vol * 1.3
    
    # Price position
    at_lows = last_close < min(lows) + price_range * 0.3
    at_highs = last_close > max(highs) - price_range * 0.3
    
    # Trend
    if len(closes) >= 20:
        sma20 = sum(closes[-20:]) / 20
        trending_up = last_close > sma20
        trending_down = last_close < sma20
    else:
        trending_up = trending_down = False
    
    # Spring detection: price dips below support then recovers
    if len(closes) >= 5:
        recent_low = min(lows[-5:])
        prior_low = min(lows[:-5]) if len(lows) > 5 else recent_low
        spring = recent_low < prior_low and last_close > prior_low and vol_expanding
    else:
        spring = False
    
    # Upthrust detection: price spikes above resistance then falls
    if len(closes) >= 5:
        recent_high = max(highs[-5:])
        prior_high = max(highs[:-5]) if len(highs) > 5 else recent_high
        upthrust = recent_high > prior_high and last_close < prior_high and vol_expanding
    else:
        upthrust = False
    
    # Determine phase
    if spring:
        phase = 'SPRING'
    elif upthrust:
        phase = 'UPTHRUST'
    elif is_ranging and at_lows:
        phase = 'ACCUMULATION'
    elif is_ranging and at_highs:
        phase = 'DISTRIBUTION'
    elif trending_up and vol_expanding:
        phase = 'SIGN_OF_STRENGTH'
    elif trending_up:
        phase = 'MARKUP'
    elif trending_down and vol_expanding:
        phase = 'MARKDOWN'
    elif trending_down:
        phase = 'MARKDOWN'
    elif is_ranging:
        phase = 'RANGING'
    else:
        phase = 'UNKNOWN'
    
    return {'phase': phase}


# ═══════════════════════════════════════════════════════════════
# LAYER 3 — SMC (Smart Money Concepts) DETECTION
# ═══════════════════════════════════════════════════════════════

def detect_order_blocks(ohlc, lookback=50):
    """Detect institutional order blocks."""
    if len(ohlc) < 3:
        return []
    
    obs = []
    data = ohlc[-lookback:] if len(ohlc) >= lookback else ohlc
    
    for i in range(1, len(data) - 1):
        prev = data[i-1]
        curr = data[i]
        nxt = data[i+1]
        
        # Bullish OB: bearish candle followed by strong bullish move
        if curr['close'] < curr['open'] and nxt['close'] > nxt['open']:
            move = abs(nxt['close'] - nxt['open'])
            body = abs(curr['close'] - curr['open'])
            if body > 0 and move > body * 1.5:
                obs.append({
                    'type': 'BULLISH',
                    'high': curr['high'],
                    'low': curr['low'],
                    'date': curr['date']
                })
        
        # Bearish OB: bullish candle followed by strong bearish move
        if curr['close'] > curr['open'] and nxt['close'] < nxt['open']:
            move = abs(nxt['open'] - nxt['close'])
            body = abs(curr['close'] - curr['open'])
            if body > 0 and move > body * 1.5:
                obs.append({
                    'type': 'BEARISH',
                    'high': curr['high'],
                    'low': curr['low'],
                    'date': curr['date']
                })
    
    return obs[-5:]  # Return last 5


def detect_fair_value_gaps(ohlc, lookback=50):
    """Detect Fair Value Gaps (imbalances)."""
    if len(ohlc) < 3:
        return []
    
    fvgs = []
    data = ohlc[-lookback:] if len(ohlc) >= lookback else ohlc
    
    for i in range(2, len(data)):
        c0 = data[i-2]
        c2 = data[i]
        
        # Bullish FVG: gap up
        if c2['low'] > c0['high']:
            fvgs.append({
                'type': 'BULLISH',
                'top': c2['low'],
                'bot': c0['high'],
                'date': data[i-1]['date']
            })
        
        # Bearish FVG: gap down
        if c2['high'] < c0['low']:
            fvgs.append({
                'type': 'BEARISH',
                'top': c0['low'],
                'bot': c2['high'],
                'date': data[i-1]['date']
            })
    
    return fvgs[-5:]


def detect_liquidity_sweeps(ohlc, lookback=30):
    """Detect liquidity sweeps (stop hunts)."""
    if len(ohlc) < lookback:
        return {}
    
    data = ohlc[-lookback:]
    lows = [c['low'] for c in data[:-3]]
    highs = [c['high'] for c in data[:-3]]
    
    if not lows or not highs:
        return {}
    
    recent = data[-3:]
    swept_low = any(c['low'] < min(lows) for c in recent)
    swept_high = any(c['high'] > max(highs) for c in recent)
    
    return {
        'swept_low': swept_low,
        'swept_high': swept_high,
    }


def build_volume_profile(ohlc, bins=20):
    """Build volume profile with POC and value area."""
    if len(ohlc) < 10:
        return {}
    
    prices = [(c['high'] + c['low'] + c['close']) / 3 for c in ohlc[-50:]]
    volumes = [c['volume'] for c in ohlc[-50:]]
    
    if not prices:
        return {}
    
    lo = min(prices)
    hi = max(prices)
    if hi == lo:
        return {}
    
    step = (hi - lo) / bins
    profile = [0.0] * bins
    
    for p, v in zip(prices, volumes):
        idx = min(int((p - lo) / step), bins - 1)
        profile[idx] += v
    
    total_vol = sum(profile)
    poc_idx = profile.index(max(profile))
    poc = lo + (poc_idx + 0.5) * step
    
    # Value area (70% of volume)
    sorted_bins = sorted(range(bins), key=lambda i: profile[i], reverse=True)
    va_vol = 0
    va_bins = set()
    for b in sorted_bins:
        va_vol += profile[b]
        va_bins.add(b)
        if va_vol >= total_vol * 0.7:
            break
    
    va_low = lo + min(va_bins) * step
    va_high = lo + (max(va_bins) + 1) * step
    
    return {
        'poc': poc,
        'value_area_low': va_low,
        'value_area_high': va_high,
    }

'''

# Insert new functions before the old calc_confluence
old_calc_start = "def calc_confluence(ohlc, ticker, d_date, direction, broker_data_by_date, fib_sc):"
if old_calc_start in rc:
    rc = rc.replace(old_calc_start, new_functions + "\n" + old_calc_start)
    print("[1] ✅ Added Wyckoff, SMC, Volume Profile functions")
else:
    print("[1] ⚠️ calc_confluence not found")

# 1b. Replace old calc_confluence with 5-layer version
old_calc = '''def calc_confluence(ohlc, ticker, d_date, direction, broker_data_by_date, fib_sc):
    """Compute total confluence score (0-100) from all 4 layers."""
    
    # L1: Harmonic pattern quality (fib score mapped to 0-25)
    l1_score = min(25, round(fib_sc / 4))
    
    # L2: Trend alignment
    l2_score, l2_detail = check_trend_alignment(ohlc, direction)
    
    # L3: Volume spike
    l3_score, l3_detail = check_volume_spike(ohlc)
    
    # L4: Broker flow
    l4_score, l4_detail = check_broker_flow(broker_data_by_date, ticker, d_date, direction)
    
    total = l1_score + l2_score + l3_score + l4_score
    
    return total, {
        'total': total,
        'l1_pattern': l1_score,
        'l2_trend': l2_score,
        'l3_volume': l3_score,
        'l4_broker': l4_score,
        'trend_detail': l2_detail,
        'volume_detail': l3_detail,
        'broker_detail': l4_detail,
    }'''

new_calc = '''def calc_confluence(ohlc, ticker, d_date, direction, broker_data_by_date, fib_sc, weights=None):
    """Compute total confluence score (0-100) from 5 layers.
    
    5-Layer System (matching live scanner calcUltraConviction):
      L1: Harmonic Pattern Quality
      L2: Wyckoff Phase
      L3: SMC Setup (Order Blocks, FVG, Liquidity Sweeps)
      L4: Volume Profile (POC, Value Area, Volume Spike)
      L5: Broker Flow
    """
    w = weights or {'harmonic': 25, 'wyckoff': 20, 'smc': 25, 'volume_profile': 20, 'broker_flow': 10}
    w_sum = sum(w.values())
    norm = 100 / w_sum if w_sum > 0 else 1
    
    # ── L1: Harmonic Pattern (raw 0-20) ──
    PAT_BASE = {'CRAB':20, 'SHARK':19, 'BAT':18, 'GARTLEY':16, 'BUTTERFLY':15, 'CYPHER':14, 'ABCD':10}
    # fib_sc is already computed, map to 0-20
    raw_l1 = min(20, 10 + round(fib_sc * 0.1))
    score_l1 = (raw_l1 / 20) * w['harmonic'] * norm
    
    # ── L2: Wyckoff Phase (raw 0-15) ──
    wy = detect_wyckoff_phase(ohlc)
    phase = wy.get('phase', 'UNKNOWN')
    WY_PTS_BULL = {'SPRING':15, 'SIGN_OF_STRENGTH':14, 'SOS':14, 'LPS':12, 'ACCUMULATION':8, 'MARKUP':6, 'RANGING':3, 'UPTHRUST':0, 'DISTRIBUTION':0, 'MARKDOWN':0, 'UNKNOWN':0}
    WY_PTS_BEAR = {'UPTHRUST':15, 'DISTRIBUTION':14, 'MARKDOWN':12, 'RANGING':3, 'MARKUP':0, 'SPRING':0, 'ACCUMULATION':0, 'SIGN_OF_STRENGTH':0, 'SOS':0, 'LPS':0, 'UNKNOWN':0}
    wy_map = WY_PTS_BULL if direction == 'BULLISH' else WY_PTS_BEAR
    raw_l2 = max(0, wy_map.get(phase, 0))
    score_l2 = (raw_l2 / 15) * w['wyckoff'] * norm
    
    # ── L3: SMC Setup (raw 0-20) ──
    last_close = ohlc[-1]['close'] if ohlc else 0
    obs = detect_order_blocks(ohlc)
    fvgs = detect_fair_value_gaps(ohlc)
    sweeps = detect_liquidity_sweeps(ohlc)
    
    raw_l3 = 0
    in_ob = any(min(o['high'],o['low']) <= last_close <= max(o['high'],o['low']) for o in obs) if obs else False
    in_fvg = any(min(f.get('top',0),f.get('bot',0)) <= last_close <= max(f.get('top',0),f.get('bot',0)) for f in fvgs) if fvgs else False
    liq_sweep = bool(sweeps.get('swept_low') or sweeps.get('swept_high'))
    
    if in_ob: raw_l3 += 8
    if in_fvg: raw_l3 += 7
    if liq_sweep: raw_l3 += 5
    raw_l3 = min(20, raw_l3)
    score_l3 = (raw_l3 / 20) * w['smc'] * norm
    
    # ── L4: Volume Profile (raw 0-15) ──
    vp = build_volume_profile(ohlc)
    vol_score_raw, vol_detail = check_volume_spike(ohlc)
    
    raw_l4 = 0
    if vol_detail.get('spike'): raw_l4 += 6
    if vp.get('poc') and last_close and vp['poc'] > 0:
        if abs(last_close - vp['poc']) / vp['poc'] < 0.02: raw_l4 += 5
    if vp.get('value_area_low') and vp.get('value_area_high'):
        if vp['value_area_low'] <= last_close <= vp['value_area_high']: raw_l4 += 4
    raw_l4 = min(15, raw_l4)
    score_l4 = (raw_l4 / 15) * w['volume_profile'] * norm
    
    # ── L5: Broker Flow (raw 0-25) ──
    l5_raw_score, l5_detail = check_broker_flow(broker_data_by_date, ticker, d_date, direction)
    raw_l5 = l5_raw_score
    score_l5 = (raw_l5 / 25) * w['broker_flow'] * norm
    
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

if old_calc in rc:
    rc = rc.replace(old_calc, new_calc)
    print("[2] ✅ Replaced calc_confluence with 5-layer version")
else:
    print("[2] ⚠️ old calc_confluence not found exactly")

# 1c. Add weights param to argv parsing
# Find where market is parsed and add weights after it
old_market = "    market = sys.argv[5] if len(sys.argv) > 5 else 'IDX'"
new_market = """    market = sys.argv[5] if len(sys.argv) > 5 else 'IDX'
    weights_json = sys.argv[6] if len(sys.argv) > 6 else None
    custom_weights = json.loads(weights_json) if weights_json else None"""

if old_market in rc:
    rc = rc.replace(old_market, new_market, 1)
    print("[3] ✅ Added weights argv parsing")
else:
    print("[3] ⚠️ market argv not found")

# Make sure json is imported
if 'import json' not in rc.split('\n')[0:20].__repr__():
    rc = rc.replace('import sys', 'import sys, json', 1)
    print("[3b] Added json import")

# 1d. Pass weights to calc_confluence calls
old_conf_call = "calc_confluence(\n                    ohlc_cut, ticker, pat['D_date'], pat['direction'], broker_by_date, pat.get('fib_score', 0)\n                )"
if old_conf_call in rc:
    new_conf_call = "calc_confluence(\n                    ohlc_cut, ticker, pat['D_date'], pat['direction'], broker_by_date, pat.get('fib_score', 0), custom_weights\n                )"
    rc = rc.replace(old_conf_call, new_conf_call)
    print("[4] ✅ Pass weights to calc_confluence")
else:
    # Try simpler pattern
    if "calc_confluence(" in rc and "custom_weights" not in rc.split("calc_confluence(")[1][:200]:
        # Find all calc_confluence calls and add weights
        rc = rc.replace(
            "broker_by_date, pat.get('fib_score', 0))",
            "broker_by_date, pat.get('fib_score', 0), custom_weights)"
        )
        print("[4b] ✅ Pass weights (alternate match)")
    else:
        print("[4] ⚠️ calc_confluence call not found")

with open(RUNNER, 'w') as f:
    f.write(rc)

# Verify Python syntax
import subprocess
r = subprocess.run(['python3', '-m', 'py_compile', RUNNER], capture_output=True, text=True)
if r.returncode == 0:
    print("[5] ✅ Python syntax OK")
else:
    print(f"[5] ❌ Syntax error: {r.stderr[:200]}")

# ═══════════════════════════════════════════════════
# PART 2: Update server.js to accept weights
# ═══════════════════════════════════════════════════
SERVER = '/var/www/flowtracker-scraper/server.js'
with open(SERVER, 'r') as f:
    sc = f.read()

# Add weights to backtest/run body extraction
old_body = "const { startDate, endDate, tickers: customTickers, min_score = 60, market = 'IDX' } = req.body;"
new_body = "const { startDate, endDate, tickers: customTickers, min_score = 60, market = 'IDX', weights = null } = req.body;"
if old_body in sc:
    sc = sc.replace(old_body, new_body, 1)
    print("[6] ✅ Added weights to body extraction")

# Pass weights to Python spawn
old_spawn = "const py = spawn('python3', [pythonScript, runId, startDate, endDate, String(min_score), market || 'IDX'], {"
new_spawn = "const py = spawn('python3', [pythonScript, runId, startDate, endDate, String(min_score), market || 'IDX', weights ? JSON.stringify(weights) : ''], {"
if old_spawn in sc:
    sc = sc.replace(old_spawn, new_spawn, 1)
    print("[7] ✅ Pass weights to Python runner")

with open(SERVER, 'w') as f:
    f.write(sc)

# Verify JS
r2 = subprocess.run(['node', '-c', SERVER], capture_output=True, text=True)
print(f"[8] {'✅ JS syntax OK' if r2.returncode == 0 else '❌ ' + r2.stderr[:200]}")

print("\nDone with Part 1 & 2!")
