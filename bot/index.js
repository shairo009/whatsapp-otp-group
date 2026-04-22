// WhatsApp OTP Group — Bot
//
// Features:
//   1. Metadata sync   — fills missing name/dp for groups (joins if needed)
//   2. Group join      — joins ALL approved groups so we can post in them
//   3. Reset detection — groups that are admin-only/empty go to DB review
//   4. Daily broadcast — every day at 7 PM IST, posts promo in all joined groups
//
// HTTP Endpoints:
//   GET  /healthz
//   GET  /qr
//   GET  /preview/:code   (Bearer auth)
//   POST /broadcast        (Bearer auth) — trigger broadcast manually
//   GET  /broadcast/status (Bearer auth)
//
// Required env vars:
//   BOT_KEY       — secret auth token
//   DATABASE_URL  — postgres connection string
//   SITE_URL      — website URL (default: https://whatsapp-otp-group.vercel.app)
//   PORT          — optional, default 3000
//   SESSION_DIR   — optional, default ./.wwebjs_auth

const express   = require("express");
const QRCode    = require("qrcode");
const path      = require("path");
const fs        = require("fs");
const { Client, LocalAuth } = require("whatsapp-web.js");
const { Pool }  = require("pg");
require("dotenv").config();

const PORT       = parseInt(process.env.PORT || "3000", 10);
const BOT_KEY    = process.env.BOT_KEY || "";
const SITE_URL   = (process.env.SITE_URL || "https://whatsapp-otp-group.vercel.app").replace(/\/+$/, "");
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, ".wwebjs_auth");

if (!BOT_KEY) { console.error("FATAL: BOT_KEY env var is required."); process.exit(1); }

try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch (_) {}

// ── State ────────────────────────────────────────────────────────────────────
let lastQr = null, lastQrAt = 0, ready = false, lastReadyAt = 0, lastDisconnectReason = null;
let broadcastRunning = false, lastBroadcastAt = null, lastBroadcastSent = 0, lastBroadcastTotal = 0;

// ── Promotional message (Hindi) ──────────────────────────────────────────────
const PROMO_MSG =
`🙏 *नमस्ते दोस्तों!*

हमने आप सभी के लिए एक खास वेबसाइट बनाई है — जहाँ मिलेंगे सैकड़ों *WhatsApp OTP Groups* बिल्कुल *FREE!* 🎉

📲 ${SITE_URL}

✅ *अपना OTP Group यहाँ Share करें* — आपका Group हमारी Website पर आ जाएगा और हजारों लोग Join करेंगे!

🔥 OTP Groups का सबसे बड़ा Collection
💯 Free में Join करो — Enjoy करो! 😊

#OTP #WhatsApp #FreeOTPGroups`;

// ── WhatsApp client ──────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR, clientId: "main" }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage",
           "--disable-accelerated-2d-canvas","--no-first-run","--no-zygote","--disable-gpu"],
  },
});

client.on("qr", (qr) => { lastQr = qr; lastQrAt = Date.now(); ready = false; console.log("[bot] QR received."); });
client.on("authenticated", () => console.log("[bot] Authenticated."));
client.on("auth_failure", (m) => console.error("[bot] AUTH FAILURE:", m));
client.on("ready", () => {
  ready = true; lastReadyAt = Date.now(); lastQr = null;
  console.log("[bot] Ready.");
  // Give WhatsApp time to settle, then start tasks
  setTimeout(joinAndSyncGroups, 15000);
});
client.on("disconnected", (reason) => {
  ready = false; lastDisconnectReason = reason;
  console.warn("[bot] Disconnected:", reason);
  setTimeout(() => client.initialize().catch((e) => console.error("[bot] reinit failed:", e)), 5000);
});
client.initialize().catch((e) => console.error("[bot] initialize() failed:", e));

// ── DB ───────────────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── HTTP ─────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.disable("x-powered-by");

function authOk(req) {
  const h = req.headers.authorization || "";
  return h === `Bearer ${BOT_KEY}` || req.headers["x-bot-key"] === BOT_KEY || (req.query.key || "") === BOT_KEY;
}

app.get("/healthz", (_req, res) => res.json({
  ok: true, ready, hasQr: !!lastQr, lastReadyAt: lastReadyAt||null,
  lastQrAt: lastQrAt||null, lastDisconnectReason,
  uptimeSeconds: Math.round(process.uptime()),
  broadcast: { running: broadcastRunning, lastAt: lastBroadcastAt, lastSent: lastBroadcastSent, lastTotal: lastBroadcastTotal },
}));

app.get("/qr", async (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const wrap = (body) =>
    `<!doctype html><meta charset=utf8><meta http-equiv=refresh content=8>` +
    `<style>body{font-family:system-ui;background:#0b1020;color:#e2e8f0;display:flex;` +
    `align-items:center;justify-content:center;min-height:100vh;margin:0}` +
    `div{padding:28px 24px;background:#111c3a;border-radius:16px;text-align:center;max-width:420px}` +
    `h1{margin:0 0 6px;font-size:20px}p,li{color:#94a3b8;font-size:14px;line-height:1.5}` +
    `img{display:block;margin:14px auto;border-radius:12px;background:#fff;padding:10px}</style>` + body;

  if (ready) return res.end(wrap(`<div><h1 style=color:#22c55e>Bot logged in ✓</h1><p>Last ready: ${new Date(lastReadyAt).toISOString()}</p></div>`));
  if (!lastQr) return res.end(wrap(`<div><h1>Waiting for QR…</h1><p>WhatsApp Web is starting (20–60s). Page refreshes automatically.</p></div>`));
  const dataUrl = await QRCode.toDataURL(lastQr, { margin: 1, width: 320 });
  res.end(wrap(
    `<div><h1 style=color:#22c55e>Scan to log in</h1><img src="${dataUrl}" alt="QR">` +
    `<ol style=text-align:left;padding-left:18px>` +
    `<li>Open WhatsApp → Settings → Linked Devices</li>` +
    `<li>Tap "Link a Device" and scan this QR</li></ol></div>`
  ));
});

const VALID_CODE_RE = /^[A-Za-z0-9]{10,}$/;
app.get("/preview/:code", async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!ready) return res.status(503).json({ ok: false, error: "bot not ready", retryAfterMs: 5000 });
  const code = String(req.params.code || "").trim();
  if (!VALID_CODE_RE.test(code)) return res.status(400).json({ ok: false, error: "invalid invite code" });
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
      } catch (_) { pictureUrl = info.pictureUrl || null; }
    }
    return res.json({ ok: true, name: info.subject||null, imageUrl: pictureUrl||info.pictureUrl||null,
      size: typeof info.size==="number" ? info.size : (info.participants?.length??null), groupId });
  } catch (err) {
    const msg = err?.message || String(err);
    const lower = msg.toLowerCase();
    return res.json({ ok: false, error: msg,
      revoked: lower.includes("revoked")||lower.includes("not-found")||lower.includes("invalid")||lower.includes("not found") });
  }
});

app.get("/broadcast/status", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  res.json({ ok: true, running: broadcastRunning, lastAt: lastBroadcastAt, lastSent: lastBroadcastSent, lastTotal: lastBroadcastTotal, message: PROMO_MSG });
});

app.post("/broadcast", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!ready) return res.status(503).json({ ok: false, error: "bot not ready" });
  if (broadcastRunning) return res.status(409).json({ ok: false, error: "Broadcast already running" });
  res.json({ ok: true, message: "Broadcast started in background" });
  broadcastToAllGroups().catch((e) => console.error("[broadcast] error:", e));
});

app.get("/", (_req, res) => res.json({ service: "whatsapp-otp-group-bot", ready,
  routes: ["/healthz", "/qr", "/preview/:code (auth)", "POST /broadcast (auth)", "GET /broadcast/status (auth)"] }));

app.listen(PORT, "0.0.0.0", () => console.log(`[bot] HTTP listening on :${PORT}`));

// ── CORE: Join groups + sync metadata + detect reset groups ──────────────────

async function joinAndSyncGroups() {
  if (!ready) return;
  console.log("[sync] Starting group sync...");
  let db;
  try {
    db = await pool.connect();
    // Get all approved groups from DB
    const { rows: groups } = await db.query(
      `SELECT id, link, name, image_url FROM groups WHERE status = 'approved' ORDER BY id`
    );
    console.log(`[sync] ${groups.length} approved groups to process`);

    // Get all chats we're currently in
    let joinedMap = {};
    try {
      const chats = await client.getChats();
      for (const c of chats) { if (c.isGroup) joinedMap[c.id._serialized] = c; }
    } catch (e) { console.error("[sync] getChats failed:", e.message); }

    for (const g of groups) {
      try {
        const code = g.link.split("/").pop();
        let chatId = null, groupName = g.name, imageUrl = g.image_url;

        // Step 1: get invite info (fast, no join)
        try {
          const info = await Promise.race([
            client.getInviteInfo(code),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 12000)),
          ]);
          chatId = info.id?._serialized || null;
          if (!groupName && info.subject) groupName = info.subject;
          if (!imageUrl && info.pictureUrl) imageUrl = info.pictureUrl;
        } catch (e) {
          console.log(`[sync] getInviteInfo failed for ${g.id}: ${e.message} — marking review`);
          // Link is broken/revoked — send to review
          await db.query(
            `UPDATE groups SET status='review', removed_reason=$1 WHERE id=$2 AND status='approved'`,
            [`Invite link kaam nahi kar raha (revoked ya invalid): ${e.message}`, g.id]
          );
          await sleep(2000);
          continue;
        }

        // Step 2: join the group if not already a member
        let chat = chatId ? joinedMap[chatId] : null;
        if (!chat) {
          try {
            console.log(`[sync] Joining group ${g.id}...`);
            const joinedId = await Promise.race([
              client.acceptInvite(code),
              new Promise((_, rej) => setTimeout(() => rej(new Error("join timeout")), 25000)),
            ]);
            await sleep(3000);
            if (joinedId) {
              chat = await client.getChatById(joinedId).catch(() => null);
              if (chat) {
                joinedMap[chat.id._serialized] = chat;
                chatId = chat.id._serialized;
                if (!groupName && chat.name) groupName = chat.name;
              }
            }
          } catch (e) {
            console.log(`[sync] Join failed for ${g.id}: ${e.message}`);
          }
        }

        // Step 3: detect reset / admin-only groups
        if (chat) {
          // isReadOnly = true means messages can only be sent by admins
          if (chat.isReadOnly) {
            console.log(`[sync] Group ${g.id} is admin-only (read-only) — sending to review`);
            await db.query(
              `UPDATE groups SET status='review', removed_reason=$1 WHERE id=$2 AND status='approved'`,
              [`Group admin-only mode mein hai — sirf admin post kar sakte hain. Verify karke approve karo.`, g.id]
            );
            await sleep(2000);
            continue;
          }

          // Get fresh DP if missing
          if (!imageUrl && chatId) {
            try {
              imageUrl = await Promise.race([
                client.getProfilePicUrl(chatId),
                new Promise((_, rej) => setTimeout(() => rej(new Error("dp timeout")), 8000)),
              ]);
            } catch (_) {}
          }
        }

        // Step 4: update name/dp in DB if we got better info
        if (groupName !== g.name || imageUrl !== g.image_url) {
          await db.query(
            `UPDATE groups SET name=$1, image_url=$2, last_checked_at=NOW() WHERE id=$3`,
            [groupName || g.name, imageUrl || g.image_url, g.id]
          );
          if (groupName !== g.name) console.log(`[sync] Updated name for ${g.id}: ${groupName}`);
        }

        await sleep(3000); // 3s between each group
      } catch (e) {
        console.error(`[sync] Unexpected error for group ${g.id}:`, e.message);
      }
    }
    console.log("[sync] Group sync done.");
  } catch (e) {
    console.error("[sync] DB error:", e.message);
  } finally {
    if (db) db.release();
  }
}

// ── BROADCAST: post promo to all joined approved groups ───────────────────────

async function broadcastToAllGroups() {
  if (!ready) return;
  if (broadcastRunning) { console.log("[broadcast] Already running, skipping."); return; }
  broadcastRunning = true;
  console.log("[broadcast] Starting daily broadcast...");
  let db;
  try {
    db = await pool.connect();
    const { rows: groups } = await db.query(
      `SELECT id, link, name FROM groups WHERE status='approved' ORDER BY id`
    );
    lastBroadcastTotal = groups.length;
    console.log(`[broadcast] ${groups.length} approved groups.`);

    // Get current joined chats
    let joinedMap = {};
    try {
      const chats = await client.getChats();
      for (const c of chats) { if (c.isGroup) joinedMap[c.id._serialized] = c; }
    } catch (e) { console.error("[broadcast] getChats failed:", e.message); }

    let sent = 0;
    for (const g of groups) {
      try {
        const code = g.link.split("/").pop();
        let chatId = null;

        // Find chatId
        try {
          const info = await Promise.race([
            client.getInviteInfo(code),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 10000)),
          ]);
          chatId = info.id?._serialized || null;
        } catch (_) {}

        let chat = chatId ? joinedMap[chatId] : null;

        // Join if not member
        if (!chat && chatId) {
          try {
            const joinedId = await Promise.race([
              client.acceptInvite(code),
              new Promise((_, rej) => setTimeout(() => rej(new Error("join timeout")), 20000)),
            ]);
            await sleep(3000);
            if (joinedId) {
              chat = await client.getChatById(joinedId).catch(() => null);
              if (chat) joinedMap[chat.id._serialized] = chat;
            }
          } catch (e) { console.log(`[broadcast] Join failed for ${g.id}: ${e.message}`); }
        }

        if (chat) {
          if (chat.isReadOnly) {
            console.log(`[broadcast] Skipping admin-only group ${g.id}`);
          } else {
            await chat.sendMessage(PROMO_MSG);
            sent++;
            console.log(`[broadcast] ✓ Sent to ${g.id} (${g.name || chatId})`);
          }
        } else {
          console.log(`[broadcast] ✗ Not joined in group ${g.id}`);
        }
      } catch (e) {
        console.error(`[broadcast] Error for group ${g.id}:`, e.message);
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
    if (db) db.release();
    broadcastRunning = false;
  }
}

// ── SCHEDULERS ────────────────────────────────────────────────────────────────

// Sync groups every 30 minutes
setInterval(() => { if (ready) joinAndSyncGroups().catch((e) => console.error("[sync] interval error:", e)); }, 30 * 60 * 1000);

// Daily broadcast at 7:00 PM IST = 13:30 UTC
function scheduleDailyBroadcast() {
  const now = new Date();
  const target = new Date();
  target.setUTCHours(13, 30, 0, 0); // 7 PM IST
  if (target <= now) target.setDate(target.getDate() + 1);
  const delay = target - now;
  const mins = Math.round(delay / 60000);
  const hrs  = Math.floor(mins / 60);
  console.log(`[broadcast] Next daily broadcast in ${hrs}h ${mins % 60}m (7 PM IST)`);
  setTimeout(async () => {
    console.log("[broadcast] Scheduled broadcast starting...");
    await broadcastToAllGroups().catch((e) => console.error("[broadcast] scheduled error:", e));
    scheduleDailyBroadcast();
  }, delay);
}

setTimeout(scheduleDailyBroadcast, 5000);
