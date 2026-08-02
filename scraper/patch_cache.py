#!/usr/bin/env python3
"""Fix cache to be interval-aware so different timeframes produce different results."""
FILE = '/var/www/flowtracker-scraper/server.js'

with open(FILE, 'r') as f:
    content = f.read()

# 1. Add interval to cache object
old_cache = "let _harmonicScanCache = { date: null, ts: 0, results: [], scanned: 0, errors: 0, scanning: false, progress: '' };"
new_cache = "let _harmonicScanCache = { date: null, ts: 0, results: [], scanned: 0, errors: 0, scanning: false, progress: '', interval: '1d' };"
if "interval: '1d'" not in content:
    content = content.replace(old_cache, new_cache, 1)
    print("[1] Added interval to cache object")
else:
    print("[1] SKIP")

# 2. Update cache check to also compare interval
old_check = """  // If cache is warm, return from cache immediately
  if (!force && _harmonicScanCache.ts > 0 && (now - _harmonicScanCache.ts) < SCAN_CACHE_TTL) {
    const filtered = _harmonicScanCache.results.filter(r =>
      r.conviction_score >= Number(min_score) && r.risk_reward >= Number(min_rr)
    );
    return res.json({
      scanned: _harmonicScanCache.scanned,
      found: filtered.length,
      errors: _harmonicScanCache.errors,
      date: _harmonicScanCache.date,
      results: filtered,
      cached: true,
      cache_age_min: Math.round((now - _harmonicScanCache.ts) / 60000),
    });
  }"""

new_check = """  const reqInterval = interval || '1d';
  
  // If cache is warm AND same interval, return from cache immediately
  if (!force && _harmonicScanCache.ts > 0 && (now - _harmonicScanCache.ts) < SCAN_CACHE_TTL && _harmonicScanCache.interval === reqInterval) {
    const filtered = _harmonicScanCache.results.filter(r =>
      r.conviction_score >= Number(min_score) && r.risk_reward >= Number(min_rr)
    );
    return res.json({
      scanned: _harmonicScanCache.scanned,
      found: filtered.length,
      errors: _harmonicScanCache.errors,
      date: _harmonicScanCache.date,
      results: filtered,
      cached: true,
      interval: reqInterval,
      cache_age_min: Math.round((now - _harmonicScanCache.ts) / 60000),
    });
  }"""

if old_check in content:
    content = content.replace(old_check, new_check, 1)
    print("[2] Made cache interval-aware")
else:
    print("[2] SKIP: cache check not found")

# 3. Update _startScanWorker call to use reqInterval
old_call = "  _startScanWorker(Number(min_rr), interval || '1d');"
new_call = "  _startScanWorker(Number(min_rr), reqInterval);"
if old_call in content:
    content = content.replace(old_call, new_call, 1)
    print("[3] Updated _startScanWorker call")
else:
    print("[3] SKIP")

# 4. Store interval in cache when loading results
old_load = """      _harmonicScanCache = {
        date: data.date, ts: data.ts || Date.now(),
        results: data.results || [], scanned: data.scanned || 0,
        errors: data.errors || 0, scanning: false, progress: 'done',
      };"""
# We need to find this section
if old_load in content:
    new_load = """      _harmonicScanCache = {
        date: data.date, ts: data.ts || Date.now(),
        results: data.results || [], scanned: data.scanned || 0,
        errors: data.errors || 0, scanning: false, progress: 'done',
        interval: data.interval || '1d',
      };"""
    content = content.replace(old_load, new_load, 1)
    print("[4] Store interval in cache from worker output")
else:
    # Try alternate pattern
    print("[4] SKIP: load pattern not found, trying alternate...")
    # Let's search for it
    import re
    match = re.search(r'_harmonicScanCache = \{[^}]+scanning: false, progress: .done.[^}]*\}', content)
    if match:
        old_text = match.group(0)
        if "interval:" not in old_text:
            new_text = old_text.rstrip('}') + ", interval: data.interval || '1d' }"
            content = content.replace(old_text, new_text, 1)
            print("[4b] Store interval in cache (alternate)")

# 5. Frontend: add force=1 when scanning (so user click always triggers fresh scan)
PAGE = '/var/www/flowtracker/app/signal-scanner/page.tsx'
with open(PAGE, 'r') as f:
    pc = f.read()

old_idx_ep = ': `${apiBase}/api/harmonic-scan?min_score=${minScore}&min_rr=${minRR}&interval=${timeframe}`;'
new_idx_ep = ': `${apiBase}/api/harmonic-scan?min_score=${minScore}&min_rr=${minRR}&interval=${timeframe}&force=1`;'
if old_idx_ep in pc:
    pc = pc.replace(old_idx_ep, new_idx_ep, 1)
    print("[F1] Added force=1 to IDX scan URL")
else:
    print("[F1] SKIP")

with open(PAGE, 'w') as f:
    f.write(pc)

with open(FILE, 'w') as f:
    f.write(content)
print("Done!")
