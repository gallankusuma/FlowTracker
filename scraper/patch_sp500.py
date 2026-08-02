#!/usr/bin/env python3
"""
Add S&P 500 (Top 100) scanner support:
1. Add TOP_US_STOCKS list to worker
2. Add US market handling in server.js
3. Add US button in frontend
"""

# ── PART 1: Add US stocks to worker ──
WORKER = '/var/www/flowtracker-scraper/harmonic-scan-worker.js'
with open(WORKER, 'r') as f:
    wc = f.read()

# Add TOP_US_STOCKS list after TOP_STOCKS
us_stocks = """
// Top 100 S&P 500 stocks
const TOP_US_STOCKS = [
  'AAPL','MSFT','AMZN','NVDA','GOOGL','META','TSLA','BRK-B','UNH','LLY',
  'JPM','XOM','V','AVGO','JNJ','PG','MA','HD','COST','MRK',
  'ABBV','CVX','CRM','AMD','PEP','KO','ADBE','WMT','BAC','MCD',
  'CSCO','TMO','NFLX','ACN','ABT','LIN','DHR','ORCL','CMCSA','WFC',
  'INTC','VZ','DIS','PM','INTU','IBM','QCOM','TXN','AMGN','CAT',
  'GE','NOW','UNP','HON','ISRG','GS','LOW','BA','PFE','MS',
  'RTX','ELV','SPGI','BLK','AMAT','AXP','DE','SYK','BKNG','LMT',
  'MDLZ','GILD','ADI','ADP','TJX','MMC','REGN','VRTX','CI','PLD',
  'CB','PYPL','SCHW','SO','MO','LRCX','ZTS','DUK','SNPS','CME',
  'CL','BMY','AON','FI','ICE','EQIX','SHW','PGR','MCK','NOC'
];
"""

if 'TOP_US_STOCKS' not in wc:
    # Insert after the existing TOP_STOCKS array
    insert_marker = "const INTERVAL = process.argv[5] || '1d';"
    if insert_marker in wc:
        wc = wc.replace(insert_marker, us_stocks + "\n" + insert_marker, 1)
        print("[W1] Added TOP_US_STOCKS (100 tickers)")
    else:
        print("[W1] SKIP: marker not found")
else:
    print("[W1] SKIP: already exists")

# Update stock list selection based on market
old_market_check = "const stocks = MARKET === 'CRYPTO'"
if old_market_check in wc:
    # Find the full line
    import re
    m = re.search(r'const stocks = MARKET === .CRYPTO.*?;', wc)
    if m:
        old_line = m.group(0)
        new_line = "const stocks = MARKET === 'CRYPTO' ? TOP_CRYPTO : MARKET === 'US' ? TOP_US_STOCKS : TOP_STOCKS;"
        wc = wc.replace(old_line, new_line, 1)
        print("[W2] Updated stock list to include US market")
    else:
        print("[W2] SKIP: regex failed")
else:
    print("[W2] SKIP: market check not found")

# For US stocks, ticker doesn't need .JK suffix
# Check how Yahoo URL is built
yahoo_search = re.search(r"const symbol = .*?;", wc)
if yahoo_search:
    old_symbol = yahoo_search.group(0)
    print(f"[W3] Current symbol line: {old_symbol}")
    # We need to handle US tickers (no suffix) vs IDX (.JK)
    if "MARKET" not in old_symbol:
        new_symbol = "const symbol = MARKET === 'US' ? ticker : MARKET === 'CRYPTO' ? `${ticker}-USD` : `${ticker}.JK`;"
        wc = wc.replace(old_symbol, new_symbol, 1)
        print("[W3] Updated symbol to handle US/CRYPTO/IDX")
    else:
        print("[W3] SKIP: already has MARKET logic")
else:
    print("[W3] SKIP: symbol line not found")

with open(WORKER, 'w') as f:
    f.write(wc)

# ── PART 2: Add US endpoint to server.js ──
SERVER = '/var/www/flowtracker-scraper/server.js'
with open(SERVER, 'r') as f:
    sc = f.read()

# Add US scan endpoint (copy from IDX with market=US)
# Check if the worker spawn passes the market parameter
spawn_search = re.search(r"_startScanWorker.*?\{[^}]*spawn.*?harmonic-scan-worker.*?\[.*?\]", sc, re.DOTALL)
if spawn_search:
    print("[S1] Found worker spawn, checking market param...")
else:
    print("[S1] SKIP: spawn not found")

# Add /api/harmonic-scan-us endpoint
if '/api/harmonic-scan-us' not in sc:
    # Find the existing harmonic-scan endpoint and add US version after it
    us_endpoint = """
app.get('/api/harmonic-scan-us', (req, res) => {
  const { min_score = 50, min_rr = 1.5, force, interval } = req.query;
  const reqInterval = interval || '1d';
  const now = Date.now();

  if (_harmonicScanCache.scanning) {
    return res.json({
      scanned: 0, found: 0, errors: 0,
      date: new Date().toISOString().slice(0,10),
      results: [],
      scanning: true,
      progress: _harmonicScanCache.progress,
      message: 'Scan running in background, refresh in 30 seconds',
    });
  }

  // Start US scan
  _startScanWorker(Number(min_rr), reqInterval, !!force, 'US');

  return res.json({
    scanned: 0, found: 0, errors: 0,
    date: new Date().toISOString().slice(0,10),
    results: [],
    scanning: true,
    progress: '0/100',
    message: 'S&P 500 scan started, refresh in 2-3 minutes',
  });
});
"""
    # Insert before the last app.listen or before a known endpoint
    insert_before = "app.get('/api/harmonic-scan/status'"
    if insert_before in sc:
        sc = sc.replace(insert_before, us_endpoint + "\n" + insert_before, 1)
        print("[S2] Added /api/harmonic-scan-us endpoint")
    else:
        print("[S2] SKIP: insert marker not found")
else:
    print("[S2] SKIP: already exists")

# Update _startScanWorker to accept market parameter
old_fn = "function _startScanWorker(minRR = 1.0, interval = '1d', force = false) {"
new_fn = "function _startScanWorker(minRR = 1.0, interval = '1d', force = false, market = 'IDX') {"
if old_fn in sc:
    sc = sc.replace(old_fn, new_fn, 1)
    print("[S3] Updated _startScanWorker signature with market param")
else:
    print("[S3] SKIP")

# Update the spawn args to pass market
old_spawn_args = "String(minRR), 'IDX', interval"
new_spawn_args = "String(minRR), market, interval"
if old_spawn_args in sc:
    sc = sc.replace(old_spawn_args, new_spawn_args, 1)
    print("[S4] Updated spawn args to pass market param")
else:
    print("[S4] SKIP")

with open(SERVER, 'w') as f:
    f.write(sc)

# ── PART 3: Add US button to frontend ──
PAGE = '/var/www/flowtracker/app/signal-scanner/page.tsx'
with open(PAGE, 'r') as f:
    pc = f.read()

# Add "US" to market type
old_market_type = 'const [market, setMarket] = useState<"IDX" | "CRYPTO">("IDX");'
new_market_type = 'const [market, setMarket] = useState<"IDX" | "CRYPTO" | "US">("IDX");'
if old_market_type in pc:
    pc = pc.replace(old_market_type, new_market_type, 1)
    print("[F1] Added US to market state type")
else:
    print("[F1] SKIP")

# Add US button alongside IDX and CRYPTO
old_buttons = '{(["IDX","CRYPTO"] as const).map(m => ('
new_buttons = '{(["IDX","CRYPTO","US"] as const).map(m => ('
count = pc.count(old_buttons)
if count > 0:
    pc = pc.replace(old_buttons, new_buttons)
    print(f"[F2] Added US to market buttons ({count} locations)")
else:
    print("[F2] SKIP")

# Update button label for US
old_label = '{m === "CRYPTO" ? "🪙 CRYPTO" : "🇮🇩 IDX"}'
new_label = '{m === "CRYPTO" ? "🪙 CRYPTO" : m === "US" ? "🇺🇸 S&P 500" : "🇮🇩 IDX"}'
if old_label in pc:
    pc = pc.replace(old_label, new_label)
    print("[F3] Updated button labels with US flag")
else:
    print("[F3] SKIP")

# Update button styling for US
old_bg = """                    background: market === m
                      ? m === "CRYPTO"
                        ? "linear-gradient(135deg, #f59e0b, #fbbf24)"
                        : "linear-gradient(135deg, #3b82f6, #6366f1)"
                      : "transparent",
                    color: market === m ? (m === "CRYPTO" ? "#000" : "#fff") : "var(--text-muted)","""
new_bg = """                    background: market === m
                      ? m === "CRYPTO"
                        ? "linear-gradient(135deg, #f59e0b, #fbbf24)"
                        : m === "US"
                        ? "linear-gradient(135deg, #dc2626, #1d4ed8)"
                        : "linear-gradient(135deg, #3b82f6, #6366f1)"
                      : "transparent",
                    color: market === m ? (m === "CRYPTO" ? "#000" : "#fff") : "var(--text-muted)","""
if old_bg in pc:
    pc = pc.replace(old_bg, new_bg)
    print("[F4] Updated button colors for US (red-blue gradient)")
else:
    print("[F4] SKIP: button bg not found")

# Update scan endpoint URL to include US
old_endpoint = """      const endpoint = market === "CRYPTO"
        ? `${apiBase}/api/harmonic-scan-crypto?min_score=${minScore}&min_rr=${minRR}&interval=${timeframe}`
        : `${apiBase}/api/harmonic-scan?min_score=${minScore}&min_rr=${minRR}&interval=${timeframe}&force=1`;
      const pollEndpoint = market === "CRYPTO"
        ? `${apiBase}/api/harmonic-scan-crypto?min_score=${minScore}&min_rr=${minRR}&interval=${timeframe}`
        : `${apiBase}/api/harmonic-scan?min_score=${minScore}&min_rr=${minRR}&interval=${timeframe}`;"""

new_endpoint = """      const endpoint = market === "CRYPTO"
        ? `${apiBase}/api/harmonic-scan-crypto?min_score=${minScore}&min_rr=${minRR}&interval=${timeframe}`
        : market === "US"
        ? `${apiBase}/api/harmonic-scan-us?min_score=${minScore}&min_rr=${minRR}&interval=${timeframe}&force=1`
        : `${apiBase}/api/harmonic-scan?min_score=${minScore}&min_rr=${minRR}&interval=${timeframe}&force=1`;
      const pollEndpoint = market === "CRYPTO"
        ? `${apiBase}/api/harmonic-scan-crypto?min_score=${minScore}&min_rr=${minRR}&interval=${timeframe}`
        : market === "US"
        ? `${apiBase}/api/harmonic-scan-us?min_score=${minScore}&min_rr=${minRR}&interval=${timeframe}`
        : `${apiBase}/api/harmonic-scan?min_score=${minScore}&min_rr=${minRR}&interval=${timeframe}`;"""

if old_endpoint in pc:
    pc = pc.replace(old_endpoint, new_endpoint, 1)
    print("[F5] Updated scan endpoints for US market")
else:
    print("[F5] SKIP")

# Update scan button label for US
old_scan_label = """? "🪙 Scan 25 Crypto" : `Scan ${timeframe === "1d" ? "Daily" : timeframe === "1wk" ? "Weekly" : "Monthly"} IDX`"""
new_scan_label = """? "🪙 Scan 25 Crypto" : market === "US" ? `🇺🇸 Scan ${timeframe === "1d" ? "Daily" : timeframe === "1wk" ? "Weekly" : "Monthly"} S&P 100` : `Scan ${timeframe === "1d" ? "Daily" : timeframe === "1wk" ? "Weekly" : "Monthly"} IDX`"""
if old_scan_label in pc:
    pc = pc.replace(old_scan_label, new_scan_label, 1)
    print("[F6] Updated scan button label for US")
else:
    print("[F6] SKIP")

# Update scan button color for US
old_scan_color = """              background: scanning ? "rgba(99,102,241,0.3)"
                : market === "CRYPTO"
                ? "linear-gradient(135deg, #f59e0b, #fbbf24)"
                : "linear-gradient(135deg, #6366f1, #8b5cf6)",
              color: market === "CRYPTO" ? "#000" : "#fff","""
new_scan_color = """              background: scanning ? "rgba(99,102,241,0.3)"
                : market === "CRYPTO"
                ? "linear-gradient(135deg, #f59e0b, #fbbf24)"
                : market === "US"
                ? "linear-gradient(135deg, #dc2626, #1d4ed8)"
                : "linear-gradient(135deg, #6366f1, #8b5cf6)",
              color: market === "CRYPTO" ? "#000" : "#fff","""
if old_scan_color in pc:
    pc = pc.replace(old_scan_color, new_scan_color, 1)
    print("[F7] Updated scan button color for US")
else:
    print("[F7] SKIP")

# Update journal market filter to include US
old_journal = 'const [journalMarket, setJournalMarket] = useState<"ALL" | "IDX" | "CRYPTO">("ALL");'
new_journal = 'const [journalMarket, setJournalMarket] = useState<"ALL" | "IDX" | "CRYPTO" | "US">("ALL");'
if old_journal in pc:
    pc = pc.replace(old_journal, new_journal, 1)
    print("[F8] Updated journal market type with US")
else:
    print("[F8] SKIP")

old_journal_btns = '{(["ALL","IDX","CRYPTO"] as const).map(m => ('
new_journal_btns = '{(["ALL","IDX","CRYPTO","US"] as const).map(m => ('
if old_journal_btns in pc:
    pc = pc.replace(old_journal_btns, new_journal_btns)
    print("[F9] Updated journal market buttons with US")
else:
    print("[F9] SKIP")

with open(PAGE, 'w') as f:
    f.write(pc)

print("\nDone!")
