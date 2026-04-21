import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "../_lib/db";
import {
  fetchGroupPreview,
  isValidWhatsAppLink,
  extractWhatsAppLinks,
} from "../_lib/whatsapp";

const MAX_LINKS = 40;
const CONCURRENCY = 5;

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
  if (!preview.ok) {
    return { link, status: "failed", reason: preview.reason || "Link not working" };
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
