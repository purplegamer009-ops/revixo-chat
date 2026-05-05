const http = require('http');
const https = require('https');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const GUILD_ID = process.env.GUILD_ID || '';
const CATEGORY_ID = process.env.CATEGORY_ID || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const PORT = process.env.PORT || 3000;

// In-memory sessions: sessionId -> { name, channelId, messages[], lastActivity }
const sessions = {};

function discordRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'discord.com',
      path: '/api/v10' + path,
      method,
      headers: {
        'Authorization': 'Bot ' + DISCORD_TOKEN,
        'Content-Type': 'application/json',
        'User-Agent': 'RevixoBot/1.0'
      }
    };
    if (data) options.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sendWebhook(body) {
  return new Promise((resolve) => {
    if (!WEBHOOK_URL) return resolve();
    const url = new URL(WEBHOOK_URL + '?wait=true');
    const data = JSON.stringify(body);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(data);
    req.end();
  });
}

async function createChannel(name) {
  const safeName = name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20);
  const channelName = 'chat-' + safeName + '-' + Date.now().toString(36).slice(-4);
  const body = { name: channelName, type: 0 };
  if (CATEGORY_ID) body.parent_id = CATEGORY_ID;
  const res = await discordRequest('POST', '/guilds/' + GUILD_ID + '/channels', body);
  return res.body;
}

async function sendToChannel(channelId, content) {
  await discordRequest('POST', '/channels/' + channelId + '/messages', { content });
}

async function deleteChannel(channelId) {
  await discordRequest('DELETE', '/channels/' + channelId);
}

// Poll Discord channel for new messages from owner
async function pollChannel(channelId, after) {
  const path = '/channels/' + channelId + '/messages?limit=10' + (after ? '&after=' + after : '');
  const res = await discordRequest('GET', path, null);
  if (!Array.isArray(res.body)) return [];
  // Filter out bot messages and system messages
  return res.body.filter(m => !m.author.bot && m.type === 0);
}

function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); } catch(e) { resolve({}); }
    });
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

const server = http.createServer(async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];
  const params = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');

  // Health check
  if (url === '/' && req.method === 'GET') {
    return json(res, 200, { ok: true, sessions: Object.keys(sessions).length });
  }

  // Start chat session
  if (url === '/chat/start' && req.method === 'POST') {
    const body = await parseBody(req);
    const { sessionId, name } = body;
    if (!sessionId) return json(res, 400, { error: 'no sessionId' });

    try {
      // Create Discord channel for this chat
      const channel = await createChannel(name || 'visitor');
      sessions[sessionId] = {
        name: name || 'Visitor',
        channelId: channel.id,
        channelName: channel.name,
        lastMsgId: null,
        replies: [],
        ended: false,
        lastActivity: Date.now()
      };

      // Send welcome embed to channel
      await discordRequest('POST', '/channels/' + channel.id + '/messages', {
        embeds: [{
          title: '💬 New Live Chat — ' + (name || 'Visitor'),
          color: 3559039,
          description: 'A visitor started a live chat on revixo.ca.\n\nType your reply directly in this channel.\nUse `!endchat` to close the chat.',
          fields: [{ name: 'Session', value: sessionId, inline: true }],
          footer: { text: 'Revixo | revixo.ca' },
          timestamp: new Date().toISOString()
        }]
      });

      // Also notify main webhook
      await sendWebhook({
        embeds: [{
          title: '💬 New Live Chat — ' + (name || 'Visitor'),
          color: 3559039,
          description: 'Go to **#' + channel.name + '** to reply.',
          footer: { text: 'Revixo | revixo.ca' },
          timestamp: new Date().toISOString()
        }]
      });

      return json(res, 200, { ok: true, channel: channel.name });
    } catch(e) {
      return json(res, 500, { error: e.message });
    }
  }

  // Send message from visitor
  if (url === '/chat/send' && req.method === 'POST') {
    const body = await parseBody(req);
    const { sessionId, name, message } = body;
    const session = sessions[sessionId];
    if (!session) return json(res, 404, { error: 'no session' });
    if (session.ended) return json(res, 200, { ok: true, ended: true });

    session.lastActivity = Date.now();

    // Send to Discord channel
    try {
      await sendToChannel(session.channelId, '**' + (name || session.name) + ':** ' + message);
    } catch(e) {}

    return json(res, 200, { ok: true });
  }

  // Poll for replies from owner
  if (url === '/chat/poll' && req.method === 'GET') {
    const sessionId = params.get('sessionId');
    const since = params.get('since') || 0;
    const session = sessions[sessionId];
    if (!session) return json(res, 200, { replies: [], ended: false });

    if (session.ended) {
      return json(res, 200, { replies: [], ended: true });
    }

    try {
      // Poll Discord channel for new messages
      const msgs = await pollChannel(session.channelId, session.lastMsgId);

      const newReplies = [];
      for (const msg of msgs) {
        // Check for !endchat command
        if (msg.content.toLowerCase().trim() === '!endchat') {
          session.ended = true;
          await sendToChannel(session.channelId, '✅ Chat ended. Channel will be deleted in 10 seconds.');
          setTimeout(() => deleteChannel(session.channelId), 10000);
          return json(res, 200, { replies: newReplies, ended: true });
        }
        // Regular reply - send to visitor
        newReplies.push({ text: msg.content, ts: Date.parse(msg.timestamp) });
        session.lastMsgId = msg.id;
      }

      return json(res, 200, { replies: newReplies, ended: false });
    } catch(e) {
      return json(res, 200, { replies: [], ended: false });
    }
  }

  // Quote notification (from site booking form)
  if (url === '/quote' && req.method === 'POST') {
    const body = await parseBody(req);
    // Just acknowledge - webhook is handled client-side
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'not found' });
});

// Cleanup old sessions every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of Object.entries(sessions)) {
    if (now - session.lastActivity > 1800000) { // 30 min
      if (!session.ended && session.channelId) {
        deleteChannel(session.channelId).catch(() => {});
      }
      delete sessions[id];
    }
  }
}, 1800000);

server.listen(PORT, () => console.log('Revixo chat server running on port ' + PORT));
