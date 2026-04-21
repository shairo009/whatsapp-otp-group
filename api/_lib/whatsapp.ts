export type GroupPreview = {
  ok: boolean;
  name: string | null;
  imageUrl: string | null;
  reason?: string;
};

const INVALID_MARKERS = [
  "invite link is no longer valid",
  "invite link revoked",
  "this invite link is invalid",
  "link is invalid",
  "reset by an admin",
];

const LINK_RE = /https?:\/\/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{10,})/gi;

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

export async function fetchGroupPreview(link: string): Promise<GroupPreview> {
  if (!isValidWhatsAppLink(link)) {
    return { ok: false, name: null, imageUrl: null, reason: "Invalid link format" };
  }

  try {
    const res = await fetch(link, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    if (!res.ok) {
      return { ok: false, name: null, imageUrl: null, reason: `HTTP ${res.status}` };
    }

    const html = await res.text();
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
      ogTitle && ogTitle.toLowerCase() !== "whatsapp" && ogTitle.toLowerCase() !== "whatsapp group invite"
        ? ogTitle
        : null;

    return { ok: true, name, imageUrl: ogImage || null };
  } catch (err: any) {
    return { ok: false, name: null, imageUrl: null, reason: err?.message || "Fetch failed" };
  }
}
