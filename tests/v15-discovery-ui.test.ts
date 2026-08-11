import assert from "node:assert/strict";
import test from "node:test";
import {
  cappedCountLabel,
  listingFailureMessage,
  PUBLIC_OPEN_SEAT_COUNT_CAP,
  PUBLIC_TABLE_COUNT_CAP,
  isValidRoomAlias,
  normalizeRoomAlias,
  parsePublicAvailability,
  parsePublicRoomPage,
  parseViewerListing,
  publicJoinFailureMessage,
  waitingAgeLabel,
} from "../app/components/public-discovery";

test("anonymous discovery accepts only the allowlisted public card contract", () => {
  const page = parsePublicRoomPage({
    enabled: true,
    rooms: [{
      listingId: "0123456789abcdef0123456789abcdef",
      occupancy: 2,
      capacity: 6,
      pace: "quick",
      rulesProfile: "merciless-baseline-v1",
      waitingAge: "recent",
    }],
    nextCursor: null,
  });
  assert.deepEqual(page, {
    enabled: true,
    rooms: [{
      listingId: "0123456789abcdef0123456789abcdef",
      occupancy: 2,
      capacity: 6,
      pace: "quick",
      rulesProfile: "merciless-baseline-v1",
      waitingAge: "recent",
    }],
    nextCursor: null,
  });
  assert.equal(
    parsePublicRoomPage({
      enabled: true,
      rooms: [{
        listingId: "0123456789abcdef0123456789abcdef",
        occupancy: 2,
        capacity: 6,
        pace: "quick",
        rulesProfile: "merciless-baseline-v1",
        waitingAge: "2026-08-11T12:00:00Z",
      }],
      nextCursor: null,
    }),
    null,
  );
});

test("discovery fails closed for disabled and malformed payloads", () => {
  assert.equal(parsePublicAvailability({ enabled: false }), null);
  assert.equal(parsePublicAvailability({
    enabled: true,
    tableCount: 3,
    tableCountCapped: false,
    openSeatCount: 12,
    openSeatCountCapped: false,
  })?.openSeatCount, 12);
  assert.equal(parsePublicRoomPage({ enabled: true, rooms: "not-an-array", nextCursor: null }), null);
  assert.equal(parseViewerListing({ state: "listed", pace: "fast", version: 1, canPublish: true }), null);
  assert.equal(parsePublicAvailability({
    enabled: true,
    tableCount: PUBLIC_TABLE_COUNT_CAP + 1,
    tableCountCapped: true,
    openSeatCount: 1,
    openSeatCountCapped: false,
  }), null);
  assert.equal(parsePublicAvailability({
    enabled: true,
    tableCount: 1,
    tableCountCapped: false,
    openSeatCount: PUBLIC_OPEN_SEAT_COUNT_CAP + 1,
    openSeatCountCapped: true,
  }), null);
  assert.equal(parsePublicAvailability({
    enabled: true,
    tableCount: 3,
    tableCountCapped: true,
    openSeatCount: 12,
    openSeatCountCapped: false,
  }), null);
});

test("public-facing labels stay coarse and precise failures stay safe", () => {
  assert.equal(cappedCountLabel(20, true), "20+");
  assert.equal(waitingAgeLabel("just_opened"), "Just opened");
  assert.match(publicJoinFailureMessage("PUBLIC_ROOM_FULL"), /filled up/i);
  assert.match(publicJoinFailureMessage("ROOM_CLOSED"), /closed/i);
  assert.match(publicJoinFailureMessage("BLOCKED_PAIR"), /no longer available/i);
  assert.doesNotMatch(publicJoinFailureMessage("BLOCKED_PAIR"), /block/i);
  assert.match(listingFailureMessage("VERSION_CONFLICT"), /changed/i);
});

test("room aliases normalize and enforce the shared public boundary", () => {
  assert.equal(normalizeRoomAlias("  Ａce\tPlayer  "), "Ace Player");
  assert.equal(isValidRoomAlias("Ace_Player-2"), true);
  assert.equal(isValidRoomAlias("Élan"), true);
  assert.equal(isValidRoomAlias("A"), false);
  assert.equal(isValidRoomAlias("-Ace"), false);
  assert.equal(isValidRoomAlias("Ace!"), false);
  assert.equal(isValidRoomAlias("a".repeat(25)), false);
});
