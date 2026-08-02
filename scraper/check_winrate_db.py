#!/usr/bin/env python3
"""Check and reset winrate data, then update backtest settings."""
import subprocess, json

# 1. Check current data
print("=== CURRENT RECOMMENDATIONS DATA ===")
result = subprocess.run(
    ['mysql', '-u', 'root', 'erp_manufacturing', '-e',
     "SELECT COUNT(*) as total, "
     "SUM(status='OPEN') as open_count, "
     "SUM(status IN ('HIT_T1','HIT_T2')) as wins, "
     "SUM(status='STOPPED') as stopped, "
     "SUM(status='EXPIRED') as expired "
     "FROM recommendations;"],
    capture_output=True, text=True
)
print(result.stdout or result.stderr)

# 2. Check auto_journal
print("=== AUTO JOURNAL DATA ===")
result2 = subprocess.run(
    ['mysql', '-u', 'root', 'erp_manufacturing', '-e',
     "SELECT COUNT(*) as total FROM auto_journal;"],
    capture_output=True, text=True
)
print(result2.stdout or result2.stderr)

# 3. Check scanner_stats
print("=== SCANNER STATS ===")
result3 = subprocess.run(
    ['mysql', '-u', 'root', 'erp_manufacturing', '-e',
     "SHOW TABLES LIKE '%scanner%';"],
    capture_output=True, text=True
)
print(result3.stdout or result3.stderr)

# 4. Check all related tables
print("=== ALL TABLES ===")
result4 = subprocess.run(
    ['mysql', '-u', 'root', 'erp_manufacturing', '-e',
     "SHOW TABLES LIKE '%recommend%'; SHOW TABLES LIKE '%journal%'; SHOW TABLES LIKE '%backtest%'; SHOW TABLES LIKE '%winrate%';"],
    capture_output=True, text=True
)
print(result4.stdout or result4.stderr)
