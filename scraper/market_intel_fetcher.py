#!/usr/bin/env python3
"""
market_intel_fetcher.py
Fetches sentiment + macro signals from ai4trade.ai (FREE, no API key)
and Alpha Vantage for US + HK stock news sentiment.
Saves results to ft_sentiment_cache table.

Schedule: Every 15 min during market hours
"""

import os
import pymysql
import requests
import json
import logging
from datetime import datetime, date
from typing import Optional

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('MarketIntel')

DB_CFG = dict(
    host=os.environ.get('DB_HOST', 'localhost'),
    user=os.environ.get('DB_USER', 'erp_user'),
    password=os.environ.get('DB_PASSWORD'),
    database='erp_manufacturing', charset='utf8mb4',
    cursorclass=pymysql.cursors.DictCursor
)

AI4TRADE_BASE = 'https://ai4trade.ai/api'
ALPHA_VANTAGE_KEY = 'demo'   # replace with real key for more quota
ALPHA_VANTAGE_BASE = 'https://www.alphavantage.co/query'

TIMEOUT = 10

# ── Ensure table exists ────────────────────────────────────────
SETUP_SQL = """
CREATE TABLE IF NOT EXISTS ft_sentiment_cache (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    fetched_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source          VARCHAR(50) NOT NULL,
    category        VARCHAR(50) NOT NULL,
    ticker          VARCHAR(20),
    market          VARCHAR(10) DEFAULT 'us',
    sentiment_label VARCHAR(20),
    sentiment_score DECIMAL(5,3),
    headline_count  INT DEFAULT 0,
    top_headline    TEXT,
    raw_summary     TEXT,
    macro_verdict   VARCHAR(20),
    macro_bullish   INT DEFAULT 0,
    macro_total     INT DEFAULT 0,
    extra_json      JSON,
    INDEX idx_ticker (ticker),
    INDEX idx_fetched (fetched_at),
    INDEX idx_source (source)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ft_news_items (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    fetched_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source          VARCHAR(50),
    category        VARCHAR(50),
    ticker          VARCHAR(20),
    title           TEXT,
    summary         TEXT,
    url             TEXT,
    sentiment_label VARCHAR(20),
    time_published  DATETIME,
    INDEX idx_ticker (ticker),
    INDEX idx_category (category),
    INDEX idx_fetched (fetched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
"""


def get_db():
    return pymysql.connect(**DB_CFG)


def setup_tables():
    db = get_db()
    cur = db.cursor()
    for stmt in SETUP_SQL.strip().split(';'):
        s = stmt.strip()
        if s:
            try:
                cur.execute(s)
            except Exception as e:
                if 'already exists' not in str(e).lower():
                    log.warning(f'Setup: {e}')
    db.commit()
    cur.close()
    db.close()
    log.info('Tables ready')


# ── AI4Trade Market Intel ──────────────────────────────────────

def fetch_macro_signals() -> Optional[dict]:
    """Fetch macro regime snapshot from ai4trade.ai"""
    try:
        r = requests.get(f'{AI4TRADE_BASE}/market-intel/macro-signals', timeout=TIMEOUT)
        r.raise_for_status()
        d = r.json()
        if not d.get('available'):
            log.info('Macro signals not available')
            return None
        log.info(f"Macro verdict: {d.get('verdict')} "
                 f"({d.get('bullish_count')}/{d.get('total_count')} bullish)")
        return d
    except Exception as e:
        log.warning(f'fetch_macro_signals: {e}')
        return None


def fetch_news(categories=None) -> list:
    """Fetch grouped financial news from ai4trade.ai"""
    if categories is None:
        categories = ['equities', 'macro', 'commodities']

    all_items = []
    try:
        params = {'limit': 10}
        r = requests.get(f'{AI4TRADE_BASE}/market-intel/news', params=params, timeout=TIMEOUT)
        r.raise_for_status()
        data = r.json()

        for section in data.get('categories', []):
            cat = section.get('category', '')
            if cat not in categories:
                continue
            for item in section.get('items', []):
                all_items.append({
                    'category': cat,
                    'title': item.get('title', ''),
                    'summary': item.get('summary', ''),
                    'url': item.get('url', ''),
                    'sentiment_label': item.get('overall_sentiment_label', 'Neutral'),
                    'source': item.get('source', 'ai4trade'),
                    'time_published': item.get('time_published'),
                })
        log.info(f'AI4Trade news: {len(all_items)} items from {len(categories)} categories')
    except Exception as e:
        log.warning(f'fetch_news: {e}')
    return all_items


def fetch_stock_analysis(symbol: str) -> Optional[dict]:
    """Fetch latest stock analysis snapshot from ai4trade.ai"""
    try:
        r = requests.get(
            f'{AI4TRADE_BASE}/market-intel/stocks/{symbol}/latest',
            timeout=TIMEOUT
        )
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()
    except Exception as e:
        log.debug(f'fetch_stock_analysis({symbol}): {e}')
        return None


def fetch_etf_flows() -> Optional[dict]:
    """Fetch ETF flow snapshot (crypto ETF, useful for risk-on/off signal)"""
    try:
        r = requests.get(f'{AI4TRADE_BASE}/market-intel/etf-flows', timeout=TIMEOUT)
        r.raise_for_status()
        d = r.json()
        if d.get('available'):
            log.info(f"ETF flows: {d.get('summary', '')[:80]}")
        return d if d.get('available') else None
    except Exception as e:
        log.warning(f'fetch_etf_flows: {e}')
        return None


# ── Alpha Vantage News Sentiment ───────────────────────────────

def fetch_alphavantage_news(tickers: list, market='us') -> list:
    """
    Fetch news sentiment from Alpha Vantage.
    Free tier: 25 req/day. Use sparingly — max 5 tickers.
    """
    results = []
    tickers_str = ','.join(tickers[:5])  # limit to 5

    params = {
        'function': 'NEWS_SENTIMENT',
        'tickers': tickers_str,
        'limit': 20,
        'apikey': ALPHA_VANTAGE_KEY,
    }
    try:
        r = requests.get(ALPHA_VANTAGE_BASE, params=params, timeout=TIMEOUT)
        r.raise_for_status()
        data = r.json()

        if 'Information' in data:
            log.warning(f'Alpha Vantage quota: {data["Information"][:80]}')
            return []

        for item in data.get('feed', []):
            for ts in item.get('ticker_sentiment', []):
                ticker = ts.get('ticker', '')
                if not ticker:
                    continue
                results.append({
                    'ticker': ticker,
                    'title': item.get('title', ''),
                    'summary': item.get('summary', '')[:500],
                    'url': item.get('url', ''),
                    'source': item.get('source', 'alpha_vantage'),
                    'sentiment_label': ts.get('ticker_sentiment_label', 'Neutral'),
                    'sentiment_score': float(ts.get('ticker_sentiment_score', 0)),
                    'time_published': item.get('time_published', ''),
                    'category': 'equities',
                })

        log.info(f'Alpha Vantage: {len(results)} sentiment items for {tickers_str}')
    except Exception as e:
        log.warning(f'fetch_alphavantage_news: {e}')

    return results


# ── HK Stock Data via Alpha Vantage ───────────────────────────

def fetch_hk_quote(symbol: str) -> Optional[dict]:
    """
    Fetch HK stock quote from Alpha Vantage.
    HK symbols: append .HKG (e.g., 0700.HKG for Tencent)
    """
    # Convert HK code to Alpha Vantage format
    if not symbol.endswith('.HKG') and not symbol.endswith('.HK'):
        hk_sym = f"{symbol}.HKG"
    else:
        hk_sym = symbol

    params = {
        'function': 'GLOBAL_QUOTE',
        'symbol': hk_sym,
        'apikey': ALPHA_VANTAGE_KEY,
    }
    try:
        r = requests.get(ALPHA_VANTAGE_BASE, params=params, timeout=TIMEOUT)
        r.raise_for_status()
        data = r.json()

        if 'Information' in data:
            log.warning(f'Alpha Vantage HK quota: {data["Information"][:80]}')
            return None

        quote = data.get('Global Quote', {})
        if not quote or not quote.get('05. price'):
            return None

        return {
            'symbol': hk_sym,
            'price': float(quote.get('05. price', 0)),
            'change': float(quote.get('09. change', 0)),
            'change_pct': quote.get('10. change percent', '0%').replace('%', ''),
            'volume': int(quote.get('06. volume', 0)),
            'prev_close': float(quote.get('08. previous close', 0)),
        }
    except Exception as e:
        log.debug(f'fetch_hk_quote({symbol}): {e}')
        return None


def fetch_hk_rsi(symbol: str) -> Optional[float]:
    """Fetch RSI for HK stock via Alpha Vantage"""
    hk_sym = f"{symbol}.HKG" if not symbol.endswith('.HKG') else symbol
    params = {
        'function': 'RSI',
        'symbol': hk_sym,
        'interval': 'daily',
        'time_period': 14,
        'series_type': 'close',
        'apikey': ALPHA_VANTAGE_KEY,
    }
    try:
        r = requests.get(ALPHA_VANTAGE_BASE, params=params, timeout=TIMEOUT)
        data = r.json()
        if 'Information' in data:
            return None
        rsi_data = data.get('Technical Analysis: RSI', {})
        if rsi_data:
            latest = list(rsi_data.values())[0]
            return round(float(latest.get('RSI', 50)), 2)
    except Exception as e:
        log.debug(f'fetch_hk_rsi({symbol}): {e}')
    return None


# ── Sentiment Score Calculator ─────────────────────────────────

def sentiment_to_score(label: str, count: int = 1) -> float:
    """Convert sentiment label to numeric score (-15 to +15)"""
    mapping = {
        'Bullish':       15.0,
        'Somewhat-Bullish': 8.0,
        'Neutral':        0.0,
        'Somewhat-Bearish': -8.0,
        'Bearish':       -15.0,
        'Positive':      10.0,
        'Negative':     -10.0,
    }
    base = mapping.get(label, 0.0)
    # Scale by news volume (more news = stronger signal, max 1.5x)
    multiplier = min(1.0 + (count - 1) * 0.1, 1.5)
    return round(base * multiplier, 2)


def macro_verdict_to_score(verdict: str, bullish: int, total: int) -> float:
    """Convert macro verdict to sentiment score"""
    if not total:
        return 0.0
    ratio = bullish / total
    if verdict == 'BULLISH':
        return round(10.0 + ratio * 5.0, 2)
    elif verdict == 'BEARISH':
        return round(-10.0 - (1 - ratio) * 5.0, 2)
    else:
        return round((ratio - 0.5) * 10.0, 2)


# ── DB Save Functions ──────────────────────────────────────────

def save_macro(db, macro: dict):
    verdict = macro.get('verdict', 'NEUTRAL')
    bullish = macro.get('bullish_count', 0)
    total   = macro.get('total_count', 0)
    score   = macro_verdict_to_score(verdict, bullish, total)

    db.cursor().execute("""
        INSERT INTO ft_sentiment_cache
        (source, category, market, macro_verdict, macro_bullish, macro_total,
         sentiment_score, sentiment_label, top_headline, raw_summary)
        VALUES ('ai4trade', 'macro', 'us', %s, %s, %s, %s, %s, %s, %s)
    """, (
        verdict, bullish, total, score, verdict,
        macro.get('signals', [{}])[0].get('signal', '')[:255] if macro.get('signals') else '',
        json.dumps(macro.get('meta', {}))[:500],
    ))
    log.info(f'  Macro saved: verdict={verdict} score={score}')


def save_news_items(db, items: list, source: str):
    cur = db.cursor()
    for item in items:
        tp = item.get('time_published')
        if tp:
            try:
                tp = datetime.fromisoformat(tp[:19].replace('T', ' '))
            except:
                tp = None

        cur.execute("""
            INSERT INTO ft_news_items
            (source, category, ticker, title, summary, url, sentiment_label, time_published)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """, (
            source,
            item.get('category', 'general'),
            item.get('ticker'),
            item.get('title', '')[:500],
            item.get('summary', '')[:1000],
            item.get('url', '')[:500],
            item.get('sentiment_label', 'Neutral'),
            tp,
        ))
    log.info(f'  Saved {len(items)} news items from {source}')


def save_ticker_sentiment(db, ticker: str, items: list, market='us'):
    if not items:
        return 0.0

    labels = [i.get('sentiment_label', 'Neutral') for i in items]
    scores = [i.get('sentiment_score', 0.0) for i in items if 'sentiment_score' in i]
    avg_score = sum(scores) / len(scores) if scores else sentiment_to_score(labels[0], len(labels))

    # Majority label
    from collections import Counter
    majority_label = Counter(labels).most_common(1)[0][0]

    db.cursor().execute("""
        INSERT INTO ft_sentiment_cache
        (source, category, ticker, market, sentiment_label, sentiment_score,
         headline_count, top_headline)
        VALUES ('alpha_vantage', 'equities', %s, %s, %s, %s, %s, %s)
    """, (
        ticker, market, majority_label, round(avg_score, 3),
        len(items), items[0].get('title', '')[:255]
    ))
    return avg_score


# ── Public API: get_sentiment_score ───────────────────────────

def get_sentiment_score(ticker: str, market: str = 'us', db=None) -> float:
    """
    Get latest cached sentiment score for a ticker.
    Returns score in range -15 to +15.
    Called by signal_engine.py during scoring.
    """
    close_db = False
    if db is None:
        db = get_db()
        close_db = True
    try:
        cur = db.cursor()
        cur.execute("""
            SELECT sentiment_score, macro_verdict
            FROM ft_sentiment_cache
            WHERE (ticker = %s OR (ticker IS NULL AND category = 'macro'))
              AND fetched_at >= NOW() - INTERVAL 4 HOUR
            ORDER BY fetched_at DESC LIMIT 5
        """, (ticker,))
        rows = cur.fetchall()
        if not rows:
            return 0.0
        scores = [float(r['sentiment_score'] or 0) for r in rows if r['sentiment_score']]
        return round(sum(scores) / len(scores), 2) if scores else 0.0
    finally:
        if close_db:
            db.close()


def get_macro_sentiment_score(db=None) -> dict:
    """
    Returns macro sentiment by sector.
    Used by signal_engine to boost sector-specific scores.
    """
    close_db = False
    if db is None:
        db = get_db()
        close_db = True
    try:
        cur = db.cursor()
        cur.execute("""
            SELECT macro_verdict, macro_bullish, macro_total, sentiment_score
            FROM ft_sentiment_cache
            WHERE source = 'ai4trade' AND category = 'macro'
              AND fetched_at >= NOW() - INTERVAL 4 HOUR
            ORDER BY fetched_at DESC LIMIT 1
        """)
        row = cur.fetchone()
        if not row:
            return {'verdict': 'NEUTRAL', 'score': 0.0, 'bullish_pct': 50.0}
        total = row['macro_total'] or 1
        return {
            'verdict': row['macro_verdict'] or 'NEUTRAL',
            'score': float(row['sentiment_score'] or 0),
            'bullish_pct': round(row['macro_bullish'] / total * 100, 1),
        }
    finally:
        if close_db:
            db.close()


# ── Main Runner ────────────────────────────────────────────────

def run(market='us', tickers=None):
    log.info('=== Market Intel Fetcher Starting ===')
    setup_tables()
    db = get_db()

    try:
        # 1. Macro regime from ai4trade
        log.info('Fetching macro signals from ai4trade...')
        macro = fetch_macro_signals()
        if macro:
            save_macro(db, macro)

        # 2. News from ai4trade (free, no auth)
        log.info('Fetching news from ai4trade...')
        news = fetch_news()
        if news:
            save_news_items(db, news, 'ai4trade')

        # 3. ETF flows (risk-on/off indicator)
        log.info('Fetching ETF flows...')
        etf = fetch_etf_flows()
        if etf:
            etf_score = 5.0 if 'inflow' in str(etf.get('summary', '')).lower() else -3.0
            db.cursor().execute("""
                INSERT INTO ft_sentiment_cache
                (source, category, market, sentiment_score, sentiment_label,
                 top_headline, headline_count)
                VALUES ('ai4trade', 'etf_flow', 'us', %s, %s, %s, 1)
            """, (etf_score, 'Bullish' if etf_score > 0 else 'Bearish',
                  str(etf.get('summary', ''))[:255]))

        # 4. Alpha Vantage ticker sentiment
        if tickers:
            log.info(f'Fetching Alpha Vantage sentiment for {tickers[:5]}...')
            av_items = fetch_alphavantage_news(tickers[:5], market)
            if av_items:
                save_news_items(db, av_items, 'alpha_vantage')
                # Aggregate per ticker
                from itertools import groupby
                av_items.sort(key=lambda x: x.get('ticker', ''))
                for ticker, group in groupby(av_items, key=lambda x: x.get('ticker', '')):
                    if ticker:
                        save_ticker_sentiment(db, ticker, list(group), market)

        db.commit()
        log.info('=== Market Intel Fetcher Done ===')

        # Print summary
        macro_status = get_macro_sentiment_score(db)
        log.info(f"Macro: {macro_status['verdict']} "
                 f"({macro_status['bullish_pct']}% bullish, score={macro_status['score']})")

    except Exception as e:
        log.error(f'Run error: {e}')
        import traceback; traceback.print_exc()
    finally:
        db.close()


if __name__ == '__main__':
    import sys
    market = sys.argv[1] if len(sys.argv) > 1 else 'us'

    # Default tickers to get sentiment for
    US_TICKERS  = ['MSTR', 'NVDA', 'MSFT', 'AAPL', 'PLTR']
    HK_TICKERS  = ['0700', '0005', '9988', '0941', '1299']  # Tencent, HSBC, Alibaba, CM, AIA

    tickers = US_TICKERS if market == 'us' else HK_TICKERS
    run(market=market, tickers=tickers)
