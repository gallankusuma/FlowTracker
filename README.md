# FlowTracker — Uncover the Hidden Moves

Real-time broker flow analysis platform for the Indonesia Stock Exchange (IDX/IHSG).

## Features

- **Flow Analyzer** — Detect accumulation/distribution patterns across 959+ IHSG stocks
- **Broker Activity (Stalker)** — Track individual broker buy/sell activity with transaction matrix
- **Accumulation Streak** — Identify multi-day accumulation patterns by top brokers
- **Insider Moves** — Monitor unusual broker activity and concentration shifts
- **Broker P/L Summary** — Comprehensive profit/loss analysis across all brokers
- **Data Warehouse** — Automated daily data pipeline from IDX official API

## Tech Stack

- **Backend**: Node.js, Express, SQLite (better-sqlite3)
- **Frontend**: Vanilla HTML/CSS/JS with modern glassmorphism design
- **Data Source**: IDX Official API (idx.co.id) — no third-party dependencies
- **Deployment**: PM2, Nginx reverse proxy

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│  IDX (idx.co.id)│────→│  Local Worker    │────→│  VPS Server │
│  Official API   │     │  (Puppeteer)     │     │  (SQLite DB)│
└─────────────────┘     └──────────────────┘     └──────┬──────┘
                                                        │
                                                 ┌──────┴──────┐
                                                 │  Frontend   │
                                                 │  (Web App)  │
                                                 └─────────────┘
```

## Setup

### Backend
```bash
cd backend
cp .env.example .env
npm install
node server.js
```

### Frontend
```bash
cd frontend
# Serve with any static file server
npx serve -s . -l 3000
```

### Data Pipeline (Local Worker)
```bash
cd local-worker
npm install
node idx-worker.js      # Daily sync
node idx-backfill.js    # Historical backfill
```

## Database

The SQLite database contains:
- **master_tickers** — 959+ IHSG stocks with OHLCV data
- **master_brokers** — 90 registered IDX broker entities
- **broker_daily_pl** — 140,000+ daily broker trading records (2020–present)
- **trading_days** — Market calendar

## License

Private — All rights reserved.
