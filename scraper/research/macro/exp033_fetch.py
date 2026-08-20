#!/usr/bin/env python3
"""
Fetch the EXP-033 basket once, to a file.

Separate from the analysis for the same reason as EXP-031: Yahoo back-adjusts,
so a re-run would silently draw a different sample and the pre-registered test
would not be the same test twice. The JSON is the sample.

Usage: .venv/bin/python3 research/macro/exp033_fetch.py
"""
import json, os, time
import yfinance as yf

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'exp033_data.json')

# Six USD-denominated country ETFs, none previously queried by this project.
SYMBOLS = ['VNM', 'GXG', 'EPU', 'KSA', 'ECH', 'EPOL']

out = {}
for sym in SYMBOLS:
    try:
        h = yf.Ticker(sym).history(period='10y')
        rows = [{'d': str(d.date()), 'c': float(c)}
                for d, c in zip(h.index, h['Close']) if c == c and c > 0]
        out[sym] = rows
        print(f"  {sym:6s} {len(rows)} closes  {rows[0]['d']} .. {rows[-1]['d']}" if rows else f"  {sym:6s} EMPTY")
    except Exception as e:
        print(f"  {sym:6s} ERROR {str(e)[:60]}")
        out[sym] = []
    time.sleep(1.0)

with open(OUT, 'w') as f:
    json.dump(out, f)
print(f"wrote {OUT} ({sum(len(v) for v in out.values())} closes)")
