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

// 80% of approved/pending slots are reserved for OTP groups.
// Up to 20% may be non-OTP groups. Groups that exceed this cap are sent
// to the review queue instead of being added directly.
const OTHER_NAME_MAX_RATIO = 0.20;

type ResultItem = {
  link: string;
  status: "added" | "duplicate" | "failed" | "review";
  reason?: string;
  id?: number;
  name?: string | null;
  imageUrl?: string | null;
  existingStatus?: string;
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

  // Hard fail only when the link is definitively bad. If WhatsApp rate-limited
  // us (429) or returned a transient server error, accept the link as pending
  // — the verify cron will revalidate it later.
  if (!preview.ok && !preview.rateLimited) {
    return { link, status: "failed", reason: preview.reason || "Link not working" };
  }

  // Determine whether this is an OTP group or an "other name" group.
  // Rules:
  //   - If rate-limited, allow as pending; the verify cron will enforce ratio later.
  //   - If name is known and contains OTP, add as pending (normal flow).
  //   - If name is known and does NOT contain OTP, apply the 20% cap rule:
  //       * Within cap  → add as pending
  //       * Over cap    → send to review queue
  //   - If name is null and not rate-limited, we can't verify; reject.
  if (!preview.rateLimited && !preview.name) {
    return {
      link,
      status: "failed",
      reason: "Could not read the group name. Please make sure the link is valid and try again.",
    };
  }

  const isOtp = preview.rateLimited || nameContainsOTP(preview.name ?? "");

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
    // already exists with a name that normalizes to the same key.
    if (preview.name) {
      const candidateKey = normalizeName(preview.name);
      if (candidateKey) {
        const all = await client.query(
          `SELECT id, status, name FROM groups
           WHERE status IN ('approved','pending','review')`
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

    if (counter.added >= MAX_ADDS) {
      return {
        link,
        status: "failed",
        reason: `Add limit reached — only ${MAX_ADDS} groups can be added per submit. This link is valid but was not added.`,
      };
    }

    // For non-OTP groups, enforce the 20% other-name cap.
    // Count how many non-OTP groups exist in active (approved/pending) slots.
    if (!isOtp && preview.name) {
      const ratioResult = await client.query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE name IS NOT NULL AND name NOT ILIKE '%otp%') AS other_count
         FROM groups WHERE status IN ('approved', 'pending')`
      );
      const total = parseInt(ratioResult.rows[0].total || "0", 10);
      const otherCount = parseInt(ratioResult.rows[0].other_count || "0", 10);
      const newTotal = total + 1;
      const allowedOther = Math.floor(newTotal * OTHER_NAME_MAX_RATIO);

      if (otherCount >= allowedOther) {
        // Over the 20% cap — send to review instead of rejecting outright.
        const result = await client.query(
          `INSERT INTO groups (link, description, name, image_url, status, last_checked_at)
           VALUES ($1, $2, $3, $4, 'review', NOW())
           RETURNING id, name, image_url`,
          [link, description, preview.name, preview.imageUrl]
        );
        const r = result.rows[0];
        return {
          link,
          status: "review",
          id: r.id,
          name: r.name ?? null,
          imageUrl: r.image_url ?? null,
          reason:
            `This group has been sent to review. Our listing maintains 80% OTP groups and up to 20% other groups. ` +
            `The other-name slots (20%) are currently full, so this group will be reviewed and approved when a slot opens.`,
        };
      }
    }

    // Within limits — add as pending.
    const result = await client.query(
      `INSERT INTO groups (link, description, name, image_url, status, last_checked_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW())
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
        ? "Saved as pending — WhatsApp rate-limited verification, will retry automatically."
        : !isOtp
        ? `Added as pending. Note: This group's name does not contain 'OTP'. It counts toward the 20% other-name allowance.`
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
    review: results.filter((r) => r.status === "review").length,
    duplicates: results.filter((r) => r.status === "duplicate").length,
    failed: results.filter((r) => r.status === "failed").length,
    truncated,
    maxPerSubmit: MAX_LINKS,
    maxAdds: MAX_ADDS,
    policy: "80% OTP groups / 20% other-name groups. Groups exceeding the 20% other-name cap are sent to review.",
  };

  const allFailed = toProcess.length === 1 && results[0].status === "failed";
  return res.status(allFailed ? 400 : 200).json({
    summary,
    results,
  });
}
