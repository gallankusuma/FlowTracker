#!/usr/bin/env python3
"""Apply crypto-specific tuning based on deep diagnostic results.

Diagnostic findings:
- STRICT (current): 0 patterns everywhere — too tight
- MEDIUM (swingLeft:3, swingRight:2, dAge:10): catches BTC, SOL, BNB, XRP, DOGE, DOT, LINK
- CRYPTO-TUNED (swing:3/2, dAge:8): catches SOL, XRP on daily; XRP, BNB, DOT, LINK on weekly

Root cause: Crypto is 24/7 and more volatile, so:
1. Swing pivots form faster → need SMALLER swingLeft/swingRight (3/2 vs 5/3)
2. Patterns take longer to complete → need HIGHER maxDAge (10 for daily)
3. Price gaps from PRZ are wider → need HIGHER maxPrzGap (15%)

Optimal settings (balances freshness vs availability):
- Daily:   swing 3/2, dAge 10, span 100, gap 15%
- Weekly:  swing 3/2, dAge 5,  span 60,  gap 15%  
- Monthly: swing 2/1, dAge 3,  span 40,  gap 20%
"""
import re

SERVER = '/var/www/flowtracker-scraper/server.js'
with open(SERVER, 'r') as f:
    sc = f.read()

# Find current crypto tfConfig
old = re.search(r"const tfConfig = \{.*?'1mo'.*?\};", sc, re.DOTALL)
if not old:
    print("[1] ❌ Cannot find crypto tfConfig!")
    exit(1)

print(f"[1] Found crypto tfConfig at pos {old.start()}")

# New crypto-specific config with swing parameters
new_config = """const tfConfig = {
            '1d':  { maxPatternSpan: 100, maxDAge: 10, maxPrzGap: 0.15, swingLeft: 3, swingRight: 2 },
            '1wk': { maxPatternSpan: 60,  maxDAge: 5,  maxPrzGap: 0.15, swingLeft: 3, swingRight: 2 },
            '1mo': { maxPatternSpan: 40,  maxDAge: 3,  maxPrzGap: 0.20, swingLeft: 2, swingRight: 1 }
          };"""

sc = sc.replace(old.group(), new_config)

# Now we need to make sure detectHarmonicPatterns receives swingLeft/swingRight
# Check what's passed
detect_call = re.search(r"const patterns = detectHarmonicPatterns\(ohlc, ticker, opts\);", sc)
if detect_call:
    print("[2] ✅ detect call uses opts directly — swing params will pass through")
else:
    print("[2] ⚠️ detect call format unexpected")

with open(SERVER, 'w') as f:
    f.write(sc)
print("[3] ✅ Updated crypto tfConfig with swing-optimized settings")

# Also need to check if the crypto fetch range is correct per interval
# Should be: daily=1y, weekly=2y, monthly=5y
fetch_check = "const range = interval === '1mo' ? '5y' : interval === '1wk' ? '2y' : '1y';"
if fetch_check in sc:
    print("[4] ✅ Crypto fetch range already correct")
else:
    print("[4] ⚠️ Crypto fetch range may need checking")

print("\n=== FINAL CRYPTO CONFIG ===")
print("Daily:   swing=3/2, dAge=10, span=100, gap=15%")
print("Weekly:  swing=3/2, dAge=5,  span=60,  gap=15%")
print("Monthly: swing=2/1, dAge=3,  span=40,  gap=20%")
print("Done!")
