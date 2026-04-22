import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "../_lib/db";

const DEFAULT_LIMIT = 42;
const MAX_LIMIT = 42;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  const pageRaw = parseInt(String(req.query.page || "1"), 10);
  const limitRaw = parseInt(String(req.query.limit || DEFAULT_LIMIT), 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT)
  );
  const offset = (page - 1) * limit;

  const client = await getPool().connect();
  try {
    // Make sure last_synced_at exists even if /api/cron/sync hasn't been
    // hit yet — keeps SELECT below safe on a fresh DB.
    await client.query(
      "ALTER TABLE groups ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP"
    );

    // Dedupe by group name (case-insensitive). Same WhatsApp group can have
    // multiple invite codes if admin reset the link — show only one row per
    // distinct name. Rows with NULL name are kept individually.
    const dedupedCte = `
      WITH ranked AS (
        SELECT id, link, description, name, image_url, status, created_at,
               last_checked_at, last_synced_at,
               ROW_NUMBER() OVER (
                 PARTITION BY CASE WHEN name IS NULL THEN id::text ELSE LOWER(TRIM(name)) END
                 ORDER BY created_at ASC, id ASC
               ) AS rn
        FROM groups
        WHERE status IN ('approved','pending')
      )
      SELECT id, link, description, name, image_url, status, created_at,
             last_checked_at, last_synced_at
      FROM ranked WHERE rn = 1
    `;

    const totalRes = await client.query(
      `SELECT COUNT(*)::int AS c FROM (${dedupedCte}) t`
    );
    const total = totalRes.rows[0].c as number;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    const result = await client.query(
      `${dedupedCte}
       ORDER BY (CASE WHEN (name IS NOT NULL OR image_url IS NOT NULL) THEN 0 ELSE 1 END), created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const items = result.rows.map((r) => {
      // Pick the most recent freshness signal we have.
      const synced = r.last_synced_at ? new Date(r.last_synced_at).getTime() : 0;
      const checked = r.last_checked_at ? new Date(r.last_checked_at).getTime() : 0;
      const freshest = Math.max(synced, checked);
      return {
        id: r.id,
        link: r.link,
        description: r.description ?? null,
        name: r.name ?? null,
        imageUrl: r.image_url ?? null,
        status: r.status,
        createdAt: r.created_at,
        lastSyncedAt: freshest > 0 ? new Date(freshest).toISOString() : null,
      };
    });

    return res.json({
      items,
      total,
      page,
      limit,
      totalPages,
    });
  } finally {
    client.release();
  }
}
