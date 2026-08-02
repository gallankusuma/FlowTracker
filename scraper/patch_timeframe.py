#!/usr/bin/env python3
"""Add timeframe selector: Daily/Weekly/Monthly for harmonic scanner."""

# ── PART 1: Worker - accept interval param ──
WORKER = '/var/www/flowtracker-scraper/harmonic-scan-worker.js'
with open(WORKER, 'r') as f:
    wc = f.read()

# Add INTERVAL arg parsing
old_args = """const OUTPUT_FILE = process.argv[2] || '/tmp/harmonic-scan-results.json';
const MIN_RR = Number(process.argv[3] || 1.0);
const MARKET = (process.argv[4] || 'IDX').toUpperCase();"""
new_args = """const OUTPUT_FILE = process.argv[2] || '/tmp/harmonic-scan-results.json';
const MIN_RR = Number(process.argv[3] || 1.0);
const MARKET = (process.argv[4] || 'IDX').toUpperCase();
const INTERVAL = process.argv[5] || '1d'; // 1d, 1wk, 1mo"""
if 'INTERVAL' not in wc:
    wc = wc.replace(old_args, new_args, 1)
    print("[W1] Added INTERVAL arg")
else:
    print("[W1] SKIP: INTERVAL exists")

# Update Yahoo fetch URL to use INTERVAL
old_url = "const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=1d`;"
new_url = "const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${INTERVAL || '1d'}`;"
if old_url in wc:
    wc = wc.replace(old_url, new_url, 1)
    print("[W2] Updated Yahoo URL to use INTERVAL")
else:
    print("[W2] SKIP: URL not found")

# Increase range for weekly/monthly to get enough data points
old_range = "const range = days >= 150 ? '6mo' : days >= 80 ? '3mo' : '1mo';"
new_range = """const range = INTERVAL === '1mo' ? '5y' : INTERVAL === '1wk' ? '2y' : days >= 150 ? '6mo' : days >= 80 ? '3mo' : '1mo';"""
if old_range in wc:
    wc = wc.replace(old_range, new_range, 1)
    print("[W3] Updated range for weekly/monthly")
else:
    print("[W3] SKIP: range not found")

# Include interval in output
old_output = """    date: today, ts: Date.now(),"""
new_output = """    date: today, ts: Date.now(), interval: INTERVAL,"""
if 'interval: INTERVAL' not in wc:
    wc = wc.replace(old_output, new_output, 1)
    print("[W4] Added interval to output")
else:
    print("[W4] SKIP")

with open(WORKER, 'w') as f:
    f.write(wc)

# ── PART 2: Server - pass interval to worker ──
SERVER = '/var/www/flowtracker-scraper/server.js'
with open(SERVER, 'r') as f:
    sc = f.read()

# Update _startScanWorker to accept interval
old_start = """function _startScanWorker(minRR = 1.0) {
  if (_scanProcess || _harmonicScanCache.scanning) return;
  
  _harmonicScanCache.scanning = true;
  _harmonicScanCache.progress = '0/124';
  console.log('[harmonic-scan] Spawning worker process...');
  
  const workerPath = path.join(__dirname, 'harmonic-scan-worker.js');
  const workerEnv = { ...process.env };
  if (_customWeights) workerEnv.SCAN_WEIGHTS = JSON.stringify(_customWeights);
  _scanProcess = spawn('node', [workerPath, SCAN_RESULTS_FILE, String(minRR)], {"""

new_start = """function _startScanWorker(minRR = 1.0, interval = '1d') {
  if (_scanProcess || _harmonicScanCache.scanning) return;
  
  _harmonicScanCache.scanning = true;
  _harmonicScanCache.progress = '0/124';
  console.log(`[harmonic-scan] Spawning worker process... interval=${interval}`);
  
  const workerPath = path.join(__dirname, 'harmonic-scan-worker.js');
  const workerEnv = { ...process.env };
  if (_customWeights) workerEnv.SCAN_WEIGHTS = JSON.stringify(_customWeights);
  _scanProcess = spawn('node', [workerPath, SCAN_RESULTS_FILE, String(minRR), 'IDX', interval], {"""

if 'interval = \'1d\'' not in sc:
    sc = sc.replace(old_start, new_start, 1)
    print("[S1] Updated _startScanWorker with interval param")
else:
    print("[S1] SKIP")

# Update the scan endpoint to pass interval
old_call = "  _startScanWorker(Number(min_rr));"
new_call = "  _startScanWorker(Number(min_rr), interval || '1d');"
if old_call in sc:
    sc = sc.replace(old_call, new_call, 1)
    print("[S2] Updated _startScanWorker call")
else:
    print("[S2] SKIP")

# Add interval to query params
old_query = "  const { tickers, min_score = 50, min_rr = 1.5, force } = req.query;"
new_query = "  const { tickers, min_score = 50, min_rr = 1.5, force, interval } = req.query;"
# Only replace the one in /api/harmonic-scan (not crypto)
idx = sc.find("app.get('/api/harmonic-scan',")
if idx > 0:
    pos = sc.find(old_query, idx)
    if pos > 0 and pos < idx + 500:
        sc = sc[:pos] + new_query + sc[pos + len(old_query):]
        print("[S3] Added interval to query params")
    else:
        print("[S3] SKIP: query not found near endpoint")
else:
    print("[S3] SKIP: endpoint not found")

with open(SERVER, 'w') as f:
    f.write(sc)

# ── PART 3: Frontend - add timeframe selector ──
PAGE = '/var/www/flowtracker/app/signal-scanner/page.tsx'
with open(PAGE, 'r') as f:
    pc = f.read()

# Add timeframe state
anchor = '  const [market, setMarket] = useState<"IDX" | "CRYPTO">("IDX");'
tf_state = '\n  const [timeframe, setTimeframe] = useState<"1d" | "1wk" | "1mo">("1d");'
if 'timeframe' not in pc:
    pc = pc.replace(anchor, anchor + tf_state, 1)
    print("[F1] Added timeframe state")
else:
    print("[F1] SKIP")

# Add interval to scan URL
old_endpoint = '? `${apiBase}/api/harmonic-scan-crypto?min_score=${minScore}&min_rr=${minRR}`'
new_endpoint = '? `${apiBase}/api/harmonic-scan-crypto?min_score=${minScore}&min_rr=${minRR}&interval=${timeframe}`'
if old_endpoint in pc:
    pc = pc.replace(old_endpoint, new_endpoint, 1)
    print("[F2a] Added interval to crypto endpoint")
else:
    print("[F2a] SKIP")

old_idx_ep = ': `${apiBase}/api/harmonic-scan?min_score=${minScore}&min_rr=${minRR}`;'
new_idx_ep = ': `${apiBase}/api/harmonic-scan?min_score=${minScore}&min_rr=${minRR}&interval=${timeframe}`;'
if old_idx_ep in pc:
    pc = pc.replace(old_idx_ep, new_idx_ep, 1)
    print("[F2b] Added interval to IDX endpoint")
else:
    print("[F2b] SKIP")

# Add timeframe buttons in the UI - after the market toggle buttons
# Find the MinR:R input area to add timeframe selector nearby
old_search = '🔍 Search Ticker...'
# Find the line with the search input
search_idx = pc.find(old_search)
if search_idx > 0:
    # Find the parent div that contains the control row
    # Look for the market toggle section
    market_toggle = 'setMarket(m as "IDX" | "CRYPTO")'
    mt_idx = pc.find(market_toggle)
    if mt_idx > 0:
        # Find the end of the market toggle section and insert after it
        # Look for the closing of the button map
        end_buttons = pc.find('))}', mt_idx)
        if end_buttons > 0:
            # Insert timeframe selector after market toggle
            # Find the right closing point (after the market button row)
            # Find the next </div> after the market buttons
            insert_point = pc.find('</div>', end_buttons + 5)
            if insert_point > 0:
                insert_point += 6  # after </div>
                tf_ui = '''
                {/* Timeframe Selector */}
                <div style={{ display: "flex", gap: 2, padding: 2, background: "rgba(255,255,255,0.04)", borderRadius: 8 }}>
                  {(["1d", "1wk", "1mo"] as const).map(tf => (
                    <button key={tf} onClick={() => setTimeframe(tf)} style={{
                      padding: "5px 10px", borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: "pointer",
                      border: "none",
                      background: timeframe === tf ? "rgba(99,102,241,0.8)" : "transparent",
                      color: timeframe === tf ? "#fff" : "var(--text-muted)",
                      transition: "all 0.2s",
                    }}>
                      {tf === "1d" ? "Daily" : tf === "1wk" ? "Weekly" : "Monthly"}
                    </button>
                  ))}
                </div>'''
                pc = pc[:insert_point] + tf_ui + pc[insert_point:]
                print("[F3] Added timeframe selector UI")
            else:
                print("[F3] SKIP: insert point not found")
        else:
            print("[F3] SKIP: end buttons not found")
    else:
        print("[F3] SKIP: market toggle not found")
else:
    print("[F3] SKIP: search not found")

with open(PAGE, 'w') as f:
    f.write(pc)
print("Done!")
