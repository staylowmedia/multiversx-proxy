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

app.get('/progress/:id', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const id = req.params.id;
  clientProgress.set(id, msg => {
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

function deduplicateTransactions(transactions) {
  const seen = new Map();
  const result = [];

  for (const tx of transactions) {
    const normalizedFunc = (tx.function || '').toLowerCase();
    const key = `${tx.txHash}:${normalizedFunc}`;
    if (!seen.has(key)) {
      seen.set(key, { ...tx, function: normalizedFunc, inAmounts: [], outAmounts: [] });
      result.push(seen.get(key));
    } else {
      const existing = seen.get(key);
      if (tx.inAmount !== '0' && !existing.inAmounts.some(a => a.amount === tx.inAmount && a.currency === tx.inCurrency)) {
        if (existing.inAmount === '0') {
          existing.inAmount = tx.inAmount;
          existing.inCurrency = tx.inCurrency;
        }
        existing.inAmounts.push({ amount: tx.inAmount, currency: tx.inCurrency });
      }
      if (tx.outAmount !== '0' && !existing.outAmounts.some(a => a.amount === tx.outAmount && a.currency === tx.outCurrency)) {
        if (existing.outAmount === '0') {
          existing.outAmount = tx.outAmount;
          existing.outCurrency = tx.outCurrency;
        }
        existing.outAmounts.push({ amount: tx.outAmount, currency: tx.outCurrency });
      }
      console.log(`⚠️ Merged transaction: ${key}, in=${tx.inAmount} ${tx.inCurrency}, out=${tx.outAmount} ${tx.outCurrency}`);
    }
  }

  return result.map(tx => ({
    timestamp: tx.timestamp,
    function: tx.function,
    inAmount: tx.inAmount,
    inCurrency: tx.inCurrency,
    outAmount: tx.outAmount,
    outCurrency: tx.outCurrency,
    fee: tx.fee,
    txHash: tx.txHash
  }));
}

app.post('/fetch-transactions', async (req, res) => {
  const { walletAddress, fromDate, toDate, clientId } = req.body;

  if (!walletAddress || !fromDate || !toDate || !clientId) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  reportProgress(clientId, '📡 Validating address...');
  if (!/^erd1[0-9a-z]{58}$/.test(walletAddress)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const cacheKey = `${walletAddress}:${fromDate}:${toDate}`;
  if (cache.has(cacheKey)) {
    reportProgress(clientId, '✅ Loaded from cache');
    return res.json(cache.get(cacheKey));
  }

  const fromTimestamp = Math.floor(new Date(fromDate).getTime() / 1000);
  const toTimestamp = Math.floor(new Date(toDate).getTime() / 1000);
  let allTransactions = [];

  try {
    reportProgress(clientId, '🔍 Fetching transactions...');
    const pageSize = 1000;
    for (let from = 0; from < 10000; from += pageSize) {
      const params = {
        after: fromTimestamp,
        before: toTimestamp,
        size: pageSize,
        order: 'asc',
        from
      };
      const response = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transactions`, { params });
      const batch = response.data;
      allTransactions.push(...batch);
      reportProgress(clientId, `📦 Fetched ${allTransactions.length} transactions...`);
      if (batch.length < pageSize) break;
    }

    // Filter for tax-relevant functions
    const taxRelevantFunctions = [
      'claimrewards', 'claim', 'claimrewardsproxy',
      'swap_tokens_fixed_input', 'swap_tokens_fixed_output',
      'multipairswap', 'transfer', 'esdttransfer', 'multiesdtnfttransfer',
      'swap', 'send', 'receive', 'wrapegld', 'unwrapegld'
    ];
    const taxRelevantTransactions = [];

    for (const [index, tx] of allTransactions.entries()) {
      const func = (tx.function || '').toLowerCase();
      reportProgress(clientId, `🔍 Processing ${index + 1} of ${allTransactions.length}...`);
      if (taxRelevantFunctions.includes(func)) {
        taxRelevantTransactions.push({
          timestamp: tx.timestamp,
          function: func,
          inAmount: tx.value && tx.receiver === walletAddress ? new BigNumber(tx.value).div(1e18).toString() : '0',
          inCurrency: tx.value && tx.receiver === walletAddress ? 'EGLD' : '',
          outAmount: tx.value && tx.sender === walletAddress ? new BigNumber(tx.value).div(1e18).toString() : '0',
          outCurrency: tx.value && tx.sender === walletAddress ? 'EGLD' : '',
          fee: new BigNumber(tx.fee || 0).div(1e18).toString(),
          txHash: tx.txHash
        });
      }
    }

    const deduped = deduplicateTransactions(taxRelevantTransactions);
    const result = { allTransactions, taxRelevantTransactions: deduped };
    cache.set(cacheKey, result);
    reportProgress(clientId, '✅ Done');
    return res.json(result);

  } catch (err) {
    console.error('❌ Error fetching transactions:', err.message);
    reportProgress(clientId, '❌ Failed');
    return res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
});
