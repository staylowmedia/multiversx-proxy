// server.js (now handles long date range by splitting into 30-day intervals)
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

  try {
    await axios.get(`https://api.multiversx.com/accounts/${walletAddress}`);
    const dateChunks = splitDateRange(fromDateObj, toDateObj);

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
      const startTimestamp = Math.floor(chunkStart.getTime() / 1000);
      const endTimestamp = Math.floor(chunkEnd.getTime() / 1000);

      for (let fromIndex = 0; fromIndex < 10000; fromIndex += 1000) {
        const params = { after: startTimestamp, before: endTimestamp, size: 1000, order: 'asc', from: fromIndex };
        const response = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transactions`, { params });
        const batch = response.data;
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
          transfers.push(...response.data);
          await delay(RATE_LIMIT_DELAY);
          if (response.data.length < 500) break;
          startIndex += 500;
        }
      }
    }

    // Filtering and processing logic stays the same as in prior version
    // This includes SCResult parsing and LP logic
    // ... (left out here to keep update short)

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
