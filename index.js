const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 8192;
const MAX_ITERATIONS = 15;

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
  if (!prompt || !system) return res.status(400).json({ error: 'Missing prompt or system' });

  try {
    let messages = [{ role: 'user', content: prompt }];
    let iterations = 0;
    let searchCount = 0;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const apiResponse = await axios({
        method: 'post',
        url: 'https://api.anthropic.com/v1/messages',
        timeout: 180000,
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

      const stopReason = apiResponse.data.stop_reason;
      const content = apiResponse.data.content;
      console.log('Iteration ' + iterations + ' | stop_reason: ' + stopReason + ' | searches: ' + searchCount);

      messages.push({ role: 'assistant', content: content });

      if (stopReason === 'end_turn') {
        const textBlock = content.find(function(b) { return b.type === 'text'; });
        if (!textBlock || !textBlock.text) return res.status(500).json({ error: 'No text response. Try again.' });

        const jsonStr = extractJSON(textBlock.text);
        try {
          JSON.parse(jsonStr);
          console.log('Success — returning valid JSON');
          return res.json({ response: jsonStr });
        } catch (parseErr) {
          console.log('Invalid JSON — asking Claude to fix...');
          messages.push({ role: 'user', content: 'Return ONLY the raw JSON object. Start with { and end with }. No text before or after.' });
          continue;
        }
      }

      if (stopReason === 'tool_use') {
        const toolUseBlocks = content.filter(function(b) { return b.type === 'tool_use'; });
        searchCount += toolUseBlocks.length;
        console.log('Searches: ' + toolUseBlocks.map(function(b) { return b.input && b.input.query ? b.input.query : 'unknown'; }).join(' | '));

        var toolResults = toolUseBlocks.map(function(block) {
          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: searchCount >= 6
              ? 'Search limit reached. Output the final JSON now using data gathered so far.'
              : (block.content || '')
          };
        });

        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      console.log('Unexpected stop_reason: ' + stopReason);
      break;
    }

    return res.status(500).json({ error: 'Analysis did not complete. Please try again.' });

  } catch (err) {
    var errMsg = err.message;
    if (err.response && err.response.data && err.response.data.error) errMsg = err.response.data.error.message || errMsg;
    console.error('API Error:', errMsg);
    return res.status(500).json({ error: errMsg });
  }
});

app.get('/health', function(req, res) { res.json({ status: 'ok' }); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Server running on port ' + PORT); });
