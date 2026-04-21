export type GroupPreview = {
  ok: boolean;
  name: string | null;
  imageUrl: string | null;
  reason?: string;
  rateLimited?: boolean;
};

const INVALID_MARKERS = [
  "invite link is no longer valid",
  "invite link revoked",
  "this invite link is invalid",
  "link is invalid",
  "reset by an admin",
];

const LINK_RE = /https?:\/\/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{10,})/gi;

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
];

function pickUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function metaContent(html: string, prop: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`,
    "i"
  );
  const m = html.match(re);
  if (m) return decodeHtml(m[1]);
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`,
    "i"
  );
  const m2 = html.match(re2);
  return m2 ? decodeHtml(m2[1]) : null;
}

export function isValidWhatsAppLink(link: string): boolean {
  return /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]{10,}$/.test(link.trim());
}

/**
 * Extract all unique, normalized WhatsApp invite links from arbitrary text.
 * Ignores everything that isn't a valid WhatsApp invite URL — so users can
 * paste messages, captions, mixed content, etc.
 */
export function extractWhatsAppLinks(text: string): string[] {
  if (!text || typeof text !== "string") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(text)) !== null) {
    const code = m[1];
    const normalized = `https://chat.whatsapp.com/${code}`;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchOnce(link: string): Promise<{
  status: number;
  html: string | null;
  error?: string;
}> {
  try {
    const res = await fetch(link, {
      headers: {
        "User-Agent": pickUA(),
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      return { status: res.status, html: null };
    }
    const html = await res.text();
    return { status: res.status, html };
  } catch (err: any) {
    return { status: 0, html: null, error: err?.message || "Fetch failed" };
  }
}

export async function fetchGroupPreview(link: string): Promise<GroupPreview> {
  if (!isValidWhatsAppLink(link)) {
    return { ok: false, name: null, imageUrl: null, reason: "Invalid link format" };
  }

  // Up to 3 attempts. Retry on 429 / 5xx with exponential backoff + jitter.
  const maxAttempts = 3;
  let lastStatus = 0;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await fetchOnce(link);
    lastStatus = r.status;
    lastError = r.error;

    const transient =
      r.status === 429 || (r.status >= 500 && r.status < 600) || r.status === 0;

    if (!transient && r.html) {
      const html = r.html;
      const lower = html.toLowerCase();

      for (const marker of INVALID_MARKERS) {
        if (lower.includes(marker)) {
          return { ok: false, name: null, imageUrl: null, reason: "Link reset or revoked" };
        }
      }

      const ogTitle = metaContent(html, "og:title");
      const ogImage = metaContent(html, "og:image");

      if (!ogTitle && !ogImage) {
        return { ok: false, name: null, imageUrl: null, reason: "No group preview available" };
      }

      const name =
        ogTitle &&
        ogTitle.toLowerCase() !== "whatsapp" &&
        ogTitle.toLowerCase() !== "whatsapp group invite"
          ? ogTitle
          : null;

      return { ok: true, name, imageUrl: ogImage || null };
    }

    if (!transient) {
      return { ok: false, name: null, imageUrl: null, reason: `HTTP ${r.status}` };
    }

    if (attempt < maxAttempts) {
      const backoff = 400 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 300);
      await sleep(backoff);
    }
  }

  if (lastStatus === 429) {
    return {
      ok: false,
      name: null,
      imageUrl: null,
      reason: "WhatsApp temporarily rate-limited the request. Will retry later.",
      rateLimited: true,
    };
  }
  if (lastStatus >= 500) {
    return {
      ok: false,
      name: null,
      imageUrl: null,
      reason: `WhatsApp server error (HTTP ${lastStatus}). Will retry later.`,
      rateLimited: true,
    };
  }
  return {
    ok: false,
    name: null,
    imageUrl: null,
    reason: lastError || "Fetch failed",
  };
}
