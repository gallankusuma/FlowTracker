import json, sys
d = json.load(sys.stdin)
print("Status:", d.get("status"))
b = d.get("baseline", {})
o = d.get("optimized", {})
print(f"Baseline WR: {b.get('validateWinRate')}% (n={b.get('validateTotal')})")
print(f"Optimized WR: {o.get('validateWinRate')}% (n={o.get('validateTotal')})")
print("Improvement:", o.get("improvement"), "%")
print("Weights:", json.dumps(o.get("weights", {}), indent=2))
