import assert from "node:assert/strict";
import test from "node:test";
import { RULES_VERSION } from "../lib/game/types";
import {
  buildPublicAvailability,
  buildPublicRoomCard,
  buildPublicRoomsPage,
  PUBLIC_DISCOVERY_DISABLED,
} from "../lib/server/discovery-dto";

const LISTING_ID = "a".repeat(32);
const SECRET = "PRIVATE_SENTINEL_DO_NOT_EXPOSE";

test("public room cards contain exactly the anonymous contract fields", () => {
  const plantedPrivateRow = {
    listingId: LISTING_ID,
    occupancy: 2,
    pace: "casual" as const,
    publishedAt: 990_000,
    gameId: SECRET,
    joinCode: SECRET,
    ownerProfileId: SECRET,
    hostName: SECRET,
  };
  const card = buildPublicRoomCard(plantedPrivateRow, 1_000_000);

  assert.deepEqual(card, {
    listingId: LISTING_ID,
    occupancy: 2,
    capacity: 6,
    pace: "casual",
    rulesProfile: RULES_VERSION,
    waitingAge: "just_opened",
  });
  assert.deepEqual(Object.keys(card), [
    "listingId",
    "occupancy",
    "capacity",
    "pace",
    "rulesProfile",
    "waitingAge",
  ]);
  assert.equal(JSON.stringify(card).includes(SECRET), false);
});

test("availability and room envelopes stay bounded and omit exact totals", () => {
  assert.deepEqual(buildPublicAvailability(200, 500), {
    enabled: true,
    tableCount: 20,
    tableCountCapped: true,
    openSeatCount: 50,
    openSeatCountCapped: true,
  });
  const room = buildPublicRoomCard(
    {
      listingId: LISTING_ID,
      occupancy: 1,
      pace: "quick",
      publishedAt: 0,
    },
    1_000_000,
  );
  assert.deepEqual(buildPublicRoomsPage([room], LISTING_ID), {
    enabled: true,
    rooms: [room],
    nextCursor: LISTING_ID,
  });
  assert.deepEqual(PUBLIC_DISCOVERY_DISABLED, { enabled: false });
});

test("DTO builders reject invalid locators, cursors, occupancy and pace", () => {
  assert.throws(
    () =>
      buildPublicRoomCard(
        {
          listingId: "not-a-listing",
          occupancy: 1,
          pace: "casual",
          publishedAt: 0,
        },
        1,
      ),
    TypeError,
  );
  assert.throws(
    () =>
      buildPublicRoomCard(
        {
          listingId: LISTING_ID,
          occupancy: 6,
          pace: "casual",
          publishedAt: 0,
        },
        1,
      ),
    TypeError,
  );
  assert.throws(() => buildPublicRoomsPage([], "bad-cursor"), TypeError);
});
