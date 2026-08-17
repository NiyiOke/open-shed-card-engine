import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { deriveSocketCapability, signNotification } from "../src/crypto";
import {
  authorizeNotification,
  authorizeSocketRoute,
  parseSocketRoute,
} from "../src/edge-auth";

const SECRET = "edge-security-secret-with-at-least-thirty-two-bytes";
const ROOM = "A".repeat(32);

test("forged, expired, and far-future socket capabilities fail edge authorization", async () => {
  const now = Date.now();
  const validExpiry = now + 30_000;
  const validCapability = await deriveSocketCapability(SECRET, ROOM, validExpiry);
  assert.equal(await authorizeSocketRoute(SECRET, {
    room: ROOM,
    expiresAt: validExpiry,
    capability: validCapability,
  }, now), true);
  assert.equal(await authorizeSocketRoute(SECRET, {
    room: ROOM,
    expiresAt: validExpiry,
    capability: "B".repeat(22),
  }, now), false);

  for (const expiresAt of [now - 10_000, now + 60_000]) {
    const capability = await deriveSocketCapability(SECRET, ROOM, expiresAt);
    assert.equal(await authorizeSocketRoute(SECRET, { room: ROOM, expiresAt, capability }, now), false);
  }
  assert.equal(parseSocketRoute(`/socket/${ROOM}/${validExpiry}/${validCapability}`)?.room, ROOM);
  assert.equal(parseSocketRoute(`/socket/${ROOM}/${validCapability}`), null);
});

test("stale, future, wrong-room, and modified notifications fail edge authorization", async () => {
  const body = JSON.stringify({ v: 1, topics: ["chat"] });
  const now = Date.now();
  const valid = { room: ROOM, timestamp: now, nonce: "C".repeat(22), body };
  const signature = await signNotification(SECRET, valid);
  const headers = new Headers({
    "Open-Shed-Realtime-Timestamp": String(valid.timestamp),
    "Open-Shed-Realtime-Nonce": valid.nonce,
    "Open-Shed-Realtime-Signature": signature,
  });
  assert.deepEqual(await authorizeNotification(SECRET, ROOM, body, headers, now), {
    timestamp: now,
    nonce: valid.nonce,
  });

  for (const timestamp of [now - 60_000, now + 10_000]) {
    const input = { ...valid, timestamp };
    const signedHeaders = new Headers({
      "Open-Shed-Realtime-Timestamp": String(timestamp),
      "Open-Shed-Realtime-Nonce": input.nonce,
      "Open-Shed-Realtime-Signature": await signNotification(SECRET, input),
    });
    assert.equal(await authorizeNotification(SECRET, ROOM, body, signedHeaders, now), null);
  }
  assert.equal(await authorizeNotification(SECRET, "D".repeat(32), body, headers, now), null);
  assert.equal(
    await authorizeNotification(SECRET, ROOM, JSON.stringify({ v: 1, topics: ["game"] }), headers, now),
    null,
  );
});

test("edge authorization is ordered before Durable Object selection", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const socketHandler = source.slice(source.indexOf("async function handleSocket"), source.indexOf("async function handleNotification"));
  const notificationHandler = source.slice(source.indexOf("async function handleNotification"), source.indexOf("export const worker"));
  assert.ok(socketHandler.indexOf("authorizeSocketRoute") >= 0);
  assert.ok(socketHandler.indexOf("authorizeSocketRoute") < socketHandler.indexOf("idFromName"));
  assert.ok(socketHandler.indexOf("parseWebSocketProtocols") >= 0);
  assert.ok(socketHandler.indexOf("parseWebSocketProtocols") < socketHandler.indexOf("idFromName"));
  assert.ok(socketHandler.indexOf("verifyTicket") >= 0);
  assert.ok(socketHandler.indexOf("verifyTicket") < socketHandler.indexOf("idFromName"));
  assert.ok(notificationHandler.indexOf("authorizeNotification") >= 0);
  assert.ok(notificationHandler.indexOf("authorizeNotification") < notificationHandler.indexOf("idFromName"));
});

test("notification length is required and bounded before stream read or room selection", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const handler = source.slice(
    source.indexOf("async function handleNotification"),
    source.indexOf("export const worker"),
  );
  const lengthRequired = handler.indexOf("content_length_required");
  const declaredLimit = handler.indexOf("contentLength > MAX_PROTOCOL_BYTES");
  const bodyRead = handler.indexOf("readBoundedUtf8Body");
  const mismatch = handler.indexOf("content_length_mismatch");
  const roomSelection = handler.indexOf("idFromName");
  assert.ok(lengthRequired >= 0 && lengthRequired < bodyRead);
  assert.ok(declaredLimit >= 0 && declaredLimit < bodyRead);
  assert.ok(bodyRead < mismatch && mismatch < roomSelection);
});

test("hibernation socket is accepted before its ready attachment is serialized", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const admission = source.slice(
    source.indexOf("private async admitConnection"),
    source.indexOf("private broadcast"),
  );
  const accepted = admission.indexOf("this.ctx.acceptWebSocket(server");
  const attached = admission.indexOf("server.serializeAttachment");
  const result = admission.indexOf('status: "accepted"');
  assert.ok(accepted >= 0 && accepted < attached && attached < result);
});
