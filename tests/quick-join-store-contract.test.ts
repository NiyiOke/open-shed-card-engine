import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const STORE_SOURCE = read("../lib/server/game-store.ts");
const ROUTE_SOURCE = read("../app/api/public/quick-join/route.ts");

test("quick join route authenticates and accepts only the pinned body fields", () => {
  assert.match(ROUTE_SOURCE, /assertSafeMutationRequest\(request\)/u);
  assert.match(ROUTE_SOURCE, /requireRequestUser\(request\)/u);
  assert.match(ROUTE_SOURCE, /requireCommandId\(body\.commandId\)/u);
  assert.match(ROUTE_SOURCE, /typeof body\.alias !== "string"/u);
  assert.match(
    ROUTE_SOURCE,
    /quickJoinPublicRoom\(user, body\.alias, commandId\)/u,
  );
  assert.doesNotMatch(ROUTE_SOURCE, /listingId|suggestedName|pace/u);
});

test("quick idempotency hash is distinct and excludes room selection", () => {
  const quick = functionSource("quickJoinPublicRoom", "joinSelectedPublicRoom");
  assert.match(quick, /const operation = "quick_public_join"/u);
  assert.match(
    quick,
    /JSON\.stringify\(\{ operation, alias \}\)/u,
  );
  const hashStart = quick.indexOf("const requestHash");
  const recovery = quick.indexOf("recoverPublicJoinReceipt", hashStart);
  assert.ok(hashStart >= 0 && recovery > hashStart);
  assert.doesNotMatch(quick.slice(hashStart, recovery), /listingId|selected/u);

  const selected = functionSource("joinSelectedPublicRoom", "getGame");
  assert.match(selected, /execution\?\.operation \?\? "public_join"/u);
  assert.match(
    selected,
    /JSON\.stringify\(\{ operation, listingId, alias \}\)/u,
  );
});

test("durable quick receipt recovery happens before pool selection and quota", () => {
  const quick = functionSource("quickJoinPublicRoom", "joinSelectedPublicRoom");
  const recovery = quick.indexOf("recoverPublicJoinReceipt(");
  const accepted = quick.indexOf("if (existing) return existing");
  const actorQuota = quick.indexOf(
    "scope: `auth:${user.userId}:public-join`",
  );
  const selection = quick.indexOf("listPublicRooms(user, null)");
  assert.ok(
    recovery >= 0 &&
      accepted > recovery &&
      actorQuota > accepted &&
      selection > actorQuota,
  );
  assert.match(quick, /recoverPublicJoinReceipt\([\s\S]*catch \(error\)/u);
});

test("quick selection uses the authenticated safe pool and unbiased randomness", () => {
  const quick = functionSource("quickJoinPublicRoom", "joinSelectedPublicRoom");
  assert.match(quick, /listPublicRooms\(user, null\)/u);
  assert.match(
    quick,
    /candidates\[secureRandomIndex\(candidates\.length\)\]/u,
  );
  assert.doesNotMatch(
    quick,
    /public_game_listings|profile_blocks|join_code|state_json/u,
  );

  const random = functionSource("secureRandomIndex", "publicJoinSnapshotFromReceipt");
  assert.match(random, /crypto\.getRandomValues/u);
  assert.match(random, /uint32Range - \(uint32Range % length\)/u);
  assert.match(random, /while \(random\[0\] >= unbiasedLimit\)/u);
});

test("empty safe pool is generic and selected room reuses the atomic core", () => {
  const quick = functionSource("quickJoinPublicRoom", "joinSelectedPublicRoom");
  assert.match(
    quick,
    /"NO_ELIGIBLE_PUBLIC_ROOM"[\s\S]*404/u,
  );
  assert.match(
    quick,
    /joinSelectedPublicRoom\([\s\S]*selected\.listingId[\s\S]*\{ operation, requestHash, actorQuotaCharged: true \}/u,
  );
  const selected = functionSource("joinSelectedPublicRoom", "getGame");
  for (const atomicWrite of [
    "guardedPublicJoinReceiptStatement",
    "guardedPublicProfileProvisionStatement",
    "guardedPublicMembershipUpsertStatement",
    "guardedPresenceUpsertStatement",
    "guardedGameUpdateStatement",
  ]) {
    assert.match(selected, new RegExp(atomicWrite, "u"));
  }
});

test("quick join retries at most three distinct selected-card races", () => {
  const quick = functionSource("quickJoinPublicRoom", "joinSelectedPublicRoom");
  assert.match(quick, /const attemptedListingIds = new Set<string>\(\)/u);
  assert.match(quick, /attempt < 3/u);
  assert.match(
    quick,
    /!attemptedListingIds\.has\(room\.listingId\)/u,
  );
  assert.match(quick, /attemptedListingIds\.add\(selected\.listingId\)/u);
  assert.match(quick, /isRetryableQuickSelectionError\(error\)/u);

  const retryable = functionSource(
    "isRetryableQuickSelectionError",
    "publicJoinSnapshotFromReceipt",
  );
  for (const code of [
    "PUBLIC_ROOM_UNAVAILABLE",
    "PUBLIC_ROOM_FULL",
    "ROOM_CLOSED",
  ]) {
    assert.match(retryable, new RegExp(`"${code}"`, "u"));
  }
  assert.doesNotMatch(retryable, /RATE_LIMITED|IDEMPOTENCY_KEY_REUSED/u);
});

test("receipt recovery wins before each reselection and final exhaustion", () => {
  const quick = functionSource("quickJoinPublicRoom", "joinSelectedPublicRoom");
  const loop = quick.indexOf("for (let attempt = 0; attempt < 3");
  const loopRecovery = quick.indexOf("recoverPublicJoinReceipt(", loop);
  const poolRead = quick.indexOf("listPublicRooms(user, null)", loop);
  const finalComment = quick.indexOf("A concurrent identical request");
  const finalRecovery = quick.indexOf(
    "recoverPublicJoinReceipt(",
    finalComment,
  );
  const noPoolError = quick.lastIndexOf('"NO_ELIGIBLE_PUBLIC_ROOM"');
  assert.ok(loop >= 0 && loopRecovery > loop && poolRead > loopRecovery);
  assert.ok(
    finalComment > poolRead &&
      finalRecovery > finalComment &&
      noPoolError > finalRecovery,
  );
});

test("direct and quick command-key reuse is rejected by operation matching", () => {
  const replay = functionSource(
    "publicJoinSnapshotFromReceipt",
    "recoverPublicJoinReceipt",
  );
  assert.match(replay, /assertReceiptMatches\(receipt, operation, requestHash\)/u);
  const matcher = functionSource("assertReceiptMatches", "viewFromReceipt");
  assert.match(matcher, /receipt\.operation === operation/u);
  assert.match(matcher, /"IDEMPOTENCY_KEY_REUSED"[\s\S]*409/u);
});

function functionSource(startName: string, endName: string): string {
  const start = STORE_SOURCE.indexOf(`function ${startName}`);
  const end = STORE_SOURCE.indexOf(`function ${endName}`, start + 1);
  assert.ok(start >= 0, `missing ${startName}`);
  assert.ok(end > start, `missing boundary after ${startName}`);
  return STORE_SOURCE.slice(start, end);
}

function read(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
}
