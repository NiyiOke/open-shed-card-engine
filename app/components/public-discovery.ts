export const PUBLIC_PACES = ["casual", "quick"] as const;
export const PUBLIC_TABLE_COUNT_CAP = 20;
export const PUBLIC_OPEN_SEAT_COUNT_CAP = 50;
export const ROOM_ALIAS_MAX_LENGTH = 24;
export const ROOM_ALIAS_ERROR =
  "Use 2–24 letters or numbers. Spaces, apostrophes, underscores, and hyphens are allowed inside.";

export type PublicPace = (typeof PUBLIC_PACES)[number];
export type PublicWaitingAge = "just_opened" | "recent" | "waiting";

export type PublicAvailability = {
  enabled: true;
  tableCount: number;
  tableCountCapped: boolean;
  openSeatCount: number;
  openSeatCountCapped: boolean;
};

export type PublicRoomCard = {
  listingId: string;
  occupancy: number;
  capacity: number;
  pace: PublicPace;
  rulesProfile: "merciless-baseline-v1";
  waitingAge: PublicWaitingAge;
};

export type PublicRoomPage = {
  enabled: true;
  rooms: PublicRoomCard[];
  nextCursor: string | null;
};

export type ViewerListing = {
  state: "private" | "listed" | "suppressed";
  pace: PublicPace | null;
  version: number | null;
  canPublish: boolean;
  reason?: "NOT_HOST" | "NOT_LOBBY" | "NOT_SOLE_OCCUPANT" | "HOST_OFFLINE";
};

const WAITING_AGES = new Set<PublicWaitingAge>([
  "just_opened",
  "recent",
  "waiting",
]);
const LISTING_STATES = new Set<ViewerListing["state"]>([
  "private",
  "listed",
  "suppressed",
]);
const LISTING_REASONS = new Set<NonNullable<ViewerListing["reason"]>>([
  "NOT_HOST",
  "NOT_LOBBY",
  "NOT_SOLE_OCCUPANT",
  "HOST_OFFLINE",
]);
const OPAQUE_LISTING_ID = /^[0-9a-f]{32}$/;
const OPAQUE_CURSOR = OPAQUE_LISTING_ID;

export function parsePublicAvailability(value: unknown): PublicAvailability | null {
  if (!isRecord(value) || value.enabled !== true) return null;
  if (
    !isSafeCount(value.tableCount) ||
    value.tableCount > PUBLIC_TABLE_COUNT_CAP ||
    typeof value.tableCountCapped !== "boolean" ||
    (value.tableCountCapped && value.tableCount !== PUBLIC_TABLE_COUNT_CAP) ||
    !isSafeCount(value.openSeatCount) ||
    value.openSeatCount > PUBLIC_OPEN_SEAT_COUNT_CAP ||
    typeof value.openSeatCountCapped !== "boolean" ||
    (value.openSeatCountCapped &&
      value.openSeatCount !== PUBLIC_OPEN_SEAT_COUNT_CAP)
  ) {
    return null;
  }
  return {
    enabled: true,
    tableCount: value.tableCount,
    tableCountCapped: value.tableCountCapped,
    openSeatCount: value.openSeatCount,
    openSeatCountCapped: value.openSeatCountCapped,
  };
}

export function parsePublicRoomPage(
  value: unknown,
  maximumRooms = 20,
): PublicRoomPage | null {
  if (!isRecord(value) || value.enabled !== true || !Array.isArray(value.rooms)) {
    return null;
  }
  if (
    !Number.isSafeInteger(maximumRooms) ||
    maximumRooms < 0 ||
    maximumRooms > 20 ||
    value.rooms.length > maximumRooms
  ) {
    return null;
  }
  const rooms: PublicRoomCard[] = [];
  for (const candidate of value.rooms) {
    const room = parsePublicRoomCard(candidate);
    if (!room) return null;
    rooms.push(room);
  }
  if (
    value.nextCursor !== null &&
    (typeof value.nextCursor !== "string" || !OPAQUE_CURSOR.test(value.nextCursor))
  ) {
    return null;
  }
  return { enabled: true, rooms, nextCursor: value.nextCursor };
}

export function parseViewerListing(value: unknown): ViewerListing | null {
  if (!isRecord(value) || !LISTING_STATES.has(value.state as ViewerListing["state"])) {
    return null;
  }
  if (
    value.pace !== null &&
    !PUBLIC_PACES.includes(value.pace as PublicPace)
  ) {
    return null;
  }
  if (
    value.version !== null &&
    (!Number.isSafeInteger(value.version) || (value.version as number) < 0)
  ) {
    return null;
  }
  if (typeof value.canPublish !== "boolean") return null;
  if (
    value.reason !== undefined &&
    !LISTING_REASONS.has(value.reason as NonNullable<ViewerListing["reason"]>)
  ) {
    return null;
  }
  if (
    value.state === "private" &&
    value.pace !== null
  ) {
    return null;
  }
  if (
    value.state !== "private" &&
    (value.pace === null || value.version === null)
  ) {
    return null;
  }
  return {
    state: value.state as ViewerListing["state"],
    pace: value.pace as PublicPace | null,
    version: value.version as number | null,
    canPublish: value.canPublish,
    ...(value.reason ? { reason: value.reason as NonNullable<ViewerListing["reason"]> } : {}),
  };
}

export function cappedCountLabel(value: number, capped: boolean): string {
  return `${value}${capped ? "+" : ""}`;
}

export function normalizePublicListingId(value: unknown): string | null {
  return typeof value === "string" && OPAQUE_LISTING_ID.test(value) ? value : null;
}

export function normalizeRoomAlias(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function isValidRoomAlias(value: string): boolean {
  const alias = normalizeRoomAlias(value);
  const length = Array.from(alias).length;
  return (
    length >= 2 &&
    length <= ROOM_ALIAS_MAX_LENGTH &&
    !hasUnsafePublicText(alias) &&
    /^[\p{L}\p{N}][\p{L}\p{N} _'-]*[\p{L}\p{N}]$/u.test(alias)
  );
}

export function signInPathForListing(signInPath: string, listingId: string): string {
  const url = new URL(signInPath, "https://open-shed.local");
  url.searchParams.set("return_to", `/?listing=${encodeURIComponent(listingId)}`);
  return `${url.pathname}${url.search}`;
}

export function waitingAgeLabel(age: PublicWaitingAge): string {
  if (age === "just_opened") return "Just opened";
  if (age === "recent") return "Waiting a little while";
  return "Waiting for players";
}

export function publicJoinFailureMessage(code?: string): string {
  if (code === "PUBLIC_ROOM_FULL") {
    return "This table filled up just now. Choose another open table.";
  }
  if (code === "ROOM_CLOSED") {
    return "This table has closed. Choose another open table.";
  }
  if (code === "NO_ELIGIBLE_PUBLIC_ROOM") {
    return "No eligible open table is available right now. Refresh the pool or create one.";
  }
  if (code === "ALIAS_REQUIRED" || code === "INVALID_ALIAS") {
    return ROOM_ALIAS_ERROR;
  }
  return "This table is no longer available. Choose another open table.";
}

export function listingFailureMessage(code?: string): string {
  if (code === "VERSION_CONFLICT" || code === "LISTING_VERSION_CONFLICT") {
    return "The table changed while this was open. Review the latest status and try again.";
  }
  if (code === "INVALID_ALIAS" || code === "ALIAS_REQUIRED") {
    return ROOM_ALIAS_ERROR;
  }
  return "Public listing is unavailable for this table right now.";
}

export function listingUnavailableReason(reason?: ViewerListing["reason"]): string | null {
  if (reason === "NOT_SOLE_OCCUPANT") {
    return "A private table can only be published while you are its only player.";
  }
  if (reason === "HOST_OFFLINE") {
    return "Reconnect fully before publishing this table.";
  }
  if (reason === "NOT_LOBBY") {
    return "Only a waiting lobby can be published.";
  }
  if (reason === "NOT_HOST") return "Only the host can publish this table.";
  return null;
}

function parsePublicRoomCard(value: unknown): PublicRoomCard | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.listingId !== "string" ||
    !OPAQUE_LISTING_ID.test(value.listingId) ||
    !isSafeCount(value.occupancy) ||
    !isSafeCount(value.capacity) ||
    value.capacity !== 6 ||
    value.occupancy < 1 ||
    value.occupancy >= value.capacity ||
    !PUBLIC_PACES.includes(value.pace as PublicPace) ||
    value.rulesProfile !== "merciless-baseline-v1" ||
    !WAITING_AGES.has(value.waitingAge as PublicWaitingAge)
  ) {
    return null;
  }
  return {
    listingId: value.listingId,
    occupancy: value.occupancy,
    capacity: value.capacity,
    pace: value.pace as PublicPace,
    rulesProfile: "merciless-baseline-v1",
    waitingAge: value.waitingAge as PublicWaitingAge,
  };
}

function isSafeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
import { hasUnsafePublicText } from "../../lib/public-text-policy";
