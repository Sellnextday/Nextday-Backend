const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function extractJSON(text) {
  text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    return text.substring(first, last + 1);
  }
  return text.trim();
}

app.post('/analyze', async (req, res) => {
  const { prompt, system } = req.body;

  try {
    const response = await axios({
      method: 'post',
      url: 'https://api.anthropic.com/v1/messages',
      timeout: 120000,
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      data: {
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: system,
        messages: [{ role: 'user', content: prompt }]
      }
    });

    const content = response.data.content;
    const textBlock = content.find(function(b) { return b.type === 'text'; });

    if (!textBlock) {
      return res.status(500).json({ error: 'No text response from Claude' });
    }

    const jsonStr = extractJSON(textBlock.text);

    try {
      JSON.parse(jsonStr);
      return res.json({ response: jsonStr });
    } catch (parseErr) {
      console.error('JSON parse failed:', jsonStr.substring(0, 200));
      return res.status(500).json({ error: 'Claude did not return valid JSON. Try again.' });
    }

  } catch (err) {
    const errMsg = (err.response && err.response.data && err.response.data.error && err.response.data.error.message) || err.message;
    console.error('Error:', errMsg);
    return res.status(500).json({ error: errMsg });
  }
});

app.get('/health', function(req, res) { res.json({ status: 'ok' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Server running on port ' + PORT); });
