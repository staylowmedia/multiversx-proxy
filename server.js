// server.js - optimalisert for å unngå duplikate transaksjoner uten å fjerne funksjonalitet

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

function deduplicateTransactions(transactions) {
  const seen = new Set();
  const result = [];

  for (const tx of transactions) {
    const normalizedFunc = (tx.function || '').toLowerCase();
    const key = `${tx.txHash}:${normalizedFunc}:${tx.inAmount}:${tx.inCurrency}:${tx.outAmount}:${tx.outCurrency}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ ...tx, function: normalizedFunc });
    } else {
      console.log(`⚠️ Duplikat hoppet over: ${key}`);
    }
  }

  return result;
}

// ... resten av filen forblir uendret
