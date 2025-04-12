// server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const BigNumber = require('bignumber.js');
const NodeCache = require('node-cache');
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

  req.on('close', () => {
    clientProgress.delete(id);
  });
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

const validateWalletAddress = address => /^erd1[0-9a-z]{58}$/.test(address);

app.post('/fetch-transactions', async (req, res) => {
  const { walletAddress, fromDate, toDate, clientId } = req.body;

  if (!walletAddress || !fromDate || !toDate || !clientId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  if (!validateWalletAddress(walletAddress)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const fromDateObj = new Date(fromDate);
  const toDateObj = new Date(toDate);
  const startTimestamp = Math.floor(fromDateObj.getTime() / 1000);
  const endTimestamp = Math.floor(toDateObj.getTime() / 1000);

  let allTransactions = [];
  let transfers = [];
  let tokenDecimalsCache = {};

  try {
    reportProgress(clientId, `📡 Verifying account ${walletAddress}`);
    await axios.get(`https://api.multiversx.com/accounts/${walletAddress}`);

    const pageSize = 100;
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

    for (let tx of taxRelevantTransactions) {
      tx.inAmount = '0';
      tx.inCurrency = 'EGLD';
      tx.outAmount = '0';
      tx.outCurrency = 'EGLD';

      const related = transfers.filter(t => t.txHash === tx.txHash);
      const inTransfer = related.find(t => t.receiver === walletAddress);
      const outTransfer = related.find(t => t.sender === walletAddress);

      const handleTransfer = async (transfer, isIn) => {
        if (!transfer) return;
        let identifier = transfer.identifier || 'EGLD';
        let value = transfer.value;

        if (transfer.data && transfer.data.startsWith('RVNEVFRyYW5zZmVy')) {
          const decodedData = decodeBase64ToString(transfer.data);
          const parts = decodedData.split('@');
          if (parts[0] === 'ESDTTransfer' && parts.length >= 3) {
            identifier = decodeHexToString(parts[1]);
            value = decodeHexToBigInt(parts[2]).toString();
          }
        }

        if (value && value !== '0') {
          const decimals = tokenDecimalsCache[identifier] || 18;
          const formatted = new BigNumber(value).dividedBy(new BigNumber(10).pow(decimals)).toFixed();
          if (isIn) {
            tx.inAmount = formatted;
            tx.inCurrency = identifier;
          } else {
            tx.outAmount = formatted;
            tx.outCurrency = identifier;
          }
        }
      };

      await handleTransfer(inTransfer, true);
      await handleTransfer(outTransfer, false);

      try {
        const details = await axios.get(`https://api.multiversx.com/transactions/${tx.txHash}`);
        const results = details.data.results || [];

        for (const scr of results) {
          const data = decodeBase64ToString(scr.data || '');
          if (data.startsWith('ESDTTransfer@') || data.startsWith('MultiESDTNFTTransfer@')) {
            const parts = data.split('@');
            if (parts.length >= 3) {
              const token = decodeHexToString(parts[1]);
              const amount = decodeHexToBigInt(parts[2]);
              const decimals = tokenDecimalsCache[token] || 18;
              const formatted = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed();
              if (scr.receiver === walletAddress && tx.inAmount === '0') {
                tx.inAmount = formatted;
                tx.inCurrency = token;
              }
              if (scr.sender === walletAddress && tx.outAmount === '0') {
                tx.outAmount = formatted;
                tx.outCurrency = token;
              }
            }
          }
        }
      } catch (err) {
        console.warn(`Failed to fetch SC results for ${tx.txHash}`);
      }
    }

    reportProgress(clientId, `✅ Done!`);
    res.json({ allTransactions, taxRelevantTransactions });
  } catch (err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
