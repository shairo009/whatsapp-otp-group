import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "../_lib/db";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const client = await getPool().connect();
  try {
    if (req.method === "GET") {
      const result = await client.query(
        "SELECT id, name, content, created_at FROM comments ORDER BY created_at DESC LIMIT 50"
      );
      return res.json(result.rows);
    }

    if (req.method === "POST") {
      const { name, content } = req.body as { name?: string; content?: string };
      if (!name || !content || !name.trim() || !content.trim()) {
        return res.status(400).json({ error: "Name and comment are required." });
      }

      const result = await client.query(
        "INSERT INTO comments (name, content) VALUES ($1, $2) RETURNING id, name, content, created_at",
        [name.trim().slice(0, 50), content.trim().slice(0, 1000)]
      );
      return res.json(result.rows[0]);
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
}
