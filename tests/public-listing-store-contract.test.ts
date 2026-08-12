import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getOptionalPublicDiscoveryUser } from "../lib/server/auth";

const STORE_SOURCE = read("../lib/server/game-store.ts");
const RUNTIME_SOURCE = read("../db/runtime.ts");
const AVAILABILITY_ROUTE_SOURCE = read(
  "../app/api/public/availability/route.ts",
);
const ROOMS_ROUTE_SOURCE = read("../app/api/public/rooms/route.ts");
const LISTING_ROUTE_SOURCE = read(
  "../app/api/games/[gameId]/listing/route.ts",
);

test("headerless localhost public discovery stays anonymous", () => {
  assert.equal(
    getOptionalPublicDiscoveryUser(
      new Request("http://localhost/api/public/rooms"),
    ),
    null,
  );
  assert.deepEqual(
    getOptionalPublicDiscoveryUser(
      new Request("http://localhost/api/public/rooms", {
        headers: { "x-open-shed-dev-user": "player-2" },
      }),
    ),
    {
      userId: "dev:player-2",
      suggestedName: "Player-957F",
      development: true,
    },
  );
});

test("availability is counts-only and publicly cacheable for thirty seconds", () => {
  assert.match(AVAILABILITY_ROUTE_SOURCE, /getPublicAvailability\(\)/u);
  assert.doesNotMatch(AVAILABILITY_ROUTE_SOURCE, /requireRequestUser/u);
  assert.match(
    AVAILABILITY_ROUTE_SOURCE,
    /cache-control[\s\S]*public,[\s\S]*max-age=/u,
  );
  assert.match(STORE_SOURCE, /buildPublicAvailability\(/u);
  assert.doesNotMatch(
    functionSource("getPublicAvailability", "listPublicRooms"),
    /findProfileForUser|nickname|join_code|state_json/u,
  );
});

test("room pages use explicit optional auth and exact DTO builders", () => {
  assert.match(ROOMS_ROUTE_SOURCE, /getOptionalPublicDiscoveryUser/u);
  const rooms = functionSource("listPublicRooms", "mutateGameListing");
  assert.match(rooms, /PUBLIC_ROOM_PAGE_LIMIT_ANONYMOUS/u);
  assert.match(rooms, /PUBLIC_ROOM_PAGE_LIMIT_AUTHENTICATED/u);
  assert.match(rooms, /buildPublicRoomCard/u);
  assert.match(rooms, /buildPublicRoomsPage/u);
  assert.match(rooms, /profile_blocks/u);
  assert.match(rooms, /public_discovery_consent_at IS NULL/u);
  assert.match(rooms, /AND l\.listing_id < \?/u);
  assert.doesNotMatch(rooms, /cursor_listing/u);
  assert.doesNotMatch(rooms, /join_code|state_json|public_payload_json/u);
});

test("shared listing quota is charged only after host authorization", () => {
  const mutation = functionSource("mutateGameListing", "createGame");
  const hostGuard = mutation.indexOf("state.hostUserId === user.userId");
  const roomQuota = mutation.indexOf("scope: `room:${gameId}:listing`");
  assert.ok(hostGuard >= 0 && roomQuota > hostGuard);
});

test("quota scopes short-circuit instead of incrementing later targets", () => {
  const quota = functionSource("enforceMutationQuota", "maintainRooms");
  assert.match(quota, /for \(const rule of rules\)/u);
  assert.doesNotMatch(quota, /database\.batch/u);
  const command = functionSource("executeGameCommand", "listLobbies");
  const memberGuard = command.indexOf('"NOT_A_MEMBER"');
  const roomQuota = command.lastIndexOf("scope: `room:${gameId}`");
  assert.ok(memberGuard >= 0 && roomQuota > memberGuard);
});

test("listing route requires the full revision and idempotency contract", () => {
  for (const field of [
    "commandId",
    "expectedRevision",
    "expectedListingVersion",
    "action",
    "alias",
    "pace",
  ]) {
    assert.match(LISTING_ROUTE_SOURCE, new RegExp(`body\\.${field}`, "u"));
  }
  assert.match(LISTING_ROUTE_SOURCE, /mutateGameListing/u);
});

test("publish persists alias, state, consent, listing, event and receipt in one batch", () => {
  const mutation = functionSource("mutateGameListing", "createGame");
  const batchStart = mutation.indexOf("const batch = await database.batch([", mutation.indexOf("const nextState"));
  assert.ok(batchStart >= 0);
  const publishBatch = mutation.slice(batchStart, mutation.indexOf("]);", batchStart));
  for (const guard of [
    "guardedPublishReceiptStatement",
    "guardedCommunicationScopeDowngradeStatement",
    "guardedProfileNicknameStatement",
    "guardedEventStatement",
    "guardedHostDiscoveryConsentStatement",
    "guardedPublishListingStatement",
    "guardedGameUpdateStatement",
  ]) {
    assert.match(publishBatch, new RegExp(guard, "u"));
  }
  assert.match(mutation, /nextHost\.displayName = alias/u);
  assert.match(mutation, /eventFloorVersion|nextState\.revision/u);
});

test("publication permanently downgrades communication behind its exact receipt", () => {
  const downgrade = functionSource(
    "guardedCommunicationScopeDowngradeStatement",
    "guardedPublishListingStatement",
  );
  assert.match(downgrade, /UPDATE games/u);
  assert.match(
    downgrade,
    /WHEN communication_scope = 'invite_only' THEN 'public_safe'/u,
  );
  assert.doesNotMatch(
    downgrade,
    /SET communication_scope = 'invite_only'/u,
  );
  for (const receiptBoundary of [
    "actor_profile_id = ?",
    "command_id = ?",
    "game_id = ?",
    "request_hash = ?",
  ]) {
    assert.ok(
      downgrade.includes(receiptBoundary),
      `missing communication-scope receipt guard: ${receiptBoundary}`,
    );
  }

  const create = functionSource("createGame", "joinGame");
  assert.match(
    create,
    /status, communication_scope, version,[\s\S]*'lobby', 'invite_only', 0/u,
  );
  assert.match(
    RUNTIME_SOURCE,
    /UPDATE games[\s\S]*SET communication_scope = 'public_safe'[\s\S]*communication_scope = 'invite_only'[\s\S]*FROM public_game_listings listing[\s\S]*listing\.game_id = games\.id[\s\S]*member\.join_source = 'public'/u,
  );
});

test("ordinary game purge cannot orphan durable message receipts", () => {
  const purge = functionSource("purgeExpiredRows", "normalizeJoinCode");
  assert.match(
    purge,
    /DELETE FROM game_message_receipts[\s\S]*receipt\.expires_at <= \?/u,
  );
  assert.match(
    purge,
    /DELETE FROM game_messages[\s\S]*message\.expires_at <= \?/u,
  );
  assert.match(
    purge,
    /NOT EXISTS \([\s\S]*FROM game_message_receipts receipt[\s\S]*receipt\.game_id = g\.id/u,
  );
});

test("terminal lifecycle closes only locators that remain publicly listed", () => {
  const visibility = functionSource(
    "guardedListingVisibilityStatement",
    "guardedInactiveRemovalReceiptStatement",
  );
  const maintenanceClose = functionSource(
    "closeRoomFromMaintenance",
    "maybePurgeExpiredGames",
  );
  assert.match(visibility, /WHERE game_id = \? AND state = 'listed'/u);
  assert.doesNotMatch(visibility, /state <> \?|OR \? = 'closed'/u);
  assert.match(
    maintenanceClose,
    /UPDATE public_game_listings[\s\S]*WHERE game_id = \? AND state = 'listed'/u,
  );
  assert.match(STORE_SOURCE, /"private_join"/u);
  assert.match(STORE_SOURCE, /"game_started"/u);
  assert.match(STORE_SOURCE, /"host_changed"/u);
  assert.match(STORE_SOURCE, /DELETE FROM public_game_listings/u);
});

test("an already-active manual join cannot rename or delist its table", () => {
  const join = functionSource("joinGame", "getGame");
  const acknowledgement = join.indexOf(
    "if (alreadyActive && !recoversAcceptedJoin)",
  );
  const privateUnlist = join.indexOf('"private_join"');
  assert.ok(acknowledgement >= 0);
  assert.ok(privateUnlist > acknowledgement);
  const replayBranch = join.slice(
    join.indexOf("if (result.replayed)"),
    join.indexOf("const nextJson"),
  );
  assert.doesNotMatch(replayBranch, /guardedProfileNicknameStatement/u);
  assert.doesNotMatch(replayBranch, /guardedListingVisibilityStatement/u);
});

function functionSource(startName: string, endName: string): string {
  const start = STORE_SOURCE.indexOf(`function ${startName}`);
  const exportedStart = STORE_SOURCE.indexOf(`function ${startName}`);
  const end = STORE_SOURCE.indexOf(`function ${endName}`, start + 1);
  assert.ok(start >= 0 || exportedStart >= 0, `missing ${startName}`);
  assert.ok(end > start, `missing boundary after ${startName}`);
  return STORE_SOURCE.slice(Math.max(start, exportedStart), end);
}

function read(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
}
