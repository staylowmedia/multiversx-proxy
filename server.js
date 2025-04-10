const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const cors = require('cors');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 }); // Cache i 1 time

app.use(cors());
app.use(express.json());

// Funksjon for å legge til forsinkelse
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Valider MultiversX-adresse
const validateWalletAddress = (address) => {
    const addressPattern = /^erd1[0-9a-z]{58}$/;
    return addressPattern.test(address);
};

// Proxy-endepunkt for å hente transaksjoner og token-overføringer
app.post('/fetch-transactions', async (req, res) => {
    const { walletAddress, fromDate, toDate } = req.body;

    // Valider parametere
    if (!walletAddress || !fromDate || !toDate) {
        console.error('Missing required parameters:', { walletAddress, fromDate, toDate });
        return res.status(400).json({ error: 'Missing required parameters: walletAddress, fromDate, and toDate are required' });
    }

    // Valider walletAddress-format
    if (!validateWalletAddress(walletAddress)) {
        console.error('Invalid wallet address:', walletAddress);
        return res.status(400).json({ error: 'Invalid wallet address: must start with erd1 and be 62 characters long, containing only lowercase letters and numbers' });
    }

    // Valider datoer
    const fromDateObj = new Date(fromDate);
    const toDateObj = new Date(toDate);
    if (isNaN(fromDateObj) || isNaN(toDateObj)) {
        console.error('Invalid dates:', { fromDate, toDate });
        return res.status(400).json({ error: 'Invalid dates: fromDate and toDate must be valid ISO date strings' });
    }
    if (fromDateObj > toDateObj) {
        console.error('Invalid date range:', { fromDate, toDate });
        return res.status(400).json({ error: 'Invalid date range: fromDate must be before toDate' });
    }

    const startTimestamp = Math.floor(fromDateObj.getTime() / 1000);
    const endTimestamp = Math.floor(toDateObj.getTime() / 1000);

    // Valider tidsstempler
    if (isNaN(startTimestamp) || isNaN(endTimestamp)) {
        console.error('Invalid timestamps:', { startTimestamp, endTimestamp });
        return res.status(400).json({ error: 'Invalid timestamps: could not convert dates to Unix timestamps' });
    }

    let allTransactions = [];
    let transfers = [];
    let tokenDecimalsCache = {};

    try {
        // Test adresseens eksistens først
        console.log(`Verifying account existence for ${walletAddress}...`);
        try {
            const accountResponse = await axios.get(`https://api.multiversx.com/accounts/${walletAddress}`);
            console.log(`Account exists:`, accountResponse.data);
        } catch (error) {
            console.error(`Error verifying account ${walletAddress}:`, {
                status: error.response?.status,
                data: error.response?.data,
                message: error.message
            });
            throw new Error(`Failed to verify account: ${error.response?.data?.message || error.message}`);
        }

        // Hent transaksjoner parallelt
        const pageSize = 500; // Redusert fra 1000 til 500
        let fromIndex = 0;
        const transactionPromises = [];
        const maxConcurrentRequests = 3; // Maks 3 kall samtidig

        while (true) {
            const params = {
                after: startTimestamp,
                before: endTimestamp,
                size: pageSize,
                order: 'asc',
                from: fromIndex
            };
            const cacheKey = `transactions_${walletAddress}_${fromIndex}_${startTimestamp}_${endTimestamp}`;
            let transactions = cache.get(cacheKey);

            if (!transactions) {
                console.log(`Queueing transaction fetch from index ${fromIndex} for ${walletAddress} with params:`, params);
                const url = `https://api.multiversx.com/accounts/${walletAddress}/transactions`;
                console.log(`Request URL: ${url}?${new URLSearchParams(params).toString()}`);
                transactionPromises.push(
                    axios.get(url, { params })
                        .then(response => {
                            const data = response.data;
                            cache.set(cacheKey, data);
                            return data;
                        })
                        .catch(error => {
                            console.error(`Error fetching transactions for ${walletAddress} at index ${fromIndex}:`, {
                                status: error.response?.status,
                                data: error.response?.data,
                                message: error.message
                            });
                            throw new Error(`Failed to fetch transactions: ${error.response?.data?.message || error.message}`);
                        })
                );
            } else {
                transactionPromises.push(Promise.resolve(transactions));
            }

            fromIndex += pageSize;

            // Begrens antall samtidige kall
            if (transactionPromises.length >= maxConcurrentRequests || fromIndex >= 8520) { // Basert på nonce
                const results = await Promise.all(transactionPromises);
                results.forEach(transactions => {
                    if (transactions && transactions.length > 0) {
                        allTransactions = allTransactions.concat(transactions);
                    }
                });
                transactionPromises.length = 0; // Tøm arrayen
                if (results.every(transactions => !transactions || transactions.length < pageSize)) break;
                await delay(500); // Redusert fra 1000 til 500 ms
            }
        }

        // Hent token-overføringer parallelt
        let transferIndex = 0;
        const transferPromises = [];

        while (true) {
            const transferParams = {
                from: startTimestamp,
                to: endTimestamp,
                size: pageSize,
                order: 'asc',
                start: transferIndex
            };
            const cacheKey = `transfers_${walletAddress}_${transferIndex}_${startTimestamp}_${endTimestamp}`;
            let transferBatch = cache.get(cacheKey);

            if (!transferBatch) {
                console.log(`Queueing token transfers fetch from index ${transferIndex} for ${walletAddress} with params:`, transferParams);
                const url = `https://api.multiversx.com/accounts/${walletAddress}/transfers`;
                console.log(`Request URL: ${url}?${new URLSearchParams(transferParams).toString()}`);
                transferPromises.push(
                    axios.get(url, { params: transferParams })
                        .then(response => {
                            const data = response.data;
                            cache.set(cacheKey, data);
                            return data;
                        })
                        .catch(error => {
                            console.error(`Error fetching token transfers for ${walletAddress} at index ${transferIndex}:`, {
                                status: error.response?.status,
                                data: error.response?.data,
                                message: error.message
                            });
                            throw new Error(`Failed to fetch token transfers: ${error.response?.data?.message || error.message}`);
                        })
                );
            } else {
                transferPromises.push(Promise.resolve(transferBatch));
            }

            transferIndex += pageSize;

            if (transferPromises.length >= maxConcurrentRequests) {
                const results = await Promise.all(transferPromises);
                results.forEach(batch => {
                    if (batch && batch.length > 0) {
                        transfers = transfers.concat(batch);
                    }
                });
                transferPromises.length = 0; // Tøm arrayen
                if (results.every(batch => !batch || batch.length < pageSize)) break;
                await delay(500); // Redusert til 500 ms
            }
        }

        // Filtrer skattepliktige transaksjoner
        const taxRelevantTransactions = allTransactions.filter(tx => {
            const func = tx.function || '';
            const hasValue = tx.value && BigInt(tx.value) > 0;
            return hasValue || [
                'claimRewards', 'claim', 'claimRewardsProxy',
                'swapTokensFixedInput', 'swapTokensFixedOutput', 'multiPairSwap',
                'transfer', 'wrapEgld', 'unwrapEgld',
                'aggregateEgld', 'aggregateEsdt',
                'reDelegateRewards', 'ESDTTransfer',
                'ESDTNFTTransfer', 'buy', 'sell'
            ].includes(func);
        });

        // Hent token-desimaler
        const fetchTokenDecimals = async (tokenIdentifier) => {
            if (tokenIdentifier === 'EGLD') return 18;
            if (tokenDecimalsCache[tokenIdentifier]) return tokenDecimalsCache[tokenIdentifier];

            const cacheKey = `tokenDecimals_${tokenIdentifier}`;
            let decimals = cache.get(cacheKey);
            if (!decimals) {
                console.log(`Fetching decimals for token ${tokenIdentifier}...`);
                try {
                    const response = await axios.get(`https://api.multiversx.com/tokens/${tokenIdentifier}`);
                    decimals = response.data.decimals || 18;
                    cache.set(cacheKey, decimals);
                } catch (error) {
                    console.error(`Error fetching decimals for token ${tokenIdentifier}:`, {
                        status: error.response?.status,
                        data: error.response?.data,
                        message: error.message
                    });
                    decimals = 18; // Fallback til 18 desimaler
                }
            }
            tokenDecimalsCache[tokenIdentifier] = decimals;
            return decimals;
        };

        // Koble token-overføringer til transaksjoner
        for (let tx of taxRelevantTransactions) {
            tx.inAmount = '0';
            tx.inCurrency = 'EGLD';
            tx.outAmount = '0';
            tx.outCurrency = 'EGLD';

            const relatedTransfers = transfers.filter(t => t.txHash === tx.txHash);
            const inTransfer = relatedTransfers.find(t => t.sender === walletAddress);
            const outTransfer = relatedTransfers.find(t => t.receiver === walletAddress);

            if (inTransfer) {
                const decimals = await fetchTokenDecimals(inTransfer.identifier);
                tx.inAmount = (BigInt(inTransfer.value) / BigInt(10**decimals)).toString();
                tx.inCurrency = inTransfer.identifier;
            }

            if (outTransfer) {
                const decimals = await fetchTokenDecimals(outTransfer.identifier);
                tx.outAmount = (BigInt(outTransfer.value) / BigInt(10**decimals)).toString();
                tx.outCurrency = outTransfer.identifier;
            }

            if (tx.inAmount === '0' && tx.outAmount === '0') {
                if (BigInt(tx.value || 0) > 0) {
                    if (['transfer', 'reDelegateRewards', 'claimRewards', 'claim'].includes(tx.function)) {
                        tx.outAmount = (BigInt(tx.value) / BigInt(10**18)).toString();
                        tx.outCurrency = 'EGLD';
                    }
                }
            }
        }

        res.json({
            allTransactions,
            taxRelevantTransactions
        });
    } catch (error) {
        console.error('Error in fetch-transactions:', error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Proxy server running on port ${PORT}`);
});
