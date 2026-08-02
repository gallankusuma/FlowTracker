#!/usr/bin/env python3
"""Fix timeframe settings to align with TradingView conventions.

TradingView Harmonic Pattern Scanner reference:
- Pivot Left/Right bars: determines swing point sensitivity
  - Daily: swingLeft=5, swingRight=3 (medium sensitivity)
  - Weekly: swingLeft=4, swingRight=2 (slightly more sensitive on weekly)
  - Monthly: swingLeft=3, swingRight=2

- maxDAge: how many candles old can point D be and still be "actionable"
  TradingView shows ALL patterns on chart, but for a SCANNER that generates
  BUY/SELL signals, the D point must be recent enough to act on:
  - Daily:   maxDAge=5  (D within last 5 trading days = 1 week)
  - Weekly:  maxDAge=3  (D within last 3 weeks)
  - Monthly: maxDAge=2  (D within last 2 months)

- maxPatternSpan: how many candles wide can X→D span be
  TradingView recommendation: 12-20 bars for position trading
  - Daily:   60 candles (~3 months of daily data)
  - Weekly:  40 candles (~10 months of weekly data)
  - Monthly: 30 candles (~2.5 years of monthly data)

- maxPrzGap: how far current price can be from PRZ (D level)
  - 8% for IDX (stock market, tighter)
  - 12% for Crypto (more volatile)

- Data range for Yahoo Finance:
  - Daily:   6mo (enough for span 60)
  - Weekly:  2y  (enough for span 40)
  - Monthly: 5y  (enough for span 30)
"""
import re

# ═══════════════════════════════════════════════════
# 1. Fix harmonic-scan-worker.js (IDX & US scanner)
# ═══════════════════════════════════════════════════
WORKER = '/var/www/flowtracker-scraper/harmonic-scan-worker.js'
with open(WORKER, 'r') as f:
    wc = f.read()

# Current (broken by Gemini):
#   '1d':  { maxPatternSpan: 60, maxDAge: 2,  maxPrzGap: 0.08, swingLeft: 5, swingRight: 3 },
#   '1wk': { maxPatternSpan: 40, maxDAge: 1,  maxPrzGap: 0.08, swingLeft: 4, swingRight: 2 },
#   '1mo': { maxPatternSpan: 30, maxDAge: 1,  maxPrzGap: 0.08, swingLeft: 3, swingRight: 2 },

old_tf = """const TF_CONFIG = {
  '1d':  { maxPatternSpan: 60, maxDAge: 2,  maxPrzGap: 0.08, swingLeft: 5, swingRight: 3 },
  '1wk': { maxPatternSpan: 40, maxDAge: 1,  maxPrzGap: 0.08, swingLeft: 4, swingRight: 2 },
  '1mo': { maxPatternSpan: 30, maxDAge: 1,  maxPrzGap: 0.08, swingLeft: 3, swingRight: 2 },
};"""

new_tf = """const TF_CONFIG = {
  '1d':  { maxPatternSpan: 60, maxDAge: 5,  maxPrzGap: 0.08, swingLeft: 5, swingRight: 3 },
  '1wk': { maxPatternSpan: 40, maxDAge: 3,  maxPrzGap: 0.08, swingLeft: 4, swingRight: 2 },
  '1mo': { maxPatternSpan: 30, maxDAge: 2,  maxPrzGap: 0.08, swingLeft: 3, swingRight: 2 },
};"""

if old_tf in wc:
    wc = wc.replace(old_tf, new_tf)
    with open(WORKER, 'w') as f:
        f.write(wc)
    print("[1] ✅ Fixed IDX/US TF_CONFIG (D:5/W:3/M:2)")
else:
    # Try to find whatever is there
    m = re.search(r"const TF_CONFIG = \{.*?\};", wc, re.DOTALL)
    if m:
        print(f"[1] ⚠️ TF_CONFIG found but different:\n{m.group()[:200]}")
        wc = wc.replace(m.group(), new_tf)
        with open(WORKER, 'w') as f:
            f.write(wc)
        print("[1] ✅ Replaced with correct TF_CONFIG")
    else:
        print("[1] ❌ TF_CONFIG not found!")

# ═══════════════════════════════════════════════════
# 2. Fix server.js (Crypto scanner)
# ═══════════════════════════════════════════════════
SERVER = '/var/www/flowtracker-scraper/server.js'
with open(SERVER, 'r') as f:
    sc = f.read()

# Current (broken by Gemini): inline tfConfig with maxDAge 2/1/1
# Find the crypto tfConfig block
old_crypto = re.search(
    r"const tfConfig = \{.*?'1mo'.*?\};",
    sc, re.DOTALL
)

new_crypto_config = """const tfConfig = {
            '1d':  { maxPatternSpan: 80, maxDAge: 5, maxPrzGap: 0.12 },
            '1wk': { maxPatternSpan: 60, maxDAge: 3, maxPrzGap: 0.12 },
            '1mo': { maxPatternSpan: 40, maxDAge: 2, maxPrzGap: 0.15 }
          };"""

if old_crypto:
    sc = sc.replace(old_crypto.group(), new_crypto_config)
    with open(SERVER, 'w') as f:
        f.write(sc)
    print(f"[2] ✅ Fixed Crypto tfConfig (D:5/W:3/M:2)")
else:
    print("[2] ⚠️ Crypto tfConfig not found")

# ═══════════════════════════════════════════════════
# 3. Verify the fetch range is correct per interval
# ═══════════════════════════════════════════════════
with open(SERVER, 'r') as f:
    sc = f.read()

# Check crypto fetch range
if "const range = interval === '1mo' ? '5y' : interval === '1wk' ? '2y' : '1y';" in sc:
    print("[3] ✅ Crypto fetch range already dynamic (1y/2y/5y)")
elif "fetchYahooCandles(ticker, '1y')" in sc:
    print("[3] ⚠️ Crypto fetch range still hardcoded to 1y")
else:
    print("[3] ℹ️ Crypto fetch range status unknown")

# Check worker fetch range
with open(WORKER, 'r') as f:
    wc = f.read()
fetch_match = re.search(r"const range = .*?;", wc)
if fetch_match:
    print(f"[4] Worker fetch range: {fetch_match.group()[:80]}")

print("\n=== FINAL CONFIG ===")
print("IDX/US (worker):  D:5/W:3/M:2, Span:60/40/30, Gap:8%/8%/8%")
print("Crypto (server):  D:5/W:3/M:2, Span:80/60/40, Gap:12%/12%/15%")
print("Done!")
