#!/usr/bin/env python3
"""
Fix harmonic engine with proper timeframe-based limits:
1. Pattern span limit (X to D max candles)
2. D freshness (must be within N recent candles)
3. PRZ gap tighter (8%)
4. Pass interval config from worker
"""

# ── PART 1: Update harmonicEngine.js ──
ENGINE = '/var/www/flowtracker-scraper/harmonicEngine.js'
with open(ENGINE, 'r') as f:
    ec = f.read()

# 1a. Update detectHarmonicPatterns to accept options
old_fn = "function detectHarmonicPatterns(ohlc, ticker) {"
new_fn = """function detectHarmonicPatterns(ohlc, ticker, options = {}) {
  const maxPatternSpan = options.maxPatternSpan || 60;   // max candles from X to D
  const maxDAge        = options.maxDAge || 5;            // D must be within N recent candles
  const maxPrzGap      = options.maxPrzGap || 0.08;       // price vs D max 8%
  const swingLeft      = options.swingLeft || 5;
  const swingRight     = options.swingRight || 3;"""

if old_fn in ec:
    ec = ec.replace(old_fn, new_fn, 1)
    print("[E1] Updated detectHarmonicPatterns signature with options")
else:
    print("[E1] SKIP")

# 1b. Update findSwings call to use dynamic params
old_swings = "  const swings = findSwings(ohlc, 5, 3);"
new_swings = "  const swings = findSwings(ohlc, swingLeft, swingRight);"
if old_swings in ec:
    ec = ec.replace(old_swings, new_swings, 1)
    print("[E2] Updated findSwings to use dynamic params")
else:
    print("[E2] SKIP")

# 1c. Replace the old recency/invalidation block with proper timeframe-aware version
old_recency = """    // ── INVALIDATION RULES (from Harmonic Basic Concept) ──

    // Rule: B must NOT cross X
    if (isBullish && B.price < X.price) continue;
    if (isBearish && B.price > X.price) continue;

    // Rule: C should NOT cross A (for standard patterns)
    if (isBullish && C.price > A.price) continue;
    if (isBearish && C.price < A.price) continue;

    // Rule: XA must be a significant impulse (min 2% move)
    const xaPercent = (XA / Math.min(X.price, A.price)) * 100;
    if (xaPercent < 2) continue;

    // Rule: D must be RECENT (within last 15 candles) - pattern must be actionable
    const candlesAfterD = ohlc.length - 1 - D.index;
    if (candlesAfterD > 15) continue;  // Skip old/stale patterns

    // Rule: Current price must be near PRZ (within 10% of D)
    const lastClose = ohlc[ohlc.length - 1].close;
    const dPriceGap = Math.abs(lastClose - D.price) / D.price;
    if (dPriceGap > 0.10) continue;  // Price moved too far from D, no longer actionable"""

new_recency = """    // ── INVALIDATION RULES (from Harmonic Basic Concept) ──

    // Rule: B must NOT cross X
    if (isBullish && B.price < X.price) continue;
    if (isBearish && B.price > X.price) continue;

    // Rule: C should NOT cross A (for standard patterns)
    if (isBullish && C.price > A.price) continue;
    if (isBearish && C.price < A.price) continue;

    // Rule: XA must be a significant impulse (min 2% move)
    const xaPercent = (XA / Math.min(X.price, A.price)) * 100;
    if (xaPercent < 2) continue;

    // Rule: Pattern span limit (X to D must be within maxPatternSpan candles)
    const patternSpan = D.index - X.index;
    if (patternSpan > maxPatternSpan) continue;

    // Rule: D must be FRESH (within maxDAge candles from end)
    const candlesAfterD = ohlc.length - 1 - D.index;
    if (candlesAfterD > maxDAge) continue;

    // Rule: Current price must be near PRZ
    const lastClose = ohlc[ohlc.length - 1].close;
    const dPriceGap = Math.abs(lastClose - D.price) / D.price;
    if (dPriceGap > maxPrzGap) continue;"""

if old_recency in ec:
    ec = ec.replace(old_recency, new_recency, 1)
    print("[E3] Updated recency rules with timeframe-aware limits")
else:
    print("[E3] SKIP")

# 1d. Also update ABCD recency filter
old_abcd_recency = """    // ABCD recency: D must be within last 15 candles
    const abcdCandlesAfterD = ohlc.length - 1 - sD.index;
    if (abcdCandlesAfterD > 15) continue;

    // ABCD: current price near D
    const abcdLastClose = ohlc[ohlc.length - 1].close;
    const abcdGap = Math.abs(abcdLastClose - sD.price) / sD.price;
    if (abcdGap > 0.10) continue;"""

new_abcd_recency = """    // ABCD recency: D must be fresh
    const abcdCandlesAfterD = ohlc.length - 1 - sD.index;
    if (abcdCandlesAfterD > maxDAge) continue;

    // ABCD: pattern span limit
    const abcdSpan = sD.index - sA.index;
    if (abcdSpan > maxPatternSpan) continue;

    // ABCD: current price near D
    const abcdLastClose = ohlc[ohlc.length - 1].close;
    const abcdGap = Math.abs(abcdLastClose - sD.price) / sD.price;
    if (abcdGap > maxPrzGap) continue;"""

if old_abcd_recency in ec:
    ec = ec.replace(old_abcd_recency, new_abcd_recency, 1)
    print("[E4] Updated ABCD recency with timeframe-aware limits")
else:
    print("[E4] SKIP")

with open(ENGINE, 'w') as f:
    f.write(ec)

# ── PART 2: Update worker to pass options per timeframe ──
WORKER = '/var/www/flowtracker-scraper/harmonic-scan-worker.js'
with open(WORKER, 'r') as f:
    wc = f.read()

# Add timeframe config before the scan loop
old_interval_line = "const INTERVAL = process.argv[5] || '1d'; // 1d, 1wk, 1mo"
new_interval_block = """const INTERVAL = process.argv[5] || '1d'; // 1d, 1wk, 1mo

// Timeframe-specific settings (TradingView-aligned)
const TF_CONFIG = {
  '1d':  { maxPatternSpan: 60, maxDAge: 5,  maxPrzGap: 0.08, swingLeft: 5, swingRight: 3 },
  '1wk': { maxPatternSpan: 40, maxDAge: 4,  maxPrzGap: 0.08, swingLeft: 4, swingRight: 2 },
  '1mo': { maxPatternSpan: 30, maxDAge: 3,  maxPrzGap: 0.08, swingLeft: 3, swingRight: 2 },
};
const HARMONIC_OPTS = TF_CONFIG[INTERVAL] || TF_CONFIG['1d'];"""

if 'TF_CONFIG' not in wc:
    wc = wc.replace(old_interval_line, new_interval_block, 1)
    print("[W1] Added TF_CONFIG per timeframe")
else:
    print("[W1] SKIP: already exists")

# Pass options to detectHarmonicPatterns call
old_detect = "const patterns = detectHarmonicPatterns(ohlc, ticker);"
new_detect = "const patterns = detectHarmonicPatterns(ohlc, ticker, HARMONIC_OPTS);"
if old_detect in wc:
    wc = wc.replace(old_detect, new_detect, 1)
    print("[W2] Pass HARMONIC_OPTS to detectHarmonicPatterns")
else:
    print("[W2] SKIP")

with open(WORKER, 'w') as f:
    f.write(wc)

# ── PART 3: Update server.js crypto scanner too ──
SERVER = '/var/www/flowtracker-scraper/server.js'
with open(SERVER, 'r') as f:
    sc = f.read()

old_crypto_detect = "const patterns = detectHarmonicPatterns(ohlc, ticker);"
new_crypto_detect = "const patterns = detectHarmonicPatterns(ohlc, ticker, { maxPatternSpan: 60, maxDAge: 5, maxPrzGap: 0.08 });"
if old_crypto_detect in sc:
    sc = sc.replace(old_crypto_detect, new_crypto_detect, 1)
    print("[S1] Updated crypto scanner with options")
else:
    print("[S1] SKIP")

with open(SERVER, 'w') as f:
    f.write(sc)

print("Done!")
