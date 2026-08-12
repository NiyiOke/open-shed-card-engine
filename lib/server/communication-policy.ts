import { GameRuleError } from "../game/errors";
import { getV15FeaturePolicy } from "./v15-feature-policy";

export const COMMUNICATION_MESSAGE_KINDS = ["phrase", "reaction", "text"] as const;
export type CommunicationMessageKind =
  (typeof COMMUNICATION_MESSAGE_KINDS)[number];
export type CuratedCommunicationMessageKind = Exclude<
  CommunicationMessageKind,
  "text"
>;

export const QUICK_PHRASE_IDS = [
  "your_turn",
  "nice_play",
  "one_second",
  "ready",
  "good_game",
  "rematch",
] as const;
export type QuickPhraseId = (typeof QUICK_PHRASE_IDS)[number];

export const REACTION_IDS = [
  "wave",
  "clap",
  "laugh",
  "surprised",
  "thinking",
  "fire",
] as const;
export type ReactionId = (typeof REACTION_IDS)[number];

export const REPORT_REASON_IDS = [
  "harassment",
  "hate",
  "sexual_grooming",
  "threat_self_harm",
  "personal_information",
  "spam_scam",
  "cheating",
  "other",
] as const;
export type ReportReasonId = (typeof REPORT_REASON_IDS)[number];

export type CommunicationContentId = QuickPhraseId | ReactionId;
export type CuratedCommunicationMessage = Readonly<{
  kind: CuratedCommunicationMessageKind;
  contentId: CommunicationContentId;
}>;
export type FreeTextCommunicationMessage = Readonly<{
  kind: "text";
  body: string;
}>;
export type CommunicationMessage =
  | CuratedCommunicationMessage
  | FreeTextCommunicationMessage;

export const COMMUNICATION_LIMITS = Object.freeze({
  messageRetentionMs: 24 * 60 * 60_000,
  reportRetentionMs: 90 * 24 * 60 * 60_000,
  messageScanLimit: 48,
  messageCooldownMs: 2_000,
  messageUserMinuteLimit: 10,
  messageRoomMinuteLimit: 60,
  reportUserHourLimit: 5,
  reportRoomHourLimit: 30,
  relationshipUserMinuteLimit: 30,
  relationshipRoomMinuteLimit: 120,
  cleanupBatchSize: 128,
  freeTextGraphemeLimit: 160,
});

const OPAQUE_ID_PATTERN = /^[a-f0-9]{32}$/;
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
const FREE_TEXT_FIELD_NAMES = new Set([
  "body",
  "caption",
  "comment",
  "content",
  "detail",
  "details",
  "freetext",
  "message",
  "text",
]);

export function parseCommunicationMessage(
  kind: unknown,
  contentId: unknown,
): CuratedCommunicationMessage {
  if (kind !== "phrase" && kind !== "reaction") {
    throw new GameRuleError(
      "INVALID_MESSAGE",
      "Choose an available phrase or reaction.",
      400,
    );
  }
  const allowed = kind === "phrase" ? QUICK_PHRASE_IDS : REACTION_IDS;
  if (
    typeof contentId !== "string" ||
    !(allowed as readonly string[]).includes(contentId)
  ) {
    throw new GameRuleError(
      "INVALID_MESSAGE",
      "Choose an available phrase or reaction.",
      400,
    );
  }
  return { kind, contentId: contentId as CommunicationContentId };
}

/** Normalizes a private-table message without ever logging or echoing rejected input. */
export function parseFreeTextMessage(body: unknown): FreeTextCommunicationMessage {
  if (typeof body !== "string") throw invalidFreeText();
  const normalized = body.normalize("NFKC");
  if (CONTROL_OR_BIDI_PATTERN.test(normalized)) throw invalidFreeText();
  const compact = normalized.replace(/\s+/gu, " ").trim();
  if (!compact || graphemeCount(compact) > COMMUNICATION_LIMITS.freeTextGraphemeLimit) {
    throw invalidFreeText();
  }
  if (
    URL_PATTERN.test(compact) ||
    OBFUSCATED_URL_PATTERN.test(compact) ||
    EMAIL_PATTERN.test(compact) ||
    PHONE_PATTERN.test(compact) ||
    SOCIAL_CONTACT_PATTERN.test(compact)
  ) {
    throw new GameRuleError(
      "CONTACT_DETAILS_NOT_ALLOWED",
      "Links and contact details are not allowed in table chat.",
      400,
    );
  }
  return { kind: "text", body: compact };
}

export function parseReportReason(value: unknown): ReportReasonId {
  if (
    typeof value !== "string" ||
    !(REPORT_REASON_IDS as readonly string[]).includes(value)
  ) {
    throw new GameRuleError(
      "INVALID_REPORT_REASON",
      "Choose one of the available report reasons.",
      400,
    );
  }
  return value as ReportReasonId;
}

export function assertExactJsonKeys(
  body: Record<string, unknown>,
  expectedKeys: readonly string[],
  code: string,
  message: string,
): void {
  const actual = Object.keys(body).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new GameRuleError(code, message, 400);
  }
}

export function hasRecognizedFreeTextField(
  body: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(body).some((key) => {
    if (allowed.has(key)) return false;
    return FREE_TEXT_FIELD_NAMES.has(key.normalize("NFKC").toLowerCase());
  });
}

export function requireOpaqueCommunicationId(
  value: unknown,
  code: string,
  message: string,
): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw new GameRuleError(code, message, 400);
  }
  return value;
}

export function createOpaqueCommunicationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function assertCommunicationEnabled(): void {
  if (!getV15FeaturePolicy().communicationEnabled) {
    throw new GameRuleError(
      "COMMUNICATION_DISABLED",
      "Table communication is not available.",
      404,
    );
  }
}

export function assertFreeTextEnabled(): void {
  if (!getV15FeaturePolicy().freeTextEnabled) {
    throw new GameRuleError(
      "FREE_TEXT_DISABLED",
      "Free-text table messages are not available.",
      404,
    );
  }
}

function invalidFreeText(): GameRuleError {
  return new GameRuleError(
    "INVALID_FREE_TEXT",
    `Write a message of 1–${COMMUNICATION_LIMITS.freeTextGraphemeLimit} characters without hidden controls.`,
    400,
  );
}

function graphemeCount(value: string): number {
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  return [...segmenter.segment(value)].length;
}
