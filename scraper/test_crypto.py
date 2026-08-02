#!/usr/bin/env python3
"""Force crypto scan and check results."""
import http.client, json, time

# Force new crypto scan
conn = http.client.HTTPConnection("127.0.0.1", 3100)
conn.request("GET", "/api/harmonic-scan-crypto?min_score=5&min_rr=0.5&interval=1wk&force=1")
resp = conn.getresponse()
d = json.loads(resp.read())
print(f"Started: scanning={d.get('scanning')}, msg={d.get('message','')[:60]}")
conn.close()

# Wait and poll
for i in range(20):
    time.sleep(5)
    conn = http.client.HTTPConnection("127.0.0.1", 3100)
    conn.request("GET", "/api/harmonic-scan-crypto?min_score=5&min_rr=0.5&interval=1wk")
    resp = conn.getresponse()
    d = json.loads(resp.read())
    found = d.get('found', 0)
    scanning = d.get('scanning', False)
    print(f"  [{i+1}] scanning={scanning}, found={found}, scanned={d.get('scanned',0)}")
    conn.close()
    if not scanning and d.get('scanned', 0) > 0:
        print(f"\nDone! Found {found} patterns from {d.get('scanned',0)} crypto")
        if d.get('results'):
            for r in d['results'][:5]:
                print(f"  {r['ticker']:12s} {r['pattern_type']:10s} {r['direction']:8s} score:{r.get('conviction_score',0)}")
        break
