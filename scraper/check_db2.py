#!/usr/bin/env python3
"""Check ft_recommendations and ft_backtest_results data."""
import subprocess

queries = [
    ("RECOMMENDATIONS", "SELECT COUNT(*) as total, SUM(status='OPEN') as open_count, SUM(status IN ('HIT_T1','HIT_T2')) as wins, SUM(status='STOPPED') as stopped, SUM(status='EXPIRED') as expired FROM ft_recommendations;"),
    ("SAMPLE RECS", "SELECT id, ticker, pattern_type, direction, status, detected_date, market FROM ft_recommendations ORDER BY id DESC LIMIT 5;"),
    ("BACKTEST", "SELECT COUNT(*) as total FROM ft_backtest_results;"),
    ("BACKTEST SAMPLE", "SELECT id, run_date, timeframe, total_signals, win_rate, status FROM ft_backtest_results ORDER BY id DESC LIMIT 5;"),
    ("TABLES", "SHOW TABLES LIKE 'ft_%';"),
]

for label, q in queries:
    print(f"\n=== {label} ===")
    r = subprocess.run(['mysql', '-u', 'root', 'erp_manufacturing', '-e', q], capture_output=True, text=True)
    print(r.stdout.strip() if r.stdout else r.stderr.strip())
