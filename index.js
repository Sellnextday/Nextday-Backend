const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 8000;

app.post('/analyze', async (req, res) => {
  const { prompt, system } = req.body;

  try {
    let messages = [{ role: 'user', content: prompt }];

    // Agentic loop — keeps running until Claude stops using tools
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

      // Add assistant response to message history
      messages.push({ role: 'assistant', content: content });

      // If Claude is done (no more tool calls) — return the final text
      if (stopReason === 'end_turn') {
        const textBlock = content.find(b => b.type === 'text');
        if (textBlock) {
          return res.json({ response: textBlock.text });
        } else {
          return res.status(500).json({ error: 'No text response from Claude' });
        }
      }

      // If Claude wants to use a tool — collect all tool results and continue
      if (stopReason === 'tool_use') {
        const toolUseBlocks = content.filter(b => b.type === 'tool_use');

        const toolResults = toolUseBlocks.map(block => ({
          type: 'tool_result',
          tool_use_id: block.id,
          content: block.type === 'tool_use' ? (block.content || '') : ''
        }));

        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // Safety exit for unexpected stop reasons
      break;
    }

    return res.status(500).json({ error: 'Unexpected end of agentic loop' });

  } catch (err) {
    console.error('Error:', err.response?.data || err.message);
    return res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
