import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "../_lib/db";
import { fetchGroupPreview, nameContainsOTP } from "../_lib/whatsapp";

// Hours a link can stay "soft broken" before we actually remove it.
// This avoids removing healthy links during transient WhatsApp issues
// (cached previews, geo blips, weird UA detection, etc.).
const SOFT_BROKEN_GRACE_HOURS = 24;

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
  const softBroken: any[] = [];
  const recovered: any[] = [];
  const skipped: any[] = [];
  try {
    // Ensure broken_since column exists (idempotent migration)
    await client.query(
      "ALTER TABLE groups ADD COLUMN IF NOT EXISTS broken_since TIMESTAMP"
    );

    // Tunable via query params so an external scheduler can throttle.
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
       ORDER BY last_checked_at ASC NULLS FIRST, id ASC
       LIMIT $1`,
      [limit]
    );

    const sleep = (ms: number) =>
      ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();

    let first = true;
    for (const row of result.rows) {
      // Spread requests to chat.whatsapp.com so we don't get blocked.
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

      // HARD broken (explicit revoked/invalid markers, no metadata at all,
      // invalid format, etc.) — remove immediately.
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
        removed.push({
          id: row.id,
          link: row.link,
          reason: preview.reason || "Link reset or revoked",
        });
        continue;
      }

      // SOFT broken (generic title with no member count etc.). Mark
      // broken_since on the first hit; only remove after the grace window
      // so we don't kill healthy links during transient WhatsApp weirdness.
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
               SET status = 'removed',
                   last_checked_at = NOW()
             WHERE id = $1`,
            [row.id]
          );
          removed.push({
            id: row.id,
            link: row.link,
            reason: `Soft-broken for ${Math.round(ageHours)}h: ${preview.reason}`,
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

      // From here: preview.ok === true.
      const effectiveName = preview.name ?? row.name;
      const knowName = !!effectiveName;
      const isOtp = nameContainsOTP(effectiveName);

      // OTP policy:
      //   - If we KNOW the name and it doesn't contain OTP → remove.
      //   - If we don't know the name (rare with the new fetcher), DO NOT
      //     remove on this run. Just refresh metadata; we'll catch it later.
      if (knowName && !isOtp) {
        await client.query(
          "UPDATE groups SET status = 'removed', last_checked_at = NOW() WHERE id = $1",
          [row.id]
        );
        removed.push({
          id: row.id,
          link: row.link,
          reason: "Not an OTP group",
        });
        continue;
      }

      // Healthy — clear broken_since if set, refresh metadata.
      const wasBroken = !!row.broken_since;
      await client.query(
        `UPDATE groups SET name = COALESCE($2, name),
                            image_url = COALESCE($3, image_url),
                            broken_since = NULL,
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
      removed: removed.length,
      softBroken: softBroken.length,
      recovered: recovered.length,
      skipped: skipped.length,
      graceHours,
      removedDetails: removed,
      softBrokenDetails: softBroken,
      recoveredDetails: recovered,
      skippedDetails: skipped,
    });
  } finally {
    client.release();
  }
}
