import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool, isAdmin } from "../_lib/db";
import { normalizeName } from "../_lib/whatsapp";

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
    if (action === "dedupe-names") {
      // Find groups whose normalized name collides with another approved /
      // pending entry. Keep the OLDEST entry (lowest id) per name key — it's
      // most likely the one users have already shared — and mark the rest
      // as 'removed' so they disappear from the public list but remain
      // recoverable from the Removed tab.
      const all = await client.query(
        `SELECT id, status, name FROM groups
         WHERE status IN ('approved','pending')
         ORDER BY id ASC`
      );
      const buckets = new Map<string, Array<{ id: number; status: string; name: string | null }>>();
      for (const row of all.rows as Array<{ id: number; status: string; name: string | null }>) {
        const key = normalizeName(row.name);
        if (!key) continue;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key)!.push(row);
      }
      const toRemove: number[] = [];
      const groupsAffected: Array<{ kept: number; removed: number[]; name: string | null }> = [];
      for (const rows of buckets.values()) {
        if (rows.length < 2) continue;
        const [keep, ...rest] = rows;
        const removedIds = rest.map((r) => r.id);
        toRemove.push(...removedIds);
        groupsAffected.push({ kept: keep.id, removed: removedIds, name: keep.name });
      }
      if (toRemove.length > 0) {
        await client.query(
          `UPDATE groups SET status = 'removed' WHERE id = ANY($1::int[])`,
          [toRemove]
        );
      }
      return res.json({
        ok: true,
        scanned: all.rows.length,
        duplicateGroups: groupsAffected.length,
        removed: toRemove.length,
        details: groupsAffected,
      });
    }
    return res.status(400).json({ error: "Unknown action" });
  } finally {
    client.release();
  }
}
