import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "../_lib/db";
import { fetchGroupPreview, nameContainsOTP } from "../_lib/whatsapp";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";
  const isVercelCron =
    !!cronSecret && auth === `Bearer ${cronSecret}`;
  const adminKey = process.env.ADMIN_KEY;
  const isManual =
    !!adminKey &&
    ((req.query.key as string) === adminKey ||
      req.headers["x-admin-key"] === adminKey);

  if (!isVercelCron && !isManual) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const client = await getPool().connect();
  const checked: any[] = [];
  const removed: any[] = [];
  const skipped: any[] = [];
  try {
    // Ensure broken_since column exists (idempotent migration)
    await client.query(
      "ALTER TABLE groups ADD COLUMN IF NOT EXISTS broken_since TIMESTAMP"
    );

    // Tunable via query params so an external scheduler can throttle.
    // Defaults are conservative to avoid WhatsApp blocking us.
    const limitRaw = parseInt(String(req.query.limit ?? "25"), 10);
    const delayRaw = parseInt(String(req.query.delay ?? "800"), 10);
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 25));
    const delayMs = Math.min(5000, Math.max(0, Number.isFinite(delayRaw) ? delayRaw : 800));

    const result = await client.query(
      `SELECT id, link, name, broken_since FROM groups
       WHERE status IN ('approved','pending')
       ORDER BY last_checked_at ASC NULLS FIRST, id ASC
       LIMIT $1`,
      [limit]
    );

    const sleep = (ms: number) =>
      ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();

    let first = true;
    for (const row of result.rows) {
      // Spread requests to chat.whatsapp.com so we don't get blocked.
      // Add a small jitter on top of the base delay.
      if (!first) {
        const jitter = Math.floor(Math.random() * 400);
        await sleep(delayMs + jitter);
      }
      first = false;

      const preview = await fetchGroupPreview(row.link);

      // Transient failure (rate-limit / 5xx). Don't punish the group; try
      // again on the next hourly run.
      if (!preview.ok && preview.rateLimited) {
        await client.query(
          "UPDATE groups SET last_checked_at = NOW() WHERE id = $1",
          [row.id]
        );
        skipped.push({ id: row.id, link: row.link, reason: preview.reason });
        continue;
      }

      // Hard-broken (link reset / revoked / invalid). Remove immediately —
      // this cron runs every hour, so dead links shouldn't linger.
      if (!preview.ok) {
        await client.query(
          `UPDATE groups
             SET status = 'removed',
                 broken_since = COALESCE(broken_since, NOW()),
                 last_checked_at = NOW()
           WHERE id = $1`,
          [row.id]
        );
        removed.push({
          id: row.id,
          link: row.link,
          reason: preview.reason || "Link reset or revoked",
        });
        continue;
      }

      const effectiveName = preview.name ?? row.name;
      // Enforce OTP-only policy. If we have a name and it doesn't contain OTP,
      // remove immediately. If the name is still null after a successful
      // (non-rate-limited) fetch, also remove — we can't confirm it's OTP.
      const knowName = !!effectiveName;
      const isOtp = nameContainsOTP(effectiveName);
      if ((knowName && !isOtp) || (!knowName && !preview.rateLimited)) {
        await client.query(
          "UPDATE groups SET status = 'removed', last_checked_at = NOW() WHERE id = $1",
          [row.id]
        );
        removed.push({
          id: row.id,
          link: row.link,
          reason: knowName ? "Not an OTP group" : "Could not verify group name",
        });
        continue;
      }

      // Healthy — clear broken_since if set, refresh metadata.
      await client.query(
        `UPDATE groups SET name = COALESCE($2, name),
                            image_url = COALESCE($3, image_url),
                            broken_since = NULL,
                            last_checked_at = NOW()
         WHERE id = $1`,
        [row.id, preview.name, preview.imageUrl]
      );
      checked.push({ id: row.id, link: row.link });
    }
    return res.json({
      ok: true,
      checked: checked.length,
      removed: removed.length,
      skipped: skipped.length,
      removedDetails: removed,
      skippedDetails: skipped,
    });
  } finally {
    client.release();
  }
}
