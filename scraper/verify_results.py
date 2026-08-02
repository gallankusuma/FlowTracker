#!/usr/bin/env python3
"""Verify scan results - show each pattern with dates and price gaps."""
import json

d = json.load(open('/tmp/harmonic-scan-results.json'))
results = d.get('results', [])
print(f"Total patterns: {len(results)}")
print(f"Scanned: {d.get('scanned',0)} stocks")
print(f"Date: {d.get('date','?')}")
print()
print(f"{'Ticker':<8} {'Dir':<8} {'Pattern':<12} {'Score':>5} | {'X_date':<12} {'D_date':<12} | {'D_price':>8} {'Close':>8} {'Gap%':>6}")
print("-" * 100)

for r in results:
    pd = r.get('pattern_data', {})
    x_date = pd.get('X', {}).get('date', '?')[:10]
    d_date = pd.get('D', {}).get('date', '?')[:10]
    d_price = pd.get('D', {}).get('price', 0)
    
    candles = r.get('ohlc_candles', [])
    last_close = candles[-1]['c'] if candles else r.get('current_price', 0)
    
    gap_pct = round(abs(last_close - d_price) / d_price * 100, 1) if d_price else 0
    score = r.get('conviction_score', 0)
    
    print(f"{r['ticker']:<8} {r['direction']:<8} {r['pattern_type']:<12} {score:>5} | {x_date:<12} {d_date:<12} | {d_price:>8,.0f} {last_close:>8,.0f} {gap_pct:>5.1f}%")

print()
print("=== VALIDATION ===")
print(f"All D dates should be RECENT (within ~15 trading days of today)")
print(f"All Gap% should be < 10% (price still near PRZ)")
