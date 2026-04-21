import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "../_lib/db";
import {
  fetchGroupPreview,
  isValidWhatsAppLink,
  extractWhatsAppLinks,
  nameContainsOTP,
  normalizeName,
} from "../_lib/whatsapp";

const MAX_LINKS = 40;
const CONCURRENCY = 2;

type ResultItem = {
  link: string;
  status: "added" | "duplicate" | "failed";
  reason?: string;
  id?: number;
  name?: string | null;
  imageUrl?: string | null;
  existingStatus?: string;
};

async function processOne(
  link: string,
  description: string | null
): Promise<ResultItem> {
  if (!isValidWhatsAppLink(link)) {
    return { link, status: "failed", reason: "Invalid link format" };
  }

  const preview = await fetchGroupPreview(link);

  // Hard fail only when the link is definitively bad. If WhatsApp rate-limited
  // us (429) or returned a transient server error, accept the link as pending
  // — the verify cron will revalidate it later.
  if (!preview.ok && !preview.rateLimited) {
    return { link, status: "failed", reason: preview.reason || "Link not working" };
  }

  // Strict OTP-only policy:
  // - If WhatsApp gave us a name, it MUST contain "otp".
  // - If we couldn't read a name (null) AND we weren't rate-limited, reject —
  //   we can't verify, so we don't let unknown groups in.
  // - If rate-limited, allow as pending; the verify cron will enforce OTP later.
  if (!preview.rateLimited) {
    if (!preview.name || !nameContainsOTP(preview.name)) {
      return {
        link,
        status: "failed",
        reason: "Only OTP groups are allowed (group name must contain 'OTP')",
      };
    }
  }

  const client = await getPool().connect();
  try {
    const existing = await client.query(
      "SELECT id, status FROM groups WHERE link = $1",
      [link]
    );
    if (existing.rows.length > 0) {
      return {
        link,
        status: "duplicate",
        existingStatus: existing.rows[0].status,
        reason: "Already submitted",
      };
    }

    // Same group with a different invite link? Reject if a non-removed entry
    // already exists with a name that normalizes to the same key. We do the
    // comparison in JS (not SQL) so that fancy unicode, strikethrough,
    // homoglyphs, zero-width chars, emoji separators etc. all collapse to
    // the same canonical form — e.g. "O̶ T̶ P̶ Group", "𝐎𝐓𝐏 group" and
    // "OTP-Group" are all treated as the same group.
    if (preview.name) {
      const candidateKey = normalizeName(preview.name);
      if (candidateKey) {
        const all = await client.query(
          `SELECT id, status, name FROM groups
           WHERE status IN ('approved','pending')`
        );
        const match = all.rows.find(
          (r: { id: number; status: string; name: string | null }) =>
            normalizeName(r.name) === candidateKey
        );
        if (match) {
          return {
            link,
            status: "duplicate",
            existingStatus: match.status,
            reason: "Same group already listed under another invite link",
          };
        }
      }
    }

    const result = await client.query(
      `INSERT INTO groups (link, description, name, image_url, status, last_checked_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW())
       RETURNING id, name, image_url`,
      [link, description, preview.name, preview.imageUrl]
    );
    const r = result.rows[0];
    return {
      link,
      status: "added",
      id: r.id,
      name: r.name ?? null,
      imageUrl: r.image_url ?? null,
      reason: preview.rateLimited
        ? "Saved as pending — WhatsApp rate-limited verification, will retry automatically."
        : undefined,
    };
  } catch (err: any) {
    return { link, status: "failed", reason: err?.message || "DB error" };
  } finally {
    client.release();
  }
}

async function processBatch(
  links: string[],
  description: string | null
): Promise<ResultItem[]> {
  const out: ResultItem[] = new Array(links.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= links.length) return;
      out[idx] = await processOne(links[idx], description);
    }
  }
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, links.length) },
    () => worker()
  );
  await Promise.all(workers);
  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const body = req.body || {};
  const { link, links, text, description } = body as {
    link?: string;
    links?: string[];
    text?: string;
    description?: string;
  };

  // Collect candidate raw inputs from any of the supported fields.
  const rawSources: string[] = [];
  if (typeof text === "string" && text.trim()) rawSources.push(text);
  if (Array.isArray(links)) {
    for (const l of links) if (typeof l === "string") rawSources.push(l);
  }
  if (typeof link === "string" && link.trim()) rawSources.push(link);

  if (rawSources.length === 0) {
    return res.status(400).json({
      error: "Please provide one or more WhatsApp group links.",
    });
  }

  // Extract + dedupe across all sources, ignore everything that isn't a valid link.
  const merged = extractWhatsAppLinks(rawSources.join("\n"));

  if (merged.length === 0) {
    return res.status(400).json({
      error:
        "No valid WhatsApp invite links found. Make sure links look like https://chat.whatsapp.com/xxxxxxxxxx",
    });
  }

  const truncated = merged.length > MAX_LINKS;
  const toProcess = merged.slice(0, MAX_LINKS);
  const desc =
    typeof description === "string" && description.trim()
      ? description.trim().slice(0, 240)
      : null;

  const results = await processBatch(toProcess, desc);

  const summary = {
    received: merged.length,
    processed: toProcess.length,
    added: results.filter((r) => r.status === "added").length,
    duplicates: results.filter((r) => r.status === "duplicate").length,
    failed: results.filter((r) => r.status === "failed").length,
    truncated,
    maxPerSubmit: MAX_LINKS,
  };

  return res.status(toProcess.length === 1 && results[0].status === "failed" ? 400 : 200).json({
    summary,
    results,
  });
}
