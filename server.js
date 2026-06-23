/**
 * Revixo Backend v3
 * - PostgreSQL persistence (bookings + referrals survive redeploys)
 * - In-memory chat sessions (fast, no DB overhead for live chat)
 * - Full admin endpoints (nuke, clear)
 * - Referral tracking with pending payout detection
 */

const http   = require('http');
const https  = require('https');
const { Pool } = require('pg');

const BOT_TOKEN = process.env.BOT_TOKEN;
const GUILD_ID  = process.env.GUILD_ID;
const SECRET    = process.env.REPLY_SECRET;
const PORT      = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL;

// ── POSTGRES ──────────────────────────────────────────────────────────────
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
}) : null;

async function dbInit() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        ts BIGINT NOT NULL,
        name TEXT,
        phone TEXT,
        devices TEXT,
        total NUMERIC,
        type TEXT,
        notes TEXT,
        ref TEXT,
        ref_name TEXT,
        ref_phone TEXT,
        ref_pay TEXT,
        photos TEXT,
        sold BOOLEAN DEFAULT FALSE
      );
      CREATE TABLE IF NOT EXISTS referrals (
        id SERIAL PRIMARY KEY,
        ts BIGINT NOT NULL,
        name TEXT,
        phone TEXT,
        pay TEXT,
        code TEXT UNIQUE,
        pending_payout BOOLEAN DEFAULT FALSE,
        booked_by TEXT,
        booked_at BIGINT
      );
      CREATE TABLE IF NOT EXISTS analytics (
        id SERIAL PRIMARY KEY,
        ts BIGINT NOT NULL,
        event TEXT,
        data JSONB
      );
    `);
    console.log('✅ PostgreSQL tables ready');
  } catch (e) {
    console.error('DB init error:', e.message);
  }
}

// ── IN-MEMORY (chat sessions — fast, no persistence needed) ───────────────
const sessions = {};
const chanMap  = {};
const pollers  = {};
// Fallback analytics if no DB
const memAnalytics = { bookings: [], referrals: [] };

// ── HELPERS ───────────────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
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

function authBody(body, res) {
  if (body.secret !== SECRET) { send(res, 403, { error: 'forbidden' }); return false; }
  return true;
}

// ── DISCORD ───────────────────────────────────────────────────────────────
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
        try { resolve({ ok: res.statusCode < 300, body: JSON.parse(raw) }); }
        catch { resolve({ ok: false, body: {} }); }
      });
    });
    req.on('error', () => resolve({ ok: false, body: {} }));
    if (data) req.write(data);
    req.end();
  });
}

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
    type: 0, parent_id: catId,
    topic: 'Chat with ' + name + ' | Session: ' + sessionId
  });
  if (!chanRes.ok) return null;
  const channelId = chanRes.body.id;
  chanMap[channelId] = sessionId;
  await discord('POST', `/channels/${channelId}/messages`, {
    embeds: [{
      title: '🟢 New chat — ' + name,
      color: 0x1a56db,
      description: 
        '**To reply:** just type in this channel\n' +
        '**To close:** type `!end`\n\n' +
        '> 💡 The visitor sees your messages in real-time on revixo.ca',
      fields: [
        { name: '👤 Visitor', value: name, inline: true },
        { name: '🕐 Started', value: new Date().toLocaleTimeString('en-CA', {hour:'2-digit',minute:'2-digit'}), inline: true },
      ],
      footer: { text: 'Revixo Live Chat · ' + sessionId },
      timestamp: new Date().toISOString()
    }]
  });
  return channelId;
}

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
    for (const msg of res.body.slice().reverse()) {
      if (!lastId || BigInt(msg.id) > BigInt(lastId)) lastId = msg.id;
      if (msg.author?.bot) continue;
      const txt = (msg.content || '').trim();
      if (!txt) continue;
      if (txt.toLowerCase() === '!end') {
        sess.ended = true;
        sess.replies.push({ text: '__ended__', ts: Date.now(), ended: true });
        await discord('POST', `/channels/${channelId}/messages`, {
          embeds: [{ title: '🔴 Chat closed by staff', color: 0xdc2626, footer: { text: 'Revixo' } }]
        });
        setTimeout(() => {
          discord('DELETE', `/channels/${channelId}`);
          clearInterval(pollers[channelId]);
          delete pollers[channelId];
          delete chanMap[channelId];
        }, 4000);
        return;
      }
      sess.replies.push({ text: txt, ts: Date.now() });
      sess.transcript.push({ from: 'owner', name: 'Revixo', text: txt, ts: Date.now() });
      sess.lastActivity = Date.now();
    }
  }, 1500);
}

// ── DB HELPERS ────────────────────────────────────────────────────────────
async function saveBooking(b) {
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO bookings (ts,name,phone,devices,total,type,notes,ref,ref_name,ref_phone,ref_pay,photos)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [b.ts, b.name, b.phone, b.devices, b.total, b.type, b.notes,
         b.ref, b.refName, b.refPhone, b.refPay, JSON.stringify(b.photos || [])]
      );
    } catch (e) { console.error('saveBooking:', e.message); }
  } else {
    memAnalytics.bookings.push(b);
  }
}

async function getBookings() {
  if (pool) {
    try {
      const r = await pool.query('SELECT * FROM bookings ORDER BY ts DESC LIMIT 200');
      return r.rows.map(row => ({
        ts: Number(row.ts), name: row.name, phone: row.phone,
        devices: row.devices, total: row.total, type: row.type,
        notes: row.notes, ref: row.ref, refName: row.ref_name,
        refPhone: row.ref_phone, refPay: row.ref_pay,
        photos: JSON.parse(row.photos || '[]'), sold: row.sold, id: row.id
      }));
    } catch (e) { console.error('getBookings:', e.message); return []; }
  }
  return memAnalytics.bookings.slice().reverse();
}

async function saveReferral(r) {
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO referrals (ts,name,phone,pay,code)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (code) DO NOTHING`,
        [r.ts, r.name, r.phone, r.pay, r.code]
      );
    } catch (e) { console.error('saveReferral:', e.message); }
  } else {
    if (!memAnalytics.referrals.find(x => x.code === r.code)) {
      memAnalytics.referrals.push(r);
    }
  }
}

async function getReferrals() {
  if (pool) {
    try {
      const r = await pool.query('SELECT * FROM referrals ORDER BY ts DESC LIMIT 200');
      return r.rows.map(row => ({
        ts: Number(row.ts), name: row.name, phone: row.phone, pay: row.pay,
        code: row.code, pendingPayout: row.pending_payout,
        bookedBy: row.booked_by, bookedAt: row.booked_at, id: row.id
      }));
    } catch (e) { console.error('getReferrals:', e.message); return []; }
  }
  return memAnalytics.referrals.slice().reverse();
}

async function markReferralPending(code, bookedBy, refData) {
  if (pool) {
    try {
      // Upsert — create record if it doesn't exist yet, then mark pending
      await pool.query(
        `INSERT INTO referrals (ts, name, phone, pay, code, pending_payout, booked_by, booked_at)
         VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7)
         ON CONFLICT (code) DO UPDATE
           SET pending_payout = TRUE,
               booked_by      = EXCLUDED.booked_by,
               booked_at      = EXCLUDED.booked_at,
               name           = CASE WHEN referrals.name = '' OR referrals.name IS NULL THEN EXCLUDED.name ELSE referrals.name END,
               phone          = CASE WHEN referrals.phone = '' OR referrals.phone IS NULL THEN EXCLUDED.phone ELSE referrals.phone END,
               pay            = CASE WHEN referrals.pay = '' OR referrals.pay IS NULL THEN EXCLUDED.pay ELSE referrals.pay END`,
        [
          Date.now(),
          (refData && refData.refName) || 'Unknown referrer',
          (refData && refData.refPhone) || '',
          (refData && refData.refPay) || '',
          code,
          bookedBy,
          Date.now()
        ]
      );
    } catch (e) { console.error('markReferralPending:', e.message); }
  } else {
    const ref = memAnalytics.referrals.find(r => r.code === code);
    if (ref) {
      ref.pendingPayout = true; ref.bookedBy = bookedBy; ref.bookedAt = Date.now();
    } else {
      // Create if missing
      memAnalytics.referrals.push({
        ts: Date.now(), code,
        name: (refData && refData.refName) || 'Unknown referrer',
        phone: (refData && refData.refPhone) || '',
        pay: (refData && refData.refPay) || '',
        pendingPayout: true, bookedBy, bookedAt: Date.now()
      });
    }
  }
}

async function markBookingSold(id, sold) {
  if (pool) {
    try {
      await pool.query('UPDATE bookings SET sold=$1 WHERE id=$2', [sold, id]);
    } catch (e) { console.error('markBookingSold:', e.message); }
  }
}

// ── HTTP SERVER ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const path = req.url.split('?')[0];
  const qs   = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');

  // Health
  if (path === '/' && req.method === 'GET') {
    const bk = pool ? (await pool.query('SELECT COUNT(*) FROM bookings').catch(() => ({ rows: [{ count: 0 }] }))).rows[0].count : memAnalytics.bookings.length;
    const rf = pool ? (await pool.query('SELECT COUNT(*) FROM referrals').catch(() => ({ rows: [{ count: 0 }] }))).rows[0].count : memAnalytics.referrals.length;
    return send(res, 200, {
      status: 'ok', db: pool ? 'postgres' : 'memory',
      bookings: Number(bk), referrals: Number(rf),
      sessions: Object.keys(sessions).filter(k => !sessions[k].ended).length
    });
  }

  // ── CHAT ─────────────────────────────────────────────────────────────
  if (path === '/chat/start' && req.method === 'POST') {
    const body = await parseBody(req);
    // Use client's sessionId if valid, otherwise generate one
    const id = (body.sessionId && body.sessionId.length > 5 && !sessions[body.sessionId])
      ? body.sessionId
      : 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    sessions[id] = {
      id, name: body.name || 'Visitor', device: body.device || '',
      transcript: [{ from: 'visitor', text: body.name || 'Visitor', ts: Date.now(), system: true }],
      replies: [], started: Date.now(),
      lastActivity: Date.now(), ended: false, channelId: null
    };
    const channelId = await createChannel(id, body.name || 'visitor');
    if (channelId) { sessions[id].channelId = channelId; startChannelPoller(channelId, id); }
    return send(res, 200, { sessionId: id, ok: true });
  }

  if (path === '/chat/send' && req.method === 'POST') {
    const body = await parseBody(req);
    const sess = sessions[body.sessionId];
    if (!sess || sess.ended) return send(res, 404, { error: 'session not found' });
    sess.transcript.push({ from: 'visitor', text: body.message, ts: Date.now() });
    sess.lastActivity = Date.now();
    if (sess.channelId) {
      await discord('POST', `/channels/${sess.channelId}/messages`, {
        embeds: [{
          description: body.message,
          color: 0x374151,
          author: { name: '💬 ' + (sess.name || 'Visitor') },
          timestamp: new Date().toISOString()
        }]
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
    if (!authBody(body, res)) return;
    const sess = sessions[body.sessionId];
    if (!sess || sess.ended) return send(res, 404, { error: 'not found' });
    sess.replies.push({ text: body.message, ts: Date.now() });
    sess.transcript.push({ from: 'staff', name: 'Revixo', text: body.message, ts: Date.now() });
    sess.lastActivity = Date.now();
    if (sess.channelId) {
      await discord('POST', `/channels/${sess.channelId}/messages`, {
        embeds: [{
          description: body.message,
          color: 0x1a56db,
          author: { name: '📤 Revixo Staff' },
          timestamp: new Date().toISOString()
        }]
      });
    }
    return send(res, 200, { ok: true });
  }

  if (path === '/chat/end' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!authBody(body, res)) return;
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
    const cutoff = Date.now() - 30 * 60 * 1000;
    const active = Object.values(sessions)
      .filter(s => !s.ended && s.lastActivity > cutoff)
      .map(s => ({ id: s.id, name: s.name, device: s.device, transcript: s.transcript, started: s.started, lastActivity: s.lastActivity }));
    return send(res, 200, { sessions: active });
  }

  // ── TRACKING ──────────────────────────────────────────────────────────
  if (path === '/track/pageview' && req.method === 'POST') {
    if (pool) pool.query('INSERT INTO analytics (ts,event,data) VALUES ($1,$2,$3)', [Date.now(), 'pageview', '{}']).catch(() => {});
    return send(res, 200, { ok: true });
  }

  if (path === '/track/quote' && req.method === 'POST') {
    const body = await parseBody(req);
    if (pool) pool.query('INSERT INTO analytics (ts,event,data) VALUES ($1,$2,$3)', [Date.now(), 'quote', JSON.stringify(body)]).catch(() => {});
    return send(res, 200, { ok: true });
  }

  if (path === '/track/booking' && req.method === 'POST') {
    const body = await parseBody(req);
    const booking = {
      ts: Date.now(), name: body.name || 'Unknown', phone: body.phone || '',
      devices: body.devices || '', total: Number(body.total) || 0,
      type: body.type || 'callback', notes: body.notes || '',
      photos: body.photos || [], ref: body.ref || null,
      refName: body.refName || null, refPhone: body.refPhone || null, refPay: body.refPay || null,
    };
    await saveBooking(booking);
    if (booking.ref) await markReferralPending(booking.ref, booking.name, booking);
    return send(res, 200, { ok: true });
  }

  if (path === '/track/referral' && req.method === 'POST') {
    const body = await parseBody(req);
    await saveReferral({ ts: Date.now(), name: body.name || '', phone: body.phone || '', pay: body.pay || '', code: body.code || '' });
    return send(res, 200, { ok: true });
  }

  // ── DATA ──────────────────────────────────────────────────────────────
  if (path === '/bookings' && req.method === 'GET') {
    if (!auth(qs, res)) return;
    return send(res, 200, { bookings: await getBookings() });
  }

  if (path === '/referrals' && req.method === 'GET') {
    if (!auth(qs, res)) return;
    return send(res, 200, { referrals: await getReferrals() });
  }

  // Get info about a specific referral code (for buyer's session)
  if (path === '/referral-info' && req.method === 'GET') {
    const code = qs.get('code');
    if (!code) return send(res, 400, { error: 'missing code' });
    if (pool) {
      try {
        const r = await pool.query('SELECT name, phone, pay FROM referrals WHERE code=$1', [code]);
        if (r.rows.length) return send(res, 200, r.rows[0]);
        return send(res, 404, { error: 'not found' });
      } catch (e) { return send(res, 500, { error: 'db error' }); }
    } else {
      const ref = memAnalytics.referrals.find(r => r.code === code);
      if (ref) return send(res, 200, { name: ref.name, phone: ref.phone, pay: ref.pay });
      return send(res, 404, { error: 'not found' });
    }
  }

  if (path === '/analytics' && req.method === 'GET') {
    if (!auth(qs, res)) return;
    const bks = await getBookings();
    const rfs = await getReferrals();
    const activeSessions = Object.values(sessions).filter(s => !s.ended).length;
    return send(res, 200, {
      bookings: bks.length, referrals: rfs.length,
      activeSessions, db: pool ? 'postgres' : 'memory'
    });
  }

  // Mark booking as sold
  if (path === '/bookings/sold' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!authBody(body, res)) return;
    await markBookingSold(body.id, body.sold);
    return send(res, 200, { ok: true });
  }

  if (path === '/quote' && req.method === 'POST') return send(res, 200, { ok: true });

  // ── ADMIN ─────────────────────────────────────────────────────────────
  if (path === '/admin/clear-bookings' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!authBody(body, res)) return;
    let count = 0;
    if (pool) {
      const r = await pool.query('DELETE FROM bookings RETURNING id').catch(() => ({ rows: [] }));
      count = r.rows.length;
    } else {
      count = memAnalytics.bookings.length;
      memAnalytics.bookings.length = 0;
    }
    return send(res, 200, { ok: true, cleared: count });
  }

  if (path === '/admin/clear-referrals' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!authBody(body, res)) return;
    let count = 0;
    if (pool) {
      const r = await pool.query('DELETE FROM referrals RETURNING id').catch(() => ({ rows: [] }));
      count = r.rows.length;
    } else {
      count = memAnalytics.referrals.length;
      memAnalytics.referrals.length = 0;
    }
    return send(res, 200, { ok: true, cleared: count });
  }

  if (path === '/admin/nuke' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!authBody(body, res)) return;
    if (pool) {
      await Promise.all([
        pool.query('DELETE FROM bookings').catch(() => {}),
        pool.query('DELETE FROM referrals').catch(() => {}),
        pool.query('DELETE FROM analytics').catch(() => {}),
      ]);
    } else {
      memAnalytics.bookings.length = 0;
      memAnalytics.referrals.length = 0;
    }
    const sessionIds = Object.keys(sessions);
    for (const id of sessionIds) {
      sessions[id].ended = true;
      if (sessions[id].channelId) discord('DELETE', `/channels/${sessions[id].channelId}`).catch(() => {});
    }
    return send(res, 200, { ok: true, nuked: { bookings: true, referrals: true, sessions: sessionIds.length } });
  }

  send(res, 404, { error: 'not found' });
});

// Cleanup stale sessions every 30 min
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const id of Object.keys(sessions)) {
    if (sessions[id].ended || sessions[id].lastActivity < cutoff) delete sessions[id];
  }
}, 30 * 60 * 1000);

// Boot
dbInit().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 Revixo backend on port ${PORT} | DB: ${pool ? 'PostgreSQL' : 'memory'}`);
  });
});
