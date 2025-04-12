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

    reportProgress(clientId, '🔄 Fetching transfers...');
    const SECONDS_IN_DAY = 86400;
    for (let ts = startTimestamp; ts < endTimestamp; ts += SECONDS_IN_DAY) {
      const chunkStart = ts;
      const chunkEnd = Math.min(ts + 86398, endTimestamp);
      let startIndex = 0;
      while (true) {
        const params = {
          after: chunkStart,
          before: chunkEnd,
          size: 500,
          order: 'asc',
          start: startIndex
        };
        const response = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transfers`, { params });
        transfers.push(...response.data);
        reportProgress(clientId, `🔄 Transfers: ${transfers.length} so far...`);
        await delay(RATE_LIMIT_DELAY);
        if (response.data.length < 500) break;
        startIndex += 500;
      }
    }

    const taxRelevantFunctions = [
      'claimrewards', 'claim', 'claimrewardsproxy', 'redelegaterewards',
      'swaptokensfixedinput', 'swaptokensfixedoutput', 'multipairswap',
      'transfer', 'wrapegld', 'unwrapegld',
      'aggregateegld', 'aggregateesdt',
      'esdttransfer', 'esdtnfttransfer', 'multiesdtnfttransfer',
      'buy', 'sell', 'withdraw', 'claimlockedassets'
    ];

    const taxRelevantTransactions = allTransactions.filter(tx => {
      const func = tx.function?.toLowerCase() || '';
      return (tx.timestamp >= startTimestamp && tx.timestamp <= endTimestamp) &&
             (transfers.some(t => t.txHash === tx.txHash) || taxRelevantFunctions.includes(func));
    });

    // 🔁 Extract token values
    for (let tx of taxRelevantTransactions) {
      tx.inAmount = tx.outAmount = '0';
      tx.inCurrency = tx.outCurrency = 'EGLD';

      const relatedTransfers = transfers.filter(t => t.txHash === tx.txHash);
      for (let t of relatedTransfers) {
        const isIn = t.receiver === walletAddress;
        let identifier = t.identifier || 'EGLD';
        let value = t.value || '0';

        if (t.data?.startsWith('RVNEVFRyYW5zZmVy')) {
          const decoded = decodeBase64ToString(t.data).split('@');
          if (decoded.length >= 3) {
            identifier = decodeHexToString(decoded[1]);
            value = decodeHexToBigInt(decoded[2]).toString();
          }
        }

        const decimals = await fetchTokenDecimals(identifier, tokenDecimalsCache);
        const formatted = new BigNumber(value).dividedBy(new BigNumber(10).pow(decimals)).toFixed(decimals);
        if (isIn && tx.inAmount === '0') {
          tx.inAmount = formatted;
          tx.inCurrency = identifier;
        } else if (!isIn && tx.outAmount === '0') {
          tx.outAmount = formatted;
          tx.outCurrency = identifier;
        }
      }
    }

    reportProgress(clientId, `✅ Filtered ${taxRelevantTransactions.length} tax-relevant transactions.`);
    reportProgress(clientId, '✅ Done');

    res.json({ allTransactions, taxRelevantTransactions });
  } catch (error) {
    console.error('❌ Error in fetch-transactions:', error);
    reportProgress(clientId, '❌ Failed');
    res.status(500).json({ error: error.message });
  }
});

async function fetchTokenDecimals(identifier, cache) {
  if (cache[identifier]) return cache[identifier];
  const known = { 'EGLD': 18, 'WEGLD-bd4d79': 18, 'MEX-43535633537': 18 };
  if (known[identifier]) return known[identifier];
  try {
    const res = await axios.get(`https://api.multiversx.com/tokens/${identifier}`);
    const decimals = res.data.decimals || 18;
    cache[identifier] = decimals;
    return decimals;
  } catch {
    return 18;
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
});
