"""
Minimal .env loader for the Python cron subsystem.

WHY THIS EXISTS (2026-08-02)
----------------------------
The Node side calls `require('dotenv').config()`, so moving its credentials into
.env was self-contained. The Python side had no equivalent: `market_intel_fetcher.py`,
`paper_trader.py` and `signal_engine.py` carried the MySQL password as a literal,
and the crontab invokes them as

    cd /var/www/flowtracker-scraper && .venv/bin/python3 <script>.py

Bare `python3` from cron inherits no shell profile and no environment, so simply
replacing the literal with `os.environ.get('DB_PASSWORD')` returns None and every
one of those jobs starts failing silently at connect time. This module closes
that gap without adding a dependency — `python-dotenv` is not installed in the
venv, and requiring it would make a credential fix depend on a package install.

Values already present in the real environment always win; this only fills gaps,
so an operator can still override anything by exporting it.
"""

import os

_DEFAULT_ENV = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')


def load_env(path=None):
    """Populate os.environ from a .env file. Never overwrites an existing value.

    Handles the subset of .env syntax this project actually uses: KEY=value,
    blank lines, # comments, optional surrounding quotes, and an optional
    `export ` prefix. Values containing '=' are preserved (split once only).
    Missing or unreadable file is not an error — the environment may legitimately
    already be populated.
    """
    target = path or _DEFAULT_ENV
    try:
        with open(target, 'r', encoding='utf-8') as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                if line.startswith('export '):
                    line = line[len('export '):].lstrip()
                key, _, value = line.partition('=')
                key = key.strip()
                if not key:
                    continue
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                    value = value[1:-1]
                os.environ.setdefault(key, value)
    except (IOError, OSError):
        pass
    return os.environ


def require(name):
    """Fetch a variable that the caller cannot run without, failing loudly.

    A missing credential should stop the job with a clear message rather than
    surface later as an opaque database authentication error in a cron log
    nobody reads.
    """
    val = os.environ.get(name)
    if not val:
        raise RuntimeError(
            "%s is not set. Expected it in the environment or in %s. "
            "Cron runs bare python3 and inherits no shell profile, so the .env "
            "file is the only source." % (name, _DEFAULT_ENV)
        )
    return val
