#!/usr/bin/env python3
"""
MASTER FIX: Reset winrate + Update backtest + Final deploy.
Run on server: python3 /var/www/flowtracker-scraper/master_reset.py
"""
import subprocess, re, os

def run(cmd, check=False):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return r.stdout.strip() + r.stderr.strip()

print("=" * 60)
print("STEP 1: Check backtest_runner.py constants")
print("=" * 60)

# Read backtest_runner.py
RUNNER = '/var/www/flowtracker-scraper/backtest_runner.py'
with open(RUNNER, 'r') as f:
    rc = f.read()

# Find constants
import re as regex
for const in ['MAX_D_AGE', 'SWING_THRESHOLD', 'MAX_SWINGS', 'MAX_PATTERN_SPAN']:
    m = regex.search(rf'{const}\s*=\s*(\S+)', rc)
    if m:
        print(f"  {const} = {m.group(1)}")

# Update backtest_runner.py to match latest TF_CONFIG for daily
# MAX_D_AGE should be 5 (matching IDX daily)
old_dage = regex.search(r'MAX_D_AGE\s*=\s*\d+', rc)
if old_dage:
    current_val = old_dage.group()
    new_val = 'MAX_D_AGE = 5'
    if current_val != new_val:
        rc = rc.replace(current_val, new_val)
        print(f"  [UPDATED] {current_val} -> {new_val}")
    else:
        print(f"  [OK] {current_val}")

# Also update backtestEngine.js to pass TF_CONFIG options
BTENGINE = '/var/www/flowtracker-scraper/backtestEngine.js'
with open(BTENGINE, 'r') as f:
    bc = f.read()

# Check if it passes options or not
if 'detectHarmonicPatterns(truncatedOHLC, ticker)' in bc:
    # It doesn't pass options - add them
    old_call = 'detectHarmonicPatterns(truncatedOHLC, ticker)'
    new_call = 'detectHarmonicPatterns(truncatedOHLC, ticker, { maxPatternSpan: 60, maxDAge: 5, maxPrzGap: 0.08, swingLeft: 5, swingRight: 3 })'
    bc = bc.replace(old_call, new_call)
    print(f"  [UPDATED] backtestEngine.js: added TF options to detect call")
else:
    print(f"  [OK] backtestEngine.js already has options")

with open(BTENGINE, 'w') as f:
    f.write(bc)
with open(RUNNER, 'w') as f:
    f.write(rc)

print("\n" + "=" * 60)
print("STEP 2: Reset winrate data (TRUNCATE old records)")
print("=" * 60)

# Truncate old recommendations and backtest results
queries = [
    "TRUNCATE TABLE ft_recommendations;",
    "TRUNCATE TABLE ft_backtest_results;",
]
for q in queries:
    r = run(f"mysql -u root erp_manufacturing -e \"{q}\"")
    print(f"  {q} -> {r if r else 'OK'}")

# Verify
r = run("mysql -u root erp_manufacturing -e \"SELECT COUNT(*) as recs FROM ft_recommendations; SELECT COUNT(*) as bt FROM ft_backtest_results;\"")
print(f"  Verification: {r}")

print("\n" + "=" * 60)
print("STEP 3: Restart scraper")
print("=" * 60)

# Syntax check
r1 = run("node -c /var/www/flowtracker-scraper/server.js")
r2 = run("node -c /var/www/flowtracker-scraper/harmonicEngine.js")
r3 = run("node -c /var/www/flowtracker-scraper/harmonic-scan-worker.js")
r4 = run("node -c /var/www/flowtracker-scraper/backtestEngine.js")
print(f"  server.js: {r1 if r1 else 'OK'}")
print(f"  harmonicEngine.js: {r2 if r2 else 'OK'}")
print(f"  harmonic-scan-worker.js: {r3 if r3 else 'OK'}")
print(f"  backtestEngine.js: {r4 if r4 else 'OK'}")

r5 = run("pm2 restart flowtracker-scraper")
print(f"  PM2 restart: {'OK' if 'online' in r5 else r5[:100]}")

print("\n" + "=" * 60)
print("STEP 4: Summary of current config")
print("=" * 60)

# Read current configs
with open('/var/www/flowtracker-scraper/harmonic-scan-worker.js', 'r') as f:
    wc = f.read()
tf_match = regex.search(r"const TF_CONFIG = \{(.*?)\};", wc, re.DOTALL)
if tf_match:
    print("  Worker TF_CONFIG (IDX/US):")
    for line in tf_match.group(1).strip().split('\n'):
        print(f"    {line.strip()}")

with open('/var/www/flowtracker-scraper/server.js', 'r') as f:
    sc = f.read()
crypto_match = regex.search(r"const tfConfig = \{(.*?)\};", sc, re.DOTALL)
if crypto_match:
    print("  Crypto tfConfig:")
    for line in crypto_match.group(1).strip().split('\n'):
        print(f"    {line.strip()}")

print("\n✅ DONE! Winrate reset, backtest updated, ready for fresh data.")
