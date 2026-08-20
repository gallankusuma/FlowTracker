#!/usr/bin/env python3
"""
Fetch the EXP-031 panel once, to a file, so the analysis is reproducible.

Kept separate from the analysis on purpose. If fetching and testing lived in one
script, a re-run would silently draw a slightly different sample -- Yahoo revises
and back-adjusts -- and the pre-registered test would not be the same test twice.
The JSON is the sample; the analysis reads it and nothing else.

Usage: .venv/bin/python3 research/macro/exp031_fetch.py
"""
import json
import os
import time
import yfinance as yf

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'exp031_data.json')

SYMBOLS = [
    # out of sample
    '^BSESN', 'INR=X',
    '^SET.BK', 'THB=X',
    'PSEI.PS', 'PHP=X',
    '^KLSE', 'MYR=X',
    '^BVSP', 'BRL=X',
    '^MXX', 'MXN=X',
    'XU100.IS', 'TRY=X',
    '^J203.JO', 'ZAR=X',
    '^KS11', 'KRW=X',
    # in sample, reported separately and excluded from the statistic
    '^JKSE', 'IDR=X',
]

out = {}
for sym in SYMBOLS:
    try:
        h = yf.Ticker(sym).history(period='10y')
        rows = [{'d': str(d.date()), 'c': float(c)}
                for d, c in zip(h.index, h['Close']) if c == c and c > 0]
        out[sym] = rows
        print(f"  {sym:10s} {len(rows)} closes  {rows[0]['d']} .. {rows[-1]['d']}" if rows
              else f"  {sym:10s} EMPTY")
    except Exception as e:
        print(f"  {sym:10s} ERROR {str(e)[:60]}")
        out[sym] = []
    time.sleep(1.0)

with open(OUT, 'w') as f:
    json.dump(out, f)
print(f"wrote {OUT}  ({sum(len(v) for v in out.values())} closes total)")
