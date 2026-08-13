const CONTROL_OR_BIDI_PATTERN =
  /[\p{Cc}\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;
const URL_PATTERN = /(?:\bhttps?:\/\/|\bwww\.|\b[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+\b)/iu;
const OBFUSCATED_URL_PATTERN =
  /\b(?:dot|period)\s*(?:com|net|org|co|io|gg|me|app|uk)\b/iu;
const EMAIL_PATTERN =
  /[\p{L}\p{N}._%+-]+\s*(?:@|\bat\b)\s*[\p{L}\p{N}-]+(?:\s*\.\s*[\p{L}\p{N}-]+)+/iu;
const PHONE_PATTERN = /(?:\+?\d[\s().-]*){7,}/u;
const SOCIAL_CONTACT_PATTERN =
  /(?:@[\p{L}\p{N}_.-]{2,}|\b(?:discord|facebook|instagram|insta|snapchat|telegram|tiktok|twitter|whatsapp)\b\s*(?:[:@-]\s*)?[\p{L}\p{N}_.-]{2,}|\b(?:add|contact|dm|message)\s+me\b)/iu;

/** Browser- and server-safe boundary for text shown to strangers. */
export function hasUnsafePublicText(value: string): boolean {
  return (
    CONTROL_OR_BIDI_PATTERN.test(value) ||
    URL_PATTERN.test(value) ||
    OBFUSCATED_URL_PATTERN.test(value) ||
    EMAIL_PATTERN.test(value) ||
    PHONE_PATTERN.test(value) ||
    SOCIAL_CONTACT_PATTERN.test(value)
  );
}

export function hasUnsafeControlText(value: string): boolean {
  return CONTROL_OR_BIDI_PATTERN.test(value);
}
