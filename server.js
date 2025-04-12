// server.js with progress updates for fetching transactions
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
const RATE_LIMIT_DELAY = 1000;

const validateWalletAddress = (address) => /^erd1[0-9a-z]{58}$/.test(address);
const decodeHexToString = hex => Buffer.from(hex, 'hex').toString();
const decodeHexToBigInt = hex => BigInt(`0x${hex}`);
const decodeBase64ToString = base64 => Buffer.from(base64, 'base64').toString();

function splitDateRange(start, end, chunkDays = 30) {
  const intervals = [];
  let cursor = new Date(start);
  const endDate = new Date(end);
  while (cursor < endDate) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + chunkDays);
    if (chunkEnd > endDate) chunkEnd.setTime(endDate.getTime());
    intervals.push([new Date(cursor), new Date(chunkEnd)]);
    cursor = new Date(chunkEnd);
    cursor.setDate(cursor.getDate() + 1);
  }
  return intervals;
}

app.post('/fetch-transactions', async (req, res) => {
  const { walletAddress, fromDate, toDate } = req.body;
  if (!walletAddress || !fromDate || !toDate) return res.status(400).json({ error: 'Missing required parameters' });
  if (!validateWalletAddress(walletAddress)) return res.status(400).json({ error: 'Invalid wallet address' });

  const fromDateObj = new Date(fromDate);
  const toDateObj = new Date(toDate);
  if (isNaN(fromDateObj) || isNaN(toDateObj)) return res.status(400).json({ error: 'Invalid timestamps' });
  if (fromDateObj > toDateObj) return res.status(400).json({ error: 'Invalid date range' });

  let allTransactions = [];
  let transfers = [];
  let tokenDecimalsCache = {};
  let taxRelevantTransactions = [];
  let txCounter = 0;

  try {
    console.log(`🔍 Checking account: ${walletAddress}`);
    await axios.get(`https://api.multiversx.com/accounts/${walletAddress}`);
    const dateChunks = splitDateRange(fromDateObj, toDateObj);
    console.log('📅 Date chunks:', dateChunks.map(pair => pair.map(d => d.toISOString())));

    const fetchTokenDecimals = async (tokenIdentifier) => {
      const knownDecimals = { 'EGLD': 18, 'WEGLD-bd4d79': 18, 'MEX-43535633537': 18 };
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

    for (const [chunkStart, chunkEnd] of dateChunks) {
      console.log(`⏱️ Fetching from ${chunkStart.toISOString()} to ${chunkEnd.toISOString()}`);
      const startTimestamp = Math.floor(chunkStart.getTime() / 1000);
      const endTimestamp = Math.floor(chunkEnd.getTime() / 1000);

      for (let fromIndex = 0; fromIndex < 10000; fromIndex += 1000) {
        const params = { after: startTimestamp, before: endTimestamp, size: 1000, order: 'asc', from: fromIndex };
        console.log(`📥 Fetching transaction batch: startIndex=${fromIndex}`);
        const response = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transactions`, { params });
        const batch = response.data;
        txCounter += batch.length;
        console.log(`📥 Got ${batch.length} transactions. Total so far: ${txCounter}`);
        allTransactions.push(...batch);
        await delay(RATE_LIMIT_DELAY);
        if (batch.length < 1000) break;
      }

      for (let ts = startTimestamp; ts < endTimestamp; ts += 86400) {
        let startIndex = 0;
        const chunkDayEnd = Math.min(ts + 86398, endTimestamp);
        while (true) {
          if (startIndex + 500 > 10000) break;
          const params = { after: ts, before: chunkDayEnd, size: 500, order: 'asc', start: startIndex };
          const response = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transfers`, { params });
          console.log(`🔁 Transfers ${response.data.length} at start ${startIndex}`);
          transfers.push(...response.data);
          await delay(RATE_LIMIT_DELAY);
          if (response.data.length < 500) break;
          startIndex += 500;
        }
      }
    }

    console.log('📊 Total transactions:', allTransactions.length);
    console.log('📦 Total transfers:', transfers.length);

    const taxRelevantFunctions = [
      'claimrewards', 'claim', 'claimrewardsproxy', 'redelegaterewards',
      'swaptokensfixedinput', 'swaptokensfixedoutput', 'multipairswap',
      'transfer', 'wrapegld', 'unwrapegld',
      'aggregateegld', 'aggregateesdt',
      'esdttransfer', 'esdtnfttransfer', 'multiesdtnfttransfer',
      'buy', 'sell', 'withdraw', 'claimlockedassets'
    ];

    taxRelevantTransactions = allTransactions.filter(tx => {
      const func = tx.function?.toLowerCase() || '';
      const hasTransfer = transfers.some(t => t.txHash === tx.txHash);
      return (hasTransfer || taxRelevantFunctions.includes(func));
    });

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
        if (value && value !== '0') {
          const decimals = await fetchTokenDecimals(identifier);
          const formattedAmount = new BigNumber(value).dividedBy(new BigNumber(10).pow(decimals)).toFixed(decimals);
          if (formattedAmount !== '0') {
            tx.inAmount = formattedAmount;
            tx.inCurrency = identifier;
          }
        }
      }

      if (outTransfer) {
        let identifier = outTransfer.identifier || 'EGLD';
        let value = outTransfer.value;
        if (value && value !== '0') {
          const decimals = await fetchTokenDecimals(identifier);
          const formattedAmount = new BigNumber(value).dividedBy(new BigNumber(10).pow(decimals)).toFixed(decimals);
          if (formattedAmount !== '0') {
            tx.outAmount = formattedAmount;
            tx.outCurrency = identifier;
          }
        }
      }
    }

    console.log('✅ Found tax-relevant:', taxRelevantTransactions.length);
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
