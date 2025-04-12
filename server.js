// server.js
const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const cors = require('cors');
const BigNumber = require('bignumber.js');
const { v4: uuidv4 } = require('uuid');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 });
const clientProgress = new Map();

app.use(cors());
app.use(express.json());

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const RATE_LIMIT_DELAY = 500;

app.get('/progress/:id', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const id = req.params.id;
  clientProgress.set(id, (msg) => {
    res.write(`data: ${msg}\n\n`);
  });

  req.on('close', () => {
    clientProgress.delete(id);
  });
});

function reportProgress(clientId, message) {
  const sender = clientProgress.get(clientId);
  if (sender) sender(message);
}

const validateWalletAddress = (address) => /^erd1[0-9a-z]{58}$/.test(address);
function decodeHexToString(hex) { return Buffer.from(hex, 'hex').toString(); }
function decodeHexToBigInt(hex) { return BigInt(`0x${hex}`); }
function decodeBase64ToString(base64) { return Buffer.from(base64, 'base64').toString(); }

app.post('/fetch-transactions', async (req, res) => {
  const { walletAddress, fromDate, toDate, clientId } = req.body;

  if (!walletAddress || !fromDate || !toDate || !clientId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  reportProgress(clientId, '📡 Validating address...');
  if (!validateWalletAddress(walletAddress)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const fromDateObj = new Date(fromDate);
  const toDateObj = new Date(toDate);
  const startTimestamp = Math.floor(fromDateObj.getTime() / 1000);
  const endTimestamp = Math.floor(toDateObj.getTime() / 1000);

  if (fromDateObj > toDateObj) {
    return res.status(400).json({ error: 'Invalid date range' });
  }

  let allTransactions = [], transfers = [], tokenDecimalsCache = {};

  try {
    await axios.get(`https://api.multiversx.com/accounts/${walletAddress}`);

    reportProgress(clientId, '🔍 Fetching transactions...');
    const pageSize = 1000;
    for (let fromIndex = 0; fromIndex < 10000; fromIndex += pageSize) {
      const params = {
        after: startTimestamp,
        before: endTimestamp,
        size: pageSize,
        order: 'asc',
        from: fromIndex
      };
      const response = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transactions`, { params });
      const batch = response.data;
      allTransactions.push(...batch);
      reportProgress(clientId, `📦 Got ${allTransactions.length} transactions...`);
      await delay(RATE_LIMIT_DELAY);
      if (batch.length < pageSize) break;
    }

    const taxRelevantFunctions = [
      'claimrewards', 'claim', 'claimrewardsproxy'
    ];

    let taxRelevantTransactions = [];

    for (let i = 0; i < allTransactions.length; i++) {
      const tx = allTransactions[i];
      reportProgress(clientId, `🔍 Fetching ${i + 1} of ${allTransactions.length} transactions...`);
      const func = tx.function?.toLowerCase() || '';
      const isTaxRelevant = taxRelevantFunctions.includes(func);

      if (!isTaxRelevant) continue;

      try {
        const detailed = await axios.get(`https://api.multiversx.com/transactions/${tx.txHash}`);
        const scResults = detailed.data.results || [];

        const esdtTransfers = scResults.filter(r => r.data?.startsWith('RVNEVFRyYW5zZmVy'));

        for (const result of esdtTransfers) {
          const decodedData = decodeBase64ToString(result.data);
          const parts = decodedData.split('@');
          if (parts.length < 3) continue;

          const tokenHex = parts[1];
          const amountHex = parts[2];
          const token = decodeHexToString(tokenHex);
          const amount = decodeHexToBigInt(amountHex);
          const decimals = tokenDecimalsCache[token] || 18;
          const formatted = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed();

          taxRelevantTransactions.push({
            timestamp: tx.timestamp,
            function: tx.function,
            inAmount: formatted,
            inCurrency: token,
            outAmount: '0',
            outCurrency: 'EGLD',
            fee: tx.fee || '0',
            txHash: tx.txHash
          });
        }

        // If no tokens, add empty fallback
        if (esdtTransfers.length === 0) {
          taxRelevantTransactions.push({
            timestamp: tx.timestamp,
            function: tx.function,
            inAmount: '0',
            inCurrency: 'EGLD',
            outAmount: '0',
            outCurrency: 'EGLD',
            fee: tx.fee || '0',
            txHash: tx.txHash
          });
        }
      } catch (err) {
        console.warn(`⚠️ Could not fetch SC result for tx ${tx.txHash}:`, err.message);
      }
    }

    reportProgress(clientId, `✅ Done`);
    res.json({ allTransactions, taxRelevantTransactions });
  } catch (error) {
    console.error('❌ Error in fetch-transactions:', error);
    reportProgress(clientId, '❌ Failed');
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
});
