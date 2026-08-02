#!/usr/bin/env python3
"""Fix crypto scan: maxDAge too tight. 
Crypto patterns with dAge 37-130 are all old.
Increase maxDAge to 60 for daily, 20 for weekly.
Also increase range from 6mo to 1y for more data.
"""
SERVER = '/var/www/flowtracker-scraper/server.js'
with open(SERVER, 'r') as f:
    sc = f.read()

# 1. Loosen crypto detect params
old = "const patterns = detectHarmonicPatterns(ohlc, ticker, { maxPatternSpan: 80, maxDAge: 10, maxPrzGap: 0.12 });"
new = "const patterns = detectHarmonicPatterns(ohlc, ticker, { maxPatternSpan: 120, maxDAge: 60, maxPrzGap: 0.15 });"

if old in sc:
    sc = sc.replace(old, new, 1)
    print("[1] Loosened crypto params: span 120, dAge 60, gap 15%")
else:
    print("[1] SKIP: exact pattern not found")

# 2. Increase crypto fetch range from 6mo to 1y for more data
old_range = "const raw = await fetchYahooCandles(ticker, '6mo');"
# Count occurrences - only change the one in crypto scan context
count = sc.count(old_range)
print(f"[2] Found {count} fetchYahooCandles(ticker, '6mo') calls")

# The crypto scan is around line 3827, let's only change that one
# Find the crypto section and replace there
import re
# Find the section with CRYPTO_WEIGHTS and change the fetch range
crypto_section = re.search(r'(const CRYPTO_WEIGHTS.*?)(const raw = await fetchYahooCandles\(ticker, .6mo.\);)', sc, re.DOTALL)
if crypto_section:
    old_crypto_fetch = crypto_section.group(2)
    new_crypto_fetch = "const raw = await fetchYahooCandles(ticker, '1y');"
    sc = sc.replace(old_crypto_fetch, new_crypto_fetch, 1)
    print("[3] Changed crypto fetch range to 1y")
else:
    print("[3] SKIP")

with open(SERVER, 'w') as f:
    f.write(sc)

print("Done!")
