import assert from "node:assert/strict";
import test from "node:test";
import {
  isValidRoomAlias,
  normalizeRoomAlias,
} from "../app/components/public-discovery";
import { GAME_PROTOCOL_VERSION, RULES_VERSION } from "../lib/game/types";
import {
  buildPublicAvailability,
  buildPublicRoomCard,
  buildPublicRoomsPage,
  PUBLIC_DISCOVERY_DISABLED,
} from "../lib/server/discovery-dto";
import {
  capPublicCount,
  classifyPublicWaitingAge,
  createPublicListingId,
  evaluatePublicRoomEligibility,
  isPublicListingId,
  normalizePublicAlias,
  PUBLIC_ALIAS_MAX_LENGTH,
  PUBLIC_ALIAS_MIN_LENGTH,
  PUBLIC_DISCOVERY_OPEN_SEAT_COUNT_CAP,
  PUBLIC_DISCOVERY_TABLE_COUNT_CAP,
  PUBLIC_ROOM_CAPACITY,
  PUBLIC_ROOM_PAGE_LIMIT_AUTHENTICATED,
  PUBLIC_WAITING_AGE_JUST_OPENED_MS,
  PUBLIC_WAITING_AGE_RECENT_MS,
  type PublicRoomEligibilityInput,
} from "../lib/server/discovery-policy";
import { PUBLIC_HOST_SUPPRESSION_AFTER_MS } from "../lib/server/room-lifecycle-policy";

const NOW = 1_786_444_800_000;
const LISTING_ID = "0123456789abcdef0123456789abcdef";
const NEXT_LISTING_ID = "fedcba9876543210fedcba9876543210";
const SECRET_VALUES = [
  "J0IN9X",
  "11111111-2222-4333-8444-555555555555",
  "profile-secret-01",
  "player-secret-01",
  "user-secret-01",
  "Unconfirmed Account Name",
  "Confirmed Room Alias",
  "Unconfirmed Account Name is ready.",
  NOW - 1_234,
  NOW - 9_876,
] as const;

test("public DTO builders recursively expose only the anonymous allowlist", () => {
  const internalListingRow = {
    listingId: LISTING_ID,
    occupancy: 2,
    pace: "quick" as const,
    publishedAt: NOW - 3 * 60_000,
    gameId: SECRET_VALUES[1],
    joinCode: SECRET_VALUES[0],
    ownerProfileId: SECRET_VALUES[2],
    hostPlayerId: SECRET_VALUES[3],
    hostUserId: SECRET_VALUES[4],
    hostName: SECRET_VALUES[5],
    alias: SECRET_VALUES[6],
    roster: [{ playerId: SECRET_VALUES[3], displayName: SECRET_VALUES[5] }],
    events: [{ message: SECRET_VALUES[7] }],
    lastSeenAt: SECRET_VALUES[8],
    published_at: SECRET_VALUES[9],
  };

  const card = buildPublicRoomCard(internalListingRow, NOW);
  const availability = buildPublicAvailability(3, 12);
  const page = buildPublicRoomsPage([card], NEXT_LISTING_ID);

  assertExactKeys(availability, [
    "enabled",
    "openSeatCount",
    "openSeatCountCapped",
    "tableCount",
    "tableCountCapped",
  ]);
  assertExactKeys(page, ["enabled", "nextCursor", "rooms"]);
  assertExactKeys(card, [
    "capacity",
    "listingId",
    "occupancy",
    "pace",
    "rulesProfile",
    "waitingAge",
  ]);
  assert.deepEqual(card, {
    listingId: LISTING_ID,
    occupancy: 2,
    capacity: 6,
    pace: "quick",
    rulesProfile: RULES_VERSION,
    waitingAge: "recent",
  });
  assert.deepEqual(availability, {
    enabled: true,
    tableCount: 3,
    tableCountCapped: false,
    openSeatCount: 12,
    openSeatCountCapped: false,
  });
  assert.deepEqual(page, {
    enabled: true,
    rooms: [card],
    nextCursor: NEXT_LISTING_ID,
  });

  assertPublicDiscoverySafe(availability);
  assertPublicDiscoverySafe(page);
  assertNoSecretLeaves(availability, SECRET_VALUES);
  assertNoSecretLeaves(page, SECRET_VALUES);
  assert.equal(Object.isFrozen(card), true);
  assert.equal(Object.isFrozen(page.rooms), true);
});

test("the recursive privacy guard catches every forbidden discovery category", () => {
  const forbiddenFixtures: Array<[string, unknown]> = [
    ["join code", { nested: [{ join_code: "ABC123" }] }],
    ["game ID", { metadata: { gameId: "game-secret" } }],
    ["renamed room ID", { metadata: { room_id: "game-secret" } }],
    ["game UUID", { metadata: { gameUuid: "game-secret" } }],
    ["profile ID", { metadata: { owner_profile_id: "profile-secret" } }],
    ["player ID", { metadata: { playerId: "player-secret" } }],
    ["user identity", { metadata: { authSubject: "user-secret" } }],
    ["account identity", { metadata: { accountId: "user-secret" } }],
    ["member identity", { metadata: { memberId: "profile-secret" } }],
    ["name", { metadata: { display_name: "Account Name" } }],
    ["renamed display label", { metadata: { displayLabel: "Account Name" } }],
    ["alias", { metadata: { hostAlias: "Room Alias" } }],
    ["roster", { metadata: { roster: [] } }],
    ["members", { metadata: { members: [] } }],
    ["events", { metadata: { events: [] } }],
    ["presence", { metadata: { presence: { status: "live" } } }],
    ["exact timestamp", { metadata: { lastSeenAt: NOW } }],
    ["prefixed exact timestamp", { metadata: { hostLastSeenAt: NOW } }],
    ["generic exact timestamp", { metadata: { timestamp: NOW } }],
  ];

  for (const [label, fixture] of forbiddenFixtures) {
    assert.throws(
      () => assertPublicDiscoverySafe(fixture),
      /forbidden public discovery field/i,
      label,
    );
  }
});

test("room-page composition re-projects tainted structural cards and enforces its hard limit", () => {
  const card = buildPublicRoomCard(
    {
      listingId: LISTING_ID,
      occupancy: 1,
      pace: "casual",
      publishedAt: NOW,
    },
    NOW,
  );
  const taintedStructuralCard = {
    ...card,
    gameId: SECRET_VALUES[1],
    joinCode: SECRET_VALUES[0],
    nested: {
      roster: [{ playerId: SECRET_VALUES[3] }],
      lastSeenAt: SECRET_VALUES[8],
    },
  };

  const page = buildPublicRoomsPage([taintedStructuralCard], null);
  assertExactKeys(page.rooms[0], [
    "capacity",
    "listingId",
    "occupancy",
    "pace",
    "rulesProfile",
    "waitingAge",
  ]);
  assertPublicDiscoverySafe(page);
  assertNoSecretLeaves(page, SECRET_VALUES);
  assert.throws(
    () =>
      buildPublicRoomsPage(
        Array.from(
          { length: PUBLIC_ROOM_PAGE_LIMIT_AUTHENTICATED + 1 },
          () => card,
        ),
        null,
      ),
    /page|room|limit|many/i,
  );
});

test("disabled discovery has one frozen field and cannot carry stale room data", () => {
  assert.deepEqual(PUBLIC_DISCOVERY_DISABLED, { enabled: false });
  assertExactKeys(PUBLIC_DISCOVERY_DISABLED, ["enabled"]);
  assertPublicDiscoverySafe(PUBLIC_DISCOVERY_DISABLED);
  assert.equal(Object.isFrozen(PUBLIC_DISCOVERY_DISABLED), true);
});

test("availability counts cap without exposing their exact over-cap value", () => {
  assert.deepEqual(
    capPublicCount(
      PUBLIC_DISCOVERY_TABLE_COUNT_CAP,
      PUBLIC_DISCOVERY_TABLE_COUNT_CAP,
    ),
    { count: PUBLIC_DISCOVERY_TABLE_COUNT_CAP, capped: false },
  );
  assert.deepEqual(
    capPublicCount(
      PUBLIC_DISCOVERY_TABLE_COUNT_CAP + 973,
      PUBLIC_DISCOVERY_TABLE_COUNT_CAP,
    ),
    { count: PUBLIC_DISCOVERY_TABLE_COUNT_CAP, capped: true },
  );
  assert.deepEqual(
    buildPublicAvailability(
      PUBLIC_DISCOVERY_TABLE_COUNT_CAP + 1,
      PUBLIC_DISCOVERY_OPEN_SEAT_COUNT_CAP + 1,
    ),
    {
      enabled: true,
      tableCount: PUBLIC_DISCOVERY_TABLE_COUNT_CAP,
      tableCountCapped: true,
      openSeatCount: PUBLIC_DISCOVERY_OPEN_SEAT_COUNT_CAP,
      openSeatCountCapped: true,
    },
  );
  assert.deepEqual(capPublicCount(Number.NaN, 20), { count: 0, capped: false });
  assert.deepEqual(capPublicCount(-100, 20), { count: 0, capped: false });
});

test("waiting age is coarse at every deterministic boundary", () => {
  assert.equal(classifyPublicWaitingAge(NOW, NOW), "just_opened");
  assert.equal(
    classifyPublicWaitingAge(
      NOW - PUBLIC_WAITING_AGE_JUST_OPENED_MS + 1,
      NOW,
    ),
    "just_opened",
  );
  assert.equal(
    classifyPublicWaitingAge(NOW - PUBLIC_WAITING_AGE_JUST_OPENED_MS, NOW),
    "recent",
  );
  assert.equal(
    classifyPublicWaitingAge(NOW - PUBLIC_WAITING_AGE_RECENT_MS + 1, NOW),
    "recent",
  );
  assert.equal(
    classifyPublicWaitingAge(NOW - PUBLIC_WAITING_AGE_RECENT_MS, NOW),
    "waiting",
  );
  assert.equal(classifyPublicWaitingAge(Number.NaN, NOW), "waiting");
});

test("public locators are lowercase 128-bit values and cursors use only locators", () => {
  const generated = new Set(
    Array.from({ length: 128 }, () => createPublicListingId()),
  );
  assert.equal(generated.size, 128);
  for (const listingId of generated) {
    assert.equal(listingId.length, 32);
    assert.match(listingId, /^[0-9a-f]{32}$/);
    assert.equal(isPublicListingId(listingId), true);
  }
  for (const invalid of [
    "",
    "A".repeat(32),
    "0".repeat(31),
    "0".repeat(33),
    "11111111-2222-4333-8444-555555555555",
  ]) {
    assert.equal(isPublicListingId(invalid), false);
  }
  assert.throws(
    () => buildPublicRoomsPage([], String(NOW)),
    /cursor is invalid/i,
  );
});

test("public aliases require explicit bounded safe text and preserve deliberate equality", () => {
  assert.equal(PUBLIC_ALIAS_MIN_LENGTH, 2);
  assert.equal(PUBLIC_ALIAS_MAX_LENGTH, 24);
  assert.equal(normalizePublicAlias("  Table   Captain  "), "Table Captain");
  assert.equal(normalizePublicAlias("Ａｌｉｃｅ"), "Alice");
  assert.equal(
    normalizePublicAlias("Unconfirmed Account Name"),
    "Unconfirmed Account Name",
    "a user may deliberately type the same text as their account name",
  );
  for (const invalid of [
    undefined,
    null,
    "",
    " ",
    "x",
    "a".repeat(PUBLIC_ALIAS_MAX_LENGTH + 1),
    "https://example.test",
    "<script>alert(1)</script>",
    "Player\u0000Name",
    "🎴",
  ]) {
    assert.equal(normalizePublicAlias(invalid), null);
  }
});

test("client and server alias policies remain identical on a hostile Unicode corpus", () => {
  const corpus = [
    "A",
    "AB",
    "  Table   Captain  ",
    "ＯｐｅｎＳｈｅｄ",
    "Élan",
    "O'Neil-2",
    "Ace_Player",
    "_Player",
    "Player_",
    "Player!",
    "Player.example",
    "🎴 Player",
    "A\u0000B",
    "A\u200dB",
    "a".repeat(PUBLIC_ALIAS_MAX_LENGTH),
    "a".repeat(PUBLIC_ALIAS_MAX_LENGTH + 1),
  ];

  for (const candidate of corpus) {
    const server = normalizePublicAlias(candidate);
    const clientNormalized = normalizeRoomAlias(candidate);
    assert.equal(
      isValidRoomAlias(candidate),
      server !== null,
      `validity drift for ${JSON.stringify(candidate)}`,
    );
    if (server !== null) assert.equal(clientNormalized, server);
  }
});

test("public eligibility rejects every sensitive condition deterministically", () => {
  const eligible = eligibleInput();
  assert.deepEqual(evaluatePublicRoomEligibility(eligible), {
    eligible: true,
    reason: "eligible",
  });

  const cases: Array<
    [
      string,
      Partial<PublicRoomEligibilityInput>,
      ReturnType<typeof evaluatePublicRoomEligibility>["reason"],
    ]
  > = [
    ["feature off", { discoveryEnabled: false }, "discovery_disabled"],
    ["unlisted", { listingState: "unlisted" }, "listing_not_listed"],
    ["closed", { roomStatus: "closed" }, "room_closed"],
    ["expired", { expiresAt: NOW }, "room_expired"],
    ["playing", { gameStatus: "playing" }, "not_lobby"],
    ["protocol", { protocolVersion: GAME_PROTOCOL_VERSION + 1 }, "unsupported_protocol"],
    ["rules", { rulesVersion: "future-rules" }, "unsupported_rules"],
    ["host mismatch", { ownerMatchesHost: false }, "host_mismatch"],
    ["host missing", { hostLastSeenAt: null }, "host_offline"],
    [
      "host stale boundary",
      { hostLastSeenAt: NOW - PUBLIC_HOST_SUPPRESSION_AFTER_MS },
      "host_offline",
    ],
    ["missing consent", { allMembersConsented: false }, "missing_consent"],
    ["empty", { occupancy: 0 }, "empty"],
    ["full", { occupancy: PUBLIC_ROOM_CAPACITY }, "full"],
    ["already member", { viewerAlreadyMember: true }, "already_member"],
    ["bilateral block", { viewerBlocked: true }, "blocked"],
  ];

  for (const [label, override, reason] of cases) {
    assert.deepEqual(
      evaluatePublicRoomEligibility({ ...eligible, ...override }),
      { eligible: false, reason },
      label,
    );
  }
  assert.equal(
    evaluatePublicRoomEligibility({
      ...eligible,
      hostLastSeenAt: NOW - PUBLIC_HOST_SUPPRESSION_AFTER_MS + 1,
    }).eligible,
    true,
  );
  assert.deepEqual(
    evaluatePublicRoomEligibility({
      ...eligible,
      occupancy: PUBLIC_ROOM_CAPACITY,
      viewerBlocked: true,
    }),
    { eligible: false, reason: "blocked" },
    "bilateral block privacy must take precedence over a precise full result",
  );
  assert.deepEqual(
    evaluatePublicRoomEligibility({
      ...eligible,
      occupancy: PUBLIC_ROOM_CAPACITY,
      viewerAlreadyMember: true,
    }),
    { eligible: false, reason: "already_member" },
    "membership privacy must take precedence over a precise full result",
  );
});

function eligibleInput(): PublicRoomEligibilityInput {
  return {
    discoveryEnabled: true,
    listingState: "listed",
    roomStatus: "open",
    gameStatus: "lobby",
    expiresAt: NOW + 60_000,
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

function assertExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

function assertPublicDiscoverySafe(value: unknown, path = "$public"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertPublicDiscoverySafe(entry, `${path}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
    if (isForbiddenPublicKey(normalized)) {
      throw new Error(`Forbidden public discovery field at ${path}.${key}`);
    }
    assertPublicDiscoverySafe(entry, `${path}.${key}`);
  }
}

function isForbiddenPublicKey(normalized: string): boolean {
  if (normalized === "listingid") return false;
  if (
    [
      "joincode",
      "tablecode",
      "authsubject",
      "roster",
      "member",
      "members",
      "player",
      "players",
      "event",
      "events",
      "message",
      "messages",
      "chat",
      "presence",
      "presences",
      "online",
      "connected",
      "timestamp",
      "servertime",
      "eventcursor",
      "nickname",
      "displaylabel",
      "playerlabel",
      "hostlabel",
    ].includes(normalized)
  ) {
    return true;
  }
  if (
    /(?:game|room|table|profile|player|member|user|account|host|owner)(?:id|uuid)$/u.test(
      normalized,
    )
  ) {
    return true;
  }
  if (/(?:name|alias)$/u.test(normalized)) return true;
  return /(?:created|updated|published|unlisted|joined|left|seen|lastseen|heartbeat|closed|expires|abandoned)(?:at|time|timestamp)$/u.test(
    normalized,
  );
}

function assertNoSecretLeaves(
  value: unknown,
  secrets: readonly (string | number)[],
  path = "$public",
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoSecretLeaves(entry, secrets, `${path}[${index}]`),
    );
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertNoSecretLeaves(entry, secrets, `${path}.${key}`);
    }
    return;
  }
  for (const secret of secrets) {
    if (
      (typeof value === "string" &&
        typeof secret === "string" &&
        value.includes(secret)) ||
      (typeof value === "number" && value === secret)
    ) {
      assert.fail(`Secret discovery value leaked at ${path}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
