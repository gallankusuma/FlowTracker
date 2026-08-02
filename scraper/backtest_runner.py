#!/usr/bin/env python3
"""
FlowTracker Harmonic Pattern Backtest Runner — Multi-Layer Confluence v3
=========================================================================
4-Layer Confluence System:
  L1: Harmonic Pattern (XABCD) — 25 pts
  L2: Trend Alignment (EMA20/50) — 25 pts
  L3: Volume Spike (>1.3x avg) — 25 pts
  L4: Broker Flow (idx_broker_summary) — 25 pts

Only patterns with Confluence Score >= 60 are kept.

Usage:
  python3 backtest_runner.py <run_id> <start_date> <end_date> [min_score]
Progress written to /tmp/backtest_<run_id>.json
"""

import sys, json, time, math, os
from datetime import datetime
import pymysql

# ── DB Config ──────────────────────────────────────────────────────────────────
DB_CFG = dict(
    host='localhost', port=3306,
    user='erp_user', password=os.environ.get('DB_PASSWORD'),
    database='erp_manufacturing',
    charset='utf8mb4', cursorclass=pymysql.cursors.DictCursor
)

# ── Constants ─────────────────────────────────────────────────────────────────
HARMONIC_TOLERANCE = 0.06
SWING_THRESHOLD    = 0.04
MAX_SWINGS         = 20
MIN_OHLC_BARS      = 60
MAX_D_AGE          = 15
MIN_RR             = 1.0
DEFAULT_MIN_SCORE  = 60   # minimum confluence score to keep a signal

# ═══════════════════════════════════════════════════════════════
# LAYER 1 — HARMONIC PATTERN MATH (identical to harmonicEngine.js)
# ═══════════════════════════════════════════════════════════════

def near(val, target, tol):
    return abs(val - target) <= tol

def in_range(val, lo, hi):
    return (lo - HARMONIC_TOLERANCE) <= val <= (hi + HARMONIC_TOLERANCE)

def validate_pattern(name, r):
    XA = r['XA'] or 1; AB = r['AB'] or 1
    if name == 'ABCD':
        return in_range(r['BC']/AB, 0.382, 0.886)
    elif name == 'GARTLEY':
        return near(r['AB']/XA,0.618,0.06) and in_range(r['BC']/AB,0.382,0.886) and near(r['AD']/XA,0.786,0.06)
    elif name == 'BAT':
        return in_range(r['AB']/XA,0.382,0.500) and in_range(r['BC']/AB,0.382,0.886) and near(r['AD']/XA,0.886,0.06)
    elif name == 'BUTTERFLY':
        return (near(r['AB']/XA,0.786,0.06) and in_range(r['BC']/AB,0.382,0.886) and
                (near(r['AD']/XA,1.618,0.08) or near(r['AD']/XA,2.618,0.10) or near(r['AD']/XA,1.272,0.08)))
    elif name == 'CRAB':
        return in_range(r['AB']/XA,0.382,0.618) and in_range(r['BC']/AB,0.382,0.886) and near(r['AD']/XA,1.618,0.06)
    elif name == 'SHARK':
        return in_range(r['AB']/XA,0.446,0.618) and in_range(r['BC']/AB,1.13,1.618) and near(r['AD']/XA,0.886,0.08)
    elif name == 'CYPHER':
        return in_range(r['AB']/XA,0.382,0.618) and in_range(r['BC']/AB,1.272,1.414) and near(r['AD']/XA,0.786,0.07)
    return False

PATTERN_NAMES = ['ABCD','GARTLEY','BAT','BUTTERFLY','CRAB','SHARK','CYPHER']

def compute_ratios(X, A, B, C, D):
    return {
        'XA': abs(A['price']-X['price']),
        'AB': abs(B['price']-A['price']),
        'BC': abs(C['price']-B['price']),
        'CD': abs(D['price']-C['price']),
        'AD': abs(D['price']-A['price']),
    }

def compute_fib_score(name, r):
    XA = r['XA'] or 1; AB = r['AB'] or 1
    checks = {
        'ABCD':      [{'v': r['BC']/AB,    'ts': [0.618,0.786]}],
        'GARTLEY':   [{'v': r['AB']/XA,    'ts': [0.618]}, {'v': r['AD']/XA, 'ts': [0.786]}],
        'BAT':       [{'v': r['AB']/XA,    'ts': [0.382,0.500]}, {'v': r['AD']/XA, 'ts': [0.886]}],
        'BUTTERFLY': [{'v': r['AB']/XA,    'ts': [0.786]}, {'v': r['AD']/XA, 'ts': [1.618,2.618]}],
        'CRAB':      [{'v': r['AB']/XA,    'ts': [0.382,0.618]}, {'v': r['AD']/XA, 'ts': [1.618]}],
        'SHARK':     [{'v': r['AB']/XA,    'ts': [0.446,0.618]}, {'v': r['AD']/XA, 'ts': [0.886]}],
        'CYPHER':    [{'v': r['AB']/XA,    'ts': [0.382,0.618]}, {'v': r['AD']/XA, 'ts': [0.786]}],
    }.get(name, [])
    total = sum(max(0, 100 - min(abs(c['v']-t) for t in c['ts'])/0.06*100) for c in checks)
    return round(total / max(len(checks), 1))

# ═══════════════════════════════════════════════════════════════
# SWING DETECTION (identical to harmonicEngine.js detectSwings)
# ═══════════════════════════════════════════════════════════════

def detect_swings(ohlc, threshold=0.04, max_sw=20):
    if not ohlc or len(ohlc) < 10: return []
    swings = []
    lf = 'H'
    rh = {'price': ohlc[0]['high'], 'idx': 0, 'date': ohlc[0]['date']}
    rl = {'price': ohlc[0]['low'],  'idx': 0, 'date': ohlc[0]['date']}
    for i in range(1, len(ohlc)):
        b = ohlc[i]
        if b['high'] > rh['price']: rh = {'price': b['high'], 'idx': i, 'date': b['date']}
        if b['low']  < rl['price']: rl = {'price': b['low'],  'idx': i, 'date': b['date']}
        if lf == 'H':
            if (rh['price'] - b['low']) / rh['price'] >= threshold:
                swings.append({**rh, 'type': 'H'}); lf = 'L'
                rl = {'price': b['low'], 'idx': i, 'date': b['date']}
        else:
            if (b['high'] - rl['price']) / rl['price'] >= threshold:
                swings.append({**rl, 'type': 'L'}); lf = 'H'
                rh = {'price': b['high'], 'idx': i, 'date': b['date']}
    return swings[-max_sw:]

# ═══════════════════════════════════════════════════════════════
# LAYER 2 — TREND ALIGNMENT (EMA20 / EMA50)
# ═══════════════════════════════════════════════════════════════

def calc_ema(prices, period):
    """Exponential Moving Average."""
    if len(prices) < period: return None
    k = 2 / (period + 1)
    ema = sum(prices[:period]) / period
    for p in prices[period:]:
        ema = p * k + ema * (1 - k)
    return ema

def check_trend_alignment(ohlc, direction):
    """
    Returns (score 0-25, details dict)
    Bullish: price near/above EMA20, EMA20 above EMA50 (or recent cross) = 25
    Bearish: price near/below EMA20, EMA20 below EMA50 = 25
    Neutral/opposite trend = 0
    """
    if len(ohlc) < 50:
        return 12, {'trend': 'INSUFFICIENT_DATA', 'ema20': None, 'ema50': None}
    
    closes = [c['close'] for c in ohlc]
    ema20 = calc_ema(closes, 20)
    ema50 = calc_ema(closes, 50)
    last_close = closes[-1]
    
    if ema20 is None or ema50 is None:
        return 12, {'trend': 'INSUFFICIENT_DATA', 'ema20': None, 'ema50': None}
    
    trend = 'UP' if ema20 > ema50 else 'DOWN'
    
    # Zone: how close is price to EMA20 (within 2% = in zone)
    near_ema20 = abs(last_close - ema20) / ema20 < 0.02
    
    if direction == 'BULLISH':
        if trend == 'UP' and last_close >= ema20 * 0.98:
            score = 25  # perfect: uptrend + price near/above EMA20 support
        elif near_ema20:
            score = 15  # price testing EMA20 — potential bounce zone
        elif trend == 'DOWN':
            score = 0   # contra-trend bullish = very risky
        else:
            score = 10
    else:  # BEARISH
        if trend == 'DOWN' and last_close <= ema20 * 1.02:
            score = 25  # perfect: downtrend + price near/below EMA20 resistance
        elif near_ema20:
            score = 15
        elif trend == 'UP':
            score = 0   # contra-trend bearish = risky
        else:
            score = 10

    return score, {'trend': trend, 'ema20': round(ema20, 2), 'ema50': round(ema50, 2),
                   'last_close': last_close, 'near_ema20': near_ema20}

# ═══════════════════════════════════════════════════════════════
# LAYER 3 — VOLUME SPIKE CONFIRMATION
# ═══════════════════════════════════════════════════════════════

def check_volume_spike(ohlc, lookback=20, threshold=1.3):
    """
    Returns (score 0-25, details dict)
    Volume on D-point candle vs avg 20 days.
    > 2.0x avg = 25pts, > 1.3x = 20pts, else = 0-10pts
    """
    if len(ohlc) < lookback + 1:
        return 10, {'volume_ratio': None, 'spike': False}
    
    vols = [c['volume'] for c in ohlc]
    avg_vol = sum(vols[-lookback-1:-1]) / lookback  # exclude last candle from avg
    last_vol = vols[-1]
    
    if avg_vol == 0:
        return 10, {'volume_ratio': None, 'spike': False}
    
    ratio = last_vol / avg_vol
    
    if ratio >= 2.0:
        score = 25  # strong spike
    elif ratio >= threshold:
        score = 20  # moderate spike
    elif ratio >= 1.0:
        score = 10  # normal volume
    else:
        score = 5   # low volume — less reliable

    return score, {'volume_ratio': round(ratio, 2), 'spike': ratio >= threshold,
                   'last_volume': int(last_vol), 'avg_volume': int(avg_vol)}

# ═══════════════════════════════════════════════════════════════
# LAYER 4 — BROKER FLOW CONFIRMATION
# ═══════════════════════════════════════════════════════════════

def check_broker_flow(broker_data_by_date, ticker, d_date, direction, lookback_days=3):
    """
    Returns (score 0-25, details dict)
    Uses pre-loaded broker data (passed as dict by date) for speed.
    Net flow = SUM(buy_val - sell_val) for the ticker over last N days.
    """
    # broker_data_by_date: {date: {ticker: {net_val, buy_val, sell_val}}}
    
    # Find dates <= d_date with broker data
    available_dates = sorted([d for d in broker_data_by_date.keys() if d <= d_date], reverse=True)
    recent_dates = available_dates[:lookback_days]
    
    if not recent_dates:
        return 10, {'broker_net': None, 'days_checked': 0, 'coverage': 'NO_DATA'}
    
    total_net = 0
    total_buy = 0
    total_sell = 0
    days_found = 0
    
    for d in recent_dates:
        ticker_data = broker_data_by_date[d].get(ticker)
        if ticker_data:
            total_net  += ticker_data['net_val']
            total_buy  += ticker_data['buy_val']
            total_sell += ticker_data['sell_val']
            days_found += 1
    
    if days_found == 0:
        return 8, {'broker_net': None, 'days_checked': 0, 'coverage': 'TICKER_NOT_FOUND'}
    
    # Normalize: positive net = accumulation, negative = distribution
    net_in_billions = total_net / 1e9
    
    if direction == 'BULLISH':
        if total_net > 0:
            # Broker accumulating — confirms bullish
            score = 25 if total_net > 5e9 else (20 if total_net > 1e9 else 15)
        else:
            # Broker distributing — contradicts bullish
            score = 0 if total_net < -5e9 else 5
    else:  # BEARISH
        if total_net < 0:
            # Broker distributing — confirms bearish
            score = 25 if total_net < -5e9 else (20 if total_net < -1e9 else 15)
        else:
            # Broker accumulating — contradicts bearish
            score = 0 if total_net > 5e9 else 5
    
    return score, {
        'broker_net': round(net_in_billions, 2),
        'broker_net_raw': total_net,
        'days_checked': days_found,
        'accumulating': total_net > 0,
        'coverage': f'{days_found}/{lookback_days} days'
    }

# ═══════════════════════════════════════════════════════════════
# CONFLUENCE SCORE CALCULATOR
# ═══════════════════════════════════════════════════════════════

def calc_confluence(ohlc, ticker, d_date, direction, broker_data_by_date, fib_sc):
    """Compute total confluence score (0-100) from all 4 layers."""
    
    # L1: Harmonic pattern quality (fib score mapped to 0-25)
    l1_score = min(25, round(fib_sc / 4))
    
    # L2: Trend alignment
    l2_score, l2_detail = check_trend_alignment(ohlc, direction)
    
    # L3: Volume spike
    l3_score, l3_detail = check_volume_spike(ohlc)
    
    # L4: Broker flow
    l4_score, l4_detail = check_broker_flow(broker_data_by_date, ticker, d_date, direction)
    
    total = l1_score + l2_score + l3_score + l4_score
    
    return total, {
        'total': total,
        'l1_pattern': l1_score,
        'l2_trend': l2_score,
        'l3_volume': l3_score,
        'l4_broker': l4_score,
        'trend_detail': l2_detail,
        'volume_detail': l3_detail,
        'broker_detail': l4_detail,
    }

# ═══════════════════════════════════════════════════════════════
# MAIN HARMONIC DETECTION + CONFLUENCE FILTER
# ═══════════════════════════════════════════════════════════════

def detect_harmonic_patterns(ohlc, ticker, broker_data_by_date, scan_date, min_score=60):
    swings = detect_swings(ohlc, SWING_THRESHOLD, MAX_SWINGS)
    if len(swings) < 5: return []

    n = len(ohlc)
    results = []

    for i in range(len(swings) - 4):
        X, A, B, C, D = swings[i:i+5]
        is_bullish = (X['type']=='L' and A['type']=='H' and B['type']=='L' and C['type']=='H' and D['type']=='L')
        is_bearish = (X['type']=='H' and A['type']=='L' and B['type']=='H' and C['type']=='L' and D['type']=='H')
        if not is_bullish and not is_bearish: continue

        ratios = compute_ratios(X, A, B, C, D)
        direction = 'BULLISH' if is_bullish else 'BEARISH'

        days_ago = n - 1 - D['idx']
        if days_ago > MAX_D_AGE: continue

        for pat_name in PATTERN_NAMES:
            if not validate_pattern(pat_name, ratios): continue

            entry = D['price']
            if is_bullish:
                swing_range = abs(A['price'] - D['price'])
                sl = min(D['price'] * 0.985, X['price'] * 0.99)
                t1 = D['price'] + swing_range * 0.382
                t2 = D['price'] + swing_range * 0.618
            else:
                swing_range = abs(D['price'] - A['price'])
                sl = max(D['price'] * 1.015, X['price'] * 1.01)
                t1 = D['price'] - swing_range * 0.382
                t2 = D['price'] - swing_range * 0.618

            risk = abs(entry - sl); reward = abs(t1 - entry)
            rr = round(reward / risk, 2) if risk > 0 else 0
            if rr < MIN_RR: continue

            # Direction guard
            if is_bullish and (sl >= entry or t1 <= entry or t2 <= t1): continue
            if is_bearish and (sl <= entry or t1 >= entry or t2 >= t1): continue

            fib_sc = compute_fib_score(pat_name, ratios)

            # ── CONFLUENCE SCORE ──────────────────────────────────
            # Use OHLC up to D point for indicator calculations
            d_idx = D['idx']
            ohlc_at_d = ohlc[:d_idx+1]
            
            confluence, conf_detail = calc_confluence(
                ohlc_at_d, ticker, D['date'], direction,
                broker_data_by_date, fib_sc
            )

            if confluence < min_score:
                continue  # ⛔ Skip low-quality signals

            XA = ratios['XA'] or 1
            results.append({
                'ticker': ticker,
                'pattern_type': pat_name,
                'direction': direction,
                'D_date': D['date'],
                'entry_price': round(entry),
                'stop_loss': round(sl),
                'target_1': round(t1),
                'target_2': round(t2),
                'risk_reward': rr,
                'fib_score': fib_sc,
                'conviction_score': confluence,
                'confluence_score': confluence,
                'confluence_breakdown': conf_detail,
                'pattern_data': json.dumps({
                    'X': {'price': X['price'], 'date': X['date']},
                    'A': {'price': A['price'], 'date': A['date']},
                    'B': {'price': B['price'], 'date': B['date']},
                    'C': {'price': C['price'], 'date': C['date']},
                    'D': {'price': D['price'], 'date': D['date']},
                    'ratios': {
                        'AB_XA': round(ratios['AB']/XA, 3),
                        'BC_AB': round(ratios['BC']/ratios['AB'], 3) if ratios['AB'] > 0 else 0,
                        'AD_XA': round(ratios['AD']/XA, 3),
                    },
                    'confluence': conf_detail
                })
            })

    # De-duplicate: per ticker+direction keep highest confluence score
    best = {}
    for r in results:
        key = f"{r['ticker']}-{r['direction']}"
        if key not in best or r['confluence_score'] > best[key]['confluence_score']:
            best[key] = r
    return list(best.values())

# ═══════════════════════════════════════════════════════════════
# TRADE SIMULATION
# ═══════════════════════════════════════════════════════════════

def simulate_trade(pattern, future_ohlc):
    entry = pattern['entry_price']; sl = pattern['stop_loss']
    t1 = pattern['target_1']; t2 = pattern['target_2']
    direction = pattern['direction']
    
    status = 'NO_ENTRY'; result_pct = 0.0
    exit_price = None; exit_date = None; hold_days = 0
    entered = False

    for i, row in enumerate(future_ohlc):
        h, l, c, d = row['high'], row['low'], row['close'], row['date']
        if not entered:
            if l <= entry * 1.01 and h >= entry * 0.99:
                entered = True
            elif i >= 3:
                break
            continue
        hold_days = i
        if direction == 'BULLISH':
            if l <= sl:
                status='STOPPED'; exit_price=sl; exit_date=d
                result_pct=round((sl-entry)/entry*100,2); break
            elif h >= t2:
                status='HIT_T2'; exit_price=t2; exit_date=d
                result_pct=round((t2-entry)/entry*100,2); break
            elif h >= t1:
                status='HIT_T1'; exit_price=t1; exit_date=d
                result_pct=round((t1-entry)/entry*100,2); break
        else:
            if h >= sl:
                status='STOPPED'; exit_price=sl; exit_date=d
                result_pct=round((entry-sl)/entry*100,2); break
            elif l <= t2:
                status='HIT_T2'; exit_price=t2; exit_date=d
                result_pct=round((entry-t2)/entry*100,2); break
            elif l <= t1:
                status='HIT_T1'; exit_price=t1; exit_date=d
                result_pct=round((entry-t1)/entry*100,2); break
        if hold_days >= 20:
            status='EXPIRED'; exit_price=c; exit_date=d
            mult = 1 if direction == 'BULLISH' else -1
            result_pct=round((c-entry)/entry*100*mult,2); break

    if entered and status == 'NO_ENTRY': status = 'EXPIRED'
    return status, result_pct, exit_price, exit_date, hold_days

def write_progress(run_id, data):
    with open(f'/tmp/backtest_{run_id}.json', 'w') as f:
        json.dump(data, f, default=str)

# ═══════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════

def main():
    if len(sys.argv) < 4:
        print('Usage: python3 backtest_runner.py <run_id> <start_date> <end_date> [min_score]')
        sys.exit(1)

    run_id     = sys.argv[1]
    start_date = sys.argv[2]
    end_date   = sys.argv[3]
    min_score  = int(sys.argv[4]) if len(sys.argv) > 4 else DEFAULT_MIN_SCORE

    progress = {'run_id': run_id, 'status': 'RUNNING', 'startDate': start_date,
                'endDate': end_date, 'min_score': min_score,
                'progress': {'processed': 0, 'total': 0, 'currentDate': ''},
                'startedAt': datetime.now().isoformat()}
    write_progress(run_id, progress)

    print(f'\n🔬 [BACKTEST v3] Run {run_id}')
    print(f'   📅 {start_date} → {end_date}  |  Min score: {min_score}')
    t0 = time.time()

    conn = pymysql.connect(**DB_CFG)
    cur  = conn.cursor()

    # ── 1. Load OHLC (bulk) ────────────────────────────────────
    print('   ⏳ Loading OHLC...')
    cur.execute("""
        SELECT ticker, date, open_price AS `open`, high_price AS high,
               low_price AS low, close_price AS close, volume
        FROM ft_price_ohlc WHERE date <= %s ORDER BY ticker, date ASC
    """, (end_date,))
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
    print(f'   ✅ {len(all_rows)} OHLC rows, {len(tickers)} tickers in {round(time.time()-t0,2)}s')

    # ── 2. Load Broker Flow (bulk, all dates in range + 5 before start) ──
    print('   ⏳ Loading broker flow...')
    tb = time.time()
    cur.execute("""
        SELECT date, stock_code, SUM(buy_val) as buy_val, SUM(sell_val) as sell_val,
               SUM(net_val) as net_val
        FROM idx_broker_summary
        WHERE date <= %s AND date >= DATE_SUB(%s, INTERVAL 7 DAY)
        GROUP BY date, stock_code
    """, (end_date, start_date))
    broker_rows = cur.fetchall()

    # Build dict: {date_str: {ticker: {net_val, buy_val, sell_val}}}
    broker_by_date = {}
    for r in broker_rows:
        d = str(r['date'])[:10]
        broker_by_date.setdefault(d, {})[r['stock_code']] = {
            'net_val': float(r['net_val'] or 0),
            'buy_val': float(r['buy_val'] or 0),
            'sell_val': float(r['sell_val'] or 0),
        }
    print(f'   ✅ {len(broker_rows)} broker rows, {len(broker_by_date)} dates in {round(time.time()-tb,2)}s')

    # ── 3. Get trading days in range ──────────────────────────
    trading_days = sorted(set(
        str(r['date'])[:10] for r in all_rows
        if start_date <= str(r['date'])[:10] <= end_date
    ))
    print(f'   📆 {len(trading_days)} trading days, {len(tickers)} tickers')

    progress['progress']['total'] = len(trading_days)
    write_progress(run_id, progress)

    # ── 4. Scan each day ──────────────────────────────────────
    trades = []
    seen   = set()
    skipped_low_score = 0

    for day_i, scan_date in enumerate(trading_days):
        progress['progress']['processed'] = day_i + 1
        progress['progress']['currentDate'] = scan_date
        if day_i % 5 == 0:
            write_progress(run_id, progress)

        for ticker, ohlc_full in ohlc_by_ticker.items():
            ohlc_cut = [r for r in ohlc_full if r['date'] <= scan_date]
            if len(ohlc_cut) < MIN_OHLC_BARS: continue

            try:
                patterns = detect_harmonic_patterns(
                    ohlc_cut, ticker, broker_by_date, scan_date, min_score
                )
            except Exception as e:
                continue

            for pat in patterns:
                key = f"{ticker}|{pat['pattern_type']}|{pat['direction']}|{pat['D_date']}"
                if key in seen: continue
                seen.add(key)

                pat['run_id'] = run_id
                pat['detected_date'] = scan_date
                pat['entry_date']    = scan_date

                future = [r for r in ohlc_full if r['date'] > scan_date]
                status, result_pct, exit_price, exit_date, hold_days = simulate_trade(pat, future)

                pat.update({'status': status, 'result_pct': result_pct,
                            'exit_price': exit_price, 'exit_date': exit_date, 'hold_days': hold_days})
                trades.append(pat)

    print(f'   🔍 {len(trades)} signals passed confluence filter (min score: {min_score})')

    # ── 5. Batch INSERT ───────────────────────────────────────
    if trades:
        sql = """
            INSERT INTO ft_backtest_results
            (run_id, ticker, pattern_type, direction, detected_date,
             entry_price, entry_date, stop_loss, target_1, target_2,
             risk_reward, conviction_score, fib_score,
             status, result_pct, exit_price, exit_date, hold_days, pattern_data)
            VALUES (%s,%s,%s,%s,%s, %s,%s,%s,%s,%s, %s,%s,%s, %s,%s,%s,%s,%s,%s)
        """
        vals = [(
            t['run_id'], t['ticker'], t['pattern_type'], t['direction'], t['detected_date'],
            t['entry_price'], t.get('entry_date'), t['stop_loss'], t['target_1'], t['target_2'],
            t['risk_reward'], t['conviction_score'], t['fib_score'],
            t['status'], t['result_pct'], t.get('exit_price'), t.get('exit_date'),
            t.get('hold_days', 0), t['pattern_data']
        ) for t in trades]

        for i in range(0, len(vals), 200):
            try:
                cur.executemany(sql, vals[i:i+200])
                conn.commit()
            except Exception as e:
                print(f'   ⚠️  INSERT error: {e}')
                conn.rollback()
        print(f'   ✅ Inserted {len(trades)} records')

    # ── 6. Stats ──────────────────────────────────────────────
    entered  = [t for t in trades if t['status'] != 'NO_ENTRY']
    wins     = [t for t in entered if t['status'] in ('HIT_T1','HIT_T2')]
    losses   = [t for t in entered if t['status'] == 'STOPPED']
    win_rate = round(len(wins)/len(entered)*100, 1) if entered else 0
    avg_ret  = round(sum(t['result_pct'] for t in entered)/len(entered), 2) if entered else 0
    elapsed  = round(time.time()-t0, 1)

    # Score distribution
    scores = [t['conviction_score'] for t in trades]
    score_dist = {
        'high_75plus': len([s for s in scores if s >= 75]),
        'mid_60_74': len([s for s in scores if 60 <= s < 75]),
    }

    result = {
        'run_id': run_id, 'status': 'DONE', 'min_score': min_score,
        'total_trades': len(trades), 'entered': len(entered),
        'wins': len(wins), 'losses': len(losses),
        'expired': len([t for t in entered if t['status']=='EXPIRED']),
        'no_entry': len([t for t in trades if t['status']=='NO_ENTRY']),
        'win_rate': win_rate, 'avg_return': avg_ret,
        'score_distribution': score_dist,
        'elapsed_seconds': elapsed,
        'completedAt': datetime.now().isoformat()
    }
    progress.update(result)
    progress['progress'] = {'processed': len(trading_days), 'total': len(trading_days), 'currentDate': end_date}
    write_progress(run_id, progress)

    print(f'\n✅ [BACKTEST v3] COMPLETE in {elapsed}s!')
    print(f'   📊 Signals: {len(trades)} (HIGH≥75: {score_dist["high_75plus"]}, MID 60-74: {score_dist["mid_60_74"]})')
    print(f'   🎯 Win rate: {win_rate}%  |  Avg return: {avg_ret}%')
    print(f'   📈 {len(wins)} wins | {len(losses)} losses | {len(entered)-len(wins)-len(losses)} expired')
    print(json.dumps(result))

    cur.close(); conn.close()

if __name__ == '__main__':
    main()
