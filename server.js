// server.js
const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const cors = require('cors');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 }); // 1 hour cache

app.use(cors());
app.use(express.json());

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const validateWalletAddress = (address) => {
    const addressPattern = /^erd1[0-9a-z]{58}$/;
    return addressPattern.test(address);
};

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
    if (isNaN(fromDateObj) || isNaN(toDateObj) || fromDateObj > toDateObj) {
        return res.status(400).json({ error: 'Invalid date range' });
    }

    const startTimestamp = Math.floor(fromDateObj.getTime() / 1000);
    const endTimestamp = Math.floor(toDateObj.getTime() / 1000);

    let allTransactions = [];
    let transfers = [];
    let tokenDecimalsCache = {};

    try {
        // Account check
        await axios.get(`https://api.multiversx.com/accounts/${walletAddress}`);

        // Transactions
        const pageSize = 500;
        let fromIndex = 0;
        const transactionPromises = [];
        const maxConcurrentRequests = 3;

        while (fromIndex + pageSize <= 10000) {
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
                transactionPromises.push(
                    axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transactions`, { params })
                        .then(response => {
                            const data = response.data;
                            cache.set(cacheKey, data);
                            return data;
                        })
                );
            } else {
                transactionPromises.push(Promise.resolve(transactions));
            }

            fromIndex += pageSize;

            if (transactionPromises.length >= maxConcurrentRequests) {
                const results = await Promise.all(transactionPromises);
                results.forEach(transactions => {
                    if (transactions && transactions.length > 0) {
                        allTransactions = allTransactions.concat(transactions);
                    }
                });
                transactionPromises.length = 0;
                if (results.every(t => !t || t.length < pageSize)) break;
                await delay(500);
            }
        }

        // Transfers (SAFE)
        let transferIndex = 0;
        const transferPromises = [];

        while (true) {
            if (transferIndex + pageSize > 10000) {
                console.log(`🔴 Skipping fetch to avoid API limit: start=${transferIndex}, size=${pageSize}`);
                break;
            }

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
                transferPromises.push(
                    axios.get(`https://api.multiversx.com/accounts/${walletAddress}/transfers`, { params: transferParams })
                        .then(response => {
                            const data = response.data;
                            cache.set(cacheKey, data);
                            return data;
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
                transferPromises.length = 0;
                if (results.every(b => !b || b.length < pageSize)) break;
                await delay(500);
            }
        }

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

        const fetchTokenDecimals = async (tokenIdentifier) => {
            if (tokenIdentifier === 'EGLD') return 18;
            if (tokenDecimalsCache[tokenIdentifier]) return tokenDecimalsCache[tokenIdentifier];

            const cacheKey = `tokenDecimals_${tokenIdentifier}`;
            let decimals = cache.get(cacheKey);
            if (!decimals) {
                try {
                    const response = await axios.get(`https://api.multiversx.com/tokens/${tokenIdentifier}`);
                    decimals = response.data.decimals || 18;
                    cache.set(cacheKey, decimals);
                } catch (error) {
                    decimals = 18;
                }
            }
            tokenDecimalsCache[tokenIdentifier] = decimals;
            return decimals;
        };

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
