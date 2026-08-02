#!/usr/bin/env python3
"""Fix: for weekly/monthly intervals, bypass DB cache and fetch directly from Yahoo."""
FILE = '/var/www/flowtracker-scraper/harmonic-scan-worker.js'

with open(FILE, 'r') as f:
    content = f.read()

# Replace the ohlc fetch line to handle different intervals
old_fetch = "      const ohlc = await fetchAndCacheOHLC(ticker, 180);"

new_fetch = """      // For non-daily intervals, fetch directly from Yahoo (DB only has daily data)
      let ohlc;
      if (INTERVAL !== '1d') {
        const range = INTERVAL === '1mo' ? '5y' : '2y';
        const raw = await fetchYahooCandles(ticker, range);
        ohlc = (raw.candles || []).filter(c => c.close > 0);
      } else {
        ohlc = await fetchAndCacheOHLC(ticker, 180);
      }"""

if old_fetch in content:
    content = content.replace(old_fetch, new_fetch, 1)
    print("[1] Fixed: weekly/monthly bypass DB cache, fetch from Yahoo directly")
else:
    print("[1] SKIP: ohlc fetch not found")

with open(FILE, 'w') as f:
    f.write(content)
print("Done!")
