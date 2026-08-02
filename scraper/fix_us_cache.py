#!/usr/bin/env python3
"""Fix US endpoint to share cache and properly return results."""
SERVER = '/var/www/flowtracker-scraper/server.js'

with open(SERVER, 'r') as f:
    sc = f.read()

# Replace the entire US endpoint with one that uses the cache
old_us = """
app.get('/api/harmonic-scan-us', (req, res) => {
  const { min_score = 50, min_rr = 1.5, force, interval } = req.query;
  const reqInterval = interval || '1d';
  const now = Date.now();

  if (_harmonicScanCache.scanning) {
    return res.json({
      scanned: 0, found: 0, errors: 0,
      date: new Date().toISOString().slice(0,10),
      results: [],
      scanning: true,
      progress: _harmonicScanCache.progress,
      message: 'Scan running in background, refresh in 30 seconds',
    });
  }

  // Start US scan
  _startScanWorker(Number(min_rr), reqInterval, !!force, 'US');

  return res.json({
    scanned: 0, found: 0, errors: 0,
    date: new Date().toISOString().slice(0,10),
    results: [],
    scanning: true,
    progress: '0/100',
    message: 'S&P 500 scan started, refresh in 2-3 minutes',
  });
});
"""

new_us = """
app.get('/api/harmonic-scan-us', (req, res) => {
  const { min_score = 50, min_rr = 1.5, force, interval } = req.query;
  const reqInterval = interval || '1d';
  const now = Date.now();

  // If cache is warm AND same market+interval, return cached
  if (!force && _harmonicScanCache.ts > 0 && (now - _harmonicScanCache.ts) < SCAN_CACHE_TTL 
      && _harmonicScanCache.interval === reqInterval && _harmonicScanCache.market === 'US') {
    const filtered = _harmonicScanCache.results.filter(r =>
      r.conviction_score >= Number(min_score) && r.risk_reward >= Number(min_rr)
    );
    return res.json({
      scanned: _harmonicScanCache.scanned, found: filtered.length,
      errors: _harmonicScanCache.errors, date: _harmonicScanCache.date,
      results: filtered, cached: true, market: 'US',
      cache_age_min: Math.round((now - _harmonicScanCache.ts) / 60000),
    });
  }

  // If scan running, return progress
  if (_harmonicScanCache.scanning) {
    _loadScanResults();
    return res.json({
      scanned: 0, found: 0, errors: 0,
      date: new Date().toISOString().slice(0,10),
      results: [], scanning: true,
      progress: _harmonicScanCache.progress,
      message: 'S&P 500 scan running, refresh in 30 seconds',
    });
  }

  // Start US scan
  _startScanWorker(Number(min_rr), reqInterval, !!force, 'US');

  return res.json({
    scanned: 0, found: 0, errors: 0,
    date: new Date().toISOString().slice(0,10),
    results: [], scanning: true,
    progress: '0/100',
    message: 'S&P 500 scan started, refresh in 2-3 minutes',
  });
});
"""

if old_us in sc:
    sc = sc.replace(old_us, new_us, 1)
    print("[1] Fixed US endpoint with proper cache logic")
else:
    print("[1] SKIP")

# Add market to cache loading
old_load_cache = "        interval: data.interval || '1d',"
new_load_cache = "        interval: data.interval || '1d',\n        market: data.market || 'IDX',"
if old_load_cache in sc and 'market: data.market' not in sc:
    sc = sc.replace(old_load_cache, new_load_cache, 1)
    print("[2] Added market to cache load")
else:
    print("[2] SKIP")

# Also add market to the IDX endpoint cache check
old_idx_cache = "&& _harmonicScanCache.interval === reqInterval) {"
new_idx_cache = "&& _harmonicScanCache.interval === reqInterval && (!_harmonicScanCache.market || _harmonicScanCache.market === 'IDX')) {"
if old_idx_cache in sc:
    sc = sc.replace(old_idx_cache, new_idx_cache, 1)
    print("[3] Added market check to IDX cache")
else:
    print("[3] SKIP")

with open(SERVER, 'w') as f:
    f.write(sc)

# Also update worker to write market to output
WORKER = '/var/www/flowtracker-scraper/harmonic-scan-worker.js'
with open(WORKER, 'r') as f:
    wc = f.read()

old_output = "    interval: INTERVAL,"
new_output = "    interval: INTERVAL,\n    market: MARKET,"
if old_output in wc and 'market: MARKET,' not in wc:
    wc = wc.replace(old_output, new_output, 1)
    print("[4] Added market to worker output")
else:
    print("[4] SKIP")

with open(WORKER, 'w') as f:
    f.write(wc)

print("Done!")
