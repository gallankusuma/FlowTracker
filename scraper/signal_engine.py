#!/usr/bin/env python3
"""
FlowTracker Signal Engine v1.0
Multi-layer: Bandarmology + Technical + Macro + Sentiment + Seasonality
"""

import json
import math
import logging
from datetime import date, datetime, timedelta
from typing import Optional

import pymysql
import sys, os
sys.path.insert(0, os.path.dirname(__file__))

# Market Intel integration (ai4trade + Alpha Vantage sentiment)
try:
    from market_intel_fetcher import get_sentiment_score, get_macro_sentiment_score
    HAS_MARKET_INTEL = True
except ImportError:
    HAS_MARKET_INTEL = False
    def get_sentiment_score(ticker, market='us', db=None): return 0.0
    def get_macro_sentiment_score(db=None): return {'score': 0.0, 'verdict': 'NEUTRAL', 'bullish_pct': 50.0}

# HK market support
try:
    from hk_fetcher import scan_hk_market, get_hk_macro, HK_WATCHLIST
    HAS_HK = True
except ImportError:
    HAS_HK = False
import yfinance as yf
import pandas as pd
import numpy as np
import requests

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('SignalEngine')

class NumpyEncoder(json.JSONEncoder):
    """Handle numpy scalar types for json.dumps."""
    def default(self, obj):
        if isinstance(obj, np.bool_): return bool(obj)
        if isinstance(obj, np.integer): return int(obj)
        if isinstance(obj, np.floating): return float(obj)
        if isinstance(obj, np.ndarray): return obj.tolist()
        return super().default(obj)

# ── DB Config ──────────────────────────────────────────────────────────
import env_loader
env_loader.load_env()

DB_CFG = dict(host=os.environ.get('DB_HOST', 'localhost'),
              user=os.environ.get('DB_USER', 'erp_user'),
              password=env_loader.require('DB_PASSWORD'),
              database='erp_manufacturing',
              charset='utf8mb4', cursorclass=pymysql.cursors.DictCursor)

def get_db():
    return pymysql.connect(**DB_CFG)

# ══════════════════════════════════════════════════════════════════════
# LAYER 1: TECHNICAL ANALYSIS
# ══════════════════════════════════════════════════════════════════════

class TechnicalEngine:
    """Compute all technical indicators from OHLCV data."""

    def __init__(self, ticker: str, market: str = 'us'):
        self.ticker = ticker
        self.market  = market
        self.yf_ticker = ticker if market == 'us' else f"{ticker}.JK"
        self.df: Optional[pd.DataFrame] = None

    def fetch(self, period: str = '6mo') -> bool:
        try:
            t = yf.Ticker(self.yf_ticker)
            df = t.history(period=period)
            if df.empty or len(df) < 30:
                return False
            df.index = pd.to_datetime(df.index).tz_localize(None)
            self.df = df
            return True
        except Exception as e:
            log.warning(f"[TECH] fetch failed {self.ticker}: {e}")
            return False

    def rsi(self, period: int = 14) -> Optional[float]:
        if self.df is None or len(self.df) < period + 1:
            return None
        close = self.df['Close']
        delta = close.diff()
        gain  = delta.where(delta > 0, 0).rolling(period).mean()
        loss  = (-delta.where(delta < 0, 0)).rolling(period).mean()
        rs    = gain / loss.replace(0, np.nan)
        rsi   = 100 - (100 / (1 + rs))
        val   = rsi.iloc[-1]
        return round(float(val), 2) if not math.isnan(val) else None

    def macd(self, fast: int = 12, slow: int = 26, signal: int = 9) -> dict:
        if self.df is None: return {}
        close    = self.df['Close']
        ema_fast = close.ewm(span=fast, adjust=False).mean()
        ema_slow = close.ewm(span=slow, adjust=False).mean()
        macd_line   = ema_fast - ema_slow
        signal_line = macd_line.ewm(span=signal, adjust=False).mean()
        histogram   = macd_line - signal_line
        # Detect crossover (today MACD > Signal, yesterday MACD < Signal)
        crossed_up   = (macd_line.iloc[-1] > signal_line.iloc[-1] and
                        macd_line.iloc[-2] <= signal_line.iloc[-2])
        crossed_down = (macd_line.iloc[-1] < signal_line.iloc[-1] and
                        macd_line.iloc[-2] >= signal_line.iloc[-2])
        return {
            'macd':        round(float(macd_line.iloc[-1]), 4),
            'signal':      round(float(signal_line.iloc[-1]), 4),
            'histogram':   round(float(histogram.iloc[-1]), 4),
            'crossed_up':  bool(crossed_up),
            'crossed_down': bool(crossed_down),
            'above_signal': bool(macd_line.iloc[-1] > signal_line.iloc[-1]),
        }

    def sma(self, period: int) -> Optional[float]:
        if self.df is None or len(self.df) < period: return None
        val = self.df['Close'].rolling(period).mean().iloc[-1]
        return round(float(val), 4) if not math.isnan(val) else None

    def ema(self, period: int) -> Optional[float]:
        if self.df is None or len(self.df) < period: return None
        val = self.df['Close'].ewm(span=period, adjust=False).mean().iloc[-1]
        return round(float(val), 4) if not math.isnan(val) else None

    def volume_ratio(self, period: int = 20) -> Optional[float]:
        if self.df is None or len(self.df) < period + 1: return None
        today_vol = self.df['Volume'].iloc[-1]
        avg_vol   = self.df['Volume'].iloc[-period-1:-1].mean()
        if avg_vol == 0: return None
        return round(float(today_vol / avg_vol), 2)

    def bollinger(self, period: int = 20, std: float = 2.0) -> dict:
        if self.df is None or len(self.df) < period: return {}
        close  = self.df['Close']
        mid    = close.rolling(period).mean()
        upper  = mid + std * close.rolling(period).std()
        lower  = mid - std * close.rolling(period).std()
        price  = close.iloc[-1]
        bw     = (upper.iloc[-1] - lower.iloc[-1]) / mid.iloc[-1]  # bandwidth
        pct_b  = (price - lower.iloc[-1]) / (upper.iloc[-1] - lower.iloc[-1])
        # Squeeze: bandwidth < 10th percentile of last 50 days
        bw_series = (upper - lower) / mid
        squeeze   = bw < bw_series.iloc[-50:].quantile(0.10) if len(self.df) >= 50 else False
        return {
            'upper':          round(float(upper.iloc[-1]), 4),
            'mid':            round(float(mid.iloc[-1]), 4),
            'lower':          round(float(lower.iloc[-1]), 4),
            'pct_b':          round(float(pct_b), 4),
            'bandwidth':      round(float(bw), 4),
            'squeeze':        bool(squeeze),
            'price_above_mid': bool(price > mid.iloc[-1]),
            'near_upper':     bool(pct_b > 0.8),
            'near_lower':     bool(pct_b < 0.2),
        }

    def golden_cross(self) -> dict:
        """SMA50 vs SMA200"""
        if self.df is None or len(self.df) < 201: return {}
        sma50  = self.df['Close'].rolling(50).mean()
        sma200 = self.df['Close'].rolling(200).mean()
        golden = (sma50.iloc[-1] > sma200.iloc[-1] and
                  sma50.iloc[-2] <= sma200.iloc[-2])
        death  = (sma50.iloc[-1] < sma200.iloc[-1] and
                  sma50.iloc[-2] >= sma200.iloc[-2])
        return {
            'sma50':        round(float(sma50.iloc[-1]), 4),
            'sma200':       round(float(sma200.iloc[-1]), 4),
            'above_200':    bool(sma50.iloc[-1] > sma200.iloc[-1]),
            'golden_cross': bool(golden),
            'death_cross':  bool(death),
        }

    def price_vs_sma(self, period: int = 50) -> Optional[float]:
        """Returns % difference: positive = price above SMA"""
        s = self.sma(period)
        if s is None: return None
        price = float(self.df['Close'].iloc[-1])
        return round((price - s) / s * 100, 2)

    def current_price(self) -> Optional[float]:
        if self.df is None: return None
        return round(float(self.df['Close'].iloc[-1]), 4)

    def compute_all(self) -> dict:
        return {
            'rsi_14':        self.rsi(14),
            'rsi_9':         self.rsi(9),
            'macd':          self.macd(),
            'sma20':         self.sma(20),
            'sma50':         self.sma(50),
            'sma200':        self.sma(200),
            'ema21':         self.ema(21),
            'volume_ratio20': self.volume_ratio(20),
            'volume_ratio5':  self.volume_ratio(5),
            'bollinger':      self.bollinger(),
            'golden_cross':   self.golden_cross(),
            'price_vs_sma50': self.price_vs_sma(50),
            'price_vs_sma200': self.price_vs_sma(200),
            'price':          self.current_price(),
        }

# ══════════════════════════════════════════════════════════════════════
# LAYER 2: BANDARMOLOGY (IDX only - from FlowTracker DB)
# ══════════════════════════════════════════════════════════════════════

class BandarmologyEngine:
    """Fetch broker flow data from existing FlowTracker tables."""

    def __init__(self, ticker: str, db_conn):
        self.ticker = ticker
        self.conn   = db_conn

    def get_flow(self, days: int = 10) -> dict:
        cur = self.conn.cursor()
        since = (date.today() - timedelta(days=days*2)).isoformat()

        # Load broker categories from CMS
        cur.execute("SELECT code, category FROM ft_broker_config WHERE active = 1")
        cats = {r['code']: r['category'] for r in cur.fetchall()}
        foreign_set   = {k for k, v in cats.items() if v == 'FOREIGN'}
        bigmoney_set  = {k for k, v in cats.items() if v == 'BIG_MONEY'}

        # Fetch broker summary
        cur.execute("""
            SELECT date, broker_code,
                   SUM(buy_vol - sell_vol) as net_lot,
                   SUM(buy_val - sell_val) as net_val
            FROM idx_broker_summary
            WHERE stock_code = %s AND date >= %s
            GROUP BY date, broker_code
            ORDER BY date DESC
        """, (self.ticker, since))
        rows = cur.fetchall()

        if not rows:
            return {}

        # Aggregate by date
        by_date = {}
        for r in rows:
            d = str(r['date'])
            if d not in by_date:
                by_date[d] = {'foreign': 0, 'bigmoney': 0, 'retail': 0}
            bk  = r['broker_code']
            val = float(r['net_val'] or 0)
            if bk in foreign_set:
                by_date[d]['foreign']  += val
            elif bk in bigmoney_set:
                by_date[d]['bigmoney'] += val
            else:
                by_date[d]['retail']   += val

        sorted_dates = sorted(by_date.keys(), reverse=True)[:days]

        # Accumulation streak: how many consecutive days both foreign + bigmoney positive
        streak = 0
        for d in sorted_dates:
            day = by_date[d]
            if day['foreign'] > 0 and day['bigmoney'] > 0:
                streak += 1
            else:
                break

        latest = by_date[sorted_dates[0]] if sorted_dates else {}
        recent = [by_date[d] for d in sorted_dates[:5]]

        return {
            'foreign_net_today':   latest.get('foreign', 0),
            'bigmoney_net_today':  latest.get('bigmoney', 0),
            'retail_net_today':    latest.get('retail', 0),
            'foreign_net_5d':      sum(d['foreign']  for d in recent),
            'bigmoney_net_5d':     sum(d['bigmoney'] for d in recent),
            'accum_streak':        streak,
            'days_available':      len(sorted_dates),
        }

# ══════════════════════════════════════════════════════════════════════
# LAYER 3: MACRO
# ══════════════════════════════════════════════════════════════════════

class MacroEngine:
    """Fetch macro indicators from DB (pre-fetched by macro_fetcher.py)."""

    def __init__(self, db_conn):
        self.conn = db_conn

    def get_latest(self, indicator: str) -> Optional[dict]:
        cur = self.conn.cursor()
        cur.execute("""
            SELECT value, previous_value, direction
            FROM ft_macro_data
            WHERE indicator = %s
            ORDER BY date DESC LIMIT 1
        """, (indicator,))
        return cur.fetchone()

    def get_context(self, sector: str) -> dict:
        """Get macro factors relevant for this sector."""
        result = {'score': 0, 'factors': []}

        SECTOR_MAP = {
            'FINTECH': ['FED_RATE', 'YIELD_CURVE', 'VIX'],
            'ENERGY':  ['WTI', 'NATURAL_GAS'],
            'MINING':  ['GOLD', 'COPPER', 'DXY'],
            'TECH':    ['YIELD_10Y', 'VIX', 'DXY'],
            'INDUSTRIAL': ['PMI', 'COPPER'],
            'CONSUMER':   ['CPI', 'UNEMPLOYMENT'],
            'ETF':     ['VIX', 'YIELD_10Y'],
        }

        indicators = SECTOR_MAP.get(sector, ['VIX'])
        score = 0

        for ind in indicators:
            data = self.get_latest(ind)
            if not data:
                continue
            val = float(data['value'] or 0)
            direction = data['direction']

            # Scoring rules
            if ind == 'FED_RATE':
                s = 10 if direction == 'DOWN' else (-10 if direction == 'UP' else 0)
            elif ind == 'YIELD_CURVE':
                s = 7 if val > 0 else -7
            elif ind == 'VIX':
                s = 8 if val < 15 else (5 if val < 20 else (-5 if val < 30 else -12))
            elif ind == 'WTI':
                s = 8 if direction == 'UP' else -5
            elif ind == 'GOLD':
                s = 8 if direction == 'UP' else 0
            elif ind == 'COPPER':
                s = 6 if direction == 'UP' else -4
            elif ind == 'DXY':
                s = -5 if direction == 'UP' else 5  # weak dollar = bullish commodities
            elif ind == 'PMI':
                s = 8 if val > 52 else (3 if val > 50 else -8)
            elif ind == 'CPI':
                s = -6 if val > 3.5 else 0  # high inflation = bearish consumer
            elif ind == 'YIELD_10Y':
                s = -8 if direction == 'UP' else 5  # rising yields = bearish tech
            else:
                s = 0

            score += s
            result['factors'].append({'indicator': ind, 'value': val,
                                       'direction': direction, 'score': s})

        result['score'] = max(-20, min(20, score))
        return result

# ══════════════════════════════════════════════════════════════════════
# LAYER 4: SEASONALITY
# ══════════════════════════════════════════════════════════════════════

class SeasonalityEngine:
    """Calendar-based scoring: events, day-of-week, sector cycles."""

    def __init__(self, db_conn):
        self.conn = db_conn

    def get_score(self, eval_date: date, sector: str = 'ALL') -> dict:
        cur = self.conn.cursor()
        score = 0
        notes = []

        # 1. DB calendar events
        cur.execute("""
            SELECT event_type, score_adjustment, description
            FROM ft_seasonality_calendar
            WHERE event_date = %s AND (applies_to = 'ALL' OR applies_to = %s)
        """, (eval_date, sector))
        for ev in cur.fetchall():
            score += float(ev['score_adjustment'])
            notes.append(f"{ev['event_type']}: {ev['score_adjustment']:+.0f} ({ev['description']})")

        # 2. Day of week
        dow = eval_date.weekday()  # 0=Mon, 4=Fri
        if dow == 0:    # Monday
            score -= 3; notes.append("Monday effect: -3")
        elif dow in (1, 2):  # Tue/Wed
            score += 3; notes.append(f"{'Tue' if dow==1 else 'Wed'} strength: +3")
        elif dow == 4:  # Friday
            score -= 3; notes.append("Friday drift: -3")

        # 3. Month effects
        month = eval_date.month
        if month == 9:
            score -= 5; notes.append("September effect: -5")
        elif month == 10:
            score += 3; notes.append("Q4 start: +3")
        elif month in (11, 12):
            score += 5; notes.append("Q4 strength: +5")
        elif month == 1 and eval_date.day <= 15:
            score += 5; notes.append("January effect: +5")
        elif month in (5, 6, 7, 8):
            score -= 3; notes.append("Sell in May period: -3")

        # 4. Sector seasonality
        if sector == 'ENERGY' and month in (7, 8, 9):
            score += 8; notes.append("Energy Q3 summer: +8")
        elif sector == 'CONSUMER' and month in (11, 12):
            score += 10; notes.append("Holiday season consumer: +10")
        elif sector == 'ENERGY' and month in (10, 11, 12):
            score += 6; notes.append("Energy winter heating: +6")

        return {
            'score':  max(-15, min(15, score)),
            'notes':  '; '.join(notes) or 'No special events',
            'dow':    dow,
            'month':  month,
        }

# ══════════════════════════════════════════════════════════════════════
# STEP ENGINE — evaluate strategy steps against data
# ══════════════════════════════════════════════════════════════════════

class StepEngine:
    """Evaluate strategy step conditions and compute final score."""

    def evaluate_condition(self, step: dict, data: dict) -> bool:
        indicator = step['indicator']
        operator  = step['operator']
        value_a   = step.get('value_a')
        value_b   = step.get('value_b')
        params    = step.get('params') or {}

        if isinstance(params, str):
            try: params = json.loads(params)
            except: params = {}

        # Resolve actual value from data
        actual = self._resolve(indicator, data, params)
        if actual is None:
            return False  # No data = condition fails

        # Type coerce
        try:
            if operator in ('<', '>', '>=', '<=', '=', '!='):
                # Try numeric comparison first
                try:
                    v = float(value_a)
                    actual_f = float(actual)
                    return self._compare(actual_f, operator, v)
                except (ValueError, TypeError):
                    # String comparison
                    return self._compare(str(actual), operator, str(value_a))
            elif operator == 'crosses_up':
                return bool(actual) if isinstance(actual, bool) else False
            elif operator == 'crosses_down':
                return bool(actual) if isinstance(actual, bool) else False
            elif operator == 'between':
                return float(value_a) <= float(actual) <= float(value_b)
        except Exception as e:
            log.debug(f"Condition eval error {indicator}: {e}")
            return False

    def _compare(self, a, op, b):
        if op == '<':  return a < b
        if op == '>':  return a > b
        if op == '>=': return a >= b
        if op == '<=': return a <= b
        if op == '=':  return a == b
        if op == '!=': return a != b
        return False

    def _resolve(self, indicator: str, data: dict, params: dict):
        """Map indicator name → actual computed value."""
        tech  = data.get('technical', {})
        bando = data.get('bandarmology', {})
        macro_data = data.get('macro', {})
        season = data.get('seasonality', {})

        MAP = {
            # Technical
            'RSI':            tech.get('rsi_14'),
            'RSI_9':          tech.get('rsi_9'),
            'VOLUME_RATIO':   tech.get('volume_ratio20'),
            'VOLUME_RATIO5':  tech.get('volume_ratio5'),
            'MACD_ABOVE':     tech.get('macd', {}).get('above_signal'),
            'MACD_CROSSED_UP': tech.get('macd', {}).get('crossed_up'),
            'GOLDEN_CROSS':   tech.get('golden_cross', {}).get('golden_cross'),
            'DEATH_CROSS':    tech.get('golden_cross', {}).get('death_cross'),
            'ABOVE_SMA200':   tech.get('golden_cross', {}).get('above_200'),
            'PRICE_VS_SMA':   tech.get('price_vs_sma50'),
            'BB_SQUEEZE':     tech.get('bollinger', {}).get('squeeze'),
            'BB_PCT_B':       tech.get('bollinger', {}).get('pct_b'),
            'PRICE':          tech.get('price'),

            # Bandarmology
            'FOREIGN_NET':    bando.get('foreign_net_today'),
            'BIGMONEY_NET':   bando.get('bigmoney_net_today'),
            'FOREIGN_NET_5D': bando.get('foreign_net_5d'),
            'BIGMONEY_NET_5D': bando.get('bigmoney_net_5d'),
            'ACCUM_STREAK':   bando.get('accum_streak'),

            # Macro
            'VIX':            self._get_macro_val(macro_data, 'VIX'),
            'FED_RATE_DIRECTION': self._get_macro_dir(macro_data, 'FED_RATE'),
            'WTI':            self._get_macro_val(macro_data, 'WTI'),
            'GOLD':           self._get_macro_val(macro_data, 'GOLD'),
            'PMI':            self._get_macro_val(macro_data, 'PMI'),
            'YIELD_CURVE':    self._get_macro_val(macro_data, 'YIELD_CURVE'),

            # Seasonality
            'FOMC_WEEK':      1 if 'FOMC' in season.get('notes', '') else 0,
            'DAY_OF_WEEK':    season.get('dow', -1),
            'MONTH':          season.get('month', -1),
        }
        return MAP.get(indicator)

    def _get_macro_val(self, macro_data, ind):
        for f in macro_data.get('factors', []):
            if f['indicator'] == ind:
                return f['value']
        return None

    def _get_macro_dir(self, macro_data, ind):
        for f in macro_data.get('factors', []):
            if f['indicator'] == ind:
                return f['direction']
        return None

    def run_strategy(self, strategy_code: str, ticker: str, data: dict,
                     steps: list, thresholds: list) -> dict:
        total_score = 0
        step_results = []

        for step in sorted(steps, key=lambda s: s['step_order']):
            if not step.get('active', 1):
                continue

            passed = self.evaluate_condition(step, data)
            score  = float(step['score_true']) if passed else float(step['score_false'])
            total_score += score

            step_results.append({
                'step':      step['step_order'],
                'label':     step['label'],
                'layer':     step['layer'],
                'indicator': step['indicator'],
                'passed':    passed,
                'score':     score,
            })

            # Hard filter: if fails, skip this ticker entirely
            if step.get('is_filter') and not passed:
                return {
                    'signal': 'SKIP',
                    'final_score': total_score,
                    'step_details': step_results,
                    'filtered_at': step['label'],
                }

        # Determine signal from thresholds
        signal = 'HOLD'
        thresh_map = {t['signal']: float(t['min_score']) for t in thresholds}
        if total_score >= thresh_map.get('STRONG_BUY', 90):
            signal = 'STRONG_BUY'
        elif total_score >= thresh_map.get('BUY', 60):
            signal = 'BUY'
        elif total_score <= thresh_map.get('STRONG_SELL', 10):
            signal = 'STRONG_SELL'
        elif total_score <= thresh_map.get('SELL', 25):
            signal = 'SELL'

        return {
            'signal':      signal,
            'final_score': round(total_score, 2),
            'step_details': step_results,
        }

# ══════════════════════════════════════════════════════════════════════
# MAIN ENGINE — orchestrate all layers
# ══════════════════════════════════════════════════════════════════════

class SignalEngine:

    def __init__(self):
        self.step_engine = StepEngine()
        log.info("SignalEngine initialized")

    def run(self, tickers: list = None, market: str = 'us',
            strategy_codes: list = None, save_to_db: bool = True):
        conn = get_db()
        cur  = conn.cursor()

        # Load active strategies
        if strategy_codes:
            ph = ','.join(['%s'] * len(strategy_codes))
            cur.execute(f"SELECT * FROM ft_strategies WHERE code IN ({ph}) AND active=1",
                        strategy_codes)
        else:
            cur.execute("SELECT * FROM ft_strategies WHERE active=1 AND market IN (%s,'both')", (market,))
        strategies = cur.fetchall()

        if not strategies:
            log.warning("No active strategies found")
            conn.close()
            return []

        # Load steps and thresholds for all strategies
        strat_steps = {}
        strat_thresholds = {}
        for s in strategies:
            code = s['code']
            cur.execute("SELECT * FROM ft_strategy_steps WHERE strategy_code=%s AND active=1 ORDER BY step_order", (code,))
            strat_steps[code] = cur.fetchall()
            cur.execute("SELECT * FROM ft_strategy_thresholds WHERE strategy_code=%s", (code,))
            strat_thresholds[code] = cur.fetchall()

        # Load tickers if not provided
        if not tickers:
            cur.execute("SELECT ticker FROM ft_ticker_sectors WHERE market=%s AND active=1", (market,))
            tickers = [r['ticker'] for r in cur.fetchall()]

        log.info(f"Running {len(strategies)} strategies on {len(tickers)} tickers [{market}]")

        results = []
        signal_date = date.today()
        macro_eng = MacroEngine(conn)
        season_eng = SeasonalityEngine(conn)

        for ticker in tickers:
            log.info(f"  → {ticker}")

            # Fetch technical data
            tech_eng = TechnicalEngine(ticker, market)
            if not tech_eng.fetch():
                log.warning(f"    No data for {ticker}")
                continue

            tech_data = tech_eng.compute_all()
            current_price = tech_data.get('price')

            # Get sector
            cur.execute("SELECT sector FROM ft_ticker_sectors WHERE ticker=%s", (ticker,))
            sec_row = cur.fetchone()
            sector = sec_row['sector'] if sec_row else 'UNKNOWN'

            # Bandarmology (IDX only)
            bando_data = {}
            if market == 'idx':
                bando_eng = BandarmologyEngine(ticker, conn)
                bando_data = bando_eng.get_flow()

            # Macro context
            macro_data = macro_eng.get_context(sector)

            # Seasonality
            season_data = season_eng.get_score(signal_date, sector)

            # Combined data for step evaluation
            data = {
                'technical':    tech_data,
                'bandarmology': bando_data,
                'macro':        macro_data,
                'seasonality':  season_data,
            }

            # Run each strategy
            for strat in strategies:
                code  = strat['code']
                steps = strat_steps.get(code, [])
                thresholds = strat_thresholds.get(code, [])

                if not steps:
                    continue

                result = self.step_engine.run_strategy(code, ticker, data, steps, thresholds)

                if result['signal'] == 'SKIP':
                    continue

                # Layer scores breakdown
                tech_score   = sum(r['score'] for r in result['step_details']
                                   if r['layer'] == 'TECHNICAL')
                bando_score  = sum(r['score'] for r in result['step_details']
                                   if r['layer'] == 'BANDARMOLOGY')
                macro_score  = macro_data['score'] if result['signal'] not in ('SKIP',) else 0
                season_score = season_data['score']

                signal_row = {
                    'signal_date':        signal_date,
                    'ticker':             ticker,
                    'market':             market,
                    'sector':             sector,
                    'strategy_code':      code,
                    'tech_score':         tech_score,
                    'macro_score':        macro_score,
                    'sentiment_score':    round(get_sentiment_score(ticker, market) * 0.6 + get_macro_sentiment_score().get(" score, 0) * 0.4, 2) if HAS_MARKET_INTEL else 0,
                    'seasonality_score':  season_score,
                    'bandarmology_score': bando_score,
                    'final_score':        result['final_score'],
                    'signal':             result['signal'],
                    'entry_price':        current_price,
                    'indicators':         json.dumps({
                        'rsi':            tech_data.get('rsi_14'),
                        'volume_ratio':   tech_data.get('volume_ratio20'),
                        'macd_above':     tech_data.get('macd', {}).get('above_signal'),
                        'price_vs_sma50': tech_data.get('price_vs_sma50'),
                        'golden_cross':   tech_data.get('golden_cross', {}).get('above_200'),
                    }, cls=NumpyEncoder),
                    'macro_factors':      json.dumps(macro_data.get('factors', []), cls=NumpyEncoder),
                    'seasonality_notes':  season_data.get('notes', ''),
                    'step_details':       json.dumps(result['step_details'], cls=NumpyEncoder),
                }
                results.append(signal_row)

                if save_to_db:
                    try:
                        cur.execute("""
                            INSERT INTO ft_signals
                            (signal_date, ticker, market, sector, strategy_code,
                             tech_score, macro_score, sentiment_score, seasonality_score,
                             bandarmology_score, final_score, `signal`, entry_price,
                             indicators, macro_factors, seasonality_notes, step_details)
                            VALUES (%(signal_date)s, %(ticker)s, %(market)s, %(sector)s,
                                    %(strategy_code)s, %(tech_score)s, %(macro_score)s,
                                    %(sentiment_score)s, %(seasonality_score)s,
                                    %(bandarmology_score)s, %(final_score)s, %(signal)s,
                                    %(entry_price)s, %(indicators)s, %(macro_factors)s,
                                    %(seasonality_notes)s, %(step_details)s)
                            ON DUPLICATE KEY UPDATE
                              final_score=VALUES(final_score), `signal`=VALUES(`signal`),
                              tech_score=VALUES(tech_score), macro_score=VALUES(macro_score),
                              seasonality_score=VALUES(seasonality_score),
                              bandarmology_score=VALUES(bandarmology_score),
                              step_details=VALUES(step_details)
                        """, signal_row)
                        conn.commit()
                    except Exception as e:
                        log.error(f"DB insert error {ticker}/{code}: {e}")
                        conn.rollback()

                sig_emoji = {'STRONG_BUY': '🟢🟢', 'BUY': '🟢',
                             'HOLD': '⬜', 'SELL': '🔴', 'STRONG_SELL': '🔴🔴'}.get(result['signal'], '?')
                log.info(f"    [{code}] {sig_emoji} {result['signal']} score={result['final_score']:.1f}")

        conn.close()

        # Summary
        buys = [r for r in results if r['signal'] in ('BUY', 'STRONG_BUY')]
        log.info(f"\n{'='*50}")
        log.info(f"DONE: {len(results)} signals | {len(buys)} BUY signals")
        for r in sorted(buys, key=lambda x: -x['final_score'])[:10]:
            log.info(f"  {r['signal']:12s} {r['ticker']:6s} score={r['final_score']:5.1f} [{r['strategy_code']}]")
        return results


# ══════════════════════════════════════════════════════════════════════
# RESULT TRACKER — update win/loss next morning
# ══════════════════════════════════════════════════════════════════════

class ResultTracker:
    """Morning job: fetch yesterday's prices and mark win/loss."""

    def run(self):
        conn = get_db()
        cur  = conn.cursor()

        yesterday = (date.today() - timedelta(days=1)).isoformat()
        # Allow weekends — find last trading day
        for offset in range(1, 6):
            check_date = (date.today() - timedelta(days=offset)).isoformat()
            cur.execute("SELECT COUNT(*) as cnt FROM ft_signals WHERE signal_date=%s AND win IS NULL", (check_date,))
            if cur.fetchone()['cnt'] > 0:
                yesterday = check_date
                break

        cur.execute("""
            SELECT id, ticker, market, entry_price
            FROM ft_signals
            WHERE signal_date=%s AND win IS NULL AND signal IN ('BUY','STRONG_BUY')
        """, (yesterday,))
        pending = cur.fetchall()
        log.info(f"ResultTracker: {len(pending)} signals to evaluate for {yesterday}")

        updated = 0
        for row in pending:
            ticker   = row['ticker']
            market   = row['market']
            entry    = float(row['entry_price'] or 0)
            if entry <= 0:
                continue

            yf_sym = ticker if market == 'us' else f"{ticker}.JK"
            try:
                t    = yf.Ticker(yf_sym)
                hist = t.history(period='5d')
                if hist.empty:
                    continue
                exit_price = float(hist['Close'].iloc[-1])
                pnl_pct    = (exit_price - entry) / entry * 100
                win        = 1 if pnl_pct > 0 else 0

                cur.execute("""
                    UPDATE ft_signals
                    SET win=%s, exit_price=%s, exit_date=%s, pnl_pct=%s
                    WHERE id=%s
                """, (win, exit_price, date.today(), round(pnl_pct, 4), row['id']))
                updated += 1
            except Exception as e:
                log.warning(f"ResultTracker error {ticker}: {e}")

        conn.commit()

        # Update strategy stats
        cur.execute("SELECT DISTINCT strategy_code FROM ft_signals WHERE signal_date=%s", (yesterday,))
        codes = [r['strategy_code'] for r in cur.fetchall()]
        for code in codes:
            cur.execute("""
                SELECT
                  COUNT(*) as total,
                  SUM(CASE WHEN win=1 THEN 1 ELSE 0 END) as wins,
                  SUM(CASE WHEN win=0 THEN 1 ELSE 0 END) as losses,
                  SUM(CASE WHEN win IS NULL THEN 1 ELSE 0 END) as pending,
                  AVG(CASE WHEN win IS NOT NULL THEN pnl_pct END) as avg_pnl
                FROM ft_signals WHERE strategy_code=%s AND signal IN ('BUY','STRONG_BUY')
            """, (code,))
            st = cur.fetchone()
            if st and st['total']:
                wr = (st['wins'] / (st['wins'] + st['losses']) * 100) if (st['wins'] + st['losses']) > 0 else 0
                cur.execute("""
                    INSERT INTO ft_strategy_stats
                    (strategy_code, total_signals, wins, losses, pending, win_rate, avg_pnl_pct)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON DUPLICATE KEY UPDATE
                    total_signals=VALUES(total_signals), wins=VALUES(wins),
                    losses=VALUES(losses), pending=VALUES(pending),
                    win_rate=VALUES(win_rate), avg_pnl_pct=VALUES(avg_pnl_pct)
                """, (code, st['total'], st['wins'] or 0, st['losses'] or 0,
                      st['pending'] or 0, round(wr, 2), round(float(st['avg_pnl'] or 0), 4)))

        conn.commit()

        # Save journey snapshot
        cur.execute("""
            INSERT IGNORE INTO ft_journey_snapshots
            (snapshot_date, strategy_code, win_rate, total_signals, wins, losses)
            SELECT %s, strategy_code, win_rate, total_signals, wins, losses
            FROM ft_strategy_stats
        """, (date.today(),))
        conn.commit()

        conn.close()
        log.info(f"ResultTracker done: {updated} signals updated")


# ══════════════════════════════════════════════════════════════════════
# CLI ENTRY POINT
# ══════════════════════════════════════════════════════════════════════



def run_hk_scan(db):
    """
    Scan HK market using hk_fetcher and insert signals into ft_signals.
    Called by main cron after US scan.
    """
    if not HAS_HK:
        print('⚠️  hk_fetcher not available, skipping HK scan')
        return 0

    print('\n=== HK Market Scan ===')

    # Get HK macro regime
    hk_macro = get_hk_macro()
    regime   = hk_macro.get('_regime', {})
    macro_score = regime.get('score', 0.0)
    print(f"HK Macro: {regime.get('verdict','NEUTRAL')} score={macro_score:.1f}")

    # Get sentiment
    sentiment_score = get_macro_sentiment_score(db).get('score', 0.0) if HAS_MARKET_INTEL else 0.0

    # Run scan
    signals = scan_hk_market()
    inserted = 0
    today    = __import__('datetime').date.today().isoformat()
    cur      = db.cursor()

    for s in signals:
        code       = s['code']
        indicators = s['indicators']
        tech_score = s['tech_score']
        final_score = tech_score + macro_score * 0.3 + sentiment_score * 0.2

        # Final signal based on combined score
        if final_score >= 120:   sig = 'STRONG_BUY'
        elif final_score >= 80:  sig = 'BUY'
        elif final_score >= 30:  sig = 'HOLD'
        elif final_score >= -10: sig = 'SELL'
        else:                    sig = 'STRONG_SELL'

        cur.execute("""
            INSERT INTO ft_signals
            (signal_date, ticker, market, sector, strategy_code,
             tech_score, macro_score, seasonality_score, sentiment_score, bandarmology_score,
             final_score, `signal`, entry_price, target_price, stop_loss, indicators)
            VALUES (%s, %s, 'hk', %s, 'hk_technical',
                    %s, %s, 0, %s, 0,
                    %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              final_score=VALUES(final_score), `signal`=VALUES(`signal`),
              tech_score=VALUES(tech_score), macro_score=VALUES(macro_score),
              indicators=VALUES(indicators)
        """, (
            today, code, s.get('sector', 'UNKNOWN'),
            round(tech_score, 2), round(macro_score, 2),
            round(sentiment_score, 2),
            round(final_score, 2), sig,
            s.get('entry_price', 0), s.get('target_price', 0), s.get('stop_loss', 0),
            __import__('json').dumps(indicators),
        ))
        inserted += 1
        print(f"  {code} → {sig} score={final_score:.0f} RSI={indicators.get('rsi',0):.1f}")

    db.commit()
    print(f'✅ HK scan done: {inserted} signals inserted')
    return inserted

if __name__ == '__main__':
    import sys
    mode = sys.argv[1] if len(sys.argv) > 1 else 'run'

    if mode == 'run':
        market   = sys.argv[2] if len(sys.argv) > 2 else 'us'
        tickers  = sys.argv[3].split(',') if len(sys.argv) > 3 else None
        engine   = SignalEngine()
        engine.run(tickers=tickers, market=market)

    elif mode == 'track':
        tracker = ResultTracker()
        tracker.run()

    elif mode == 'test':
        # Quick test on 3 tickers
        engine = SignalEngine()
        engine.run(tickers=['AAPL', 'NVDA', 'MSFT'], market='us')

    else:
        print("Usage: python signal_engine.py [run|track|test] [market] [tickers,...]")
