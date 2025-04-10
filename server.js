const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = [
  'https://www.multiversxdomain.com',
  'https://multiversxdomain.com',
  'http://www.multiversxdomain.com',
  'http://multiversxdomain.com',
  'http://localhost:5500'
];

const corsOptionsDelegate = function (req, callback) {
  const origin = req.header('Origin');
  if (!origin || allowedOrigins.includes(origin)) {
    callback(null, {
      origin: true,
      credentials: true
    });
  } else {
    console.warn('❌ Blocked by CORS:', origin);
    callback(new Error('Not allowed by CORS'));
  }
};

app.use(cors(corsOptionsDelegate));

app.get('/api/transactions/:wallet', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  const { wallet } = req.params;
  const { from = 0, size = 50 } = req.query;
  const url = `https://api.multiversx.com/accounts/${wallet}/transactions?size=${size}&from=${from}`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('❌ Error fetching transactions:', err);
    res.status(502)
       .setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
       .json({ error: 'Bad Gateway - Failed to fetch transactions' });
  }
});

app.get('/api/token/:identifier', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  const { identifier } = req.params;
  const url = `https://api.multiversx.com/tokens/${identifier}`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('❌ Error fetching token info:', err);
    res.status(502)
       .setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
       .json({ error: 'Bad Gateway - Failed to fetch token info' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Proxy server running on port ${PORT}`);
});
