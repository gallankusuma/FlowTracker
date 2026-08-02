#!/usr/bin/env python3
"""Fix: polling request should NOT include force=1, only the initial request."""
FILE = '/var/www/flowtracker/app/signal-scanner/page.tsx'

with open(FILE, 'r') as f:
    content = f.read()

# The polling uses the same endpoint URL which has force=1
# We need to separate: initial request = with force, polling = without force
old_scan = '''      const endpoint = market === "CRYPTO"
        ? `${apiBase}/api/harmonic-scan-crypto?min_score=${minScore}&min_rr=${minRR}&interval=${timeframe}`
        : `${apiBase}/api/harmonic-scan?min_score=${minScore}&min_rr=${minRR}&interval=${timeframe}&force=1`;
      const r = await fetch(endpoint);
      const d = await r.json();
      
      // If scan is running in background, poll until complete
      if (d.scanning) {
        setScanError(`⏳ ${d.message || 'Scanning in background...'}`);
        const poll = setInterval(async () => {
          try {
            const pr = await fetch(endpoint);'''

new_scan = '''      const endpoint = market === "CRYPTO"
        ? `${apiBase}/api/harmonic-scan-crypto?min_score=${minScore}&min_rr=${minRR}&interval=${timeframe}`
        : `${apiBase}/api/harmonic-scan?min_score=${minScore}&min_rr=${minRR}&interval=${timeframe}&force=1`;
      const pollEndpoint = market === "CRYPTO"
        ? `${apiBase}/api/harmonic-scan-crypto?min_score=${minScore}&min_rr=${minRR}&interval=${timeframe}`
        : `${apiBase}/api/harmonic-scan?min_score=${minScore}&min_rr=${minRR}&interval=${timeframe}`;
      const r = await fetch(endpoint);
      const d = await r.json();
      
      // If scan is running in background, poll until complete (without force!)
      if (d.scanning) {
        setScanError(`⏳ ${d.message || 'Scanning in background...'}`);
        const poll = setInterval(async () => {
          try {
            const pr = await fetch(pollEndpoint);'''

if old_scan in content:
    content = content.replace(old_scan, new_scan, 1)
    print("[1] Fixed: poll uses endpoint without force=1")
else:
    print("[1] SKIP: pattern not found")

with open(FILE, 'w') as f:
    f.write(content)
print("Done!")
