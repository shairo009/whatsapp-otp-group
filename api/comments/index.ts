import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "../_lib/db";
import { extractWhatsAppLinks, fetchGroupPreview } from "../_lib/whatsapp";

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
      let { name, content } = req.body as { name?: string; content?: string };
      if (!name || !content || !name.trim() || !content.trim()) {
        return res.status(400).json({ error: "Name and comment are required." });
      }

      name = name.trim().slice(0, 50);
      content = content.trim();

      // Detect WhatsApp links
      const links = extractWhatsAppLinks(content);
      if (links.length > 0) {
        for (const link of links) {
          try {
            // Check duplicate
            const dup = await client.query("SELECT id FROM groups WHERE link = $1", [link]);
            if (dup.rows.length === 0) {
              const preview = await fetchGroupPreview(link);
              // Add to groups as approved
              await client.query(
                "INSERT INTO groups (link, name, image_url, status, last_checked_at) VALUES ($1, $2, $3, 'approved', NOW())",
                [link, preview.name || null, preview.imageUrl || null]
              );
            }
          } catch (e) {
            console.error("Error auto-adding link from comment:", e);
          }
        }
        // Replace links in content
        const linkRe = /https?:\/\/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{10,})/gi;
        content = content.replace(linkRe, "[Submit your group on our website. Thank you!]");
      }

      const result = await client.query(
        "INSERT INTO comments (name, content) VALUES ($1, $2) RETURNING id, name, content, created_at",
        [name, content.slice(0, 1000)]
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
