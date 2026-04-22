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

// Website ratio rule: 80% OTP groups, 20% other-name groups (max).
// This ratio is calculated dynamically based on total approved groups.
// Example:
//   Total approved = 10  → max other = 2  (20% of 10)
//   Total approved = 50  → max other = 10 (20% of 50)
//   Total approved = 100 → max other = 20 (20% of 100)
//   Total approved = 200 → max other = 40 (20% of 200)
const OTHER_NAME_MAX_RATIO = 0.20; // 20%
const OTP_MIN_RATIO = 0.80;        // 80%

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

// Calculate the current ratio stats from DB.
async function getRatioStats(client: any) {
  const res = await client.query(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE name IS NOT NULL AND name ILIKE '%otp%') AS otp_count,
       COUNT(*) FILTER (WHERE name IS NULL OR name NOT ILIKE '%otp%') AS other_count
     FROM groups WHERE status = 'approved'`
  );
  const total = parseInt(res.rows[0].total || "0", 10);
  const otpCount = parseInt(res.rows[0].otp_count || "0", 10);
  const otherCount = parseInt(res.rows[0].other_count || "0", 10);
  const allowedOther = Math.floor(total * OTHER_NAME_MAX_RATIO);
  const availableSlots = Math.max(0, allowedOther - otherCount);
  const currentOtherPercent =
    total > 0 ? ((otherCount / total) * 100).toFixed(1) + "%" : "0%";

  return { total, otpCount, otherCount, allowedOther, availableSlots, currentOtherPercent };
}

async function processOne(
  link: string,
  description: string | null,
  counter: { added: number }
): Promise<ResultItem> {
  if (!isValidWhatsAppLink(link)) {
    return { link, status: "failed", reason: "Invalid link format" };
  }

  const preview = await fetchGroupPreview(link);

  if (!preview.ok && !preview.rateLimited) {
    return { link, status: "failed", reason: preview.reason || "Link not working" };
  }

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

    // Check duplicate by group name (same group, different invite link)
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
        reason: `Add limit reached — only ${MAX_ADDS} groups can be added per submit.`,
      };
    }

    // --- 80%/20% RATIO CALCULATION ---
    // Count currently approved groups to calculate how many other-name slots exist.
    // Formula: allowed_other = floor(total_approved * 20%)
    // If current other-name approved groups have filled the 20% slot → review queue.
    const stats = await getRatioStats(client);

    if (!isOtp && preview.name) {
      const ratioInfo = {
        totalApproved: stats.total,
        otpApproved: stats.otpCount,
        otherApproved: stats.otherCount,
        allowedOther: stats.allowedOther,
        availableSlots: stats.availableSlots,
        currentOtherPercent: stats.currentOtherPercent,
      };

      if (stats.availableSlots <= 0) {
        // 20% cap is full — send to review.
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
          ratioInfo,
          reason:
            `Sent to review — the 20% other-name slots are currently full. ` +
            `Currently ${stats.otherCount}/${stats.total} groups (${stats.currentOtherPercent}) are other-name. ` +
            `Allowed: ${stats.allowedOther} (20% of ${stats.total} approved groups). ` +
            `Your group will be reviewed and approved when a slot opens.`,
        };
      }

      // Within 20% cap — add as pending with slot info.
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
        ratioInfo,
        reason:
          `Added as pending (other-name group). ` +
          `Other-name slots: ${stats.otherCount + 1}/${stats.allowedOther} used ` +
          `(${stats.availableSlots - 1} slot${stats.availableSlots - 1 === 1 ? "" : "s"} remaining). ` +
          `Policy: max 20% of approved groups may be other-name.`,
      };
    }

    // OTP group (or rate-limited — name unverified) → add as pending normally.
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

  // Current ratio snapshot for the summary
  const dbClient = await getPool().connect();
  let currentStats: any = null;
  try {
    currentStats = await getRatioStats(dbClient);
  } finally {
    dbClient.release();
  }

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
    currentRatio: currentStats
      ? {
          totalApproved: currentStats.total,
          otpGroups: currentStats.otpCount,
          otherNameGroups: currentStats.otherCount,
          allowedOtherMax: currentStats.allowedOther,
          availableOtherSlots: currentStats.availableSlots,
          otherPercent: currentStats.currentOtherPercent,
          otpPercent:
            currentStats.total > 0
              ? ((currentStats.otpCount / currentStats.total) * 100).toFixed(1) + "%"
              : "0%",
          rule: `80% OTP groups / 20% other-name groups (max ${currentStats.allowedOther} other-name slots for ${currentStats.total} approved groups)`,
        }
      : null,
  };

  const allFailed = toProcess.length === 1 && results[0].status === "failed";
  return res.status(allFailed ? 400 : 200).json({ summary, results });
}
