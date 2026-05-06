const http = require('http');
const https = require('https');

const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const REPLY_SECRET = process.env.REPLY_SECRET || 'revixoj6769';
const PORT = process.env.PORT || 3000;

// sessions: id -> { name, replies[], ended, lastActivity, transcript[], discordMsgId }
const sessions = {};

function parseBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({}); } });
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function send(res, code, data) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function webhook(body) {
  return new Promise(resolve => {
    if (!WEBHOOK_URL) return resolve(null);
    const url = new URL(WEBHOOK_URL + '?wait=true');
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(data);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const path = req.url.split('?')[0];
  const qs = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');

  // Health check
  if (path === '/' && req.method === 'GET') {
    const active = Object.values(sessions).filter(s => !s.ended).length;
    return send(res, 200, { ok: true, active, total: Object.keys(sessions).length });
  }

  // -- VISITOR: start chat ----------------------------------------------
  if (path === '/chat/start' && req.method === 'POST') {
    const body = await parseBody(req);
    const { sessionId, name } = body;
    if (!sessionId) return send(res, 400, { error: 'missing sessionId' });

    const sid6 = sessionId.slice(0, 6).toUpperCase();
    sessions[sessionId] = { name: name || 'Visitor', replies: [], ended: false, lastActivity: Date.now(), transcript: [], discordMsgId: null };

    const msg = await webhook({
      embeds: [{
        title: '- New Chat - ' + (name || 'Visitor'),
        color: 3447003,
        description: [
          '**To reply via Discord:**',
          '```',
          '!reply:' + sessionId + ' your message here',
          '```',
          '**To end chat:**',
          '```',
          '!end:' + sessionId,
          '```',
          '',
          'Or use the **Staff Dashboard** on the site to reply.'
        ].join('\n'),
        fields: [{ name: 'Session', value: '`' + sid6 + '`', inline: true }],
        footer: { text: 'Revixo - revixo.ca' },
        timestamp: new Date().toISOString()
      }]
    });

    if (msg && msg.id) sessions[sessionId].discordMsgId = msg.id;
    return send(res, 200, { ok: true });
  }

  // -- VISITOR: send message --------------------------------------------
  if (path === '/chat/send' && req.method === 'POST') {
    const body = await parseBody(req);
    const { sessionId, name, message } = body;
    const sess = sessions[sessionId];
    if (!sess) return send(res, 404, { error: 'session not found' });
    if (sess.ended) return send(res, 200, { ok: true, ended: true });

    sess.lastActivity = Date.now();
    sess.transcript.push({ from: 'visitor', name: name || sess.name, text: message, ts: Date.now() });

    await webhook({
      embeds: [{
        color: 5793266,
        author: { name: (name || sess.name) + ' says:' },
        description: message,
        footer: { text: '!reply:' + sessionId + ' <your reply>  -  !end:' + sessionId }
      }]
    });

    return send(res, 200, { ok: true });
  }

  // -- VISITOR: poll for owner replies ---------------------------------
  if (path === '/chat/poll' && req.method === 'GET') {
    const sessionId = qs.get('sessionId');
    const sess = sessions[sessionId];
    if (!sess) return send(res, 200, { replies: [], ended: false });
    const pending = sess.replies.splice(0);
    return send(res, 200, { replies: pending, ended: sess.ended });
  }

  // -- OWNER: reply to visitor (from dashboard OR Discord webhook) ------
  if (path === '/chat/reply' && req.method === 'POST') {
    const body = await parseBody(req);
    const { sessionId, message, secret } = body;
    if (secret !== REPLY_SECRET) return send(res, 403, { error: 'forbidden' });
    const sess = sessions[sessionId];
    if (!sess) return send(res, 404, { error: 'session not found' });
    if (sess.ended) return send(res, 200, { ok: true, ended: true });

    sess.replies.push({ text: message, ts: Date.now() });
    sess.transcript.push({ from: 'owner', name: 'Revixo', text: message, ts: Date.now() });
    sess.lastActivity = Date.now();

    // Echo to Discord so owner sees the reply in context
    await webhook({
      embeds: [{
        color: 2664261,
        author: { name: 'You replied to ' + sess.name + ':' },
        description: message,
        footer: { text: 'Revixo Staff - revixo.ca' }
      }]
    });

    return send(res, 200, { ok: true });
  }

  // -- OWNER: end chat --------------------------------------------------
  if (path === '/chat/end' && req.method === 'POST') {
    const body = await parseBody(req);
    const { sessionId, secret } = body;
    if (secret !== REPLY_SECRET) return send(res, 403, { error: 'forbidden' });
    const sess = sessions[sessionId];
    if (sess) {
      sess.ended = true;
      sess.replies.push({ text: '__ended__', ts: Date.now(), ended: true });
      await webhook({
        embeds: [{
          color: 15158332,
          description: '- Chat ended - **' + sess.name + '**',
          footer: { text: 'Revixo - revixo.ca' }
        }]
      });
    }
    return send(res, 200, { ok: true });
  }

  // -- OWNER: list active sessions --------------------------------------
  if (path === '/chat/sessions' && req.method === 'GET') {
    if (qs.get('secret') !== REPLY_SECRET) return send(res, 403, { error: 'forbidden' });
    const active = Object.entries(sessions)
      .filter(([, s]) => !s.ended)
      .map(([id, s]) => ({
        id,
        name: s.name,
        msgs: s.transcript.length,
        lastActivity: s.lastActivity,
        transcript: s.transcript
      }));
    return send(res, 200, { sessions: active });
  }

  // -- DISCORD: incoming webhook message (owner types !reply or !end) ---
  if (path === '/discord/message' && req.method === 'POST') {
    const body = await parseBody(req);
    const content = (body.content || '').trim();

    const replyMatch = content.match(/^!reply:([a-z0-9]+)\s+(.+)$/is);
    if (replyMatch) {
      const [, sessionId, message] = replyMatch;
      const sess = sessions[sessionId];
      if (sess && !sess.ended) {
        sess.replies.push({ text: message, ts: Date.now() });
        sess.transcript.push({ from: 'owner', name: 'Revixo', text: message, ts: Date.now() });
        sess.lastActivity = Date.now();
        return send(res, 200, { ok: true, action: 'replied', to: sess.name });
      }
      return send(res, 404, { error: 'session not found' });
    }

    const endMatch = content.match(/^!end:([a-z0-9]+)$/i);
    if (endMatch) {
      const [, sessionId] = endMatch;
      const sess = sessions[sessionId];
      if (sess) {
        sess.ended = true;
        sess.replies.push({ text: '__ended__', ts: Date.now(), ended: true });
        return send(res, 200, { ok: true, action: 'ended', name: sess.name });
      }
      return send(res, 404, { error: 'session not found' });
    }

    return send(res, 200, { ok: true, action: 'ignored' });
  }

  if (path === '/quote' && req.method === 'POST') return send(res, 200, { ok: true });

  send(res, 404, { error: 'not found' });
});

// Cleanup stale sessions every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of Object.entries(sessions)) {
    if (now - s.lastActivity > 1800000) delete sessions[id];
  }
}, 1800000);

server.listen(PORT, () => console.log('Revixo chat v3 running on port ' + PORT));
