import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "../_lib/db";
import { fetchGroupPreview } from "../_lib/whatsapp";

/**
 * Real-time link check fired when a user taps "Join group" on the site.
 *
 * Policy: a real, working link must NEVER be removed by a join-click.
 * Only the hourly cron (verify.ts) is allowed to enforce the 80%/20%
 * OTP/other-name ratio or mark links as broken/removed.
 *
 * The join handler only blocks on signals that are virtually impossible
 * to come from a healthy link:
 *   - Explicit "invite revoked / reset" text in WhatsApp's own page body
 *   - Page that returned no metadata at all
 *   - Group already marked removed/rejected in our DB
 * Anything ambiguous (generic preview, rate-limit, 5xx, name change) ->
 * just open the link and let WhatsApp itself decide.
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

    // HARD broken: explicit "invite revoked" text from WhatsApp itself, or
    // a page with no metadata at all. A real link CANNOT produce these
    // signals — they only appear on actually dead links. Safe to remove.
    const isHardBroken =
      !preview.ok && !preview.softBroken && !preview.rateLimited;
    if (isHardBroken) {
      await client.query(
        `UPDATE groups
           SET status = 'removed',
               broken_since = COALESCE(broken_since, NOW()),
               last_checked_at = NOW()
         WHERE id = $1`,
        [row.id]
      );
      return res.json({
        ok: false,
        removed: true,
        reason: preview.reason || "This invite link has been reset by the admin",
      });
    }

    // SOFT broken / rate-limited / 5xx — DO NOT touch the row at all.
    // Just open the link. If it's real, the user joins. If it's dead, the
    // hourly cron will catch it across multiple checks and remove it then.
    if (!preview.ok) {
      return res.json({
        ok: true,
        link: row.link,
        warning: preview.reason || "Could not fully verify the group right now",
      });
    }

    // Healthy preview — refresh metadata and clear broken flag.
    // NOTE: We intentionally do NOT enforce the OTP-name rule here.
    // The 80% OTP / 20% other-name ratio is enforced by the hourly cron
    // (verify.ts) via the review queue, not on every join click.
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
    // Network/DB errors must never kill the link. Return the link if we
    // already loaded it; otherwise surface a soft error.
    return res.status(500).json({
      ok: false,
      removed: false,
      error: err?.message || "Server error",
    });
  } finally {
    client.release();
  }
}
