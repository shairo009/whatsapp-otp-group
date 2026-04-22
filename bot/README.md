# whatsapp-otp-group-bot

A small Node.js service that runs `whatsapp-web.js` (a headless WhatsApp Web
client) and exposes a tiny HTTP API the main Vercel site calls to resolve
**group invite codes → real group name + display picture**.

This exists because WhatsApp removed group name/DP from the public invite
preview HTML, so server-side scraping (from Vercel, Microlink, anything) no
longer works. Only a logged-in WhatsApp client can read the data.

## What you need

1. A spare WhatsApp number (DO NOT use your main number — there's a small
   risk WhatsApp will ban automated clients).
2. A free hosting account that supports Docker + persistent volumes:
   - **Fly.io** (recommended, free tier with persistent volumes), OR
   - **Railway.app** ($5/mo, simplest UI), OR
   - any VPS / home server with Docker.

## Quick deploy on Fly.io (free tier)

```bash
# 1. Install flyctl: https://fly.io/docs/hands-on/install-flyctl/
# 2. From this `bot/` directory:
fly launch --no-deploy --name whatsapp-otp-group-bot
fly volumes create wwebjs_data --size 1 --region <pick a region>

# 3. Edit the generated fly.toml so the volume mounts at /app/.wwebjs_auth:
#    [mounts]
#      source      = "wwebjs_data"
#      destination = "/app/.wwebjs_auth"
#
#    And add the secret:
fly secrets set BOT_KEY="$(openssl rand -hex 24)"

# 4. Deploy.
fly deploy
fly open  # opens the bot's URL in your browser
```

## Quick deploy on Railway

1. Go to https://railway.app → **New Project** → **Deploy from GitHub repo**
   → pick `shairo009/whatsapp-otp-group`.
2. After import, open the service → **Settings** → set **Root Directory** to
   `/bot` and **Builder** to **Dockerfile**.
3. **Variables** → add `BOT_KEY` with a long random string (save it, you'll
   need it on Vercel later).
4. **Volumes** → New Volume → mount path `/app/.wwebjs_auth` (so the QR scan
   survives restarts).
5. **Settings** → **Networking** → **Generate Domain**. Note the URL.
6. Wait for the build to finish (~3 min, Chromium is heavy).

## First-time login (QR scan)

1. Open `<your bot URL>/qr` in a browser.
2. On the spare phone: **WhatsApp → Settings → Linked Devices → Link a Device**.
3. Scan the QR. The page auto-refreshes; after a few seconds it'll say
   "Bot is logged in".
4. Test it (replace BOT_URL and BOT_KEY):
   ```bash
   curl -H "Authorization: Bearer $BOT_KEY" "$BOT_URL/preview/L8tYoTo4kdI8bBiIxrgfDz"
   ```

## Wire it into the main site

On Vercel → your project → **Settings** → **Environment Variables**:

| Name        | Value                                       |
| ----------- | ------------------------------------------- |
| `BOT_URL`   | The bot's public URL (no trailing slash)    |
| `BOT_KEY`   | Same secret you set on the bot              |

Redeploy Vercel once. The next sync run will start using the bot to fetch
real group names and DPs.

## Endpoints

- `GET /healthz` — JSON status (no auth)
- `GET /qr`      — HTML page for the one-time QR scan (no auth)
- `GET /preview/:code` — `Authorization: Bearer <BOT_KEY>` required.
  Returns: `{ ok, name, imageUrl, size, groupId }`.

## Notes

- The session lives in `/app/.wwebjs_auth`. **Mount a persistent volume**
  there or you'll have to re-scan the QR after every restart.
- WhatsApp throttles `getInviteInfo` aggressively. The main site's sync cron
  already paces requests (~600ms between fetches, batches of 15 every 5 min)
  — keep it that way.
- If the bot starts returning errors like `getInviteInfo failed`, check
  `/healthz`. If `ready: false` for more than a minute, redeploy.
