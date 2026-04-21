# WhatsApp OTP Group

Free lifetime service website to discover & submit WhatsApp groups for sharing OTPs.
Live: https://whatsapp-otp-group.vercel.app

---

## ✨ Features

- 📋 Group directory with auto-fetched **group name** and **DP** from each WhatsApp invite link
- 🔍 Live **link preview** while submitting — verifies the link is valid and not reset
- 🚨 **Report button** (red) on every group card. Users can flag groups for:
  - Only admin can post
  - Messages turned off
  - Link reset / not working
  - Spam / irrelevant
  - Other
- 🛠 **Admin panel** at `/admin` to approve submissions, view reports, remove/delete groups
- ⏰ **Auto-verifier** runs every 5 days on Vercel Cron — re-checks every approved group and auto-removes dead/reset links

---

## 🚀 First-time setup (do this once)

### 1. Database — run `setup.sql` in Neon

Open Neon SQL editor and paste the contents of `setup.sql`.

If you already had an older `groups` table, also run these manually:

```sql
ALTER TYPE group_status ADD VALUE IF NOT EXISTS 'removed';
ALTER TABLE groups ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMP;
ALTER TABLE groups ADD CONSTRAINT groups_link_unique UNIQUE (link);
```

### 2. Vercel environment variables

Go to your Vercel project → **Settings → Environment Variables** and add:

| Variable | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Your Neon connection string | Already set |
| `ADMIN_KEY` | Any strong password (e.g. `MyAdmin@2026!`) | Used to log in to `/admin` |
| `CRON_SECRET` | (optional) | Vercel auto-generates this for crons |

### 3. Redeploy

After adding env vars, click **Redeploy** in Vercel (or just push another commit — auto-deploys).

---

## 🧑‍💻 Using it

### Public site (`/`)
- Visitors see all approved groups with name + DP
- Click **Join group** to open WhatsApp invite
- Click **Report — Admin only / Issue** if a group has problems
- Submit form at the top (live preview before submitting)

### Admin panel (`/admin`)
- Open `https://whatsapp-otp-group.vercel.app/admin`
- Enter your `ADMIN_KEY`
- Tabs:
  - **Pending** — approve or delete new submissions
  - **Reports** — view all user reports, remove reported groups
  - **Approved** — manage all live groups
  - **Removed** — see groups that were auto-removed by the cron
- **"Run verify now"** button manually triggers the 5-day verifier

### Cron schedule
Already wired in `vercel.json`:
```
"crons": [{ "path": "/api/cron/verify", "schedule": "0 3 */5 * *" }]
```
Runs at **03:00 UTC every 5 days**. Vercel handles auth via `CRON_SECRET`.

---

## ⚠️ What WhatsApp does NOT expose

WhatsApp's public invite link only shows: group name, DP, and validity. It does **NOT** expose:

- Whether only admins can post (announcement mode)
- Whether messages are turned off

These can only be checked by joining the group with an unofficial WhatsApp client (against ToS, risk of number ban). That's why **users report these issues** through the red button — and the admin reviews them.

---

## 🗂 Project structure

```
.
├── index.html              # Public site (vanilla JS, no build)
├── admin.html              # Admin panel
├── favicon.svg
├── setup.sql               # DB schema for Neon
├── vercel.json             # Routes + cron schedule
├── package.json
└── api/
    ├── _lib/
    │   ├── db.ts           # Postgres pool + admin auth helper
    │   └── whatsapp.ts     # Fetches group preview from invite link
    ├── groups/
    │   ├── index.ts        # GET /api/groups — public approved list
    │   ├── preview.ts      # GET /api/groups/preview?link=… — name+DP preview
    │   ├── submit.ts       # POST /api/groups/submit — verifies + saves
    │   └── report.ts       # POST /api/groups/report — user reports
    ├── admin/
    │   ├── groups.ts       # GET — all groups (auth)
    │   ├── reports.ts      # GET — all reports (auth)
    │   └── action.ts       # POST — approve/remove/delete/dismiss/clear
    └── cron/
        └── verify.ts       # 5-day auto-verifier
```

---

## 🛣 API routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/groups` | Public list of approved groups |
| GET | `/api/groups/preview?link=…` | Name + DP from a WhatsApp invite link |
| POST | `/api/groups/submit` | Submit a new group (auto-verified) |
| POST | `/api/groups/report` | Report a group |
| GET | `/api/admin/groups` | All groups (needs `X-Admin-Key`) |
| GET | `/api/admin/reports` | All reports (needs `X-Admin-Key`) |
| POST | `/api/admin/action` | `approve` / `remove` / `delete` / `dismiss-report` / `clear-reports` |
| GET | `/api/cron/verify` | Runs the 5-day auto-verifier |

---

Made with ❤ for the OTP-sharing community.
