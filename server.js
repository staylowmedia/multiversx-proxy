// Updated server.js to properly extract XMEX and other ESDT rewards from SCResults
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

function decodeHexToString(hex) {
  return Buffer.from(hex, 'hex').toString();
}

function decodeHexToBigInt(hex) {
  return BigInt(`0x${hex}`);
}

function decodeBase64ToString(base64) {
  return Buffer.from(base64, 'base64').toString();
}

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

app.post('/fetch-transactions', async (req, res) => {
  const { walletAddress, fromDate, toDate, clientId } = req.body;

  if (!walletAddress || !fromDate || !toDate || !clientId)
    return res.status(400).json({ error: 'Missing required parameters' });

  const startTimestamp = Math.floor(new Date(fromDate).getTime() / 1000);
  const endTimestamp = Math.floor(new Date(toDate).getTime() / 1000);

  let allTransactions = [], transfers = [], tokenDecimalsCache = {};
  const taxRelevantFunctions = [
    'claimrewards', 'claim', 'claimrewardsproxy', 'redelegaterewards',
    'swaptokensfixedinput', 'swaptokensfixedoutput', 'multipairswap',
    'transfer', 'wrapegld', 'unwrapegld', 'aggregateegld', 'aggregateesdt',
    'esdttransfer', 'esdtnfttransfer', 'multiesdtnfttransfer', 'buy', 'sell',
    'withdraw', 'claimlockedassets'
  ];

  try {
    reportProgress(clientId, 'Fetching transactions...');
    for (let from = 0; from < 10000; from += 1000) {
      const txRes = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transactions`, {
        params: {
          after: startTimestamp,
          before: endTimestamp,
          size: 1000,
          order: 'asc',
          from
        }
      });
      allTransactions.push(...txRes.data);
      reportProgress(clientId, `Fetched ${allTransactions.length} transactions...`);
      if (txRes.data.length < 1000) break;
      await delay(RATE_LIMIT_DELAY);
    }

    const taxRelevantTransactions = allTransactions.filter(tx => {
      return (tx.timestamp >= startTimestamp && tx.timestamp <= endTimestamp &&
              (taxRelevantFunctions.includes(tx.function?.toLowerCase()) || tx.action === 'scCall'));
    });

    for (let tx of taxRelevantTransactions) {
      tx.inAmount = '0';
      tx.outAmount = '0';
      tx.inCurrency = 'EGLD';
      tx.outCurrency = 'EGLD';
      tx.fee = tx.fee || '0';

      const detailed = await axios.get(`https://api.multiversx.com/transactions/${tx.txHash}`);
      const scResults = detailed.data.results || [];

      for (const scr of scResults) {
        if (!scr.data || scr.receiver !== walletAddress) continue;
        const decoded = decodeBase64ToString(scr.data);
        if (!decoded.startsWith('ESDTTransfer@') && !decoded.startsWith('ESDTNFTTransfer@')) continue;

        const parts = decoded.split('@');
        if (parts.length >= 3) {
          const token = decodeHexToString(parts[1]);
          const value = decodeHexToBigInt(parts[2]);
          const decimals = await fetchTokenDecimals(token, tokenDecimalsCache);
          const formatted = new BigNumber(value.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed(decimals);
          if (tx.inAmount === '0') {
            tx.inAmount = formatted;
            tx.inCurrency = token;
          }
        }
      }
    }

    reportProgress(clientId, `Done! Found ${taxRelevantTransactions.length} tax-relevant transactions.`);
    res.json({ allTransactions, taxRelevantTransactions });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

async function fetchTokenDecimals(token, cache) {
  if (cache[token]) return cache[token];
  try {
    const response = await axios.get(`https://api.multiversx.com/tokens/${token}`);
    cache[token] = response.data.decimals || 18;
  } catch {
    cache[token] = 18;
  }
  return cache[token];
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
