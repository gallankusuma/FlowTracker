#!/usr/bin/env python3
"""
Macro Data Fetcher — fetches from FRED API + Yahoo Finance
Run daily before signal_engine.py
"""
import os
import json
import logging
from datetime import date, datetime, timedelta
import pymysql
import yfinance as yf
import requests

log = logging.getLogger('MacroFetcher')
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')

import env_loader
env_loader.load_env()
DB_CFG = dict(host=os.environ.get('DB_HOST','localhost'), user=os.environ.get('DB_USER','erp_user'), password=env_loader.require('DB_PASSWORD'), db=os.environ.get('DB_NAME','erp_manufacturing'),
              charset='utf8mb4', cursorclass=pymysql.cursors.DictCursor)

# FRED API key (free at fred.stlouisfed.org)
FRED_API_KEY = os.getenv('FRED_API_KEY', '')
FRED_BASE    = 'https://api.stlouisfed.org/fred/series/observations'

def get_db():
    return pymysql.connect(**DB_CFG)

FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv'


def fetch_fred_observations(series_id: str) -> list:
    """
    Every observation of a FRED series, as [{'d': date, 'v': float}].

    TWO ROUTES, and the order matters. The documented API is preferred whenever
    FRED_API_KEY is set, because it is the stable contract. When no key exists we
    fall back to the PUBLIC fredgraph.csv download, which needs no credential.

    That fallback is the whole reason these series exist at all: the five FRED
    indicators had produced ZERO rows for months, silently, because a key was
    never configured -- and signal_engine.py was scoring sectors from them.
    Waiting on a credential was never necessary; the data was public the whole
    time.

    The CSV route is not the documented interface and could change shape without
    notice, so it announces itself rather than pretending to be the API.
    """
    if FRED_API_KEY:
        try:
            r = requests.get(FRED_BASE, params={
                'series_id': series_id,
                'api_key':   FRED_API_KEY,
                'file_type': 'json',
                'sort_order': 'asc',
            }, timeout=20)
            obs = [o for o in r.json().get('observations', []) if o['value'] not in ('.', '')]
            return [{'d': o['date'], 'v': float(o['value'])} for o in obs]
        except Exception as e:
            log.warning(f"FRED api {series_id}: {e} -- falling back to the public CSV")

    try:
        r = requests.get(FRED_CSV, params={'id': series_id}, timeout=25)
        r.raise_for_status()
        out = []
        for line in r.text.splitlines()[1:]:          # first line is the header
            parts = line.split(',')
            if len(parts) < 2:
                continue
            d, v = parts[0].strip(), parts[1].strip()
            # Missing observations arrive as an EMPTY field, not the '.' the JSON
            # API uses. Checked against DGS2, which has hundreds of them.
            if not v:
                continue
            try:
                out.append({'d': d, 'v': float(v)})
            except ValueError:
                continue
        return out
    except Exception as e:
        log.warning(f"FRED csv {series_id}: {e}")
        return []


def fred_rows(series_id: str, history: bool) -> list:
    """save()-shaped rows: the whole series, or just the latest observation."""
    obs = fetch_fred_observations(series_id)
    if len(obs) < 2:
        return []
    pairs = [{'current': obs[i]['v'], 'previous': obs[i - 1]['v'], 'date': obs[i]['d']}
             for i in range(1, len(obs))]
    return pairs if history else pairs[-1:]


def fetch_yahoo_price(symbol: str) -> dict | None:
    """Latest close and the one before it."""
    try:
        t    = yf.Ticker(symbol)
        hist = t.history(period='5d')
        if hist.empty or len(hist) < 2:
            return None
        cur  = float(hist['Close'].iloc[-1])
        prev = float(hist['Close'].iloc[-2])
        return {
            'current':  round(cur, 4),
            'previous': round(prev, 4),
            'date':     str(hist.index[-1].date()),
        }
    except Exception as e:
        log.warning(f"Yahoo {symbol}: {e}")
        return None


def fetch_yahoo_history(symbol: str, period: str = '5y') -> list:
    """
    Every close in the period, as save()-shaped rows.

    WHY THIS EXISTS. The daily path stores one observation per run, so after
    three months of running the table held 13 points per indicator. Thirteen
    points cannot support an information-coefficient test, which is the only
    thing that would tell us whether any of this macro data predicts anything.
    A feed nobody can evaluate is decoration.
    """
    try:
        hist = yf.Ticker(symbol).history(period=period)
        if hist.empty or len(hist) < 2:
            return []
        out = []
        closes = [float(c) for c in hist['Close']]
        for i in range(1, len(closes)):
            out.append({
                'current':  round(closes[i], 4),
                'previous': round(closes[i - 1], 4),
                'date':     str(hist.index[i].date()),
            })
        return out
    except Exception as e:
        log.warning(f"Yahoo history {symbol}: {e}")
        return []


def direction(cur, prev) -> str | None:
    """
    None when there is nothing to compare against.

    The column is enum('UP','DOWN','FLAT'), so there is no value that means
    "unknown" — NULL is the only honest option, and inventing a previous value
    to avoid it is what produced a YIELD_CURVE whose direction was UP on every
    row ever written.
    """
    if prev is None:
        return None
    if cur > prev * 1.001: return 'UP'
    if cur < prev * 0.999: return 'DOWN'
    return 'FLAT'


def save(conn, indicator: str, data: dict, source: str, quiet: bool = False, commit: bool = True):
    if not data:
        return
    cur  = data['current']
    prev = data.get('previous')
    d    = data.get('date', str(date.today()))
    dir_ = direction(cur, prev)
    c = conn.cursor()
    c.execute("""
        INSERT INTO ft_macro_data (date, indicator, value, previous_value, direction, source)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE value=%s, previous_value=%s, direction=%s
    """, (d, indicator, cur, prev, dir_, source, cur, prev, dir_))
    if commit:
        conn.commit()
    if not quiet:
        log.info(f"  {indicator}: {cur} ({dir_ or 'no prior'}) <- {source}")


# ── What we track, and why each one is here ───────────────────────────────────
#
# GLOBAL/US: the original set. Useful for the US layer and for global risk
# appetite, but note that none of it is Indonesia-specific.
#
# IDX: added 2026-08-20. IHSG is a commodity-heavy, foreign-flow-sensitive
# market and none of the drivers that actually move it were being tracked. Every
# symbol below was verified to resolve on Yahoo before being added — a symbol
# that silently returns nothing is the same defect as a missing API key.
YF_SYMBOLS = {
    # global / US
    'VIX':          '^VIX',
    'WTI':          'CL=F',
    'GOLD':         'GC=F',
    'COPPER':       'HG=F',
    'SILVER':       'SI=F',
    'NATURAL_GAS':  'NG=F',
    'DXY':          'DX-Y.NYB',
    'YIELD_10Y':    '^TNX',
    # ^IRX is the 13-WEEK T-bill, not the 2-year. It was stored as YIELD_2Y,
    # which made the computed curve 10Y-3M while every reader saw a name that
    # promised 10Y-2Y. Renamed to what it is; Yahoo has no clean 2-year series.
    'YIELD_3M':     '^IRX',
    'SPY':          'SPY',
    'QQQ':          'QQQ',

    # IDX-relevant
    'USDIDR':       'IDR=X',   # the most direct macro variable for IHSG
    'EIDO':         'EIDO',    # iShares MSCI Indonesia — foreign-flow proxy
    'JKSE':         '^JKSE',   # IHSG itself, so macro and index share one table
    'COAL_BTU':     'BTU',     # thermal-coal proxy; Newcastle is not on Yahoo
    'PALM_PROXY':   'ZL=F',    # soybean oil; CPO itself trades on Bursa Malaysia
    'NICKEL_PROXY': 'VALE',    # nickel/iron miner, not the LME contract
    'CHINA_FXI':    'FXI',     # Indonesia's largest export market
    'EM_EEM':       'EEM',     # emerging-market risk appetite
}

# FRED series. NOTE THE KEY REQUIREMENT: without FRED_API_KEY these have never
# produced a single row, and signal_engine.py's SECTOR_MAP consumes four of them
# (FED_RATE, CPI, PMI, UNEMPLOYMENT). Its loop does `if not data: continue`, so
# a sector whose indicators are all absent scores 0 — indistinguishable from a
# sector whose macro is genuinely balanced.
FRED_SERIES = {
    # growth
    'GDP_GROWTH':        'A191RL1Q225SBEA',   # real GDP, % change annualised
    # inflation, realised and expected
    'CPI':               'CPIAUCSL',
    'PCE_PRICE':         'PCEPI',
    'INFL_EXP_5Y':       'T5YIE',             # 5-year breakeven
    'INFL_EXP_10Y':      'T10YIE',            # 10-year breakeven
    # labour
    'UNEMPLOYMENT':      'UNRATE',
    'PAYROLLS':          'PAYEMS',            # nonfarm payrolls, thousands
    'JOBLESS_CLAIMS':    'ICSA',              # weekly initial claims
    # policy and the curve
    'FED_RATE':          'FEDFUNDS',
    # A REAL two-year at last. Yahoo has no clean 2Y series, which is how ^IRX
    # (the 13-week bill) came to be stored under the name YIELD_2Y. FRED has the
    # actual constant-maturity 2-year, so the name is now used correctly.
    'YIELD_2Y':          'DGS2',
    'YIELD_CURVE_10Y2Y': 'T10Y2Y',            # FRED computes this one itself
    # money and liquidity
    'M2':                'M2SL',
    'M2_REAL':           'M2REAL',
    'FED_BALANCE_SHEET': 'WALCL',
    'REVERSE_REPO':      'RRPONTSYD',
    # sentiment
    'CONSUMER_SENT':     'UMCSENT',           # U. Michigan
    # Kept under an honest name: MANEMP is manufacturing EMPLOYMENT, not the PMI.
    # Real ISM/S&P Global PMI is licensed and not available from any free source.
    'MFG_EMPLOYMENT':    'MANEMP',
}


def compute_yield_curve(conn):
    """
    10Y minus 3M, with a REAL previous value.

    The old version did `prev_spread = spread - 0.01  # approximate`, so the
    previous value was fabricated and `direction` came out UP on every row ever
    written. A direction that is constant by construction is worse than no
    direction: it looks like a measurement.
    """
    c = conn.cursor()
    c.execute("SELECT value FROM ft_macro_data WHERE indicator='YIELD_10Y' ORDER BY date DESC LIMIT 1")
    y10 = c.fetchone()
    c.execute("SELECT value FROM ft_macro_data WHERE indicator='YIELD_3M' ORDER BY date DESC LIMIT 1")
    y3 = c.fetchone()
    if not (y10 and y3):
        log.warning("  YIELD_CURVE skipped: need both YIELD_10Y and YIELD_3M")
        return
    spread = round(float(y10['value']) - float(y3['value']), 4)

    # The real prior spread, or None. Never a guess.
    c.execute("""SELECT value FROM ft_macro_data
                  WHERE indicator='YIELD_CURVE' AND date < %s
                  ORDER BY date DESC LIMIT 1""", (str(date.today()),))
    prior = c.fetchone()
    save(conn, 'YIELD_CURVE',
         {'current': spread,
          'previous': round(float(prior['value']), 4) if prior else None,
          'date': str(date.today())},
         'COMPUTED')


def backfill_yield_curve(conn):
    """
    The curve for every date where both legs exist.

    compute_yield_curve() only ever writes today, so after backfilling 1,254
    observations of each leg the curve was still a 13-row series -- the one
    indicator in the set that could not be tested. Derived series have to be
    derived across the whole history, not just the tip.
    """
    c = conn.cursor()
    c.execute("""SELECT a.date AS d, a.value AS y10, b.value AS y3
                   FROM ft_macro_data a
                   JOIN ft_macro_data b ON b.date = a.date AND b.indicator = 'YIELD_3M'
                  WHERE a.indicator = 'YIELD_10Y'
                  ORDER BY a.date ASC""")
    rows = c.fetchall()
    prev = None
    n = 0
    for r in rows:
        spread = round(float(r['y10']) - float(r['y3']), 4)
        save(conn, 'YIELD_CURVE',
             {'current': spread, 'previous': prev, 'date': str(r['d'])},
             'COMPUTED', quiet=True, commit=False)
        prev = spread
        n += 1
    conn.commit()
    log.info(f"  YIELD_CURVE: {n} observations derived from both legs")


def repair_legacy(conn):
    """
    One-time corrections to rows already written under the wrong names.

    This renames labels; it does not alter any measured value. The YIELD_2Y rows
    hold 13-week yields and always did — only the name was wrong.
    """
    c = conn.cursor()
    # SCOPED TO source='YAHOO', and that scope is load-bearing.
    #
    # The mislabelled rows came from Yahoo's ^IRX. Since then YIELD_2Y has become
    # a LEGITIMATE indicator sourced from FRED's DGS2 -- an actual constant-maturity
    # two-year. An unscoped rename would have destroyed it, folding real 2-year
    # yields into the 3-month series. The unique key caught it on the first run;
    # it should not have needed to.
    #
    # A migration that outlives the condition it was written for is a hazard, not
    # a fix. This one now names exactly the rows it was meant for.
    c.execute("SELECT COUNT(*) n FROM ft_macro_data WHERE indicator='YIELD_2Y' AND source='YAHOO'")
    n = c.fetchone()['n']
    if n:
        c.execute("""UPDATE IGNORE ft_macro_data SET indicator='YIELD_3M'
                      WHERE indicator='YIELD_2Y' AND source='YAHOO'""")
        c.execute("DELETE FROM ft_macro_data WHERE indicator='YIELD_2Y' AND source='YAHOO'")
        conn.commit()
        log.info(f"  repaired {n} mislabelled Yahoo YIELD_2Y rows -> YIELD_3M (^IRX is the 13-week bill)")

    # Strip the fabricated direction: previous_value exactly 0.01 below value is
    # the signature of `spread - 0.01`, and no real series lands on that.
    c.execute("""SELECT COUNT(*) n FROM ft_macro_data
                  WHERE indicator='YIELD_CURVE' AND source='COMPUTED'
                    AND ABS((value - previous_value) - 0.01) < 0.00005""")
    n = c.fetchone()['n']
    if n:
        c.execute("""UPDATE ft_macro_data SET previous_value=NULL, direction=NULL
                      WHERE indicator='YIELD_CURVE' AND source='COMPUTED'
                        AND ABS((value - previous_value) - 0.01) < 0.00005""")
        conn.commit()
        log.info(f"  cleared {n} fabricated YIELD_CURVE previous/direction values (they were value-0.01)")


def run(backfill: str | None = None):
    conn = get_db()
    log.info("=== Macro Fetcher Starting ===")
    repair_legacy(conn)

    if backfill:
        log.info(f"BACKFILL mode: {backfill} of history per Yahoo symbol")
        for indicator, symbol in YF_SYMBOLS.items():
            rows = fetch_yahoo_history(symbol, backfill)
            for r in rows:
                # One transaction per INDICATOR, not per row. The first backfill
                # committed ~24k times and took four minutes for work that is
                # seconds of actual insertion.
                save(conn, indicator, r, 'YAHOO', quiet=True, commit=False)
            conn.commit()
            log.info(f"  {indicator}: {len(rows)} observations")
    else:
        for indicator, symbol in YF_SYMBOLS.items():
            save(conn, indicator, fetch_yahoo_price(symbol), 'YAHOO')

    if backfill:
        backfill_yield_curve(conn)
    else:
        compute_yield_curve(conn)

    # No key required. The five series that had produced zero rows for months
    # are fetched here whether or not FRED_API_KEY exists.
    log.info(f"FRED via {'the keyed API' if FRED_API_KEY else 'the public CSV endpoint (no key needed)'}")
    for indicator, series in FRED_SERIES.items():
        rows = fred_rows(series, history=bool(backfill))
        for r in rows:
            save(conn, indicator, r, 'FRED', quiet=bool(backfill))
        if backfill:
            conn.commit()
            log.info(f"  {indicator}: {len(rows)} observations")
        elif not rows:
            log.warning(f"  {indicator} ({series}): no observations returned")

    conn.close()
    log.info("=== Macro Fetcher Done ===")


if __name__ == '__main__':
    import sys
    bf = None
    if '--backfill' in sys.argv:
        i = sys.argv.index('--backfill')
        bf = sys.argv[i + 1] if len(sys.argv) > i + 1 else '5y'
    run(bf)
