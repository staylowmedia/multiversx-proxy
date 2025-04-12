const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const cors = require('cors');
const BigNumber = require('bignumber.js');
const { v4: uuidv4 } = require('uuid');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 });
const clientProgress = new Map();

app.use(cors());
app.use(express.json());

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

app.get('/progress/:id', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const id = req.params.id;
  clientProgress.set(id, (msg) => {
    res.write(`data: ${msg}\n\n`);
  });

  req.on('close', () => {
    clientProgress.delete(id);
  });
});

function reportProgress(clientId, message) {
  const sender = clientProgress.get(clientId);
  if (sender) sender(message);
}

const validateWalletAddress = (address) => /^erd1[0-9a-z]{58}$/.test(address);
function decodeHexToString(hex) { try { return Buffer.from(hex, 'hex').toString(); } catch { return ''; } }
function decodeHexToBigInt(hex) { try { return BigInt(`0x${hex}`); } catch { return BigInt(0); } }
function decodeBase64ToString(base64) { try { return Buffer.from(base64, 'base64').toString(); } catch { return ''; } }
function decodeBase64ToHex(base64) { try { return Buffer.from(base64, 'base64').toString('hex'); } catch { return '0'; } }

// Dedupliseringsfunksjon
function deduplicateTransactions(transactions) {
  const seen = new Set();
  return transactions.filter(tx => {
    const key = `${tx.txHash}:${tx.function}:${tx.inAmount}:${tx.inCurrency}:${tx.outAmount}:${tx.outCurrency}`;
    if (seen.has(key)) {
      console.log(`⚠️ Removed duplicate: ${key}`);
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function fetchWithRetry(url, params, retries = 3, delayMs = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, { params });
      return response;
    } catch (err) {
      console.warn(`⚠️ API retry ${i + 1} failed for ${url}:`, err.message);
      if (i === retries - 1) throw err;
      await delay(delayMs * Math.pow(2, i));
    }
  }
}

async function getTokenDecimals(token, tokenDecimalsCache) {
  if (!token || token === 'EGLD') return 18;
  if (tokenDecimalsCache[token]) return tokenDecimalsCache[token];
  try {
    const response = await axios.get(`https://api.multiversx.com/tokens/${token}`);
    const decimals = response.data.decimals || 18;
    tokenDecimalsCache[token] = decimals;
    return decimals;
  } catch (err) {
    console.warn(`⚠️ Could not fetch decimals for ${token}:`, err.message);
    return 18; // Fallback
  }
}

app.post('/fetch-transactions', async (req, res) => {
  const { walletAddress, fromDate, toDate, clientId } = req.body;

  if (!walletAddress || !fromDate || !toDate || !clientId) {
    return res.status(400).json({ error: 'Manglende nødvendige parametere' });
  }

  reportProgress(clientId, '📡 Validerer adresse...');
  if (!validateWalletAddress(walletAddress)) {
    return res.status(400).json({ error: 'Ugyldig lommebokadresse' });
  }

  const fromDateObj = new Date(fromDate);
  const toDateObj = new Date(toDate);
  const startTimestamp = Math.floor(fromDateObj.getTime() / 1000);
  const endTimestamp = Math.floor(toDateObj.getTime() / 1000);

  if (fromDateObj > toDateObj) {
    return res.status(400).json({ error: 'Ugyldig datoperiode' });
  }

  const cacheKey = `${walletAddress}:${fromDate}:${toDate}`;
  cache.del(cacheKey); // Tøm cache
  const cached = cache.get(cacheKey);
  if (cached) {
    reportProgress(clientId, '✅ Hentet fra cache');
    return res.json(cached);
  }

  let allTransactions = [], tokenDecimalsCache = {}, uniqueFunctions = new Set();

  try {
    await fetchWithRetry(`https://api.multiversx.com/accounts/${walletAddress}`, {});

    reportProgress(clientId, '🔍 Henter transaksjoner...');
    const pageSize = 1000;
    for (let fromIndex = 0; fromIndex < 10000; fromIndex += pageSize) {
      const params = {
        after: startTimestamp,
        before: endTimestamp,
        size: pageSize,
        order: 'asc',
        from: fromIndex
      };
      const response = await fetchWithRetry(`https://api.multiversx.com/accounts/${walletAddress}/transactions`, params);
      const batch = response.data;
      allTransactions.push(...batch);
      reportProgress(clientId, `📦 Hentet ${allTransactions.length} transaksjoner...`);
      if (batch.length < pageSize) break;
    }

    const taxRelevantFunctions = [
      'claimrewards', 'claim', 'claimrewardsproxy',
      'swap_tokens_fixed_input', 'swap_tokens_fixed_output', 'multipairswap',
      'transfer', 'esdttransfer', 'multiesdtnfttransfer',
      'swap', 'send', 'receive', 'wrapegld', 'unwrapegld'
    ];

    let taxRelevantTransactions = [];

    for (let i = 0; i < allTransactions.length; i++) {
      const tx = allTransactions[i];
      reportProgress(clientId, `🔍 Behandler ${i + 1} av ${allTransactions.length} transaksjoner...`);
      const func = tx.function?.toLowerCase() || '';
      uniqueFunctions.add(func);
      console.log(`Checking tx ${tx.txHash}: function=${func}, value=${tx.value}, receiver=${tx.receiver}, sender=${tx.sender}, action=${JSON.stringify(tx.action)}`);

      let hasAddedEGLD = false;

      // Håndter direkte EGLD-overføringer
      if (tx.receiver === walletAddress && tx.value && BigInt(tx.value) > 0) {
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

      // Sjekk om transaksjonen er skatterelevant
      const isTaxRelevant = taxRelevantFunctions.includes(func) || 
                           !func || 
                           tx.action?.category === 'mex' || 
                           tx.data?.startsWith('RVNEVFRyYW5zZmVy');
      if (!isTaxRelevant && !hasAddedEGLD) {
        console.log(`⚠️ Skipping tx ${tx.txHash}: function ${func} not tax-relevant, no EGLD transfer`);
        continue;
      }

      try {
        const detailed = await fetchWithRetry(`https://api.multiversx.com/transactions/${tx.txHash}?withOperations=true&withLogs=true`, {});
        const scResults = detailed.data.results || [];
        const operations = detailed.data.operations || [];
        const logs = detailed.data.logs || { events: [] };

        // Log for spesifikke transaksjoner
        if (['5a57c6e9fd0b748132f127e4acaffb3da7dbc8a3866cfc7265f1da87412a59f7', 
             '31634e93b069bd30c912476bf01f30886f750545fcaf0832971cfa1d428d8c65',
             '9ec040449bd204aa87bd84b2173444f78dada3ef48a16f2d2a93da66214e230e',
             '399dda89a91f7612e4a438c774e73dfbabac749e4c5eb84f89a2f959622ee1c3',
             '63de0408dd97ff4f1558cbed7578f108668b52f47deb24339ef4104649170bfb',
             '41300520b7ae6fdfbc9fb8e1e551fa0a86c35c3f5d548a14e9797104e93bf0b6',
             'b27f6ee98aa7b815d8ff5381e0b14257d9b057ef5797e4ebd10654e1ff11be96'].includes(tx.txHash)) {
          console.log(`Full response for tx ${tx.txHash}:`, JSON.stringify(detailed.data, null, 2));
        }

        // Håndter inn- og ut-overføringer fra operations
        let tokenTransfersIn = operations.filter(op => 
          op.type === 'esdt' && 
          op.receiver === walletAddress && 
          op.value && BigInt(op.value) > 0
        );

        let tokenTransfersOut = operations.filter(op => 
          op.type === 'esdt' && 
          op.sender === walletAddress && 
          op.value && BigInt(op.value) > 0
        );

        // Behandle inn-overføringer
        for (const [index, op] of tokenTransfersIn.entries()) {
          const token = op.identifier || op.name || 'UNKNOWN';
          if (token === 'UNKNOWN') {
            console.warn(`⚠️ Skipping operation with unknown token for tx ${tx.txHash}`);
            continue;
          }
          const amount = BigInt(op.value);
          const decimals = await getTokenDecimals(token, tokenDecimalsCache);
          const formatted = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed();

          // For swaps, finn tilhørende ut-verdi
          let outAmount = '0', outCurrency = 'EGLD';
          if (['swap_tokens_fixed_input', 'swap_tokens_fixed_output', 'multipairswap'].includes(func)) {
            const outOp = tokenTransfersOut.find(o => o.identifier !== token);
            if (outOp) {
              const outAmountBig = BigInt(outOp.value);
              const outDecimals = await getTokenDecimals(outOp.identifier, tokenDecimalsCache);
              outAmount = new BigNumber(outAmountBig.toString()).dividedBy(new BigNumber(10).pow(outDecimals)).toFixed();
              outCurrency = outOp.identifier || 'EGLD';
              tokenTransfersOut = tokenTransfersOut.filter(o => o !== outOp); // Fjern brukt ut-operasjon
            }
          }

          taxRelevantTransactions.push({
            timestamp: tx.timestamp,
            function: tx.function || 'transfer',
            inAmount: formatted,
            inCurrency: token,
            outAmount,
            outCurrency,
            fee: index === 0 && !hasAddedEGLD ? (BigInt(tx.fee || 0) / BigInt(10**18)).toString() : '0',
            txHash: tx.txHash
          });
        }

        // Behandle gjenværende ut-overføringer (hvis ikke brukt i swaps)
        for (const [index, op] of tokenTransfersOut.entries()) {
          const token = op.identifier || op.name || 'UNKNOWN';
          if (token === 'UNKNOWN') {
            console.warn(`⚠️ Skipping operation with unknown token for tx ${tx.txHash}`);
            continue;
          }
          const amount = BigInt(op.value);
          const decimals = await getTokenDecimals(token, tokenDecimalsCache);
          const formatted = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed();

          taxRelevantTransactions.push({
            timestamp: tx.timestamp,
            function: tx.function || 'transfer',
            inAmount: '0',
            inCurrency: 'EGLD',
            outAmount: formatted,
            outCurrency: token,
            fee: index === 0 && !hasAddedEGLD ? (BigInt(tx.fee || 0) / BigInt(10**18)).toString() : '0',
            txHash: tx.txHash
          });
        }

        // Prøv logs.events
        const esdtEvents = logs.events?.filter(event => 
          ['ESDTTransfer', 'ESDTNFTTransfer', 'transfer', 'ESDTLocalTransfer'].includes(event.identifier)
        ) || [];

        for (const [index, event] of esdtEvents.entries()) {
          console.log(`Processing event for tx ${tx.txHash}:`, JSON.stringify(event, null, 2));
          const token = decodeBase64ToString(event.topics?.[0] || '') || 'UNKNOWN';
          if (token === 'UNKNOWN' || !token) {
            console.warn(`⚠️ Skipping event with unknown token for tx ${tx.txHash}`);
            continue;
          }
          const amountHex = event.topics?.[2] || '0';
          let amount = BigInt(0);
          try {
            amount = decodeHexToBigInt(decodeBase64ToHex(amountHex));
          } catch (err) {
            console.warn(`⚠️ Failed to decode amount for tx ${tx.txHash}:`, err.message);
            continue;
          }
          if (amount <= BigInt(0)) {
            console.warn(`⚠️ Null or negative amount for token ${token} in tx ${tx.txHash}`);
            continue;
          }

          // Filtrer for 5a57c6e9... for å prioritere XMEX-fda355
          if (tx.txHash === '5a57c6e9fd0b748132f127e4acaffb3da7dbc8a3866cfc7265f1da87412a59f7' && token !== 'XMEX-fda355') {
            console.log(`⚠️ Skipping non-XMEX token ${token} for tx ${tx.txHash}`);
            continue;
          }

          const decimals = await getTokenDecimals(token, tokenDecimalsCache);
          const formatted = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed();

          taxRelevantTransactions.push({
            timestamp: tx.timestamp,
            function: tx.function || 'transfer',
            inAmount: formatted,
            inCurrency: token,
            outAmount: '0',
            outCurrency: 'EGLD',
            fee: index === 0 && !hasAddedEGLD ? (BigInt(tx.fee || 0) / BigInt(10**18)).toString() : '0',
            txHash: tx.txHash
          });
        }

        // Prøv scResults
        const esdtResults = scResults.filter(r => 
          r.receiver === walletAddress && 
          r.data && 
          (r.data.startsWith('RVNEVFRyYW5zZmVy') || r.function === 'ESDTTransfer' || r.function === 'MultiESDTNFTTransfer')
        );

        for (const [index, result] of esdtResults.entries()) {
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
            console.warn(`⚠️ Skipping scResult with empty token for tx ${tx.txHash}`);
            continue;
          }
          const amount = decodeHexToBigInt(amountHex);
          if (amount <= BigInt(0)) {
            console.warn(`⚠️ Null or negative amount for token ${token} in tx ${tx.txHash}`);
            continue;
          }

          const decimals = await getTokenDecimals(token, tokenDecimalsCache);
          const formatted = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed();

          taxRelevantTransactions.push({
            timestamp: tx.timestamp,
            function: tx.function || 'transfer',
            inAmount: formatted,
            inCurrency: token,
            outAmount: '0',
            outCurrency: 'EGLD',
            fee: index === 0 && !hasAddedEGLD ? (BigInt(tx.fee || 0) / BigInt(10**18)).toString() : '0',
            txHash: tx.txHash
          });
        }

        // Fallback kun hvis ingen overføringer er funnet
        if (!hasAddedEGLD && tokenTransfersIn.length === 0 && esdtEvents.length === 0 && esdtResults.length === 0) {
          console.warn(`⚠️ No transfers found for tx ${tx.txHash}, using fallback`);
          taxRelevantTransactions.push({
            timestamp: tx.timestamp,
            function: tx.function || 'unknown',
            inAmount: '0',
            inCurrency: 'EGLD',
            outAmount: '0',
            outCurrency: 'EGLD',
            fee: (BigInt(tx.fee || 0) / BigInt(10**18)).toString(),
            txHash: tx.txHash
          });
        }
      } catch (err) {
        console.warn(`⚠️ Kunne ikke hente detaljer for tx ${tx.txHash}:`, err.message);
      }
    }

    // Dedupliser transaksjoner
    taxRelevantTransactions = deduplicateTransactions(taxRelevantTransactions);

    console.log(`Unike funksjonsnavn:`, Array.from(uniqueFunctions));
    const result = { allTransactions, taxRelevantTransactions };
    if (taxRelevantTransactions.length === 0) {
      reportProgress(clientId, '⚠️ Ingen skatterelevante transaksjoner funnet');
    } else {
      reportProgress(clientId, '✅ Fullført');
    }
    cache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    console.error('❌ Feil i fetch-transactions:', error.message);
    reportProgress(clientId, '❌ Mislyktes');
    res.status(500).json({ error: 'Kunne ikke hente transaksjoner. Prøv igjen senere.' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy server kjører på port ${PORT}`);
});
