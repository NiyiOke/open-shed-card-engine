import { RULES_VERSION } from "../game/types";
import {
  capPublicCount,
  classifyPublicWaitingAge,
  isPublicListingId,
  parsePublicPace,
  PUBLIC_DISCOVERY_OPEN_SEAT_COUNT_CAP,
  PUBLIC_DISCOVERY_TABLE_COUNT_CAP,
  PUBLIC_ROOM_CAPACITY,
  PUBLIC_ROOM_PAGE_LIMIT_AUTHENTICATED,
  type PublicPace,
  type PublicWaitingAge,
} from "./discovery-policy";

export type PublicRoomCard = Readonly<{
  listingId: string;
  occupancy: number;
  capacity: typeof PUBLIC_ROOM_CAPACITY;
  pace: PublicPace;
  rulesProfile: typeof RULES_VERSION;
  waitingAge: PublicWaitingAge;
}>;

export type PublicAvailability =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      tableCount: number;
      tableCountCapped: boolean;
      openSeatCount: number;
      openSeatCountCapped: boolean;
    }>;

export type PublicRoomsPage =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      rooms: readonly PublicRoomCard[];
      nextCursor: string | null;
    }>;

export type ViewerListingReason =
  | "NOT_HOST"
  | "NOT_LOBBY"
  | "NOT_SOLE_OCCUPANT"
  | "HOST_OFFLINE";

export type ViewerListing = Readonly<{
  state: "private" | "listed" | "suppressed";
  pace: PublicPace | null;
  version: number | null;
  canPublish: boolean;
  reason?: ViewerListingReason;
}>;

export const PUBLIC_DISCOVERY_DISABLED = Object.freeze({
  enabled: false,
}) satisfies PublicAvailability & PublicRoomsPage;

export function buildPublicRoomCard(
  input: {
    listingId: string;
    occupancy: number;
    pace: PublicPace;
    publishedAt: number;
  },
  now: number,
): PublicRoomCard {
  if (!isPublicListingId(input.listingId)) {
    throw new TypeError("Public listing ID is invalid.");
  }
  if (
    !Number.isSafeInteger(input.occupancy) ||
    input.occupancy <= 0 ||
    input.occupancy >= PUBLIC_ROOM_CAPACITY
  ) {
    throw new TypeError("Public room occupancy is invalid.");
  }
  const pace = parsePublicPace(input.pace);
  if (!pace) throw new TypeError("Public room pace is invalid.");

  return Object.freeze({
    listingId: input.listingId,
    occupancy: input.occupancy,
    capacity: PUBLIC_ROOM_CAPACITY,
    pace,
    rulesProfile: RULES_VERSION,
    waitingAge: classifyPublicWaitingAge(input.publishedAt, now),
  });
}

export function buildPublicAvailability(
  tableCount: number,
  openSeatCount: number,
): Extract<PublicAvailability, { enabled: true }> {
  const tables = capPublicCount(tableCount, PUBLIC_DISCOVERY_TABLE_COUNT_CAP);
  const seats = capPublicCount(
    openSeatCount,
    PUBLIC_DISCOVERY_OPEN_SEAT_COUNT_CAP,
  );
  return Object.freeze({
    enabled: true,
    tableCount: tables.count,
    tableCountCapped: tables.capped,
    openSeatCount: seats.count,
    openSeatCountCapped: seats.capped,
  });
}

export function buildPublicRoomsPage(
  rooms: readonly PublicRoomCard[],
  nextCursor: string | null,
): Extract<PublicRoomsPage, { enabled: true }> {
  if (rooms.length > PUBLIC_ROOM_PAGE_LIMIT_AUTHENTICATED) {
    throw new TypeError("Public room page is too large.");
  }
  if (nextCursor !== null && !isPublicListingId(nextCursor)) {
    throw new TypeError("Public room cursor is invalid.");
  }
  const safeRooms = rooms.map((room) => {
    if (
      !isPublicListingId(room.listingId) ||
      !Number.isSafeInteger(room.occupancy) ||
      room.occupancy <= 0 ||
      room.occupancy >= PUBLIC_ROOM_CAPACITY ||
      parsePublicPace(room.pace) === null ||
      room.rulesProfile !== RULES_VERSION ||
      !["just_opened", "recent", "waiting"].includes(room.waitingAge)
    ) {
      throw new TypeError("Public room card is invalid.");
    }
    return Object.freeze({
      listingId: room.listingId,
      occupancy: room.occupancy,
      capacity: PUBLIC_ROOM_CAPACITY,
      pace: room.pace,
      rulesProfile: RULES_VERSION,
      waitingAge: room.waitingAge,
    }) satisfies PublicRoomCard;
  });
  return Object.freeze({
    enabled: true,
    rooms: Object.freeze(safeRooms),
    nextCursor,
  });
}
