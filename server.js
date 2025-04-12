// server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const BigNumber = require('bignumber.js');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const RATE_LIMIT_DELAY = 500;
const clientProgress = new Map();

function decodeBase64ToString(base64) {
  return Buffer.from(base64, 'base64').toString();
}
function decodeHexToString(hex) {
  return Buffer.from(hex, 'hex').toString();
}
function decodeHexToBigInt(hex) {
  return BigInt(`0x${hex}`);
}

app.get('/progress/:id', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const id = req.params.id;
  clientProgress.set(id, (msg) => res.write(`data: ${msg}\n\n`));
  req.on('close', () => clientProgress.delete(id));
});

function reportProgress(clientId, message) {
  const sender = clientProgress.get(clientId);
  if (sender) sender(message);
}

const fetchTokenDecimals = async (identifier, cache) => {
  if (identifier === 'EGLD') return 18;
  if (cache[identifier]) return cache[identifier];
  try {
    const { data } = await axios.get(`https://api.multiversx.com/tokens/${identifier}`);
    cache[identifier] = data.decimals || 18;
    return cache[identifier];
  } catch {
    cache[identifier] = 18;
    return 18;
  }
};

app.post('/fetch-transactions', async (req, res) => {
  const { walletAddress, fromDate, toDate, clientId } = req.body;
  if (!walletAddress || !fromDate || !toDate || !clientId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }
  const start = Math.floor(new Date(fromDate).getTime() / 1000);
  const end = Math.floor(new Date(toDate).getTime() / 1000);
  const tokenDecimalsCache = {};
  const allTx = [], txMap = new Map();

  try {
    reportProgress(clientId, '🔍 Fetching transactions...');
    const pageSize = 1000;
    for (let i = 0; i < 10000; i += pageSize) {
      const { data } = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transactions`, {
        params: { from: i, size: pageSize, order: 'asc', after: start, before: end }
      });
      if (data.length === 0) break;
      allTx.push(...data);
      reportProgress(clientId, `📦 Fetching ${allTx.length} transactions so far...`);
      await delay(RATE_LIMIT_DELAY);
      if (data.length < pageSize) break;
    }

    const taxRelevant = [];
    for (const tx of allTx) {
      const { data } = await axios.get(`https://api.multiversx.com/transactions/${tx.txHash}`);
      const scResults = data.results || [];
      const rewards = scResults.filter(r => r.data && r.data.startsWith('RVNEVFRyYW5zZmVy'));

      if (rewards.length === 0) {
        taxRelevant.push({
          ...tx,
          inAmount: '0', inCurrency: 'EGLD',
          outAmount: '0', outCurrency: 'EGLD'
        });
        continue;
      }

      for (const r of rewards) {
        const decoded = decodeBase64ToString(r.data);
        const parts = decoded.split('@');
        if (parts.length < 3) continue;
        const token = decodeHexToString(parts[1]);
        const raw = decodeHexToBigInt(parts[2]);
        const decimals = await fetchTokenDecimals(token, tokenDecimalsCache);
        const amount = new BigNumber(raw.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed(decimals);
        taxRelevant.push({
          ...tx,
          inAmount: amount,
          inCurrency: token,
          outAmount: '0',
          outCurrency: 'EGLD'
        });
      }
      await delay(50);
    }

    reportProgress(clientId, `✅ Fetched ${allTx.length} total. ${taxRelevant.length} tax-relevant.`);
    res.json({ allTransactions: allTx, taxRelevantTransactions: taxRelevant });
  } catch (err) {
    console.error(err);
    reportProgress(clientId, '❌ Error during fetch');
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Running on port ${PORT}`));
