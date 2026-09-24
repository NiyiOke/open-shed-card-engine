import assert from "node:assert/strict";
import test from "node:test";

import type { TicketClaims } from "../src/contracts";
import {
  deriveOpaqueKey,
  deriveSocketCapability,
  signNotification,
  signTicket,
  verifyNotificationSignature,
  verifySocketCapability,
  verifyTicket,
} from "../src/crypto";

const SECRET = "shared-secret-that-is-longer-than-thirty-two-bytes";
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function mutateUnusedBase64UrlBits(value: string): string {
  const index = BASE64URL_ALPHABET.indexOf(value.at(-1) ?? "");
  assert.ok(index >= 0 && index % 4 === 0 && index + 1 < BASE64URL_ALPHABET.length);
  return `${value.slice(0, -1)}${BASE64URL_ALPHABET[index + 1]}`;
}

test("opaque room and subject keys match the Sites shape and domain separation", async () => {
  const room = await deriveOpaqueKey(SECRET, "room", "game-123");
  const subject = await deriveOpaqueKey(SECRET, "subject", "user-456");
  assert.match(room, /^[A-Za-z0-9_-]{32}$/u);
  assert.match(subject, /^[A-Za-z0-9_-]{32}$/u);
  assert.notEqual(room, subject);
  assert.equal(await deriveOpaqueKey(SECRET, "room", "game-123"), room);
});

test("socket route capability is expiry-bound and constant-time verified", async () => {
  const room = await deriveOpaqueKey(SECRET, "room", "game-123");
  const expiresAt = 1_900_000_030_000;
  const capability = await deriveSocketCapability(SECRET, room, expiresAt);
  assert.match(capability, /^[A-Za-z0-9_-]{22}$/u);
  assert.equal(await verifySocketCapability(SECRET, room, expiresAt, capability), true);
  assert.equal(await verifySocketCapability(SECRET, room, expiresAt + 1, capability), false);
  assert.equal(await verifySocketCapability(SECRET, "B".repeat(32), expiresAt, capability), false);
});

test("ticket signs and verifies the exact Sites millisecond window", async () => {
  const claims: TicketClaims = {
    v: 1,
    room: await deriveOpaqueKey(SECRET, "room", "game-123"),
    subject: await deriveOpaqueKey(SECRET, "subject", "user-456"),
    nonce: "A".repeat(22),
    issuedAt: 1_000_000,
    expiresAt: 1_030_000,
    leaseUntil: 1_060_000,
  };
  const ticket = await signTicket(SECRET, claims);
  assert.deepEqual(await verifyTicket(SECRET, ticket, 1_001_000), claims);
  const [payload, signature] = ticket.split(".");
  assert.ok(payload && signature);
  await assert.rejects(() => verifyTicket(
    SECRET,
    `${payload}.${mutateUnusedBase64UrlBits(signature)}`,
    1_001_000,
  ));
  await assert.rejects(() => verifyTicket(`${SECRET}!`, ticket, 1_001_000));
  await assert.rejects(() => verifyTicket(SECRET, ticket, 1_030_001));
});

test("notification signature is body-bound and namespaced", async () => {
  const body = '{"v":1,"topics":["chat"]}';
  const input = {
    room: "A".repeat(32),
    timestamp: 1_900_000_000_000,
    nonce: "B".repeat(22),
    body,
  };
  const signature = await signNotification(SECRET, input);
  assert.match(signature, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(await verifyNotificationSignature(SECRET, input, signature), true);
  assert.equal(
    await verifyNotificationSignature(SECRET, input, mutateUnusedBase64UrlBits(signature)),
    false,
  );
  assert.equal(
    await verifyNotificationSignature(SECRET, { ...input, room: "C".repeat(32) }, signature),
    false,
  );
  assert.equal(
    await verifyNotificationSignature(SECRET, { ...input, timestamp: input.timestamp + 1 }, signature),
    false,
  );
  assert.equal(
    await verifyNotificationSignature(SECRET, { ...input, nonce: "D".repeat(22) }, signature),
    false,
  );
  assert.equal(
    await verifyNotificationSignature(SECRET, { ...input, body: '{"v":1,"topics":["game"]}' }, signature),
    false,
  );
});
