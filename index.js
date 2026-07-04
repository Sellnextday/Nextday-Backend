/**
 * JARVIS — Slack body (Cloudflare Worker)
 *
 * A thin forwarder: DM or @mention JARVIS → forwards to the shared brain
 * (via the BRAIN service binding) and posts his reply. The BRAIN itself now
 * has a post_to_slack tool, so JARVIS decides — conversationally — when to post
 * to a channel. We just tell the brain whether the asker is Chris (canAct), so
 * only Chris can make him take actions; everyone else gets answers only.
 *
 * Secrets:  SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN
 * Binding:  BRAIN -> service "jarvis"   (Worker→Worker by URL is blocked, error 1042)
 */

const CHRIS = 'U0A75DYD4D6';
const JARVIS_ASK_URL = 'https://jarvis.twilight-tree-d5c3.workers.dev/ask';

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('JARVIS Slack body online. POST only.', { status: 200 });

    const body = await request.text();
    let data = null;
    try { data = JSON.parse(body); } catch (e) {}

    if (data && data.type === 'url_verification') {
      return new Response(data.challenge || '', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    if (request.headers.get('x-slack-retry-num')) return new Response('', { status: 200 });
    if (!(await verifySlackSignature(request, body, env.SLACK_SIGNING_SECRET))) return new Response('bad signature', { status: 401 });

    if (data && data.type === 'event_callback' && data.event) {
      const ev = data.event;
      if (ev.bot_id || ev.subtype) return new Response('', { status: 200 });
      const isMention = ev.type === 'app_mention';
      const isDM = ev.type === 'message' && ev.channel_type === 'im';
      if (isMention || isDM) {
        const text = (ev.text || '').replace(/<@[^>]+>/g, '').trim();
        const channel = ev.channel;
        const thread = isMention ? (ev.thread_ts || ev.ts) : (ev.thread_ts || undefined);
        const canAct = ev.user === CHRIS;
        ctx.waitUntil(answerInSlack(text, channel, thread, canAct, env));
      }
      return new Response('', { status: 200 });
    }
    return new Response('ok', { status: 200 });
  }
};

async function answerInSlack(text, channel, thread, canAct, env) {
  let reply = "I didn't catch that, Boss.";
  try {
    if (text) {

      // ── JARVIS DEAL ANALYSIS ─────────────────────────────────────
      // Detects a property address in the message and runs the
      // 4-agent ATTOM pipeline on Render before hitting JARVIS brain.
      const _isAddr = /^\s*\d{1,6}\s+[A-Za-z]/.test(text)
        || /\b(run|analyze|comp|deal)\s+\d+\s+[A-Za-z]/i.test(text);
      let _dealDone = false;

      if (_isAddr) {
        const _addrRx = /\d{1,6}\s+[\w\s#-]{0,50}?(?:st(?:reet)?|ave(?:nue)?|blvd|boulevard|dr(?:ive)?|rd|road|ln|lane|ct|court|way|pl(?:ace)?|cir(?:cle)?|ter(?:race)?|hwy|highway|pkwy|parkway)\b[^.!?\n]*/i;
        const _addrHit = text.match(_addrRx);
        const _addrStr = _addrHit ? _addrHit[0].trim() : text;

        // Immediate ack — so Boss knows it's running even during Render cold start
        await postToSlack(channel, thread, '🔍 On it — pulling comps for ' + _addrStr + '...', env);

        try {
          const _r = await fetch('https://nextday-backend.onrender.com/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: _addrStr, callNotes: text })
          });

          if (_r.ok) {
            const _j = await _r.json();
            // Index v2.0 returns pre-formatted Slack text, or a needs_* prompt
            if (_j.needs_sqft) {
              reply = '📐 ' + _j.message;
            } else if (_j.needs_info) {
              reply = 'ℹ️ ' + _j.message;
            } else if (typeof _j.response === 'string') {
              reply = _j.response;
            } else {
              reply = '⚠️ Unexpected response from analyzer — check Render logs';
            }
          } else {
            let _errDetail = '';
            try { const _eb = await _r.json(); _errDetail = _eb.error || JSON.stringify(_eb); } catch(e) {}
            reply = '⚠️ Analyzer error (' + _r.status + '): ' + (_errDetail || 'check Render logs');
          }
        } catch (_e) {
          console.error('[DEAL]', _e && _e.message);
          reply = '⚠️ Analyzer timed out — Render may be waking up. Send the address again in ~30 sec.';
        }
        _dealDone = true; // address was detected — don't fall through to JARVIS brain either way
      }
      // ── END DEAL ANALYSIS ────────────────────────────────────────

      if (!_dealDone) {
        const history = await fetchHistory(channel, thread, env);
        const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: text, canAct, history, channel: channel, threadTs: thread }) };
        const r = (env.BRAIN && typeof env.BRAIN.fetch === 'function')
          ? await env.BRAIN.fetch('https://brain/ask', init)
          : await fetch(env.JARVIS_ASK_URL || JARVIS_ASK_URL, init);
        const j = await r.json().catch(() => ({}));
        reply = (j && j.text) ? String(j.text) : "My brain link dropped for a second, Boss — try me again.";
      }
    }
  } catch (e) {
    reply = "My reasoning core hiccuped, Boss — give me another go.";
  }
  try {
    const msg = { channel, text: reply };
    if (thread) msg.thread_ts = thread;
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.SLACK_BOT_TOKEN, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(msg)
    });
  } catch (e) {}
}

// Post a single message to Slack (used for acks before long-running ops)
async function postToSlack(channel, thread, text, env) {
  try {
    const msg = { channel, text };
    if (thread) msg.thread_ts = thread;
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.SLACK_BOT_TOKEN, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(msg)
    });
  } catch (e) {}
}

// Pull recent thread/DM messages so JARVIS stays in-context (memory) in Slack too.
async function fetchHistory(channel, thread, env) {
  try {
    const url = thread
      ? 'https://slack.com/api/conversations.replies?channel=' + channel + '&ts=' + thread + '&limit=12'
      : 'https://slack.com/api/conversations.history?channel=' + channel + '&limit=12';
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + env.SLACK_BOT_TOKEN } });
    const j = await r.json();
    if (!j || !j.ok || !Array.isArray(j.messages)) return [];
    let msgs = j.messages.slice();
    if (!thread) msgs.reverse();
    const out = [];
    for (const m of msgs) {
      const t = (m.text || '').replace(/<@[^>]+>/g, '').trim();
      if (!t) continue;
      if (m.bot_id) out.push({ role: 'assistant', content: t });
      else if (m.user === CHRIS) out.push({ role: 'user', content: t });
    }
    while (out.length && out[out.length - 1].role === 'user') out.pop();
    return out.slice(-8);
  } catch (e) { return []; }
}

async function verifySlackSignature(request, body, signingSecret) {
  const ts = request.headers.get('x-slack-request-timestamp');
  const sig = request.headers.get('x-slack-signature');
  if (!ts || !sig || !signingSecret) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Date.now() / 1000 - tsNum) > 300) return false;
  const baseString = `v0:${ts}:${body}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(signingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(baseString));
  const expected = 'v0=' + Array.from(new Uint8Array(sigBytes)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
