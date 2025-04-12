// Updated server.js with multiple rows for multi-token rewards
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
function decodeHexToString(hex) { return Buffer.from(hex, 'hex').toString(); }
function decodeHexToBigInt(hex) { return BigInt(`0x${hex}`); }
function decodeBase64ToString(base64) { return Buffer.from(base64, 'base64').toString(); }

const fetchTokenDecimals = async (identifier, tokenDecimalsCache) => {
  const known = { 'EGLD': 18 };
  if (known[identifier]) return known[identifier];
  if (tokenDecimalsCache[identifier]) return tokenDecimalsCache[identifier];
  try {
    const { data } = await axios.get(`https://api.multiversx.com/tokens/${identifier}`);
    tokenDecimalsCache[identifier] = data.decimals || 18;
    return data.decimals || 18;
  } catch {
    return 18;
  }
};

app.post('/fetch-transactions', async (req, res) => {
  const { walletAddress, fromDate, toDate } = req.body;
  if (!walletAddress || !fromDate || !toDate || !validateWalletAddress(walletAddress)) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  const from = Math.floor(new Date(fromDate).getTime() / 1000);
  const to = Math.floor(new Date(toDate).getTime() / 1000);

  let allTransactions = [], transfers = [], tokenDecimalsCache = {};

  try {
    await axios.get(`https://api.multiversx.com/accounts/${walletAddress}`);

    for (let i = 0; i < 10000; i += 1000) {
      const { data } = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transactions`, {
        params: { after: from, before: to, size: 1000, order: 'asc', from: i }
      });
      allTransactions.push(...data);
      await delay(RATE_LIMIT_DELAY);
      if (data.length < 1000) break;
    }

    const taxRelevant = [];

    for (let tx of allTransactions) {
      if (tx.timestamp < from || tx.timestamp > to) continue;
      const txHash = tx.txHash;

      let detailed;
      try {
        const { data } = await axios.get(`https://api.multiversx.com/transactions/${txHash}`);
        detailed = data;
      } catch {
        continue;
      }

      const scResults = detailed.results || [];
      const processed = [];

      for (const scr of scResults) {
        if (!scr.data || !scr.receiver || scr.receiver !== walletAddress) continue;
        let decoded;
        try {
          decoded = decodeBase64ToString(scr.data);
        } catch { continue; }

        if (!decoded.startsWith('ESDTTransfer@')) continue;
        const parts = decoded.split('@');
        if (parts.length < 3) continue;

        const token = decodeHexToString(parts[1]);
        const rawAmount = decodeHexToBigInt(parts[2]);
        const decimals = await fetchTokenDecimals(token, tokenDecimalsCache);
        const formatted = new BigNumber(rawAmount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed(decimals);

        processed.push({
          timestamp: tx.timestamp,
          function: tx.function || 'claimRewards',
          inAmount: formatted,
          inCurrency: token,
          outAmount: '0',
          outCurrency: 'EGLD',
          fee: tx.fee || '0',
          txHash
        });
      }

      if (processed.length > 0) {
        taxRelevant.push(...processed);
      } else {
        taxRelevant.push({
          timestamp: tx.timestamp,
          function: tx.function || 'N/A',
          inAmount: '0',
          inCurrency: 'EGLD',
          outAmount: '0',
          outCurrency: 'EGLD',
          fee: tx.fee || '0',
          txHash
        });
      }
    }

    res.json({ allTransactions, taxRelevantTransactions: taxRelevant });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
