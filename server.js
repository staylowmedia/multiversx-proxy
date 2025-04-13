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

function decodeBase64ToString(base64) {
  try { return Buffer.from(base64, 'base64').toString(); } catch { return ''; }
}
function decodeBase64ToHex(base64) {
  try { return Buffer.from(base64, 'base64').toString('hex'); } catch { return '0'; }
}
function decodeHexToString(hex) {
  try { return Buffer.from(hex, 'hex').toString(); } catch { return ''; }
}
function decodeHexToBigInt(hex) {
  try { return BigInt(`0x${hex}`); } catch { return BigInt(0); }
}

function deduplicateTransactions(transactions) {
  const seen = new Map();
  const result = [];

  for (const tx of transactions) {
    const normalizedFunc = (tx.function || '').toLowerCase();
    const key = `${tx.txHash}:${normalizedFunc}`;
    if (!seen.has(key)) {
      seen.set(key, { ...tx, function: normalizedFunc });
      result.push(seen.get(key));
    } else {
      console.log(`⚠️ Duplicate skipped: ${key}`);
    }
  }

  return result;
}

async function getTokenDecimals(token, cache) {
  if (!token || token === 'EGLD') return 18;
  if (cache[token]) return cache[token];
  try {
    const res = await axios.get(`https://api.multiversx.com/tokens/${token}`);
    const decimals = res.data.decimals || 18;
    cache[token] = decimals;
    return decimals;
  } catch (e) {
    console.warn(`⚠️ Could not fetch decimals for ${token}`);
    return 18;
  }
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

  const fromTs = Math.floor(new Date(fromDate).getTime() / 1000);
  const toTs = Math.floor(new Date(toDate).getTime() / 1000);
  let allTransactions = [], tokenDecimalsCache = {};
  const taxRelevantTransactions = [];

  try {
    reportProgress(clientId, '🔍 Fetching transactions...');
    for (let from = 0; from < 10000; from += 1000) {
      const res = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transactions`, {
        params: { after: fromTs, before: toTs, size: 1000, order: 'asc', from }
      });
      allTransactions.push(...res.data);
      reportProgress(clientId, `📦 ${allTransactions.length} transactions...`);
      if (res.data.length < 1000) break;
    }

    for (const [i, tx] of allTransactions.entries()) {
      const func = (tx.function || '').toLowerCase();
      reportProgress(clientId, `🔍 Analyzing ${i + 1}/${allTransactions.length}`);

      if (!['claimrewards', 'claimrewardsproxy'].includes(func)) continue;

      const details = await axios.get(`https://api.multiversx.com/transactions/${tx.txHash}?withLogs=true&withOperations=true`);
      const logs = details.data.logs?.events || [];
      const rewardEvents = logs.filter(e => ['ESDTTransfer', 'ESDTNFTTransfer'].includes(e.identifier));

      for (const event of rewardEvents) {
        const token = decodeBase64ToString(event.topics?.[0] || '') || 'UNKNOWN';
        const amountHex = decodeBase64ToHex(event.topics?.[2] || '0');
        const amount = decodeHexToBigInt(amountHex);
        if (!token || amount <= 0n) continue;

        const decimals = await getTokenDecimals(token, tokenDecimalsCache);
        const formatted = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed();

        taxRelevantTransactions.push({
          timestamp: tx.timestamp,
          function: func,
          inAmount: formatted,
          inCurrency: token,
          outAmount: '0',
          outCurrency: 'EGLD',
          fee: new BigNumber(tx.fee || 0).div(1e18).toString(),
          txHash: tx.txHash
        });
      }
    }

    const deduped = deduplicateTransactions(taxRelevantTransactions);
    const result = { allTransactions, taxRelevantTransactions: deduped };
    cache.set(cacheKey, result);
    reportProgress(clientId, '✅ Done');
    res.json(result);
  } catch (err) {
    console.error('❌ Error:', err.message);
    reportProgress(clientId, '❌ Failed');
    res.status(500).json({ error: 'Could not process transactions' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
});
