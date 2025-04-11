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
    await axios.get(`https://api.multiversx.com/accounts/${walletAddress}`);

    // Fetch transactions
    const pageSize = 500;
    let fromIndex = 0;

    while (fromIndex + pageSize <= 10000) {
      const params = {
        after: startTimestamp,
        before: endTimestamp,
        size: pageSize,
        order: 'asc',
        from: fromIndex
      };
      const cacheKey = `transactions_${walletAddress}_${fromIndex}_${startTimestamp}_${endTimestamp}`;
      let transactions = cache.get(cacheKey);

      if (!transactions) {
        const response = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transactions`, { params });
        transactions = response.data;
        cache.set(cacheKey, transactions);
      }

      if (transactions && transactions.length > 0) {
        allTransactions = allTransactions.concat(transactions);
      }

      if (!transactions || transactions.length < pageSize) break;
      fromIndex += pageSize;
      await delay(500);
    }

    // Fetch transfers using `start` parameter
    let transferIndex = 0;
    const maxTransfersPerBatch = 500;

    while (true) {
      const params = {
        start: transferIndex,
        size: maxTransfersPerBatch,
        order: 'asc'
      };
      const cacheKey = `transfers_${walletAddress}_${transferIndex}`;
      let batch = cache.get(cacheKey);

      if (!batch) {
        try {
          const response = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transfers`, { params });
          batch = response.data;
          cache.set(cacheKey, batch);
        } catch (error) {
          console.error(`Transfer fetch failed at index ${transferIndex}:`, error.response?.data || error.message);
          break;
        }
      }

      if (batch && batch.length > 0) {
        transfers = transfers.concat(batch);
      }

      if (!batch || batch.length < maxTransfersPerBatch) break;
      transferIndex += maxTransfersPerBatch;
      await delay(500);
    }

    // Define tax-relevant functions
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

    // Helper for token decimals
    const fetchTokenDecimals = async (tokenIdentifier) => {
      if (tokenIdentifier === 'EGLD') return 18;
      if (tokenDecimalsCache[tokenIdentifier]) return tokenDecimalsCache[tokenIdentifier];

      const cacheKey = `tokenDecimals_${tokenIdentifier}`;
      let decimals = cache.get(cacheKey);
      if (!decimals) {
        try {
          const response = await axios.get(`https://api.multiversx.com/tokens/${tokenIdentifier}`);
          decimals = response.data.decimals || 18;
          cache.set(cacheKey, decimals);
        } catch {
          decimals = 18;
        }
      }
      tokenDecimalsCache[tokenIdentifier] = decimals;
      return decimals;
    };

    // Attach transfer values to transactions
    for (let tx of taxRelevantTransactions) {
      tx.inAmount = '0';
      tx.inCurrency = 'EGLD';
      tx.outAmount = '0';
      tx.outCurrency = 'EGLD';

      const relatedTransfers = transfers.filter(t => t.txHash === tx.txHash);

      const inTransfer = relatedTransfers.find(t => t.receiver === walletAddress);
      const outTransfer = relatedTransfers.find(t => t.sender === walletAddress);

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
            tx.outCurrency = 'EGLD';
          } else if (tx.receiver === walletAddress) {
            tx.inAmount = (BigInt(tx.value) / BigInt(10 ** 18)).toString();
            tx.inCurrency = 'EGLD';
          }
        }
      }
    }

    res.json({ allTransactions, taxRelevantTransactions });

  } catch (error) {
    console.error('Error in fetch-transactions:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
