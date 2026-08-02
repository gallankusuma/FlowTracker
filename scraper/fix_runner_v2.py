#!/usr/bin/env python3
"""Add missing TOP_US_STOCKS and fetch_yahoo_ohlc to backtest_runner.py - v2"""

RUNNER = '/var/www/flowtracker-scraper/backtest_runner.py'
with open(RUNNER, 'r') as f:
    rc = f.read()

block = '''
# US S&P 500 Top Tickers for backtest
TOP_US_STOCKS = [
    'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','BRK-B','UNH','XOM',
    'JNJ','JPM','V','PG','MA','AVGO','HD','CVX','MRK','ABBV',
    'LLY','PEP','KO','COST','ADBE','WMT','MCD','CRM','CSCO','TMO',
    'ACN','ABT','NFLX','DHR','LIN','TXN','NEE','PM','CMCSA','UNP',
    'INTC','AMD','QCOM','LOW','BA','HON','UPS','RTX','CAT','GE',
]

def fetch_yahoo_ohlc(ticker, start_date, end_date):
    """Fetch OHLC from Yahoo Finance for US stocks."""
    import urllib.request, json
    from datetime import datetime, timedelta

    start_dt = datetime.strptime(start_date, '%Y-%m-%d') - timedelta(days=365)
    end_dt = datetime.strptime(end_date, '%Y-%m-%d') + timedelta(days=1)

    p1 = int(start_dt.timestamp())
    p2 = int(end_dt.timestamp())

    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?period1={p1}&period2={p2}&interval=1d"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        data = json.loads(resp.read())
        result = data.get('chart', {}).get('result', [{}])[0]
        timestamps = result.get('timestamp', [])
        quote = result.get('indicators', {}).get('quote', [{}])[0]

        candles = []
        for i, ts in enumerate(timestamps):
            c = quote.get('close', [None])[i]
            if c is None or c <= 0: continue
            candles.append({
                'date': datetime.utcfromtimestamp(ts).strftime('%Y-%m-%d'),
                'open': float(quote.get('open', [c])[i] or c),
                'high': float(quote.get('high', [c])[i] or c),
                'low': float(quote.get('low', [c])[i] or c),
                'close': float(c),
                'volume': float(quote.get('volume', [0])[i] or 0),
            })
        return candles
    except Exception as e:
        print(f"    Warning: Yahoo fetch failed for {ticker}: {e}")
        return []

'''

# Insert before def main()
if 'TOP_US_STOCKS = [' not in rc:
    idx = rc.find('\ndef main():')
    if idx >= 0:
        rc = rc[:idx] + block + rc[idx:]
        with open(RUNNER, 'w') as f:
            f.write(rc)
        print("[1] Inserted TOP_US_STOCKS + fetch_yahoo_ohlc before main()")
    else:
        print("[1] ERROR: def main() not found")
else:
    print("[1] Already exists")

# Verify
with open(RUNNER, 'r') as f:
    rc2 = f.read()
print(f"Verify TOP_US_STOCKS: {'FOUND' if 'TOP_US_STOCKS = [' in rc2 else 'MISSING'}")
print(f"Verify fetch_yahoo_ohlc: {'FOUND' if 'def fetch_yahoo_ohlc' in rc2 else 'MISSING'}")
print("Done!")
