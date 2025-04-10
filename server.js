const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

app.get('/api/transactions/:wallet', async (req, res) => {
  const { wallet } = req.params;
  const { from = 0, size = 50 } = req.query;
  const url = `https://api.multiversx.com/accounts/${wallet}/transactions?size=${size}&from=${from}`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch transactions' });
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
    res.status(500).json({ error: 'Failed to fetch token info' });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
