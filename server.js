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
function decodeHexToString(hex) { return Buffer.from(hex, 'hex').toString(); }
function decodeHexToBigInt(hex) { return BigInt(`0x${hex}`); }
function decodeBase64ToString(base64) { return Buffer.from(base64, 'base64').toString(); }

async function fetchWithRetry(url, params, retries = 3, delayMs = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, { params });
      return response;
    } catch (err) {
      if (i === retries - 1) throw err;
      await delay(delayMs * Math.pow(2, i));
    }
  }
}

async function getTokenDecimals(token, tokenDecimalsCache) {
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
  const cached = cache.get(cacheKey);
  if (cached) {
    reportProgress(clientId, '✅ Hentet fra cache');
    return res.json(cached);
  }

  let allTransactions = [], tokenDecimalsCache = {};

  try {
    await axios.get(`https://api.multiversx.com/accounts/${walletAddress}`);

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
      'claimrewards', 'claim', 'claimrewardsproxy'
    ];

    let taxRelevantTransactions = [];

    for (let i = 0; i < allTransactions.length; i++) {
      const tx = allTransactions[i];
      reportProgress(clientId, `🔍 Behandler ${i + 1} av ${allTransactions.length} transaksjoner...`);
      const func = tx.function?.toLowerCase() || '';
      const isTaxRelevant = taxRelevantFunctions.includes(func);

      if (!isTaxRelevant) continue;

      try {
        const detailed = await fetchWithRetry(`https://api.multiversx.com/transactions/${tx.txHash}?withOperations=true`, {});
        const scResults = detailed.data.results || [];
        const operations = detailed.data.operations || [];

        // Log rådata for feilsøking (fjern i produksjon)
        console.log(`scResults for tx ${tx.txHash}:`, JSON.stringify(scResults, null, 2));
        console.log(`Operations for tx ${tx.txHash}:`, JSON.stringify(operations, null, 2));

        // Håndter token-overføringer fra operations
        let tokenTransfers = operations.filter(op => 
          (op.action === 'transfer' || op.action === 'ESDTTransfer') && 
          op.type === 'esdt' && 
          op.receiver === walletAddress // Kun overføringer til lommeboken
        );

        if (tokenTransfers.length > 0) {
          for (const [index, op] of tokenTransfers.entries()) {
            const token = op.identifier || op.name;
            const amount = BigInt(op.value || '0');
            if (amount === BigInt(0)) {
              console.warn(`⚠️ Null amount for token ${token} in tx ${tx.txHash}`);
              continue;
            }
            const decimals = await getTokenDecimals(token, tokenDecimalsCache);
            const formatted = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed();

            taxRelevantTransactions.push({
              timestamp: tx.timestamp,
              function: tx.function,
              inAmount: formatted,
              inCurrency: token,
              outAmount: '0',
              outCurrency: 'EGLD',
              fee: index === 0 ? (BigInt(tx.fee || 0) / BigInt(10**18)).toString() : '0', // Gebyr kun på første linje
              txHash: tx.txHash
            });
          }
        } else {
          // Prøv scResults som fallback
          const esdtTransfers = scResults.filter(r => r.data && (
            r.data.startsWith('RVNEVFRyYW5zZmVy') || // ESDTTransfer
            r.data.includes('transfer') // Mer fleksibel sjekk
          ));
          if (esdtTransfers.length > 0) {
            for (const [index, result] of esdtTransfers.entries()) {
              const decodedData = decodeBase64ToString(result.data);
              const parts = decodedData.split('@');
              if (parts.length < 3) {
                console.warn(`⚠️ Invalid ESDTTransfer data for tx ${tx.txHash}:`, decodedData);
                continue;
              }

              const tokenHex = parts[1];
              const amountHex = parts[2];
              const token = decodeHexToString(tokenHex);
              const amount = decodeHexToBigInt(amountHex);
              if (amount === BigInt(0)) {
                console.warn(`⚠️ Null amount for token ${token} in tx ${tx.txHash}`);
                continue;
              }
              const decimals = await getTokenDecimals(token, tokenDecimalsCache);
              const formatted = new BigNumber(amount.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed();

              taxRelevantTransactions.push({
                timestamp: tx.timestamp,
                function: tx.function,
                inAmount: formatted,
                inCurrency: token,
                outAmount: '0',
                outCurrency: 'EGLD',
                fee: index === 0 ? (BigInt(tx.fee || 0) / BigInt(10**18)).toString() : '0',
                txHash: tx.txHash
              });
            }
          } else {
            // Fallback for transaksjoner uten token-overføringer
            console.warn(`⚠️ No token transfers found for tx ${tx.txHash}, using fallback`);
            taxRelevantTransactions.push({
              timestamp: tx.timestamp,
              function: tx.function,
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
        console.warn(`⚠️ Kunne ikke hente detaljer for tx ${tx.txHash}:`, err.message);
      }
    }

    const result = { allTransactions, taxRelevantTransactions };
    cache.set(cacheKey, result);
    reportProgress(clientId, '✅ Fullført');
    res.json(result);
  } catch (error) {
    console.error('❌ Feil i fetch-transactions:', error);
    reportProgress(clientId, '❌ Mislyktes');
    res.status(500).json({ error: 'Kunne ikke hente transaksjoner. Prøv igjen senere.' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy server kjører på port ${PORT}`);
});
