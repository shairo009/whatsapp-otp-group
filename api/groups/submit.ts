import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "../_lib/db";
import {
  fetchGroupPreview,
  isValidWhatsAppLink,
  extractWhatsAppLinks,
  nameContainsOTP,
  normalizeName,
} from "../_lib/whatsapp";

const MAX_LINKS = 500;
const MAX_ADDS = 40;
const CONCURRENCY = 2;

type ResultItem = {
  link: string;
  status: "added" | "duplicate" | "failed" | "review";
  reason?: string;
  id?: number;
  name?: string | null;
  imageUrl?: string | null;
  existingStatus?: string;
  ratioInfo?: {
    totalApproved: number;
    otpApproved: number;
    otherApproved: number;
    allowedOther: number;
    availableSlots: number;
    currentOtherPercent: string;
  };
};

async function processOne(
  link: string,
  description: string | null,
  counter: { added: number }
): Promise<ResultItem> {
  if (!isValidWhatsAppLink(link)) {
    return { link, status: "failed", reason: "Invalid link format" };
  }

  const preview = await fetchGroupPreview(link);

  // Allow soft-broken links (blocked by WhatsApp but technically reachable)
  if (!preview.ok && !preview.rateLimited && !preview.softBroken) {
    return { link, status: "failed", reason: preview.reason || "Link not working" };
  }

  const client = await getPool().connect();
  try {
    // Check duplicate by link
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

    if (counter.added >= MAX_ADDS) {
      return {
        link,
        status: "failed",
        reason: `Add limit reached — only ${MAX_ADDS} groups can be added per submit.`,
      };
    }

    // All groups are now added as 'approved' immediately as per user request.
    const result = await client.query(
      `INSERT INTO groups (link, description, name, image_url, status, last_checked_at)
       VALUES ($1, $2, $3, $4, 'approved', NOW())
       RETURNING id, name, image_url`,
      [link, description, preview.name, preview.imageUrl]
    );
    counter.added++;
    const r = result.rows[0];
    return {
      link,
      status: "added",
      id: r.id,
      name: r.name ?? null,
      imageUrl: r.image_url ?? null,
      reason: preview.rateLimited
        ? "Saved — WhatsApp rate-limited verification, name/DP will be updated automatically later."
        : preview.softBroken
        ? "Saved — WhatsApp blocked preview, name/DP will be updated automatically later."
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
  const counter = { added: 0 };
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= links.length) return;
      out[idx] = await processOne(links[idx], description, counter);
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
    review: results.filter((r) => r.status === "review").length,
    duplicates: results.filter((r) => r.status === "duplicate").length,
    failed: results.filter((r) => r.status === "failed").length,
    truncated,
    maxPerSubmit: MAX_LINKS,
    maxAdds: MAX_ADDS,
  };

  const allFailed = toProcess.length === 1 && results[0].status === "failed";
  return res.status(allFailed ? 400 : 200).json({ summary, results });
}
