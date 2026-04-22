// WhatsApp group-preview + broadcast bot.
//
// Runs whatsapp-web.js (Puppeteer + WhatsApp Web) and exposes a tiny HTTP
// API the main Vercel site can call to resolve a group invite code into
// the real group name + display picture.
//
// Endpoints:
//   GET  /healthz                        -> liveness probe
//   GET  /qr                             -> first-time QR setup page (HTML)
//   GET  /preview/:code   (Bearer auth)  -> { ok, name, imageUrl, size }
//   POST /set-message     (Bearer auth)  -> set daily broadcast message
//   GET  /broadcast/status (Bearer auth) -> last broadcast info
//   POST /broadcast        (Bearer auth) -> trigger broadcast now
//
// Required env vars:
//   BOT_KEY        Secret string the main site sends as Bearer token.
//   PORT           Optional, defaults to 3000.
//   SESSION_DIR    Optional, defaults to ./.wwebjs_auth
//   DATABASE_URL   PostgreSQL connection string.
//   BROADCAST_MESSAGE  Optional, default message for daily broadcast.

const express = require("express");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const { Client, LocalAuth } = require("whatsapp-web.js");
const { Pool } = require("pg");
require("dotenv").config();

const PORT = parseInt(process.env.PORT || "3000", 10);
const BOT_KEY = process.env.BOT_KEY || "";
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, ".wwebjs_auth");

if (!BOT_KEY) {
  console.error("FATAL: BOT_KEY env var is required.");
  process.exit(1);
}

try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch (e) {}

let lastQr = null;
let lastQrAt = 0;
let ready = false;
let lastReadyAt = 0;
let lastDisconnectReason = null;

// ---- BROADCAST STATE ----
let broadcastMessage = process.env.BROADCAST_MESSAGE || "";
let broadcastRunning = false;
let lastBroadcastAt = null;
let lastBroadcastSent = 0;
let lastBroadcastTotal = 0;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR, clientId: "main" }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
    ],
  },
});

client.on("qr", (qr) => {
  lastQr = qr;
  lastQrAt = Date.now();
  ready = false;
  console.log("[bot] QR received — open /qr to scan.");
});

client.on("authenticated", () => { console.log("[bot] Authenticated."); });
client.on("auth_failure", (m) => { console.error("[bot] AUTH FAILURE:", m); });

client.on("ready", () => {
  ready = true;
  lastReadyAt = Date.now();
  lastQr = null;
  console.log("[bot] Ready — accepting requests.");
});

client.on("disconnected", (reason) => {
  ready = false;
  lastDisconnectReason = reason;
  console.warn("[bot] Disconnected:", reason);
  setTimeout(() => {
    client.initialize().catch((e) => console.error("[bot] reinit failed:", e));
  }, 5000);
});

client.initialize().catch((e) => { console.error("[bot] initialize() failed:", e); });

const app = express();
app.use(express.json());
app.disable("x-powered-by");

// ── helpers ──────────────────────────────────────────────────────────────────

function authOk(req) {
  const h = req.headers.authorization || "";
  if (h === `Bearer ${BOT_KEY}`) return true;
  if (req.headers["x-bot-key"] === BOT_KEY) return true;
  if ((req.query.key || "") === BOT_KEY) return true;
  return false;
}

const VALID_CODE_RE = /^[A-Za-z0-9]{10,}$/;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── routes ────────────────────────────────────────────────────────────────────

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true, ready, hasQr: !!lastQr,
    lastReadyAt: lastReadyAt || null,
    lastQrAt: lastQrAt || null,
    lastDisconnectReason,
    uptimeSeconds: Math.round(process.uptime()),
    broadcast: {
      hasMessage: !!broadcastMessage,
      running: broadcastRunning,
      lastAt: lastBroadcastAt,
      lastSent: lastBroadcastSent,
      lastTotal: lastBroadcastTotal,
    },
  });
});

app.get("/qr", async (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const base = `<!doctype html><meta charset=utf8><meta http-equiv=refresh content=8>
    <style>body{font-family:system-ui;background:#0b1020;color:#e2e8f0;display:flex;align-items:center;
    justify-content:center;min-height:100vh;margin:0}div{padding:28px 24px;background:#111c3a;
    border-radius:16px;text-align:center;max-width:420px}h1{margin:0 0 6px;font-size:20px}
    p,li{color:#94a3b8;font-size:14px;line-height:1.5}img{display:block;margin:14px auto;
    border-radius:12px;background:#fff;padding:10px}</style>`;

  if (ready) {
    return res.end(base + `<div><h1 style=color:#22c55e>Bot logged in ✓</h1>
      <p>Last ready: ${new Date(lastReadyAt).toISOString()}</p></div>`);
  }
  if (!lastQr) {
    return res.end(base + `<div><h1>Waiting for QR…</h1>
      <p>WhatsApp Web client is starting. Takes 20–60s on first boot.</p></div>`);
  }
  const dataUrl = await QRCode.toDataURL(lastQr, { margin: 1, width: 320 });
  res.end(base + `<div><h1 style=color:#22c55e>Scan to log in</h1>
    <img src="${dataUrl}" alt="QR">
    <ol style=text-align:left;padding-left:18px>
      <li>Open WhatsApp → Settings → Linked Devices</li>
      <li>Tap "Link a Device" and scan this QR</li>
    </ol></div>`);
});

// Preview group WITHOUT joining
app.get("/preview/:code", async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!ready) return res.status(503).json({ ok: false, error: "bot not ready", retryAfterMs: 5000 });
  const code = String(req.params.code || "").trim();
  if (!VALID_CODE_RE.test(code))
    return res.status(400).json({ ok: false, error: "invalid invite code" });
  try {
    const info = await Promise.race([
      client.getInviteInfo(code),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000)),
    ]);
    if (!info) return res.json({ ok: false, error: "no info returned" });

    const groupId = info.id?._serialized || info.id || null;
    let pictureUrl = null;
    if (groupId) {
      try {
        pictureUrl = await Promise.race([
          client.getProfilePicUrl(groupId),
          new Promise((_, rej) => setTimeout(() => rej(new Error("dp timeout")), 8000)),
        ]);
      } catch (e) { pictureUrl = info.pictureUrl || null; }
    }
    return res.json({
      ok: true,
      name: info.subject || null,
      imageUrl: pictureUrl || info.pictureUrl || null,
      size: typeof info.size === "number" ? info.size : (info.participants?.length ?? null),
      groupId,
    });
  } catch (err) {
    const msg = err?.message || String(err);
    const lower = msg.toLowerCase();
    const revoked = lower.includes("revoked") || lower.includes("not-found")
      || lower.includes("invalid") || lower.includes("not found");
    return res.json({ ok: false, error: msg, revoked });
  }
});

// Set the daily broadcast message
app.post("/set-message", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const msg = req.body?.message;
  if (!msg || typeof msg !== "string" || !msg.trim())
    return res.status(400).json({ ok: false, error: "message required" });
  broadcastMessage = msg.trim();
  console.log("[broadcast] Message updated:", broadcastMessage.slice(0, 60));
  return res.json({ ok: true, message: broadcastMessage });
});

// Get broadcast status
app.get("/broadcast/status", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  return res.json({
    ok: true,
    message: broadcastMessage || null,
    running: broadcastRunning,
    lastAt: lastBroadcastAt,
    lastSent: lastBroadcastSent,
    lastTotal: lastBroadcastTotal,
  });
});

// Trigger broadcast now
app.post("/broadcast", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!ready) return res.status(503).json({ ok: false, error: "bot not ready" });
  if (!broadcastMessage) return res.status(400).json({ ok: false, error: "No message set. Call POST /set-message first." });
  if (broadcastRunning) return res.status(409).json({ ok: false, error: "Broadcast already running. Wait for it to finish." });
  res.json({ ok: true, message: "Broadcast started in background." });
  broadcastToApproved().catch((e) => console.error("[broadcast] Error:", e));
});

app.get("/", (_req, res) => {
  res.json({
    service: "whatsapp-otp-group-bot", ready,
    routes: ["/healthz", "/qr", "/preview/:code (auth)",
             "POST /set-message (auth)", "GET /broadcast/status (auth)",
             "POST /broadcast (auth)"],
  });
});

app.listen(PORT, "0.0.0.0", () => { console.log(`[bot] HTTP listening on :${PORT}`); });

// ── DATABASE ──────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── SYNC: fill missing name/dp by joining the group ───────────────────────────

async function syncPendingGroups() {
  if (!ready) return;
  console.log("[sync] Checking for groups needing metadata...");
  let dbClient;
  try {
    dbClient = await pool.connect();
    const res = await dbClient.query(`
      SELECT id, link FROM groups
      WHERE (name IS NULL OR image_url IS NULL)
        AND status IN ('approved', 'pending')
        AND (last_checked_at IS NULL OR last_checked_at < NOW() - INTERVAL '1 hour')
      LIMIT 5
    `);

    for (const row of res.rows) {
      const code = row.link.split("/").pop();
      console.log(`[sync] Resolving ${code} (ID: ${row.id})...`);
      try {
        // First try without joining (cheaper)
        const info = await Promise.race([
          client.getInviteInfo(code),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000)),
        ]);

        let imageUrl = info.pictureUrl || null;

        // If still no name/pic, join the group to get real info
        if (!info.subject || !imageUrl) {
          console.log(`[sync] Joining group ${row.id} to get full info...`);
          try {
            const joinedChatId = await Promise.race([
              client.acceptInvite(code),
              new Promise((_, rej) => setTimeout(() => rej(new Error("join timeout")), 20000)),
            ]);
            await sleep(3000); // let WhatsApp settle
            if (joinedChatId) {
              try {
                const chat = await client.getChatById(joinedChatId);
                if (chat.name && !info.subject) info.subject = chat.name;
                if (!imageUrl) {
                  imageUrl = await Promise.race([
                    client.getProfilePicUrl(joinedChatId),
                    new Promise((_, rej) => setTimeout(() => rej(new Error("dp timeout")), 8000)),
                  ]).catch(() => null);
                }
                console.log(`[sync] Joined & got: name="${chat.name}" hasPic=${!!imageUrl}`);
              } catch (e) { console.log(`[sync] getChatById failed:`, e.message); }
            }
          } catch (e) { console.log(`[sync] Join failed for ${row.id}:`, e.message); }
        } else {
          // Try backup DP fetch if still missing
          if (!imageUrl && info.id) {
            try {
              imageUrl = await Promise.race([
                client.getProfilePicUrl(info.id._serialized || info.id),
                new Promise((_, rej) => setTimeout(() => rej(new Error("dp timeout")), 5000)),
              ]);
            } catch (e) { /* noop */ }
          }
        }

        await dbClient.query(
          `UPDATE groups SET name = $1, image_url = $2, last_checked_at = NOW() WHERE id = $3`,
          [info.subject || null, imageUrl || null, row.id]
        );
        console.log(`[sync] Updated ${row.id}: ${info.subject}`);
        await sleep(3000); // 3s between each group to avoid rate limits
      } catch (err) {
        console.error(`[sync] Failed to resolve ${code}:`, err.message);
        await dbClient.query("UPDATE groups SET last_checked_at = NOW() WHERE id = $1", [row.id]);
      }
    }
  } catch (err) {
    console.error("[sync] DB Error:", err.message);
  } finally {
    if (dbClient) dbClient.release();
  }
}

// ── BROADCAST: daily message to all approved groups ───────────────────────────

async function broadcastToApproved() {
  if (!ready || !broadcastMessage) return;
  if (broadcastRunning) { console.log("[broadcast] Already running, skipping."); return; }

  broadcastRunning = true;
  console.log("[broadcast] Starting broadcast...");
  let dbClient;
  try {
    dbClient = await pool.connect();
    const result = await dbClient.query(
      `SELECT id, link, name FROM groups WHERE status = 'approved' ORDER BY id`
    );
    const groups = result.rows;
    console.log(`[broadcast] ${groups.length} approved groups to message.`);
    lastBroadcastTotal = groups.length;

    // Build a map of joined chats for quick lookup (chatId → chat)
    let joinedChats = {};
    try {
      const allChats = await client.getChats();
      for (const c of allChats) { if (c.isGroup) joinedChats[c.id._serialized] = c; }
    } catch (e) { console.error("[broadcast] getChats failed:", e.message); }

    let sent = 0;
    for (const g of groups) {
      try {
        const code = g.link.split("/").pop();

        // Get group id (without joining)
        let chatId = null;
        try {
          const info = await Promise.race([
            client.getInviteInfo(code),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 10000)),
          ]);
          chatId = info.id?._serialized || null;
        } catch (e) { console.log(`[broadcast] getInviteInfo failed for ${g.id}: ${e.message}`); }

        let chat = chatId ? joinedChats[chatId] : null;

        // If not a member yet, join the group
        if (!chat && chatId) {
          try {
            console.log(`[broadcast] Joining group ${g.id} to send message...`);
            const joinedId = await Promise.race([
              client.acceptInvite(code),
              new Promise((_, rej) => setTimeout(() => rej(new Error("join timeout")), 20000)),
            ]);
            await sleep(3000);
            if (joinedId) {
              chat = await client.getChatById(joinedId).catch(() => null);
              if (chat) joinedChats[joinedId] = chat;
            }
          } catch (e) { console.log(`[broadcast] Join failed for ${g.id}: ${e.message}`); }
        }

        if (chat) {
          try {
            await chat.sendMessage(broadcastMessage);
            sent++;
            console.log(`[broadcast] ✓ Sent to group ${g.id} (${g.name || chatId})`);
          } catch (e) { console.log(`[broadcast] sendMessage failed for ${g.id}: ${e.message}`); }
        } else {
          console.log(`[broadcast] ✗ Not a member of group ${g.id}, skipped.`);
        }
      } catch (e) {
        console.error(`[broadcast] Unexpected error for group ${g.id}:`, e.message);
      }

      // 5 second delay between each group
      await sleep(5000);
    }

    lastBroadcastAt = new Date().toISOString();
    lastBroadcastSent = sent;
    console.log(`[broadcast] Done. Sent: ${sent}/${groups.length}`);
  } catch (e) {
    console.error("[broadcast] DB error:", e.message);
  } finally {
    if (dbClient) dbClient.release();
    broadcastRunning = false;
  }
}

// ── SCHEDULERS ────────────────────────────────────────────────────────────────

// Sync every 2 minutes
setInterval(syncPendingGroups, 2 * 60 * 1000);
setTimeout(syncPendingGroups, 30000);

// Daily broadcast at 10:00 AM IST (04:30 UTC)
function scheduleDailyBroadcast() {
  const now = new Date();
  const target = new Date();
  target.setUTCHours(4, 30, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const delay = target - now;
  console.log(`[broadcast] Next daily broadcast in ${Math.round(delay / 60000)} minutes (IST 10:00 AM)`);
  setTimeout(async () => {
    if (broadcastMessage) {
      await broadcastToApproved().catch((e) => console.error("[broadcast] scheduled error:", e));
    } else {
      console.log("[broadcast] No message set — skipping scheduled broadcast.");
    }
    scheduleDailyBroadcast();
  }, delay);
}

setTimeout(scheduleDailyBroadcast, 10000);
