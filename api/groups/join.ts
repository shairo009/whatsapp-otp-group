import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "../_lib/db";
import { fetchGroupPreview, nameContainsOTP } from "../_lib/whatsapp";

/**
 * Real-time link check fired when a user taps "Join group" on the site.
 *
 * - HARD broken (explicit revoke text, no metadata)  -> remove + block.
 * - SOFT broken (generic preview, no member count)   -> mark broken_since
 *                                                       but still let user
 *                                                       try the link. The
 *                                                       cron will remove it
 *                                                       only if it stays
 *                                                       soft-broken past the
 *                                                       grace window.
 * - Rate-limited / 5xx                               -> let user try.
 * - OK + not OTP (when name is known)                -> remove + block.
 * - OK                                               -> open link.
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

    // HARD broken: explicit invalid markers / no metadata at all. Remove.
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

    // SOFT broken: generic preview with no member count. WhatsApp does this
    // for some valid links during transient issues, so DON'T remove on the
    // first hit — just mark broken_since (cron will grace + remove later).
    // Still let the user try opening the link; if it really is dead, WhatsApp
    // will tell them. If it's alive, they join successfully.
    if (!preview.ok && preview.softBroken) {
      await client.query(
        `UPDATE groups
           SET broken_since = COALESCE(broken_since, NOW()),
               last_checked_at = NOW()
         WHERE id = $1`,
        [row.id]
      );
      return res.json({
        ok: true,
        link: row.link,
        warning: preview.reason || "Could not fully verify the group right now",
      });
    }

    // Transient (rate-limited / 5xx). Let the user try.
    if (!preview.ok && preview.rateLimited) {
      return res.json({
        ok: true,
        link: row.link,
        warning: preview.reason || "Could not verify right now",
      });
    }

    // Successful preview. Enforce OTP-only policy in real time as well.
    const effectiveName = preview.name ?? row.name;
    const knowName = !!effectiveName;
    const isOtp = nameContainsOTP(effectiveName);
    if (knowName && !isOtp) {
      await client.query(
        `UPDATE groups
           SET status = 'removed',
               last_checked_at = NOW()
         WHERE id = $1`,
        [row.id]
      );
      return res.json({
        ok: false,
        removed: true,
        reason: "This group is no longer an OTP group",
      });
    }

    // Healthy — refresh metadata and clear broken flag.
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
