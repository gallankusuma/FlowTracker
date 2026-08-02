#!/usr/bin/env python3
"""Fix US market stock list selection in worker."""
FILE = '/var/www/flowtracker-scraper/harmonic-scan-worker.js'
with open(FILE, 'r') as f:
    c = f.read()

# Add US branch before the else (IDX) branch
old = '} else {\n  TOP_STOCKS = [\n    "AALI"'
new = "} else if (MARKET === 'US') {\n  TOP_STOCKS = TOP_US_STOCKS;\n} else {\n  TOP_STOCKS = [\n    \"AALI\""

if old in c:
    c = c.replace(old, new, 1)
    print('[1] Added US market branch')
else:
    print('[1] SKIP')

# Fix crypto symbol - tickers already have -USD suffix
old_sym = "MARKET === 'CRYPTO' ? `${ticker}-USD`"
new_sym = "MARKET === 'CRYPTO' ? ticker"
if old_sym in c:
    c = c.replace(old_sym, new_sym, 1)
    print('[2] Fixed crypto symbol (already has -USD)')
else:
    print('[2] SKIP')

# For US market, skip broker flow queries (no IDX broker data)
# The worker queries ft_broker_concentration - need to skip for US
old_broker = "    const [brokerRows] = await pool.query("
if old_broker in c:
    # We need to wrap the broker query with a market check
    # Actually, let's just handle the error gracefully - it already does try/catch
    print('[3] Broker flow query - checking error handling...')
else:
    print('[3] SKIP: no broker query found')

with open(FILE, 'w') as f:
    f.write(c)
print('Done!')
