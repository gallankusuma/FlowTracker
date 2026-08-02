#!/usr/bin/env python3
import json
d = json.load(open("/tmp/harmonic-scan-results.json"))
r = d["results"][0]
has = "ohlc_candles" in r
cnt = len(r.get("ohlc_candles", []))
print(f"Has ohlc_candles: {has}, count: {cnt}")
if has and cnt > 0:
    print(f"First candle: {r['ohlc_candles'][0]}")
    print(f"Last candle: {r['ohlc_candles'][-1]}")
