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
const decodeHexToString = (hex) => Buffer.from(hex, 'hex').toString();
const decodeHexToBigInt = (hex) => BigInt(`0x${hex}`);

async function fetchTokenDecimals(tokenId, cache) {
  if (cache[tokenId] !== undefined) return cache[tokenId];
  try {
    const { data } = await axios.get(`https://api.multiversx.com/tokens/${tokenId}`);
    cache[tokenId] = data.decimals;
    return data.decimals;
  } catch {
    cache[tokenId] = 18;
    return 18;
  }
}

function extractRewardAmountFromLogs(logs, walletAddress) {
  const rewards = [];
  if (!logs || !Array.isArray(logs)) return rewards;
  for (const log of logs) {
    const events = log.events || [];
    for (const event of events) {
      if ((event.identifier || '').toLowerCase() === 'esdtnfttransfer') {
        const topics = event.topics || [];
        if (topics.length >= 3 && event.address === walletAddress) {
          const tokenHex = topics[0];
          const nonce = topics[1];
          const amountHex = topics[2];
          const tokenId = decodeHexToString(tokenHex);
          const amount = decodeHexToBigInt(amountHex);
          rewards.push({ tokenId, amount });
        }
      }
    }
  }
  return rewards;
}

app.post('/fetch-transactions', async (req, res) => {
  const { walletAddress, fromDate, toDate, clientId } = req.body;

  if (!walletAddress || !fromDate || !toDate || !clientId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  reportProgress(clientId, '📡 Validating address...');
  if (!validateWalletAddress(walletAddress)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const fromTimestamp = Math.floor(new Date(fromDate).getTime() / 1000);
  const toTimestamp = Math.floor(new Date(toDate).getTime() / 1000);

  let allTransactions = [], transfers = [], tokenDecimalsCache = {}, enriched = [];

  try {
    await axios.get(`https://api.multiversx.com/accounts/${walletAddress}`);

    reportProgress(clientId, '🔍 Fetching transactions...');
    for (let i = 0; i < 10000; i += 1000) {
      const { data } = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transactions`, {
        params: {
          from: i,
          size: 1000,
          after: fromTimestamp,
          before: toTimestamp,
          order: 'asc'
        }
      });
      allTransactions.push(...data);
      reportProgress(clientId, `📦 Got ${allTransactions.length} transactions...`);
      await delay(RATE_LIMIT_DELAY);
      if (data.length < 1000) break;
    }

    reportProgress(clientId, '🔄 Processing transactions...');
    for (const tx of allTransactions) {
      const func = (tx.function || '').toLowerCase();
      let inAmount = '', inCurrency = '', outAmount = '', outCurrency = '';

      if (['claimrewards', 'claimrewardsproxy'].includes(func)) {
        const txDetails = await axios.get(`https://api.multiversx.com/transactions/${tx.txHash}`);
        const rewards = extractRewardAmountFromLogs(txDetails.data.logs?.events, walletAddress);
        if (rewards.length > 0) {
          const { tokenId, amount } = rewards[0];
          const decimals = await fetchTokenDecimals(tokenId, tokenDecimalsCache);
          inAmount = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed();
          inCurrency = tokenId;
        }
      }

      enriched.push({
        timestamp: tx.timestamp,
        function: func,
        inAmount,
        inCurrency,
        outAmount,
        outCurrency,
        fee: tx.fee,
        txHash: tx.txHash
      });
    }

    reportProgress(clientId, `✅ Filtered ${enriched.length} tax-relevant transactions.`);
    reportProgress(clientId, '✅ Done');
    res.json({ allTransactions, taxRelevantTransactions: enriched });
  } catch (err) {
    console.error(err);
    reportProgress(clientId, '❌ Failed');
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
});
