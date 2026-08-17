import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROUTE = readFileSync(
  new URL("../app/api/games/[gameId]/realtime-ticket/route.ts", import.meta.url),
  "utf8",
);
const NOTIFY = readFileSync(
  new URL("../lib/server/realtime-notify.ts", import.meta.url),
  "utf8",
);

test("ticket route is same-origin JSON, exact-body, Sites-authenticated, and membership-gated", () => {
  assert.match(ROUTE, /assertSafeMutationRequest\(request\)/u);
  assert.match(ROUTE, /requireRequestUser\(request\)/u);
  assert.match(ROUTE, /assertExactJsonKeys\([\s\S]*?\[\]/u);
  assert.match(ROUTE, /await getGame\(user, gameId\)/u);
  assert.match(
    ROUTE,
    /await getGame\(user, gameId\)[\s\S]*await enforceRealtimeTicketQuota\(user\.userId, gameId\)/u,
  );
  assert.match(ROUTE, /if \(!config\) return jsonResponse\(\{ enabled: false \}\)/u);
  assert.doesNotMatch(ROUTE, /oai-authenticated-user-id["']/u);
});

test("post-commit notifier is content-free, signed, bounded, and best effort", () => {
  assert.match(NOTIFY, /type RealtimeTopic = "game" \| "chat"/u);
  assert.match(NOTIFY, /NOTIFICATION_TIMEOUT_MS = 750/u);
  assert.match(NOTIFY, /signRealtimeNotification/u);
  assert.match(NOTIFY, /open-shed-realtime-timestamp/u);
  assert.match(NOTIFY, /open-shed-realtime-nonce/u);
  assert.match(NOTIFY, /catch \{/u);
  for (const forbidden of [
    "GameView",
    "senderDisplayName",
    "message.body",
    "joinCode",
    "playerId",
    "profileId",
  ]) {
    assert.equal(NOTIFY.includes(forbidden), false, forbidden);
  }
});
