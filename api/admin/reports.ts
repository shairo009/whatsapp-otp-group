import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool, isAdmin } from "../_lib/db";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (!isAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const client = await getPool().connect();
  try {
    const result = await client.query(
      `SELECT r.id, r.group_id, r.reason, r.details, r.created_at,
              g.link, g.name, g.image_url, g.status
       FROM reports r
       JOIN groups g ON g.id = r.group_id
       ORDER BY r.created_at DESC
       LIMIT 500`
    );
    return res.json(
      result.rows.map((r) => ({
        id: r.id,
        groupId: r.group_id,
        reason: r.reason,
        details: r.details,
        createdAt: r.created_at,
        group: {
          link: r.link,
          name: r.name,
          imageUrl: r.image_url,
          status: r.status,
        },
      }))
    );
  } finally {
    client.release();
  }
}
