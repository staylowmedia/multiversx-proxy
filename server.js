<script>
    window.addEventListener('DOMContentLoaded', () => {
        document.getElementById('fromDate').value = '2024-01-01';
        document.getElementById('toDate').value = '2024-12-31';
    });

    let allTransactions = [];
    let taxRelevantTransactions = [];
    let currentPage = 1;
    const transactionsPerPage = 25;

    document.getElementById('transactionForm').addEventListener('submit', async (event) => {
        event.preventDefault();

        const walletAddress = document.getElementById('walletAddress').value.trim();
        const fromDateInput = document.getElementById('fromDate').value;
        const toDateInput = document.getElementById('toDate').value;
        const errorDiv = document.getElementById('error');
        const loadingDiv = document.getElementById('loading');
        const progressDiv = document.getElementById('progress');
        const resultsDiv = document.getElementById('results');
        const downloadOptionsDiv = document.getElementById('downloadOptions');
        const button = event.submitter;

        button.disabled = true;
        errorDiv.style.display = 'none';
        loadingDiv.style.display = 'block';
        progressDiv.style.display = 'block';
        resultsDiv.style.display = 'none';
        downloadOptionsDiv.style.display = 'none';

        // Inputvalidering
        if (!walletAddress.startsWith('erd1') || walletAddress.length !== 62) {
            errorDiv.textContent = 'Please enter a valid MultiversX wallet address.';
            errorDiv.style.display = 'block';
            loadingDiv.style.display = 'none';
            progressDiv.style.display = 'none';
            button.disabled = false;
            return;
        }

        try {
            progressDiv.textContent = '🚀 Connecting to proxy...';

            const response = await fetch('https://multiversx-proxy.onrender.com/fetch-transactions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    walletAddress,
                    fromDate: new Date(fromDateInput).toISOString(),
                    toDate: new Date(toDateInput).toISOString()
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Unknown error from proxy.');
            }

            const data = await response.json();
            allTransactions = data.allTransactions;
            taxRelevantTransactions = data.taxRelevantTransactions;

            if (taxRelevantTransactions.length === 0) {
                errorDiv.textContent = 'No tax-relevant transactions found for the selected period.';
                errorDiv.style.display = 'block';
                loadingDiv.style.display = 'none';
                progressDiv.style.display = 'none';
                button.disabled = false;
                return;
            }

            document.getElementById('summary').innerHTML = `
                <p><strong>Total tax-relevant transactions:</strong> ${taxRelevantTransactions.length}</p>
                <p><strong>Total all transactions:</strong> ${allTransactions.length}</p>
            `;

            currentPage = 1;
            renderPage();
            resultsDiv.style.display = 'block';
            downloadOptionsDiv.style.display = 'block';

        } catch (error) {
            errorDiv.textContent = 'Error: ' + error.message;
            errorDiv.style.display = 'block';
        } finally {
            loadingDiv.style.display = 'none';
            progressDiv.style.display = 'none';
            button.disabled = false;
        }
    });

    function renderPage() {
        const startIndex = (currentPage - 1) * transactionsPerPage;
        const endIndex = startIndex + transactionsPerPage;
        const pageTransactions = taxRelevantTransactions.slice(startIndex, endIndex);

        const tableBody = document.getElementById('taxTableBody');
        tableBody.innerHTML = '';
        pageTransactions.forEach(tx => {
            const row = document.createElement('tr');
            const feeAmount = (BigInt(tx.fee || 0) / BigInt(10**18)).toString();
            row.innerHTML = `
                <td>${new Date(tx.timestamp * 1000).toISOString()}</td>
                <td>${tx.function || 'N/A'}</td>
                <td>${tx.inAmount}</td>
                <td>${tx.inCurrency}</td>
                <td>${tx.outAmount}</td>
                <td>${tx.outCurrency}</td>
                <td>${feeAmount}</td>
                <td>EGLD</td>
                <td class="txhash-col">${tx.txHash}</td>
            `;
            tableBody.appendChild(row);
        });

        const totalPages = Math.ceil(taxRelevantTransactions.length / transactionsPerPage);
        document.getElementById('pageInfo').textContent = `Page ${currentPage} of ${totalPages}`;
        document.getElementById('prevPage').disabled = currentPage === 1;
        document.getElementById('nextPage').disabled = currentPage === totalPages;
    }

    function prevPage() {
        if (currentPage > 1) {
            currentPage--;
            renderPage();
        }
    }

    function nextPage() {
        const totalPages = Math.ceil(taxRelevantTransactions.length / transactionsPerPage);
        if (currentPage < totalPages) {
            currentPage++;
            renderPage();
        }
    }

    function downloadTaxCSV() {
        const headers = ['Date/time','Type of transaction','In','In currency','Out','Out currency','Fee','Fee currency','Tx Hash'];
        const rows = taxRelevantTransactions.map(tx => {
            const feeAmount = (BigInt(tx.fee || 0) / BigInt(10**18)).toString();
            return [
                new Date(tx.timestamp * 1000).toISOString(),
                tx.function || 'N/A',
                tx.inAmount, tx.inCurrency,
                tx.outAmount, tx.outCurrency,
                feeAmount, 'EGLD',
                tx.txHash
            ].join(',');
        });
        downloadCSV([headers.join(','), ...rows], 'multiversx_tax_transactions.csv');
    }

    function downloadFullCSV() {
        const headers = ['txHash','sender','receiver','value','timestamp','status','function'];
        const rows = allTransactions.map(tx => [
            tx.txHash || '', tx.sender || '', tx.receiver || '',
            tx.value || '0', new Date(tx.timestamp * 1000).toISOString(),
            tx.status || '', tx.function || ''
        ].join(','));
        downloadCSV([headers.join(','), ...rows], 'multiversx_full_transactions.csv');
    }

    function downloadCSV(lines, filename) {
        const blob = new Blob([lines.join('\\n')], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        window.URL.revokeObjectURL(url);
    }
</script>
