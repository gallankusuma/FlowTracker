#!/usr/bin/env python3
"""
Update backtest_runner.py to:
1. Accept market param (argv[5])
2. For US market, fetch data from Yahoo Finance instead of DB
3. For IDX market, keep using DB (existing logic)
"""
import re

RUNNER = '/var/www/flowtracker-scraper/backtest_runner.py'
with open(RUNNER, 'r') as f:
    rc = f.read()

# Check if market is already properly handled
if "market == 'US'" in rc:
    print("[1] SKIP: US market already handled in runner")
else:
    # Find where tickers are loaded from DB
    # After ohlc_by_ticker is built, add US market logic
    
    # First, add US ticker list
    us_tickers_block = """
# US S&P 500 Top Tickers for backtest
TOP_US_STOCKS = [
    'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','BRK-B','UNH','XOM',
    'JNJ','JPM','V','PG','MA','AVGO','HD','CVX','MRK','ABBV',
    'LLY','PEP','KO','COST','ADBE','WMT','MCD','CRM','CSCO','TMO',
    'ACN','ABT','NFLX','DHR','LIN','TXN','NEE','PM','CMCSA','UNP',
    'INTC','AMD','QCOM','LOW','BA','HON','UPS','RTX','CAT','GE',
]
"""
    
    # Insert before the main function
    main_match = re.search(r"def run_backtest\(", rc)
    if main_match:
        rc = rc[:main_match.start()] + us_tickers_block + "\n" + rc[main_match.start():]
        print("[2] Added TOP_US_STOCKS list")
    
    # Add Yahoo fetch function for US market
    yahoo_fetch = '''
def fetch_yahoo_ohlc(ticker, start_date, end_date):
    """Fetch OHLC from Yahoo Finance for US stocks."""
    import urllib.request, json
    from datetime import datetime, timedelta
    
    # Get 1 year before start_date for enough history
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
        print(f"    ⚠️ Yahoo fetch failed for {ticker}: {e}")
        return []

'''
    
    # Insert before run_backtest
    main_match2 = re.search(r"def run_backtest\(", rc)
    if main_match2:
        rc = rc[:main_match2.start()] + yahoo_fetch + "\n" + rc[main_match2.start():]
        print("[3] Added fetch_yahoo_ohlc function")
    
    # Now modify the OHLC loading section to handle US market
    # Find the section that loads from DB
    old_ohlc_load = """    # ── 1. Load OHLC (bulk) ────────────────────────────────────
    print('   ⏳ Loading OHLC...')
    cur.execute(\"\"\"
        SELECT ticker, date, open_price AS `open`, high_price AS high,
               low_price AS low, close_price AS close, volume
        FROM ft_price_ohlc WHERE date <= %s ORDER BY ticker, date ASC
    \"\"\", (end_date,))
    all_rows = cur.fetchall()

    ohlc_by_ticker = {}
    for r in all_rows:
        t = r['ticker']
        d = str(r['date'])[:10]
        ohlc_by_ticker.setdefault(t, []).append({
            'date': d, 'open': float(r['open']), 'high': float(r['high']),
            'low': float(r['low']), 'close': float(r['close']),
            'volume': float(r['volume'] or 0)
        })
    tickers = list(ohlc_by_ticker.keys())
    print(f'   ✅ {len(all_rows)} OHLC rows, {len(tickers)} tickers in {round(time.time()-t0,2)}s')"""
    
    new_ohlc_load = """    # ── 1. Load OHLC (bulk) ────────────────────────────────────
    ohlc_by_ticker = {}
    if market == 'US':
        print('   ⏳ Loading OHLC from Yahoo Finance (US)...')
        for i, ticker in enumerate(TOP_US_STOCKS):
            print(f'     [{i+1}/{len(TOP_US_STOCKS)}] {ticker}...')
            candles = fetch_yahoo_ohlc(ticker, start_date, end_date)
            if len(candles) >= 20:
                ohlc_by_ticker[ticker] = candles
            import time as _t; _t.sleep(0.3)  # Rate limit
        all_rows = sum(len(v) for v in ohlc_by_ticker.values())
        tickers = list(ohlc_by_ticker.keys())
        print(f'   ✅ {all_rows} OHLC rows, {len(tickers)} US tickers in {round(time.time()-t0,2)}s')
    else:
        print('   ⏳ Loading OHLC from DB (IDX)...')
        cur.execute(\\\"\\\"\\\"
            SELECT ticker, date, open_price AS `open`, high_price AS high,
                   low_price AS low, close_price AS close, volume
            FROM ft_price_ohlc WHERE date <= %s ORDER BY ticker, date ASC
        \\\"\\\"\\\", (end_date,))
        all_rows = cur.fetchall()

        for r in all_rows:
            t = r['ticker']
            d = str(r['date'])[:10]
            ohlc_by_ticker.setdefault(t, []).append({
                'date': d, 'open': float(r['open']), 'high': float(r['high']),
                'low': float(r['low']), 'close': float(r['close']),
                'volume': float(r['volume'] or 0)
            })
        tickers = list(ohlc_by_ticker.keys())
        print(f'   ✅ {len(all_rows)} OHLC rows, {len(tickers)} tickers in {round(time.time()-t0,2)}s')"""
    
    if old_ohlc_load in rc:
        rc = rc.replace(old_ohlc_load, new_ohlc_load, 1)
        print("[4] Updated OHLC loading with US/IDX market split")
    else:
        print("[4] SKIP: OHLC loading section different")
    
    # Also handle broker flow for US (skip it, no broker data)
    old_broker = """    # ── 2. Load Broker Flow (bulk, all dates in range + 5 before start) ──
    print('   ⏳ Loading broker flow...')"""
    new_broker = """    # ── 2. Load Broker Flow (bulk, all dates in range + 5 before start) ──
    broker_by_date = {}
    if market == 'US':
        print('   ℹ️ Skipping broker flow (not available for US)')
        broker_rows = []
    else:
        print('   ⏳ Loading broker flow...')"""
    
    if old_broker in rc:
        rc = rc.replace(old_broker, new_broker, 1)
        print("[5] Added US broker flow skip")
    else:
        print("[5] SKIP: broker section different")

    with open(RUNNER, 'w') as f:
        f.write(rc)

print("\nDone!")
