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
  try {
    const result = await client.query(
      `SELECT id, link, name FROM groups
       WHERE status IN ('approved','pending')
       ORDER BY id ASC LIMIT 200`
    );

    for (const row of result.rows) {
      const preview = await fetchGroupPreview(row.link);
      if (!preview.ok && !preview.rateLimited) {
        await client.query(
          "UPDATE groups SET status = 'removed', last_checked_at = NOW() WHERE id = $1",
          [row.id]
        );
        removed.push({ id: row.id, link: row.link, reason: preview.reason });
        continue;
      }

      const effectiveName = preview.name ?? row.name;
      // Enforce OTP-only policy. If we have a name and it doesn't contain OTP,
      // remove. If the name is still null after a successful (non-rate-limited)
      // fetch, also remove — we can't confirm it's an OTP group.
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

      await client.query(
        `UPDATE groups SET name = COALESCE($2, name),
                            image_url = COALESCE($3, image_url),
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
      removedDetails: removed,
    });
  } finally {
    client.release();
  }
}
