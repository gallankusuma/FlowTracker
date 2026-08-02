#!/usr/bin/env python3
"""Fix the broken cache load line in server.js"""
FILE = '/var/www/flowtracker-scraper/server.js'

with open(FILE, 'r') as f:
    content = f.read()

# Fix the broken cache assignment
old_broken = """      _harmonicScanCache = {
        date: data.date, ts: data.ts || Date.now(),
        results: data.results, scanned: data.scanned || 0,
        errors: data.errors || 0, scanning: false, progress: " done,
       interval: data.interval || '1d' };"""

new_fixed = """      _harmonicScanCache = {
        date: data.date, ts: data.ts || Date.now(),
        results: data.results, scanned: data.scanned || 0,
        errors: data.errors || 0, scanning: false, progress: 'done',
        interval: data.interval || '1d',
      };"""

if old_broken in content:
    content = content.replace(old_broken, new_fixed, 1)
    print("[1] Fixed broken cache assignment")
else:
    print("[1] SKIP: pattern not found, trying broader match...")
    # Try to find and fix it using line-by-line
    lines = content.split('\n')
    for i, line in enumerate(lines):
        if 'progress: " done,' in line or "progress: ' done," in line:
            # Found the broken line
            lines[i] = "        errors: data.errors || 0, scanning: false, progress: 'done',"
            if i+1 < len(lines) and "interval: data.interval" in lines[i+1]:
                lines[i+1] = "        interval: data.interval || '1d',"
                # Also fix the next line if it's the closing brace with semicolon
                if i+2 < len(lines) and '};' in lines[i+2]:
                    lines[i+2] = '      };'
            content = '\n'.join(lines)
            print("[1b] Fixed broken line at line " + str(i+1))
            break

with open(FILE, 'w') as f:
    f.write(content)
print("Done!")
