import { GameRuleError } from "../game/errors";
import { getV15FeaturePolicy } from "./v15-feature-policy";

export const COMMUNICATION_MESSAGE_KINDS = ["phrase", "reaction"] as const;
export type CommunicationMessageKind =
  (typeof COMMUNICATION_MESSAGE_KINDS)[number];

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
});

const OPAQUE_ID_PATTERN = /^[a-f0-9]{32}$/;
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
): {
  kind: CommunicationMessageKind;
  contentId: CommunicationContentId;
} {
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
