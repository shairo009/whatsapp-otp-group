export type GroupPreview = {
  ok: boolean;
  name: string | null;
  imageUrl: string | null;
  reason?: string;
  rateLimited?: boolean;
  // Soft-broken means we *suspect* the link is dead (generic title, missing
  // name, no member count) but we're not 100% sure. The cron should grace
  // these via `broken_since` rather than removing on the first hit.
  softBroken?: boolean;
  hasMembers?: boolean;
};

const INVALID_MARKERS = [
  "invite link is no longer valid",
  "invite link revoked",
  "this invite link is invalid",
  "link is invalid",
  "reset by an admin",
  "this link has been revoked",
  "no longer available",
  "invite was reset",
  "link has been reset",
  "check with the group admin",
];

// These og:titles mean WhatsApp couldn't resolve the group (or is serving a
// fallback). They're a STRONG hint the link is broken — but not proof, since
// WhatsApp occasionally serves them for valid groups during transient issues.
// Treat as "soft broken" and let the cron grace them via broken_since.
const GENERIC_TITLES = new Set([
  "whatsapp",
  "whatsapp group invite",
  "join whatsapp group",
  "whatsapp group",
  "whatsapp messenger",
]);

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
  let out = s.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return _; }
  });
  out = out.replace(/&#(\d+);/g, (_, dec) => {
    try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return _; }
  });
  return out
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// Cyrillic / Greek homoglyphs that look identical to Latin letters. Users
// love these for "OTP" group names because they bypass naive substring
// matching: e.g. "ОТР" (Cyrillic O, T, R/P-lookalike) renders the same as
// "OTP" in WhatsApp.
const HOMOGLYPHS: Record<string, string> = {
  // Cyrillic uppercase
  "\u0410": "A", "\u0412": "B", "\u0415": "E", "\u041A": "K", "\u041C": "M",
  "\u041D": "H", "\u041E": "O", "\u0420": "P", "\u0421": "C", "\u0422": "T",
  "\u0425": "X", "\u0406": "I", "\u0408": "J", "\u0405": "S", "\u04AE": "Y",
  // Cyrillic lowercase
  "\u0430": "a", "\u0435": "e", "\u043A": "k", "\u043E": "o", "\u0440": "p",
  "\u0441": "c", "\u0445": "x", "\u0443": "y", "\u0456": "i", "\u0458": "j",
  "\u0455": "s",
  // Greek uppercase
  "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0396": "Z", "\u0397": "H",
  "\u0399": "I", "\u039A": "K", "\u039C": "M", "\u039D": "N", "\u039F": "O",
  "\u03A1": "P", "\u03A4": "T", "\u03A5": "Y", "\u03A7": "X",
  // Greek lowercase
  "\u03BF": "o", "\u03C1": "p", "\u03C4": "t",
};

// Map a single fancy/styled unicode character to its plain ASCII equivalent
// when possible. Covers Mathematical Alphanumeric Symbols, Enclosed
// Alphanumerics, Fullwidth Latin, Negative Squared/Circled letters, Cyrillic/
// Greek homoglyphs and several other ranges users love to use for stylized
// group names like 𝐎𝐓𝐏 / Ⓞⓣⓟ / 🅾🆃🅿 / ОТР / OTP.
function mapFancyChar(cp: number): string | null {
  // Mathematical Alphanumeric Symbols (U+1D400..U+1D7FF)
  if (cp >= 0x1d400 && cp <= 0x1d7ff) {
    const ranges: Array<[number, number, string]> = [
      [0x1d400, 0x1d419, "A"], [0x1d41a, 0x1d433, "a"],
      [0x1d434, 0x1d44d, "A"], [0x1d44e, 0x1d467, "a"],
      [0x1d468, 0x1d481, "A"], [0x1d482, 0x1d49b, "a"],
      [0x1d49c, 0x1d4b5, "A"], [0x1d4b6, 0x1d4cf, "a"],
      [0x1d4d0, 0x1d4e9, "A"], [0x1d4ea, 0x1d503, "a"],
      [0x1d504, 0x1d51d, "A"], [0x1d51e, 0x1d537, "a"],
      [0x1d538, 0x1d551, "A"], [0x1d552, 0x1d56b, "a"],
      [0x1d56c, 0x1d585, "A"], [0x1d586, 0x1d59f, "a"],
      [0x1d5a0, 0x1d5b9, "A"], [0x1d5ba, 0x1d5d3, "a"],
      [0x1d5d4, 0x1d5ed, "A"], [0x1d5ee, 0x1d607, "a"],
      [0x1d608, 0x1d621, "A"], [0x1d622, 0x1d63b, "a"],
      [0x1d63c, 0x1d655, "A"], [0x1d656, 0x1d66f, "a"],
      [0x1d670, 0x1d689, "A"], [0x1d68a, 0x1d6a3, "a"],
      [0x1d7ce, 0x1d7d7, "0"], [0x1d7d8, 0x1d7e1, "0"],
      [0x1d7e2, 0x1d7eb, "0"], [0x1d7ec, 0x1d7f5, "0"],
      [0x1d7f6, 0x1d7ff, "0"],
    ];
    for (const [start, end, base] of ranges) {
      if (cp >= start && cp <= end) {
        return String.fromCharCode(base.charCodeAt(0) + (cp - start));
      }
    }
  }
  // Enclosed Alphanumerics: Ⓐ..Ⓩ (U+24B6..U+24CF), ⓐ..ⓩ (U+24D0..U+24E9)
  if (cp >= 0x24b6 && cp <= 0x24cf) return String.fromCharCode("A".charCodeAt(0) + (cp - 0x24b6));
  if (cp >= 0x24d0 && cp <= 0x24e9) return String.fromCharCode("a".charCodeAt(0) + (cp - 0x24d0));
  // Fullwidth Latin: A..Z (U+FF21..U+FF3A), a..z (U+FF41..U+FF5A), 0..9 (U+FF10..U+FF19)
  if (cp >= 0xff21 && cp <= 0xff3a) return String.fromCharCode("A".charCodeAt(0) + (cp - 0xff21));
  if (cp >= 0xff41 && cp <= 0xff5a) return String.fromCharCode("a".charCodeAt(0) + (cp - 0xff41));
  if (cp >= 0xff10 && cp <= 0xff19) return String.fromCharCode("0".charCodeAt(0) + (cp - 0xff10));
  // Parenthesized Latin small: ⒜..⒵ (U+249C..U+24B5)
  if (cp >= 0x249c && cp <= 0x24b5) return String.fromCharCode("a".charCodeAt(0) + (cp - 0x249c));
  // Regional indicators: 🇦..🇿 (U+1F1E6..U+1F1FF) → A..Z
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return String.fromCharCode("A".charCodeAt(0) + (cp - 0x1f1e6));
  // Squared Latin Letters: 🄰..🅉 (U+1F130..U+1F149) → A..Z
  if (cp >= 0x1f130 && cp <= 0x1f149) return String.fromCharCode("A".charCodeAt(0) + (cp - 0x1f130));
  // Negative Squared Latin Letters: 🅰..🆉 (U+1F170..U+1F189) → A..Z
  if (cp >= 0x1f170 && cp <= 0x1f189) return String.fromCharCode("A".charCodeAt(0) + (cp - 0x1f170));
  // Negative Circled Latin Letters: 🅐..🅩 (U+1F150..U+1F169) → A..Z
  if (cp >= 0x1f150 && cp <= 0x1f169) return String.fromCharCode("A".charCodeAt(0) + (cp - 0x1f150));
  // Circled Latin small: ⓐ already handled in 24D0; also small from U+24D0..U+24E9 done above
  // Tag characters: U+E0020..U+E007E → printable ASCII
  if (cp >= 0xe0020 && cp <= 0xe007e) return String.fromCharCode(cp - 0xe0000);
  // Cyrillic / Greek homoglyphs
  const ch = String.fromCodePoint(cp);
  if (HOMOGLYPHS[ch]) return HOMOGLYPHS[ch];
  return null;
}

// Invisible / format characters that users sprinkle into stylized names to
// break naive substring matching. Strip these BEFORE running the OTP regex.
// Includes: ZWSP, ZWNJ, ZWJ, BOM, word joiner, soft hyphen, variation
// selectors (FE00-FE0F), and bidi controls.
const INVISIBLE_RE =
  /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF\uFE00-\uFE0F]/g;

function normalizeFancy(s: string): string {
  // Strip invisible / zero-width / variation-selector chars first so they
  // don't survive into the OTP regex check.
  let pre = s.replace(INVISIBLE_RE, "");
  // Unicode NFKD (handles many compatibility forms cheaply) + strip combining
  // marks (U+0300..U+036F) which include strikethrough (U+0336), underline,
  // accents and the like.
  try {
    pre = pre.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  } catch {
    /* ignore */
  }
  let out = "";
  for (const ch of pre) {
    const cp = ch.codePointAt(0)!;
    const mapped = mapFancyChar(cp);
    out += mapped ?? ch;
  }
  return out;
}

// Canonical form of a group name used for "is this the same group?"
// comparisons. Normalizes fancy unicode, strips invisible chars, lowercases,
// and removes ALL non-alphanumerics so "O̶ T̶ P̶ Group", "𝐎𝐓𝐏  group",
// "OTP-Group" and "ОТР group" all collapse to the same key.
export function normalizeName(name: string | null | undefined): string {
  if (!name) return "";
  return normalizeFancy(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function nameContainsOTP(name: string | null | undefined): boolean {
  if (!name) return false;
  const normalized = normalizeFancy(name).toLowerCase();
  // Match "otp" anywhere, with or without common separators between the
  // letters (otp, o.t.p, o-t-p, o t p, o*t*p, o/t/p, o|t|p, o:t:p, etc.).
  if (/otp/.test(normalized)) return true;
  if (/o[\s._\-*\/|:~+=]?t[\s._\-*\/|:~+=]?p/.test(normalized)) return true;
  // Last-resort: collapse ALL non-alphanumeric chars and look for "otp" in
  // the residue. This catches names like "✦O✦T✦P✦", "⟨O⟩⟨T⟩⟨P⟩",
  // "★O★T★P★", emoji-separated, bracket-separated, etc.
  const stripped = normalized.replace(/[^a-z0-9]+/g, "");
  if (stripped.includes("otp")) return true;
  return false;
}

// Strip WhatsApp branding noise from a candidate name string. Returns null if
// nothing meaningful remains.
function cleanCandidateName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = decodeHtml(raw).replace(/\s+/g, " ").trim();
  // Strip surrounding quotes
  s = s.replace(/^["'\u201C\u201D\u2018\u2019]+|["'\u201C\u201D\u2018\u2019]+$/g, "").trim();
  // Strip common suffix/prefix patterns WhatsApp adds:
  //   "GroupName | WhatsApp"   "GroupName - WhatsApp"   "GroupName · WhatsApp"
  //   "WhatsApp Group Invite: GroupName"   "WhatsApp Group: GroupName"
  s = s.replace(/\s*[|\-·•:–—]\s*whatsapp(?:\s+group(?:\s+invite)?)?\s*$/i, "").trim();
  s = s.replace(/^\s*whatsapp(?:\s+group)?(?:\s+invite)?\s*[:\-|·•–—]\s*/i, "").trim();
  if (!s) return null;
  if (GENERIC_TITLES.has(s.toLowerCase().trim())) return null;
  // Reject if too short or just punctuation
  if (s.replace(/[\W_]+/g, "").length < 2) return null;
  return s;
}

// Try to find the group name in places other than og:title — used as a
// fallback when WhatsApp serves a generic og:title for a valid group.
function extractFallbackName(html: string, ogDescription: string | null): string | null {
  // 1. <title> tag
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const fromTitle = cleanCandidateName(titleMatch?.[1]);
  if (fromTitle) return fromTitle;

  // 2. <h3> heading — WhatsApp's invite page typically renders the group name in an h3.
  const h3Match = html.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
  if (h3Match) {
    const stripped = h3Match[1].replace(/<[^>]+>/g, " ").trim();
    const fromH3 = cleanCandidateName(stripped);
    if (fromH3) return fromH3;
  }

  // 3. og:description sometimes leads with the group name, e.g.
  //    "Join the group 'GroupName' via this invite link" or
  //    "GroupName · 123 members"
  if (ogDescription) {
    const desc = ogDescription.trim();
    // "GroupName · 123 members" or "GroupName • 123 members"
    const sepMatch = desc.match(/^(.+?)\s*[·•|]\s*\d/);
    const fromSep = cleanCandidateName(sepMatch?.[1]);
    if (fromSep) return fromSep;
    // "Join the 'GroupName' group" / 'group "GroupName"'
    const quoted = desc.match(/['"\u201C\u2018]([^'"\u201D\u2019]{2,80})['"\u201D\u2019]/);
    const fromQuoted = cleanCandidateName(quoted?.[1]);
    if (fromQuoted) return fromQuoted;
  }

  return null;
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

// Look for "X members" / "X participants" in the page body OR description.
// Valid invite links advertise a member count; revoked/reset links don't.
function detectHasMembers(html: string, ogDescription: string | null): boolean {
  const haystacks = [ogDescription || "", html];
  const patterns = [
    /\b\d{1,3}(?:[,.]\d{3})*\s*(?:members?|participants?)\b/i,
    /\b(?:members?|participants?)\s*[:\-]?\s*\d{1,3}(?:[,.]\d{3})*/i,
  ];
  for (const h of haystacks) {
    for (const re of patterns) {
      if (re.test(h)) return true;
    }
  }
  return false;
}

export function isValidWhatsAppLink(link: string): boolean {
  return /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]{10,}$/.test(link.trim());
}

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

      // HARD evidence the link is broken — explicit revoked/invalid text.
      for (const marker of INVALID_MARKERS) {
        if (lower.includes(marker)) {
          return { ok: false, name: null, imageUrl: null, reason: "Link reset or revoked" };
        }
      }

      const ogTitle = metaContent(html, "og:title");
      const ogImage = metaContent(html, "og:image");
      const ogDescription = metaContent(html, "og:description");
      const hasMembers = detectHasMembers(html, ogDescription);

      // No metadata at all → broken link (hard).
      if (!ogTitle && !ogImage) {
        return { ok: false, name: null, imageUrl: null, reason: "No group preview available" };
      }

      const titleIsGeneric =
        !ogTitle || GENERIC_TITLES.has(ogTitle.toLowerCase().trim());

      // If og:title is generic, try harder to find the real name from the
      // page <title>, an <h3>, or og:description before giving up.
      const fallbackName = titleIsGeneric
        ? extractFallbackName(html, ogDescription)
        : null;

      // Generic title, no fallback name, AND no member count → soft broken.
      // Otherwise the link is alive (even if name preview is weird).
      if (titleIsGeneric && !fallbackName && !hasMembers) {
        return {
          ok: false,
          name: null,
          imageUrl: ogImage || null,
          reason: "Generic preview, no member count (likely reset)",
          softBroken: true,
          hasMembers: false,
        };
      }

      // Prefer specific og:title, then fallback name, else null.
      const name = titleIsGeneric ? fallbackName : cleanCandidateName(ogTitle);
      return {
        ok: true,
        name: name ?? null,
        imageUrl: ogImage || null,
        hasMembers,
      };
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
