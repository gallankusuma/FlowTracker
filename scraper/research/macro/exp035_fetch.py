#!/usr/bin/env python3
"""
Fetch the EXP-035 Asian basket once, to a file.

Separate from the analysis for the same reason as EXP-031 and EXP-033: Yahoo
back-adjusts, so a re-run would silently draw a different sample and the
pre-registered test would not be the same test twice. The JSON is the sample.

Usage: .venv/bin/python3 research/macro/exp035_fetch.py
"""
import json, os, time, warnings
warnings.filterwarnings('ignore')
import yfinance as yf

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'exp035_data.json')

# Selected by an explicit rule, not by preference: every major Asian index with
# >= 2,400 sessions in the window that this project has NEVER read. That rule
# excludes India, Thailand, Malaysia, the Philippines and Korea (spent by
# EXP-031) and is what keeps the choice from being a search for a helpful set.
SYMBOLS = ['^TWII', '^STI', '^HSI', '000001.SS', '^N225']

out = {}
for sym in SYMBOLS:
    try:
        h = yf.Ticker(sym).history(start='2016-07-01', end='2026-08-22')
        rows = [{'d': str(d.date()), 'c': float(c)}
                for d, c in zip(h.index, h['Close']) if c == c and c > 0]
        out[sym] = rows
        print(f"  {sym:12s} {len(rows)} closes  {rows[0]['d']} .. {rows[-1]['d']}" if rows else f"  {sym:12s} EMPTY")
    except Exception as e:
        print(f"  {sym:12s} ERROR {str(e)[:60]}")
        out[sym] = []
    time.sleep(1.0)

with open(OUT, 'w') as f:
    json.dump(out, f)
print(f"wrote {OUT} ({sum(len(v) for v in out.values())} closes)")
