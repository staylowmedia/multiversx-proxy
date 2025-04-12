const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const cors = require('cors');
const BigNumber = require('bignumber.js');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 });

app.use(cors());
app.use(express.json());

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const RATE_LIMIT_DELAY = 500;

const validateWalletAddress = (address) => /^erd1[0-9a-z]{58}$/.test(address);
const decodeHexToString = hex => Buffer.from(hex, 'hex').toString();
const decodeHexToBigInt = hex => BigInt(`0x${hex}`);
const decodeBase64ToString = base64 => Buffer.from(base64, 'base64').toString();

app.post('/fetch-transactions', async (req, res) => {
  const { walletAddress, fromDate, toDate } = req.body;

  if (!walletAddress || !fromDate || !toDate) return res.status(400).json({ error: 'Missing required parameters' });
  if (!validateWalletAddress(walletAddress)) return res.status(400).json({ error: 'Invalid wallet address' });

  const fromDateObj = new Date(fromDate);
  const toDateObj = new Date(toDate);
  const startTimestamp = Math.floor(fromDateObj.getTime() / 1000);
  const endTimestamp = Math.floor(toDateObj.getTime() / 1000);

  if (isNaN(startTimestamp) || isNaN(endTimestamp)) return res.status(400).json({ error: 'Invalid timestamps' });
  if (fromDateObj > toDateObj) return res.status(400).json({ error: 'Invalid date range' });

  let allTransactions = [];
  let transfers = [];
  let tokenDecimalsCache = {};

  try {
    await axios.get(`https://api.multiversx.com/accounts/${walletAddress}`);

    const pageSize = 1000;
    for (let fromIndex = 0; fromIndex < 10000; fromIndex += pageSize) {
      const params = { after: startTimestamp, before: endTimestamp, size: pageSize, order: 'asc', from: fromIndex };
      const response = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transactions`, { params });
      const batch = response.data;
      allTransactions.push(...batch);
      await delay(RATE_LIMIT_DELAY);
      if (batch.length < pageSize) break;
    }

    const SECONDS_IN_DAY = 86400;
    for (let ts = startTimestamp; ts < endTimestamp; ts += SECONDS_IN_DAY) {
      const chunkStart = ts;
      const chunkEnd = Math.min(ts + 86398, endTimestamp);
      let startIndex = 0;
      while (true) {
        if (startIndex + 500 > 10000) break;
        const params = { after: chunkStart, before: chunkEnd, size: 500, order: 'asc', start: startIndex };
        const response = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transfers`, { params });
        transfers.push(...response.data);
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
      const withinDate = tx.timestamp >= startTimestamp && tx.timestamp <= endTimestamp;
      const hasTransfer = transfers.some(t => t.txHash === tx.txHash);
      return withinDate && (hasTransfer || taxRelevantFunctions.includes(func));
    });

    const fetchTokenDecimals = async (tokenIdentifier) => {
      const knownDecimals = {
        'EGLD': 18,
        'WEGLD-bd4d79': 18,
        'MEX-43535633537': 18
      };
      if (knownDecimals[tokenIdentifier]) return knownDecimals[tokenIdentifier];
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
        let identifier = inTransfer.identifier || 'EGLD';
        let value = inTransfer.value;

        if (inTransfer.data?.startsWith('RVNEVFRyYW5zZmVy')) {
          const decodedData = decodeBase64ToString(inTransfer.data);
          const parts = decodedData.split('@');
          if (parts[0] === 'ESDTTransfer' && parts.length >= 3) {
            identifier = decodeHexToString(parts[1]);
            value = decodeHexToBigInt(parts[2]).toString();
          }
        }

        if (value && value !== '0') {
          const decimals = await fetchTokenDecimals(identifier);
          const formatted = new BigNumber(value).dividedBy(new BigNumber(10).pow(decimals)).toFixed(decimals);
          if (formatted !== '0') {
            tx.inAmount = formatted;
            tx.inCurrency = identifier;
          }
        }
      }

      if (outTransfer) {
        let identifier = outTransfer.identifier || 'EGLD';
        let value = outTransfer.value;

        if (outTransfer.data?.startsWith('RVNEVFRyYW5zZmVy')) {
          const decodedData = decodeBase64ToString(outTransfer.data);
          const parts = decodedData.split('@');
          if (parts[0] === 'ESDTTransfer' && parts.length >= 3) {
            identifier = decodeHexToString(parts[1]);
            value = decodeHexToBigInt(parts[2]).toString();
          }
        }

        if (value && value !== '0') {
          const decimals = await fetchTokenDecimals(identifier);
          const formatted = new BigNumber(value).dividedBy(new BigNumber(10).pow(decimals)).toFixed(decimals);
          if (formatted !== '0') {
            tx.outAmount = formatted;
            tx.outCurrency = identifier;
          }
        }
      }

      try {
        const detailed = await axios.get(`https://api.multiversx.com/transactions/${tx.txHash}`);
        let scResults = detailed.data.results || [];

        scResults.sort((a, b) => {
          const aIsEsdt = a.data && a.data.startsWith('RVNEVFRyYW5zZmVy') ? 1 : 0;
          const bIsEsdt = b.data && b.data.startsWith('RVNEVFRyYW5zZmVy') ? 1 : 0;
          return aIsEsdt - bIsEsdt;
        });

        for (const scr of scResults) {
          if (!scr.data || !scr.data.includes('@')) continue;

          const decodedData = decodeBase64ToString(scr.data);
          const parts = decodedData.split('@');
          const callType = parts[0].toLowerCase();

          if ((callType === 'esdttransfer' || callType === 'multiesdtnfttransfer') && parts.length >= 3) {
            try {
              const token = decodeHexToString(parts[1]);
              const amount = decodeHexToBigInt(parts[2]);
              const decimals = await fetchTokenDecimals(token);
              const formattedAmount = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed(decimals);

              if (scr.receiver === walletAddress && formattedAmount !== '0') {
                if (tx.inAmount === '0' || tx.inCurrency === 'EGLD') {
                  tx.inAmount = formattedAmount;
                  tx.inCurrency = token;
                }
              }

              if (scr.sender === walletAddress && formattedAmount !== '0') {
                if (tx.outAmount === '0' || tx.outCurrency === 'EGLD') {
                  tx.outAmount = formattedAmount;
                  tx.outCurrency = token;
                }
              }
            } catch (error) {
              console.warn(`⚠️ Failed to parse SCResult for ${tx.txHash}: ${error.message}`);
            }
          }
        }
      } catch (error) {
        console.warn(`⚠️ Could not fetch operations for ${tx.txHash}:`, error.response?.data || error.message);
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
