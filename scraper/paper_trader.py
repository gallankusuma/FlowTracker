#!/usr/bin/env python3
"""
paper_trader.py
Virtual Paper Trading Auto-Pilot System

Lifecycle:
  PLANNED → OPEN → WIN / LOSS / EVEN

Timeline (US market example, WIB):
  19:30  signal_engine.py runs  → generates ft_signals
  19:45  generate_plan()        → creates PLANNED trades from top signals
  21:30  open_positions()       → market opens, PLANNED → OPEN
  21:30-04:00  check_prices()   → every 15 min, TP/SL monitoring
  04:00  settle_day()           → EOD settle remaining OPEN positions

IDX timeline (WIB):
  19:30  signal_engine.py runs
  19:45  generate_plan()
  09:00  open_positions()       → IDX opens
  09:00-15:50  check_prices()
  16:00  settle_day()
"""

import os
import pymysql
import yfinance as yf
import json
import logging
import sys
from datetime import datetime, date, timedelta
from typing import Optional, List, Dict
from decimal import Decimal

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('PaperTrader')

import env_loader
env_loader.load_env()

DB_CFG = dict(
    host=os.environ.get('DB_HOST', 'localhost'),
    user=os.environ.get('DB_USER', 'erp_user'),
    password=env_loader.require('DB_PASSWORD'),
    database='erp_manufacturing', charset='utf8mb4',
    cursorclass=pymysql.cursors.DictCursor
)

# ── Config ─────────────────────────────────────────────────────
CAPITAL_PER_TRADE = 1000.0      # USD per virtual trade
MAX_TRADES_PER_DAY = 5          # Max positions in one plan
MIN_SIGNAL = 'BUY'              # Minimum signal to include
DEFAULT_TP_PCT  = 5.0           # Default take profit %
DEFAULT_SL_PCT  = 3.0           # Default stop loss %
MIN_RR_RATIO    = 1.5           # Min risk/reward ratio

MARKETS = {
    'us':  {'tz_offset': -4,   'open': (9, 30),  'close': (16, 0),  'suffix': ''},
    'idx': {'tz_offset': +7,   'open': (9, 0),   'close': (16, 0),  'suffix': '.JK'},
    'hk':  {'tz_offset': +8,   'open': (9, 30),  'close': (16, 0),  'suffix': '.HK'},
}


# ── DB Setup ───────────────────────────────────────────────────

SETUP_SQL = """
CREATE TABLE IF NOT EXISTS ft_virtual_trades (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    trade_date      DATE NOT NULL,
    signal_id       BIGINT,
    ticker          VARCHAR(20) NOT NULL,
    market          ENUM('us','idx','hk') NOT NULL DEFAULT 'us',
    sector          VARCHAR(50),
    strategy_code   VARCHAR(50),
    signal_score    DECIMAL(6,2) DEFAULT 0,
    signal_type     VARCHAR(20),

    -- Plan
    entry_price     DECIMAL(15,4) NOT NULL,
    target_price    DECIMAL(15,4),
    stop_loss       DECIMAL(15,4),
    tp_pct          DECIMAL(5,2),
    sl_pct          DECIMAL(5,2),
    risk_reward     DECIMAL(5,2),
    rationale       TEXT,

    -- Virtual position
    virtual_capital DECIMAL(15,2) DEFAULT 1000.00,
    quantity        DECIMAL(15,4),

    -- Status: PLANNED → OPEN → WIN/LOSS/EVEN/STOPPED
    status          ENUM('PLANNED','OPEN','WIN','LOSS','EVEN','STOPPED') DEFAULT 'PLANNED',

    -- Result
    exit_price      DECIMAL(15,4),
    exit_time       DATETIME,
    exit_reason     ENUM('TP_HIT','SL_HIT','EOD_CLOSE','MANUAL'),
    pnl_usd         DECIMAL(10,2),
    pnl_pct         DECIMAL(8,4),

    -- Timestamps
    planned_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    opened_at       DATETIME,
    closed_at       DATETIME,

    INDEX idx_date      (trade_date),
    INDEX idx_ticker    (ticker),
    INDEX idx_status    (status),
    INDEX idx_market    (market),
    UNIQUE KEY uniq_trade (trade_date, ticker, strategy_code)
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
    log.info('Tables ready: ft_virtual_trades')


# ── Price Fetcher ──────────────────────────────────────────────

def get_current_price(ticker: str, market: str) -> Optional[float]:
    """Get current/latest price via yfinance"""
    suffix = MARKETS.get(market, {}).get('suffix', '')
    sym = ticker + suffix if not ticker.endswith(suffix) else ticker

    # HK: zero-pad to 4 digits
    if market == 'hk':
        code = ticker.zfill(4)
        sym  = f"{code}.HK"

    try:
        t    = yf.Ticker(sym)
        hist = t.history(period='1d', interval='5m')
        if hist.empty:
            hist = t.history(period='2d', interval='1d')
        if hist.empty:
            return None
        return round(float(hist['Close'].iloc[-1]), 4)
    except Exception as e:
        log.debug(f'get_current_price({sym}): {e}')
        return None


def get_day_ohlc(ticker: str, market: str, trade_date: date) -> Optional[Dict]:
    """Get full OHLC for a specific trading day"""
    suffix = MARKETS.get(market, {}).get('suffix', '')
    sym = ticker + suffix if not ticker.endswith(suffix) else ticker

    if market == 'hk':
        sym = f"{ticker.zfill(4)}.HK"

    try:
        t    = yf.Ticker(sym)
        hist = t.history(period='5d', interval='1d')
        if hist.empty:
            return None

        # Find the target date
        for idx, row in hist.iterrows():
            row_date = idx.date() if hasattr(idx, 'date') else idx
            if str(row_date) == str(trade_date):
                return {
                    'open':  round(float(row['Open']), 4),
                    'high':  round(float(row['High']), 4),
                    'low':   round(float(row['Low']), 4),
                    'close': round(float(row['Close']), 4),
                }

        # Fallback: latest day
        row = hist.iloc[-1]
        return {
            'open':  round(float(row['Open']), 4),
            'high':  round(float(row['High']), 4),
            'low':   round(float(row['Low']), 4),
            'close': round(float(row['Close']), 4),
        }
    except Exception as e:
        log.debug(f'get_day_ohlc({sym}): {e}')
        return None


# ── Signal Filter → Battle Plan ────────────────────────────────

def generate_plan(market='us', trade_date=None, max_trades=MAX_TRADES_PER_DAY):
    """
    Generate today's battle plan from ft_signals.
    Picks top signals by score, sets TP/SL, creates PLANNED trades.
    """
    if trade_date is None:
        trade_date = date.today()

    log.info(f'=== Generating Battle Plan: {market.upper()} | {trade_date} ===')
    setup_tables()
    db = get_db()
    cur = db.cursor()

    # Get today's top signals
    allowed_signals = ('STRONG_BUY', 'BUY')
    cur.execute("""
        SELECT id, ticker, sector, strategy_code, `signal`,
               final_score, entry_price, target_price, stop_loss,
               indicators, step_details
        FROM ft_signals
        WHERE signal_date = %s AND market = %s
          AND `signal` IN ('STRONG_BUY', 'BUY')
          AND entry_price > 0
        ORDER BY final_score DESC
        LIMIT %s
    """, (trade_date, market, max_trades * 3))  # fetch more, filter best

    signals = cur.fetchall()
    log.info(f'Found {len(signals)} BUY/STRONG_BUY signals for {market.upper()}')

    planned = 0
    for sig in signals:
        if planned >= max_trades:
            break

        ticker      = sig['ticker']
        entry_price = float(sig['entry_price'] or 0)
        if entry_price <= 0:
            continue

        # Calculate TP/SL
        tp_price = float(sig['target_price'] or 0)
        sl_price = float(sig['stop_loss'] or 0)

        if tp_price <= entry_price or tp_price == 0:
            tp_pct   = DEFAULT_TP_PCT
            # Adjust TP based on signal strength
            if sig['signal'] == 'STRONG_BUY':
                tp_pct = min(8.0, DEFAULT_TP_PCT * 1.5)
            tp_price = round(entry_price * (1 + tp_pct / 100), 4)
        else:
            tp_pct = round((tp_price - entry_price) / entry_price * 100, 2)

        if sl_price >= entry_price or sl_price == 0:
            sl_pct   = DEFAULT_SL_PCT
            sl_price = round(entry_price * (1 - sl_pct / 100), 4)
        else:
            sl_pct = round((entry_price - sl_price) / entry_price * 100, 2)

        # Risk/reward filter
        rr = tp_pct / sl_pct if sl_pct > 0 else 0
        if rr < MIN_RR_RATIO:
            log.info(f'  Skip {ticker}: R/R={rr:.2f} < {MIN_RR_RATIO}')
            continue

        quantity = round(CAPITAL_PER_TRADE / entry_price, 4)

        # Build rationale
        indicators = {}
        try:
            ind_raw = sig['indicators']
            if ind_raw:
                indicators = json.loads(ind_raw) if isinstance(ind_raw, str) else ind_raw
        except Exception:
            pass

        rsi    = indicators.get('rsi_14') or indicators.get('rsi', 0)
        sector = sig['sector'] or 'UNKNOWN'
        rationale = (
            f"{sig['signal']} signal | Score={sig['final_score']:.0f} | "
            f"RSI={float(rsi):.1f} | R/R={rr:.2f} | "
            f"TP +{tp_pct:.1f}% → ${tp_price:.2f} | "
            f"SL -{sl_pct:.1f}% → ${sl_price:.2f}"
        )

        try:
            cur.execute("""
                INSERT INTO ft_virtual_trades
                (trade_date, signal_id, ticker, market, sector, strategy_code,
                 signal_score, signal_type, entry_price, target_price, stop_loss,
                 tp_pct, sl_pct, risk_reward, rationale,
                 virtual_capital, quantity, status)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'PLANNED')
                ON DUPLICATE KEY UPDATE
                  signal_score=VALUES(signal_score),
                  target_price=VALUES(target_price),
                  stop_loss=VALUES(stop_loss),
                  tp_pct=VALUES(tp_pct), sl_pct=VALUES(sl_pct),
                  risk_reward=VALUES(risk_reward),
                  rationale=VALUES(rationale)
            """, (
                trade_date, sig['id'], ticker, market, sector,
                sig['strategy_code'], float(sig['final_score'] or 0),
                sig['signal'], entry_price, tp_price, sl_price,
                tp_pct, sl_pct, round(rr, 2), rationale,
                CAPITAL_PER_TRADE, quantity
            ))

            planned += 1
            log.info(f"  ✅ PLANNED: {ticker} @ ${entry_price:.2f} → "
                     f"TP ${tp_price:.2f} (+{tp_pct:.1f}%) | SL ${sl_price:.2f} (-{sl_pct:.1f}%) | R/R={rr:.2f}")
        except Exception as e:
            log.warning(f'  ❌ {ticker}: {e}')

    db.commit()
    db.close()
    log.info(f'Battle plan done: {planned} trades planned for {market.upper()} {trade_date}')
    return planned


# ── Open Positions at Market Open ─────────────────────────────

def open_positions(market='us', trade_date=None):
    """
    Market opens → change PLANNED to OPEN.
    Optionally verify price is still near entry (within 2%).
    """
    if trade_date is None:
        trade_date = date.today()

    log.info(f'=== Opening Positions: {market.upper()} {trade_date} ===')
    db  = get_db()
    cur = db.cursor()

    cur.execute("""
        SELECT id, ticker, market, entry_price
        FROM ft_virtual_trades
        WHERE trade_date = %s AND market = %s AND status = 'PLANNED'
    """, (trade_date, market))
    trades = cur.fetchall()

    opened = 0
    for t in trades:
        # Get open price to confirm entry
        current = get_current_price(t['ticker'], market)
        entry   = float(t['entry_price'])

        if current and abs(current - entry) / entry > 0.05:
            # Price moved >5% from signal entry — adjust entry to open price
            log.info(f"  {t['ticker']}: price moved {(current-entry)/entry*100:.1f}%, adjusting entry to ${current:.4f}")
            entry  = current
            cur.execute("""
                UPDATE ft_virtual_trades
                SET entry_price=%s, quantity=%s,
                    target_price = entry_price * (1 + tp_pct/100),
                    stop_loss    = entry_price * (1 - sl_pct/100)
                WHERE id=%s
            """, (current, round(CAPITAL_PER_TRADE / current, 4), t['id']))

        cur.execute("""
            UPDATE ft_virtual_trades
            SET status='OPEN', opened_at=NOW()
            WHERE id=%s
        """, (t['id'],))
        opened += 1
        log.info(f"  🟢 OPEN: {t['ticker']} @ ${entry:.4f}")

    db.commit()
    db.close()
    log.info(f'Opened {opened} positions for {market.upper()}')
    return opened


# ── Price Monitor: Check TP/SL ────────────────────────────────

def check_prices(market='us', trade_date=None):
    """
    Run every 15 min during market hours.
    Checks if TP or SL hit for any OPEN position.
    """
    if trade_date is None:
        trade_date = date.today()

    db  = get_db()
    cur = db.cursor()

    cur.execute("""
        SELECT id, ticker, market, entry_price, target_price, stop_loss,
               virtual_capital, quantity, strategy_code
        FROM ft_virtual_trades
        WHERE trade_date = %s AND market = %s AND status = 'OPEN'
    """, (trade_date, market))
    trades = cur.fetchall()

    if not trades:
        db.close()
        return 0

    log.info(f'Checking {len(trades)} open positions for {market.upper()}...')
    settled = 0

    for t in trades:
        current = get_current_price(t['ticker'], market)
        if current is None:
            log.debug(f"  {t['ticker']}: no price data")
            continue

        entry  = float(t['entry_price'])
        tp     = float(t['target_price'])
        sl     = float(t['stop_loss'])
        qty    = float(t['quantity'])
        cap    = float(t['virtual_capital'])

        pnl_pct = (current - entry) / entry * 100
        pnl_usd = cap * pnl_pct / 100

        if current >= tp:
            reason = 'TP_HIT'
            status = 'WIN'
            log.info(f"  🎯 {t['ticker']}: TP HIT @ ${current:.4f} (+{pnl_pct:.2f}%)")
        elif current <= sl:
            reason = 'SL_HIT'
            status = 'LOSS'
            log.info(f"  🔴 {t['ticker']}: SL HIT @ ${current:.4f} ({pnl_pct:.2f}%)")
        else:
            # Still open — log progress
            log.info(f"  📊 {t['ticker']}: ${current:.4f} | P&L {pnl_pct:+.2f}% | "
                     f"TP ${tp:.4f} (+{(tp-entry)/entry*100:.1f}%) | SL ${sl:.4f}")
            continue

        cur.execute("""
            UPDATE ft_virtual_trades
            SET status=%s, exit_price=%s, exit_time=NOW(),
                exit_reason=%s, pnl_pct=%s, pnl_usd=%s, closed_at=NOW()
            WHERE id=%s
        """, (status, current, reason, round(pnl_pct, 4), round(pnl_usd, 2), t['id']))
        settled += 1

    db.commit()
    db.close()
    return settled


# ── EOD Settlement ─────────────────────────────────────────────

def settle_day(market='us', trade_date=None):
    """
    End of day: settle all remaining OPEN positions at close price.
    Then update ft_journey_snapshots with today's results.
    """
    if trade_date is None:
        trade_date = date.today()

    log.info(f'=== EOD Settlement: {market.upper()} {trade_date} ===')
    db  = get_db()
    cur = db.cursor()

    # Get all OPEN positions
    cur.execute("""
        SELECT id, ticker, market, entry_price, target_price, stop_loss,
               virtual_capital, quantity, strategy_code
        FROM ft_virtual_trades
        WHERE trade_date = %s AND market = %s AND status = 'OPEN'
    """, (trade_date, market))
    open_trades = cur.fetchall()

    for t in open_trades:
        ohlc   = get_day_ohlc(t['ticker'], market, trade_date)
        close  = ohlc['close'] if ohlc else get_current_price(t['ticker'], market)
        if close is None:
            close = float(t['entry_price'])

        entry   = float(t['entry_price'])
        pnl_pct = (close - entry) / entry * 100
        pnl_usd = float(t['virtual_capital']) * pnl_pct / 100

        if pnl_pct > 0.5:    status = 'WIN'
        elif pnl_pct < -0.5: status = 'LOSS'
        else:                 status = 'EVEN'

        cur.execute("""
            UPDATE ft_virtual_trades
            SET status=%s, exit_price=%s, exit_time=%s,
                exit_reason='EOD_CLOSE', pnl_pct=%s, pnl_usd=%s, closed_at=NOW()
            WHERE id=%s
        """, (status, close, datetime.combine(trade_date, datetime.max.time()),
              round(pnl_pct, 4), round(pnl_usd, 2), t['id']))
        log.info(f"  EOD {t['ticker']}: close=${close:.4f} P&L {pnl_pct:+.2f}% → {status}")

    db.commit()

    # ── Update ft_journey_snapshots ────────────────────────────
    cur.execute("""
        SELECT strategy_code,
               COUNT(*) as total,
               SUM(CASE WHEN status='WIN'  THEN 1 ELSE 0 END) as wins,
               SUM(CASE WHEN status='LOSS' THEN 1 ELSE 0 END) as losses,
               AVG(pnl_pct) as avg_pnl,
               SUM(pnl_usd) as total_pnl_usd
        FROM ft_virtual_trades
        WHERE trade_date = %s AND market = %s AND status IN ('WIN','LOSS','EVEN')
        GROUP BY strategy_code
    """, (trade_date, market))
    results = cur.fetchall()

    # Get previous portfolio value per strategy
    for r in results:
        code  = r['strategy_code']
        wins  = r['wins'] or 0
        total = r['total'] or 1
        wr    = round(wins / total * 100, 2)
        avg_pnl = float(r['avg_pnl'] or 0)

        # Get previous snapshot to compute cumulative portfolio value
        cur.execute("""
            SELECT portfolio_value, total_signals, wins, losses
            FROM ft_journey_snapshots
            WHERE strategy_code=%s AND snapshot_date < %s
            ORDER BY snapshot_date DESC LIMIT 1
        """, (code, trade_date))
        prev = cur.fetchone()

        prev_val  = float(prev['portfolio_value'] if prev else 100000)
        prev_tot  = int(prev['total_signals']      if prev else 0)
        prev_wins = int(prev['wins']               if prev else 0)
        prev_loss = int(prev['losses']             if prev else 0)

        new_val   = round(prev_val * (1 + avg_pnl / 100), 2)
        new_tot   = prev_tot + int(total)
        new_wins  = prev_wins + int(wins)
        new_loss  = prev_loss + int(r['losses'] or 0)
        cum_wr    = round(new_wins / new_tot * 100, 2) if new_tot > 0 else 0

        cur.execute("""
            INSERT INTO ft_journey_snapshots
            (snapshot_date, strategy_code, win_rate, total_signals, wins, losses,
             avg_pnl_pct, portfolio_value)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              win_rate=VALUES(win_rate), total_signals=VALUES(total_signals),
              wins=VALUES(wins), losses=VALUES(losses),
              avg_pnl_pct=VALUES(avg_pnl_pct), portfolio_value=VALUES(portfolio_value)
        """, (trade_date, code, cum_wr, new_tot, new_wins, new_loss,
              round(avg_pnl, 4), new_val))

        log.info(f"  📊 {code}: W={wins}/{total} WR={wr:.1f}% avg={avg_pnl:+.2f}% "
                 f"portfolio=${new_val:,.0f}")

    db.commit()
    db.close()
    log.info(f'✅ EOD settlement complete: {len(open_trades)} settled, '
             f'{len(results)} strategies updated in journey')


# ── Summary Report ─────────────────────────────────────────────

def daily_report(market='us', trade_date=None) -> Dict:
    """Get summary of today's virtual trades"""
    if trade_date is None:
        trade_date = date.today()

    db  = get_db()
    cur = db.cursor()

    cur.execute("""
        SELECT ticker, market, sector, strategy_code, signal_type, signal_score,
               entry_price, target_price, stop_loss, tp_pct, sl_pct, risk_reward,
               virtual_capital, status, exit_price, exit_reason, pnl_pct, pnl_usd,
               rationale, planned_at, opened_at, closed_at
        FROM ft_virtual_trades
        WHERE trade_date = %s AND market = %s
        ORDER BY signal_score DESC
    """, (trade_date, market))
    trades = cur.fetchall()

    total    = len(trades)
    wins     = sum(1 for t in trades if t['status'] == 'WIN')
    losses   = sum(1 for t in trades if t['status'] == 'LOSS')
    open_pos = sum(1 for t in trades if t['status'] == 'OPEN')
    planned  = sum(1 for t in trades if t['status'] == 'PLANNED')
    total_pnl = sum(float(t['pnl_usd'] or 0) for t in trades)

    result = {
        'date':       str(trade_date),
        'market':     market,
        'total':      total,
        'wins':       wins,
        'losses':     losses,
        'open':       open_pos,
        'planned':    planned,
        'win_rate':   round(wins / (wins + losses) * 100, 1) if (wins + losses) > 0 else 0,
        'total_pnl':  round(total_pnl, 2),
        'trades':     [dict(t) for t in trades],
    }

    db.close()
    return result


# ── API endpoint data for server.js ───────────────────────────

def get_today_plan(market='us', trade_date=None) -> Dict:
    """Called by server.js API — returns today's battle plan"""
    return daily_report(market, trade_date)


# ── Main ───────────────────────────────────────────────────────

if __name__ == '__main__':
    import sys

    cmd    = sys.argv[1] if len(sys.argv) > 1 else 'plan'
    market = sys.argv[2] if len(sys.argv) > 2 else 'us'

    if cmd == 'setup':
        setup_tables()

    elif cmd == 'plan':
        generate_plan(market)

    elif cmd == 'open':
        open_positions(market)

    elif cmd == 'check':
        check_prices(market)

    elif cmd == 'settle':
        settle_day(market)

    elif cmd == 'report':
        r = daily_report(market)
        print(f"\n=== {r['market'].upper()} Battle Report {r['date']} ===")
        print(f"Total: {r['total']} | W: {r['wins']} | L: {r['losses']} | "
              f"Open: {r['open']} | WR: {r['win_rate']}% | PnL: ${r['total_pnl']:+.2f}")
        print()
        for t in r['trades']:
            status_icon = {'WIN':'🎯','LOSS':'🔴','OPEN':'📊','PLANNED':'📋','EVEN':'➖'}.get(t['status'],'?')
            pnl = f"{float(t['pnl_pct'] or 0):+.2f}%" if t['pnl_pct'] else 'pending'
            print(f"  {status_icon} {t['ticker']:6s} {t['status']:8s} | "
                  f"Entry ${float(t['entry_price']):.2f} → "
                  f"TP ${float(t['target_price']):.2f} (+{float(t['tp_pct']):.1f}%) | "
                  f"SL ${float(t['stop_loss']):.2f} | P&L {pnl}")

    elif cmd == 'full':
        # Full simulation: plan → open → check → settle
        log.info('Running full paper trading simulation...')
        generate_plan(market)
        open_positions(market)
        check_prices(market)
        settle_day(market)
        r = daily_report(market)
        print(f"\nResult: W={r['wins']} L={r['losses']} WR={r['win_rate']}% "
              f"PnL=${r['total_pnl']:+.2f}")

    else:
        print(f"Usage: paper_trader.py [setup|plan|open|check|settle|report|full] [us|idx|hk]")
