import mongoose from 'mongoose';
import { TikTokLiveConnection, WebcastEvent } from 'tiktok-live-connector';
import crypto from 'node:crypto';

const eventSchema = new mongoose.Schema({
  eventId: { type: String, unique: true, index: true },
  type: { type: String, index: true },
  username: String,
  userId: String,
  text: String,
  giftName: String,
  replyText: String,
  status: { type: String, default: 'new', index: true },
  createdAt: { type: Date, default: Date.now, index: true },
}, { versionKey: false });
const knowledgeSchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: { type: String, required: true },
  updatedAt: { type: Date, default: Date.now },
}, { versionKey: false });
const LiveEvent = mongoose.models.LiveEvent || mongoose.model('LiveEvent', eventSchema);
const Knowledge = mongoose.models.LiveKnowledge || mongoose.model('LiveKnowledge', knowledgeSchema);

export function installLiveHost(app) {
  const allowedOrigins = (process.env.FRONTEND_ORIGINS || '*').split(',').map(x => x.trim()).filter(Boolean);
  app.use('/api/live', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.includes('*') || allowedOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigins.includes('*') ? '*' : origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const adminToken = process.env.LIVE_ADMIN_TOKEN || '';
  const requireAdmin = (req, res, next) => {
    if (!adminToken) return res.status(503).json({ error: 'Set LIVE_ADMIN_TOKEN in the backend environment before using live controls.' });
    const token = req.get('X-Admin-Token') || req.get('Authorization')?.replace(/^Bearer\s+/i, '');
    if (token !== adminToken) return res.status(401).json({ error: 'Invalid admin token.' });
    next();
  };

  let connection = null;
  let liveUsername = null;
  let connected = false;
  let lastError = null;
  const seen = new Set();
  const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
  const textOf = (v) => String(v ?? '').trim();
  const userOf = (d) => textOf(d?.nickname || d?.user?.nickname || d?.uniqueId || d?.user?.uniqueId || d?.username || 'Viewer');
  const idOf = (d) => textOf(d?.userId || d?.user?.userId || d?.uniqueId || d?.user?.uniqueId);

  async function aiReply(prompt, kind, extra = {}) {
    const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
    if (!apiKey) return kind === 'chat' ? `Thanks for your question! The host is still setting up its AI connection.` : extra.fallback;
    const knowledge = await Knowledge.find().sort({ updatedAt: -1 }).limit(30).lean().catch(() => []);
    const knowledgeText = knowledge.map(k => `${k.title}: ${k.content}`).join('\n').slice(0, 14000);
    const system = `You are a warm, concise, natural TikTok LIVE host. Reply in 1-2 short spoken sentences, suitable for live speech. Do not claim to be a human. Be friendly and safe. If the viewer asks a question, answer helpfully; if the knowledge notes don't cover it, say so rather than inventing business facts.\nKnowledge notes:\n${knowledgeText || '(No custom knowledge yet)'}`;
    const r = await fetch(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || process.env.LLM_MODEL || 'gpt-4o-mini', temperature: 0.7, max_tokens: 120, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(25000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error?.message || `OpenAI request failed (${r.status})`);
    return textOf(data.choices?.[0]?.message?.content) || extra.fallback || 'Thanks for joining the live!';
  }

  async function saveEvent({ type, username, userId, text, giftName, fallback, eventId }) {
    const signature = eventId || hash(`${type}|${userId}|${text}|${giftName}|${Date.now()}`);
    if (seen.has(signature)) return;
    seen.add(signature); if (seen.size > 2000) seen.clear();
    let replyText = '';
    try {
      if (type === 'chat' && text) replyText = await aiReply(`${username} commented: ${text}`, 'chat', { fallback: `Great question, ${username}! Thanks for asking.` });
      else if (type === 'join') replyText = await aiReply(`A viewer named ${username} just joined the LIVE. Welcome them warmly.`, type, { fallback: `Welcome to the live, ${username}! Great to have you here.` });
      else if (type === 'gift') replyText = await aiReply(`${username} sent a TikTok gift${giftName ? ` called ${giftName}` : ''}. Thank them warmly.`, type, { fallback: `Thank you so much for the gift, ${username}! I really appreciate you.` });
      else if (type === 'screen_comment' && text) replyText = await aiReply(`${username} commented on screen: ${text}`, 'chat', { fallback: `Thanks for your comment!` });
    } catch (e) { lastError = e.message; replyText = fallback || `Thanks, ${username}!`; }
    await LiveEvent.create({ eventId: signature, type, username, userId, text, giftName, replyText, status: 'new' }).catch(e => { if (e.code !== 11000) console.error('Could not save live event:', e.message); });
  }

  app.get('/api/live/status', requireAdmin, async (_req, res) => res.json({ connected, username: liveUsername, error: lastError, mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', openaiConfigured: Boolean(process.env.OPENAI_API_KEY || process.env.LLM_API_KEY) }));
  app.post('/api/live/connect', requireAdmin, async (req, res) => {
    const username = textOf(req.body?.username).replace(/^@/, '');
    if (!username) return res.status(400).json({ error: 'Enter the TikTok LIVE username without @.' });
    try {
      if (connection) { try { await connection.disconnect(); } catch {} connection = null; }
      liveUsername = username; lastError = null;
      connection = new TikTokLiveConnection(username, { processInitialData: false, enableExtendedGiftInfo: true });
      connection.on(WebcastEvent.CHAT, d => saveEvent({ type: 'chat', username: userOf(d), userId: idOf(d), text: textOf(d.comment), eventId: d.msgId || d.common?.msgId }));
      connection.on(WebcastEvent.MEMBER, d => saveEvent({ type: 'join', username: userOf(d), userId: idOf(d), eventId: d.common?.msgId || `${idOf(d)}-${d.memberCount || ''}-${Date.now()}` }));
      connection.on(WebcastEvent.GIFT, d => { const giftName = textOf(d.giftName || d.gift?.name || d.giftDetails?.giftName); saveEvent({ type: 'gift', username: userOf(d), userId: idOf(d), giftName, eventId: d.common?.msgId || `${idOf(d)}-${giftName}-${d.repeatCount || 1}-${Date.now()}` }); });
      connection.on('error', e => { lastError = e?.message || String(e); console.error('TikTok LIVE connector:', lastError); });
      const result = await connection.connect(); connected = true;
      res.json({ ok: true, username, roomId: result?.roomId || null, message: `Connected to @${username}'s LIVE event stream.` });
    } catch (e) { connected = false; lastError = e.message; res.status(502).json({ error: `Could not connect to @${username}. Confirm the account is LIVE and try again. ${e.message}` }); }
  });
  app.post('/api/live/disconnect', requireAdmin, async (_req, res) => { if (connection) { try { await connection.disconnect(); } catch {} } connection = null; connected = false; res.json({ ok: true }); });
  app.get('/api/live/events', requireAdmin, async (req, res) => {
    const after = req.query.after ? new Date(req.query.after) : new Date(Date.now() - 10 * 60 * 1000);
    const events = await LiveEvent.find({ createdAt: { $gt: after } }).sort({ createdAt: 1 }).limit(100).lean();
    res.json({ events, latest: events.at(-1)?.createdAt || after });
  });
  app.get('/api/live/knowledge', requireAdmin, async (_req, res) => res.json({ items: await Knowledge.find().sort({ updatedAt: -1 }).lean() }));
  app.post('/api/live/knowledge', requireAdmin, async (req, res) => {
    const title = textOf(req.body?.title), content = textOf(req.body?.content);
    if (!title || !content) return res.status(400).json({ error: 'Both title and content are required.' });
    if (content.length > 20000) return res.status(413).json({ error: 'Knowledge content must be 20,000 characters or less.' });
    res.status(201).json(await Knowledge.create({ title, content, updatedAt: new Date() }));
  });
  app.delete('/api/live/knowledge/:id', requireAdmin, async (req, res) => { await Knowledge.findByIdAndDelete(req.params.id); res.sendStatus(204); });
  app.post('/api/live/screen-observation', requireAdmin, async (req, res) => {
    const image = textOf(req.body?.image);
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(image)) return res.status(400).json({ error: 'Send a PNG, JPEG or WebP screenshot as a data URL.' });
    if (image.length > 4_500_000) return res.status(413).json({ error: 'Screenshot too large. Reduce capture resolution.' });
    const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'Configure OPENAI_API_KEY for screen-reading fallback.' });
    try {
      const model = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';
      const r = await fetch(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 350, temperature: 0, messages: [{ role: 'system', content: 'Read the screenshot of TikTok LIVE Studio. Extract only clearly visible new viewer chat comments, gift notifications, or join notifications. Ignore creator UI text, buttons, and old messages where possible. Return valid JSON only: {"items":[{"type":"chat"|"gift"|"join","username":"...","text":"...","giftName":"..."}]}. If nothing is clear, return {"items":[]}.' }, { role: 'user', content: [{ type: 'text', text: 'Extract visible LIVE events.' }, { type: 'image_url', image_url: { url: image, detail: 'low' } }] }] }), signal: AbortSignal.timeout(30000) });
      const payload = await r.json(); if (!r.ok) throw new Error(payload.error?.message || 'Vision request failed');
      const raw = payload.choices?.[0]?.message?.content || '{"items":[]}';
      const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
      const items = Array.isArray(parsed.items) ? parsed.items.slice(0, 10) : [];
      for (const item of items) {
        const username = textOf(item.username) || 'Viewer'; const type = ['chat','gift','join'].includes(item.type) ? item.type : 'chat'; const text = textOf(item.text); const giftName = textOf(item.giftName);
        if (type === 'chat' && !text) continue;
        await saveEvent({ type: type === 'chat' ? 'screen_comment' : type, username, text, giftName, eventId: hash(`screen|${username}|${text}|${giftName}`), fallback: type === 'gift' ? `Thanks for the gift, ${username}!` : `Welcome, ${username}!` });
      }
      res.json({ ok: true, extracted: items.length });
    } catch (e) { lastError = e.message; res.status(502).json({ error: `Screen analysis failed: ${e.message}` }); }
  });
}

export async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.warn('MONGODB_URI is not set; live knowledge and event persistence will not work.'); return; }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  console.log('MongoDB connected for TikTok LIVE host.');
}
