// Forge JWT to call xfact's API and get market summary data
require('dotenv').config();
const jwt = require('jsonwebtoken');
const axios = require('axios');

const JWT_SECRET = process.env.JWT_SECRET;

// Forge an admin token
const token = jwt.sign(
  { id: 1, email: 'gallankusuma41@gmail.com', role: 'admin' },
  JWT_SECRET,
  { expiresIn: '1h' }
);

console.log('Token forged:', token.substring(0, 50) + '...');

async function test() {
  try {
    const res = await axios.get('http://localhost:3001/api/broker-tracker', {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    const data = res.data;
    console.log('Response keys:', Object.keys(data));
    if (data.tickers) {
      console.log('Tickers count:', data.tickers.length);
      data.tickers.slice(0, 5).forEach(t => {
        console.log(t.code || t.ticker, 'price:', t.marketPrice || t.price, 'conc:', t.concentration);
      });
    } else if (data.data) {
      const items = Array.isArray(data.data) ? data.data : Object.entries(data.data).slice(0, 5);
      console.log('Data sample:', JSON.stringify(items.slice(0, 3)).substring(0, 300));
    } else {
      console.log('Full response:', JSON.stringify(data).substring(0, 500));
    }
  } catch (err) {
    console.log('Error:', err.response?.status, JSON.stringify(err.response?.data || err.message).substring(0, 200));
  }
}
test();
