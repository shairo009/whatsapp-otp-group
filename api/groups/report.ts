import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "../_lib/db";

const ALLOWED_REASONS = new Set([
  "Admin only post",
  "Messages off",
  "Link reset",
  "Spam / irrelevant",
  "Other",
]);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { groupId, reason, details } = req.body || {};
  const gid = Number(groupId);

  if (!gid || !Number.isFinite(gid)) {
    return res.status(400).json({ error: "Invalid groupId" });
  }
  if (!reason || !ALLOWED_REASONS.has(reason)) {
    return res.status(400).json({ error: "Invalid reason" });
  }

  const client = await getPool().connect();
  try {
    const grp = await client.query("SELECT id FROM groups WHERE id = $1", [gid]);
    if (grp.rows.length === 0) {
      return res.status(404).json({ error: "Group not found" });
    }

    await client.query(
      "INSERT INTO reports (group_id, reason, details) VALUES ($1, $2, $3)",
      [gid, reason, (details || "").toString().slice(0, 500) || null]
    );

    return res.status(201).json({ ok: true });
  } finally {
    client.release();
  }
}
