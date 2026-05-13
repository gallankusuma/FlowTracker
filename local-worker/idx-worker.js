/**
 * IDX Local Worker v2 (Puppeteer Stealth)
 * 
 * Uses a real browser to bypass Cloudflare protection on idx.co.id
 * Scrapes data from IDX and pushes to VPS database.
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');

puppeteer.use(StealthPlugin());

const VPS_URL = 'http://76.13.22.155:3001';
const IDX_BASE = 'https://www.idx.co.id';
const DELAY_MS = 2000;

const ADMIN_EMAIL = 'admin@flowtracker.id';
const ADMIN_PASS = 'admin123';

let ADMIN_TOKEN = '';
let browser = null;
let page = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) {
  const t = new Date().toLocaleTimeString('id-ID');
  console.log(`[${t}] ${msg}`);
}

// ── VPS Auth ──

async function authenticateVPS() {
  log('🔐 Authenticating with VPS...');
  try {
    const res = await axios.post(`${VPS_URL}/api/login`, {
      email: ADMIN_EMAIL, password: ADMIN_PASS
    });
    ADMIN_TOKEN = res.data.token;
    log('✅ VPS Auth OK!');
    return true;
  } catch (err) {
    log('❌ VPS Auth failed: ' + (err.response?.data?.error || err.message));
    return false;
  }
}

async function pushToVPS(endpoint, data) {
  try {
    const res = await axios.post(`${VPS_URL}/api/scraper/push/${endpoint}`, data, {
      headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
      maxContentLength: 50 * 1024 * 1024,
      maxBodyLength: 50 * 1024 * 1024
    });
    return res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      await authenticateVPS();
      return pushToVPS(endpoint, data);
    }
    log(`❌ Push failed: ${err.response?.data?.error || err.message}`);
    return null;
  }
}

// ── Browser Setup ──

async function launchBrowser() {
  log('🌐 Launching stealth browser...');
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });
  page = await browser.newPage();
  
  // Set realistic viewport
  await page.setViewport({ width: 1920, height: 1080 });
  
  // First visit idx.co.id to pass Cloudflare challenge
  log('🔑 Passing Cloudflare challenge...');
  await page.goto('https://www.idx.co.id/id', { waitUntil: 'networkidle2', timeout: 30000 });
  
  // Wait a bit for any JS challenge to resolve
  await sleep(3000);
  
  const title = await page.title();
  log(`   Page title: "${title}"`);
  
  if (title.includes('Attention') || title.includes('blocked')) {
    log('⚠️ Cloudflare still blocking. Waiting longer...');
    await sleep(10000);
    await page.reload({ waitUntil: 'networkidle2' });
    await sleep(3000);
  }
  
  log('✅ Browser ready!');
}

async function fetchJSON(url) {
  try {
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const status = response.status();
    
    if (status !== 200) {
      log(`   ⚠️ HTTP ${status} for ${url}`);
      
      // If we get 403, try to go back to main page first and retry
      if (status === 403) {
        log('   🔄 Re-establishing session...');
        await page.goto('https://www.idx.co.id/id', { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(5000);
        const retryResponse = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        if (retryResponse.status() !== 200) {
          log(`   ❌ Retry failed with HTTP ${retryResponse.status()}`);
          return null;
        }
      } else {
        return null;
      }
    }
    
    const text = await page.evaluate(() => document.body.innerText);
    try {
      return JSON.parse(text);
    } catch {
      log('   ⚠️ Response is not valid JSON');
      log('   First 200 chars: ' + text.substring(0, 200));
      return null;
    }
  } catch (err) {
    log(`   ❌ Fetch error: ${err.message}`);
    return null;
  }
}

// ── Worker Tasks ──

async function syncBrokers() {
  log('\n🏢 === SYNCING BROKERS ===');
  const data = await fetchJSON(`${IDX_BASE}/primary/ExchangeMember/GetBrokerSearch?start=0&length=9999`);
  if (!data?.data || !Array.isArray(data.data)) {
    log('   ❌ No broker data');
    return 0;
  }
  
  const payload = data.data.map(i => ({ code: i.Code, name: i.Name }));
  log(`   📦 ${payload.length} brokers found. Pushing to VPS...`);
  
  const res = await pushToVPS('brokers', { brokers: payload });
  if (res) log(`   ✅ Saved ${res.count} brokers`);
  return payload.length;
}

async function syncStocks(dateYMD) {
  log(`\n📊 === SYNCING STOCKS (${dateYMD}) ===`);
  const data = await fetchJSON(`${IDX_BASE}/primary/TradingSummary/GetStockSummary?date=${dateYMD}`);
  if (!data?.data || !Array.isArray(data.data)) {
    log('   ❌ No stock data');
    return 0;
  }
  
  const payload = data.data.map(i => ({
    code: i.StockCode,
    name: i.StockName,
    last_price: i.Close || 0,
    previous: i.Previous || 0,
    last_value: i.Value || 0
  }));
  log(`   📦 ${payload.length} stocks found. Pushing to VPS...`);
  
  const res = await pushToVPS('stocks', { stocks: payload, date: dateYMD });
  if (res) log(`   ✅ Saved ${res.count} stocks`);
  return payload.length;
}

async function syncBrokerSummary(dateStr) {
  const dateYMD = dateStr.replace(/-/g, '');
  log(`\n🏢 === SYNCING BROKER SUMMARY (${dateStr}) ===`);
  const data = await fetchJSON(`${IDX_BASE}/primary/TradingSummary/GetBrokerSummary?length=9999&start=0&date=${dateYMD}`);
  
  if (!data?.data || !Array.isArray(data.data) || data.data.length === 0) {
    log(`   ⚠️ No data for ${dateStr} (maybe holiday)`);
    return 0;
  }
  
  const payload = data.data.map(i => ({
    broker_code: i.IDFirm,
    broker_name: i.FirmName,
    total_net: i.Value || 0,
    total_buy: i.Value || 0,
    total_sell: 0
  }));
  log(`   📦 ${payload.length} broker records found. Pushing to VPS...`);
  
  const res = await pushToVPS('broker_pl', { data: payload, date: dateStr });
  if (res) log(`   ✅ Saved ${res.count} records`);
  return payload.length;
}

// ── Main ──

function getTradingDays(count) {
  const dates = [];
  const d = new Date();
  while (dates.length < count) {
    d.setDate(d.getDate() - 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) {
      dates.push(d.toISOString().split('T')[0]);
    }
  }
  return dates.reverse();
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   IDX LOCAL WORKER v2 (Puppeteer Stealth)       ║');
  console.log('║   Bypass Cloudflare → Push to VPS Database      ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // 1. Auth with VPS
  const authOk = await authenticateVPS();
  if (!authOk) {
    log('CRITICAL: Cannot connect to VPS. Exiting.');
    process.exit(1);
  }

  // 2. Launch browser
  await launchBrowser();

  let totalRecords = 0;

  // 3. Sync Master Brokers
  totalRecords += await syncBrokers();
  await sleep(DELAY_MS);

  // 4. Sync last 5 trading days
  const days = getTradingDays(5);
  log(`\n📅 Syncing ${days.length} trading days: ${days[0]} → ${days[days.length-1]}`);

  for (const dateStr of days) {
    const dateYMD = dateStr.replace(/-/g, '');
    totalRecords += await syncStocks(dateYMD);
    await sleep(DELAY_MS);
    totalRecords += await syncBrokerSummary(dateStr);
    await sleep(DELAY_MS);
  }

  // Done
  console.log('');
  log('╔══════════════════════════════════════════════════╗');
  log(`║   ✅ COMPLETE! Total records synced: ${totalRecords.toString().padEnd(12)}║`);
  log('╚══════════════════════════════════════════════════╝');

  await browser.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  if (browser) browser.close();
  process.exit(1);
});
