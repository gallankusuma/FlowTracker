/**
 * IDX Scraper Test — Try various approaches to get broker data
 * Run: node test-idx-scrape.js
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function testIDXScrape() {
  console.log('🚀 Starting IDX scrape test with stealth plugin...\n');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Realistic user agent
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    
    // Override navigator properties for stealth
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['id-ID', 'id', 'en-US', 'en'] });
      window.chrome = { runtime: {} };
    });

    // Step 1: Visit the main page to get cookies
    console.log('Step 1: Loading idx.co.id broker summary page...');
    const response = await page.goto('https://www.idx.co.id/en/market-data/trading-summary/broker-summary/', {
      waitUntil: 'networkidle0',
      timeout: 60000,
    });
    console.log(`  → Page status: ${response?.status()}`);
    
    // Wait for Cloudflare challenge to resolve
    console.log('Step 2: Waiting for Cloudflare challenge...');
    await delay(8000);
    
    // Check page title to verify we passed Cloudflare
    const title = await page.title();
    console.log(`  → Page title: "${title}"`);
    
    // Check if we're still on Cloudflare challenge
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || '');
    const isCloudflare = bodyText.includes('Verifying you are human') || bodyText.includes('Checking your browser') || bodyText.includes('Just a moment');
    console.log(`  → Cloudflare blocked: ${isCloudflare}`);
    
    if (isCloudflare) {
      console.log('  → Waiting longer for CF challenge...');
      await delay(10000);
      const title2 = await page.title();
      console.log(`  → Title after wait: "${title2}"`);
    }
    
    // Check cookies
    const cookies = await page.cookies();
    const cfCookies = cookies.filter(c => c.name.startsWith('cf_') || c.name.startsWith('__cf'));
    console.log(`  → CF cookies: ${cfCookies.map(c => c.name).join(', ') || 'none'}`);

    // Step 3: Try fetching API within browser context (same-origin)
    console.log('\nStep 3: Fetching broker summary API from browser context...');
    
    const brokerCode = 'MG';
    const dateStr = '20260425'; // Use recent trading day
    
    const apiUrls = [
      `https://www.idx.co.id/primary/TradingSummary/GetBrokerSummary?code=${brokerCode}&date=${dateStr}&length=100&start=0`,
      `https://www.idx.co.id/primary/TradingSummary/GetBrokerSummary?code=${brokerCode}&date=${dateStr}&length=50&start=0&_=${Date.now()}`,
    ];
    
    for (const apiUrl of apiUrls) {
      console.log(`  → Trying: ${apiUrl.split('?')[0]}...`);
      
      const result = await page.evaluate(async (url) => {
        try {
          const resp = await fetch(url, {
            credentials: 'include',
            headers: {
              'Accept': 'application/json, text/plain, */*',
              'X-Requested-With': 'XMLHttpRequest',
            },
          });
          const status = resp.status;
          if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            return { status, error: `HTTP ${status}`, body: text.slice(0, 200) };
          }
          const data = await resp.json();
          return { status, data, count: data?.data?.length || data?.Data?.length || data?.Results?.length || 0 };
        } catch (e) {
          return { error: e.message };
        }
      }, apiUrl);
      
      console.log(`  → Result:`, JSON.stringify(result).slice(0, 300));
      
      if (result.data && result.count > 0) {
        console.log(`\n✅ SUCCESS! Got ${result.count} records from IDX API!`);
        console.log('  Sample data:', JSON.stringify(result.data?.data?.[0] || result.data?.Data?.[0] || result.data?.Results?.[0], null, 2));
        break;
      }
    }

    // Step 4: Try to scrape the actual table from the page
    console.log('\nStep 4: Trying to scrape data directly from the rendered page...');
    
    // Take screenshot
    await page.screenshot({ path: '/tmp/idx-page.png', fullPage: true });
    console.log('  → Screenshot saved to /tmp/idx-page.png');
    
    // Check if there's a table
    const tableExists = await page.evaluate(() => {
      const tables = document.querySelectorAll('table');
      return { count: tables.length, html: tables[0]?.outerHTML?.slice(0, 500) || 'no table' };
    });
    console.log(`  → Tables found: ${tableExists.count}`);
    
    // Try to interact with the page - search for broker
    try {
      const inputs = await page.$$('input[type="text"], input[type="search"]');
      console.log(`  → Input fields found: ${inputs.length}`);
      
      if (inputs.length > 0) {
        await inputs[0].click();
        await page.keyboard.type(brokerCode, { delay: 100 });
        await delay(1000);
        
        // Try clicking search/filter button
        const searchBtns = await page.$$('button');
        for (const btn of searchBtns) {
          const btnText = await page.evaluate(el => el.textContent?.trim(), btn);
          if (btnText && (btnText.includes('Search') || btnText.includes('Cari') || btnText.includes('Filter') || btnText.includes('Tampil'))) {
            console.log(`  → Clicking button: "${btnText}"`);
            await btn.click();
            await delay(3000);
            break;
          }
        }
        
        // Try scraping table data after search
        const tableData = await page.evaluate(() => {
          const rows = document.querySelectorAll('table tbody tr, table tr');
          const data = [];
          rows.forEach((row, i) => {
            if (i > 50) return;
            const cells = Array.from(row.querySelectorAll('td, th'));
            const texts = cells.map(c => c.textContent?.trim() || '');
            if (texts.length >= 3) data.push(texts);
          });
          return data;
        });
        
        console.log(`  → Table rows found: ${tableData.length}`);
        if (tableData.length > 0) {
          console.log('  → First 3 rows:');
          tableData.slice(0, 3).forEach(row => console.log(`     ${row.join(' | ')}`));
        }
        
        await page.screenshot({ path: '/tmp/idx-after-search.png', fullPage: true });
      }
    } catch (e) {
      console.log(`  → Table scrape error: ${e.message}`);
    }

    // Step 5: Try alternative data source - check if IDX has other public endpoints
    console.log('\nStep 5: Testing alternative IDX endpoints...');
    
    const altEndpoints = [
      'https://www.idx.co.id/primary/StockData/GetStockData?length=10&start=0',
      'https://www.idx.co.id/primary/ListedCompany/GetCompanyProfilesData?length=10&start=0',
      'https://pasardata.idx.co.id/trade/broker-summary',
    ];
    
    for (const url of altEndpoints) {
      const res = await page.evaluate(async (u) => {
        try {
          const r = await fetch(u, { credentials: 'include' });
          return { status: r.status, ok: r.ok };
        } catch (e) { return { error: e.message }; }
      }, url);
      console.log(`  → ${url.split('/').slice(-2).join('/')}: ${JSON.stringify(res)}`);
    }

  } catch (err) {
    console.error(`\n❌ Fatal error: ${err.message}`);
  } finally {
    await browser.close();
  }
  
  console.log('\n📋 Test complete.');
}

testIDXScrape();
