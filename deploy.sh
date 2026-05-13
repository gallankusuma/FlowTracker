#!/bin/bash
# ──────────────────────────────────────────────
# FlowTracker VPS Deployment Script
# ──────────────────────────────────────────────
# Usage: bash deploy.sh
# Prerequisites: Node.js 18+, npm, git, nginx
# ──────────────────────────────────────────────

set -e

echo "🌊 FlowTracker Deployment Starting..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Step 1: Install dependencies ──
echo ""
echo "📦 Step 1: Installing backend dependencies..."
cd backend
npm ci --production
cd ..

echo "📦 Step 1b: Installing frontend dependencies..."
cd frontend
npm ci
cd ..

# ── Step 2: Build frontend ──
echo ""
echo "🔨 Step 2: Building frontend production bundle..."
cd frontend
npm run build
cd ..

echo "✅ Frontend built → frontend/dist/"

# ── Step 3: Setup environment ──
echo ""
echo "⚙️  Step 3: Checking environment..."
if [ ! -f backend/.env ]; then
  echo "Creating .env from template..."
  cp backend/.env.example backend/.env
  echo "⚠️  IMPORTANT: Edit backend/.env and set a proper JWT_SECRET!"
fi

# ── Step 4: Initialize database ──
echo ""
echo "💾 Step 4: Database will be auto-initialized on first start"

# ── Step 5: Start with PM2 (if available) ──
echo ""
if command -v pm2 &> /dev/null; then
  echo "🚀 Step 5: Starting with PM2..."
  cd backend
  NODE_ENV=production pm2 start server.js --name flowtracker --update-env
  pm2 save
  cd ..
  echo "✅ FlowTracker running via PM2"
  echo "   View logs:   pm2 logs flowtracker"
  echo "   Restart:     pm2 restart flowtracker"
  echo "   Stop:        pm2 stop flowtracker"
else
  echo "🚀 Step 5: Starting with node..."
  echo "   (Install PM2 globally for production: npm i -g pm2)"
  cd backend
  NODE_ENV=production nohup node server.js > ../flowtracker.log 2>&1 &
  echo $! > ../flowtracker.pid
  cd ..
  echo "✅ FlowTracker running (PID: $(cat flowtracker.pid))"
  echo "   View logs: tail -f flowtracker.log"
  echo "   Stop: kill $(cat flowtracker.pid)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🌊 FlowTracker deployed successfully!"
echo "   URL: http://your-domain:${PORT:-3001}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
