const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 8000;

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
    let iterationCount = 0;
    const MAX_ITERATIONS = 10;

    while (iterationCount < MAX_ITERATIONS) {
      iterationCount++;

      const response = await axios({
        method: 'post',
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        data: {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: system,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: messages
        }
      });

      const data = response.data;
      const stopReason = data.stop_reason;
      const content = data.content;

      console.log('Iteration ' + iterationCount + ', stop_reason: ' + stopReason);

      messages.push({ role: 'assistant', content: content });

      if (stopReason === 'end_turn') {
        const textBlock = content.find(function(b) { return b.type === 'text'; });
        if (textBlock) {
          const jsonText = extractJSON(textBlock.text);
          return res.json({ response: jsonText });
        }
        return res.status(500).json({ error: 'No text in response' });
      }

      if (stopReason === 'tool_use') {
        const toolUseBlocks = content.filter(function(b) { return b.type === 'tool_use'; });
        console.log('Tools called: ' + toolUseBlocks.map(function(b) { return b.name; }).join(', '));

        const toolResults = toolUseBlocks.map(function(block) {
          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: block.content || ''
          };
        });

        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      console.log('Unexpected stop_reason:', stopReason);
      break;
    }

    return res.status(500).json({ error: 'Max iterations reached without final response' });

  } catch (err) {
    const errMsg = (err.response && err.response.data && err.response.data.error && err.response.data.error.message) || err.message;
    console.error('Error:', errMsg);
    return res.status(500).json({ error: errMsg });
  }
});

app.get('/health', function(req, res) { res.json({ status: 'ok' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Server running on port ' + PORT); });
