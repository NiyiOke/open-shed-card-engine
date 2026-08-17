import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizePublicAlias } from "../lib/server/discovery-policy";

const STORE_SOURCE = read("../lib/server/game-store.ts");
const ROUTE_SOURCE = read(
  "../app/api/public/rooms/[listingId]/join/route.ts",
);

test("direct public join route requires trusted auth and the pinned body", () => {
  assert.match(ROUTE_SOURCE, /assertSafeMutationRequest\(request\)/u);
  assert.match(ROUTE_SOURCE, /requireRequestUser\(request\)/u);
  assert.match(ROUTE_SOURCE, /requireCommandId\(body\.commandId\)/u);
  assert.match(ROUTE_SOURCE, /typeof body\.alias !== "string"/u);
  assert.match(
    ROUTE_SOURCE,
    /joinPublicRoom\(user, listingId, body\.alias, commandId\)/u,
  );
  assert.doesNotMatch(ROUTE_SOURCE, /suggestedName|quick/u);
});

test("direct public join shares the explicit strict alias contract", () => {
  assert.equal(normalizePublicAlias("x"), null);
  assert.equal(normalizePublicAlias("  Public   Guest  "), "Public Guest");
  assert.equal(normalizePublicAlias("Guest🙂"), null);
  assert.equal(normalizePublicAlias("a".repeat(25)), null);

  const join = functionSource("joinSelectedPublicRoom", "getGame");
  const normalization = join.indexOf("normalizePublicAlias(aliasInput)");
  const database = join.indexOf("ensureDatabaseSchema()");
  assert.ok(normalization >= 0 && normalization < database);
  assert.match(join, /"INVALID_ALIAS"/u);
  assert.match(join, /isPublicListingId\(listingIdInput\)/u);
});

test("actor quota precedes target lookup and target quotas follow eligibility", () => {
  const join = functionSource("joinSelectedPublicRoom", "getGame");
  const actorQuota = join.indexOf("scope: `auth:${user.userId}:public-join`");
  const targetLookup = join.indexOf("readPublicJoinTarget(database, listingId)");
  const eligibility = join.indexOf("requireEligiblePublicJoinTarget(");
  const roomQuota = join.indexOf("scope: `room:${target.id}:public-join`");
  assert.ok(actorQuota >= 0 && targetLookup > actorQuota);
  assert.ok(eligibility > targetLookup && roomQuota > eligibility);
  assert.match(join, /recoverPublicJoinReceipt\(/u);
});

test("a committed same-key retry is resolved before sequential rate limits", () => {
  const join = functionSource("joinSelectedPublicRoom", "getGame");
  const receiptLookup = join.indexOf("const initialReceipt");
  const receiptReplay = join.indexOf("if (initialReceipt)");
  const actorQuota = join.indexOf("scope: `auth:${user.userId}:public-join`");
  assert.ok(
    receiptLookup >= 0 && receiptReplay > receiptLookup && actorQuota > receiptReplay,
  );
  const recovery = functionSource(
    "recoverPublicJoinReceipt",
    "isRetryableMutationConflict",
  );
  assert.match(recovery, /findCommandReceipt/u);
  assert.match(recovery, /publicJoinSnapshotFromReceipt/u);
});

test("sensitive and unlisted checks precede closed and full responses", () => {
  const eligibility = functionSource(
    "requireEligiblePublicJoinTarget",
    "throwPublicRoomUnavailable",
  );
  const sensitive = eligibility.indexOf(
    "if (viewerAlreadyMember || viewerBlocked)",
  );
  const unlisted = eligibility.indexOf(
    'target.public_listing_state === "unlisted"',
  );
  const closed = eligibility.indexOf(
    'target.public_listing_state === "closed"',
  );
  const full = eligibility.indexOf('eligibility.reason === "full"');
  assert.ok(
    sensitive >= 0 &&
      unlisted > sensitive &&
      closed > unlisted &&
      full > closed,
  );
});

test("receipt guard atomically revalidates every public eligibility boundary", () => {
  const receipt = functionSource(
    "guardedPublicJoinReceiptStatement",
    "guardedPublicProfileProvisionStatement",
  );
  for (const boundary of [
    "listing.listing_id = ?",
    "listing.version = ?",
    "listing.state = 'listed'",
    "listing.owner_profile_id = game.host_profile_id",
    "game.version = ?",
    "game.state_hash = ?",
    "game.room_status = 'open'",
    "game.status = 'lobby'",
    "game.expires_at > ?",
    "game.protocol_version = ?",
    "game.rules_version = ?",
    "host_profile.auth_subject = ?",
    "host_member.status = 'active'",
    "host_presence.last_seen_at > ?",
    "members.public_discovery_consent_at IS NULL",
    "blocks.blocker_profile_id = ?",
    "membership.profile_id = ?",
  ]) {
    assert.ok(receipt.includes(boundary), `missing atomic guard: ${boundary}`);
  }
  assert.match(receipt, /NOT EXISTS \(\s+SELECT 1 FROM profiles/u);
  assert.match(receipt, /COUNT\(\*\)[\s\S]*< \?/u);
});

test("all public join writes are receipt-gated in one ordered batch", () => {
  const join = functionSource("joinSelectedPublicRoom", "getGame");
  const batchStart = join.indexOf("const batch = await database.batch([");
  const batchEnd = join.indexOf("]);", batchStart);
  assert.ok(batchStart >= 0 && batchEnd > batchStart);
  const batch = join.slice(batchStart, batchEnd);
  const ordered = [
    "guardedPublicJoinReceiptStatement",
    "guardedCommunicationScopeDowngradeStatement",
    "guardedPublicProfileProvisionStatement",
    "guardedEventStatement",
    "staleSeatCleanupStatement",
    "guardedPublicMembershipUpsertStatement",
    "guardedPresenceUpsertStatement",
    "guardedGameUpdateStatement",
  ];
  let cursor = -1;
  for (const name of ordered) {
    const next = batch.indexOf(name);
    assert.ok(next > cursor, `${name} is missing or out of order`);
    cursor = next;
  }
  assert.doesNotMatch(
    join.slice(0, batchStart),
    /UPDATE profiles|INSERT INTO profiles/u,
  );
  assert.match(join, /eventCommandId = `public-join:/u);
  assert.match(
    join,
    /return publicJoinResult\(await getGame\(user, target\.id\), false\)/u,
  );
});

test("successful profile and public membership mutations require the receipt", () => {
  const profile = functionSource(
    "guardedPublicProfileProvisionStatement",
    "guardedReceiptStatement",
  );
  assert.match(profile, /INSERT INTO profiles/u);
  assert.match(profile, /EXISTS \([\s\S]*FROM command_receipts/u);
  assert.match(profile, /ON CONFLICT\(auth_subject\) DO UPDATE/u);
  assert.match(profile, /WHERE profiles\.id = excluded\.id/u);

  const membership = functionSource(
    "guardedPublicMembershipUpsertStatement",
    "guardedMembershipUpsertStatement",
  );
  assert.match(membership, /public_discovery_consent_at/u);
  assert.match(membership, /'public'/u);
  assert.match(membership, /event_floor_version/u);
  assert.match(membership, /FROM command_receipts/u);
  assert.match(membership, /WHERE game_members\.status = 'left'/u);

  const join = functionSource("joinSelectedPublicRoom", "getGame");
  assert.match(
    join,
    /guardedPublicMembershipUpsertStatement\([\s\S]*joinedResult\.state\.revision/u,
  );
});

test("public error responses retain the privacy-safe status split", () => {
  const unavailable = functionSource(
    "throwPublicRoomUnavailable",
    "throwPublicRoomFull",
  );
  const full = functionSource("throwPublicRoomFull", "throwPublicRoomClosed");
  const closed = functionSource(
    "throwPublicRoomClosed",
    "publicJoinSnapshotFromReceipt",
  );
  assert.match(unavailable, /"PUBLIC_ROOM_UNAVAILABLE"[\s\S]*404/u);
  assert.match(full, /"PUBLIC_ROOM_FULL"[\s\S]*409/u);
  assert.match(closed, /"ROOM_CLOSED"[\s\S]*410/u);
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
