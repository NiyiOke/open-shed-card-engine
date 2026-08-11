import { GAME_PROTOCOL_VERSION, RULES_VERSION } from "../game/types";
import { PUBLIC_HOST_SUPPRESSION_AFTER_MS } from "./room-lifecycle-policy";

export { PUBLIC_HOST_SUPPRESSION_AFTER_MS } from "./room-lifecycle-policy";

export const PUBLIC_LISTING_ID_LENGTH = 32;
export const PUBLIC_LISTING_ID_PATTERN = /^[0-9a-f]{32}$/;
export const PUBLIC_ROOM_CAPACITY = 6;
export const PUBLIC_DISCOVERY_TABLE_COUNT_CAP = 20;
export const PUBLIC_DISCOVERY_OPEN_SEAT_COUNT_CAP = 50;
export const PUBLIC_ROOM_PAGE_LIMIT_ANONYMOUS = 6;
export const PUBLIC_ROOM_PAGE_LIMIT_AUTHENTICATED = 20;
export const PUBLIC_DISCOVERY_CACHE_SECONDS = 30;
export const PUBLIC_ALIAS_MIN_LENGTH = 2;
export const PUBLIC_ALIAS_MAX_LENGTH = 24;
export const PUBLIC_WAITING_AGE_JUST_OPENED_MS = 2 * 60_000;
export const PUBLIC_WAITING_AGE_RECENT_MS = 10 * 60_000;

export const PUBLIC_PACES = ["casual", "quick"] as const;
export type PublicPace = (typeof PUBLIC_PACES)[number];
export type PublicWaitingAge = "just_opened" | "recent" | "waiting";

export type PublicRoomEligibilityReason =
  | "eligible"
  | "discovery_disabled"
  | "listing_not_listed"
  | "room_closed"
  | "room_expired"
  | "not_lobby"
  | "unsupported_protocol"
  | "unsupported_rules"
  | "host_mismatch"
  | "host_offline"
  | "missing_consent"
  | "empty"
  | "full"
  | "already_member"
  | "blocked";

export type PublicRoomEligibilityInput = {
  discoveryEnabled: boolean;
  listingState: "listed" | "unlisted" | "closed";
  roomStatus: "open" | "closed";
  gameStatus: "lobby" | "playing" | "finished";
  expiresAt: number;
  protocolVersion: number;
  rulesVersion: string;
  ownerMatchesHost: boolean;
  hostLastSeenAt: number | null;
  allMembersConsented: boolean;
  occupancy: number;
  viewerAlreadyMember: boolean;
  viewerBlocked: boolean;
  now: number;
};

export type PublicRoomEligibility = Readonly<{
  eligible: boolean;
  reason: PublicRoomEligibilityReason;
}>;

/** Generates a non-sequential 128-bit public locator encoded as lowercase hex. */
export function createPublicListingId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isPublicListingId(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_LISTING_ID_PATTERN.test(value);
}

export function parsePublicPace(value: unknown): PublicPace | null {
  return typeof value === "string" && PUBLIC_PACES.includes(value as PublicPace)
    ? (value as PublicPace)
    : null;
}

/**
 * Public aliases are explicit and deliberately narrower than private nicknames.
 * NFKC normalization prevents visually equivalent values from bypassing bounds;
 * the allowlist excludes control characters, links, emoji and punctuation-heavy
 * strings before an alias can cross the anonymous/public boundary.
 */
export function normalizePublicAlias(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const alias = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const length = Array.from(alias).length;
  if (length < PUBLIC_ALIAS_MIN_LENGTH || length > PUBLIC_ALIAS_MAX_LENGTH) {
    return null;
  }
  if (
    !/^[\p{L}\p{N}](?:[\p{L}\p{N} _'-]*[\p{L}\p{N}])?$/u.test(alias)
  ) {
    return null;
  }
  return alias;
}

export function classifyPublicWaitingAge(
  publishedAt: number,
  now: number,
): PublicWaitingAge {
  const age =
    Number.isFinite(publishedAt) && Number.isFinite(now)
      ? Math.max(0, now - publishedAt)
      : Number.POSITIVE_INFINITY;
  if (age < PUBLIC_WAITING_AGE_JUST_OPENED_MS) return "just_opened";
  if (age < PUBLIC_WAITING_AGE_RECENT_MS) return "recent";
  return "waiting";
}

export function capPublicCount(
  value: number,
  cap: number,
): Readonly<{ count: number; capped: boolean }> {
  const safeValue = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  const safeCap = Math.max(0, Math.trunc(cap));
  return Object.freeze({
    count: Math.min(safeValue, safeCap),
    capped: safeValue > safeCap,
  });
}

export function evaluatePublicRoomEligibility(
  input: PublicRoomEligibilityInput,
): PublicRoomEligibility {
  const reject = (reason: Exclude<PublicRoomEligibilityReason, "eligible">) =>
    Object.freeze({ eligible: false, reason });

  if (!input.discoveryEnabled) return reject("discovery_disabled");
  if (input.listingState !== "listed") return reject("listing_not_listed");
  if (input.roomStatus !== "open") return reject("room_closed");
  if (!Number.isFinite(input.expiresAt) || input.expiresAt <= input.now) {
    return reject("room_expired");
  }
  if (input.gameStatus !== "lobby") return reject("not_lobby");
  if (input.protocolVersion !== GAME_PROTOCOL_VERSION) {
    return reject("unsupported_protocol");
  }
  if (input.rulesVersion !== RULES_VERSION) return reject("unsupported_rules");
  if (!input.ownerMatchesHost) return reject("host_mismatch");
  if (
    input.hostLastSeenAt === null ||
    !Number.isFinite(input.hostLastSeenAt) ||
    input.hostLastSeenAt <= input.now - PUBLIC_HOST_SUPPRESSION_AFTER_MS
  ) {
    return reject("host_offline");
  }
  if (!input.allMembersConsented) return reject("missing_consent");
  if (!Number.isSafeInteger(input.occupancy) || input.occupancy <= 0) {
    return reject("empty");
  }
  if (input.viewerAlreadyMember) return reject("already_member");
  if (input.viewerBlocked) return reject("blocked");
  if (input.occupancy >= PUBLIC_ROOM_CAPACITY) return reject("full");
  return Object.freeze({ eligible: true, reason: "eligible" });
}
