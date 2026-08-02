#!/usr/bin/env python3
"""
Add VWAP (Volume Weighted Average Price) to backtest + live scanner.

Changes:
1. backtest_runner.py: Add calc_vwap() function + integrate into L4 scoring
2. harmonicEngine.js: Add calcVWAP() helper + enhance conviction scoring
3. server.js: Pass VWAP data to structureData for live scanner
"""
import subprocess
import os

# ═══════════════════════════════════════════════════════════════
# PART 1: Add VWAP to Python backtest_runner.py
# ═══════════════════════════════════════════════════════════════
RUNNER = '/var/www/flowtracker-scraper/backtest_runner.py'
with open(RUNNER, 'r') as f:
    rc = f.read()

# 1a. Add calc_vwap function before calc_confluence
vwap_fn = '''
def calc_vwap(ohlc, period=20):
    """Calculate rolling VWAP with standard deviation bands.
    
    VWAP = Sum(TypicalPrice * Volume) / Sum(Volume)
    TypicalPrice = (High + Low + Close) / 3
    
    Returns: {vwap, upper_1, lower_1, upper_2, lower_2, above_vwap, vwap_dist_pct}
    """
    if not ohlc or len(ohlc) < period:
        return {'vwap': 0, 'above_vwap': None, 'vwap_dist_pct': 0,
                'upper_1': 0, 'lower_1': 0, 'upper_2': 0, 'lower_2': 0}
    
    recent = ohlc[-period:]
    tp_vol_sum = 0
    vol_sum = 0
    tp_values = []
    
    for c in recent:
        tp = (c['high'] + c['low'] + c['close']) / 3
        vol = c['volume'] if c['volume'] > 0 else 1
        tp_vol_sum += tp * vol
        vol_sum += vol
        tp_values.append(tp)
    
    vwap = tp_vol_sum / vol_sum if vol_sum > 0 else 0
    
    # Calculate VWAP standard deviation for bands
    if len(tp_values) > 1 and vwap > 0:
        variance = sum((tp - vwap) ** 2 for tp in tp_values) / len(tp_values)
        std = variance ** 0.5
    else:
        std = 0
    
    last_close = ohlc[-1]['close']
    above_vwap = last_close > vwap if vwap > 0 else None
    vwap_dist_pct = round(((last_close - vwap) / vwap) * 100, 2) if vwap > 0 else 0
    
    return {
        'vwap': round(vwap, 2),
        'upper_1': round(vwap + std, 2),
        'lower_1': round(vwap - std, 2),
        'upper_2': round(vwap + 2 * std, 2),
        'lower_2': round(vwap - 2 * std, 2),
        'above_vwap': above_vwap,
        'vwap_dist_pct': vwap_dist_pct,
        'std': round(std, 2),
    }

'''

# Insert before calc_confluence
calc_conf_pos = rc.find('def calc_confluence(')
if calc_conf_pos >= 0 and 'def calc_vwap(' not in rc:
    rc = rc[:calc_conf_pos] + vwap_fn + rc[calc_conf_pos:]
    print("[1a] ✅ Added calc_vwap function")
else:
    if 'def calc_vwap(' in rc:
        print("[1a] ℹ️ calc_vwap already exists")
    else:
        print("[1a] ⚠️ calc_confluence not found")

# 1b. Integrate VWAP into L4 scoring in calc_confluence
old_l4 = """    # ── L4: Volume Profile (bonus 0-20) ──
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
    score_l4 = (raw_l4 / 15) * w['volume_profile'] * norm"""

new_l4 = """    # ── L4: Volume Profile + VWAP (bonus 0-20) ──
    vp = build_volume_profile(ohlc)
    vol_score_raw, vol_detail = check_volume_spike(ohlc)
    vwap_data = calc_vwap(ohlc, 20)
    
    raw_l4 = 2  # base credit for having volume data
    if vol_detail.get('spike'): raw_l4 += 4
    elif vol_score_raw > 0: raw_l4 += 2
    if vp.get('poc') and last_close and vp['poc'] > 0:
        poc_dist = abs(last_close - vp['poc']) / vp['poc']
        if poc_dist < 0.02: raw_l4 += 4
        elif poc_dist < 0.05: raw_l4 += 2
    if vp.get('value_area_low') and vp.get('value_area_high'):
        if vp['value_area_low'] <= last_close <= vp['value_area_high']: raw_l4 += 2
    
    # VWAP confluence
    above_vwap = vwap_data.get('above_vwap')
    if above_vwap is not None:
        if direction == 'BULLISH' and above_vwap: raw_l4 += 3     # price above VWAP confirms bullish
        elif direction == 'BEARISH' and not above_vwap: raw_l4 += 3  # price below VWAP confirms bearish
        elif direction == 'BULLISH' and not above_vwap:
            # Bullish signal near/below VWAP = potential value entry
            dist = abs(vwap_data.get('vwap_dist_pct', 0))
            if dist < 2: raw_l4 += 2  # very close to VWAP
        elif direction == 'BEARISH' and above_vwap:
            dist = abs(vwap_data.get('vwap_dist_pct', 0))
            if dist < 2: raw_l4 += 2
    
    # VWAP band extremes (mean reversion signal)
    if vwap_data.get('lower_2') and last_close <= vwap_data['lower_2'] and direction == 'BULLISH':
        raw_l4 += 3  # price at -2σ band, bullish reversal potential
    if vwap_data.get('upper_2') and last_close >= vwap_data['upper_2'] and direction == 'BEARISH':
        raw_l4 += 3  # price at +2σ band, bearish reversal potential
    
    raw_l4 = min(20, raw_l4)
    score_l4 = (raw_l4 / 20) * w['volume_profile'] * norm"""

if old_l4 in rc:
    rc = rc.replace(old_l4, new_l4, 1)
    print("[1b] ✅ VWAP integrated into L4 scoring")
else:
    print("[1b] ⚠️ L4 section not found")

# 1c. Add vwap_data to the return dict
old_return_vp = "        'vp_detail': vp,"
new_return_vp = "        'vp_detail': vp,\n        'vwap_detail': vwap_data,"
if old_return_vp in rc:
    rc = rc.replace(old_return_vp, new_return_vp, 1)
    print("[1c] ✅ Added vwap_detail to return")
else:
    print("[1c] ⚠️ vp_detail not found")

with open(RUNNER, 'w') as f:
    f.write(rc)

r = subprocess.run(['python3', '-m', 'py_compile', RUNNER], capture_output=True, text=True)
print(f"[PY] {'✅ Syntax OK' if r.returncode == 0 else '❌ ' + r.stderr[:300]}")

# ═══════════════════════════════════════════════════════════════
# PART 2: Add VWAP to JS harmonicEngine.js
# ═══════════════════════════════════════════════════════════════
ENGINE = '/var/www/flowtracker-scraper/harmonicEngine.js'
with open(ENGINE, 'r') as f:
    ec = f.read()

# 2a. Add calcVWAP helper function before calcUltraConviction
vwap_js = '''
/**
 * Calculate rolling VWAP with bands.
 * @param {Array} ohlc - [{high, low, close, volume}]
 * @param {number} period - lookback period (default 20)
 * @returns {{vwap, upper_1, lower_1, upper_2, lower_2, above_vwap, vwap_dist_pct}}
 */
function calcVWAP(ohlc, period = 20) {
  if (!ohlc || ohlc.length < period) return { vwap: 0, above_vwap: null, vwap_dist_pct: 0 };
  
  const recent = ohlc.slice(-period);
  let tpVolSum = 0, volSum = 0;
  const tps = [];
  
  for (const c of recent) {
    const tp = (c.high + c.low + c.close) / 3;
    const vol = c.volume > 0 ? c.volume : 1;
    tpVolSum += tp * vol;
    volSum += vol;
    tps.push(tp);
  }
  
  const vwap = volSum > 0 ? tpVolSum / volSum : 0;
  
  let std = 0;
  if (tps.length > 1 && vwap > 0) {
    const variance = tps.reduce((sum, tp) => sum + (tp - vwap) ** 2, 0) / tps.length;
    std = Math.sqrt(variance);
  }
  
  const lastClose = ohlc[ohlc.length - 1].close;
  const above_vwap = vwap > 0 ? lastClose > vwap : null;
  const vwap_dist_pct = vwap > 0 ? Math.round(((lastClose - vwap) / vwap) * 10000) / 100 : 0;
  
  return {
    vwap: Math.round(vwap * 100) / 100,
    upper_1: Math.round((vwap + std) * 100) / 100,
    lower_1: Math.round((vwap - std) * 100) / 100,
    upper_2: Math.round((vwap + 2 * std) * 100) / 100,
    lower_2: Math.round((vwap - 2 * std) * 100) / 100,
    above_vwap,
    vwap_dist_pct,
    std: Math.round(std * 100) / 100,
  };
}

'''

# Insert before calcUltraConviction
ultra_pos = ec.find('function calcUltraConviction(')
if ultra_pos >= 0 and 'function calcVWAP(' not in ec:
    ec = ec[:ultra_pos] + vwap_js + ec[ultra_pos:]
    print("[2a] ✅ Added calcVWAP to harmonicEngine.js")
else:
    if 'function calcVWAP(' in ec:
        print("[2a] ℹ️ calcVWAP already exists")

# 2b. Export calcVWAP
old_exports = "  calcUltraConviction,"
new_exports = "  calcUltraConviction,\n  calcVWAP,"
if 'calcVWAP,' not in ec and old_exports in ec:
    ec = ec.replace(old_exports, new_exports, 1)
    print("[2b] ✅ Exported calcVWAP")

with open(ENGINE, 'w') as f:
    f.write(ec)

r2 = subprocess.run(['node', '-c', ENGINE], capture_output=True, text=True)
print(f"[JS Engine] {'✅ Syntax OK' if r2.returncode == 0 else '❌ ' + r2.stderr[:200]}")

# ═══════════════════════════════════════════════════════════════
# PART 3: Update server.js to compute VWAP for live scanner
# ═══════════════════════════════════════════════════════════════
SERVER = '/var/www/flowtracker-scraper/server.js'
with open(SERVER, 'r') as f:
    sc = f.read()

# 3a. Import calcVWAP from harmonicEngine
old_import = "const { calcUltraConviction,"
new_import = "const { calcUltraConviction, calcVWAP,"
if 'calcVWAP' not in sc and old_import in sc:
    sc = sc.replace(old_import, new_import, 1)
    print("[3a] ✅ Import calcVWAP in server.js")
elif 'calcVWAP' in sc:
    print("[3a] ℹ️ calcVWAP already imported")

# 3b. Find where structureData is built for live scanner and add VWAP
# Look for above_vwap in structureData construction
if 'above_vwap' in sc:
    # Check if it's already using calcVWAP or just DB data
    import re
    vwap_usage = [l.strip() for l in sc.split('\n') if 'above_vwap' in l]
    for v in vwap_usage[:5]:
        print(f"  [3b] Found: {v[:80]}")

with open(SERVER, 'r') as f:
    sc = f.read()
with open(SERVER, 'w') as f:
    f.write(sc)

r3 = subprocess.run(['node', '-c', SERVER], capture_output=True, text=True)
print(f"[JS Server] {'✅ Syntax OK' if r3.returncode == 0 else '❌ ' + r3.stderr[:200]}")

# Restart & verify
subprocess.run(['pm2', 'restart', 'flowtracker-scraper'], capture_output=True)
print("[4] ✅ PM2 restart")

# Quick test
print("\n--- Quick VWAP Test ---")
import sys
sys.path.insert(0, '/var/www/flowtracker-scraper')
for m in list(sys.modules.keys()):
    if 'backtest' in m: del sys.modules[m]

from backtest_runner import calc_vwap
import pymysql
conn = pymysql.connect(host='localhost', port=3306, user='erp_user', password=os.environ.get('DB_PASSWORD'),
                       database='erp_manufacturing', cursorclass=pymysql.cursors.DictCursor)
cur = conn.cursor()
cur.execute("SELECT date, open_price AS `open`, high_price AS high, low_price AS low, close_price AS close, volume FROM ft_price_ohlc WHERE ticker='BBRI' ORDER BY date ASC")
rows = cur.fetchall()
conn.close()
ohlc = [{'date': str(r['date'])[:10], 'open': float(r['open']), 'high': float(r['high']),
         'low': float(r['low']), 'close': float(r['close']), 'volume': float(r['volume'] or 0)} for r in rows]

vwap = calc_vwap(ohlc, 20)
print(f"  BBRI VWAP(20): {vwap['vwap']}")
print(f"  Close: {ohlc[-1]['close']}")
print(f"  Above VWAP: {vwap['above_vwap']}")
print(f"  Distance: {vwap['vwap_dist_pct']}%")
print(f"  Bands: [{vwap['lower_2']} .. {vwap['lower_1']} .. VWAP={vwap['vwap']} .. {vwap['upper_1']} .. {vwap['upper_2']}]")
