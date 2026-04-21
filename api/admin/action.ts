import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool, isAdmin } from "../_lib/db";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (!isAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { action, groupId, reportId } = req.body || {};
  const client = await getPool().connect();
  try {
    if (action === "approve") {
      const r = await client.query(
        "UPDATE groups SET status = 'approved' WHERE id = $1 RETURNING id",
        [Number(groupId)]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: "Group not found" });
      return res.json({ ok: true });
    }
    if (action === "delete") {
      const r = await client.query("DELETE FROM groups WHERE id = $1 RETURNING id", [
        Number(groupId),
      ]);
      if (r.rowCount === 0) return res.status(404).json({ error: "Group not found" });
      return res.json({ ok: true });
    }
    if (action === "remove") {
      const r = await client.query(
        "UPDATE groups SET status = 'removed' WHERE id = $1 RETURNING id",
        [Number(groupId)]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: "Group not found" });
      return res.json({ ok: true });
    }
    if (action === "dismiss-report") {
      const r = await client.query("DELETE FROM reports WHERE id = $1 RETURNING id", [
        Number(reportId),
      ]);
      if (r.rowCount === 0) return res.status(404).json({ error: "Report not found" });
      return res.json({ ok: true });
    }
    if (action === "clear-reports") {
      await client.query("DELETE FROM reports WHERE group_id = $1", [Number(groupId)]);
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: "Unknown action" });
  } finally {
    client.release();
  }
}
