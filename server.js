// server.js (oppdatert med forbedret SCResult-håndtering og statusrapportering)
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
const decodeHexToString = hex => Buffer.from(hex, 'hex').toString();
const decodeHexToBigInt = hex => BigInt(`0x${hex}`);
const decodeBase64ToString = base64 => Buffer.from(base64, 'base64').toString();

const fetchTokenDecimals = async (tokenId, cacheMap) => {
  if (cacheMap[tokenId]) return cacheMap[tokenId];
  try {
    const { data } = await axios.get(`https://api.multiversx.com/tokens/${tokenId}`);
    cacheMap[tokenId] = data.decimals || 18;
    return cacheMap[tokenId];
  } catch {
    cacheMap[tokenId] = 18;
    return 18;
  }
};

app.post('/fetch-transactions', async (req, res) => {
  const { walletAddress, fromDate, toDate, clientId } = req.body;
  if (!walletAddress || !fromDate || !toDate || !clientId) return res.status(400).json({ error: 'Missing required parameters' });
  if (!validateWalletAddress(walletAddress)) return res.status(400).json({ error: 'Invalid wallet address' });

  const fromTs = Math.floor(new Date(fromDate).getTime() / 1000);
  const toTs = Math.floor(new Date(toDate).getTime() / 1000);
  let allTransactions = [], transfers = [], tokenDecimalsCache = {};

  try {
    reportProgress(clientId, '📡 Validating address...');
    await axios.get(`https://api.multiversx.com/accounts/${walletAddress}`);

    reportProgress(clientId, '🔍 Fetching transactions...');
    const pageSize = 1000;
    for (let fromIndex = 0; fromIndex < 10000; fromIndex += pageSize) {
      const params = { after: fromTs, before: toTs, size: pageSize, order: 'asc', from: fromIndex };
      const { data: txs } = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transactions`, { params });
      allTransactions.push(...txs);
      reportProgress(clientId, `📦 Got ${allTransactions.length} transactions...`);
      if (txs.length < pageSize) break;
      await delay(RATE_LIMIT_DELAY);
    }

    reportProgress(clientId, '🔄 Fetching transfers...');
    const SECONDS_IN_DAY = 86400;
    for (let ts = fromTs; ts < toTs; ts += SECONDS_IN_DAY) {
      let startIndex = 0;
      while (true) {
        const params = { after: ts, before: Math.min(ts + 86398, toTs), size: 500, order: 'asc', start: startIndex };
        const { data: chunk } = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transfers`, { params });
        transfers.push(...chunk);
        reportProgress(clientId, `🔄 Transfers: ${transfers.length} so far...`);
        if (chunk.length < 500) break;
        startIndex += 500;
        await delay(RATE_LIMIT_DELAY);
      }
    }

    const taxRelevantFunctions = [
      'claimrewards', 'claimrewardsproxy', 'redelegaterewards', 'claim',
      'swaptokensfixedinput', 'swaptokensfixedoutput', 'aggregateegld',
      'esdttransfer', 'esdtnfttransfer', 'multiesdtnfttransfer'
    ];

    const relevantTxs = allTransactions.filter(tx => {
      const func = (tx.function || '').toLowerCase();
      return tx.timestamp >= fromTs && tx.timestamp <= toTs &&
        (transfers.some(t => t.txHash === tx.txHash) || taxRelevantFunctions.includes(func));
    });

    for (const tx of relevantTxs) {
      tx.inAmount = '0';
      tx.outAmount = '0';
      tx.inCurrency = 'EGLD';
      tx.outCurrency = 'EGLD';
      try {
        const { data } = await axios.get(`https://api.multiversx.com/transactions/${tx.txHash}`);
        const results = data.results || [];

        for (const r of results) {
          if (!r.data) continue;
          const decoded = decodeBase64ToString(r.data);
          if (!decoded.toLowerCase().startsWith('esdtnfttransfer@')) continue;

          const parts = decoded.split('@');
          if (parts.length < 3) continue;

          const token = decodeHexToString(parts[1]);
          const rawAmount = decodeHexToBigInt(parts[2]);
          const decimals = await fetchTokenDecimals(token, tokenDecimalsCache);
          const amount = new BigNumber(rawAmount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed();

          if (r.receiver === walletAddress && amount !== '0') {
            tx.inAmount = amount;
            tx.inCurrency = token;
          }
        }
      } catch (err) {
        console.warn(`⚠️ Failed to fetch SCResult for tx ${tx.txHash}`);
      }
    }

    reportProgress(clientId, `✅ ${relevantTxs.length} tax-relevant transactions parsed.`);
    res.json({ allTransactions, taxRelevantTransactions: relevantTxs });
  } catch (e) {
    reportProgress(clientId, '❌ Error during processing.');
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Proxy server running on port ${PORT}`));
