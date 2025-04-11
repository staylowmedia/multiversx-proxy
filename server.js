// server.js (support multiple in/out tokens as separate rows)
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
  let taxRelevantTransactions = [];

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

    const fetchTokenDecimals = async (tokenIdentifier) => {
      const knownDecimals = {
        'EGLD': 18,
        'WEGLD-bd4d79': 18,
        'MEX-43535633537': 18,
        'XMEX-4553434d4558': 18
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

    for (let tx of allTransactions) {
      const func = tx.function?.toLowerCase() || '';
      if (!(tx.timestamp >= startTimestamp && tx.timestamp <= endTimestamp)) continue;
      if (!transfers.some(t => t.txHash === tx.txHash) && !taxRelevantFunctions.includes(func)) continue;

      let baseTx = {
        timestamp: tx.timestamp,
        function: tx.function || 'N/A',
        txHash: tx.txHash,
        fee: tx.fee || '0'
      };

      try {
        const detailed = await axios.get(`https://api.multiversx.com/transactions/${tx.txHash}`);
        const scResults = detailed.data.results || [];

        for (const scr of scResults) {
          if (!scr.data) continue;
          const decodedData = decodeBase64ToString(scr.data);
          if (!decodedData.includes('@')) continue;

          const parts = decodedData.split('@');
          const callType = parts[0].toLowerCase();

          if ((callType === 'esdttransfer' || callType === 'esdtnfttransfer' || callType === 'multiesdtnfttransfer') && parts.length >= 3) {
            try {
              const token = decodeHexToString(parts[1]);
              const amountHex = parts[3] || parts[2];
              const amount = decodeHexToBigInt(amountHex);
              const decimals = await fetchTokenDecimals(token);
              const formattedAmount = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed(decimals);

              const isReceiver = (scr.receiver?.toLowerCase() === walletAddress.toLowerCase()) ||
                                 (scr.originalReceiver?.toLowerCase() === walletAddress.toLowerCase()) ||
                                 (decodedData.startsWith('ESDTTransfer') && detailed.data.receiver === walletAddress);

              const txClone = { ...baseTx };
              if (isReceiver && formattedAmount !== '0') {
                txClone.inAmount = formattedAmount;
                txClone.inCurrency = token;
                txClone.outAmount = '0';
                txClone.outCurrency = 'EGLD';
                taxRelevantTransactions.push(txClone);
              } else if (scr.sender === walletAddress && formattedAmount !== '0') {
                txClone.outAmount = formattedAmount;
                txClone.outCurrency = token;
                txClone.inAmount = '0';
                txClone.inCurrency = 'EGLD';
                taxRelevantTransactions.push(txClone);
              }
            } catch (err) {
              console.warn(`Failed to parse smart contract result: ${err.message}`);
            }
          }
        }
      } catch (error) {
        console.warn(`Could not fetch SCResults for ${tx.txHash}:`, error.response?.data || error.message);
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
