import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PROTOCOL_BYTES,
  SUBPROTOCOL,
  encodeServerFrame,
  isTicketClaims,
  parseNotificationBody,
  parseWebSocketProtocols,
} from "../src/contracts";

const ROOM = "A".repeat(32);
const SUBJECT = "B".repeat(32);
const NONCE = "C".repeat(22);

test("pre-upgrade auth requires exactly two ordered, unique, bounded protocols", () => {
  assert.equal(parseWebSocketProtocols(`${SUBPROTOCOL}, auth.a.b`), "a.b");
  assert.equal(parseWebSocketProtocols(`${SUBPROTOCOL}\t,\tauth.a.b`), "a.b");
  for (const invalid of [
    null,
    SUBPROTOCOL,
    `auth.a.b, ${SUBPROTOCOL}`,
    `${SUBPROTOCOL}, ${SUBPROTOCOL}`,
    `${SUBPROTOCOL}, auth.a.b, extra`,
    `${SUBPROTOCOL},`,
    `${SUBPROTOCOL}, auth.a`,
    `${SUBPROTOCOL}, auth.a.b c`,
    "x".repeat(MAX_PROTOCOL_BYTES + 1),
  ]) {
    assert.throws(() => parseWebSocketProtocols(invalid));
  }
});

test("notification body accepts only sorted, unique game/chat topics", () => {
  assert.deepEqual(parseNotificationBody('{"v":1,"topics":["game"]}'), ["game"]);
  assert.deepEqual(parseNotificationBody('{"v":1,"topics":["chat","game"]}'), ["chat", "game"]);
  assert.throws(() => parseNotificationBody('{"v":1,"topics":["game","chat"]}'));
  assert.throws(() => parseNotificationBody('{"v":1,"topics":["both"]}'));
  assert.throws(() => parseNotificationBody('{"v":1,"topics":["game"],"content":{}}'));
});

test("outbound protocol contains notification hints and no room or identity data", () => {
  const frames = [
    encodeServerFrame({ v: 1, type: "ready", heartbeatMs: 25_000 }),
    encodeServerFrame({ v: 1, type: "invalidate", topics: ["chat"] }),
    encodeServerFrame({ v: 1, type: "resync_required" }),
  ];
  for (const frame of frames) {
    assert.ok(Buffer.byteLength(frame) <= MAX_PROTOCOL_BYTES);
    assert.doesNotMatch(frame, /room|subject|profile|ticket|nonce|content|gameId/u);
  }
});

test("ticket claims have the exact Sites privacy-minimized schema", () => {
  const claims = {
    v: 1,
    room: ROOM,
    subject: SUBJECT,
    nonce: NONCE,
    issuedAt: 1_000,
    expiresAt: 31_000,
    leaseUntil: 61_000,
  };
  assert.equal(isTicketClaims(claims), true);
  assert.equal(isTicketClaims({ ...claims, displayName: "Neo" }), false);
  assert.equal(isTicketClaims({ ...claims, gameId: "raw-game-id" }), false);
});
