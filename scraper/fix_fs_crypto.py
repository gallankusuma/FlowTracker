#!/usr/bin/env python3
"""Fix two bugs:
1. fs not defined in server.js - add require('fs')
2. Crypto scan 0 results - loosen D-age filter for crypto (crypto markets are 24/7)
"""

# ── FIX 1: Add fs require to server.js ──
SERVER = '/var/www/flowtracker-scraper/server.js'
with open(SERVER, 'r') as f:
    sc = f.read()

if "require('fs')" not in sc and 'require("fs")' not in sc:
    old_path = "const path    = require('path');"
    new_path = "const path    = require('path');\nconst fs      = require('fs');"
    if old_path in sc:
        sc = sc.replace(old_path, new_path, 1)
        print("[1] Added require('fs') to server.js")
    else:
        print("[1] SKIP: path require not found")
else:
    print("[1] SKIP: fs already imported")

with open(SERVER, 'w') as f:
    f.write(sc)

# ── FIX 2: Loosen crypto D-age filter ──
# Crypto trades 24/7 so candles are every day including weekends
# Also crypto is more volatile, patterns form/break faster
# maxDAge of 5 is too tight for crypto weekly - let's make it configurable

# Check the crypto scan endpoint to see if it passes options
import re

# Check how crypto scan calls detectHarmonicPatterns
m = re.search(r"detectHarmonicPatterns\(ohlc, ticker.*?\)", sc)
if m:
    print(f"[2] Crypto detect call: {m.group(0)[:80]}")
else:
    print("[2] Crypto detect call not found in server.js")

# The crypto scan runs inline in server.js, not via the worker
# Let's find it and update the options
crypto_detect = "const patterns = detectHarmonicPatterns(ohlc, ticker, { maxPatternSpan: 60, maxDAge: 5, maxPrzGap: 0.08 });"
if crypto_detect in sc:
    with open(SERVER, 'r') as f:
        sc = f.read()
    crypto_detect_new = "const patterns = detectHarmonicPatterns(ohlc, ticker, { maxPatternSpan: 80, maxDAge: 10, maxPrzGap: 0.12 });"
    sc = sc.replace(crypto_detect, crypto_detect_new, 1)
    with open(SERVER, 'w') as f:
        f.write(sc)
    print("[3] Loosened crypto detect: span 80, dAge 10, gap 12%")
else:
    print("[3] SKIP: crypto detect not found with those params")
    # Check what's there
    with open(SERVER, 'r') as f:
        sc2 = f.read()
    m2 = re.findall(r'detectHarmonicPatterns\(.*?\)', sc2)
    for mm in m2:
        print(f"    Found: {mm[:80]}")

print("Done!")
