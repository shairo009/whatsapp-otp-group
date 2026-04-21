import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool, isAdmin } from "../_lib/db";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (!isAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const status = (req.query.status as string) || "all";
  const client = await getPool().connect();
  try {
    let q = `SELECT g.id, g.link, g.description, g.name, g.image_url, g.status,
                    g.last_checked_at, g.created_at,
                    COUNT(r.id)::int AS report_count
             FROM groups g
             LEFT JOIN reports r ON r.group_id = g.id`;
    const params: any[] = [];
    if (status === "pending" || status === "approved" || status === "removed") {
      q += " WHERE g.status = $1";
      params.push(status);
    }
    q += " GROUP BY g.id ORDER BY g.created_at DESC";

    const result = await client.query(q, params);
    return res.json(
      result.rows.map((r) => ({
        id: r.id,
        link: r.link,
        description: r.description ?? null,
        name: r.name ?? null,
        imageUrl: r.image_url ?? null,
        status: r.status,
        lastCheckedAt: r.last_checked_at,
        createdAt: r.created_at,
        reportCount: r.report_count,
      }))
    );
  } finally {
    client.release();
  }
}
