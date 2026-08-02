#!/usr/bin/env python3
"""
Critical fix: Only show patterns where D is RECENT and price is still near PRZ.
Also add invalidation rules from the concept doc.
"""
FILE = '/var/www/flowtracker-scraper/harmonicEngine.js'

with open(FILE, 'r') as f:
    content = f.read()

# 1. Add recency filter: D must be within last 15 candles
# 2. Add B-must-not-cross-X rule
# 3. Add C-should-not-cross-A rule  
# 4. Add minimum XA impulse size
# Find the right spot after direction check

old_direction = """    const direction = isBullish ? 'BULLISH' : 'BEARISH';

    // Try matching against known patterns"""

new_direction = """    const direction = isBullish ? 'BULLISH' : 'BEARISH';

    // ── INVALIDATION RULES (from Harmonic Basic Concept) ──

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
    if (dPriceGap > 0.10) continue;  // Price moved too far from D, no longer actionable

    // Try matching against known patterns"""

if old_direction in content:
    content = content.replace(old_direction, new_direction, 1)
    print("[1] Added invalidation + recency rules for XABCD patterns")
else:
    print("[1] SKIP: direction block not found")

# 2. Also add recency filter for ABCD patterns
old_abcd_direction = """    const direction = isBull ? 'BULLISH' : 'BEARISH';
    const entry_price = sD.price;"""

new_abcd_direction = """    const direction = isBull ? 'BULLISH' : 'BEARISH';

    // ABCD recency: D must be within last 15 candles
    const abcdCandlesAfterD = ohlc.length - 1 - sD.index;
    if (abcdCandlesAfterD > 15) continue;

    // ABCD: current price near D
    const abcdLastClose = ohlc[ohlc.length - 1].close;
    const abcdGap = Math.abs(abcdLastClose - sD.price) / sD.price;
    if (abcdGap > 0.10) continue;

    const entry_price = sD.price;"""

if old_abcd_direction in content:
    content = content.replace(old_abcd_direction, new_abcd_direction, 1)
    print("[2] Added recency filter for ABCD patterns")
else:
    print("[2] SKIP: ABCD direction not found")

# 3. Add AB=CD confluence bonus
old_fib_score = """      const fib_score = Math.round(totalFib / 4);"""
new_fib_score = """      // AB=CD confluence bonus
      const abcdRatio = CD / (AB || 1);
      const abcdBonus = (abcdRatio > 0.85 && abcdRatio < 1.15) ? 12 : 0;
      const fib_score = Math.min(100, Math.round(totalFib / 4) + abcdBonus);"""

if old_fib_score in content:
    content = content.replace(old_fib_score, new_fib_score, 1)
    print("[3] Added AB=CD confluence bonus to fib_score")
else:
    print("[3] SKIP")

# 4. Tighten tolerance from 12% to 10%
old_tol = "const TOLERANCE = 0.12;  // 12% tolerance on fib ratio matching"
new_tol = "const TOLERANCE = 0.10;  // 10% tolerance on fib ratio matching"
if old_tol in content:
    content = content.replace(old_tol, new_tol, 1)
    print("[4] Tightened tolerance from 12% to 10%")
else:
    print("[4] SKIP")

with open(FILE, 'w') as f:
    f.write(content)
print("Done!")
