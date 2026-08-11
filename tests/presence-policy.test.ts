import assert from "node:assert/strict";
import test from "node:test";
import { createLobbyState, joinLobbyState } from "../lib/game/engine";
import { GameRuleError } from "../lib/game/errors";
import {
  assertInactiveRemovalPolicy,
  classifyPresence,
  PRESENCE_THRESHOLDS,
  presencePlayer,
} from "../lib/server/presence-policy";

const NOW = 1_000_000;
const HOST = { userId: "host-user", playerId: "host-player", name: "Host" };
const GUEST = {
  userId: "guest-user",
  playerId: "guest-player",
  name: "Guest",
};

test("presence states use stable reconnect and disconnect boundaries", () => {
  assert.equal(
    classifyPresence(NOW - PRESENCE_THRESHOLDS.reconnectingAfterMs + 1, NOW),
    "live",
  );
  assert.equal(
    classifyPresence(NOW - PRESENCE_THRESHOLDS.reconnectingAfterMs, NOW),
    "reconnecting",
  );
  assert.equal(
    classifyPresence(NOW - PRESENCE_THRESHOLDS.disconnectedAfterMs + 1, NOW),
    "reconnecting",
  );
  assert.equal(
    classifyPresence(NOW - PRESENCE_THRESHOLDS.disconnectedAfterMs, NOW),
    "disconnected",
  );
});

test("disconnected players retain a separate two-minute removal grace period", () => {
  const protectedPlayer = presencePlayer(
    GUEST.playerId,
    NOW - PRESENCE_THRESHOLDS.removableAfterMs + 1,
    NOW,
  );
  assert.equal(protectedPlayer.status, "disconnected");
  assert.equal(protectedPlayer.removable, false);

  const stalePlayer = presencePlayer(
    GUEST.playerId,
    NOW - PRESENCE_THRESHOLDS.removableAfterMs,
    NOW,
  );
  assert.equal(stalePlayer.status, "disconnected");
  assert.equal(stalePlayer.removable, true);
});

test("inactive removal policy rejects a non-host even when the target is stale", () => {
  const state = twoPlayerLobby();
  assert.throws(
    () =>
      assertInactiveRemovalPolicy(
        state,
        GUEST.userId,
        HOST.playerId,
        NOW - PRESENCE_THRESHOLDS.removableAfterMs,
        NOW,
      ),
    hasCode("HOST_ONLY"),
  );
});

test("inactive removal policy never lets a host remove a live or grace-period player", () => {
  const state = twoPlayerLobby();
  assert.throws(
    () =>
      assertInactiveRemovalPolicy(
        state,
        HOST.userId,
        GUEST.playerId,
        NOW - PRESENCE_THRESHOLDS.removableAfterMs + 1,
        NOW,
      ),
    hasCode("PLAYER_STILL_CONNECTED"),
  );
});

test("inactive removal policy allows a host to remove another active player after grace", () => {
  const state = twoPlayerLobby();
  const target = assertInactiveRemovalPolicy(
    state,
    HOST.userId,
    GUEST.playerId,
    NOW - PRESENCE_THRESHOLDS.removableAfterMs,
    NOW,
  );
  assert.equal(target.playerId, GUEST.playerId);
});

function twoPlayerLobby() {
  const state = createLobbyState({
    gameId: "presence-test",
    joinCode: "LIVE11",
    hostUserId: HOST.userId,
    hostPlayerId: HOST.playerId,
    hostDisplayName: HOST.name,
    now: 1,
    seed: 7,
  });
  return joinLobbyState(state, {
    userId: GUEST.userId,
    playerId: GUEST.playerId,
    displayName: GUEST.name,
    commandId: "join-guest",
    now: 2,
  }).state;
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof GameRuleError && error.code === code;
}
