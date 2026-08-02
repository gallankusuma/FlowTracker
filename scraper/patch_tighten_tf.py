#!/usr/bin/env python3
"""Tighten timeframe filters for all markets (IDX, US, Crypto)
so signals are always FRESH (D point is recent).
"""
import re

# 1. Update harmonic-scan-worker.js (IDX & US)
WORKER = '/var/www/flowtracker-scraper/harmonic-scan-worker.js'
with open(WORKER, 'r') as f:
    wc = f.read()

# Tighten the maxDAge parameters
old_1d = "'1d':  { maxPatternSpan: 60, maxDAge: 5,  maxPrzGap: 0.08, swingLeft: 5, swingRight: 3 },"
new_1d = "'1d':  { maxPatternSpan: 60, maxDAge: 2,  maxPrzGap: 0.08, swingLeft: 5, swingRight: 3 },"

old_1wk = "'1wk': { maxPatternSpan: 40, maxDAge: 4,  maxPrzGap: 0.08, swingLeft: 4, swingRight: 2 },"
new_1wk = "'1wk': { maxPatternSpan: 40, maxDAge: 1,  maxPrzGap: 0.08, swingLeft: 4, swingRight: 2 },"

old_1mo = "'1mo': { maxPatternSpan: 30, maxDAge: 3,  maxPrzGap: 0.08, swingLeft: 3, swingRight: 2 },"
new_1mo = "'1mo': { maxPatternSpan: 30, maxDAge: 1,  maxPrzGap: 0.08, swingLeft: 3, swingRight: 2 },"

if old_1d in wc:
    wc = wc.replace(old_1d, new_1d)
    wc = wc.replace(old_1wk, new_1wk)
    wc = wc.replace(old_1mo, new_1mo)
    print("[1] Tightened maxDAge in harmonic-scan-worker.js (IDX/US)")
    with open(WORKER, 'w') as f:
        f.write(wc)
else:
    print("[1] SKIP: worker config not found or already changed")

# 2. Update server.js (Crypto)
SERVER = '/var/www/flowtracker-scraper/server.js'
with open(SERVER, 'r') as f:
    sc = f.read()

# Make crypto use interval-based config just like IDX, instead of hardcoded 120/60
# First find where interval is extracted in the crypto route
# The route is: app.get('/api/harmonic-scan-crypto', async (req, res) => {
# and it extracts: const { min_score = 0, min_rr = 0, interval = '1d', force = '0' } = req.query;

crypto_scan_config = "const patterns = detectHarmonicPatterns(ohlc, ticker, { maxPatternSpan: 120, maxDAge: 60, maxPrzGap: 0.15 });"
crypto_scan_new = """const tfConfig = {
            '1d':  { maxPatternSpan: 80, maxDAge: 2, maxPrzGap: 0.12 },
            '1wk': { maxPatternSpan: 60, maxDAge: 1, maxPrzGap: 0.15 },
            '1mo': { maxPatternSpan: 40, maxDAge: 1, maxPrzGap: 0.15 }
          };
          const opts = tfConfig[interval] || tfConfig['1d'];
          const patterns = detectHarmonicPatterns(ohlc, ticker, opts);"""

if crypto_scan_config in sc:
    sc = sc.replace(crypto_scan_config, crypto_scan_new)
    print("[2] Tightened maxDAge and added interval logic in server.js (Crypto)")
    with open(SERVER, 'w') as f:
        f.write(sc)
else:
    print("[2] SKIP: crypto config not found or already changed")

# 3. For the Crypto fetch interval, wait, the fetch interval is hardcoded to '1y' instead of using the `interval` param!
# Let's fix that.
with open(SERVER, 'r') as f:
    sc = f.read()

# Let's check how the fetch is done
fetch_call = "const raw = await fetchYahooCandles(ticker, '1y');"
# We should change it to use interval
# Actually, the crypto endpoint doesn't pass interval to fetchYahooCandles properly if we just hardcode 1y.
# Wait, fetchYahooCandles(ticker, range, interval='1d') is the signature in fibonacci.js/server.js.
# Let's look at how fetchYahooCandles is called in server.js for crypto.
fetch_call_1y = "const raw = await fetchYahooCandles(ticker, '1y');"
fetch_call_dynamic = "const range = interval === '1mo' ? '5y' : interval === '1wk' ? '2y' : '1y';\n          const raw = await fetchYahooCandles(ticker, range, interval);"

if fetch_call_1y in sc:
    sc = sc.replace(fetch_call_1y, fetch_call_dynamic)
    print("[3] Fixed fetchYahooCandles to use proper interval/range for Crypto")
    with open(SERVER, 'w') as f:
        f.write(sc)
else:
    print("[3] SKIP: fetch call 1y not found")

print("Done tightening filters!")
