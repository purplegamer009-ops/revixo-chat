const http  = require('http');
const https = require('https');

const BOT_TOKEN = process.env.BOT_TOKEN;
const GUILD_ID  = process.env.GUILD_ID;
const SECRET    = process.env.REPLY_SECRET;
const PORT      = process.env.PORT || 3000;

const sessions  = {};  // sessionId -> session object

// ── ANALYTICS STORE ────────────────────────────────────────────────────────
const analytics = {
  pageViews: [],        // [{ts, ref}]
  quoteEvents: [],      // [{ts, device, model, price, ref}]
  bookings: [],         // [{ts, name, phone, devices, total, type, ref, refName, refPhone, refPay}]
  referrals: [],        // [{ts, name, phone, pay, code}]
  chatStarts: [],       // [{ts, name, sessionId}]
};

const chanMap   = {};  // channelId -> sessionId  (reverse lookup)

// ── UTILS ─────────────────────────────────────────────────────────────────
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

// ── DISCORD REST ───────────────────────────────────────────────────────────
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

// ── CREATE DISCORD CHANNEL FOR A CHAT ─────────────────────────────────────
async function createChannel(sessionId, name) {
  // Find or create category
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

  // Create text channel named after visitor
  const slug   = name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20);
  const chanRes = await discord('POST', `/guilds/${GUILD_ID}/channels`, {
    name: slug + '-' + sessionId.slice(0, 5),
    type: 0,
    parent_id: catId,
    topic: 'Chat with ' + name + ' | Session: ' + sessionId
  });
  if (!chanRes.ok) return null;

  const channelId = chanRes.body.id;
  chanMap[channelId] = sessionId;

  // Post instructions in channel
  await discord('POST', `/channels/${channelId}/messages`, {
    embeds: [{
      title: '💬 ' + name + ' opened a live chat',
      color: 0x0a0a0a,
      description: 'Just **type normally** in this channel to reply to them.\n\nType `!end` to close and delete this chat.',
      fields: [{ name: 'Session', value: '`' + sessionId + '`', inline: true }],
      footer: { text: 'Revixo Live Chat' },
      timestamp: new Date().toISOString()
    }]
  });

  return channelId;
}

// ── POLL DISCORD CHANNEL FOR STAFF REPLIES ─────────────────────────────────
const pollers = {};  // channelId -> interval

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

    // Reverse so oldest first
    const msgs = res.body.slice().reverse();
    for (const msg of msgs) {
      if (!lastId || BigInt(msg.id) > BigInt(lastId)) lastId = msg.id;
      if (msg.author && msg.author.bot) continue;  // skip bot messages

      const txt = (msg.content || '').trim();
      if (!txt) continue;

      if (txt.toLowerCase() === '!end') {
        // Close chat
        sess.ended = true;
        sess.replies.push({ text: '__ended__', ts: Date.now(), ended: true });
        await discord('POST', `/channels/${channelId}/messages`, {
          embeds: [{ title: '🔴 Chat closed', color: 0xdc2626, description: 'This channel will be deleted in 5 seconds.', footer: { text: 'Revixo' } }]
        });
        setTimeout(() => {
          discord('DELETE', `/channels/${channelId}`);
          clearInterval(pollers[channelId]);
          delete pollers[channelId];
          delete chanMap[channelId];
        }, 5000);
        return;
      }

      // Normal reply - push to visitor
      sess.replies.push({ text: txt, ts: Date.now() });
      sess.transcript.push({ from: 'owner', name: 'Revixo', text: txt, ts: Date.now() });
      sess.lastActivity = Date.now();
    }
  }, 1500);
}

// ── HTTP SERVER ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const path = req.url.split('?')[0];
  const qs   = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');

  // Health
  if (path === '/' && req.method === 'GET') {
    const active = Object.values(sessions).filter(s => !s.ended).length;
    return send(res, 200, { ok: true, active });
  }

  // Visitor: start chat
  if (path === '/chat/start' && req.method === 'POST') {
    const body = await parseBody(req);
    const { sessionId, name } = body;
    if (!sessionId) return send(res, 400, { error: 'missing sessionId' });

    analytics.chatStarts.push({ ts: Date.now(), name: name || 'Visitor', sessionId });
    sessions[sessionId] = {
      name: name || 'Visitor',
      replies: [],
      ended: false,
      lastActivity: Date.now(),
      transcript: [],
      channelId: null
    };

    // Create channel in background
    createChannel(sessionId, name || 'Visitor').then(channelId => {
      if (channelId) {
        sessions[sessionId].channelId = channelId;
        chanMap[channelId] = sessionId;
        startChannelPoller(channelId, sessionId);
      }
    }).catch(() => {});

    return send(res, 200, { ok: true });
  }

  // Visitor: send message -> post to Discord channel
  if (path === '/chat/send' && req.method === 'POST') {
    const body = await parseBody(req);
    const { sessionId, name, message } = body;
    const sess = sessions[sessionId];
    if (!sess || sess.ended) return send(res, 200, { ok: true });

    sess.lastActivity = Date.now();
    sess.transcript.push({ from: 'visitor', name: name || sess.name, text: message, ts: Date.now() });

    if (sess.channelId) {
      discord('POST', `/channels/${sess.channelId}/messages`, {
        content: '**' + (name || sess.name) + ':** ' + message
      }).catch(() => {});
    }

    return send(res, 200, { ok: true });
  }

  // Visitor: poll for replies (index-based, never loses messages)
  if (path === '/chat/poll' && req.method === 'GET') {
    const sessionId = qs.get('sessionId');
    const since     = parseInt(qs.get('since') || '0');
    const sess      = sessions[sessionId];
    if (!sess) return send(res, 200, { replies: [], ended: false, total: 0 });
    return send(res, 200, {
      replies: sess.replies.slice(since),
      ended: sess.ended,
      total: sess.replies.length
    });
  }

  // Staff dashboard: reply
  if (path === '/chat/reply' && req.method === 'POST') {
    const body = await parseBody(req);
    const { sessionId, message, secret } = body;
    if (secret !== SECRET) return send(res, 403, { error: 'forbidden' });
    const sess = sessions[sessionId];
    if (!sess || sess.ended) return send(res, 404, { error: 'not found' });

    sess.replies.push({ text: message, ts: Date.now() });
    sess.transcript.push({ from: 'owner', name: 'Revixo', text: message, ts: Date.now() });
    sess.lastActivity = Date.now();

    // Echo to Discord channel
    if (sess.channelId) {
      discord('POST', `/channels/${sess.channelId}/messages`, {
        content: '**[Staff Dashboard]** ' + message
      }).catch(() => {});
    }

    return send(res, 200, { ok: true });
  }

  // Staff dashboard: end chat
  if (path === '/chat/end' && req.method === 'POST') {
    const body = await parseBody(req);
    const { sessionId, secret } = body;
    if (secret !== SECRET) return send(res, 403, { error: 'forbidden' });
    const sess = sessions[sessionId];
    if (sess) {
      sess.ended = true;
      sess.replies.push({ text: '__ended__', ts: Date.now(), ended: true });
      if (sess.channelId) {
        discord('POST', `/channels/${sess.channelId}/messages`, {
          embeds: [{ title: '🔴 Chat ended by staff', color: 0xdc2626 }]
        }).catch(() => {});
        setTimeout(() => {
          discord('DELETE', `/channels/${sess.channelId}`);
          delete chanMap[sess.channelId];
        }, 5000);
      }
    }
    return send(res, 200, { ok: true });
  }

  // Staff dashboard: list sessions
  if (path === '/chat/sessions' && req.method === 'GET') {
    if (qs.get('secret') !== SECRET) return send(res, 403, { error: 'forbidden' });
    const active = Object.entries(sessions)
      .filter(([, s]) => !s.ended)
      .map(([id, s]) => ({
        id, name: s.name,
        msgs: s.transcript.length,
        lastActivity: s.lastActivity,
        transcript: s.transcript
      }));
    return send(res, 200, { sessions: active });
  }


  // Track page view (dedupe same visitor within 30 min)
  if (path === '/track/pageview' && req.method === 'POST') {
    const body = await parseBody(req);
    const fp = body.fp || (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown');
    const now = Date.now();
    const recent = analytics.pageViews.filter(p => p.fp === fp && now - p.ts < 1800000);
    if (recent.length === 0) {
      analytics.pageViews.push({ ts: now, ref: body.ref || null, page: body.page || '/', fp });
    }
    return send(res, 200, { ok: true });
  }

  // Track quote
  if (path === '/track/quote' && req.method === 'POST') {
    const body = await parseBody(req);
    analytics.quoteEvents.push({ ts: Date.now(), device: body.device, model: body.model, price: body.price, ref: body.ref || null });
    return send(res, 200, { ok: true });
  }

  // Track booking (called from site webhook)
  if (path === '/track/booking' && req.method === 'POST') {
    const body = await parseBody(req);
    analytics.bookings.push({
      ts: Date.now(),
      name: body.name || 'Unknown',
      phone: body.phone || '',
      devices: body.devices || body.device || '',
      total: body.total || body.price || 0,
      type: body.type || 'callback',
      ref: body.ref || null,
      refName: body.refName || null,
      refPhone: body.refPhone || null,
      refPay: body.refPay || null,
      notes: body.notes || ''
    });
    return send(res, 200, { ok: true });
  }

  // Track referral registration
  if (path === '/track/referral' && req.method === 'POST') {
    const body = await parseBody(req);
    analytics.referrals.push({ ts: Date.now(), name: body.name, phone: body.phone, pay: body.pay, code: body.code });
    return send(res, 200, { ok: true });
  }

  // Get analytics dashboard data
  if (path === '/analytics' && req.method === 'GET') {
    if (qs.get('secret') !== SECRET) return send(res, 403, { error: 'forbidden' });
    const now = Date.now();
    const day = 86400000;
    const week = day * 7;
    const month = day * 30;

    const since = (arr, ms) => arr.filter(e => now - e.ts < ms);
    const pv = analytics.pageViews;
    const qe = analytics.quoteEvents;
    const bk = analytics.bookings;
    const rf = analytics.referrals;
    const cs = analytics.chatStarts;

    // Revenue (sum of bookings)
    const revToday = since(bk, day).reduce((s, b) => s + Number(b.total || 0), 0);
    const revWeek  = since(bk, week).reduce((s, b) => s + Number(b.total || 0), 0);
    const revMonth = since(bk, month).reduce((s, b) => s + Number(b.total || 0), 0);

    // Top devices
    const deviceCount = {};
    qe.forEach(q => { deviceCount[q.device] = (deviceCount[q.device] || 0) + 1; });

    // Hourly pageviews for last 24h
    const hourly = Array(24).fill(0);
    since(pv, day).forEach(p => {
      const h = new Date(p.ts).getHours();
      hourly[h]++;
    });

    // Unique visitors (by fp) today
    const pvToday = since(pv, day);
    const uniqueToday = new Set(pvToday.map(p => p.fp || 'unknown')).size;
    return send(res, 200, {
      pageViews: { today: uniqueToday, week: since(pv, week).length, month: since(pv, month).length, total: pv.length },
      quotes: { today: since(qe, day).length, week: since(qe, week).length, month: since(qe, month).length, total: qe.length },
      bookings: { today: since(bk, day).length, week: since(bk, week).length, month: since(bk, month).length, total: bk.length },
      chatStarts: { today: since(cs, day).length, week: since(cs, week).length, total: cs.length },
      revenue: { today: revToday, week: revWeek, month: revMonth },
      topDevices: Object.entries(deviceCount).sort((a,b) => b[1]-a[1]).slice(0,5),
      conversionRate: pv.length > 0 ? Math.round((bk.length / pv.length) * 100) : 0,
      hourlyViews: hourly,
      recentBookings: bk.slice(-20).reverse(),
      referrals: rf.slice(-50).reverse()
    });
  }

  // Get bookings list
  if (path === '/bookings' && req.method === 'GET') {
    if (qs.get('secret') !== SECRET) return send(res, 403, { error: 'forbidden' });
    return send(res, 200, { bookings: analytics.bookings.slice(-100).reverse() });
  }

  // Get referrals list
  if (path === '/referrals' && req.method === 'GET') {
    if (qs.get('secret') !== SECRET) return send(res, 403, { error: 'forbidden' });
    return send(res, 200, { referrals: analytics.referrals.slice(-100).reverse() });
  }

  if (path === '/quote' && req.method === 'POST') return send(res, 200, { ok: true });

  send(res, 404, { error: 'not found' });
});

// Cleanup stale sessions every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of Object.entries(sessions)) {
    if (now - s.lastActivity > 1800000) {
      if (s.channelId) {
        discord('DELETE', `/channels/${s.channelId}`).catch(() => {});
        delete chanMap[s.channelId];
      }
      delete sessions[id];
    }
  }
}, 1800000);

server.listen(PORT, () => console.log('Revixo chat v5 on port ' + PORT));
