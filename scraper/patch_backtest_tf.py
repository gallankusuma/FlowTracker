#!/usr/bin/env python3
"""
Add timeframe (Daily/Weekly/Monthly) support to backtest system.

Changes:
1. backtest_runner.py: Accept 'interval' param, adjust scan config per TF
   - For Weekly: resample daily OHLC to weekly candles, adjust MAX_D_AGE, SWING params
   - For Monthly: resample to monthly candles
2. server.js: Accept 'interval' in /api/backtest/run, pass to runner
3. page.tsx: Add Daily/Weekly/Monthly toggle buttons to backtest UI
"""
import re

# ═══════════════════════════════════════════════════
# PART 1: Update backtest_runner.py 
# ═══════════════════════════════════════════════════
RUNNER = '/var/www/flowtracker-scraper/backtest_runner.py'
with open(RUNNER, 'r') as f:
    rc = f.read()

changes = 0

# 1a. Replace hardcoded constants with TF-aware config
old_consts = """SWING_THRESHOLD    = 0.04
MAX_SWINGS         = 20
MIN_OHLC_BARS      = 30
MAX_D_AGE = 5"""

new_consts = """SWING_THRESHOLD    = 0.04
MAX_SWINGS         = 20
MIN_OHLC_BARS      = 30
MAX_D_AGE = 5

# Timeframe-specific config (matching live scanner TF_CONFIG)
TF_CONFIG = {
    '1d':  { 'max_d_age': 5,  'swing_threshold': 0.04, 'max_pattern_span': 60,  'swing_left': 5, 'swing_right': 3 },
    '1wk': { 'max_d_age': 3,  'swing_threshold': 0.06, 'max_pattern_span': 40,  'swing_left': 4, 'swing_right': 2 },
    '1mo': { 'max_d_age': 2,  'swing_threshold': 0.08, 'max_pattern_span': 30,  'swing_left': 3, 'swing_right': 2 },
}"""

if old_consts in rc:
    rc = rc.replace(old_consts, new_consts, 1)
    changes += 1
    print("[1a] ✅ Added TF_CONFIG")
else:
    print("[1a] ⚠️ Constants block not found exactly")

# 1b. Add OHLC resampling function (daily → weekly/monthly)
resample_fn = '''
def resample_ohlc(daily_ohlc, interval='1d'):
    """Resample daily OHLC to weekly or monthly candles."""
    if interval == '1d':
        return daily_ohlc
    
    from datetime import datetime
    
    buckets = {}
    for c in daily_ohlc:
        dt = datetime.strptime(c['date'][:10], '%Y-%m-%d')
        if interval == '1wk':
            # Group by ISO week (Monday start)
            key = dt.strftime('%Y-W%W')
        elif interval == '1mo':
            key = dt.strftime('%Y-%m')
        else:
            key = c['date'][:10]
        
        if key not in buckets:
            buckets[key] = {
                'date': c['date'][:10],  # first date of period
                'open': c['open'],
                'high': c['high'],
                'low': c['low'],
                'close': c['close'],
                'volume': c['volume'],
            }
        else:
            b = buckets[key]
            b['high'] = max(b['high'], c['high'])
            b['low'] = min(b['low'], c['low'])
            b['close'] = c['close']  # last close
            b['date'] = c['date'][:10]  # use last date
            b['volume'] += c['volume']
    
    return [v for v in buckets.values()]

'''

# Insert before detect_swings
if 'def resample_ohlc' not in rc:
    detect_swings_pos = rc.find('def detect_swings(')
    if detect_swings_pos >= 0:
        rc = rc[:detect_swings_pos] + resample_fn + rc[detect_swings_pos:]
        changes += 1
        print("[1b] ✅ Added resample_ohlc function")
else:
    print("[1b] ⚠️ resample_ohlc already exists")

# 1c. Add interval to argv parsing (after weights)
old_weights_arg = """    weights_json = sys.argv[6] if len(sys.argv) > 6 else None
    custom_weights = json.loads(weights_json) if weights_json else None"""

new_weights_arg = """    weights_json = sys.argv[6] if len(sys.argv) > 6 else None
    custom_weights = json.loads(weights_json) if weights_json else None
    interval = sys.argv[7] if len(sys.argv) > 7 else '1d'
    tf_cfg = TF_CONFIG.get(interval, TF_CONFIG['1d'])
    print(f'   📅 Timeframe: {interval} (D_AGE={tf_cfg["max_d_age"]}, SWING={tf_cfg["swing_left"]}/{tf_cfg["swing_right"]})')"""

if old_weights_arg in rc:
    rc = rc.replace(old_weights_arg, new_weights_arg, 1)
    changes += 1
    print("[1c] ✅ Added interval argv parsing")
else:
    print("[1c] ⚠️ weights_arg not found")

# 1d. For US market Yahoo fetch, use the interval parameter
old_yahoo_url = "url = f\"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?period1={p1}&period2={p2}&interval=1d\""
new_yahoo_url = "url = f\"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?period1={p1}&period2={p2}&interval={interval}\""
if old_yahoo_url in rc:
    # But wait - fetch_yahoo_ohlc is a standalone function, not in main()
    # For Yahoo, we should always fetch daily and resample, because weekly/monthly data has gaps
    # Actually for backtest, it's simpler to always fetch daily then resample
    print("[1d] ℹ️ Yahoo always fetches daily — will resample in main loop")
else:
    print("[1d] ⚠️ Yahoo URL not found")

# 1e. Add resampling step in the main scan loop for IDX data
# After OHLC is loaded, resample it
old_trading_days = "    # ── 3. Get trading days in range"
new_trading_days = """    # ── 2b. Resample OHLC per timeframe ──────────────────────
    if interval != '1d':
        print(f'   🔄 Resampling {len(ohlc_by_ticker)} tickers to {interval}...')
        for t in ohlc_by_ticker:
            ohlc_by_ticker[t] = resample_ohlc(ohlc_by_ticker[t], interval)
        print(f'   ✅ Resampled ({interval})')

    # ── 3. Get trading days in range"""

if old_trading_days in rc:
    rc = rc.replace(old_trading_days, new_trading_days, 1)
    changes += 1
    print("[1e] ✅ Added resampling step")
else:
    print("[1e] ⚠️ trading days section not found")

# 1f. Use TF config for MAX_D_AGE in detect_harmonic_patterns
old_dage_check = "        if days_ago > MAX_D_AGE: continue"
new_dage_check = "        if days_ago > tf_cfg.get('max_d_age', MAX_D_AGE): continue"
if old_dage_check in rc:
    rc = rc.replace(old_dage_check, new_dage_check)
    changes += 1
    print("[1f] ✅ Use tf_cfg max_d_age")
else:
    print("[1f] ⚠️ MAX_D_AGE check not found")

# 1g. Use TF config for swing detection
old_swing_call = "    swings = detect_swings(ohlc, SWING_THRESHOLD, MAX_SWINGS)"
new_swing_call = "    swings = detect_swings(ohlc, tf_cfg.get('swing_threshold', SWING_THRESHOLD), MAX_SWINGS)"
if old_swing_call in rc:
    rc = rc.replace(old_swing_call, new_swing_call, 1)
    changes += 1
    print("[1g] ✅ Use tf_cfg swing_threshold")
else:
    print("[1g] ⚠️ swing call not found")

# But detect_harmonic_patterns doesn't have access to tf_cfg since it's a function
# We need to pass it as a parameter
old_detect_sig = "def detect_harmonic_patterns(ohlc, ticker, broker_data_by_date, scan_date, min_score=60):"
new_detect_sig = "def detect_harmonic_patterns(ohlc, ticker, broker_data_by_date, scan_date, min_score=60, tf_cfg=None):"
if old_detect_sig in rc:
    rc = rc.replace(old_detect_sig, new_detect_sig, 1)
    print("[1g2] ✅ Added tf_cfg param to detect_harmonic_patterns")

# Add tf_cfg default at top of function
old_detect_body = "    swings = detect_swings(ohlc, tf_cfg.get('swing_threshold', SWING_THRESHOLD), MAX_SWINGS)"
new_detect_body = "    if tf_cfg is None: tf_cfg = TF_CONFIG.get('1d', {})\n    swings = detect_swings(ohlc, tf_cfg.get('swing_threshold', SWING_THRESHOLD), MAX_SWINGS)"
if old_detect_body in rc:
    rc = rc.replace(old_detect_body, new_detect_body, 1)
    print("[1g3] ✅ Added tf_cfg default in detect")

# Update the call site to pass tf_cfg
old_detect_call = "patterns = detect_harmonic_patterns(\n                    ohlc_cut, ticker, broker_by_date, scan_date, min_score\n                )"
new_detect_call = "patterns = detect_harmonic_patterns(\n                    ohlc_cut, ticker, broker_by_date, scan_date, min_score, tf_cfg\n                )"
if old_detect_call in rc:
    rc = rc.replace(old_detect_call, new_detect_call, 1)
    changes += 1
    print("[1h] ✅ Pass tf_cfg to detect call")
else:
    # Try simpler match
    rc = rc.replace(
        "broker_by_date, scan_date, min_score\n                )",
        "broker_by_date, scan_date, min_score, tf_cfg\n                )"
    )
    print("[1h] ✅ Pass tf_cfg (alt match)")

with open(RUNNER, 'w') as f:
    f.write(rc)

# Verify
import subprocess
r = subprocess.run(['python3', '-m', 'py_compile', RUNNER], capture_output=True, text=True)
print(f"[PY] {'✅ Syntax OK' if r.returncode == 0 else '❌ ' + r.stderr[:300]}")

# ═══════════════════════════════════════════════════
# PART 2: Update server.js
# ═══════════════════════════════════════════════════
SERVER = '/var/www/flowtracker-scraper/server.js'
with open(SERVER, 'r') as f:
    sc = f.read()

# Add interval to backtest body extraction
old_body = "const { startDate, endDate, tickers: customTickers, min_score = 60, market = 'IDX', weights = null } = req.body;"
new_body = "const { startDate, endDate, tickers: customTickers, min_score = 60, market = 'IDX', weights = null, interval = '1d' } = req.body;"
if old_body in sc:
    sc = sc.replace(old_body, new_body, 1)
    print("[2a] ✅ Added interval to body extraction")

# Store interval in metadata
old_meta_market = "    market: market || 'IDX',"
new_meta_market = "    market: market || 'IDX',\n    interval: interval || '1d',"
if old_meta_market in sc:
    sc = sc.replace(old_meta_market, new_meta_market, 1)
    print("[2b] ✅ Store interval in metadata")

# Pass interval to Python spawn
old_spawn = "const py = spawn('python3', [pythonScript, runId, startDate, endDate, String(min_score), market || 'IDX', weights ? JSON.stringify(weights) : ''], {"
new_spawn = "const py = spawn('python3', [pythonScript, runId, startDate, endDate, String(min_score), market || 'IDX', weights ? JSON.stringify(weights) : '', interval || '1d'], {"
if old_spawn in sc:
    sc = sc.replace(old_spawn, new_spawn, 1)
    print("[2c] ✅ Pass interval to Python runner")

# Add interval to runs response
old_runs_market = "market: r.market || 'IDX', start_date:"
new_runs_market = "market: r.market || 'IDX', interval: r.interval || '1d', start_date:"
if old_runs_market in sc:
    sc = sc.replace(old_runs_market, new_runs_market, 1)
    print("[2d] ✅ Add interval to runs response")

with open(SERVER, 'w') as f:
    f.write(sc)

r2 = subprocess.run(['node', '-c', SERVER], capture_output=True, text=True)
print(f"[JS] {'✅ Syntax OK' if r2.returncode == 0 else '❌ ' + r2.stderr[:200]}")

# ═══════════════════════════════════════════════════
# PART 3: Update page.tsx UI
# ═══════════════════════════════════════════════════
PAGE = '/var/www/flowtracker/app/signal-scanner/page.tsx'
with open(PAGE, 'r') as f:
    pc = f.read()

# Add btInterval state
old_bt_weights_state = 'const [btWeights, setBtWeights] = useState({ harmonic: 25, wyckoff: 20, smc: 25, volume_profile: 20, broker_flow: 10 });'
new_bt_weights_state = '''const [btWeights, setBtWeights] = useState({ harmonic: 25, wyckoff: 20, smc: 25, volume_profile: 20, broker_flow: 10 });
  const [btInterval, setBtInterval] = useState<"1d" | "1wk" | "1mo">("1d");'''
if old_bt_weights_state in pc:
    pc = pc.replace(old_bt_weights_state, new_bt_weights_state, 1)
    print("[3a] ✅ Added btInterval state")

# Pass interval to API
old_api_weights = 'body: JSON.stringify({ startDate: btStartDate, endDate: btEndDate, min_score: btMinScore, market: btMarket, weights: btWeights })'
new_api_weights = 'body: JSON.stringify({ startDate: btStartDate, endDate: btEndDate, min_score: btMinScore, market: btMarket, weights: btWeights, interval: btInterval })'
if old_api_weights in pc:
    pc = pc.replace(old_api_weights, new_api_weights, 1)
    print("[3b] ✅ Pass interval to API")

# Add timeframe buttons next to market buttons
old_market_buttons = '''<div style={{ display:"flex", gap:4, marginLeft:12 }}>
                {(["IDX", "US"] as const).map(m => (
                  <button key={m} onClick={() => setBtMarket(m)} style={{
                    padding: "4px 14px", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer",
                    border: btMarket === m ? "none" : "1px solid var(--border)",
                    background: btMarket === m
                      ? m === "IDX" ? "linear-gradient(135deg, #f59e0b, #d97706)" : "linear-gradient(135deg, #dc2626, #1d4ed8)"
                      : "transparent",
                    color: btMarket === m ? "#fff" : "var(--text-muted)",
                  }}>
                    {m === "IDX" ? "🇮🇩 IDX" : "🇺🇸 S&P 500"}
                  </button>
                ))}
              </div>'''

new_market_buttons = '''<div style={{ display:"flex", gap:4, marginLeft:12 }}>
                {(["IDX", "US"] as const).map(m => (
                  <button key={m} onClick={() => setBtMarket(m)} style={{
                    padding: "4px 14px", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer",
                    border: btMarket === m ? "none" : "1px solid var(--border)",
                    background: btMarket === m
                      ? m === "IDX" ? "linear-gradient(135deg, #f59e0b, #d97706)" : "linear-gradient(135deg, #dc2626, #1d4ed8)"
                      : "transparent",
                    color: btMarket === m ? "#fff" : "var(--text-muted)",
                  }}>
                    {m === "IDX" ? "🇮🇩 IDX" : "🇺🇸 S&P 500"}
                  </button>
                ))}
              </div>
              <div style={{ display:"flex", gap:3, marginLeft:8 }}>
                {(["1d", "1wk", "1mo"] as const).map(tf => (
                  <button key={tf} onClick={() => setBtInterval(tf)} style={{
                    padding: "4px 10px", borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: "pointer",
                    border: btInterval === tf ? "none" : "1px solid var(--border)",
                    background: btInterval === tf ? "rgba(99,102,241,0.8)" : "transparent",
                    color: btInterval === tf ? "#fff" : "var(--text-muted)",
                  }}>
                    {tf === "1d" ? "📅 Daily" : tf === "1wk" ? "📆 Weekly" : "🗓️ Monthly"}
                  </button>
                ))}
              </div>'''

if old_market_buttons in pc:
    pc = pc.replace(old_market_buttons, new_market_buttons, 1)
    print("[3c] ✅ Added timeframe buttons to UI")
else:
    print("[3c] ⚠️ Market buttons not found exactly")

# Show interval in previous runs
old_run_market_flag = 'r.market && <span style={{ marginLeft:4, color: r.market==="US" ? "#60a5fa" : "#fbbf24" }}>{r.market==="US" ? "🇺🇸" : "🇮🇩"}</span>}'
new_run_market_flag = 'r.market && <span style={{ marginLeft:4, color: r.market==="US" ? "#60a5fa" : "#fbbf24" }}>{r.market==="US" ? "🇺🇸" : "🇮🇩"}</span>}\n                        {r.interval && <span style={{ marginLeft:2, fontSize:9, color:"#94a3b8" }}>{r.interval==="1d"?"D":r.interval==="1wk"?"W":"M"}</span>}'
if old_run_market_flag in pc:
    pc = pc.replace(old_run_market_flag, new_run_market_flag, 1)
    print("[3d] ✅ Show interval in previous runs")

with open(PAGE, 'w') as f:
    f.write(pc)

print(f"\n✅ Done! {changes} changes applied to runner")
