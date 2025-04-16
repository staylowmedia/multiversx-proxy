const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const cors = require('cors');
const BigNumber = require('bignumber.js');
const { v4: uuidv4 } = require('uuid');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 });
const tokenDecimalsCache = new NodeCache({ stdTTL: 86400 });
const transactionCache = new NodeCache({ stdTTL: 3600 }); // New cache for transaction details
const clientProgress = new Map();

// Konfigurasjon
const CONFIG = {
  API_BASE_URL: 'https://api.multiversx.com',
  PAGE_SIZE: 1000,
  MAX_RETRIES: 5,
  BASE_DELAY_MS: 1000,
  CORS_ORIGINS: [
    'https://www.multiversxdomain.com',
    'http://localhost:3000'
  ],
  TAX_RELEVANT_FUNCTIONS: [
    'claimrewards', 'claimrewardsproxy', 'swap_tokens_fixed_input', 'swap_tokens_fixed_output',
    'multipairswap', 'transfer', 'esdttransfer', 'multiesdtnfttransfer', 'swap', 'send',
    'receive', 'wrapegld', 'unwrapegld', 'aggregateesdt'
  ],
  KNOWN_TOKEN_DECIMALS: {
    'EGLD': 18,
    'WEGLD-bd4d79': 18,
    'MEX-455c57': 18,
    'XMEX-fda355': 18
  }
};

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || CONFIG.CORS_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`⚠️ CORS blocked for origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Helse-endepunkt
app.get('/health', (req, res) => res.send('OK'));

// SSE for fremdriftsoppdateringer
app.get('/progress/:id', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const id = req.params.id;
  console.log(`📡 SSE connection opened for clientId: ${id}`);

  clientProgress.set(id, (msg) => {
    try {
      res.write(`data: ${msg}\n\n`);
    } catch (err) {
      console.warn(`⚠️ Error sending SSE message for clientId ${id}:`, err.message);
    }
  });

  reportProgress(id, '✅ SSE connection established');

  const heartbeat = setInterval(() => {
    reportProgress(id, '💓 Heartbeat');
  }, 10000); // Reduced to 10s for stability

  const timeout = setTimeout(() => {
    console.log(`📡 Timeout for clientId ${id}`);
    clientProgress.delete(id);
    res.end();
  }, 1800000); // Extended to 30 minutes

  req.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    console.log(`📡 SSE connection closed for clientId: ${id}`);
    clientProgress.delete(id);
    res.end();
  });
});

function reportProgress(clientId, message) {
  const sender = clientProgress.get(clientId);
  if (sender) {
    console.log(`📨 Sending progress for clientId ${clientId}: ${message}`);
    sender(message);
  }
}

const validateWalletAddress = (address) => /^erd1[0-9a-z]{58}$/.test(address);
const decodeBase64ToString = (base64) => {
  try { return Buffer.from(base64, 'base64').toString(); } catch { return ''; }
};
const decodeBase64ToHex = (base64) => {
  try { return Buffer.from(base64, 'base64').toString('hex'); } catch { return '0'; }
};
const decodeHexToString = (hex) => {
  try { return Buffer.from(hex, 'hex').toString(); } catch { return ''; }
};
const decodeHexToBigInt = (hex) => {
  try { return BigInt(`0x${hex}`); } catch { return BigInt(0); }
};

function deduplicateTransactions(transactions) {
  const seen = new Map();
  const result = [];

  for (const tx of transactions) {
    const key = `${tx.txHash}:${tx.function}`;
    if (!seen.has(key)) {
      seen.set(key, {
        ...tx,
        inAmounts: [],
        outAmounts: []
      });
      result.push(seen.get(key));
    } else {
      const existing = seen.get(key);
      if (tx.inAmount !== '0' && !existing.inAmounts.some(a => a.amount === tx.inAmount && a.currency === tx.inCurrency)) {
        if (existing.inAmount === '0' || BigNumber(tx.inAmount).gt(existing.inAmount)) {
          existing.inAmount = tx.inAmount;
          existing.inCurrency = tx.inCurrency;
        }
        existing.inAmounts.push({ amount: tx.inAmount, currency: tx.inCurrency });
      }
      if (tx.outAmount !== '0' && !existing.outAmounts.some(a => a.amount === tx.outAmount && a.currency === tx.outCurrency)) {
        if (existing.outAmount === '0' || BigNumber(tx.outAmount).gt(existing.outAmount)) {
          existing.outAmount = tx.outAmount;
          existing.outCurrency = tx.outCurrency;
        }
        existing.outAmounts.push({ amount: tx.outAmount, currency: tx.outCurrency });
      }
      if (tx.fee !== '0' && existing.fee === '0') {
        existing.fee = tx.fee;
      }
    }
  }

  return result.map(tx => ({
    timestamp: tx.timestamp,
    function: tx.function,
    inAmount: tx.inAmount,
    inCurrency: tx.inCurrency,
    outAmount: tx.outAmount,
    outCurrency: tx.outCurrency,
    fee: tx.fee,
    txHash: tx.txHash
  }));
}

async function fetchWithRetry(url, params, retries = CONFIG.MAX_RETRIES, delayMs = CONFIG.BASE_DELAY_MS) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, { params, timeout: 10000 });
      return response;
    } catch (err) {
      if (err.response?.status === 429) {
        const wait = delayMs * Math.pow(2, i) + Math.random() * 100;
        console.warn(`⚠️ Rate limit hit for ${url}, waiting ${wait}ms`);
        await delay(wait);
        continue;
      }
      if (i === retries - 1) throw new Error(`Failed to fetch ${url}: ${err.message}`);
      await delay(delayMs * Math.pow(2, i));
    }
  }
}

async function getTokenDecimals(token) {
  if (!token || token === 'EGLD') return 18;
  if (CONFIG.KNOWN_TOKEN_DECIMALS[token]) return CONFIG.KNOWN_TOKEN_DECIMALS[token];
  if (tokenDecimalsCache.has(token)) return tokenDecimalsCache.get(token);

  try {
    const response = await axios.get(`${CONFIG.API_BASE_URL}/tokens/${token}`, { timeout: 5000 });
    const decimals = response.data.decimals || 18;
    tokenDecimalsCache.set(token, decimals);
    return decimals;
  } catch (err) {
    console.warn(`⚠️ Could not fetch decimals for ${token}:`, err.message);
    return 18;
  }
}

async function fetchTransactionDetails(txHash) {
  const cacheKey = `tx:${txHash}`;
  if (transactionCache.has(cacheKey)) {
    return transactionCache.get(cacheKey);
  }

  try {
    const response = await fetchWithRetry(
      `${CONFIG.API_BASE_URL}/transactions/${txHash}?withOperations=true&withLogs=true&withResults=true`,
      {}
    );
    const data = response.data;
    transactionCache.set(cacheKey, data);
    return data;
  } catch (err) {
    console.warn(`⚠️ Could not fetch details for tx ${txHash}:`, err.message);
    return { operations: [], logs: { events: [] }, results: [] };
  }
}

app.post('/fetch-transactions', async (req, res) => {
  const { walletAddress, fromDate, toDate, clientId } = req.body;

  if (!walletAddress || !fromDate || !toDate || !clientId) {
    reportProgress(clientId, '❌ Manglende parametere');
    return res.status(400).json({ error: 'Manglende nødvendige parametere' });
  }

  reportProgress(clientId, '📡 Validerer adresse...');
  if (!validateWalletAddress(walletAddress)) {
    reportProgress(clientId, '❌ Ugyldig adresse');
    return res.status(400).json({ error: 'Ugyldig lommebokadresse' });
  }

  const fromDateObj = new Date(fromDate);
  const toDateObj = new Date(toDate);
  const startTimestamp = Math.floor(fromDateObj.getTime() / 1000);
  const endTimestamp = Math.floor(toDateObj.getTime() / 1000);

  if (fromDateObj > toDateObj) {
    reportProgress(clientId, '❌ Ugyldig datoperiode');
    return res.status(400).json({ error: 'Ugyldig datoperiode' });
  }

  const cacheKey = `${walletAddress}:${fromDate}:${toDate}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    reportProgress(clientId, '✅ Hentet fra cache');
    return res.json(cached);
  }

  let allTransactions = [];
  let taxRelevantTransactions = [];
  const uniqueFunctions = new Set();

  try {
    await fetchWithRetry(`${CONFIG.API_BASE_URL}/accounts/${walletAddress}`, {});

    reportProgress(clientId, '🔍 Henter transaksjoner...');
    for (let fromIndex = 0; fromIndex < 10000; fromIndex += CONFIG.PAGE_SIZE) {
      const params = {
        after: startTimestamp,
        before: endTimestamp,
        size: CONFIG.PAGE_SIZE,
        order: 'asc',
        from: fromIndex
      };
      const response = await fetchWithRetry(`${CONFIG.API_BASE_URL}/accounts/${walletAddress}/transactions`, params);
      const batch = response.data;
      allTransactions.push(...batch);
      reportProgress(clientId, `📦 Hentet ${allTransactions.length} transaksjoner...`);
      if (batch.length < CONFIG.PAGE_SIZE) break;
    }

    for (let i = 0; i < allTransactions.length; i++) {
      const tx = allTransactions[i];
      if (i % 100 === 0) { // Update progress every 100 transactions
        reportProgress(clientId, `🔍 Behandler ${i + 1} av ${allTransactions.length} transaksjoner...`);
      }
      const func = (tx.function || '').toLowerCase();
      uniqueFunctions.add(func);

      let hasAddedEGLD = false;

      if (tx.receiver === walletAddress && tx.value && BigInt(tx.value) > 0 && func !== 'wrapegld') {
        const amount = BigInt(tx.value);
        const formatted = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(18)).toFixed();
        taxRelevantTransactions.push({
          timestamp: tx.timestamp,
          function: 'transfer',
          inAmount: formatted,
          inCurrency: 'EGLD',
          outAmount: '0',
          outCurrency: 'EGLD',
          fee: (BigInt(tx.fee || 0) / BigInt(10**18)).toString(),
          txHash: tx.txHash
        });
        hasAddedEGLD = true;
      }

      const isTaxRelevant = CONFIG.TAX_RELEVANT_FUNCTIONS.includes(func) ||
                           !func ||
                           tx.action?.category === 'mex' ||
                           tx.data?.startsWith('RVNEVFRyYW5zZmVy');
      if (!isTaxRelevant && !hasAddedEGLD) {
        continue; // Skip non-relevant transactions
      }

      const { operations = [], logs = { events: [] }, results = [] } = await fetchTransactionDetails(tx.txHash);

      let egldTransfersIn = operations.filter(op =>
        op.type === 'egld' &&
        op.receiver === walletAddress &&
        BigInt(op.value || 0) > 0
      );
      let tokenTransfersIn = operations.filter(op =>
        ['esdt', 'MetaESDT', 'fungibleESDT', 'nft', 'nonFungibleESDT'].includes(op.type) &&
        op.receiver === walletAddress &&
        BigInt(op.value || 0) > 0
      );
      let tokenTransfersOut = operations.filter(op =>
        ['esdt', 'MetaESDT', 'fungibleESDT', 'nft', 'nonFungibleESDT'].includes(op.type) &&
        op.sender === walletAddress &&
        BigInt(op.value || 0) > 0
      );

      for (const op of egldTransfersIn) {
        const amount = BigInt(op.value);
        const formatted = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(18)).toFixed();
        taxRelevantTransactions.push({
          timestamp: tx.timestamp,
          function: func || 'transfer',
          inAmount: formatted,
          inCurrency: 'EGLD',
          outAmount: '0',
          outCurrency: 'EGLD',
          fee: egldTransfersIn.indexOf(op) === 0 && !hasAddedEGLD ? (BigInt(tx.fee || 0) / BigInt(10**18)).toString() : '0',
          txHash: tx.txHash
        });
        hasAddedEGLD = true;
      }

      if (['claimrewards', 'claimrewardsproxy'].includes(func)) {
        const rewardTokens = [
          'XMEX-fda355', 'MEX-455c57', 'UTK-2f80e9', 'ZPAY-247875', 'QWT-46ac01',
          'RIDE-7d18e9', 'CRT-a28d59', 'CYBER-5d1f4a', 'AERO-458b36', 'ISET-83f339',
          'BHAT-c1fde3', 'SFIT-dcbf2a'
        ];
        let hasAddedReward = false;

        for (const op of tokenTransfersIn) {
          const token = op.identifier || op.name || 'UNKNOWN';
          if (rewardTokens.includes(token)) {
            const amount = BigInt(op.value);
            const decimals = await getTokenDecimals(token);
            const formatted = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed();
            taxRelevantTransactions.push({
              timestamp: tx.timestamp,
              function: func,
              inAmount: formatted,
              inCurrency: token,
              outAmount: '0',
              outCurrency: 'EGLD',
              fee: (BigInt(tx.fee || 0) / BigInt(10**18)).toString(),
              txHash: tx.txHash
            });
            hasAddedReward = true;
            break;
          }
        }

        if (!hasAddedReward) {
          const esdtEvents = logs.events?.filter(event =>
            ['ESDTTransfer', 'ESDTNFTTransfer'].includes(event.identifier) &&
            decodeBase64ToString(event.topics?.[3] || '') === walletAddress
          ) || [];

          for (const event of esdtEvents) {
            const token = decodeBase64ToString(event.topics?.[0] || '') || 'UNKNOWN';
            if (rewardTokens.includes(token)) {
              const amount = decodeHexToBigInt(decodeBase64ToHex(event.topics?.[2] || '0'));
              if (amount <= BigInt(0)) continue;
              const decimals = await getTokenDecimals(token);
              const formatted = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed();
              taxRelevantTransactions.push({
                timestamp: tx.timestamp,
                function: func,
                inAmount: formatted,
                inCurrency: token,
                outAmount: '0',
                outCurrency: 'EGLD',
                fee: (BigInt(tx.fee || 0) / BigInt(10**18)).toString(),
                txHash: tx.txHash
              });
              hasAddedReward = true;
              break;
            }
          }
        }

        if (!hasAddedReward) {
          taxRelevantTransactions.push({
            timestamp: tx.timestamp,
            function: func,
            inAmount: '0',
            inCurrency: 'UNKNOWN',
            outAmount: '0',
            outCurrency: 'EGLD',
            fee: (BigInt(tx.fee || 0) / BigInt(10**18)).toString(),
            txHash: tx.txHash
          });
        }
        continue;
      }

      if (func === 'wrapegld' && tx.sender === walletAddress && tx.value && BigInt(tx.value) > 0) {
        const egldAmount = BigInt(tx.value);
        const egldFormatted = new BigNumber(egldAmount.toString()).dividedBy(new BigNumber(10).pow(18)).toFixed();
        const inOp = tokenTransfersIn.find(op => op.identifier === 'WEGLD-bd4d79');
        let inAmount = '0', inCurrency = 'EGLD';

        if (inOp && BigInt(inOp.value) > 0) {
          const amount = BigInt(inOp.value);
          const decimals = await getTokenDecimals(inOp.identifier);
          inAmount = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed();
          inCurrency = inOp.identifier;
        }

        taxRelevantTransactions.push({
          timestamp: tx.timestamp,
          function: func,
          inAmount,
          inCurrency,
          outAmount: egldFormatted,
          outCurrency: 'EGLD',
          fee: (BigInt(tx.fee || 0) / BigInt(10**18)).toString(),
          txHash: tx.txHash
        });
        continue;
      }

      if (['swap_tokens_fixed_input', 'swap_tokens_fixed_output', 'multipairswap', 'aggregateesdt'].includes(func)) {
        let inAmount = '0', inCurrency = 'UNKNOWN';
        let outAmount = '0', outCurrency = 'UNKNOWN';

        if (tokenTransfersIn.length > 0) {
          const primaryIn = tokenTransfersIn.reduce((max, op) =>
            BigInt(op.value) > BigInt(max.value) ? op : max, tokenTransfersIn[0]
          );
          inCurrency = primaryIn.identifier || 'UNKNOWN';
          if (inCurrency !== 'UNKNOWN') {
            const inAmountBig = BigInt(primaryIn.value);
            const inDecimals = await getTokenDecimals(inCurrency);
            inAmount = new BigNumber(inAmountBig.toString()).dividedBy(new BigNumber(10).pow(inDecimals)).toFixed();
          }
        }

        if (tokenTransfersOut.length > 0) {
          const primaryOut = tokenTransfersOut.reduce((max, op) =>
            BigInt(op.value) > BigInt(max.value) ? op : max, tokenTransfersOut[0]
          );
          outCurrency = primaryOut.identifier || 'UNKNOWN';
          if (outCurrency !== 'UNKNOWN') {
            const outAmountBig = BigInt(primaryOut.value);
            const outDecimals = await getTokenDecimals(outCurrency);
            outAmount = new BigNumber(outAmountBig.toString()).dividedBy(new BigNumber(10).pow(outDecimals)).toFixed();
          }
        }

        if (inCurrency !== 'UNKNOWN' || outCurrency !== 'UNKNOWN') {
          taxRelevantTransactions.push({
            timestamp: tx.timestamp,
            function: func,
            inAmount,
            inCurrency,
            outAmount,
            outCurrency,
            fee: (BigInt(tx.fee || 0) / BigInt(10**18)).toString(),
            txHash: tx.txHash
          });
          continue;
        }
      }

      for (const op of tokenTransfersIn) {
        const token = op.identifier || op.name || 'UNKNOWN';
        if (token === 'UNKNOWN') continue;
        const amount = BigInt(op.value);
        if (amount <= BigInt(0)) continue;
        const decimals = await getTokenDecimals(token);
        const formatted = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed();
        taxRelevantTransactions.push({
          timestamp: tx.timestamp,
          function: func || 'transfer',
          inAmount: formatted,
          inCurrency: token,
          outAmount: '0',
          outCurrency: 'EGLD',
          fee: tokenTransfersIn.indexOf(op) === 0 && !hasAddedEGLD ? (BigInt(tx.fee || 0) / BigInt(10**18)).toString() : '0',
          txHash: tx.txHash
        });
      }

      for (const op of tokenTransfersOut) {
        const token = op.identifier || op.name || 'UNKNOWN';
        if (token === 'UNKNOWN') continue;
        const amount = BigInt(op.value);
        if (amount <= BigInt(0)) continue;
        const decimals = await getTokenDecimals(token);
        const formatted = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed();
        taxRelevantTransactions.push({
          timestamp: tx.timestamp,
          function: func || 'transfer',
          inAmount: '0',
          inCurrency: 'EGLD',
          outAmount: formatted,
          outCurrency: token,
          fee: tokenTransfersOut.indexOf(op) === 0 && !hasAddedEGLD ? (BigInt(tx.fee || 0) / BigInt(10**18)).toString() : '0',
          txHash: tx.txHash
        });
      }

      const esdtEvents = logs.events?.filter(event =>
        ['ESDTTransfer', 'ESDTNFTTransfer', 'transfer', 'ESDTLocalTransfer'].includes(event.identifier) &&
        decodeBase64ToString(event.topics?.[3] || '') === walletAddress
      ) || [];

      for (const event of esdtEvents) {
        const token = decodeBase64ToString(event.topics?.[0] || '') || 'UNKNOWN';
        if (token === 'UNKNOWN') continue;
        const amount = decodeHexToBigInt(decodeBase64ToHex(event.topics?.[2] || '0'));
        if (amount <= BigInt(0)) continue;
        const decimals = await getTokenDecimals(token);
        const formatted = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed();
        taxRelevantTransactions.push({
          timestamp: tx.timestamp,
          function: func || 'transfer',
          inAmount: formatted,
          inCurrency: token,
          outAmount: '0',
          outCurrency: 'EGLD',
          fee: esdtEvents.indexOf(event) == 0 && !hasAddedEGLD ? (BigInt(tx.fee || 0) / BigInt(10**18)).toString() : '0',
          txHash: tx.txHash
        });
      }

      const esdtResults = results.filter(r =>
        r.receiver === walletAddress &&
        r.data &&
        (r.data.startsWith('RVNEVFRyYW5zZmVy') || r.function === 'ESDTTransfer' || r.function === 'MultiESDTNFTTransfer')
      );

      for (const result of esdtResults) {
        const decodedData = decodeBase64ToString(result.data);
        const parts = decodedData.split('@');
        if (parts.length < 3) continue;
        const tokenHex = parts[1];
        const amountHex = parts[2];
        const token = decodeHexToString(tokenHex);
        if (!token) continue;
        const amount = decodeHexToBigInt(amountHex);
        if (amount <= BigInt(0)) continue;
        const decimals = await getTokenDecimals(token);
        const formatted = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed();
        taxRelevantTransactions.push({
          timestamp: tx.timestamp,
          function: func || 'transfer',
          inAmount: formatted,
          inCurrency: token,
          outAmount: '0',
          outCurrency: 'EGLD',
          fee: esdtResults.indexOf(result) === 0 && !hasAddedEGLD ? (BigInt(tx.fee || 0) / BigInt(10**18)).toString() : '0',
          txHash: tx.txHash
        });
      }

      if (!hasAddedEGLD && egldTransfersIn.length === 0 && tokenTransfersIn.length === 0 && tokenTransfersOut.length === 0 && esdtEvents.length === 0 && esdtResults.length === 0) {
        taxRelevantTransactions.push({
          timestamp: tx.timestamp,
          function: func || 'unknown',
          inAmount: '0',
          inCurrency: 'EGLD',
          outAmount: '0',
          outCurrency: 'EGLD',
          fee: (BigInt(tx.fee || 0) / BigInt(10**18)).toString(),
          txHash: tx.txHash
        });
      }
    }

    taxRelevantTransactions = deduplicateTransactions(taxRelevantTransactions);
    console.log(`Unike funksjonsnavn:`, Array.from(uniqueFunctions));

    const result = { allTransactions, taxRelevantTransactions };
    if (taxRelevantTransactions.length === 0) {
      reportProgress(clientId, '⚠️ Ingen skatterelevante transaksjoner funnet');
    } else {
      reportProgress(clientId, `✅ Fullført med ${taxRelevantTransactions.length} skatterelevante transaksjoner`);
    }

    cache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    console.error('❌ Feil i fetch-transactions:', error.message);
    reportProgress(clientId, '❌ Mislyktes: ' + error.message);
    res.status(500).json({ error: 'Kunne ikke hente transaksjoner. Prøv igjen senere.' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy server kjører på port ${PORT}`);
});
