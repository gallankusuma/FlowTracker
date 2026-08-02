#!/usr/bin/env python3
"""
hk_fetcher.py  
HK market data fetcher using yfinance + Alpha Vantage
Supports: OHLCV, RSI, MA, quote for HKEX stocks
"""

import yfinance as yf
import pandas as pd
import numpy as np
import requests
import logging
from datetime import datetime, timedelta
from typing import Optional, Dict, List

log = logging.getLogger('HKFetcher')

ALPHA_VANTAGE_KEY = 'demo'  # replace
ALPHA_BASE = 'https://www.alphavantage.co/query'

# HK market hours (UTC+8) 
# Morning: 09:30-12:00  Afternoon: 13:00-16:00
HK_OPEN_MORNING  = (9, 30)
HK_CLOSE_MORNING = (12, 0)
HK_OPEN_AFTERNOON  = (13, 0)
HK_CLOSE_AFTERNOON = (16, 0)

# Major HK stocks watchlist (Hang Seng Index components)
HK_WATCHLIST = {
    # Tech / Internet
    '0700': {'name': 'Tencent Holdings',  'sector': 'TECH'},
    '9988': {'name': 'Alibaba Group',     'sector': 'TECH'},
    '9618': {'name': 'JD.com',            'sector': 'TECH'},
    '9888': {'name': 'Baidu',             'sector': 'TECH'},
    '9999': {'name': 'NetEase',           'sector': 'TECH'},
    # Finance
    '0005': {'name': 'HSBC Holdings',     'sector': 'FINTECH'},
    '0939': {'name': 'CCB',               'sector': 'FINTECH'},
    '1398': {'name': 'ICBC',              'sector': 'FINTECH'},
    '0388': {'name': 'HK Exchanges',      'sector': 'FINTECH'},
    '1299': {'name': 'AIA Group',         'sector': 'FINTECH'},
    # Consumer
    '9961': {'name': 'Trip.com',          'sector': 'CONSUMER'},
    '6862': {'name': 'Haidilao',          'sector': 'CONSUMER'},
    # EV / Industrial
    '0175': {'name': 'Geely Auto',        'sector': 'INDUSTRIAL'},
    '2015': {'name': 'Li Auto',           'sector': 'INDUSTRIAL'},
    '0268': {'name': 'Kingdee Intl',      'sector': 'TECH'},
}

# Macro proxies for HK market
HK_MACRO_PROXIES = {
    '^HSI':    'Hang Seng Index',
    '^HSCE':   'H-Shares Index (China)',
    'USDCNH=X': 'USD/CNH (Yuan)',
    'USDHKD=X': 'USD/HKD Peg',
    '2800.HK':  'Tracker Fund HSI ETF',
    '3188.HK':  'China A50 ETF',
}


def hk_symbol(code: str) -> str:
    """Convert HK stock code to yfinance format"""
    code = str(code).lstrip('0') or '0'
    code = code.zfill(4)
    return f"{code}.HK"


def is_hk_market_open() -> bool:
    now_hkt = datetime.utcnow() + timedelta(hours=8)
    if now_hkt.weekday() >= 5:  # Sat/Sun
        return False
    h, m = now_hkt.hour, now_hkt.minute
    morning   = (h, m) >= HK_OPEN_MORNING   and (h, m) < HK_CLOSE_MORNING
    afternoon = (h, m) >= HK_OPEN_AFTERNOON and (h, m) < HK_CLOSE_AFTERNOON
    return morning or afternoon


def get_hk_quote(code: str) -> Optional[Dict]:
    """Get current quote for an HK stock via yfinance"""
    sym = hk_symbol(code)
    try:
        t = yf.Ticker(sym)
        info = t.fast_info
        hist = t.history(period='2d', interval='1d')
        if hist.empty:
            return None

        close_today = float(hist['Close'].iloc[-1])
        close_prev  = float(hist['Close'].iloc[-2]) if len(hist) >= 2 else close_today
        change      = close_today - close_prev
        change_pct  = (change / close_prev * 100) if close_prev else 0

        return {
            'code':       code,
            'symbol':     sym,
            'name':       HK_WATCHLIST.get(code, {}).get('name', sym),
            'sector':     HK_WATCHLIST.get(code, {}).get('sector', 'UNKNOWN'),
            'price':      round(close_today, 3),
            'change':     round(change, 3),
            'change_pct': round(change_pct, 2),
            'volume':     int(hist['Volume'].iloc[-1]),
            'prev_close': round(close_prev, 3),
            'market':     'hk',
        }
    except Exception as e:
        log.debug(f'get_hk_quote({code}): {e}')
        return None


def get_hk_ohlcv(code: str, period='3mo') -> Optional[pd.DataFrame]:
    """Get OHLCV data for HK stock via yfinance"""
    sym = hk_symbol(code)
    try:
        t = yf.Ticker(sym)
        df = t.history(period=period, interval='1d')
        if df.empty:
            return None
        df.index = pd.to_datetime(df.index)
        return df[['Open', 'High', 'Low', 'Close', 'Volume']]
    except Exception as e:
        log.debug(f'get_hk_ohlcv({code}): {e}')
        return None


def calc_rsi(closes: pd.Series, period=14) -> float:
    """Calculate RSI from close price series"""
    if len(closes) < period + 1:
        return 50.0
    delta = closes.diff().dropna()
    gain  = delta.clip(lower=0)
    loss  = (-delta).clip(lower=0)
    avg_gain = gain.rolling(period).mean().iloc[-1]
    avg_loss = loss.rolling(period).mean().iloc[-1]
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100 - (100 / (1 + rs)), 2)


def calc_macd(closes: pd.Series, fast=12, slow=26, signal=9) -> Dict:
    """Calculate MACD"""
    ema_fast = closes.ewm(span=fast).mean()
    ema_slow = closes.ewm(span=slow).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal).mean()
    histogram = macd_line - signal_line
    return {
        'macd':       round(float(macd_line.iloc[-1]), 4),
        'signal':     round(float(signal_line.iloc[-1]), 4),
        'histogram':  round(float(histogram.iloc[-1]), 4),
        'cross':      'bullish' if macd_line.iloc[-1] > signal_line.iloc[-1] else 'bearish',
    }


def calc_bollinger(closes: pd.Series, period=20, std=2) -> Dict:
    """Calculate Bollinger Bands"""
    ma   = closes.rolling(period).mean().iloc[-1]
    std_ = closes.rolling(period).std().iloc[-1]
    upper = ma + std * std_
    lower = ma - std * std_
    price = closes.iloc[-1]
    pct   = (price - lower) / (upper - lower) * 100 if (upper - lower) else 50
    return {
        'upper': round(float(upper), 3),
        'middle': round(float(ma), 3),
        'lower': round(float(lower), 3),
        'pct_b': round(float(pct), 1),
        'squeeze': float(std_) / float(ma) < 0.02,
    }


def calc_volume_ratio(volumes: pd.Series, period=20) -> float:
    """Volume ratio: today / avg(period days)"""
    if len(volumes) < 2:
        return 1.0
    avg = volumes.iloc[-period-1:-1].mean()
    return round(float(volumes.iloc[-1] / avg), 2) if avg > 0 else 1.0


def analyze_hk_stock(code: str) -> Optional[Dict]:
    """
    Full technical analysis for one HK stock.
    Returns score and indicators — ready for signal_engine.
    """
    df = get_hk_ohlcv(code, period='6mo')
    if df is None or len(df) < 30:
        return None

    closes  = df['Close']
    volumes = df['Volume']
    price   = float(closes.iloc[-1])

    # Moving averages
    ma5  = float(closes.rolling(5).mean().iloc[-1])
    ma10 = float(closes.rolling(10).mean().iloc[-1])
    ma20 = float(closes.rolling(20).mean().iloc[-1])
    ma60 = float(closes.rolling(60).mean().iloc[-1]) if len(closes) >= 60 else ma20

    # Returns
    ret5  = (price / float(closes.iloc[-6])  - 1) * 100 if len(closes) >= 6  else 0
    ret20 = (price / float(closes.iloc[-21]) - 1) * 100 if len(closes) >= 21 else 0

    # Indicators
    rsi    = calc_rsi(closes)
    macd   = calc_macd(closes)
    boll   = calc_bollinger(closes)
    vol_r  = calc_volume_ratio(volumes)

    # ── Scoring (aligned with US signal_engine layer) ──────────
    tech_score = 0.0

    # Trend (MA alignment)
    if price > ma20:        tech_score += 20
    if price > ma60:        tech_score += 20
    if ma5 > ma10 > ma20:   tech_score += 20   # bullish stack

    # Momentum
    if ret5 > 2:            tech_score += 15
    if ret20 > 5:           tech_score += 15

    # RSI
    if 40 <= rsi <= 65:     tech_score += 20   # healthy zone
    elif rsi < 30:          tech_score += 30   # oversold = opportunity
    elif rsi > 75:          tech_score -= 20   # overbought

    # MACD
    if macd['cross'] == 'bullish': tech_score += 15
    if macd['histogram'] > 0:      tech_score += 10

    # Volume confirmation
    if vol_r > 1.5:         tech_score += 15
    elif vol_r < 0.5:       tech_score -= 10

    # Bollinger
    if boll['pct_b'] < 20:  tech_score += 10   # near lower band
    if boll['squeeze']:     tech_score += 5    # volatility compression

    # Signal determination
    if tech_score >= 120:   signal = 'STRONG_BUY'
    elif tech_score >= 80:  signal = 'BUY'
    elif tech_score >= 30:  signal = 'HOLD'
    elif tech_score >= -10: signal = 'SELL'
    else:                   signal = 'STRONG_SELL'

    return {
        'code':     code,
        'sector':   HK_WATCHLIST.get(code, {}).get('sector', 'UNKNOWN'),
        'price':    round(price, 3),
        'signal':   signal,
        'tech_score': round(tech_score, 1),
        'indicators': {
            'rsi': rsi, 'macd': macd, 'bollinger': boll,
            'ma5': round(ma5, 3), 'ma10': round(ma10, 3),
            'ma20': round(ma20, 3), 'ma60': round(ma60, 3),
            'ret5d': round(ret5, 2), 'ret20d': round(ret20, 2),
            'vol_ratio': vol_r,
        },
        'entry_price': round(price, 3),
        'target_price': round(price * 1.08, 3),   # +8% target
        'stop_loss':    round(price * 0.95, 3),   # -5% stop
    }


def get_hk_macro() -> Dict:
    """
    Fetch HK macro indicators:
    - HSI trend
    - USD/CNH (yuan pressure)
    - USD/HKD (peg stability)
    - China A50 ETF (mainland sentiment)
    """
    result = {}
    for sym, label in HK_MACRO_PROXIES.items():
        try:
            t = yf.Ticker(sym)
            hist = t.history(period='5d', interval='1d')
            if hist.empty:
                continue
            close_now  = float(hist['Close'].iloc[-1])
            close_prev = float(hist['Close'].iloc[-2]) if len(hist) >= 2 else close_now
            chg_pct = (close_now / close_prev - 1) * 100 if close_prev else 0

            result[sym] = {
                'label':      label,
                'value':      round(close_now, 3),
                'prev':       round(close_prev, 3),
                'change_pct': round(chg_pct, 2),
                'direction':  'UP' if chg_pct > 0.1 else ('DOWN' if chg_pct < -0.1 else 'FLAT'),
            }
        except Exception as e:
            log.debug(f'HK macro {sym}: {e}')

    # Compute HK market regime
    hsi = result.get('^HSI', {})
    cnh = result.get('USDCNH=X', {})
    a50 = result.get('3188.HK', {})

    bullish_signals = sum([
        hsi.get('direction') == 'UP',
        cnh.get('direction') == 'DOWN',   # weaker dollar = good for HK
        a50.get('direction') == 'UP',
    ])

    result['_regime'] = {
        'verdict': 'BULLISH' if bullish_signals >= 2 else ('BEARISH' if bullish_signals == 0 else 'NEUTRAL'),
        'bullish_count': bullish_signals,
        'total_count': 3,
        'score': (bullish_signals - 1) * 7.5,  # -7.5 to +15
    }

    return result


def scan_hk_market(codes=None) -> List[Dict]:
    """
    Scan HK market — analyze all stocks in watchlist.
    Returns sorted signal list.
    """
    if codes is None:
        codes = list(HK_WATCHLIST.keys())

    log.info(f'Scanning {len(codes)} HK stocks...')
    results = []

    for code in codes:
        try:
            analysis = analyze_hk_stock(code)
            if analysis:
                quote = get_hk_quote(code)
                if quote:
                    analysis['change_pct'] = quote['change_pct']
                    analysis['volume']     = quote['volume']
                results.append(analysis)
                log.info(f"  {code} {analysis['signal']:12s} score={analysis['tech_score']:.0f} "
                         f"RSI={analysis['indicators']['rsi']:.1f} P={analysis['price']}")
        except Exception as e:
            log.warning(f'  {code}: {e}')

    # Sort by tech_score descending
    results.sort(key=lambda x: x['tech_score'], reverse=True)
    log.info(f'HK scan done: {len(results)} stocks analyzed')
    return results


if __name__ == '__main__':
    import sys
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')

    cmd = sys.argv[1] if len(sys.argv) > 1 else 'scan'

    if cmd == 'macro':
        macro = get_hk_macro()
        for k, v in macro.items():
            if k.startswith('_'):
                print(f"\nRegime: {v['verdict']} ({v['bullish_count']}/3 bullish)")
            else:
                print(f"  {v['label']:30s} {v['value']:>10.3f} {v['direction']} {v['change_pct']:+.2f}%")

    elif cmd == 'quote':
        code = sys.argv[2] if len(sys.argv) > 2 else '0700'
        q = get_hk_quote(code)
        print(q)

    elif cmd == 'analyze':
        code = sys.argv[2] if len(sys.argv) > 2 else '0700'
        a = analyze_hk_stock(code)
        import json
        print(json.dumps(a, indent=2, default=str))

    else:  # scan
        signals = scan_hk_market()
        print(f"\n{'CODE':6} {'SIGNAL':12} {'SCORE':6} {'RSI':5} {'PRICE':8}")
        print('-' * 45)
        for s in signals:
            print(f"{s['code']:6} {s['signal']:12} {s['tech_score']:6.0f} "
                  f"{s['indicators']['rsi']:5.1f} {s['price']:8.3f}")
