require('dotenv').config();
const CryptoJS = require('crypto-js');
const axios = require('axios');

const FT_API_BASE = 'https://api.flowtracker.id/api';
const FT_EMAIL    = 'gallankusuma41@gmail.com';
const FT_PASSWORD = process.env.FT_PASS;
const FT_AES_KEY  = process.env.FT_KEY;

async function testLogin() {
  const enc = CryptoJS.AES.encrypt(FT_PASSWORD, FT_AES_KEY).toString();
  console.log('Encrypted password (first 40):', enc.substring(0, 40));
  
  try {
    const res = await axios.post(`${FT_API_BASE}/login`, {
      email: FT_EMAIL,
      password: enc,
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
    
    if (res.data?.token) {
      console.log('LOGIN OK! Token:', res.data.token.substring(0, 50));
      
      // Now test market summary
      const mkt = await axios.get(`${FT_API_BASE}/market-summary/latest`, {
        headers: { Authorization: `Bearer ${res.data.token}` },
        timeout: 20000,
      });
      const raw = JSON.stringify(mkt.data).substring(0, 300);
      console.log('Market summary response:', raw);
    } else {
      console.log('No token in response:', JSON.stringify(res.data).substring(0, 200));
    }
  } catch (err) {
    console.log('Error:', err.response?.status, JSON.stringify(err.response?.data || err.message).substring(0, 200));
  }
}

testLogin();
