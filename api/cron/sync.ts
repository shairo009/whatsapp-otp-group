import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "../_lib/db";
import { fetchGroupPreview } from "../_lib/whatsapp";

// Dedicated metadata sync.
//
// Unlike /api/cron/verify, this endpoint NEVER removes groups and NEVER
// changes status. It only refreshes the display name and image_url for
// approved/pending groups so the listing stays in sync with the latest
// WhatsApp group DP and title. Removal logic stays in /api/cron/verify.
//
// Selection picks the rows whose metadata is the most stale (oldest
// last_synced_at first, NULLs first) so a small batch run repeatedly will
// eventually cover every group, then start the cycle again.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";
  const isVercelCron = !!cronSecret && auth === `Bearer ${cronSecret}`;
  const adminKey = process.env.ADMIN_KEY;
  const isManual =
    !!adminKey &&
    ((req.query.key as string) === adminKey ||
      req.headers["x-admin-key"] === adminKey);

  if (!isVercelCron && !isManual) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const client = await getPool().connect();
  const updated: any[] = [];
  const unchanged: any[] = [];
  const skipped: any[] = [];
  try {
    // Idempotent migration: track when we last synced metadata so we can
    // round-robin over every group instead of re-checking the same hot rows.
    await client.query(
      "ALTER TABLE groups ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP"
    );

    const limitRaw = parseInt(String(req.query.limit ?? "25"), 10);
    const delayRaw = parseInt(String(req.query.delay ?? "800"), 10);
    const limit = Math.min(
      100,
      Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 25)
    );
    const delayMs = Math.min(
      5000,
      Math.max(0, Number.isFinite(delayRaw) ? delayRaw : 800)
    );

    const result = await client.query(
      `SELECT id, link, name, image_url, last_synced_at
         FROM groups
        WHERE status IN ('approved','pending')
        ORDER BY last_synced_at ASC NULLS FIRST, id ASC
        LIMIT $1`,
      [limit]
    );

    const sleep = (ms: number) =>
      ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();

    let first = true;
    for (const row of result.rows) {
      if (!first) {
        const jitter = Math.floor(Math.random() * 400);
        await sleep(delayMs + jitter);
      }
      first = false;

      const preview = await fetchGroupPreview(row.link);

      // Anything that is not a clean "ok" preview is left alone here.
      // verify.ts owns the broken/removed lifecycle. We just bump
      // last_synced_at so we move on and don't get stuck on the same row
      // every run.
      if (!preview.ok) {
        await client.query(
          "UPDATE groups SET last_synced_at = NOW() WHERE id = $1",
          [row.id]
        );
        skipped.push({
          id: row.id,
          link: row.link,
          reason: preview.reason || "preview not ok",
        });
        continue;
      }

      const newName = preview.name ?? row.name;
      const newImage = preview.imageUrl ?? row.image_url;
      const nameChanged = preview.name && preview.name !== row.name;
      const imageChanged = preview.imageUrl && preview.imageUrl !== row.image_url;

      // Always overwrite when WhatsApp returned a value — that's the whole
      // point of the sync. COALESCE guards against accidentally wiping a
      // previously known value when the latest fetch came back empty.
      await client.query(
        `UPDATE groups
            SET name = COALESCE($2, name),
                image_url = COALESCE($3, image_url),
                last_synced_at = NOW(),
                last_checked_at = NOW()
          WHERE id = $1`,
        [row.id, preview.name, preview.imageUrl]
      );

      if (nameChanged || imageChanged) {
        updated.push({
          id: row.id,
          link: row.link,
          nameChanged: !!nameChanged,
          imageChanged: !!imageChanged,
          oldName: row.name,
          newName,
          oldImage: row.image_url,
          newImage,
        });
      } else {
        unchanged.push({ id: row.id, link: row.link });
      }
    }

    return res.json({
      ok: true,
      scanned: result.rows.length,
      updated: updated.length,
      unchanged: unchanged.length,
      skipped: skipped.length,
      updatedDetails: updated,
      skippedDetails: skipped,
    });
  } finally {
    client.release();
  }
}
