import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import fetch from 'node-fetch';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import 'dotenv/config';
const express = require('express');
const app = express();
app.set('trust proxy', 1);
app.listen(process.env.PORT || 3000);

// ── SECURITY: HTTP headers ──
app.use(helmet({ crossOriginResourcePolicy: false }));

// ── SECURITY: CORS ──
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'DELETE'],
}));

// ── SECURITY: Rate limiting ──
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_PER_MIN || '30'),
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});
app.use('/api/', limiter);

app.use(express.json({ limit: '4mb' }));

// ── FILE UPLOAD: multer (memory storage, 20MB limit) ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = [
      'image/jpeg','image/png','image/gif','image/webp',
      'application/pdf',
      'text/plain','text/csv','text/markdown',
    ];
    cb(null, allowed.includes(file.mimetype));
  },
});

// ── SESSION MEMORY: simple in-process store (swap for Redis in production) ──
const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24h

function getSession(id) {
  const s = sessions.get(id);
  if (!s) return { id, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
  return s;
}

function saveSession(s) {
  s.updatedAt = Date.now();
  sessions.set(s.id, s);
}

// Prune old sessions every 30 min
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL;
  for (const [id, s] of sessions) {
    if (s.updatedAt < cutoff) sessions.delete(id);
  }
}, 30 * 60 * 1000);

// ── ALLOWED MODELS ──
const ALLOWED_MODELS = new Set([
  'claude-sonnet-4-20250514',
  'claude-opus-4-20250514',
  'claude-haiku-4-5-20251001',
]);

// ── HELPERS ──
function sanitiseMessages(messages) {
  return messages.slice(-60).map(m => {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (typeof m.content === 'string') {
      return { role, content: m.content.slice(0, 12000) };
    }
    if (Array.isArray(m.content)) {
      // allow pre-built content blocks (for file/image messages)
      return { role, content: m.content };
    }
    return { role, content: String(m.content).slice(0, 12000) };
  });
}

async function callClaude({ model, system, messages, useWebSearch = false, maxTokens = 2048 }) {
  const tools = useWebSearch ? [{ type: 'web_search_20250305', name: 'web_search' }] : undefined;

  const body = {
    model: ALLOWED_MODELS.has(model) ? model : 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    system,
    messages,
    ...(tools ? { tools } : {}),
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05',
    },
    body: JSON.stringify(body),
  });

  return res;
}

// Extract full text from a response (handles tool_use blocks)
function extractText(data) {
  if (!data.content) return '';
  return data.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}

// ── ENDPOINT: /api/chat ──
// Handles text, web search, session memory
app.post('/api/chat', async (req, res) => {
  const { message, sessionId, system, model, useWebSearch } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }
  if (message.length > 12000) {
    return res.status(400).json({ error: 'message too long (max 12000 chars)' });
  }

  const sid = (sessionId && typeof sessionId === 'string')
    ? sessionId.slice(0, 64)
    : crypto.randomUUID();

  const session = getSession(sid);
  session.messages.push({ role: 'user', content: message });

  const safeMessages = sanitiseMessages(session.messages);
  const safeSystem = typeof system === 'string'
    ? system.slice(0, 4000)
    : 'You are Aria, a friendly and highly capable AI assistant.';

  try {
    const upstream = await callClaude({
      model,
      system: safeSystem,
      messages: safeMessages,
      useWebSearch: !!useWebSearch,
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      console.error('Anthropic error:', data);
      session.messages.pop(); // rollback
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
});

// ── ENDPOINT: /api/chat-with-file ──
// Handles image vision + PDF/text file reading
app.post('/api/chat-with-file', upload.single('file'), async (req, res) => {
  const { message, sessionId, system, model } = req.body;
  const file = req.file;

  if (!file) return res.status(400).json({ error: 'No file uploaded' });
  if (!message) return res.status(400).json({ error: 'message is required' });

  const sid = (sessionId && typeof sessionId === 'string')
    ? sessionId.slice(0, 64)
    : crypto.randomUUID();

  const session = getSession(sid);

  // Build content block based on file type
  let contentBlocks = [];

  if (file.mimetype.startsWith('image/')) {
    contentBlocks = [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: file.mimetype,
          data: file.buffer.toString('base64'),
        },
      },
      { type: 'text', text: message },
    ];
  } else if (file.mimetype === 'application/pdf') {
    contentBlocks = [
      {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: file.buffer.toString('base64'),
        },
      },
      { type: 'text', text: message },
    ];
  } else {
    // text/csv/markdown — inline as text
    const fileText = file.buffer.toString('utf8').slice(0, 20000);
    contentBlocks = [
      { type: 'text', text: `File: ${file.originalname}\n\n${fileText}\n\n---\n\n${message}` },
    ];
  }

  session.messages.push({ role: 'user', content: contentBlocks });

  const safeMessages = sanitiseMessages(session.messages);
  const safeSystem = typeof system === 'string'
    ? system.slice(0, 4000)
    : 'You are Aria, a friendly and highly capable AI assistant.';

  try {
    const upstream = await callClaude({
      model,
      system: safeSystem,
      messages: safeMessages,
      useWebSearch: false,
      maxTokens: 2048,
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      session.messages.pop();
      return res.status(upstream.status).json({ error: data.error?.message || 'Upstream error' });
    }

    const reply = extractText(data);
    // Store assistant reply; replace user content with a text summary to save memory
    session.messages[session.messages.length - 1] = {
      role: 'user',
      content: `[Uploaded file: ${file.originalname}] ${message}`,
    };
    session.messages.push({ role: 'assistant', content: reply });
    saveSession(session);

    res.json({ reply, sessionId: sid, usage: data.usage });
  } catch (err) {
    console.error('File chat error:', err);
    session.messages.pop();
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── ENDPOINT: /api/session/:id ──
// Get or clear session history
app.get('/api/session/:id', (req, res) => {
  const session = getSession(req.params.id);
  res.json({ sessionId: req.params.id, messageCount: session.messages.length });
});

app.delete('/api/session/:id', (req, res) => {
  sessions.delete(req.params.id);
  res.json({ deleted: true });
});

// ── HEALTH CHECK ──
app.get('/health', (_, res) => res.json({ status: 'ok', sessions: sessions.size }));

// ── 404 ──
app.use((_, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => console.log(`Aria proxy v2 running on port ${PORT}`));
