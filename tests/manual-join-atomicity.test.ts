import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const STORE_SOURCE = read("../lib/server/game-store.ts");

test("manual join never provisions an account-name profile before acceptance", () => {
  const join = functionSource("joinGame", "joinPublicRoom");
  assert.doesNotMatch(join, /getOrCreateProfile|user\.suggestedName/u);
  assert.match(join, /const alias = normalizePublicAlias\(nickname\)/u);
  assert.match(join, /const candidateProfileId = crypto\.randomUUID\(\)/u);
  const firstBatch = join.indexOf("database.batch([");
  assert.ok(firstBatch >= 0);
  assert.doesNotMatch(
    join.slice(0, firstBatch),
    /INSERT INTO profiles|UPDATE profiles/u,
  );
});

test("manual join refreshes profile mode and receipt on every CAS attempt", () => {
  const join = functionSource("joinGame", "joinPublicRoom");
  const loop = join.indexOf("for (let attempt = 0; attempt < 4");
  const profile = join.indexOf("findProfileForUser(database, user.userId)", loop);
  const receipt = join.indexOf("findCommandReceipt", profile);
  const target = join.indexOf("FROM games WHERE join_code = ?", receipt);
  assert.ok(loop >= 0 && profile > loop && receipt > profile && target > receipt);
  assert.match(join, /storedProfile !== null/u);
});

test("manual receipt guard serializes existing and absent profile modes", () => {
  const guard = functionSource(
    "guardedJoinReceiptStatement",
    "guardedReceiptStatement",
  );
  assert.match(
    guard,
    /\? = 1[\s\S]*profiles[\s\S]*id = \? AND auth_subject = \?/u,
  );
  assert.match(
    guard,
    /\? = 0[\s\S]*NOT EXISTS \([\s\S]*profiles WHERE auth_subject = \?/u,
  );
  for (const cas of [
    "id = ? AND join_code = ?",
    "version = ? AND state_hash = ?",
    "room_status = 'open' AND status = 'lobby'",
    "expires_at > ?",
  ]) {
    assert.ok(guard.includes(cas), `missing manual join CAS guard: ${cas}`);
  }
});

test("both accepted and recovery manual joins provision alias behind receipt", () => {
  const join = functionSource("joinGame", "joinPublicRoom");
  const replayBranch = join.slice(
    join.indexOf("if (result.replayed)"),
    join.indexOf("const nextJson"),
  );
  assertOrdered(replayBranch, [
    "guardedJoinReceiptStatement",
    "guardedPublicProfileProvisionStatement",
    "guardedMembershipUpsertStatement",
    "guardedPresenceUpsertStatement",
  ]);

  const acceptedBranch = join.slice(
    join.indexOf("const batch = await database.batch([", join.indexOf("const nextJson")),
    join.indexOf("]);", join.indexOf("const nextJson")),
  );
  assertOrdered(acceptedBranch, [
    "guardedJoinReceiptStatement",
    "guardedListingVisibilityStatement",
    "guardedPublicProfileProvisionStatement",
    "guardedEventStatement",
    "guardedMembershipUpsertStatement",
    "guardedPresenceUpsertStatement",
    "guardedGameUpdateStatement",
  ]);
  assert.doesNotMatch(acceptedBranch, /guardedProfileNicknameStatement/u);
});

test("explicit profile provisioning is receipt-gated and collision-safe", () => {
  const provision = functionSource(
    "guardedPublicProfileProvisionStatement",
    "guardedJoinReceiptStatement",
  );
  assert.match(provision, /INSERT INTO profiles/u);
  assert.match(provision, /EXISTS \([\s\S]*FROM command_receipts/u);
  assert.match(provision, /ON CONFLICT\(auth_subject\) DO UPDATE/u);
  assert.match(provision, /WHERE profiles\.id = excluded\.id/u);
});

function assertOrdered(source: string, names: string[]): void {
  let cursor = -1;
  for (const name of names) {
    const next = source.indexOf(name);
    assert.ok(next > cursor, `${name} is missing or out of order`);
    cursor = next;
  }
}

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
