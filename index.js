require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const BL_KEY = process.env.BATCHLEADS_API_KEY;

app.post('/property', async (req, res) => {
  const { address } = req.body;
  try {
    const response = await axios.post(
      'https://api.batchleads.io/v1/property/search',
      { address },
      { headers: { 'x-api-key': BL_KEY, 'Content-Type': 'application/json' } }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/comps', async (req, res) => {
  const { address, radius, beds, baths } = req.body;
  try {
    const response = await axios.post(
      'https://api.batchleads.io/v1/comps/search',
      { address, radius: radius || 1, beds, baths },
      { headers: { 'x-api-key': BL_KEY, 'Content-Type': 'application/json' } }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
