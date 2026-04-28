const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function extractJSON(text) {
  // Remove markdown fences
  text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
  // Find first { and last } to extract JSON block
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
          const jsonStr = extractJSON(textBlock.text);
          // Validate it parses before sending
          try {
            JSON.parse(jsonStr);
            return res.json({ response: jsonStr });
          } catch(parseErr) {
            // If JSON is invalid, ask Claude to fix it
            messages.push({
              role: 'user',
              content: 'Your response was not valid JSON. Return ONLY the raw JSON object with no text before or after it, no markdown, no explanation. Just the { } JSON block.'
            });
            continue;
          }
        }
        return res.status(500).json({ error: 'No text in response' });
      }

      if (stopReason === 'tool_use') {
        const toolUseBlocks = content.filter(function(b) { return b.type === 'tool_use'; });
        searchCount += toolUseBlocks.length;

        if (searchCount >= MAX_SEARCHES) {
          messages.push({
            role: 'user',
            content: toolUseBlocks.map(function(block) {
              return {
                type: 'tool_result',
                tool_use_id: block.id,
                content: 'Search limit reached. Using data gathered so far. Now output ONLY the raw JSON object — no text, no markdown, no explanation before or after.'
              };
            })
          });
        } else {
          messages.push({
            role: 'user',
            content: toolUseBlocks.map(function(block) {
              return {
                type: 'tool_result',
                tool_use_id: block.id,
                content: block.content || ''
              };
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
