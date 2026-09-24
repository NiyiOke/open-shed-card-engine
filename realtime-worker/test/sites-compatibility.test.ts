import assert from "node:assert/strict";
import test from "node:test";

import {
  getRealtimeConfig,
  issueRealtimeTicket,
  opaqueRealtimeSocketCapability,
  signRealtimeNotification,
} from "../../lib/server/realtime-ticket";
import { SUBPROTOCOL, parseNotificationBody, parseWebSocketProtocols } from "../src/contracts";
import {
  verifyNotificationSignature,
  verifySocketCapability,
  verifyTicket,
} from "../src/crypto";

const SECRET = "cross-service-secret-with-at-least-thirty-two-bytes";

test("companion verifies a ticket issued by the Sites implementation", async () => {
  const config = getRealtimeConfig({
    OPEN_SHED_REALTIME_ENABLED: "true",
    OPEN_SHED_REALTIME_URL: "https://realtime.example.workers.dev",
    OPEN_SHED_REALTIME_SHARED_SECRET: SECRET,
  });
  assert.ok(config);
  const now = 1_900_000_000_000;
  const issued = await issueRealtimeTicket(config, {
    gameId: "private-game-canary",
    authSubject: "private-user-canary",
    now,
    nonceBytes: new Uint8Array(16).fill(9),
  });
  const ticket = parseWebSocketProtocols(`${SUBPROTOCOL}, auth.${issued.ticket}`);
  const claims = await verifyTicket(SECRET, ticket, now + 1_000);
  const capability = await opaqueRealtimeSocketCapability(SECRET, claims.room, claims.expiresAt);
  assert.equal(
    issued.url,
    `wss://realtime.example.workers.dev/socket/${claims.room}/${claims.expiresAt}/${capability}`,
  );
  assert.equal(
    await verifySocketCapability(SECRET, claims.room, claims.expiresAt, capability),
    true,
  );
  assert.equal(JSON.stringify(claims).includes("private-game-canary"), false);
  assert.equal(JSON.stringify(claims).includes("private-user-canary"), false);
});

test("companion verifies the exact post-commit notification emitted by Sites", async () => {
  const body = JSON.stringify({ v: 1, topics: ["chat", "game"] });
  assert.deepEqual(parseNotificationBody(body), ["chat", "game"]);
  const input = {
    room: "A".repeat(32),
    timestamp: 1_900_000_000_000,
    nonce: "B".repeat(22),
    body,
  };
  const signature = await signRealtimeNotification(SECRET, input);
  assert.equal(await verifyNotificationSignature(SECRET, input, signature), true);
});
