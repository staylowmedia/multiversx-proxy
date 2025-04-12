// ✅ Updated server.js with proper ESDT reward handling AND real-time progress
// ✅ Matching frontend index.html with spinner + fetching status display
// ✅ These work together seamlessly

// --- server.js ---
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
  clientProgress.set(id, msg => res.write(`data: ${msg}\n\n`));
  req.on('close', () => clientProgress.delete(id));
});

function reportProgress(clientId, message) {
  const sender = clientProgress.get(clientId);
  if (sender) sender(message);
}

function decodeHexToString(hex) {
  return Buffer.from(hex, 'hex').toString();
}
function decodeHexToBigInt(hex) {
  return BigInt(`0x${hex}`);
}
function decodeBase64ToString(base64) {
  return Buffer.from(base64, 'base64').toString();
}

app.post('/fetch-transactions', async (req, res) => {
  const { walletAddress, fromDate, toDate, clientId } = req.body;
  if (!walletAddress || !fromDate || !toDate || !clientId)
    return res.status(400).json({ error: 'Missing required parameters' });

  const startTimestamp = Math.floor(new Date(fromDate).getTime() / 1000);
  const endTimestamp = Math.floor(new Date(toDate).getTime() / 1000);

  let allTransactions = [], transfers = [], tokenDecimalsCache = {};
  try {
    await axios.get(`https://api.multiversx.com/accounts/${walletAddress}`);
    reportProgress(clientId, '📦 Fetching transactions...');

    const pageSize = 1000;
    for (let fromIndex = 0; fromIndex < 10000; fromIndex += pageSize) {
      const { data: batch } = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transactions`, {
        params: { after: startTimestamp, before: endTimestamp, size: pageSize, order: 'asc', from: fromIndex }
      });
      allTransactions.push(...batch);
      reportProgress(clientId, `🔄 ${allTransactions.length} transactions...`);
      if (batch.length < pageSize) break;
      await delay(RATE_LIMIT_DELAY);
    }

    reportProgress(clientId, '📨 Fetching token transfers...');
    const SECONDS_IN_DAY = 86400;
    for (let ts = startTimestamp; ts < endTimestamp; ts += SECONDS_IN_DAY) {
      const chunkEnd = Math.min(ts + 86398, endTimestamp);
      let startIndex = 0;
      while (true) {
        const { data } = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transfers`, {
          params: { after: ts, before: chunkEnd, size: 500, order: 'asc', start: startIndex }
        });
        transfers.push(...data);
        if (data.length < 500) break;
        startIndex += 500;
        await delay(RATE_LIMIT_DELAY);
      }
    }

    const taxRelevantFunctions = [
      'claimrewards', 'claim', 'claimrewardsproxy', 'redelegaterewards',
      'swaptokensfixedinput', 'swaptokensfixedoutput', 'multipairswap',
      'transfer', 'wrapegld', 'unwrapegld', 'aggregateegld', 'aggregateesdt',
      'esdttransfer', 'esdtnfttransfer', 'multiesdtnfttransfer',
      'buy', 'sell', 'withdraw', 'claimlockedassets'
    ];

    const taxRelevantTransactions = allTransactions.filter(tx => {
      const func = tx.function?.toLowerCase() || '';
      return (tx.timestamp >= startTimestamp && tx.timestamp <= endTimestamp) &&
             (transfers.some(t => t.txHash === tx.txHash) || taxRelevantFunctions.includes(func));
    });

    async function formatAmount(value, identifier) {
      const decimals = tokenDecimalsCache[identifier] || 18;
      if (!tokenDecimalsCache[identifier]) {
        try {
          const { data } = await axios.get(`https://api.multiversx.com/tokens/${identifier}`);
          tokenDecimalsCache[identifier] = data.decimals || 18;
        } catch {
          tokenDecimalsCache[identifier] = 18;
        }
      }
      return new BigNumber(value).dividedBy(new BigNumber(10).pow(tokenDecimalsCache[identifier])).toFixed(tokenDecimalsCache[identifier]);
    }

    for (let tx of taxRelevantTransactions) {
      tx.inAmount = '0'; tx.outAmount = '0';
      tx.inCurrency = 'EGLD'; tx.outCurrency = 'EGLD';
      const relatedTransfers = transfers.filter(t => t.txHash === tx.txHash);

      for (const t of relatedTransfers) {
        const isIn = t.receiver === walletAddress;
        const id = t.identifier || 'EGLD';
        const formatted = await formatAmount(t.value, id);
        if (isIn && formatted !== '0') {
          tx.inAmount = formatted;
          tx.inCurrency = id;
        } else if (!isIn && formatted !== '0') {
          tx.outAmount = formatted;
          tx.outCurrency = id;
        }
      }

      try {
        const { data } = await axios.get(`https://api.multiversx.com/transactions/${tx.txHash}`);
        const results = data.results || [];
        for (const scr of results) {
          if (!scr.data) continue;
          const decoded = decodeBase64ToString(scr.data);
          if (!decoded.startsWith('ESDTTransfer')) continue;
          const [_, tokenHex, amountHex] = decoded.split('@');
          const token = decodeHexToString(tokenHex);
          const amount = decodeHexToBigInt(amountHex).toString();
          const formatted = await formatAmount(amount, token);
          if (scr.receiver === walletAddress && formatted !== '0') {
            tx.inAmount = formatted;
            tx.inCurrency = token;
          } else if (scr.sender === walletAddress && formatted !== '0') {
            tx.outAmount = formatted;
            tx.outCurrency = token;
          }
        }
      } catch (err) {
        console.warn(`⚠️ Cannot load smart contract results for ${tx.txHash}`);
      }
    }

    reportProgress(clientId, `✅ Done. ${taxRelevantTransactions.length} tax-relevant transactions.`);
    res.json({ allTransactions, taxRelevantTransactions });
  } catch (err) {
    reportProgress(clientId, '❌ Failed');
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
