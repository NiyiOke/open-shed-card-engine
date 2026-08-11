export const CHAT_MESSAGE_LIMIT = 48;

export const CHAT_PHRASES = [
  { id: "your_turn", label: "Your turn" },
  { id: "nice_play", label: "Nice play" },
  { id: "one_second", label: "One second" },
  { id: "ready", label: "Ready" },
  { id: "good_game", label: "Good game" },
  { id: "rematch", label: "Rematch?" },
] as const;

export const CHAT_REACTIONS = [
  { id: "wave", icon: "👋", label: "Wave" },
  { id: "clap", icon: "👏", label: "Clap" },
  { id: "laugh", icon: "😄", label: "Laugh" },
  { id: "surprised", icon: "😮", label: "Surprised" },
  { id: "thinking", icon: "🤔", label: "Thinking" },
  { id: "fire", icon: "🔥", label: "Fire" },
] as const;

export const CHAT_REPORT_REASONS = [
  { id: "harassment", label: "Harassment or bullying" },
  { id: "hate", label: "Hateful conduct" },
  { id: "sexual_grooming", label: "Sexual content or grooming" },
  { id: "threat_self_harm", label: "Threats or self-harm" },
  { id: "personal_information", label: "Sharing personal information" },
  { id: "spam_scam", label: "Spam or scam" },
  { id: "cheating", label: "Cheating or unfair play" },
  { id: "other", label: "Something else" },
] as const;

export type ChatKind = "phrase" | "reaction";
export type ChatPhraseId = (typeof CHAT_PHRASES)[number]["id"];
export type ChatReactionId = (typeof CHAT_REACTIONS)[number]["id"];
export type ChatContentId = ChatPhraseId | ChatReactionId;
export type ChatReportReason = (typeof CHAT_REPORT_REASONS)[number]["id"];

export type ChatMessage = {
  id: string;
  senderPlayerId: string;
  senderDisplayName: string;
  kind: ChatKind;
  contentId: ChatContentId;
  createdAt: number;
};

export type ChatPage = {
  messages: ChatMessage[];
  nextCursor: string | null;
  serverTime: number;
  viewer: {
    mutedPlayerIds: string[];
    blockedPlayerIds: string[];
  };
};

const PHRASE_IDS = new Set<string>(CHAT_PHRASES.map(({ id }) => id));
const REACTION_IDS = new Set<string>(CHAT_REACTIONS.map(({ id }) => id));
const OPAQUE_MESSAGE_ID = /^[0-9a-f]{32}$/;

export function parseChatPage(value: unknown): ChatPage | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["messages", "nextCursor", "serverTime", "viewer"]) ||
    !Array.isArray(value.messages)
  ) return null;
  if (value.messages.length > CHAT_MESSAGE_LIMIT) return null;
  if (
    value.nextCursor !== null &&
    (typeof value.nextCursor !== "string" || !OPAQUE_MESSAGE_ID.test(value.nextCursor))
  ) {
    return null;
  }
  if (
    !isRecord(value.viewer) ||
    !hasExactKeys(value.viewer, ["mutedPlayerIds", "blockedPlayerIds"]) ||
    !isPlayerIdList(value.viewer.mutedPlayerIds) ||
    !isPlayerIdList(value.viewer.blockedPlayerIds)
  ) {
    return null;
  }
  if (
    !Number.isSafeInteger(value.serverTime) ||
    (value.serverTime as number) < 0 ||
    (value.serverTime as number) > 8_640_000_000_000_000
  ) {
    return null;
  }

  const messages: ChatMessage[] = [];
  for (const candidate of value.messages) {
    const message = parseChatMessage(candidate);
    if (!message) return null;
    messages.push(message);
  }
  return {
    messages,
    nextCursor: value.nextCursor as string | null,
    serverTime: value.serverTime as number,
    viewer: {
      mutedPlayerIds: [...value.viewer.mutedPlayerIds],
      blockedPlayerIds: [...value.viewer.blockedPlayerIds],
    },
  };
}

export function chatContentPresentation(
  kind: ChatKind,
  contentId: string,
): { icon: string | null; label: string } | null {
  if (kind === "phrase") {
    const phrase = CHAT_PHRASES.find((candidate) => candidate.id === contentId);
    return phrase ? { icon: null, label: phrase.label } : null;
  }
  const reaction = CHAT_REACTIONS.find((candidate) => candidate.id === contentId);
  return reaction ? { icon: reaction.icon, label: reaction.label } : null;
}

function parseChatMessage(value: unknown): ChatMessage | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "senderPlayerId",
      "senderDisplayName",
      "kind",
      "contentId",
      "createdAt",
    ])
  ) return null;
  if (
    typeof value.id !== "string" ||
    !OPAQUE_MESSAGE_ID.test(value.id) ||
    !isOpaqueText(value.senderPlayerId, 128) ||
    typeof value.senderDisplayName !== "string" ||
    value.senderDisplayName.length < 1 ||
    value.senderDisplayName.length > 48 ||
    value.senderDisplayName.trim() !== value.senderDisplayName ||
    hasControlCharacter(value.senderDisplayName) ||
    !Number.isSafeInteger(value.createdAt) ||
    (value.createdAt as number) < 0 ||
    (value.createdAt as number) > 8_640_000_000_000_000
  ) {
    return null;
  }
  if (value.kind === "phrase" && PHRASE_IDS.has(String(value.contentId))) {
    return {
      id: value.id,
      senderPlayerId: value.senderPlayerId,
      senderDisplayName: value.senderDisplayName,
      kind: "phrase",
      contentId: value.contentId as ChatPhraseId,
      createdAt: value.createdAt as number,
    };
  }
  if (value.kind === "reaction" && REACTION_IDS.has(String(value.contentId))) {
    return {
      id: value.id,
      senderPlayerId: value.senderPlayerId,
      senderDisplayName: value.senderDisplayName,
      kind: "reaction",
      contentId: value.contentId as ChatReactionId,
      createdAt: value.createdAt as number,
    };
  }
  return null;
}

function isOpaqueText(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlayerIdList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > 64) return false;
  const unique = new Set<string>();
  for (const playerId of value) {
    if (!isOpaqueText(playerId, 128) || unique.has(playerId)) return false;
    unique.add(playerId);
  }
  return true;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
