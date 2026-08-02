#!/usr/bin/env python3
"""Trigger backtest and wait for results."""
import urllib.request, json, time

data = json.dumps({
    'startDate': '2026-03-01',
    'endDate': '2026-05-31',
    'min_score': 50,
    'market': 'IDX',
    'interval': '1d'
}).encode()

req = urllib.request.Request(
    'http://localhost:3100/api/backtest/run',
    data=data,
    headers={'Content-Type': 'application/json'}
)
resp = urllib.request.urlopen(req, timeout=10)
result = json.loads(resp.read())
run_id = result.get('run_id')
print(f"Started: {run_id}")

for i in range(40):
    time.sleep(2)
    try:
        sr = urllib.request.urlopen(f"http://localhost:3100/api/backtest/status/{run_id}", timeout=5)
        st = json.loads(sr.read())
        status = st.get('status')
        prog = st.get('progress', {})
        if status in ('DONE', 'ERROR'):
            print(f"\n=== RESULT ===")
            print(f"  Status: {status}")
            print(f"  Total trades: {st.get('total_trades', 0)}")
            print(f"  Entered: {st.get('entered', 0)}")
            print(f"  Wins: {st.get('wins', 0)}")
            print(f"  Win Rate: {st.get('win_rate', 0)}%")
            
            # Get trades detail
            try:
                tr = urllib.request.urlopen(f"http://localhost:3100/api/backtest/runs", timeout=5)
                runs = json.loads(tr.read())
                for r in runs:
                    if r.get('run_id') == run_id:
                        print(f"\n  Run details: {json.dumps(r, indent=2, default=str)[:500]}")
            except:
                pass
            break
        elif i % 3 == 0:
            print(f"  [{i*2}s] {status} - {prog.get('processed',0)}/{prog.get('total',0)}")
    except Exception as e:
        if i == 0:
            print(f"  Waiting... ({e})")
