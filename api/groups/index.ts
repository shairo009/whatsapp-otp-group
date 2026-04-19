import { Pool } from "pg";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT id, link, description, status, created_at FROM groups WHERE status = 'approved' ORDER BY created_at DESC"
    );
    return res.json(result.rows.map((r) => ({
      id: r.id,
      link: r.link,
      description: r.description ?? null,
      status: r.status,
      createdAt: r.created_at,
    })));
  } finally {
    client.release();
  }
}
