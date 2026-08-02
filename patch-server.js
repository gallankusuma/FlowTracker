const fs = require('fs');
const file = '/var/www/flowtracker-scraper/server.js';
let c = fs.readFileSync(file, 'utf8');
const target = '  await setupDB();';
const replacement = `  await setupDB();
  // Register ticker-detail API
  require("./ticker-detail-api")(app, pool, formatVal, formatLot);`;
c = c.replace(target, replacement);
fs.writeFileSync(file, c, 'utf8');
console.log('Patched server.js to include ticker-detail-api');
