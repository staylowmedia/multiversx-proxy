import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

app.get('/api/transactions/:address', async (req, res) => {
  const { address } = req.params;
  const { size = 50, from = 0 } = req.query;

  const url = `https://api.multiversx.com/accounts/${address}/transactions?size=${size}&from=${from}`;

  try {
    const response = await fetch(url);
    const contentType = response.headers.get("content-type");

    // 🔒 Sjekk at vi faktisk får JSON
    if (!contentType || !contentType.includes("application/json")) {
      const errorText = await response.text();
      console.error(`❌ Ikke JSON fra API:\n${errorText}`);
      return res.status(502).send({ error: "Ugyldig respons fra MultiversX API" });
    }

    const data = await response.json();
    res.send(data);
  } catch (error) {
    console.error("❌ Error fetching transactions:", error);
    res.status(500).send({ error: "Feil ved henting av transaksjoner" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Proxy server running on port ${PORT}`);
});
