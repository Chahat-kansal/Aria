import crypto from 'crypto';

const ALLOWED_MODELS = new Set([
  'claude-sonnet-4-20250514',
  'claude-opus-4-20250514',
  'claude-haiku-4-5-20251001',
]);

// In-memory sessions (per serverless instance — resets on cold start)
const sessions = new Map();

function getSession(id) {
  return sessions.get(id) || { id, messages: [], updatedAt: Date.now() };
}
function saveSession(s) { s.updatedAt = Date.now(); sessions.set(s.id, s); }

function sanitiseMessages(messages) {
  return messages.slice(-60).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content.slice(0, 12000) : m.content,
  }));
}

function extractText(data) {
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, sessionId, system, model, useWebSearch } = req.body;

  if (!message || typeof message !== 'string')
    return res.status(400).json({ error: 'message is required' });
  if (message.length > 12000)
    return res.status(400).json({ error: 'message too long' });

  const sid = (sessionId && typeof sessionId === 'string') ? sessionId.slice(0, 64) : crypto.randomUUID();
  const session = getSession(sid);
  session.messages.push({ role: 'user', content: message });

  const safeSystem = typeof system === 'string' ? system.slice(0, 4000) : 'You are Aria, a friendly and highly capable AI assistant.';
  const safeModel = ALLOWED_MODELS.has(model) ? model : 'claude-sonnet-4-20250514';
  const tools = useWebSearch ? [{ type: 'web_search_20250305', name: 'web_search' }] : undefined;

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify({
        model: safeModel,
        max_tokens: 2048,
        system: safeSystem,
        messages: sanitiseMessages(session.messages),
        ...(tools ? { tools } : {}),
      }),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      session.messages.pop();
      return res.status(upstream.status).json({ error: data.error?.message || 'Upstream error' });
    }

    const reply = extractText(data);
    session.messages.push({ role: 'assistant', content: reply });
    saveSession(session);

    res.json({ reply, sessionId: sid, usage: data.usage });
  } catch (err) {
    console.error('Chat error:', err);
    session.messages.pop();
    res.status(500).json({ error: 'Internal server error' });
  }
}
