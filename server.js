const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const cors = require('cors');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 });

app.use(cors());
app.use(express.json());

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const RATE_LIMIT_DELAY = 500;

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
    return res.status(400).json({ error: 'Invalid timestamps' });
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

    const pageSize = 500;

    for (let fromIndex = 0; fromIndex < 5000; fromIndex += pageSize) {
      const params = {
        after: startTimestamp,
        before: endTimestamp,
        size: pageSize,
        order: 'asc',
        from: fromIndex
      };
      const response = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transactions`, { params });
      const batch = response.data;
      if (batch.length === 0) break;
      console.log(`📥 Fetched ${batch.length} transactions from index ${fromIndex}`);
      allTransactions.push(...batch);
      await delay(RATE_LIMIT_DELAY);
      if (batch.length < pageSize) break;
    }

    const SECONDS_IN_DAY = 86400;
    for (let ts = startTimestamp; ts < endTimestamp; ts += SECONDS_IN_DAY) {
      const chunkStart = ts;
      const chunkEnd = Math.min(ts + SECONDS_IN_DAY - 1, endTimestamp);
      try {
        const response = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transfers`, {
          params: {
            from: chunkStart,
            to: chunkEnd,
            size: 500,
            order: 'asc'
          }
        });
        console.log(`🔄 Fetched ${response.data.length} transfers from ${chunkStart}–${chunkEnd}`);
        transfers.push(...response.data);
        await delay(RATE_LIMIT_DELAY);
      } catch (error) {
        console.warn(`⚠️ Transfer fetch failed for chunk ${chunkStart}-${chunkEnd}:`, error.response?.data || error.message);
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

      if ((tx.inAmount === '0' && tx.outAmount === '0') || ['swaptokensfixedinput', 'swaptokensfixedoutput', 'wrapegld', 'unwrapegld'].includes(tx.function?.toLowerCase())) {
        try {
          const detailed = await axios.get(`https://api.multiversx.com/transactions/${tx.txHash}`);
          const operations = detailed.data.operations || [];
          const scResults = detailed.data.smartContractResults || [];

          for (const op of operations) {
            if (op.sender === walletAddress) {
              const decimals = await fetchTokenDecimals(op.identifier);
              tx.outAmount = (BigInt(op.value) / BigInt(10 ** decimals)).toString();
              tx.outCurrency = op.identifier;
            }
            if (op.receiver === walletAddress) {
              const decimals = await fetchTokenDecimals(op.identifier);
              tx.inAmount = (BigInt(op.value) / BigInt(10 ** decimals)).toString();
              tx.inCurrency = op.identifier;
            }
          }

          for (const scr of scResults) {
            if (scr.receiver === walletAddress && scr.identifier) {
              const decimals = await fetchTokenDecimals(scr.identifier);
              tx.inAmount = (BigInt(scr.value) / BigInt(10 ** decimals)).toString();
              tx.inCurrency = scr.identifier;
            }
            if (scr.sender === walletAddress && scr.identifier) {
              const decimals = await fetchTokenDecimals(scr.identifier);
              tx.outAmount = (BigInt(scr.value) / BigInt(10 ** decimals)).toString();
              tx.outCurrency = scr.identifier;
            }
          }
        } catch (error) {
          console.warn(`⚠️ Could not fetch operations for ${tx.txHash}:`, error.response?.data || error.message);
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
