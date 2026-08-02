#!/usr/bin/env python3
"""Fix both issues:
1. Save weights - test and fix if needed
2. Crypto scan - check why 0 results
"""
import json, http.client

# Test save weights API
conn = http.client.HTTPConnection("127.0.0.1", 3100)
data = json.dumps({"harmonic": 30, "wyckoff": 30, "smc": 15, "volume_profile": 23, "broker_flow": 2})
conn.request("POST", "/api/scan-weights", body=data, headers={"Content-Type": "application/json"})
resp = conn.getresponse()
body = resp.read().decode()
print(f"[1] Save weights: status={resp.status}")
print(f"    Response: {body[:200]}")
conn.close()

# Test crypto scan status
conn2 = http.client.HTTPConnection("127.0.0.1", 3100)
conn2.request("GET", "/api/harmonic-scan-crypto?min_score=5&min_rr=0.5&interval=1wk")
resp2 = conn2.getresponse()
body2 = resp2.read().decode()
d = json.loads(body2)
print(f"\n[2] Crypto scan: scanning={d.get('scanning')}, found={d.get('found')}, scanned={d.get('scanned')}")
print(f"    Progress: {d.get('progress')}")
if d.get('results'):
    print(f"    First result: {d['results'][0].get('ticker')} {d['results'][0].get('pattern_type')}")
conn2.close()
