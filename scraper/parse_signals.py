import json, sys
d = json.load(sys.stdin)
signals = d.get("data", d.get("signals", []))
print(f"Total signals: {len(signals)}")
print(f"Date: {d.get('date', 'N/A')}")
print(f"Factors: {d.get('engine', {}).get('factors', 'N/A')}")
print()

# Sort by score desc
signals.sort(key=lambda x: x.get("score", 0), reverse=True)
top = [s for s in signals if s.get("score", 0) >= 58]
print(f"{'Stock':<8} {'Score':>5} {'Signal':<12} {'Conf':>4} {'WR':>4} {'RSI':>4} {'MACD':>4} {'BB':>4} {'EMA':>4} {'S/R':>4} {'ATR':>4}")
print("-" * 72)
for x in (top if top else signals[:20]):
    f = x.get("factors", {})
    print(f"{x.get('ticker','?'):<8} {x.get('score',0):>5} {x.get('signal','?'):<12} {x.get('confidence',0):>4} {x.get('winRate',0):>3}% {f.get('rsi','--'):>4} {f.get('macd','--'):>4} {f.get('bollinger','--'):>4} {f.get('emaTrend','--'):>4} {f.get('supportResistance','--'):>4} {f.get('atr','--'):>4}")

print(f"\n📊 Summary: {len(top)} BUY/STRONG BUY signals out of {len(signals)} total")
