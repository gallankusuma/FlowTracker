/**
 * IDX MEGA Backfill Worker
 * Scrapes ALL available trading days from 2015 → Yesterday
 * Skips dates that are already in the database.
 * Resumable — just re-run if interrupted.
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
puppeteer.use(StealthPlugin());

const VPS_URL = 'http://76.13.22.155:3001';
const IDX_BASE = 'https://www.idx.co.id';
const DELAY_MS = 2000;
const START_YEAR = 2015; // IDX data typically available from ~2015

let ADMIN_TOKEN = '';
let browser = null;
let page = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg) {
  const t = new Date().toLocaleTimeString('id-ID');
  console.log(`[${t}] ${msg}`);
}

async function authenticateVPS() {
  const res = await axios.post(`${VPS_URL}/api/login`, {
    email: 'admin@flowtracker.id', password: 'admin123'
  });
  ADMIN_TOKEN = res.data.token;
}

async function pushToVPS(endpoint, data) {
  try {
    const res = await axios.post(`${VPS_URL}/api/scraper/push/${endpoint}`, data, {
      headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
      maxContentLength: 50*1024*1024, maxBodyLength: 50*1024*1024
    });
    return res.data;
  } catch (err) {
    if (err.response?.status === 401) { await authenticateVPS(); return pushToVPS(endpoint, data); }
    return null;
  }
}

async function getExistingDates() {
  try {
    const res = await axios.get(`${VPS_URL}/api/scraper/push/existing-dates`, {
      headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
    });
    return new Set(res.data.dates || []);
  } catch {
    return new Set();
  }
}

async function fetchJSON(url) {
  try {
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    if (response.status() === 403) {
      log('   🔄 Re-establishing session...');
      await page.goto('https://www.idx.co.id/id', { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(5000);
      const retry = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      if (retry.status() !== 200) return null;
    } else if (response.status() !== 200) return null;
    const text = await page.evaluate(() => document.body.innerText);
    try { return JSON.parse(text); } catch { return null; }
  } catch { return null; }
}

function generateAllTradingDays() {
  const dates = [];
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  for (let d = new Date(`${START_YEAR}-01-01`); d <= yesterday; d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 0 && d.getDay() !== 6) {
      dates.push(d.toISOString().split('T')[0]);
    }
  }
  return dates;
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log(`║   IDX MEGA BACKFILL (${START_YEAR} → Yesterday)                  ║`);
  console.log('║   Resumable — skips dates already in database           ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  await authenticateVPS();
  log('✅ VPS Auth OK');

  // Get existing dates from DB to skip
  const existing = await getExistingDates();
  log(`📦 Already have ${existing.size} dates in database`);

  // Generate all possible trading days
  const allDays = generateAllTradingDays();
  const toScrape = allDays.filter(d => !existing.has(d));

  log(`📅 Total possible trading days: ${allDays.length}`);
  log(`📅 Dates to scrape: ${toScrape.length} (skipping ${existing.size} existing)`);

  if (toScrape.length === 0) {
    log('✅ All dates already scraped! Nothing to do.');
    process.exit(0);
  }

  // Launch browser
  browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  log('🔑 Passing Cloudflare...');
  await page.goto('https://www.idx.co.id/id', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);
  log(`   Title: "${await page.title()}"`);

  let synced = 0, skipped = 0, failed = 0;
  let consecutiveEmpty = 0;

  for (let i = 0; i < toScrape.length; i++) {
    const dateStr = toScrape[i];
    const dateYMD = dateStr.replace(/-/g, '');
    const year = dateStr.substring(0, 4);

    process.stdout.write(`[${i+1}/${toScrape.length}] ${dateStr} `);

    const data = await fetchJSON(`${IDX_BASE}/primary/TradingSummary/GetBrokerSummary?length=9999&start=0&date=${dateYMD}`);

    if (!data?.data || data.data.length === 0) {
      console.log('⚠️ empty');
      skipped++;
      consecutiveEmpty++;

      // If 30+ consecutive empty in a year, that year's data may not exist — jump to next year
      if (consecutiveEmpty >= 30) {
        const nextYear = parseInt(year) + 1;
        const nextYearStart = `${nextYear}-01-01`;
        const jumpIndex = toScrape.findIndex(d => d >= nextYearStart);
        if (jumpIndex > i) {
          log(`   ⏩ Jumping to ${nextYear} (too many empty dates in ${year})`);
          i = jumpIndex - 1; // -1 because for loop will increment
          consecutiveEmpty = 0;
        }
      }
    } else {
      consecutiveEmpty = 0;
      const payload = data.data.map(item => ({
        broker_code: item.IDFirm, broker_name: item.FirmName,
        total_net: item.Value || 0, total_buy: item.Value || 0, total_sell: 0
      }));
      const res = await pushToVPS('broker_pl', { data: payload, date: dateStr });
      if (res) {
        console.log(`✅ ${res.count} brokers`);
        synced++;
      } else {
        console.log('❌ push failed');
        failed++;
      }
    }

    await sleep(DELAY_MS);

    // Refresh session every 50 requests
    if (i > 0 && i % 50 === 0) {
      log('🔄 Refreshing browser session...');
      await page.goto('https://www.idx.co.id/id', { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(3000);
      // Re-auth VPS token too
      try { await authenticateVPS(); } catch {}
    }

    // Progress update every 100
    if (i > 0 && i % 100 === 0) {
      log(`📊 Progress: ${i}/${toScrape.length} | Synced: ${synced} | Empty: ${skipped} | Failed: ${failed}`);
    }
  }

  console.log('');
  log('╔══════════════════════════════════════════════════════════╗');
  log(`║   ✅ MEGA BACKFILL COMPLETE!                             ║`);
  log(`║   Synced: ${String(synced).padEnd(6)} | Skipped: ${String(skipped).padEnd(6)} | Failed: ${String(failed).padEnd(6)}  ║`);
  log('╚══════════════════════════════════════════════════════════╝');

  await browser.close();
  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
