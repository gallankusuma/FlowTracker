#!/usr/bin/env python3
"""Fresh test of backtest with new scoring."""
import subprocess, json

# Run a quick backtest via the actual API endpoint
import urllib.request

url = "http://localhost:3456/api/backtest/run"
data = json.dumps({
    "startDate": "2026-03-01",
    "endDate": "2026-05-31",
    "min_score": 50,
    "market": "IDX",
    "interval": "1d"
}).encode()

req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
try:
    resp = urllib.request.urlopen(req, timeout=5)
    result = json.loads(resp.read())
    run_id = result.get('run_id')
    print(f"Started backtest: {run_id}")
    
    # Wait for completion
    import time
    for i in range(30):
        time.sleep(2)
        try:
            sr = urllib.request.urlopen(f"http://localhost:3456/api/backtest/status/{run_id}", timeout=5)
            st = json.loads(sr.read())
            print(f"  Status: {st.get('status')} - {st.get('progress', {}).get('currentDate', '?')}")
            if st.get('status') in ('DONE', 'ERROR'):
                # Get results
                rr = urllib.request.urlopen(f"http://localhost:3456/api/backtest/stats/{run_id}", timeout=5)
                stats = json.loads(rr.read())
                print(f"\n  === RESULTS ===")
                print(f"  Total: {stats.get('overall', {}).get('total', 0)}")
                print(f"  Entered: {stats.get('overall', {}).get('entered', 0)}")
                print(f"  Win Rate: {stats.get('overall', {}).get('win_rate', 0)}%")
                break
        except Exception as e:
            pass
except Exception as e:
    print(f"Error: {e}")
