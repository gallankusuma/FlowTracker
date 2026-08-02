#!/usr/bin/env python3
"""Check table structures and reset winrate data."""
import subprocess

queries = [
    ("REC COLUMNS", "DESCRIBE ft_recommendations;"),
    ("REC SAMPLE", "SELECT id, ticker, pattern_type, direction, status, detected_date FROM ft_recommendations ORDER BY id DESC LIMIT 5;"),
    ("BACKTEST COLUMNS", "DESCRIBE ft_backtest_results;"),
    ("BACKTEST SAMPLE", "SELECT * FROM ft_backtest_results ORDER BY id DESC LIMIT 3;"),
]

for label, q in queries:
    print(f"\n=== {label} ===")
    r = subprocess.run(['mysql', '-u', 'root', 'erp_manufacturing', '-e', q], capture_output=True, text=True)
    print(r.stdout.strip() if r.stdout else r.stderr.strip())
