const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const cors = require('cors');
const BigNumber = require('bignumber.js');
const { v4: uuidv4 } = require('uuid');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 });
const tokenDecimalsCache = new NodeCache({ stdTTL: 86400 });
const clientProgress = new Map();

// Konfigurasjon
const CONFIG = {
  API_BASE_URL: 'https://api.multiversx.com',
  PAGE_SIZE: 1000,
  MAX_RETRIES: 5,
  BASE_DELAY_MS: 1000,
  CORS_ORIGINS: [
    'https://www.multiversxdomain.com'
  ],
  TAX_RELEVANT_FUNCTIONS: [
    'claimrewards', 'claimrewardsproxy', 'swap_tokens_fixed_input', 'swap_tokens_fixed_output',
    'multipairswap', 'transfer', 'esdttransfer', 'multiesdtnfttransfer', 'swap', 'send',
    'receive', 'wrapegld', 'unwrapegld', 'aggregateEgld' // Lagt til
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
  }, 30000);

  const timeout = setTimeout(() => {
    console.log(`📡 Timeout for clientId ${id}`);
    clientProgress.delete(id);
    res.end();
  }, 600000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    console.log(`📡 SSE connection closed for clientId: ${id}, duration: ${(Date.now() - startTime) / 1000}s`);
    clientProgress.delete(id);
    res.end();
  });

  const startTime = Date.now();
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
    const key = `${tx.txHash}:${tx.function}:${tx.inCurrency}:${tx.outCurrency}`; // Forbedret deduplisering
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
      console.log(`⚠️ Merged transaction: ${key}, in=${tx.inAmount} ${tx.inCurrency}, out=${tx.outAmount} ${tx.outCurrency}`);
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

app.post('/fetch-transactions', async (req, res) => {
  const { walletAddress, fromDate, toDate, clientId } = req.body;

  if (!walletAddress || !fromDate || !toDate || !clientId) {
    reportProgress(clientId, '❌ Missing parameters');
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  reportProgress(clientId, '📡 Validating address...');
  if (!validateWalletAddress(walletAddress)) {
    reportProgress(clientId, '❌ Invalid address');
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const fromDateObj = new Date(fromDate);
  const toDateObj = new Date(toDate);
  const startTimestamp = Math.floor(fromDateObj.getTime() / 1000);
  const endTimestamp = Math.floor(toDateObj.getTime() / 1000);

  if (fromDateObj > toDateObj) {
    reportProgress(clientId, '❌ Invalid date range');
    return res.status(400).json({ error: 'Invalid date range' });
  }

  const cacheKey = `${walletAddress}:${fromDate}:${toDate}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    reportProgress(clientId, '✅ Retrieved from cache');
    return res.json(cached);
  }

  let allTransactions = [];
  let taxRelevantTransactions = [];
  const uniqueFunctions = new Set();

  try {
    await fetchWithRetry(`${CONFIG.API_BASE_URL}/accounts/${walletAddress}`, {});

    reportProgress(clientId, '🔍 Fetching transactions...');
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
      reportProgress(clientId, `📦 Fetched ${allTransactions.length} transactions...`);
      if (batch.length < CONFIG.PAGE_SIZE) break;
    }

    for (let i = 0; i < allTransactions.length; i++) {
      const tx = allTransactions[i];
      reportProgress(clientId, `🔍 Processing ${i + 1} of ${allTransactions.length} transactions...`);
      const func = (tx.function || '').toLowerCase();
      uniqueFunctions.add(func);
      console.log(`🔍 Raw tx ${tx.txHash}: function=${tx.function}, value=${tx.value}, receiver=${tx.receiver}, action=${JSON.stringify(tx.action)}, data=${tx.data}`);

      if (func === 'aggregateEgld') {
        console.log(`🔍 aggregateEgld tx ${tx.txHash}: value=${tx.value}, receiver=${tx.receiver}`);
      }

      let hasAddedEGLD = false;

      if (tx.receiver === walletAddress && tx.value && BigInt(tx.value) > 0 && func !== 'wrapegld') {
        console.log(`Found EGLD transfer for tx ${tx.txHash}: ${tx.value} wei`);
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
        console.log(`⚠️ Skipping tx ${tx.txHash}: function ${func} not tax-relevant, no EGLD transfer`);
        continue;
      }

      try {
        const detailed = await fetchWithRetry(
          `${CONFIG.API_BASE_URL}/transactions/${tx.txHash}?withOperations=true&withLogs=true&withResults=true`,
          {}
        );
        const { operations = [], logs = { events: [] }, results = [] } = detailed.data;

        if (func === 'aggregateEgld') {
          console.log(`🔍 Details for aggregateEgld tx ${tx.txHash}: operations=${JSON.stringify(operations)}, events=${JSON.stringify(logs.events)}, results=${JSON.stringify(results)}`);
        }

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
          console.log(`Found EGLD operation for tx ${tx.txHash}: ${op.value} wei`);
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

        if (func === 'aggregateEgld' && tx.sender === walletAddress && tx.value && BigInt(tx.value) > 0) {
          console.log(`Processing aggregateEgld for tx ${tx.txHash}: EGLD out=${tx.value}`);
          const egldAmount = BigInt(tx.value);
          const egldFormatted = new BigNumber(egldAmount.toString()).dividedBy(new BigNumber(10).pow(18)).toFixed();
          taxRelevantTransactions.push({
            timestamp: tx.timestamp,
            function: func,
            inAmount: '0',
            inCurrency: 'EGLD',
            outAmount: egldFormatted,
            outCurrency: 'EGLD',
            fee: (BigInt(tx.fee || 0) / BigInt(10**18)).toString(),
            txHash: tx.txHash
          });
          continue;
        }

        if (['claimrewards', 'claimrewardsproxy'].includes(func)) {
          console.log(`Processing ${func} for tx ${tx.txHash}: operations=${JSON.stringify(operations.map(op => ({ type: op.type, identifier: op.identifier, value: op.value, receiver: op.receiver })))}`);
          const rewardTokens = [
            'XMEX-fda355', 'MEX-455c57', 'UTK-2f80e9', 'ZPAY-247875', 'QWT-46ac01',
            'RIDE-7d18e9', 'CRT-a28d59', 'CYBER-5d1f4a', 'AERO-458b36', 'ISET-83f339',
            'BHAT-c1fde3', 'SFIT-dcbf2a'
          ];
          const lpTokenPattern = /(FARM|FL-|EGLD.*FL|WEGLD.*FL|XMEXFARM|CYBEEGLD|CRTWEGLD)/i;
          let hasAddedReward = false;

          for (const op of tokenTransfersIn) {
            const token = op.identifier || op.name || 'UNKNOWN';
            console.log(`Evaluating token ${token} (value=${op.value}, type=${op.type}, receiver=${op.receiver}) for tx ${tx.txHash}`);
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
              console.log(`✅ Added reward token ${token} from operations for tx ${tx.txHash}: ${formatted}`);
              break;
            }
          }

          if (!hasAddedReward) {
            console.log(`No reward token found in rewardTokens for tx ${tx.txHash}, trying non-LP tokens`);
            for (const op of tokenTransfersIn) {
              const token = op.identifier || op.name || 'UNKNOWN';
              console.log(`Fallback: Evaluating token ${token} (value=${op.value}, type=${op.type}, receiver=${op.receiver}) for tx ${tx.txHash}`);
              if (token === 'UNKNOWN' || lpTokenPattern.test(token)) {
                console.warn(`⚠️ Skipping LP or unknown token ${token} for ${func} tx ${tx.txHash}`);
                continue;
              }
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
              console.log(`✅ Added fallback reward token ${token} from operations for tx ${tx.txHash}: ${formatted}`);
              break;
            }
          }

          if (!hasAddedReward) {
            console.log(`No reward token found in operations for tx ${tx.txHash}, checking logs.events`);
            const esdtEvents = logs.events?.filter(event =>
              ['ESDTTransfer', 'ESDTNFTTransfer'].includes(event.identifier) &&
              decodeBase64ToString(event.topics?.[3] || '') === walletAddress
            ) || [];

            for (const event of esdtEvents) {
              const token = decodeBase64ToString(event.topics?.[0] || '') || 'UNKNOWN';
              console.log(`Logs: Evaluating token ${token} for tx ${tx.txHash}`);
              if (token === 'UNKNOWN' || lpTokenPattern.test(token)) {
                console.warn(`⚠️ Skipping LP or unknown token ${token} in logs for ${func} tx ${tx.txHash}`);
                continue;
              }
              const amount = decodeHexToBigInt(decodeBase64ToHex(event.topics?.[2] || '0'));
              if (amount <= BigInt(0)) {
                console.warn(`⚠️ Zero or negative amount for token ${token} in tx ${tx.txHash}`);
                continue;
              }
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
              console.log(`✅ Added reward token ${token} from logs for tx ${tx.txHash}: ${formatted}`);
              break;
            }
          }

          if (!hasAddedReward) {
            console.log(`No reward token found in logs for tx ${tx.txHash}, checking scResults`);
            const esdtResults = results.filter(r =>
              r.receiver === walletAddress &&
              r.data &&
              (r.data.startsWith('RVNEVFRyYW5zZmVy') || r.function === 'ESDTTransfer' || r.function === 'MultiESDTNFTTransfer')
            );

            for (const result of esdtResults) {
              const decodedData = decodeBase64ToString(result.data);
              const parts = decodedData.split('@');
              if (parts.length < 3) {
                console.warn(`⚠️ Invalid ESDTTransfer data for tx ${tx.txHash}:`, decodedData);
                continue;
              }
              const tokenHex = parts[1];
              const amountHex = parts[2];
              const token = decodeHexToString(tokenHex);
              if (!token || lpTokenPattern.test(token)) {
                console.warn(`⚠️ Skipping empty or LP token ${token} in scResult for tx ${tx.txHash}`);
                continue;
              }
              const amount = decodeHexToBigInt(amountHex);
              if (amount <= BigInt(0)) {
                console.warn(`⚠️ Zero or negative amount for token ${token} in tx ${tx.txHash}`);
                continue;
              }
              const decimals = await getTokenDecimals(token);
              const formatted = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed();
              taxRelevantTransactions.push({
                timestamp: tx.timestamp,
                function: func,
                inAmount: formatted,
                inCurrency: token,
                outAmount: '0',
                outCurrency: 'EGLD',
                fee: esdtResults.indexOf(result) === 0 && !hasAddedEGLD ? (BigInt(tx.fee || 0) / BigInt(10**18)).toString() : '0',
                txHash: tx.txHash
              });
              hasAddedReward = true;
              console.log(`✅ Added reward token ${token} from scResults for tx ${tx.txHash}: ${formatted}`);
              break;
            }
          }

          if (!hasAddedReward) {
            console.warn(`⚠️ No valid reward token found for tx ${tx.txHash}, adding empty reward`);
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
          console.log(`Processing wrapEgld for tx ${tx.txHash}: EGLD out=${tx.value}`);
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

        if (['swap_tokens_fixed_input', 'swap_tokens_fixed_output', 'multipairswap'].includes(func)) {
          console.log(`Processing swap for tx ${tx.txHash}: in=${JSON.stringify(tokenTransfersIn)}, out=${JSON.stringify(tokenTransfersOut)}`);
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
            console.log(`✅ Added swap tx ${tx.txHash}: ${inAmount} ${inCurrency} -> ${outAmount} ${outCurrency}`);
            tokenTransfersIn = [];
            tokenTransfersOut = [];
            logs.events = [];
            results.length = 0;
            continue;
          }
        }

        for (const op of tokenTransfersIn) {
          const token = op.identifier || op.name || 'UNKNOWN';
          if (token === 'UNKNOWN') {
            console.warn(`⚠️ Unknown token in operation for tx ${tx.txHash}:`, JSON.stringify(op));
            continue;
          }
          const amount = BigInt(op.value);
          if (amount <= BigInt(0)) {
            console.warn(`⚠️ Zero or negative amount for token ${token} in tx ${tx.txHash}`);
            continue;
          }
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
          console.log(`✅ Added token ${token} from operations for tx ${tx.txHash}: ${formatted}`);
        }

        for (const op of tokenTransfersOut) {
          const token = op.identifier || op.name || 'UNKNOWN';
          if (token === 'UNKNOWN') {
            console.warn(`⚠️ Unknown token in operation for tx ${tx.txHash}:`, JSON.stringify(op));
            continue;
          }
          const amount = BigInt(op.value);
          if (amount <= BigInt(0)) {
            console.warn(`⚠️ Zero or negative amount for token ${token} in tx ${tx.txHash}`);
            continue;
          }
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
          console.log(`✅ Added token ${token} from operations for tx ${tx.txHash}: ${formatted}`);
        }

        const esdtEvents = logs.events?.filter(event =>
          ['ESDTTransfer', 'ESDTNFTTransfer', 'transfer', 'ESDTLocalTransfer'].includes(event.identifier) &&
          decodeBase64ToString(event.topics?.[3] || '') === walletAddress
        ) || [];

        for (const event of esdtEvents) {
          const token = decodeBase64ToString(event.topics?.[0] || '') || 'UNKNOWN';
          if (token === 'UNKNOWN') {
            console.warn(`⚠️ Skipping event with unknown token for tx ${tx.txHash}`);
            continue;
          }
          const amount = decodeHexToBigInt(decodeBase64ToHex(event.topics?.[2] || '0'));
          if (amount <= BigInt(0)) {
            console.warn(`⚠️ Zero or negative amount for token ${token} in tx ${tx.txHash}`);
            continue;
          }
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
          console.log(`✅ Added token ${token} from logs for tx ${tx.txHash}: ${formatted}`);
        }

        const esdtResults = results.filter(r =>
          r.receiver === walletAddress &&
          r.data &&
          (r.data.startsWith('RVNEVFRyYW5zZmVy') || r.function === 'ESDTTransfer' || r.function === 'MultiESDTNFTTransfer')
        );

        for (const result of esdtResults) {
          const decodedData = decodeBase64ToString(result.data);
          const parts = decodedData.split('@');
          if (parts.length < 3) {
            console.warn(`⚠️ Invalid ESDTTransfer data for tx ${tx.txHash}:`, decodedData);
            continue;
          }
          const tokenHex = parts[1];
          const amountHex = parts[2];
          const token = decodeHexToString(tokenHex);
          if (!token) {
            console.warn(`⚠️ Empty token in scResult for tx ${tx.txHash}`);
            continue;
          }
          const amount = decodeHexToBigInt(amountHex);
          if (amount <= BigInt(0)) {
            console.warn(`⚠️ Zero or negative amount for token ${token} in tx ${tx.txHash}`);
            continue;
          }
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
          console.log(`✅ Added token ${token} from scResults for tx ${tx.txHash}: ${formatted}`);
        }

        if (!hasAddedEGLD && egldTransfersIn.length === 0 && tokenTransfersIn.length === 0 && tokenTransfersOut.length === 0 && esdtEvents.length === 0 && esdtResults.length === 0) {
          console.warn(`⚠️ No transfers found for tx ${tx.txHash}: function=${func}, operations=${JSON.stringify(operations)}, events=${JSON.stringify(logs.events)}, results=${JSON.stringify(results)}`);
          if (func !== 'aggregateEgld') {
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
      } catch (err) {
        console.warn(`⚠️ Could not fetch details for tx ${tx.txHash}:`, err.message);
      }
    }

    taxRelevantTransactions = deduplicateTransactions(taxRelevantTransactions);
    console.log(`Unique function names:`, Array.from(uniqueFunctions));

    const result = { allTransactions, taxRelevantTransactions };
    if (taxRelevantTransactions.length === 0) {
      reportProgress(clientId, '⚠️ No tax-relevant transactions found');
    } else {
      reportProgress(clientId, `✅ Completed with ${taxRelevantTransactions.length} tax-relevant transactions`);
    }

    cache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    console.error('❌ Error in fetch-transactions:', error.message);
    reportProgress(clientId, '❌ Failed: ' + error.message);
    res.status(500).json({ error: 'Could not fetch transactions. Please try again later.' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
});
