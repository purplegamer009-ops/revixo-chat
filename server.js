const http = require('http');
const https = require('https');

const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const PORT = process.env.PORT || 3000;

// sessions: sessionId -> { name, replies[], ended, lastActivity, msgId }
const sessions = {};

function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({}); } });
  });
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, code, data) {
  setCORS(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendWebhook(body) {
  return new Promise((resolve) => {
    if (!WEBHOOK_URL) return resolve(null);
    const url = new URL(WEBHOOK_URL + '?wait=true');
    const data = JSON.stringify(body);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(data);
    req.end();
  });
}

function editWebhookMsg(msgId, body) {
  return new Promise((resolve) => {
    if (!WEBHOOK_URL || !msgId) return resolve(null);
    const url = new URL(WEBHOOK_URL + '/messages/' + msgId);
    const data = JSON.stringify(body);
    const opts = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.write(data);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];
  const params = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');

  if (url === '/' && req.method === 'GET') {
    return json(res, 200, { ok: true, sessions: Object.keys(sessions).length });
  }

  // Start chat
  if (url === '/chat/start' && req.method === 'POST') {
    const body = await parseBody(req);
    const { sessionId, name } = body;
    if (!sessionId) return json(res, 400, { error: 'no sessionId' });

    sessions[sessionId] = {
      name: name || 'Visitor',
      replies: [],
      ended: false,
      lastActivity: Date.now(),
      msgId: null,
      transcript: []
    };

    // Send opening card to Discord
    const shortId = sessionId.slice(0, 6).toUpperCase();
    const msg = await sendWebhook({
      embeds: [{
        title: '💬 New Chat — ' + (name || 'Visitor'),
        color: 3559039,
        description: 'To reply type in this channel:\n```!reply:' + sessionId + ' your message here```\nTo end chat:\n```!end:' + sessionId + '```',
        fields: [{ name: 'Session ID', value: '`' + shortId + '`', inline: true }],
        footer: { text: 'Revixo | revixo.ca' },
        timestamp: new Date().toISOString()
      }]
    });

    if (msg && msg.id) {
      sessions[sessionId].msgId = msg.id;
    }

    return json(res, 200, { ok: true });
  }

  // Visitor sends message
  if (url === '/chat/send' && req.method === 'POST') {
    const body = await parseBody(req);
    const { sessionId, name, message } = body;
    const session = sessions[sessionId];
    if (!session) return json(res, 404, { error: 'no session' });
    if (session.ended) return json(res, 200, { ok: true, ended: true });

    session.lastActivity = Date.now();
    session.transcript.push({ from: name || session.name, msg: message });

    // Send visitor message to Discord
    await sendWebhook({
      embeds: [{
        color: 5793266,
        description: '**' + (name || session.name) + ':** ' + message,
        footer: { text: 'Reply: !reply:' + sessionId + ' your message' }
      }]
    });

    return json(res, 200, { ok: true });
  }

  // Poll for replies (visitor polling)
  if (url === '/chat/poll' && req.method === 'GET') {
    const sessionId = params.get('sessionId');
    const session = sessions[sessionId];
    if (!session) return json(res, 200, { replies: [], ended: false });

    const pending = session.replies.splice(0);
    return json(res, 200, { replies: pending, ended: session.ended });
  }

  // Owner sends reply via webhook (called from Discord bot or from a simple form)
  // This is the KEY endpoint: Discord can POST here via a simple outgoing webhook or
  // the owner can use a bookmarklet / simple form we provide
  if (url === '/chat/reply' && req.method === 'POST') {
    const body = await parseBody(req);
    const { sessionId, message, secret } = body;
    if (secret !== (process.env.REPLY_SECRET || 'revixo2026')) {
      return json(res, 403, { error: 'forbidden' });
    }
    const session = sessions[sessionId];
    if (!session) return json(res, 404, { error: 'no session' });

    session.replies.push({ text: message, ts: Date.now() });
    session.lastActivity = Date.now();

    // Echo reply to Discord so owner can see their own message in context
    await sendWebhook({
      embeds: [{
        color: 2252244,
        description: '**You:** ' + message,
        footer: { text: 'Revixo reply sent' }
      }]
    });

    return json(res, 200, { ok: true });
  }

  // End chat
  if (url === '/chat/end' && req.method === 'POST') {
    const body = await parseBody(req);
    const { sessionId, secret } = body;
    if (secret !== (process.env.REPLY_SECRET || 'revixo2026')) {
      return json(res, 403, { error: 'forbidden' });
    }
    const session = sessions[sessionId];
    if (session) {
      session.ended = true;
      session.replies.push({ text: '---', ts: Date.now(), ended: true });
      await sendWebhook({
        embeds: [{
          color: 15158332,
          description: '❌ Chat ended for **' + session.name + '**',
          footer: { text: 'Revixo | revixo.ca' }
        }]
      });
    }
    return json(res, 200, { ok: true });
  }

  // List active sessions (for the owner dashboard)
  if (url === '/chat/sessions' && req.method === 'GET') {
    const secret = params.get('secret');
    if (secret !== (process.env.REPLY_SECRET || 'revixo2026')) {
      return json(res, 403, { error: 'forbidden' });
    }
    const active = Object.entries(sessions)
      .filter(([,s]) => !s.ended)
      .map(([id, s]) => ({ id, name: s.name, msgs: s.transcript.length, lastActivity: s.lastActivity }));
    return json(res, 200, { sessions: active });
  }

  if (url === '/quote' && req.method === 'POST') {
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'not found' });
});

// Cleanup old sessions every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of Object.entries(sessions)) {
    if (now - s.lastActivity > 1800000) delete sessions[id];
  }
}, 1800000);

server.listen(PORT, () => console.log('Revixo chat server v2 on port ' + PORT));
