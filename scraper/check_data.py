#!/usr/bin/env python3
import json
with open('/var/www/flowtracker-scraper/harmonic-scan-results.json') as f:
    d = json.load(f)
r = d.get('results', [])
if r:
    pd = r[0].get('pattern_data', {})
    print(json.dumps(pd, indent=2))
    print("\n--- Also check conviction_breakdown ---")
    print(json.dumps(r[0].get('conviction_breakdown', {}), indent=2))
    print("\n--- Keys available in result ---")
    print(sorted(r[0].keys()))
else:
    print("no results")
