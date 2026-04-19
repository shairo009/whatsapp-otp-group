import { Pool } from "pg";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { link, description } = req.body || {};

  if (!link || !link.startsWith("https://chat.whatsapp.com/")) {
    return res.status(400).json({ error: "Please provide a valid WhatsApp group link" });
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      "INSERT INTO groups (link, description, status) VALUES ($1, $2, 'pending') RETURNING id, link, description, status, created_at",
      [link, description || null]
    );
    return res.status(201).json({
      id: result.rows[0].id,
      link: result.rows[0].link,
      description: result.rows[0].description ?? null,
      status: result.rows[0].status,
      createdAt: result.rows[0].created_at,
    });
  } finally {
    client.release();
  }
}
