// Read xfact SQLite cache and export market summary as JSON
const Database = require('better-sqlite3');
const db = new Database('/var/www/xfact/backend/flowtracker.db', { readonly: true });

// List all cache keys
const keys = db.prepare('SELECT cache_key, LENGTH(response_data) as sz, cached_at FROM api_cache ORDER BY cached_at DESC LIMIT 20').all();
console.log('Cache keys:', JSON.stringify(keys, null, 2));

// Find market summary entry
const mktEntry = db.prepare("SELECT response_data, cached_at FROM api_cache WHERE cache_key LIKE '%market-summary%' ORDER BY cached_at DESC LIMIT 1").get();
if (mktEntry) {
  const data = JSON.parse(mktEntry.response_data);
  // Find DataTable rows
  const children = data?.data?.content?.response?.['market-summary']?.children || [];
  let dataRows = null;
  for (const child of children) {
    const inner = child?.props?.children;
    if (Array.isArray(inner)) {
      for (const c of inner) {
        if (c?.type === 'DataTable' && Array.isArray(c?.props?.data)) {
          dataRows = c.props.data;
          break;
        }
      }
    }
    if (dataRows) break;
  }
  if (dataRows) {
    console.log(`Found ${dataRows.length} ticker rows`);
    // Show first few
    dataRows.slice(0, 5).forEach(row => {
      const match = (row.symbol || '').match(/>([A-Z]{1,6})</);
      if (match) console.log(match[1], 'price:', row.price, 'dn0:', row['dn-0'], 'dn1:', row['dn-1']);
    });
  } else {
    console.log('No DataTable found. Keys:', Object.keys(data?.data?.content?.response || {}));
  }
} else {
  console.log('No market-summary cache found');
}
db.close();
