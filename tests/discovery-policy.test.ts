import assert from "node:assert/strict";
import test from "node:test";
import { GAME_PROTOCOL_VERSION, RULES_VERSION } from "../lib/game/types";
import {
  capPublicCount,
  classifyPublicWaitingAge,
  createPublicListingId,
  evaluatePublicRoomEligibility,
  isPublicListingId,
  normalizePublicAlias,
  parsePublicPace,
  PUBLIC_DISCOVERY_OPEN_SEAT_COUNT_CAP,
  PUBLIC_DISCOVERY_TABLE_COUNT_CAP,
  PUBLIC_HOST_SUPPRESSION_AFTER_MS,
  PUBLIC_LISTING_ID_LENGTH,
  PUBLIC_ROOM_CAPACITY,
  PUBLIC_WAITING_AGE_JUST_OPENED_MS,
  PUBLIC_WAITING_AGE_RECENT_MS,
  type PublicRoomEligibilityInput,
} from "../lib/server/discovery-policy";

const NOW = 1_000_000;

function eligibleInput(): PublicRoomEligibilityInput {
  return {
    discoveryEnabled: true,
    listingState: "listed",
    roomStatus: "open",
    gameStatus: "lobby",
    expiresAt: NOW + 1,
    protocolVersion: GAME_PROTOCOL_VERSION,
    rulesVersion: RULES_VERSION,
    ownerMatchesHost: true,
    hostLastSeenAt: NOW,
    allMembersConsented: true,
    occupancy: 1,
    viewerAlreadyMember: false,
    viewerBlocked: false,
    now: NOW,
  };
}

test("public listing locators carry 128 random bits as bounded lowercase hex", () => {
  const ids = new Set(Array.from({ length: 64 }, () => createPublicListingId()));
  assert.equal(ids.size, 64);
  for (const id of ids) {
    assert.equal(id.length, PUBLIC_LISTING_ID_LENGTH);
    assert.equal(isPublicListingId(id), true);
  }
  for (const invalid of [
    "",
    "a".repeat(31),
    "a".repeat(33),
    "A".repeat(32),
    "g".repeat(32),
    "../".padEnd(32, "a"),
  ]) {
    assert.equal(isPublicListingId(invalid), false);
  }
});

test("public aliases require explicit bounded normalized text", () => {
  assert.equal(normalizePublicAlias("  Ada   Player  "), "Ada Player");
  assert.equal(normalizePublicAlias("ＯｐｅｎＳｈｅｄ"), "OpenShed");
  assert.equal(normalizePublicAlias("O'Neil-2"), "O'Neil-2");

  for (const invalid of [
    undefined,
    "",
    "A",
    "a".repeat(25),
    "@handle",
    "player.example",
    "<script>",
    "🙂 Player",
    "Player_",
  ]) {
    assert.equal(normalizePublicAlias(invalid), null);
  }
});

test("pace and waiting-age classifiers use controlled coarse values", () => {
  assert.equal(parsePublicPace("casual"), "casual");
  assert.equal(parsePublicPace("quick"), "quick");
  assert.equal(parsePublicPace("fast"), null);
  assert.equal(
    classifyPublicWaitingAge(
      NOW - PUBLIC_WAITING_AGE_JUST_OPENED_MS + 1,
      NOW,
    ),
    "just_opened",
  );
  assert.equal(
    classifyPublicWaitingAge(
      NOW - PUBLIC_WAITING_AGE_JUST_OPENED_MS,
      NOW,
    ),
    "recent",
  );
  assert.equal(
    classifyPublicWaitingAge(NOW - PUBLIC_WAITING_AGE_RECENT_MS, NOW),
    "waiting",
  );
});

test("availability count capping never exposes values above the product caps", () => {
  assert.deepEqual(capPublicCount(3, PUBLIC_DISCOVERY_TABLE_COUNT_CAP), {
    count: 3,
    capped: false,
  });
  assert.deepEqual(capPublicCount(21, PUBLIC_DISCOVERY_TABLE_COUNT_CAP), {
    count: 20,
    capped: true,
  });
  assert.deepEqual(capPublicCount(57, PUBLIC_DISCOVERY_OPEN_SEAT_COUNT_CAP), {
    count: 50,
    capped: true,
  });
});

test("eligible rooms require a listed, compatible, attended, consented open seat", () => {
  const eligible = eligibleInput();
  assert.deepEqual(evaluatePublicRoomEligibility(eligible), {
    eligible: true,
    reason: "eligible",
  });

  const cases: Array<
    [Partial<PublicRoomEligibilityInput>, string]
  > = [
    [{ discoveryEnabled: false }, "discovery_disabled"],
    [{ listingState: "unlisted" }, "listing_not_listed"],
    [{ roomStatus: "closed" }, "room_closed"],
    [{ expiresAt: NOW }, "room_expired"],
    [{ gameStatus: "playing" }, "not_lobby"],
    [{ protocolVersion: 999 }, "unsupported_protocol"],
    [{ rulesVersion: "other" }, "unsupported_rules"],
    [{ ownerMatchesHost: false }, "host_mismatch"],
    [
      { hostLastSeenAt: NOW - PUBLIC_HOST_SUPPRESSION_AFTER_MS },
      "host_offline",
    ],
    [{ allMembersConsented: false }, "missing_consent"],
    [{ occupancy: 0 }, "empty"],
    [{ occupancy: PUBLIC_ROOM_CAPACITY }, "full"],
    [{ viewerAlreadyMember: true }, "already_member"],
    [{ viewerBlocked: true }, "blocked"],
  ];
  for (const [override, reason] of cases) {
    assert.deepEqual(evaluatePublicRoomEligibility({ ...eligible, ...override }), {
      eligible: false,
      reason,
    });
  }
});

test("sensitive viewer ineligibility takes precedence over room capacity", () => {
  assert.deepEqual(
    evaluatePublicRoomEligibility({
      ...eligibleInput(),
      occupancy: PUBLIC_ROOM_CAPACITY,
      viewerBlocked: true,
    }),
    { eligible: false, reason: "blocked" },
  );
  assert.deepEqual(
    evaluatePublicRoomEligibility({
      ...eligibleInput(),
      occupancy: PUBLIC_ROOM_CAPACITY,
      viewerAlreadyMember: true,
    }),
    { eligible: false, reason: "already_member" },
  );
});
