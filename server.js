const http  = require('http');
const https = require('https');

const BOT_TOKEN = process.env.BOT_TOKEN;
const GUILD_ID  = process.env.GUILD_ID;
const SECRET    = process.env.REPLY_SECRET;
const PORT      = process.env.PORT || 8080;

// ── IN-MEMORY STORE ──────────────────────────────────────────────────────
const sessions  = {};
const analytics = {
  pageViews: [], quoteEvents: [], bookings: [], referrals: [], chatStarts: [],
};
const chanMap = {};

// ── HELPERS ──────────────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({}); } });
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

function send(res, code, data) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function auth(qs, res) {
  if (qs.get('secret') !== SECRET) { send(res, 403, { error: 'forbidden' }); return false; }
  return true;
}

function discord(method, path, body) {
  return new Promise(resolve => {
    const data = body ? JSON.stringify(body) : null;
    const req  = https.request({
      hostname: 'discord.com',
      path: '/api/v10' + path,
      method,
      headers: {
        'Authorization': 'Bot ' + BOT_TOKEN,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 300, status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { resolve({ ok: false, status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', () => resolve({ ok: false, body: {} }));
    if (data) req.write(data);
    req.end();
  });
}

// ── DISCORD CHANNEL MANAGEMENT ────────────────────────────────────────────
async function createChannel(sessionId, name) {
  const gRes = await discord('GET', `/guilds/${GUILD_ID}/channels`);
  const all  = Array.isArray(gRes.body) ? gRes.body : [];
  let catId  = null;
  for (const ch of all) {
    if (ch.type === 4 && ch.name === 'revixo-chats') { catId = ch.id; break; }
  }
  if (!catId) {
    const r = await discord('POST', `/guilds/${GUILD_ID}/channels`, { name: 'revixo-chats', type: 4 });
    if (r.ok) catId = r.body.id;
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20);
  const chanRes = await discord('POST', `/guilds/${GUILD_ID}/channels`, {
    name: slug + '-' + sessionId.slice(0, 5),
    type: 0,
    parent_id: catId,
    topic: 'Chat with ' + name + ' | Session: ' + sessionId
  });
  if (!chanRes.ok) return null;
  const channelId = chanRes.body.id;
  chanMap[channelId] = sessionId;
  await discord('POST', `/channels/${channelId}/messages`, {
    embeds: [{
      title: '💬 ' + name + ' opened a live chat',
      color: 0x1a56db,
      description: 'Type normally to reply.\n\nType `!end` to close the chat.',
      fields: [{ name: 'Session', value: '`' + sessionId + '`', inline: true }],
      footer: { text: 'Revixo Live Chat' },
      timestamp: new Date().toISOString()
    }]
  });
  return channelId;
}

const pollers = {};
function startChannelPoller(channelId, sessionId) {
  if (pollers[channelId]) return;
  let lastId = null;
  pollers[channelId] = setInterval(async () => {
    const sess = sessions[sessionId];
    if (!sess || sess.ended) {
      clearInterval(pollers[channelId]);
      delete pollers[channelId];
      return;
    }
    const path = '/channels/' + channelId + '/messages?limit=5' + (lastId ? '&after=' + lastId : '');
    const res  = await discord('GET', path);
    if (!res.ok || !Array.isArray(res.body)) return;
    const msgs = res.body.slice().reverse();
    for (const msg of msgs) {
      if (!lastId || BigInt(msg.id) > BigInt(lastId)) lastId = msg.id;
      if (msg.author && msg.author.bot) continue;
      const txt = (msg.content || '').trim();
      if (!txt) continue;
      if (txt.toLowerCase() === '!end') {
        sess.ended = true;
        sess.replies.push({ text: '__ended__', ts: Date.now(), ended: true });
        await discord('POST', `/channels/${channelId}/messages`, {
          embeds: [{ title: '🔴 Chat closed', color: 0xdc2626, description: 'Deleting channel in 5s.', footer: { text: 'Revixo' } }]
        });
        setTimeout(() => {
          discord('DELETE', `/channels/${channelId}`);
          clearInterval(pollers[channelId]);
          delete pollers[channelId];
          delete chanMap[channelId];
        }, 5000);
        return;
      }
      sess.replies.push({ text: txt, ts: Date.now() });
      sess.transcript.push({ from: 'owner', name: 'Revixo', text: txt, ts: Date.now() });
      sess.lastActivity = Date.now();
    }
  }, 1500);
}

// ── HTTP SERVER ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const path = req.url.split('?')[0];
  const qs   = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');

  // ── HEALTH ─────────────────────────────────────────────────────────────
  if (path === '/' && req.method === 'GET') {
    return send(res, 200, {
      status: 'ok',
      bookings: analytics.bookings.length,
      referrals: analytics.referrals.length,
      sessions: Object.keys(sessions).filter(k => !sessions[k].ended).length
    });
  }

  // ── CHAT ───────────────────────────────────────────────────────────────
  if (path === '/chat/start' && req.method === 'POST') {
    const body = await parseBody(req);
    const id = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
    sessions[id] = {
      id, name: body.name || 'Visitor', device: body.device || '',
      transcript: [], replies: [], started: Date.now(),
      lastActivity: Date.now(), ended: false, channelId: null
    };
    analytics.chatStarts.push({ ts: Date.now(), name: body.name });
    const channelId = await createChannel(id, body.name || 'visitor');
    if (channelId) { sessions[id].channelId = channelId; startChannelPoller(channelId, id); }
    return send(res, 200, { sessionId: id });
  }

  if (path === '/chat/send' && req.method === 'POST') {
    const body = await parseBody(req);
    const sess = sessions[body.sessionId];
    if (!sess || sess.ended) return send(res, 404, { error: 'session not found' });
    sess.transcript.push({ from: 'visitor', text: body.message, ts: Date.now() });
    sess.lastActivity = Date.now();
    if (sess.channelId) {
      await discord('POST', `/channels/${sess.channelId}/messages`, {
        content: '**' + (sess.name || 'Visitor') + ':** ' + body.message
      });
    }
    return send(res, 200, { ok: true });
  }

  if (path === '/chat/poll' && req.method === 'GET') {
    const sess = sessions[qs.get('sessionId')];
    if (!sess) return send(res, 404, { error: 'not found' });
    const replies = sess.replies.splice(0);
    return send(res, 200, { replies, ended: sess.ended });
  }

  if (path === '/chat/reply' && req.method === 'POST') {
    const body = await parseBody(req);
    if (body.secret !== SECRET) return send(res, 403, { error: 'forbidden' });
    const sess = sessions[body.sessionId];
    if (!sess || sess.ended) return send(res, 404, { error: 'not found' });
    sess.replies.push({ text: body.message, ts: Date.now() });
    sess.transcript.push({ from: 'staff', name: 'Revixo', text: body.message, ts: Date.now() });
    sess.lastActivity = Date.now();
    if (sess.channelId) {
      await discord('POST', `/channels/${sess.channelId}/messages`, {
        embeds: [{ description: '📤 **Staff:** ' + body.message, color: 0x1a56db }]
      });
    }
    return send(res, 200, { ok: true });
  }

  if (path === '/chat/end' && req.method === 'POST') {
    const body = await parseBody(req);
    if (body.secret !== SECRET) return send(res, 403, { error: 'forbidden' });
    const sess = sessions[body.sessionId];
    if (sess) {
      sess.ended = true;
      if (sess.channelId) {
        await discord('POST', `/channels/${sess.channelId}/messages`, {
          embeds: [{ title: '🔴 Chat ended by staff', color: 0xdc2626, footer: { text: 'Revixo' } }]
        });
        setTimeout(() => discord('DELETE', `/channels/${sess.channelId}`), 3000);
      }
    }
    return send(res, 200, { ok: true });
  }

  if (path === '/chat/sessions' && req.method === 'GET') {
    if (!auth(qs, res)) return;
    const active = Object.values(sessions)
      .filter(s => !s.ended && Date.now() - s.lastActivity < 30 * 60 * 1000)
      .map(s => ({ id: s.id, name: s.name, device: s.device, transcript: s.transcript, started: s.started, lastActivity: s.lastActivity }));
    return send(res, 200, { sessions: active });
  }

  // ── TRACKING ───────────────────────────────────────────────────────────
  if (path === '/track/pageview' && req.method === 'POST') {
    analytics.pageViews.push({ ts: Date.now() });
    return send(res, 200, { ok: true });
  }

  if (path === '/track/quote' && req.method === 'POST') {
    const body = await parseBody(req);
    analytics.quoteEvents.push({ ts: Date.now(), device: body.device, condition: body.condition, price: body.price });
    return send(res, 200, { ok: true });
  }

  if (path === '/track/booking' && req.method === 'POST') {
    const body = await parseBody(req);
    const booking = {
      ts: Date.now(),
      name: body.name || 'Unknown',
      phone: body.phone || '',
      devices: body.devices || body.device || '',
      total: body.total || body.price || 0,
      type: body.type || 'callback',
      notes: body.notes || '',
      photos: body.photos || [],
      ref: body.ref || null,
      refName: body.refName || null,
      refPhone: body.refPhone || null,
      refPay: body.refPay || null,
    };
    analytics.bookings.push(booking);
    // If referral, also record in referrals with "pending" state
    if (booking.ref) {
      const existing = analytics.referrals.find(r => r.code === booking.ref);
      if (existing) {
        existing.pendingPayout = true;
        existing.bookedBy = booking.name;
        existing.bookedAt = Date.now();
      }
    }
    return send(res, 200, { ok: true });
  }

  if (path === '/track/referral' && req.method === 'POST') {
    const body = await parseBody(req);
    // Prevent duplicate referral codes
    const exists = analytics.referrals.find(r => r.code === body.code);
    if (!exists) {
      analytics.referrals.push({
        ts: Date.now(),
        name: body.name || '',
        phone: body.phone || '',
        pay: body.pay || '',
        code: body.code || '',
        pendingPayout: false,
        bookedBy: null,
        bookedAt: null,
      });
    }
    return send(res, 200, { ok: true });
  }

  // ── DATA ENDPOINTS ─────────────────────────────────────────────────────
  if (path === '/bookings' && req.method === 'GET') {
    if (!auth(qs, res)) return;
    return send(res, 200, { bookings: analytics.bookings.slice().reverse() });
  }

  if (path === '/referrals' && req.method === 'GET') {
    if (!auth(qs, res)) return;
    return send(res, 200, { referrals: analytics.referrals.slice().reverse() });
  }

  if (path === '/analytics' && req.method === 'GET') {
    if (!auth(qs, res)) return;
    return send(res, 200, {
      pageViews: analytics.pageViews.length,
      quotes: analytics.quoteEvents.length,
      bookings: analytics.bookings.length,
      referrals: analytics.referrals.length,
      chats: analytics.chatStarts.length,
      activeSessions: Object.values(sessions).filter(s => !s.ended).length,
    });
  }

  if (path === '/quote' && req.method === 'POST') return send(res, 200, { ok: true });

  // ── ADMIN — CLEAR ENDPOINTS ────────────────────────────────────────────
  if (path === '/admin/clear-bookings' && req.method === 'POST') {
    const body = await parseBody(req);
    if (body.secret !== SECRET) return send(res, 403, { error: 'forbidden' });
    const count = analytics.bookings.length;
    analytics.bookings.length = 0;
    return send(res, 200, { ok: true, cleared: count });
  }

  if (path === '/admin/clear-referrals' && req.method === 'POST') {
    const body = await parseBody(req);
    if (body.secret !== SECRET) return send(res, 403, { error: 'forbidden' });
    const count = analytics.referrals.length;
    analytics.referrals.length = 0;
    return send(res, 200, { ok: true, cleared: count });
  }

  if (path === '/admin/nuke' && req.method === 'POST') {
    const body = await parseBody(req);
    if (body.secret !== SECRET) return send(res, 403, { error: 'forbidden' });
    // Clear all analytics
    analytics.bookings.length = 0;
    analytics.referrals.length = 0;
    analytics.quoteEvents.length = 0;
    analytics.pageViews.length = 0;
    analytics.chatStarts.length = 0;
    // End all active sessions
    const sessionIds = Object.keys(sessions);
    for (const id of sessionIds) {
      sessions[id].ended = true;
      const channelId = sessions[id].channelId;
      if (channelId) discord('DELETE', `/channels/${channelId}`).catch(() => {});
    }
    return send(res, 200, { ok: true, nuked: { bookings: true, referrals: true, sessions: sessionIds.length } });
  }

  // 404
  send(res, 404, { error: 'not found' });
});

// Clean up stale sessions every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2 hours
  for (const id of Object.keys(sessions)) {
    if (sessions[id].ended || sessions[id].lastActivity < cutoff) {
      delete sessions[id];
    }
  }
}, 30 * 60 * 1000);

server.listen(PORT, () => console.log('Revixo backend running on port ' + PORT));
