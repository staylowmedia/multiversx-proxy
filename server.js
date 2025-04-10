const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// Tillat spesifikke domener (legg til flere hvis ønsket)
const allowedOrigins = [
  'http://www.multiversxdomain.com',
  'http://multiversxdomain.com',
  'https://www.multiversxdomain.com',
  'https://multiversxdomain.com',
  'http://localhost:5500'
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log('❌ Blocked by CORS:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  }
};

app.use(cors(corsOptions));

app.get('/api/transactions/:wallet', async (req, res) => {
  const { wallet } = req.params;
  const { from = 0, size = 50 } = req.query;
  const url = `https://api.multiversx.com/accounts/${wallet}/transactions?size=${size}&from=${from}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('❌ Error fetching transactions:', err);
    res.status(502).json({ error: 'Bad Gateway - Failed to fetch transactions' });
  }
});

app.get('/api/token/:identifier', async (req, res) => {
  const { identifier } = req.params;
  const url = `https://api.multiversx.com/tokens/${identifier}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('❌ Error fetching token info:', err);
    res.status(502).json({ error: 'Bad Gateway - Failed to fetch token info' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Proxy server running on port ${PORT}`);
});
