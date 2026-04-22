import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "../_lib/db";
import { fetchGroupPreview } from "../_lib/whatsapp";

/**
 * Real-time link check fired when a user taps "Join group" on the site.
 *
 * Policy: NO group is ever removed by the join handler — not even broken
 * or revoked links. All suspicious groups are sent to the review queue so
 * an admin can decide. The hourly cron (verify.ts) also only sends to
 * review, never removes directly.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Method not allowed" });

  const groupId = Number(
    (req.body && (req.body.groupId ?? req.body.id)) ?? NaN
  );
  if (!Number.isFinite(groupId) || groupId <= 0) {
    return res.status(400).json({ ok: false, error: "groupId is required" });
  }

  const client = await getPool().connect();
  try {
    const r = await client.query(
      "SELECT id, link, name, status FROM groups WHERE id = $1 LIMIT 1",
      [groupId]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ ok: false, removed: true, reason: "Group not found" });
    }
    const row = r.rows[0];

    if (row.status === "removed" || row.status === "rejected") {
      return res.json({
        ok: false,
        removed: true,
        reason: "This group is no longer available",
      });
    }

    const preview = await fetchGroupPreview(row.link);

    // HARD broken: explicit "invite revoked / reset" signal from WhatsApp.
    // Send to review — an admin will verify and decide. Never auto-remove.
    const isHardBroken =
      !preview.ok && !preview.softBroken && !preview.rateLimited;
    if (isHardBroken) {
      await client.query(
        `UPDATE groups
           SET status = 'review',
               broken_since = COALESCE(broken_since, NOW()),
               removed_reason = $2,
               last_checked_at = NOW()
         WHERE id = $1`,
        [
          row.id,
          `Sent to review on join: ${preview.reason || "invite link appears reset or revoked"}. Admin will verify.`,
        ]
      );
      return res.json({
        ok: false,
        removed: false,
        inReview: true,
        reason: "This group's link may have been reset. It has been sent for admin review.",
      });
    }

    // SOFT broken / rate-limited / 5xx — DO NOT touch the row at all.
    // Just open the link. If it's real, the user joins.
    if (!preview.ok) {
      return res.json({
        ok: true,
        link: row.link,
        warning: preview.reason || "Could not fully verify the group right now",
      });
    }

    // Healthy preview — refresh metadata and clear broken flag.
    await client.query(
      `UPDATE groups
         SET name = COALESCE($2, name),
             image_url = COALESCE($3, image_url),
             broken_since = NULL,
             last_checked_at = NOW()
       WHERE id = $1`,
      [row.id, preview.name, preview.imageUrl]
    );

    return res.json({ ok: true, link: row.link });
  } catch (err: any) {
    return res.status(500).json({
      ok: false,
      removed: false,
      error: err?.message || "Server error",
    });
  } finally {
    client.release();
  }
}
