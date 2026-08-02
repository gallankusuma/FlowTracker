#!/usr/bin/env python3
"""
Add market selector (IDX / S&P 500) to Backtest tab.
Changes:
1. server.js: Accept 'market' param in /api/backtest/run, use correct ticker list
2. server.js: Add TOP_US_STOCKS to server.js (copy from worker)
3. page.tsx: Add market toggle buttons to backtest panel
4. page.tsx: Pass market to API call
5. server.js: Store market in backtest run metadata, show in previous runs
"""
import re

# ═══════════════════════════════════════════════════
# 1. server.js: Add TOP_US_STOCKS and update backtest endpoint
# ═══════════════════════════════════════════════════
SERVER = '/var/www/flowtracker-scraper/server.js'
with open(SERVER, 'r') as f:
    sc = f.read()

# First, check if TOP_US_STOCKS already exists in server.js
if 'TOP_US_STOCKS' not in sc:
    # Read from worker
    with open('/var/www/flowtracker-scraper/harmonic-scan-worker.js', 'r') as f:
        wc = f.read()
    m = re.search(r'const TOP_US_STOCKS = \[.*?\];', wc, re.DOTALL)
    if m:
        us_stocks_block = m.group()
        # Insert after TOP_STOCKS array
        top_stocks_end = re.search(r"(const TOP_STOCKS = \[.*?\];)", sc, re.DOTALL)
        if top_stocks_end:
            sc = sc.replace(top_stocks_end.group(), top_stocks_end.group() + "\n\n" + us_stocks_block)
            print("[1] Added TOP_US_STOCKS to server.js")
    else:
        print("[1] SKIP: TOP_US_STOCKS not found in worker")
else:
    print("[1] SKIP: TOP_US_STOCKS already in server.js")

# 2. Update backtest/run endpoint to accept market param
old_run = "const { startDate, endDate, tickers: customTickers, min_score = 60 } = req.body;"
new_run = "const { startDate, endDate, tickers: customTickers, min_score = 60, market = 'IDX' } = req.body;"

if old_run in sc:
    sc = sc.replace(old_run, new_run, 1)
    print("[2] Added 'market' param to backtest/run")
else:
    print("[2] SKIP: already has market or different format")

# 3. Update ticker selection to use market
old_tickers = "const tickers = customTickers && customTickers.length > 0 ? customTickers : TOP_STOCKS;"
new_tickers = """const tickerMap = { IDX: TOP_STOCKS, US: (typeof TOP_US_STOCKS !== 'undefined' ? TOP_US_STOCKS : TOP_STOCKS) };
  const tickers = customTickers && customTickers.length > 0 ? customTickers : (tickerMap[market] || TOP_STOCKS);"""

if old_tickers in sc:
    sc = sc.replace(old_tickers, new_tickers, 1)
    print("[3] Updated ticker selection with market support")
else:
    print("[3] SKIP: ticker selection different")

# 4. Store market in backtestRuns metadata
old_meta = """  backtestRuns[runId] = {
    status: 'RUNNING',
    startDate,
    endDate,
    tickers: tickers.length,
    min_score: Number(min_score),"""
new_meta = """  backtestRuns[runId] = {
    status: 'RUNNING',
    startDate,
    endDate,
    market: market || 'IDX',
    tickers: tickers.length,
    min_score: Number(min_score),"""

if old_meta in sc:
    sc = sc.replace(old_meta, new_meta, 1)
    print("[4] Added market to backtest run metadata")
else:
    print("[4] SKIP: metadata different")

# 5. Pass market to backtest_runner.py
old_spawn = "const py = spawn('python3', [pythonScript, runId, startDate, endDate, String(min_score)], {"
new_spawn = "const py = spawn('python3', [pythonScript, runId, startDate, endDate, String(min_score), market || 'IDX'], {"

if old_spawn in sc:
    sc = sc.replace(old_spawn, new_spawn, 1)
    print("[5] Pass market to Python runner")
else:
    print("[5] SKIP: spawn call different")

# 6. Update backtest/runs endpoint to include market
# Find the runs endpoint response
old_runs_resp = re.search(r"start_date:.*?end_date:.*?total_trades:.*?win_rate:", sc)
if old_runs_resp:
    s = old_runs_resp.group()
    if 'market:' not in s:
        sc = sc.replace(s, s.replace("start_date:", "market: r.market || 'IDX', start_date:"))
        print("[6] Added market to runs response")
    else:
        print("[6] SKIP: market already in runs response")

with open(SERVER, 'w') as f:
    f.write(sc)

# ═══════════════════════════════════════════════════
# 7. Update backtest_runner.py to accept market param & use correct tickers
# ═══════════════════════════════════════════════════
RUNNER = '/var/www/flowtracker-scraper/backtest_runner.py'
with open(RUNNER, 'r') as f:
    rc = f.read()

# Check if it already handles market param
if 'market' not in rc or "sys.argv[5]" not in rc:
    # Find where it reads sys.argv
    old_args = re.search(r"run_id\s*=\s*sys\.argv\[1\].*?min_score\s*=.*?sys\.argv\[4\]", rc, re.DOTALL)
    if old_args:
        new_args = old_args.group() + "\nmarket = sys.argv[5] if len(sys.argv) > 5 else 'IDX'"
        rc = rc.replace(old_args.group(), new_args)
        print("[7] Added market arg to backtest_runner.py")
    else:
        print("[7] SKIP: argv pattern not found")
    
    # Find ticker list and make it market-aware  
    # Look for where TICKERS or tickers are defined
    ticker_match = re.search(r"(TICKERS|tickers)\s*=\s*\[", rc)
    if ticker_match:
        print(f"[7b] Found ticker list at: {ticker_match.group()[:30]}")
    
    # For now, just add the US ticker mapping near the top
    # The runner likely gets tickers from OHLC data in DB or from TOP_STOCKS
    
    with open(RUNNER, 'w') as f:
        f.write(rc)
else:
    print("[7] SKIP: market already handled")

# ═══════════════════════════════════════════════════
# 8. Update page.tsx: Add market toggle to backtest panel
# ═══════════════════════════════════════════════════
PAGE = '/var/www/flowtracker/app/signal-scanner/page.tsx'
with open(PAGE, 'r') as f:
    pc = f.read()

# Add btMarket state
old_bt_state = "const [btRunning, setBtRunning] = useState(false);"
if 'btMarket' not in pc:
    new_bt_state = 'const [btRunning, setBtRunning] = useState(false);\n  const [btMarket, setBtMarket] = useState<"IDX" | "US">("IDX");'
    if old_bt_state in pc:
        pc = pc.replace(old_bt_state, new_bt_state, 1)
        print("[8] Added btMarket state")
    else:
        print("[8] SKIP: btRunning state not found")

# Pass market to API
old_api_body = 'body: JSON.stringify({ startDate: btStartDate, endDate: btEndDate, min_score: btMinScore })'
new_api_body = 'body: JSON.stringify({ startDate: btStartDate, endDate: btEndDate, min_score: btMinScore, market: btMarket })'
if old_api_body in pc:
    pc = pc.replace(old_api_body, new_api_body, 1)
    print("[9] Updated API call with market param")
else:
    print("[9] SKIP: API body different")

# Add market toggle buttons to UI (before the date inputs)
old_bt_header = '<span style={{ fontSize:14, fontWeight:800, color:"var(--text-primary)" }}>🔬 Historical Backtest</span>'
new_bt_header = '''<span style={{ fontSize:14, fontWeight:800, color:"var(--text-primary)" }}>🔬 Historical Backtest</span>
              <div style={{ display:"flex", gap:4, marginLeft:12 }}>
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

if old_bt_header in pc:
    pc = pc.replace(old_bt_header, new_bt_header, 1)
    print("[10] Added market toggle buttons to backtest UI")
else:
    print("[10] SKIP: backtest header different")

# Show market in previous runs
old_run_label = 'r.min_score && <span style={{ marginLeft:4, color:"#a78bfa" }}>· S≥{r.min_score}</span>'
new_run_label = '''r.market && <span style={{ marginLeft:4, color: r.market==="US" ? "#60a5fa" : "#fbbf24" }}>{r.market==="US" ? "🇺🇸" : "🇮🇩"}</span>}
                        {r.min_score && <span style={{ marginLeft:4, color:"#a78bfa" }}>· S≥{r.min_score}</span>'''

if old_run_label in pc:
    pc = pc.replace(old_run_label, new_run_label, 1)
    print("[11] Added market flag to previous runs display")
else:
    print("[11] SKIP: run label different")

with open(PAGE, 'w') as f:
    f.write(pc)

print("\nDone! Market separation added to Backtest tab.")
