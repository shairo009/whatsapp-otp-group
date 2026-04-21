import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "../_lib/db";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 40;

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
    const totalRes = await client.query(
      "SELECT COUNT(*)::int AS c FROM groups WHERE status IN ('approved','pending')"
    );
    const total = totalRes.rows[0].c as number;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    const result = await client.query(
      `SELECT id, link, description, name, image_url, status, created_at
       FROM groups WHERE status IN ('approved','pending')
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const items = result.rows.map((r) => ({
      id: r.id,
      link: r.link,
      description: r.description ?? null,
      name: r.name ?? null,
      imageUrl: r.image_url ?? null,
      status: r.status,
      createdAt: r.created_at,
    }));

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
