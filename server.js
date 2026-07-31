// Revixo live chat relay — real two-way chat between website visitors and your Discord.
// This version stores chats in Postgres so history survives restarts/redeploys
// (the earlier in-memory version loses history if the service restarts mid-chat).
//
// How it works:
//   1. A visitor opens chat on the site -> this creates a new Discord THREAD
//      under your channel, one thread per visitor, and a row in Postgres.
//   2. Whatever the visitor types gets posted into that thread AND saved.
//   3. Whatever YOU type in that thread (as a reply) gets sent back to the
//      visitor's browser automatically (checked every second while chat is open).
//   4. Threads keep every visitor's conversation separate in Discord.
//
// Needs two things set as environment variables in Railway:
//   DISCORD_BOT_TOKEN   - from the Discord Developer Portal
//   DISCORD_CHANNEL_ID  - the channel threads get created under
// Postgres connects automatically: click "Add Postgres" in your Railway
// project and it injects a DATABASE_URL variable this code reads on its own.

import express from "express";
import cors from "cors";
import pg from "pg";
import { Client, GatewayIntentBits, ChannelType } from "discord.js";

const { Pool } = pg;

const app = express();
app.use(cors());
app.use(express.json());

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DISCORD_BOT_TOKEN || !DISCORD_CHANNEL_ID) {
  console.error("Missing DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID environment variables.");
}
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL — add a Postgres database to this Railway project.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      thread_id TEXT UNIQUE NOT NULL,
      name TEXT,
      ended BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      session_id TEXT REFERENCES chat_sessions(id) ON DELETE CASCADE,
      from_role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  console.log("Database ready.");
}

// Monthly pricing-review reminder — real checklist, not just a nag.
// Uses Postgres to remember the last month it fired, so it survives restarts
// and only ever sends once per calendar month regardless of how often this
// check runs or how many times the service redeploys.
async function checkMonthlyPricingReminder() {
  try {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const { rows } = await pool.query(
      "SELECT value FROM bot_state WHERE key = 'last_pricing_reminder'"
    );
    const lastSent = rows[0]?.value;
    if (lastSent === currentMonth) return; // already sent this month

    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
    await channel.send({
      embeds: [{
        author: { name: "📅 Monthly Pricing Review" },
        title: "Time to check your prices are still competitive",
        description:
          "This fires once a month as a reminder — it's not automatic market data, " +
          "just a nudge to actually go check.",
        color: 0xE8A93D,
        fields: [
          {
            name: "What to check",
            value:
              "• Search a few flagship models (latest iPhone Pro Max, Galaxy Ultra) " +
              "on SellIt9, SellPhoneNow, or similar GTA competitors\n" +
              "• Compare their \"up to\" price against your site's top tier for the same model\n" +
              "• If you're consistently 10%+ below them, it may be worth an adjustment",
          },
          {
            name: "Ask Claude to help",
            value:
              "Paste this into your chat with Claude: *\"Check current competitor prices " +
              "for [device] and compare to my site's pricing\"* — it can search and " +
              "recalculate specific models in a few minutes.",
          },
        ],
        footer: { text: "Revixo · Automated monthly reminder" },
        timestamp: new Date().toISOString(),
      }],
    });

    await pool.query(
      `INSERT INTO bot_state (key, value) VALUES ('last_pricing_reminder', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [currentMonth]
    );
    console.log("Monthly pricing reminder sent for", currentMonth);
  } catch (e) {
    console.error("monthly reminder check failed:", e);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("clientReady", () => {
  console.log(`Bot online as ${client.user.tag}`);
});

// Whenever you reply inside a visitor's thread, save it so their browser picks it up
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.channel.isThread()) return;
  try {
    const { rows } = await pool.query(
      "SELECT id FROM chat_sessions WHERE thread_id = $1",
      [message.channel.id]
    );
    if (!rows.length) return;
    const sessionId = rows[0].id;

    // Type "!close" in the thread to end the chat from your side — the
    // visitor's browser picks this up on its next check and shows it as closed.
    if (message.content.trim().toLowerCase() === "!close") {
      await pool.query("UPDATE chat_sessions SET ended = TRUE WHERE id = $1", [sessionId]);
      await message.channel.send("✅ Chat closed for the visitor. Archiving thread.");
      await message.channel.setArchived(true);
      return;
    }

    await pool.query(
      "INSERT INTO chat_messages (session_id, from_role, text) VALUES ($1, 'agent', $2)",
      [sessionId, message.content]
    );
  } catch (e) {
    console.error("failed to save agent reply:", e);
  }
});

client.login(DISCORD_BOT_TOKEN).catch((err) => {
  console.error("Discord login failed — check DISCORD_BOT_TOKEN is correct:", err.message);
});

function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Visitor opens the chat widget -> new session + new Discord thread
app.post("/chat/start", async (req, res) => {
  try {
    const name = (req.body && req.body.name) ? String(req.body.name).slice(0, 40) : "Visitor";
    const sessionId = genId();
    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
    const thread = await channel.threads.create({
      name: `${name} — ${new Date().toLocaleString("en-CA", { timeZone: "America/Toronto" })}`,
      type: ChannelType.PublicThread,
      autoArchiveDuration: 1440,
    });
    await thread.send(`💬 **${name} just opened live chat.** Reply here to talk to them in real time — it shows up on their screen in about a second.\nType \`!close\` when you're done to end the chat and archive this thread.`);
    await pool.query(
      "INSERT INTO chat_sessions (id, thread_id, name) VALUES ($1, $2, $3)",
      [sessionId, thread.id, name]
    );
    res.json({ sessionId });
  } catch (e) {
    console.error("chat/start error:", e);
    res.status(500).json({ error: "failed to start chat" });
  }
});

// Visitor sends a message -> post it into their thread and save it
app.post("/chat/send", async (req, res) => {
  try {
    const { sessionId, name, message } = req.body || {};
    const { rows } = await pool.query("SELECT thread_id FROM chat_sessions WHERE id = $1", [sessionId]);
    if (!rows.length) return res.status(404).json({ error: "unknown session" });
    const threadId = rows[0].thread_id;

    if (message === "[Chat ended by visitor]") {
      await pool.query("UPDATE chat_sessions SET ended = TRUE WHERE id = $1", [sessionId]);
      try {
        const thread = await client.channels.fetch(threadId);
        await thread.send("👋 Chat ended — thread closing automatically. Reopen it anytime from Discord if you need to follow up.");
        await thread.setArchived(true);
      } catch (e) {}
      return res.json({ ok: true });
    }

    if (!message || !String(message).trim()) return res.status(400).json({ error: "empty message" });
    const thread = await client.channels.fetch(threadId);
    await thread.send(`**${name || "Visitor"}:** ${String(message).slice(0, 1900)}`);
    await pool.query(
      "INSERT INTO chat_messages (session_id, from_role, text) VALUES ($1, 'visitor', $2)",
      [sessionId, message]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("chat/send error:", e);
    res.status(500).json({ error: "failed to send" });
  }
});

// Visitor's browser polls this every second for new replies.
// "since" is a count of replies already seen (matches the site's existing logic).
app.get("/chat/poll", async (req, res) => {
  try {
    const { sessionId, since } = req.query;
    const sinceCount = Number(since) || 0;

    const sessionRows = await pool.query("SELECT ended FROM chat_sessions WHERE id = $1", [sessionId]);
    if (!sessionRows.rows.length) return res.json({ replies: [], total: 0 });

    const totalRows = await pool.query(
      "SELECT COUNT(*)::int AS count FROM chat_messages WHERE session_id = $1 AND from_role = 'agent'",
      [sessionId]
    );
    const total = totalRows.rows[0].count;

    let replies = [];
    if (total > sinceCount) {
      const newRows = await pool.query(
        "SELECT text FROM chat_messages WHERE session_id = $1 AND from_role = 'agent' ORDER BY id ASC OFFSET $2",
        [sessionId, sinceCount]
      );
      replies = newRows.rows.map((r) => ({ text: r.text }));
    }

    res.json({ replies, total, ended: !!sessionRows.rows[0].ended });
  } catch (e) {
    console.error("chat/poll error:", e);
    res.json({ replies: [], total: 0 });
  }
});

app.get("/", (req, res) => res.send("Revixo chat relay is running."));

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
    // Check once on boot, then every 12 hours — cheap, and the DB guard
    // means it only ever actually sends once per calendar month.
    checkMonthlyPricingReminder();
    setInterval(checkMonthlyPricingReminder, 12 * 60 * 60 * 1000);
  })
  .catch((e) => {
    console.error("Failed to initialize database:", e);
    app.listen(PORT, () => console.log(`Listening on port ${PORT} (database init failed — check DATABASE_URL)`));
  });
