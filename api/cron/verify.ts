import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "../_lib/db";
import { fetchGroupPreview, nameContainsOTP } from "../_lib/whatsapp";

// Hours a link can stay "soft broken" before we send it to review.
const SOFT_BROKEN_GRACE_HOURS = 24;

// 80% of approved slots are reserved for OTP groups.
// Up to 20% may be non-OTP (other-name) groups.
const OTHER_NAME_MAX_RATIO = 0.20;

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
  const softBroken: any[] = [];
  const recovered: any[] = [];
  const skipped: any[] = [];
  const sentToReview: any[] = [];

  try {
    // Ensure required columns exist (idempotent migrations)
    await client.query(
      "ALTER TABLE groups ADD COLUMN IF NOT EXISTS broken_since TIMESTAMP"
    );
    await client.query(
      "ALTER TABLE groups ADD COLUMN IF NOT EXISTS removed_reason TEXT"
    );
    await client.query(
      "ALTER TABLE groups ADD COLUMN IF NOT EXISTS removed_at TIMESTAMP"
    );

    // --- RATIO ENFORCEMENT ---
    // Enforce the 80%/20% OTP/other-name ratio on approved groups.
    // If other-name groups exceed 20% of total approved, move the excess
    // (least recently checked first) to review.
    const ratioResult = await client.query(
      `SELECT id, name, last_checked_at FROM groups
       WHERE status = 'approved' AND name IS NOT NULL
       ORDER BY last_checked_at ASC NULLS FIRST`
    );
    const allApproved = ratioResult.rows;
    const totalApproved = allApproved.length;
    const otherApproved = allApproved.filter(
      (r: { name: string }) => !nameContainsOTP(r.name)
    );
    const allowedOther = Math.floor(totalApproved * OTHER_NAME_MAX_RATIO);
    const excessOther = otherApproved.length - allowedOther;

    if (excessOther > 0) {
      const toReview = otherApproved.slice(0, excessOther);
      for (const row of toReview) {
        await client.query(
          `UPDATE groups
             SET status = 'review',
                 removed_reason = $2,
                 last_checked_at = NOW()
           WHERE id = $1`,
          [
            row.id,
            `Moved to review: the 20% other-name allowance is full. ` +
              `Policy: 80% OTP groups / 20% other-name groups. ` +
              `This group will be reinstated when a slot opens.`,
          ]
        );
        sentToReview.push({
          id: row.id,
          name: row.name,
          reason: "Exceeded 20% other-name ratio",
        });
      }
    }

    // Tunable via query params
    const limitRaw = parseInt(String(req.query.limit ?? "25"), 10);
    const delayRaw = parseInt(String(req.query.delay ?? "800"), 10);
    const graceRaw = parseInt(
      String(req.query.graceHours ?? SOFT_BROKEN_GRACE_HOURS),
      10
    );
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 25));
    const delayMs = Math.min(5000, Math.max(0, Number.isFinite(delayRaw) ? delayRaw : 800));
    const graceHours = Math.min(
      168,
      Math.max(1, Number.isFinite(graceRaw) ? graceRaw : SOFT_BROKEN_GRACE_HOURS)
    );

    const result = await client.query(
      `SELECT id, link, name, broken_since FROM groups
       WHERE status IN ('approved','pending')
       ORDER BY (name IS NULL) DESC, last_checked_at ASC NULLS FIRST, id ASC
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

      // Transient failure (rate-limit / 5xx). Don't punish the group.
      if (!preview.ok && preview.rateLimited) {
        await client.query(
          "UPDATE groups SET last_checked_at = NOW() WHERE id = $1",
          [row.id]
        );
        skipped.push({ id: row.id, link: row.link, reason: preview.reason });
        continue;
      }

      // HARD broken — WhatsApp returned explicit "link reset / revoked".
      // Send to review so admin can verify. Never auto-remove.
      const isHardBroken =
        !preview.ok &&
        !preview.softBroken &&
        !preview.rateLimited &&
        preview.reason === "Link reset or revoked";
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
            `Sent to review: ${preview.reason || "link appears reset or revoked"}. Admin will verify before any action.`,
          ]
        );
        sentToReview.push({
          id: row.id,
          link: row.link,
          reason: preview.reason || "Hard broken — link reset or revoked",
        });
        continue;
      }

      // Any other non-ok, non-softBroken, non-rateLimited result.
      // Give it a grace window; after grace send to review (not remove).
      if (!preview.ok && !preview.softBroken && !preview.rateLimited) {
        const brokenSince: Date | null = row.broken_since
          ? new Date(row.broken_since)
          : null;
        const ageHours = brokenSince
          ? (Date.now() - brokenSince.getTime()) / 3_600_000
          : 0;
        if (brokenSince && ageHours >= graceHours) {
          // Grace period expired — send to review for admin decision.
          await client.query(
            `UPDATE groups
               SET status = 'review',
                   removed_reason = $2,
                   last_checked_at = NOW()
             WHERE id = $1`,
            [
              row.id,
              `Sent to review: unreachable for ${Math.round(ageHours)}h — ${preview.reason || "fetch failed"}. Admin will verify.`,
            ]
          );
          sentToReview.push({
            id: row.id,
            link: row.link,
            reason: `Unreachable for ${Math.round(ageHours)}h`,
          });
        } else {
          await client.query(
            `UPDATE groups
               SET broken_since = COALESCE(broken_since, NOW()),
                   last_checked_at = NOW()
             WHERE id = $1`,
            [row.id]
          );
          softBroken.push({
            id: row.id,
            link: row.link,
            reason: preview.reason,
            ageHours: Math.round(ageHours * 10) / 10,
          });
        }
        continue;
      }

      // SOFT broken (generic title, no member count).
      // Grace window before sending to review.
      if (!preview.ok && preview.softBroken) {
        const brokenSince: Date | null = row.broken_since
          ? new Date(row.broken_since)
          : null;
        const ageHours = brokenSince
          ? (Date.now() - brokenSince.getTime()) / 3_600_000
          : 0;

        if (brokenSince && ageHours >= graceHours) {
          await client.query(
            `UPDATE groups
               SET status = 'review',
                   removed_reason = $2,
                   last_checked_at = NOW()
             WHERE id = $1`,
            [
              row.id,
              `Sent to review: soft-broken for ${Math.round(ageHours)}h — ${preview.reason}. Admin will verify.`,
            ]
          );
          sentToReview.push({
            id: row.id,
            link: row.link,
            reason: `Soft-broken for ${Math.round(ageHours)}h`,
          });
        } else {
          await client.query(
            `UPDATE groups
               SET broken_since = COALESCE(broken_since, NOW()),
                   last_checked_at = NOW()
             WHERE id = $1`,
            [row.id]
          );
          softBroken.push({
            id: row.id,
            link: row.link,
            reason: preview.reason,
            ageHours: Math.round(ageHours * 10) / 10,
          });
        }
        continue;
      }

      // preview.ok === true from here.
      const effectiveName = preview.name ?? row.name;
      const knowName = !!effectiveName;
      const isOtp = nameContainsOTP(effectiveName);

      // Non-OTP group with confirmed healthy link → send to review.
      // Policy: 80% OTP / 20% other-name. Admin decides whether to keep.
      if (knowName && preview.hasMembers && !isOtp) {
        await client.query(
          `UPDATE groups
             SET status = 'review',
                 removed_reason = $2,
                 last_checked_at = NOW()
           WHERE id = $1`,
          [
            row.id,
            `Sent to review: group name "${effectiveName}" does not contain 'OTP'. ` +
              `Policy: 80% OTP / 20% other-name groups. Admin will review.`,
          ]
        );
        sentToReview.push({
          id: row.id,
          link: row.link,
          name: effectiveName,
          reason: "Non-OTP name — sent to review under 20% other-name policy",
        });
        continue;
      }

      // Healthy OTP group — clear broken_since, refresh metadata.
      const wasBroken = !!row.broken_since;
      await client.query(
        `UPDATE groups SET name = COALESCE($2, name),
                            image_url = COALESCE($3, image_url),
                            broken_since = NULL,
                            removed_reason = NULL,
                            removed_at = NULL,
                            last_checked_at = NOW()
         WHERE id = $1`,
        [row.id, preview.name, preview.imageUrl]
      );
      if (wasBroken) {
        recovered.push({ id: row.id, link: row.link });
      }
      checked.push({ id: row.id, link: row.link });
    }

    return res.json({
      ok: true,
      checked: checked.length,
      softBroken: softBroken.length,
      recovered: recovered.length,
      skipped: skipped.length,
      sentToReview: sentToReview.length,
      graceHours,
      policy: "No groups are ever auto-removed. Broken, revoked, non-OTP, and ratio-excess groups are all sent to review for admin decision.",
      softBrokenDetails: softBroken,
      recoveredDetails: recovered,
      skippedDetails: skipped,
      sentToReviewDetails: sentToReview,
    });
  } finally {
    client.release();
  }
}
