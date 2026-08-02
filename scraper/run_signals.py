#!/var/www/flowtracker-scraper/.venv/bin/python3
"""
Cron job runner untuk Signal Engine
Dipanggil oleh PM2 cron atau system cron

Schedule:
  19:30 WIB → run IDX signals (setelah IDX market close)
  07:00 WIB → run US signals + result tracker (setelah NYSE close)

Usage:
  python3 run_signals.py [evening|morning|test]
"""

import sys
import logging
from datetime import datetime

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
    handlers=[
        logging.FileHandler('/var/log/signal_engine.log'),
        logging.StreamHandler(sys.stdout),
    ]
)
log = logging.getLogger('Runner')

def is_weekday():
    return datetime.now().weekday() < 5  # Mon-Fri

def run_evening():
    """Run at 19:30 WIB — generate signals for next trading day"""
    log.info("=== EVENING RUN: Generating signals ===")
    from macro_fetcher import run as fetch_macro
    from signal_engine import SignalEngine, ResultTracker

    # 1. Fetch latest macro data
    log.info("Step 1/3: Fetching macro data...")
    fetch_macro()

    # 2. Run IDX strategies (bandarmology available)
    log.info("Step 2/3: Running IDX signal engine...")
    engine = SignalEngine()
    idx_results = engine.run(market='idx')

    # 3. Run US strategies
    log.info("Step 3/3: Running US signal engine...")
    us_results  = engine.run(market='us')

    # Summary
    all_results = idx_results + us_results
    buys = [r for r in all_results if r['signal'] in ('BUY','STRONG_BUY')]
    log.info(f"\n{'='*60}")
    log.info(f"EVENING COMPLETE: {len(buys)} BUY signals across {len(all_results)} total")
    log.info("TOP PICKS FOR TOMORROW:")
    for r in sorted(buys, key=lambda x: -x['final_score'])[:10]:
        log.info(f"  {r['signal']:12s} {r['market'].upper():3s} {r['ticker']:6s} "
                 f"score={r['final_score']:5.1f} [{r['strategy_code']}]")

def run_morning():
    """Run at 07:00 WIB — track results from yesterday's signals"""
    log.info("=== MORNING RUN: Tracking results ===")
    from signal_engine import ResultTracker
    tracker = ResultTracker()
    tracker.run()
    log.info("MORNING COMPLETE: Win/loss updated, journey snapshot saved")

def run_test():
    """Quick test on 5 tickers"""
    log.info("=== TEST RUN ===")
    from signal_engine import SignalEngine
    engine = SignalEngine()
    results = engine.run(
        tickers=['AAPL', 'NVDA', 'MSFT', 'TSLA', 'JPM'],
        market='us',
        save_to_db=True
    )
    log.info(f"Test done: {len(results)} signals generated")

if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'test'

    if not is_weekday() and mode != 'test':
        log.info(f"Weekend — skipping {mode} run")
        sys.exit(0)

    if mode == 'evening':
        run_evening()
    elif mode == 'morning':
        run_morning()
    elif mode == 'test':
        run_test()
    else:
        print(f"Unknown mode: {mode}. Use: evening | morning | test")
