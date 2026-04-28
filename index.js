const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function extractJSON(text) {
  text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const match = text.match(/\{[\s\S]*"property_address"[\s\S]*\}/);
  if (match) return match[0];
  return text;
}

app.post('/analyze', async (req, res) => {
  const { prompt, system } = req.body;

  try {
    let messages = [{ role: 'user', content: prompt }];
    let searchCount = 0;
    const MAX_SEARCHES = 4;

    while (true) {
      const response = await axios({
        method: 'post',
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        data: {
          model: 'claude-sonnet-4-6',
          max_tokens: 4096,
          system: system,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: messages
        }
      });

      const stopReason = response.data.stop_reason;
      const content = response.data.content;

      console.log('stop_reason:', stopReason, '| searches used:', searchCount);
      messages.push({ role: 'assistant', content: content });

      if (stopReason === 'end_turn') {
        const textBlock = content.find(function(b) { return b.type === 'text'; });
        if (textBlock) {
          return res.json({ response: extractJSON(textBlock.text) });
        }
        return res.status(500).json({ error: 'No text in response' });
      }

      if (stopReason === 'tool_use') {
        const toolUseBlocks = content.filter(function(b) { return b.type === 'tool_use'; });
        searchCount += toolUseBlocks.length;

        // If too many searches, force Claude to stop and return what it has
        if (searchCount >= MAX_SEARCHES) {
          messages.push({
            role: 'user',
            content: toolUseBlocks.map(function(block) {
              return { type: 'tool_result', tool_use_id: block.id, content: 'Search limit reached. Use the data already gathered to produce the final JSON response now.' };
            })
          });
        } else {
          messages.push({
            role: 'user',
            content: toolUseBlocks.map(function(block) {
              return { type: 'tool_result', tool_use_id: block.id, content: block.content || '' };
            })
          });
        }
        continue;
      }

      break;
    }

    return res.status(500).json({ error: 'Unexpected end of loop' });

  } catch (err) {
    const errMsg = (err.response && err.response.data && err.response.data.error && err.response.data.error.message) || err.message;
    console.error('Error:', errMsg);
    return res.status(500).json({ error: errMsg });
  }
});

app.get('/health', function(req, res) { res.json({ status: 'ok' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Server running on port ' + PORT); });
