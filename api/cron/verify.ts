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

    const result = await client.query(
      `SELECT id, link, name, broken_since FROM groups
       WHERE status IN ('approved','pending')
       ORDER BY id ASC LIMIT 200`
    );

    for (const row of result.rows) {
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
