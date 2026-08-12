import assert from "node:assert/strict";
import test from "node:test";
import { createLobbyState, joinLobbyState } from "../lib/game/engine";
import { GameRuleError } from "../lib/game/errors";
import type { GameState } from "../lib/game/types";
import {
  assertHostClaimPolicy,
  buildGameSeriesView,
  HOST_CLAIM_GRACE_MS,
  type HostClaimPresence,
  type RoundSeriesRecord,
} from "../lib/server/game-night-continuity-policy";

const NOW = 1_900_000_000_000;
const PLAYERS = [
  { userId: "user-a", playerId: "player-a", name: "Ada" },
  { userId: "user-b", playerId: "player-b", name: "Ben" },
  { userId: "user-c", playerId: "player-c", name: "Cy" },
  { userId: "user-d", playerId: "player-d", name: "Dee" },
] as const;

test("host recovery opens at the exact server grace boundary", () => {
  const state = lobbyState(2);
  const current = presence(state, {
    "player-a": NOW - HOST_CLAIM_GRACE_MS + 1,
    "player-b": NOW,
  });

  expectRuleError(
    () => assertHostClaimPolicy(state, "user-b", current, NOW),
    "HOST_STILL_CONNECTED",
  );

  const eligible = presence(state, {
    "player-a": NOW - HOST_CLAIM_GRACE_MS,
    "player-b": NOW,
  });
  assert.deepEqual(
    assertHostClaimPolicy(state, "user-b", eligible, NOW),
    {
      previousHostPlayerId: "player-a",
      previousHostUserId: "user-a",
      previousHostSeat: 0,
      claimantPlayerId: "player-b",
      claimantUserId: "user-b",
      claimantSeat: 1,
      staleCutoff: NOW - HOST_CLAIM_GRACE_MS,
      connectedCutoff: NOW - 45_000,
    },
  );
});

test("recovery deterministically selects the next connected eligible seat", () => {
  const state = lobbyState(4);
  state.hostUserId = "user-b";
  state.players[2]!.status = "eliminated";
  const current = presence(state, {
    "player-a": NOW,
    "player-b": NOW - HOST_CLAIM_GRACE_MS,
    "player-c": NOW,
    "player-d": NOW,
  });

  expectRuleError(
    () => assertHostClaimPolicy(state, "user-a", current, NOW),
    "HOST_CLAIM_NOT_NEXT",
  );
  const guard = assertHostClaimPolicy(state, "user-d", current, NOW);
  assert.equal(guard.claimantSeat, 3);

  const hostReconnected = presence(state, {
    "player-a": NOW,
    "player-b": NOW - 1,
    "player-c": NOW,
    "player-d": NOW,
  });
  expectRuleError(
    () => assertHostClaimPolicy(state, "user-d", hostReconnected, NOW),
    "HOST_STILL_CONNECTED",
  );
});

test("completed recovery permits the next connected Mercy-eliminated member", () => {
  const state = lobbyState(3);
  state.phase = "complete";
  state.players[1]!.status = "eliminated";
  state.winner = {
    playerId: state.players[0]!.playerId,
    reason: "last_active",
  };
  const current = presence(state, {
    "player-a": NOW - HOST_CLAIM_GRACE_MS,
    "player-b": NOW,
    "player-c": NOW,
  });

  const guard = assertHostClaimPolicy(state, "user-b", current, NOW);
  assert.equal(guard.claimantPlayerId, "player-b");
});

test("series projection keeps ledger counts while hiding departed aliases", () => {
  const state = lobbyState(3);
  state.players[0]!.displayName = "Ada Now";
  state.players[1]!.displayName = "Ben Now";
  state.players[2]!.status = "left";
  const records: RoundSeriesRecord[] = [
    round(1, "user-a", "Ada Old"),
    round(2, "user-c", "Cy Historical"),
    round(3, "user-d", "Dee Historical"),
    round(4, "user-b", "Ben Old"),
    round(5, "user-a", "Another Ada Alias"),
    round(6, "user-c", "Cy Again"),
    round(7, "user-b", "Another Ben Alias"),
  ];

  const view = buildGameSeriesView(state, records);
  assert.equal(view.roundNumber, 8);
  assert.equal(view.completedRounds, 7);
  assert.deepEqual(view.scores, [
    { playerId: "player-a", displayName: "Ada Now", wins: 2 },
    { playerId: "player-b", displayName: "Ben Now", wins: 2 },
  ]);
  assert.deepEqual(
    view.recentWinners.map((winner) => [
      winner.roundNumber,
      winner.displayName,
    ]),
    [
      [7, "Ben Now"],
      [5, "Ada Now"],
      [4, "Ben Now"],
      [1, "Ada Now"],
    ],
  );

  const complete = structuredClone(state);
  complete.phase = "complete";
  complete.winner = { playerId: "player-b", reason: "empty_hand" };
  assert.equal(buildGameSeriesView(complete, records).roundNumber, 7);
});

function lobbyState(count: number): GameState {
  let state = createLobbyState({
    gameId: "continuity-policy",
    joinCode: "SERIES",
    hostUserId: PLAYERS[0].userId,
    hostPlayerId: PLAYERS[0].playerId,
    hostDisplayName: PLAYERS[0].name,
    now: 1,
    seed: 23,
  });
  for (const player of PLAYERS.slice(1, count)) {
    state = joinLobbyState(state, {
      userId: player.userId,
      playerId: player.playerId,
      displayName: player.name,
      commandId: `join-${player.playerId}`,
      now: state.updatedAt + 1,
    }).state;
  }
  return state;
}

function presence(
  state: GameState,
  lastSeenAtByPlayer: Readonly<Record<string, number>>,
): HostClaimPresence[] {
  return state.players.map((player) => ({
    playerId: player.playerId,
    lastSeenAt: lastSeenAtByPlayer[player.playerId] ?? NOW - 60_000,
  }));
}

function round(
  roundNumber: number,
  winnerUserId: string,
  winnerDisplayName: string,
): RoundSeriesRecord {
  return {
    completionRevision: roundNumber * 10,
    roundNumber,
    winnerUserId,
    winnerDisplayName,
    winnerReason: roundNumber % 2 === 0 ? "last_active" : "empty_hand",
    completedAt: NOW + roundNumber,
  };
}

function expectRuleError(action: () => unknown, code: string): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof GameRuleError && error.code === code,
  );
}
