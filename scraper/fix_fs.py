#!/usr/bin/env python3
"""Add missing fs require to server.js"""
FILE = '/var/www/flowtracker-scraper/server.js'
with open(FILE, 'r') as f:
    c = f.read()

old = "const path    = require('path');"
new = "const path    = require('path');\nconst fs      = require('fs');"

if "const fs" not in c:
    c = c.replace(old, new, 1)
    print("[1] Added const fs = require('fs')")
else:
    print("[1] SKIP: already exists")

with open(FILE, 'w') as f:
    f.write(c)
print("Done!")
