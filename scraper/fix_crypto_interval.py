#!/usr/bin/env python3
"""
Fix 3 things:
1. Crypto endpoint: add 'interval' to query extraction
2. Reset winrate data (clear old recommendations)
3. Update backtest system to use latest settings
"""
import re

SERVER = '/var/www/flowtracker-scraper/server.js'
with open(SERVER, 'r') as f:
    sc = f.read()

# ═══════════════════════════════════════════════════
# 1. Fix crypto endpoint: extract 'interval' from query
# ═══════════════════════════════════════════════════
old_query = "const { tickers, min_score = 5, min_rr = 1.5 } = req.query;"
new_query = "const { tickers, min_score = 5, min_rr = 1.5, interval = '1d' } = req.query;"

if old_query in sc:
    sc = sc.replace(old_query, new_query, 1)
    print("[1] ✅ Added 'interval' to crypto query extraction")
else:
    # Check if already has interval
    if "interval = '1d'" in sc and 'harmonic-scan-crypto' in sc:
        print("[1] ✅ Already has interval extraction")
    else:
        print("[1] ⚠️ Could not find crypto query line")

# Also fix the fetchYahooCandles call — make sure it passes interval
# Find: const range = interval === '1mo' ? '5y' : interval === '1wk' ? '2y' : '1y';
# and:  const raw = await fetchYahooCandles(ticker, range, interval);
range_line = "const range = interval === '1mo' ? '5y' : interval === '1wk' ? '2y' : '1y';"
if range_line in sc:
    print("[2] ✅ Dynamic range already present")
else:
    print("[2] ⚠️ Range logic may need checking")

with open(SERVER, 'w') as f:
    f.write(sc)

print("\nDone with crypto fix!")
