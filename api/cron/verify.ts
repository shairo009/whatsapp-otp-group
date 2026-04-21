import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "../_lib/db";
import { fetchGroupPreview } from "../_lib/whatsapp";

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
      `SELECT id, link FROM groups WHERE status = 'approved' ORDER BY id ASC LIMIT 200`
    );

    for (const row of result.rows) {
      const preview = await fetchGroupPreview(row.link);
      if (!preview.ok) {
        await client.query(
          "UPDATE groups SET status = 'removed', last_checked_at = NOW() WHERE id = $1",
          [row.id]
        );
        removed.push({ id: row.id, link: row.link, reason: preview.reason });
      } else {
        await client.query(
          `UPDATE groups SET name = COALESCE($2, name),
                              image_url = COALESCE($3, image_url),
                              last_checked_at = NOW()
           WHERE id = $1`,
          [row.id, preview.name, preview.imageUrl]
        );
        checked.push({ id: row.id, link: row.link });
      }
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
