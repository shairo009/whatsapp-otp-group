# WhatsApp OTP Group

Free lifetime service website where users discover & submit WhatsApp groups for sharing OTPs.

## Features

- Group directory with auto-fetched **name** and **DP** from each WhatsApp invite link
- Live **link preview** while submitting (verifies link is valid & not reset)
- **Report** button on every group card (red, "Admin only / Issue") — users can flag groups where only admins can post, messages are off, link reset, etc.
- **Admin panel** at `/admin` to approve submissions, view reports, remove/delete groups
- **Auto-verifier cron** runs every 5 days on Vercel: re-checks every approved group and auto-removes dead/reset links

## Setup

### 1. Database (Neon Postgres)

Run `setup.sql` in your Neon SQL editor.

If you already have an older `groups` table, also run the `ALTER TABLE ...` lines noted in the file.

### 2. Vercel environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon Postgres connection string |
| `ADMIN_KEY` | Secret password used to access `/admin` and trigger manual verify |
| `CRON_SECRET` | (optional) If set, the scheduled cron must include `Authorization: Bearer <CRON_SECRET>`. Vercel passes this automatically. |

### 3. Cron

Already wired in `vercel.json`:

```
"crons": [{ "path": "/api/cron/verify", "schedule": "0 3 */5 * *" }]
```

Runs at 03:00 UTC every 5 days. You can also trigger it manually from `/admin` ("Run verify now").

## Limitations

WhatsApp's public invite link only exposes group name, DP, and validity. It does **not** expose:

- Whether only admins can post (announcement mode)
- Whether messages are turned off

These can only be verified by joining the group with an unofficial WhatsApp client (against ToS). That's why the **report button** lets users flag those issues for admin review.

## Routes

| Path | Description |
| --- | --- |
| `/` | Public group directory + submit form |
| `/admin` | Admin panel (requires `ADMIN_KEY`) |
| `GET /api/groups` | Public list of approved groups |
| `POST /api/groups/submit` | Submit a new group (auto-verifies link) |
| `GET /api/groups/preview?link=...` | Fetch name + DP for a link |
| `POST /api/groups/report` | Submit a report on a group |
| `GET /api/admin/groups` | All groups (admin) |
| `GET /api/admin/reports` | All reports (admin) |
| `POST /api/admin/action` | Admin actions: approve / remove / delete / dismiss-report / clear-reports |
| `GET /api/cron/verify` | 5-day verifier (cron) |
