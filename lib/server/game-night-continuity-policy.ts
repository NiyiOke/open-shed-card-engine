import { requireRule } from "../game/errors";
import type {
  GameSeriesView,
  GameState,
  GameWinner,
  PlayerState,
} from "../game/types";
import {
  PRESENCE_THRESHOLDS,
  presenceAgeMs,
} from "./presence-policy";

export const HOST_CLAIM_GRACE_MS = PRESENCE_THRESHOLDS.removableAfterMs;

export type HostClaimPresence = Readonly<{
  playerId: string;
  lastSeenAt: number;
}>;

export type HostClaimGuard = Readonly<{
  previousHostPlayerId: string;
  previousHostUserId: string;
  previousHostSeat: number;
  claimantPlayerId: string;
  claimantUserId: string;
  claimantSeat: number;
  staleCutoff: number;
  connectedCutoff: number;
}>;

export type RoundSeriesRecord = Readonly<{
  completionRevision: number;
  roundNumber: number;
  winnerUserId: string;
  winnerDisplayName: string;
  winnerReason: GameWinner["reason"];
  completedAt: number;
}>;

export type GameSeriesAggregate = Readonly<{
  completedRounds: number;
  highestRound: number;
  winsByUserId: ReadonlyMap<string, number>;
  recentWinners: readonly RoundSeriesRecord[];
}>;

/**
 * Resolves host recovery from server timestamps only. The cyclic seat rule
 * makes one connected active member eligible at a time even before D1 applies
 * the version/hash compare-and-swap.
 */
export function assertHostClaimPolicy(
  state: GameState,
  actorUserId: string,
  presence: readonly HostClaimPresence[],
  now: number,
): HostClaimGuard {
  const actor = state.players.find((player) => player.userId === actorUserId);
  requireRule(
    actor,
    "NOT_A_MEMBER",
    "You are not a member of this game.",
    403,
  );
  requireRule(
    state.phase === "complete"
      ? actor.status !== "left"
      : actor.status === "active",
    "PLAYER_NOT_ACTIVE",
    state.phase === "complete"
      ? "Only a current table member can keep the table going."
      : "Only an active player can keep the table going.",
    403,
  );
  requireRule(
    actor.userId !== state.hostUserId,
    "ALREADY_HOST",
    "You are already the host.",
    409,
  );
  const host = state.players.find((player) => player.userId === state.hostUserId);
  requireRule(
    host && host.status !== "left",
    "HOST_CLAIM_UNAVAILABLE",
    "Host recovery is not available for this table.",
    409,
  );

  const lastSeenByPlayer = new Map(
    presence.map((entry) => [entry.playerId, entry.lastSeenAt] as const),
  );
  const hostLastSeenAt = lastSeenByPlayer.get(host.playerId);
  requireRule(
    hostLastSeenAt !== undefined &&
      presenceAgeMs(hostLastSeenAt, now) >= HOST_CLAIM_GRACE_MS,
    "HOST_STILL_CONNECTED",
    "The host is connected or still within the reconnect grace period.",
    409,
  );

  const connected = (player: PlayerState): boolean => {
    const lastSeenAt = lastSeenByPlayer.get(player.playerId);
    return (
      lastSeenAt !== undefined &&
      presenceAgeMs(lastSeenAt, now) < PRESENCE_THRESHOLDS.disconnectedAfterMs
    );
  };
  requireRule(
    connected(actor),
    "CLAIMANT_NOT_CONNECTED",
    "Reconnect before keeping this table going.",
    409,
  );

  const currentMembers = state.players
    .filter((player) => player.status !== "left")
    .sort((left, right) => left.seat - right.seat);
  const hostIndex = currentMembers.findIndex(
    (player) => player.playerId === host.playerId,
  );
  requireRule(
    hostIndex >= 0,
    "HOST_CLAIM_UNAVAILABLE",
    "Host recovery is not available for this table.",
    409,
  );
  const afterHost = [
    ...currentMembers.slice(hostIndex + 1),
    ...currentMembers.slice(0, hostIndex),
  ];
  const nextConnected = afterHost.find(
    (player) =>
      (state.phase === "complete"
        ? player.status !== "left"
        : player.status === "active") && connected(player),
  );
  requireRule(
    nextConnected,
    "HOST_CLAIM_UNAVAILABLE",
    "No connected active player can recover this table yet.",
    409,
  );
  requireRule(
    nextConnected.playerId === actor.playerId,
    "HOST_CLAIM_NOT_NEXT",
    "The next connected active seat has first claim to this table.",
    409,
  );

  return {
    previousHostPlayerId: host.playerId,
    previousHostUserId: host.userId,
    previousHostSeat: host.seat,
    claimantPlayerId: actor.playerId,
    claimantUserId: actor.userId,
    claimantSeat: actor.seat,
    staleCutoff: now - HOST_CLAIM_GRACE_MS,
    connectedCutoff: now - PRESENCE_THRESHOLDS.disconnectedAfterMs,
  };
}

export function buildGameSeriesView(
  state: GameState,
  records: readonly RoundSeriesRecord[],
): GameSeriesView {
  const ordered = [...records].sort(
    (left, right) => left.roundNumber - right.roundNumber,
  );
  const highestRound = ordered.reduce(
    (maximum, record) => Math.max(maximum, record.roundNumber),
    0,
  );
  const winsByUserId = new Map<string, number>();
  for (const record of ordered) {
    winsByUserId.set(
      record.winnerUserId,
      (winsByUserId.get(record.winnerUserId) ?? 0) + 1,
    );
  }
  return buildGameSeriesViewFromAggregate(state, {
    completedRounds: ordered.length,
    highestRound,
    winsByUserId,
    recentWinners: ordered,
  });
}

export function buildGameSeriesViewFromAggregate(
  state: GameState,
  aggregate: GameSeriesAggregate,
): GameSeriesView {
  const currentPlayers = [...state.players]
    .filter((player) => player.status !== "left")
    .sort((left, right) => left.seat - right.seat);
  const currentByUserId = new Map(
    currentPlayers.map((player) => [player.userId, player] as const),
  );

  return {
    roundNumber:
      state.phase === "complete" && state.winner !== null
        ? Math.max(1, aggregate.highestRound)
        : aggregate.highestRound + 1,
    completedRounds: aggregate.completedRounds,
    scores: currentPlayers.map((player) => ({
      playerId: player.playerId,
      displayName: player.displayName,
      wins: aggregate.winsByUserId.get(player.userId) ?? 0,
    })),
    recentWinners: [...aggregate.recentWinners]
      .sort((left, right) => right.roundNumber - left.roundNumber)
      .flatMap((record) => {
        const currentWinner = currentByUserId.get(record.winnerUserId);
        return currentWinner
          ? [
              {
              roundNumber: record.roundNumber,
              displayName: currentWinner.displayName,
              reason: record.winnerReason,
              completedAt: record.completedAt,
              },
            ]
          : [];
      })
      .slice(0, 5),
  };
}
