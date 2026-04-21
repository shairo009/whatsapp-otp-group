import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "../_lib/db";

const ALLOWED_REASONS = new Set([
  "Not working",
  "Admin only post",
  "Messages off",
  "Link reset",
  "Spam / irrelevant",
  "Other",
]);

// Optional GitHub-issue mirror. When env vars are set, every report also
// creates a GitHub issue with a "remove" checkbox. Toggling the checkbox in
// the issue triggers the workflow at .github/workflows/process-report.yml
// which calls /api/admin/action to remove the group from the DB.
async function createGithubIssue(group: {
  id: number;
  link: string;
  name: string | null;
}, reason: string, details: string | null) {
  const repo = process.env.GITHUB_REPO;          // e.g. "shairo009/whatsapp-otp-group"
  const token = process.env.GITHUB_BOT_TOKEN;    // PAT with issues:write
  if (!repo || !token) return null;              // mirror disabled — silent no-op

  const title = `[Report] ${reason} — ${group.name || "Unnamed group"} (#${group.id})`;
  const body = [
    `**Group ID:** ${group.id}`,
    `**Name:** ${group.name || "_(unknown)_"}`,
    `**Link:** ${group.link}`,
    `**Reason:** ${reason}`,
    details ? `**Details:** ${details}` : "",
    "",
    "---",
    "",
    "Tick the box below and save the issue to remove this group from the site.",
    "",
    `- [ ] Confirm: remove group #${group.id}`,
    "",
    `<!-- group-report group_id=${group.id} -->`,
  ].filter(Boolean).join("\n");

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "whatsapp-otp-group-report-bot",
      },
      body: JSON.stringify({
        title,
        body,
        labels: ["group-report"],
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error("GitHub issue create failed", res.status, txt);
      return null;
    }
    const data: any = await res.json().catch(() => ({}));
    return data?.number ?? null;
  } catch (e: any) {
    console.error("GitHub issue create error", e?.message);
    return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { groupId, reason, details } = req.body || {};
  const gid = Number(groupId);
  const reasonStr = (reason || "Not working").toString();

  if (!gid || !Number.isFinite(gid)) {
    return res.status(400).json({ error: "Invalid groupId" });
  }
  if (!ALLOWED_REASONS.has(reasonStr)) {
    return res.status(400).json({ error: "Invalid reason" });
  }

  const client = await getPool().connect();
  try {
    const grp = await client.query(
      "SELECT id, link, name FROM groups WHERE id = $1",
      [gid]
    );
    if (grp.rows.length === 0) {
      return res.status(404).json({ error: "Group not found" });
    }
    const row = grp.rows[0];
    const detailStr =
      (details || "").toString().slice(0, 500) || null;

    await client.query(
      "INSERT INTO reports (group_id, reason, details) VALUES ($1, $2, $3)",
      [gid, reasonStr, detailStr]
    );

    // Fire-and-forget GitHub issue mirror. Don't block the user response on
    // GitHub's API latency.
    createGithubIssue(
      { id: row.id, link: row.link, name: row.name },
      reasonStr,
      detailStr
    ).catch((e) => console.error("issue mirror failed", e?.message));

    return res.status(201).json({ ok: true });
  } finally {
    client.release();
  }
}
