const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const cors = require('cors');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 });

app.use(cors());
app.use(express.json());

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const validateWalletAddress = (address) => {
  const addressPattern = /^erd1[0-9a-z]{58}$/;
  return addressPattern.test(address);
};

app.post('/fetch-transactions', async (req, res) => {
  const { walletAddress, fromDate, toDate } = req.body;

  if (!walletAddress || !fromDate || !toDate) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  if (!validateWalletAddress(walletAddress)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const fromDateObj = new Date(fromDate);
  const toDateObj = new Date(toDate);
  const startTimestamp = Math.floor(fromDateObj.getTime() / 1000);
  const endTimestamp = Math.floor(toDateObj.getTime() / 1000);

  if (isNaN(startTimestamp) || isNaN(endTimestamp)) {
    return res.status(400).json({ error: 'Invalid timestamps — could not convert fromDate/toDate to UNIX timestamps' });
  }

  if (fromDateObj > toDateObj) {
    return res.status(400).json({ error: 'Invalid date range' });
  }

  let allTransactions = [];
  let transfers = [];
  let tokenDecimalsCache = {};

  try {
    console.log(`📡 Verifying account ${walletAddress}`);
    await axios.get(`https://api.multiversx.com/accounts/${walletAddress}`);

    // Fetch transactions
    const pageSize = 500;
    let fromIndex = 0;

    while (true) {
      const params = {
        after: startTimestamp,
        before: endTimestamp,
        size: pageSize,
        order: 'asc',
        from: fromIndex
      };

      const response = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transactions`, { params });
      const data = response.data;

      console.log(`📥 Fetched ${data.length} transactions from index ${fromIndex}`);
      if (data.length === 0) break;

      allTransactions = allTransactions.concat(data);
      if (data.length < pageSize) break;

      fromIndex += pageSize;
      await delay(500);
    }

    // Fetch transfers (no from/to timestamps!)
    let transferIndex = 0;
    while (true) {
      const params = {
        start: transferIndex,
        size: pageSize,
        order: 'asc'
      };

      const response = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transfers`, { params });
      const batch = response.data;

      console.log(`🔄 Fetched ${batch.length} transfers from index ${transferIndex}`);
      if (batch.length === 0) break;

      transfers = transfers.concat(batch);
      if (batch.length < pageSize) break;

      transferIndex += pageSize;
      await delay(500);
    }

    // Filter relevant transactions
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
      const hasValue = tx.value && BigInt(tx.value) > 0;
      const withinDate = tx.timestamp >= startTimestamp && tx.timestamp <= endTimestamp;
      return withinDate && (hasValue || taxRelevantFunctions.includes(func));
    });

    const fetchTokenDecimals = async (tokenIdentifier) => {
      if (tokenIdentifier === 'EGLD') return 18;
      if (tokenDecimalsCache[tokenIdentifier]) return tokenDecimalsCache[tokenIdentifier];

      try {
        const response = await axios.get(`https://api.multiversx.com/tokens/${tokenIdentifier}`);
        const decimals = response.data.decimals || 18;
        tokenDecimalsCache[tokenIdentifier] = decimals;
        return decimals;
      } catch {
        return 18;
      }
    };

    for (let tx of taxRelevantTransactions) {
      tx.inAmount = '0';
      tx.inCurrency = 'EGLD';
      tx.outAmount = '0';
      tx.outCurrency = 'EGLD';

      const related = transfers.filter(t => t.txHash === tx.txHash);

      const inTransfer = related.find(t => t.receiver === walletAddress);
      const outTransfer = related.find(t => t.sender === walletAddress);

      if (inTransfer) {
        const decimals = await fetchTokenDecimals(inTransfer.identifier);
        tx.inAmount = (BigInt(inTransfer.value) / BigInt(10 ** decimals)).toString();
        tx.inCurrency = inTransfer.identifier;
      }

      if (outTransfer) {
        const decimals = await fetchTokenDecimals(outTransfer.identifier);
        tx.outAmount = (BigInt(outTransfer.value) / BigInt(10 ** decimals)).toString();
        tx.outCurrency = outTransfer.identifier;
      }

      if (tx.inAmount === '0' && tx.outAmount === '0') {
        if (BigInt(tx.value || 0) > 0) {
          if (tx.sender === walletAddress) {
            tx.outAmount = (BigInt(tx.value) / BigInt(10 ** 18)).toString();
          } else if (tx.receiver === walletAddress) {
            tx.inAmount = (BigInt(tx.value) / BigInt(10 ** 18)).toString();
          }
        }
      }
    }

    res.json({ allTransactions, taxRelevantTransactions });

  } catch (error) {
    console.error('❌ Error in fetch-transactions:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
});
