import type { VercelRequest, VercelResponse } from "@vercel/node";
import { fetchGroupPreview, isValidWhatsAppLink } from "../_lib/whatsapp";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const link =
    (req.method === "GET" ? (req.query.link as string) : req.body?.link) || "";

  if (!isValidWhatsAppLink(link)) {
    return res
      .status(400)
      .json({ ok: false, error: "Please provide a valid WhatsApp group link" });
  }

  const preview = await fetchGroupPreview(link);
  return res.json(preview);
}
