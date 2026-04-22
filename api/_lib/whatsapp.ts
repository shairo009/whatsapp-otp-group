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

// Cyrillic / Greek / Armenian / Coptic / Cherokee homoglyphs that look
// identical (or near-identical) to Latin letters. Users love these for
// "OTP" group names because they bypass naive substring matching: e.g.
// "ОТР" (Cyrillic O, T, R-lookalike) renders the same as "OTP" in WhatsApp.
const HOMOGLYPHS: Record<string, string> = {
  // === Cyrillic uppercase ===
  "\u0410":"A","\u0412":"B","\u0415":"E","\u041A":"K","\u041C":"M",
  "\u041D":"H","\u041E":"O","\u0420":"P","\u0421":"C","\u0422":"T",
  "\u0425":"X","\u0406":"I","\u0408":"J","\u0405":"S","\u04AE":"Y",
  "\u0470":"P","\u0474":"V","\u051A":"Q","\u051C":"W","\u050C":"G",
  "\u04C0":"I","\u04CF":"i","\u048A":"I","\u04AC":"T","\u04A0":"K",
  "\u0400":"E","\u0401":"E","\u0403":"F","\u0404":"E","\u0407":"I",
  "\u040C":"K","\u040D":"I","\u040E":"Y","\u0496":"X","\u04B2":"X",
  "\u04C1":"X","\u04C3":"K","\u04C5":"L","\u04C7":"H","\u04C9":"N",
  "\u04CB":"Y","\u04CD":"M","\u04E2":"N","\u04EE":"Y","\u04F0":"Y",
  "\u04F2":"Y","\u04F4":"Y","\u04F8":"H","\u04FA":"G",
  // === Cyrillic lowercase ===
  "\u0430":"a","\u0435":"e","\u043A":"k","\u043E":"o","\u0440":"p",
  "\u0441":"c","\u0445":"x","\u0443":"y","\u0456":"i","\u0458":"j",
  "\u0455":"s","\u04CE":"m","\u04BB":"h","\u04AF":"y","\u051B":"q",
  "\u051D":"w","\u050D":"g","\u04BD":"h","\u0501":"d",
  "\u0461":"w","\u0463":"b","\u0475":"v","\u04A3":"n",
  "\u0450":"e","\u0451":"e","\u0454":"e","\u0457":"i","\u045C":"k",
  "\u045D":"i","\u045E":"y","\u04BC":"h","\u04CA":"y","\u04CC":"m",
  "\u04BF":"h","\u0499":"3","\u0433":"r","\u0442":"m","\u04D9":"a",
  // === Greek uppercase ===
  "\u0391":"A","\u0392":"B","\u0395":"E","\u0396":"Z","\u0397":"H",
  "\u0399":"I","\u039A":"K","\u039C":"M","\u039D":"N","\u039F":"O",
  "\u03A1":"P","\u03A4":"T","\u03A5":"Y","\u03A7":"X","\u03A6":"O",
  "\u03BF":"o","\u03C1":"p","\u03C4":"t","\u03B9":"i","\u03BD":"v",
  "\u03BA":"k","\u03B1":"a","\u03B5":"e","\u03BC":"u","\u03C7":"x",
  "\u03C5":"u","\u03C9":"w","\u03B7":"n","\u03B2":"B","\u03B6":"z",
  "\u0398":"O","\u039B":"A","\u039E":"E","\u03A0":"H",
  "\u03A3":"E","\u03D1":"t","\u03D2":"Y","\u03D5":"o","\u03DD":"F",
  "\u03DE":"Q","\u03E2":"W","\u03E4":"O","\u03F3":"j","\u03F4":"O",
  // === Armenian look-alikes (FULL SET) ===
  "\u0531":"U","\u0532":"F","\u0533":"Q","\u0534":"T","\u0535":"E",
  "\u0536":"Q","\u0537":"E","\u0538":"C","\u053A":"J","\u053F":"Y",
  "\u0540":"H","\u0541":"Q","\u0548":"O","\u054B":"Q","\u054C":"P",
  "\u054D":"U","\u054F":"S","\u0552":"L","\u0553":"O","\u0555":"O",
  "\u0556":"D","\u0562":"p","\u0563":"q","\u0564":"r","\u0566":"q",
  "\u0567":"t","\u056A":"d","\u056F":"l","\u0570":"h","\u0571":"q",
  "\u0573":"6","\u0574":"u","\u0575":"j","\u0576":"u","\u0578":"n",
  "\u057A":"w","\u057B":"q","\u057C":"n","\u057D":"u","\u057F":"in",
  "\u0581":"g","\u0582":"L","\u0584":"p","\u0585":"o","\u0586":"d",
  // === Coptic (UPPER+LOWER) — many duplicate Greek but distinct codepoints ===
  "\u2C80":"A","\u2C82":"B","\u2C84":"G","\u2C86":"D","\u2C88":"E",
  "\u2C8A":"S","\u2C8C":"Z","\u2C8E":"H","\u2C90":"T","\u2C92":"I",
  "\u2C94":"K","\u2C96":"L","\u2C98":"M","\u2C9A":"N",
  "\u2C9C":"E","\u2C9E":"O","\u2CA0":"R","\u2CA2":"S",
  "\u2CA4":"U","\u2CA6":"F","\u2CA8":"K","\u2CAA":"P",
  "\u2CAC":"O","\u2CAE":"C","\u2CB0":"T",
  "\u2C81":"a","\u2C83":"b","\u2C89":"e","\u2C8F":"h","\u2C93":"i",
  "\u2C95":"k","\u2C97":"l","\u2C99":"m","\u2C9B":"n","\u2C9D":"e",
  "\u2C9F":"o","\u2CA1":"p","\u2CA3":"t","\u2CA5":"u","\u2CA7":"f",
  "\u2CA9":"k","\u2CAB":"h","\u2CAD":"c","\u2CAF":"c","\u2CB1":"t",
  "\u2CB3":"a",
  // === Cherokee letters that mimic Latin (FULL practical set) ===
  "\u13A0":"D","\u13A1":"R","\u13A2":"T","\u13A3":"i","\u13A6":"W",
  "\u13A9":"Z","\u13AA":"L","\u13AB":"C","\u13AC":"C","\u13B1":"E",
  "\u13B3":"S","\u13B7":"J","\u13BB":"H","\u13BD":"Y","\u13BE":"G",
  "\u13C0":"G","\u13C1":"h","\u13C2":"M","\u13C3":"H","\u13CF":"P",
  "\u13D5":"K","\u13D9":"V","\u13DA":"S","\u13DD":"C","\u13DE":"L",
  "\u13DF":"C","\u13E2":"T","\u13E6":"B","\u13E7":"F","\u13EB":"V",
  "\u13EF":"P","\u13F4":"B","\u13F5":"G",
  // === Georgian-like / Glagolitic rarities (skip, rarely abused) ===
  // === Letter-like math / symbol operators ===
  "\u2126":"O", // ohm (Ω)
  "\u212A":"K", // Kelvin sign
  "\u212B":"A", // Angstrom sign
  "\u00B5":"u", // micro sign
  "\u0299":"B", "\u00DF":"B", "\u00D8":"O", "\u00F8":"o", "\u00DE":"P",
  "\u00FE":"p", "\u00D0":"D", "\u00F0":"o",
  // === Digit homoglyphs ===
  "\u04E0":"3","\u0417":"3","\u0437":"3", // Cyrillic 3-lookalikes
  "\u0431":"6", // Cyrillic б often used as 6
  "\u07C0":"0","\u0BE6":"0","\u0ED0":"0", // other-script zero-lookalikes
  "\u06F0":"0","\u0660":"0", // arabic-indic 0
  "\u0661":"1","\u06F1":"1",
  "\u0662":"2","\u06F2":"2",
  "\u0663":"3","\u06F3":"3",
  "\u0664":"4","\u06F4":"4",
  "\u0665":"5","\u06F5":"5",
  "\u0666":"6","\u06F6":"6",
  "\u0667":"7","\u06F7":"7",
  "\u0668":"8","\u06F8":"8",
  "\u0669":"9","\u06F9":"9",
  // Devanagari digits (Hindi)
  "\u0966":"0","\u0967":"1","\u0968":"2","\u0969":"3","\u096A":"4",
  "\u096B":"5","\u096C":"6","\u096D":"7","\u096E":"8","\u096F":"9",
  // Bengali digits
  "\u09E6":"0","\u09E7":"1","\u09E8":"2","\u09E9":"3","\u09EA":"4",
  "\u09EB":"5","\u09EC":"6","\u09ED":"7","\u09EE":"8","\u09EF":"9",
  // === Latin ligatures / misc tokens ===
  "\u0153":"oe", "\u0152":"OE", "\u00E6":"ae", "\u00C6":"AE",
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
  // Enclosed Alphanumeric Supplement (emoji-style boxed/circled letters):
  //   🄐..🄩  Parenthesized Latin Capital Letter A..Z   (U+1F110..U+1F129)
  //   🄰..🅉  Squared Latin Capital Letter A..Z         (U+1F130..U+1F149)
  //   🅐..🅩  Negative Circled Latin Capital Letter A..Z (U+1F150..U+1F169)
  //   🅰..🆉  Negative Squared Latin Capital Letter A..Z (U+1F170..U+1F189)
  if (cp >= 0x1f110 && cp <= 0x1f129) return String.fromCharCode("A".charCodeAt(0) + (cp - 0x1f110));
  if (cp >= 0x1f130 && cp <= 0x1f149) return String.fromCharCode("A".charCodeAt(0) + (cp - 0x1f130));
  if (cp >= 0x1f150 && cp <= 0x1f169) return String.fromCharCode("A".charCodeAt(0) + (cp - 0x1f150));
  if (cp >= 0x1f170 && cp <= 0x1f189) return String.fromCharCode("A".charCodeAt(0) + (cp - 0x1f170));
  // Keycap digits 0..9 with U+20E3 combining mark (e.g. 1️⃣). The digit
  // itself comes through fine; the keycap suffix gets stripped by the
  // combining-mark removal in normalizeFancy. No mapping needed here.
  // Fullwidth Latin: A..Z (U+FF21..U+FF3A), a..z (U+FF41..U+FF5A), 0..9 (U+FF10..U+FF19)
  if (cp >= 0xff21 && cp <= 0xff3a) return String.fromCharCode("A".charCodeAt(0) + (cp - 0xff21));
  if (cp >= 0xff41 && cp <= 0xff5a) return String.fromCharCode("a".charCodeAt(0) + (cp - 0xff41));
  if (cp >= 0xff10 && cp <= 0xff19) return String.fromCharCode("0".charCodeAt(0) + (cp - 0xff10));
  // Parenthesized Latin small: ⒜..⒵ (U+249C..U+24B5)
  if (cp >= 0x249c && cp <= 0x24b5) return String.fromCharCode("a".charCodeAt(0) + (cp - 0x249c));
  // Regional indicators: 🇦..🇿 (U+1F1E6..U+1F1FF) → A..Z (flag-emoji letters)
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return String.fromCharCode("A".charCodeAt(0) + (cp - 0x1f1e6));
  // Tag characters: U+E0020..U+E007E → printable ASCII
  if (cp >= 0xe0020 && cp <= 0xe007e) return String.fromCharCode(cp - 0xe0000);
  // Subscript / superscript digits: ₀..₉ (U+2080..U+2089), ⁰..⁹ (most via NFKD,
  // but include explicitly for safety): U+2070, U+00B9, U+00B2, U+00B3, U+2074..U+2079
  if (cp >= 0x2080 && cp <= 0x2089) return String.fromCharCode("0".charCodeAt(0) + (cp - 0x2080));
  if (cp === 0x2070) return "0"; if (cp === 0x00B9) return "1";
  if (cp === 0x00B2) return "2"; if (cp === 0x00B3) return "3";
  if (cp >= 0x2074 && cp <= 0x2079) return String.fromCharCode("4".charCodeAt(0) + (cp - 0x2074));
  // === Latin Letter Small Capitals (full A..Z) ===
  // IPA / phonetic chars that LOOK like ALL-CAPS letters but are lowercase
  // codepoints. Irregular: scattered across IPA Extensions, Phonetic Ext.,
  // and Latin Extended-D blocks. Complete A..Z below.
  const SMALL_CAPS: Record<number, string> = {
    0x1D00:"A", 0x0299:"B", 0x1D04:"C", 0x1D05:"D", 0x1D07:"E",
    0xA730:"F", 0x0262:"G", 0x029C:"H", 0x026A:"I", 0x1D0A:"J",
    0x1D0B:"K", 0x029F:"L", 0x1D0D:"M", 0x0274:"N", 0x1D0F:"O",
    0x1D18:"P", 0xA7AF:"Q", 0x0280:"R", 0xA731:"S", 0x1D1B:"T",
    0x1D1C:"U", 0x1D20:"V", 0x1D21:"W", /* X — no standard small-cap */
    0x028F:"Y", 0x1D22:"Z",
    // alt small-cap forms
    0xA7AE:"I", 0xA7B2:"J",
  };
  if (SMALL_CAPS[cp]) return SMALL_CAPS[cp];
  // === Modifier Letter / Superscript Latin Capitals (full where exists) ===
  // U+1D2C..U+1D42 + scattered. Some letters (C, F, Q, S, X, Y, Z) have no
  // official superscript-capital codepoint and are simply not mappable here.
  const MOD_CAPS: Record<number, string> = {
    0x1D2C:"A", 0x1D2E:"B", 0x1D30:"D", 0x1D31:"E", 0x1D33:"G",
    0x1D34:"H", 0x1D35:"I", 0x1D36:"J", 0x1D37:"K", 0x1D38:"L",
    0x1D39:"M", 0x1D3A:"N", 0x1D3C:"O", 0x1D3E:"P", 0x1D3F:"R",
    0x1D40:"T", 0x1D41:"U", 0x2C7D:"V", 0x1D42:"W",
  };
  if (MOD_CAPS[cp]) return MOD_CAPS[cp];
  // === Modifier Letter / Superscript Latin Small (full a..z where exists) ===
  // 'q' has no standard superscript codepoint.
  const MOD_SMALL: Record<number, string> = {
    0x1D43:"a", 0x1D47:"b", 0x1D9C:"c", 0x1D48:"d", 0x1D49:"e",
    0x1DA0:"f", 0x1D4D:"g", 0x02B0:"h", 0x2071:"i", 0x02B2:"j",
    0x1D4F:"k", 0x02E1:"l", 0x1D50:"m", 0x207F:"n", 0x1D52:"o",
    0x1D56:"p", 0x02B3:"r", 0x02E2:"s", 0x1D57:"t", 0x1D58:"u",
    0x1D5B:"v", 0x02B7:"w", 0x02E3:"x", 0x02B8:"y", 0x1DBB:"z",
  };
  if (MOD_SMALL[cp]) return MOD_SMALL[cp];
  // === Dingbat / circled digit alternates (1..10 → '1'..'0') ===
  // ①..⑨ U+2460..U+2468  ➀..➈ U+2780..U+2788  ➊..➒ U+278A..U+2792
  // ❶..❾ U+2776..U+277E  most NFKD-decompose to ASCII, but include for safety.
  if (cp >= 0x2460 && cp <= 0x2468) return String.fromCharCode("1".charCodeAt(0) + (cp - 0x2460));
  if (cp >= 0x2776 && cp <= 0x277E) return String.fromCharCode("1".charCodeAt(0) + (cp - 0x2776));
  if (cp >= 0x2780 && cp <= 0x2788) return String.fromCharCode("1".charCodeAt(0) + (cp - 0x2780));
  if (cp >= 0x278A && cp <= 0x2792) return String.fromCharCode("1".charCodeAt(0) + (cp - 0x278A));
  if (cp === 0x24EA || cp === 0x24FF || cp === 0x2789 || cp === 0x2793 || cp === 0x277F) return "0";
  // === Double-struck digits 𝟘..𝟡 are inside the 1D7xx block above. ===
  // === IPA Extensions (U+0250..U+02AF) — many are Latin-lookalikes ===
  const IPA: Record<number, string> = {
    0x0250:"a", 0x0251:"a", 0x0252:"a", 0x0253:"b", 0x0254:"o",
    0x0255:"c", 0x0256:"d", 0x0257:"d", 0x0258:"e", 0x0259:"e",
    0x025A:"e", 0x025B:"e", 0x025C:"e", 0x025D:"e", 0x025E:"e",
    0x025F:"j", 0x0260:"g", 0x0261:"g", 0x0263:"y", 0x0264:"y",
    0x0265:"h", 0x0266:"h", 0x0267:"h", 0x0268:"i", 0x0269:"i",
    0x026B:"l", 0x026C:"l", 0x026D:"l", 0x026E:"l", 0x026F:"m",
    0x0270:"m", 0x0271:"m", 0x0272:"n", 0x0273:"n", 0x0275:"o",
    0x0276:"o", 0x0277:"o", 0x0278:"f", 0x0279:"r", 0x027A:"r",
    0x027B:"r", 0x027C:"r", 0x027D:"r", 0x027E:"r", 0x027F:"r",
    0x0281:"r", 0x0282:"s", 0x0283:"s", 0x0284:"j", 0x0285:"s",
    0x0286:"s", 0x0287:"t", 0x0288:"t", 0x0289:"u", 0x028A:"u",
    0x028B:"v", 0x028C:"v", 0x028D:"w", 0x028E:"y", 0x0290:"z",
    0x0291:"z", 0x0292:"z", 0x0293:"z", 0x0294:"?", 0x0295:"?",
    0x029A:"e", 0x029B:"G", 0x029D:"j", 0x029E:"k",
    0x02A0:"q", 0x02A1:"?", 0x02A2:"?", 0x02A3:"dz", 0x02A4:"dz",
    0x02A5:"dz", 0x02A6:"ts", 0x02A7:"ts", 0x02A8:"tc", 0x02A9:"fn",
    0x02AA:"ls", 0x02AB:"lz", 0x02AC:"w", 0x02AD:"h", 0x02AE:"h",
    0x02AF:"h",
  };
  if (IPA[cp]) return IPA[cp];
  // === Latin Extended-C (U+2C60..U+2C7F) — barred/stroked/turned letters ===
  const LATIN_EXT_C: Record<number, string> = {
    0x2C60:"L", 0x2C61:"l", 0x2C62:"L", 0x2C63:"P", 0x2C64:"R",
    0x2C65:"a", 0x2C66:"t", 0x2C67:"H", 0x2C68:"h", 0x2C69:"K",
    0x2C6A:"k", 0x2C6B:"Z", 0x2C6C:"z", 0x2C6E:"M", 0x2C6F:"A",
    0x2C70:"A", 0x2C71:"v", 0x2C72:"W", 0x2C73:"w", 0x2C74:"v",
    0x2C75:"H", 0x2C76:"h", 0x2C78:"e", 0x2C79:"r", 0x2C7A:"o",
    0x2C7B:"e", 0x2C7C:"j", 0x2C7E:"S", 0x2C7F:"Z",
  };
  if (LATIN_EXT_C[cp]) return LATIN_EXT_C[cp];
  // === Latin Extended-D (U+A720..U+A7FF) selected Latin-lookalikes ===
  // (Small-caps in this range are already handled above; add the rest.)
  const LATIN_EXT_D: Record<number, string> = {
    0x0180:"b", 0x0181:"B", 0x0182:"B", 0x0183:"b", 0x0184:"H",
    0x0185:"h", 0x0187:"C", 0x0188:"c", 0x018A:"D", 0x018B:"D",
    0x018C:"d", 0x0191:"F", 0x0192:"f", 0x0193:"G", 0x0195:"hv",
    0x0197:"I", 0x0198:"K", 0x0199:"k", 0x019A:"l", 0x019D:"N",
    0x019E:"n", 0x01A0:"O", 0x01A1:"o", 0x01A4:"P", 0x01A5:"p",
    0x01AB:"t", 0x01AC:"T", 0x01AD:"t", 0x01AE:"T", 0x01AF:"U",
    0x01B0:"u", 0x01B2:"V", 0x01B3:"Y", 0x01B4:"y", 0x01B5:"Z",
    0x01B6:"z", 0x01BB:"2", 0x01C0:"|", 0x01C3:"!",
    0x0220:"N", 0x0221:"d", 0x0224:"Z", 0x0225:"z", 0x0234:"l",
    0x0235:"n", 0x0236:"t", 0x0237:"j",
    0x023A:"A", 0x023B:"C", 0x023C:"c", 0x023D:"L", 0x023E:"T",
    0x023F:"s", 0x0240:"z", 0x0243:"B", 0x0244:"U", 0x0246:"E",
    0x0247:"e", 0x0248:"J", 0x0249:"j", 0x024A:"Q", 0x024B:"q",
    0x024C:"R", 0x024D:"r", 0x024E:"Y", 0x024F:"y",
    0xA7A0:"G", 0xA7A1:"g", 0xA7A2:"K", 0xA7A3:"k", 0xA7A4:"N",
    0xA7A5:"n", 0xA7A6:"R", 0xA7A7:"r", 0xA7A8:"S", 0xA7A9:"s",
    0xA7AA:"H", 0xA7AB:"E", 0xA7AC:"L", 0xA7AD:"L", 0xA7B0:"K",
    0xA7B1:"T",
  };
  if (LATIN_EXT_D[cp]) return LATIN_EXT_D[cp];
  // === Letterlike Symbols (U+2100..U+214F) — catch ones NFKD misses ===
  const LETTERLIKE: Record<number, string> = {
    0x2102:"C", 0x2105:"c", 0x2107:"E", 0x210A:"g", 0x210B:"H",
    0x210C:"H", 0x210D:"H", 0x210E:"h", 0x210F:"h", 0x2110:"I",
    0x2111:"I", 0x2112:"L", 0x2113:"l", 0x2115:"N", 0x2118:"P",
    0x2119:"P", 0x211A:"Q", 0x211B:"R", 0x211C:"R", 0x211D:"R",
    0x2124:"Z", 0x2128:"Z", 0x212C:"B", 0x212D:"C", 0x212F:"e",
    0x2130:"E", 0x2131:"F", 0x2132:"F", 0x2133:"M", 0x2134:"o",
    0x2135:"A", 0x2139:"i", 0x213C:"p", 0x213D:"y", 0x213E:"G",
    0x213F:"P", 0x2145:"D", 0x2146:"d", 0x2147:"e", 0x2148:"i",
    0x2149:"j",
  };
  if (LETTERLIKE[cp]) return LETTERLIKE[cp];
  // === Ligatures (U+FB00..U+FB06) — NFKD usually handles these, but include ===
  if (cp === 0xFB00) return "ff";
  if (cp === 0xFB01) return "fi";
  if (cp === 0xFB02) return "fl";
  if (cp === 0xFB03) return "ffi";
  if (cp === 0xFB04) return "ffl";
  if (cp === 0xFB05 || cp === 0xFB06) return "st";
  // === Cyrillic / Greek / Armenian / Coptic / Cherokee homoglyphs (table) ===
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
  // Reject if too short or just punctuation. IMPORTANT: many fancy unicode
  // chars (🅡🅐🅙, 🅾🆃🅿, ❶❷❸ …) are categorized as "Symbol" not "Letter",
  // so \p{L} alone misses them. Normalize to ASCII first, THEN count, so
  // stylized names like "🅡🅐🅙 🅞🅣🅟", "𝐎𝐓𝐏", "ОТР", "ⓞⓣⓟ" survive.
  const normalized = normalizeFancy(s);
  const letterCount =
    (normalized.match(/[A-Za-z0-9]/g) || []).length +
    (s.match(/[\p{L}\p{N}]/gu) || []).length;
  if (letterCount < 2) return null;
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

// ---------------------------------------------------------------------------
// FALLBACK: Microlink (https://microlink.io)
// WhatsApp frequently serves a generic / empty preview to datacenter IPs
// (Vercel / AWS / etc.), so direct fetches from our serverless function lose
// the group name and DP. Microlink renders the page with a real headless
// browser from a residential-style IP and returns the og:* metadata. The
// public free tier allows ~50 req/day per IP, which is enough for the
// fallback path (only the groups that direct-fetch failed on hit it).
// ---------------------------------------------------------------------------
async function fetchViaMicrolink(link: string): Promise<{
  name: string | null;
  imageUrl: string | null;
} | null> {
  try {
    const url = `https://api.microlink.io/?url=${encodeURIComponent(link)}&meta=true&audio=false&video=false&iframe=false`;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);
    const r = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": pickUA() },
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const data: any = await r.json().catch(() => null);
    if (!data || data.status !== "success" || !data.data) return null;
    const d = data.data;
    const rawTitle: string | null = d.title || d.publisher || null;
    const cleanedTitle = cleanCandidateName(rawTitle);
    let img: string | null = null;
    if (d.image && typeof d.image === "object") img = d.image.url || null;
    else if (typeof d.image === "string") img = d.image;
    if (!img && d.logo && typeof d.logo === "object") img = d.logo.url || null;
    // Microlink's "logo" for whatsapp.com is the WhatsApp brand mark — useless
    // as a group DP. Reject anything from whatsapp.com's static asset hosts.
    if (img && /static\.whatsapp\.net\/.+\/wa_logo/i.test(img)) img = null;
    if (img && /web\.whatsapp\.com\/favicon/i.test(img)) img = null;
    if (!cleanedTitle && !img) return null;
    return { name: cleanedTitle, imageUrl: img };
  } catch {
    return null;
  }
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
  const direct = await fetchGroupPreviewDirect(link);

  // Decide whether the direct result is "good enough". It's good if it gave
  // us BOTH a real name and an image. Otherwise, try Microlink to fill the
  // gaps — but never let a Microlink failure override a direct hard-broken
  // verdict (revoked / reset).
  const directHardBroken =
    !direct.ok &&
    !direct.softBroken &&
    !direct.rateLimited &&
    direct.reason === "Link reset or revoked";

  const directHasNameAndImage = Boolean(direct.name && direct.imageUrl);
  if (directHardBroken || directHasNameAndImage) return direct;

  // Try Microlink fallback for soft-broken / partial / rate-limited cases.
  const ml = await fetchViaMicrolink(link);
  if (ml && (ml.name || ml.imageUrl)) {
    // Microlink found something — promote to ok=true, fill any blanks from
    // the direct fetch when possible.
    return {
      ok: true,
      name: ml.name ?? direct.name ?? null,
      imageUrl: ml.imageUrl ?? direct.imageUrl ?? null,
      hasMembers: direct.hasMembers,
    };
  }
  return direct;
}

async function fetchGroupPreviewDirect(link: string): Promise<GroupPreview> {
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

      // No metadata at all → suspicious, but DON'T hard-remove. WhatsApp
      // sometimes serves an empty preview for healthy groups (UA detection,
      // geo blips, A/B tests). Treat as soft-broken so the cron grace
      // window can decide.
      if (!ogTitle && !ogImage) {
        return {
          ok: false,
          name: null,
          imageUrl: null,
          reason: "No group preview available",
          softBroken: true,
          hasMembers: false,
        };
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
