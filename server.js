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

const validateWalletAddress = (address) => {
  const addressPattern = /^erd1[0-9a-z]{58}$/;
  return addressPattern.test(address);
};

function decodeHexToString(hex) {
  return Buffer.from(hex, 'hex').toString();
}

function decodeHexToBigInt(hex) {
  return BigInt(`0x${hex}`);
}

function decodeBase64ToString(base64) {
  return Buffer.from(base64, 'base64').toString();
}

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

    // Hent transaksjoner
    const pageSize = 1000;
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
      console.log(`📥 Fetched ${batch.length} transactions from index ${fromIndex}`);
      allTransactions.push(...batch);
      await delay(RATE_LIMIT_DELAY);
      if (batch.length < pageSize) break;
    }
    console.log(`Total transactions fetched: ${allTransactions.length}`);

    // Hent transfers
    const SECONDS_IN_DAY = 86400;
    for (let ts = startTimestamp; ts < endTimestamp; ts += SECONDS_IN_DAY) {
      const chunkStart = ts;
      const chunkEnd = Math.min(ts + 86398, endTimestamp);
      let startIndex = 0;
      while (true) {
        if (startIndex + 500 > 10000) {
          console.log(`Reached MultiversX API limit: startIndex (${startIndex}) + size (500) exceeds 10000`);
          break;
        }

        const params = {
          after: chunkStart,
          before: chunkEnd,
          size: 500,
          order: 'asc',
          start: startIndex
        };
        console.log(`Sending request for transfers: ${JSON.stringify(params)}`);
        const response = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transfers`, { params });
        console.log(`🔄 Fetched ${response.data.length} transfers from ${chunkStart}–${chunkEnd} with startIndex ${startIndex}`);
        transfers.push(...response.data);
        await delay(RATE_LIMIT_DELAY);
        if (response.data.length < 500) break;
        startIndex += 500;
      }
    }
    console.log(`Total transfers fetched: ${transfers.length}`);

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
      if (tokenIdentifier === 'EGLD') {
        console.log(`Token ${tokenIdentifier} has 18 decimals (hardcoded)`);
        return 18;
      }
      if (tokenIdentifier === 'WEGLD-bd4d79') {
        console.log(`Token ${tokenIdentifier} has 18 decimals (hardcoded)`);
        return 18;
      }
      if (tokenIdentifier === 'MEX-43535633537') {
        console.log(`Token ${tokenIdentifier} has 18 decimals (hardcoded)`);
        return 18;
      }
      if (tokenDecimalsCache[tokenIdentifier]) {
        console.log(`Token ${tokenIdentifier} has ${tokenDecimalsCache[tokenIdentifier]} decimals (cached)`);
        return tokenDecimalsCache[tokenIdentifier];
      }
      try {
        const response = await axios.get(`https://api.multiversx.com/tokens/${tokenIdentifier}`);
        const decimals = response.data.decimals || 18;
        tokenDecimalsCache[tokenIdentifier] = decimals;
        console.log(`Token ${tokenIdentifier} has ${decimals} decimals (fetched from API)`);
        return decimals;
      } catch (error) {
        console.warn(`Failed to fetch decimals for ${tokenIdentifier}, defaulting to 18:`, error.response?.data || error.message);
        return 18;
      }
    };

    for (let tx of taxRelevantTransactions) {
      tx.inAmount = '0';
      tx.inCurrency = 'EGLD';
      tx.outAmount = '0';
      tx.outCurrency = 'EGLD';

      const related = transfers.filter(t => t.txHash === tx.txHash);
      console.log(`Found ${related.length} transfers for tx ${tx.txHash}`);
      const inTransfer = related.find(t => t.receiver === walletAddress);
      const outTransfer = related.find(t => t.sender === walletAddress);

      console.log(`inTransfer for tx ${tx.txHash}:`, inTransfer);
      console.log(`outTransfer for tx ${tx.txHash}:`, outTransfer);

      // Håndter inTransfer (mottatt)
      if (inTransfer) {
        let identifier = inTransfer.identifier || 'EGLD';
        let value = inTransfer.value;

        // Sjekk om dette er en ESDT-overføring ved å parse data-feltet
        if (inTransfer.data && inTransfer.data.startsWith('RVNEVFRyYW5zZmVy')) {
          const decodedData = decodeBase64ToString(inTransfer.data);
          const parts = decodedData.split('@');
          if (parts[0] === 'ESDTTransfer' && parts.length >= 3) {
            const tokenHex = parts[1];
            const amountHex = parts[2];
            identifier = decodeHexToString(tokenHex);
            value = decodeHexToBigInt(amountHex).toString();
            console.log(`Parsed ESDTTransfer from inTransfer: identifier=${identifier}, value=${value}`);
          }
        }

        if (value && value !== '0') {
          const decimals = await fetchTokenDecimals(identifier);
          console.log(`Calculating inAmount: value=${value}, decimals=${decimals}, identifier=${identifier}`);
          const formattedAmount = new BigNumber(value).dividedBy(new BigNumber(10).pow(decimals)).toFixed(decimals);
          console.log(`Formatted inAmount: ${formattedAmount}`);
          if (formattedAmount !== '0') {
            tx.inAmount = formattedAmount;
            tx.inCurrency = identifier;
          }
        }
      }

      // Håndter outTransfer (sendt)
      if (outTransfer) {
        let identifier = outTransfer.identifier || 'EGLD';
        let value = outTransfer.value;

        // Sjekk om dette er en ESDT-overføring ved å parse data-feltet
        if (outTransfer.data && outTransfer.data.startsWith('RVNEVFRyYW5zZmVy')) {
          const decodedData = decodeBase64ToString(outTransfer.data);
          const parts = decodedData.split('@');
          if (parts[0] === 'ESDTTransfer' && parts.length >= 3) {
            const tokenHex = parts[1];
            const amountHex = parts[2];
            identifier = decodeHexToString(tokenHex);
            value = decodeHexToBigInt(amountHex).toString();
            console.log(`Parsed ESDTTransfer from outTransfer: identifier=${identifier}, value=${value}`);
          }
        }

        if (value && value !== '0') {
          const decimals = await fetchTokenDecimals(identifier);
          console.log(`Calculating outAmount: value=${value}, decimals=${decimals}, identifier=${identifier}`);
          const formattedAmount = new BigNumber(value).dividedBy(new BigNumber(10).pow(decimals)).toFixed(decimals);
          console.log(`Formatted outAmount: ${formattedAmount}`);
          if (formattedAmount !== '0') {
            tx.outAmount = formattedAmount;
            tx.outCurrency = identifier;
          }
        }
      }

      // Håndter smart contract-resultater
      try {
        const detailed = await axios.get(`https://api.multiversx.com/transactions/${tx.txHash}`);
        const scResults = detailed.data.results || [];
        console.log(`Smart contract results for tx ${tx.txHash}:`, scResults);

        for (const scr of scResults) {
          if (!scr.data || !scr.data.includes('@')) continue;
          const parts = scr.data.split('@');
          const callType = parts[0].toLowerCase();

          if ((callType === 'esdttransfer' || callType === 'multiesdtnfttransfer') && parts.length >= 3) {
            const tokenHex = parts[1];
            const amountHex = parts[2];
            const token = decodeHexToString(tokenHex);
            const amount = decodeHexToBigInt(amountHex);
            const decimals = await fetchTokenDecimals(token);
            const formattedAmount = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed(decimals);

            console.log(`Smart contract result for tx ${tx.txHash}: token=${token}, amount=${amount}, decimals=${decimals}, formattedAmount=${formattedAmount}`);
            console.log(`Before update: inAmount=${tx.inAmount}, outAmount=${tx.outAmount}`);

            // Sjekk om dette er en mottatt transaksjon
            if (scr.receiver === walletAddress && amount > 0 && formattedAmount !== '0') {
              if (tx.inAmount === '0') { // Bare oppdater hvis inAmount fortsatt er 0
                tx.inAmount = formattedAmount;
                tx.inCurrency = token;
                console.log(`Updated inAmount to ${tx.inAmount} ${tx.inCurrency}`);
              }
            }
            // Sjekk om dette er en sendt transaksjon
            if (scr.sender === walletAddress && amount > 0 && formattedAmount !== '0') {
              if (tx.outAmount === '0') { // Bare oppdater hvis outAmount fortsatt er 0
                tx.outAmount = formattedAmount;
                tx.outCurrency = token;
                console.log(`Updated outAmount to ${tx.outAmount} ${tx.outCurrency}`);
              }
            }

            console.log(`After update: inAmount=${tx.inAmount}, outAmount=${tx.outAmount}`);
          } else {
            console.log(`Unknown callType: ${callType} for tx ${tx.txHash}`);
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
