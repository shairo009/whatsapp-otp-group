import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "../_lib/db";
import { fetchGroupPreview, isValidWhatsAppLink } from "../_lib/whatsapp";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { link, description } = req.body || {};

  if (!link || !isValidWhatsAppLink(link)) {
    return res.status(400).json({ error: "Please provide a valid WhatsApp group link" });
  }

  const preview = await fetchGroupPreview(link);
  if (!preview.ok) {
    return res.status(400).json({
      error:
        "Group link is not working. Please check that the link is valid and not reset.",
      reason: preview.reason,
    });
  }

  const client = await getPool().connect();
  try {
    const existing = await client.query("SELECT id, status FROM groups WHERE link = $1", [link]);
    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: "This group is already submitted.",
        status: existing.rows[0].status,
      });
    }

    const result = await client.query(
      `INSERT INTO groups (link, description, name, image_url, status, last_checked_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW())
       RETURNING id, link, description, name, image_url, status, created_at`,
      [link, description || null, preview.name, preview.imageUrl]
    );
    const r = result.rows[0];
    return res.status(201).json({
      id: r.id,
      link: r.link,
      description: r.description ?? null,
      name: r.name ?? null,
      imageUrl: r.image_url ?? null,
      status: r.status,
      createdAt: r.created_at,
    });
  } finally {
    client.release();
  }
}
