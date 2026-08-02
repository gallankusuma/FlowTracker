#!/usr/bin/env python3
"""Patch server.js on the remote server to add custom weights support."""
import re

FILE = '/var/www/flowtracker-scraper/server.js'

with open(FILE, 'r') as f:
    content = f.read()

# 1. Replace inline calcMasterScore (lines 134-260) with import
old_block_start = '// ═══════════════════════════════════════════════════════════════════════════════\n// MASTER CONVICTION SCORE ENGINE'
old_block_end = '  };\n}\n\nfunction formatVal(n) {'
new_replacement = '''// calcMasterScore is now provided by harmonicEngine.js (calcUltraConviction)
// Import used in HARMONIC PATTERN ENDPOINTS section below
const { calcUltraConviction: calcMasterScoreLegacy, DEFAULT_WEIGHTS } = require('./harmonicEngine');

function formatVal(n) {'''

start_idx = content.find(old_block_start)
end_idx = content.find(old_block_end)
if start_idx >= 0 and end_idx >= 0:
    end_idx += len(old_block_end)
    content = content[:start_idx] + new_replacement + content[end_idx:]
    print(f"[1] Replaced calcMasterScore block (was {end_idx - start_idx} chars)")
else:
    print(f"[1] SKIP: calcMasterScore block not found (start={start_idx}, end={end_idx})")

# 2. Add buildVolumeProfile to the harmonicEngine require block
old_require = """  calcUltraConviction,
} = require('./harmonicEngine');"""
new_require = """  calcUltraConviction,
  buildVolumeProfile,
} = require('./harmonicEngine');"""
if old_require in content:
    content = content.replace(old_require, new_require, 1)
    print("[2] Added buildVolumeProfile to harmonicEngine imports")
else:
    print("[2] SKIP: require block not found or already patched")

# 3. Add weight config endpoints after the require block
weight_marker = "} = require('./harmonicEngine');"
weight_endpoints = """} = require('./harmonicEngine');

// ── Custom Scan Weights (persisted to JSON file) ─────────────
const WEIGHTS_FILE = path.join(__dirname, 'scan-weights.json');
let _customWeights = null;
try { _customWeights = JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8')); } catch {}

app.get('/api/scan-weights', (req, res) => {
  res.json({ weights: _customWeights || DEFAULT_WEIGHTS, defaults: DEFAULT_WEIGHTS });
});

app.post('/api/scan-weights', (req, res) => {
  try {
    const w = req.body;
    const keys = ['harmonic', 'wyckoff', 'smc', 'volume_profile', 'broker_flow'];
    for (const k of keys) {
      if (typeof w[k] !== 'number' || w[k] < 0 || w[k] > 100) {
        return res.status(400).json({ error: `Invalid weight for ${k}` });
      }
    }
    _customWeights = { harmonic: w.harmonic, wyckoff: w.wyckoff, smc: w.smc, volume_profile: w.volume_profile, broker_flow: w.broker_flow };
    fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(_customWeights, null, 2));
    res.json({ success: true, weights: _customWeights });
  } catch (e) { res.status(500).json({ error: e.message }); }
});"""
# Only add if not already present
if '/api/scan-weights' not in content:
    content = content.replace(weight_marker, weight_endpoints, 1)
    print("[3] Added scan-weights endpoints")
else:
    print("[3] SKIP: scan-weights endpoints already exist")

# 4. Update _startScanWorker to pass weights via env
old_worker = """  const workerPath = path.join(__dirname, 'harmonic-scan-worker.js');
  _scanProcess = spawn('node', [workerPath, SCAN_RESULTS_FILE, String(minRR)], {
    cwd: __dirname,
    stdio: 'inherit',
    env: { ...process.env },
  });"""
new_worker = """  const workerPath = path.join(__dirname, 'harmonic-scan-worker.js');
  const workerEnv = { ...process.env };
  if (_customWeights) workerEnv.SCAN_WEIGHTS = JSON.stringify(_customWeights);
  _scanProcess = spawn('node', [workerPath, SCAN_RESULTS_FILE, String(minRR)], {
    cwd: __dirname,
    stdio: 'inherit',
    env: workerEnv,
  });"""
if old_worker in content:
    content = content.replace(old_worker, new_worker, 1)
    print("[4] Updated _startScanWorker to pass weights")
else:
    # Try variant with market param
    old_worker2 = """  const workerPath = path.join(__dirname, 'harmonic-scan-worker.js');
  _scanProcess = spawn('node', [workerPath, SCAN_RESULTS_FILE, String(minRR), market], {
    cwd: __dirname,
    stdio: 'inherit',
    env: { ...process.env },
  });"""
    new_worker2 = """  const workerPath = path.join(__dirname, 'harmonic-scan-worker.js');
  const workerEnv = { ...process.env };
  if (_customWeights) workerEnv.SCAN_WEIGHTS = JSON.stringify(_customWeights);
  _scanProcess = spawn('node', [workerPath, SCAN_RESULTS_FILE, String(minRR), market], {
    cwd: __dirname,
    stdio: 'inherit',
    env: workerEnv,
  });"""
    if old_worker2 in content:
        content = content.replace(old_worker2, new_worker2, 1)
        print("[4] Updated _startScanWorker (with market) to pass weights")
    else:
        print("[4] SKIP: _startScanWorker pattern not found")

with open(FILE, 'w') as f:
    f.write(content)
print("Done patching server.js!")
