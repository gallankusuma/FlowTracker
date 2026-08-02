#!/usr/bin/env python3
"""Debug crypto scan - run directly with loose settings."""
import http.client, json

# Try daily instead of weekly
for interval in ['1d', '1wk']:
    conn = http.client.HTTPConnection("127.0.0.1", 3100)
    conn.request("GET", f"/api/harmonic-scan-crypto?min_score=1&min_rr=0.1&interval={interval}&force=1")
    resp = conn.getresponse()
    d = json.loads(resp.read())
    print(f"\n[{interval}] scanning={d.get('scanning')}, found={d.get('found')}, scanned={d.get('scanned',0)}")
    
    if d.get('results'):
        for r in d['results'][:3]:
            pd = r.get('pattern_data', {})
            print(f"  {r['ticker']:12s} {r['pattern_type']:10s} {r['direction']:8s} score:{r.get('conviction_score',0)}")
            print(f"    X:{pd.get('X',{}).get('date','?')[:10]} D:{pd.get('D',{}).get('date','?')[:10]}")
    conn.close()
