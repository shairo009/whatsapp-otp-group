// WhatsApp group-preview bot.
//
// Runs whatsapp-web.js (Puppeteer + WhatsApp Web) and exposes a tiny HTTP
// API the main Vercel site can call to resolve a group invite code into
// the real group name + display picture.
//
// Endpoints:
//   GET /healthz                        -> liveness probe
//   GET /qr                             -> first-time QR setup page (HTML)
//   GET /preview/:code   (Bearer auth)  -> { ok, name, imageUrl, size }
//
// Required env vars:
//   BOT_KEY        Secret string the main site sends as Bearer token.
//   PORT           Optional, defaults to 3000.
//   SESSION_DIR    Optional, defaults to ./.wwebjs_auth (mount a volume here
//                  on Fly.io / Railway so the WhatsApp session survives
//                  restarts and you don't have to re-scan the QR every time).

const express = require("express");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const { Client, LocalAuth } = require("whatsapp-web.js");

const PORT = parseInt(process.env.PORT || "3000", 10);
const BOT_KEY = process.env.BOT_KEY || "";
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, ".wwebjs_auth");

if (!BOT_KEY) {
  console.error("FATAL: BOT_KEY env var is required.");
  process.exit(1);
}

try {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
} catch (e) {}

let lastQr = null;
let lastQrAt = 0;
let ready = false;
let lastReadyAt = 0;
let lastDisconnectReason = null;

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

client.on("authenticated", () => {
  console.log("[bot] Authenticated.");
});

client.on("auth_failure", (m) => {
  console.error("[bot] AUTH FAILURE:", m);
});

client.on("ready", () => {
  ready = true;
  lastReadyAt = Date.now();
  lastQr = null;
  console.log("[bot] Ready — accepting preview requests.");
});

client.on("disconnected", (reason) => {
  ready = false;
  lastDisconnectReason = reason;
  console.warn("[bot] Disconnected:", reason);
  // Try to come back up. WhatsApp Web reconnect is finicky; often the only
  // way is to re-init.
  setTimeout(() => {
    client.initialize().catch((e) => console.error("[bot] reinit failed:", e));
  }, 5000);
});

client.initialize().catch((e) => {
  console.error("[bot] initialize() failed:", e);
});

const app = express();
app.disable("x-powered-by");

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    ready,
    hasQr: !!lastQr,
    lastReadyAt: lastReadyAt || null,
    lastQrAt: lastQrAt || null,
    lastDisconnectReason,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// One-time setup page. Open this in a browser, scan the QR with the WhatsApp
// app on the phone you want the bot to log in as. Page auto-refreshes.
app.get("/qr", async (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (ready) {
    return res.end(
      `<!doctype html><meta charset=utf8><meta http-equiv=refresh content=10>` +
      `<style>body{font-family:system-ui;background:#0b1020;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center}div{padding:32px 28px;background:#111c3a;border-radius:16px;max-width:420px}h1{margin:0 0 8px;font-size:22px;color:#22c55e}p{margin:6px 0;color:#94a3b8;font-size:14px}</style>` +
      `<div><h1>Bot is logged in</h1><p>Last ready: ${new Date(lastReadyAt).toISOString()}</p><p>Page refreshes every 10s.</p></div>`
    );
  }
  if (!lastQr) {
    return res.end(
      `<!doctype html><meta charset=utf8><meta http-equiv=refresh content=3>` +
      `<style>body{font-family:system-ui;background:#0b1020;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}div{padding:32px;background:#111c3a;border-radius:16px;text-align:center;max-width:420px}h1{margin:0 0 8px;font-size:20px}p{margin:6px 0;color:#94a3b8;font-size:14px}</style>` +
      `<div><h1>Waiting for QR…</h1><p>The WhatsApp Web client is starting. This can take 20–60 seconds on first boot.</p><p>This page auto-refreshes.</p></div>`
    );
  }
  const dataUrl = await QRCode.toDataURL(lastQr, { margin: 1, width: 320 });
  res.end(
    `<!doctype html><meta charset=utf8><meta http-equiv=refresh content=8>` +
    `<style>body{font-family:system-ui;background:#0b1020;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}div{padding:28px 24px;background:#111c3a;border-radius:16px;text-align:center;max-width:420px}img{display:block;margin:14px auto;border-radius:12px;background:#fff;padding:10px}h1{margin:0 0 6px;font-size:20px;color:#22c55e}p{margin:6px 0;color:#94a3b8;font-size:14px;line-height:1.5}ol{text-align:left;color:#cbd5e1;font-size:13px;padding-left:18px}</style>` +
    `<div><h1>Scan to log in</h1><img src="${dataUrl}" alt="QR"><ol><li>Open WhatsApp on your phone</li><li>Settings → Linked Devices → Link a Device</li><li>Scan this QR. Page refreshes every 8s.</li></ol></div>`
  );
});

function authOk(req) {
  const h = req.headers.authorization || "";
  if (h === `Bearer ${BOT_KEY}`) return true;
  if (req.headers["x-bot-key"] === BOT_KEY) return true;
  if ((req.query.key || "") === BOT_KEY) return true;
  return false;
}

const VALID_CODE_RE = /^[A-Za-z0-9]{10,}$/;

// Resolve invite code → group metadata WITHOUT joining the group.
// `client.getInviteInfo(code)` returns the same payload WhatsApp shows in
// the join-prompt: subject (group name), id, pictureUrl, size, etc.
app.get("/preview/:code", async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!ready) return res.status(503).json({ ok: false, error: "bot not ready", retryAfterMs: 5000 });
  const code = String(req.params.code || "").trim();
  if (!VALID_CODE_RE.test(code))
    return res.status(400).json({ ok: false, error: "invalid invite code" });
  try {
    // Race a hard timeout so a slow WhatsApp reply doesn't hold the
    // connection forever.
    const info = await Promise.race([
      client.getInviteInfo(code),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000)),
    ]);
    if (!info) return res.json({ ok: false, error: "no info returned" });

    const groupId = info.id?._serialized || info.id || null;
    let pictureUrl = null;
    if (groupId) {
      try {
        // getProfilePicUrl is the canonical way to grab a fresh DP URL.
        // WhatsApp's CDN URLs expire after a few hours, so the main site
        // re-fetches periodically anyway.
        pictureUrl = await Promise.race([
          client.getProfilePicUrl(groupId),
          new Promise((_, rej) => setTimeout(() => rej(new Error("dp timeout")), 8000)),
        ]);
      } catch (e) {
        // Fall back to the picture URL embedded in invite info, if any.
        pictureUrl = info.pictureUrl || null;
      }
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
    // Common: "group-not-found", "invite-link-revoked", etc.
    const lower = msg.toLowerCase();
    const revoked =
      lower.includes("revoked") ||
      lower.includes("not-found") ||
      lower.includes("invalid") ||
      lower.includes("not found");
    return res.json({
      ok: false,
      error: msg,
      revoked,
    });
  }
});

app.get("/", (_req, res) => {
  res.json({
    service: "whatsapp-otp-group-bot",
    ready,
    routes: ["/healthz", "/qr", "/preview/:code (auth)"],
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[bot] HTTP listening on :${PORT}`);
});
