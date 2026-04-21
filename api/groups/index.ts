import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "../_lib/db";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const client = await getPool().connect();
  try {
    const result = await client.query(
      `SELECT id, link, description, name, image_url, status, created_at
       FROM groups WHERE status = 'approved'
       ORDER BY created_at DESC`
    );
    return res.json(
      result.rows.map((r) => ({
        id: r.id,
        link: r.link,
        description: r.description ?? null,
        name: r.name ?? null,
        imageUrl: r.image_url ?? null,
        status: r.status,
        createdAt: r.created_at,
      }))
    );
  } finally {
    client.release();
  }
}
