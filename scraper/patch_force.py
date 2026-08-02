#!/usr/bin/env python3
"""Fix scan logic: kill old worker when force scanning, and properly handle interval change."""
FILE = '/var/www/flowtracker-scraper/server.js'

with open(FILE, 'r') as f:
    content = f.read()

# Fix: when force=1, kill existing scan and start fresh
old_start_fn = """function _startScanWorker(minRR = 1.0, interval = '1d') {
  if (_scanProcess || _harmonicScanCache.scanning) return;"""

new_start_fn = """function _startScanWorker(minRR = 1.0, interval = '1d', force = false) {
  // If force, kill existing worker first
  if (force && _scanProcess) {
    try { _scanProcess.kill(); } catch {}
    _scanProcess = null;
    _harmonicScanCache.scanning = false;
    console.log('[harmonic-scan] Killed old worker for force re-scan');
  }
  if (_scanProcess || _harmonicScanCache.scanning) return;"""

if old_start_fn in content:
    content = content.replace(old_start_fn, new_start_fn, 1)
    print("[1] Updated _startScanWorker to support force kill")
else:
    print("[1] SKIP")

# Pass force flag from endpoint
old_call = "  _startScanWorker(Number(min_rr), reqInterval);"
new_call = "  _startScanWorker(Number(min_rr), reqInterval, !!force);"
if old_call in content:
    content = content.replace(old_call, new_call, 1)
    print("[2] Pass force flag to _startScanWorker")
else:
    print("[2] SKIP")

with open(FILE, 'w') as f:
    f.write(content)

# Also kill any stuck workers right now
import subprocess
subprocess.run(['ssh', '-i', 'C:\\Users\\GK\\.ssh\\id_ed25519', 'root@76.13.22.155',
    'pkill -f harmonic-scan-worker || true'], capture_output=True)
print("[3] Killed any stuck workers")

print("Done!")
