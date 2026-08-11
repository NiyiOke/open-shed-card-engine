import { requireRule } from "../game/errors";
import type { GameState, PlayerState } from "../game/types";

/**
 * Clients should heartbeat every 10 seconds while a game is open.
 *
 * The intermediate reconnecting state absorbs short mobile backgrounding and
 * network handoffs. A player is not removable until a separate, longer grace
 * period has elapsed, so a momentary disconnect can never become a kick.
 */
export const PRESENCE_THRESHOLDS = Object.freeze({
  reconnectingAfterMs: 15_000,
  disconnectedAfterMs: 45_000,
  removableAfterMs: 120_000,
});

export type PresenceStatus = "live" | "reconnecting" | "disconnected";

export type PresencePlayer = {
  playerId: string;
  lastSeenAt: number;
  status: PresenceStatus;
  removable: boolean;
};

export type PresenceSnapshot = {
  serverTime: number;
  thresholds: typeof PRESENCE_THRESHOLDS;
  players: PresencePlayer[];
};

export function presenceAgeMs(lastSeenAt: number, now: number): number {
  if (!Number.isFinite(lastSeenAt) || !Number.isFinite(now)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, now - lastSeenAt);
}

export function classifyPresence(
  lastSeenAt: number,
  now: number,
): PresenceStatus {
  const age = presenceAgeMs(lastSeenAt, now);
  if (age < PRESENCE_THRESHOLDS.reconnectingAfterMs) return "live";
  if (age < PRESENCE_THRESHOLDS.disconnectedAfterMs) return "reconnecting";
  return "disconnected";
}

export function presencePlayer(
  playerId: string,
  lastSeenAt: number,
  now: number,
): PresencePlayer {
  return {
    playerId,
    lastSeenAt,
    status: classifyPresence(lastSeenAt, now),
    removable:
      presenceAgeMs(lastSeenAt, now) >=
      PRESENCE_THRESHOLDS.removableAfterMs,
  };
}

export function assertInactiveRemovalPolicy(
  state: GameState,
  actorUserId: string,
  targetPlayerId: string,
  targetLastSeenAt: number,
  now: number,
): PlayerState {
  requireRule(
    state.hostUserId === actorUserId,
    "HOST_ONLY",
    "Only the host can remove an inactive player.",
    403,
  );
  const target = state.players.find(
    (player) => player.playerId === targetPlayerId,
  );
  requireRule(target, "PLAYER_NOT_FOUND", "That player is no longer in this game.", 404);
  requireRule(
    target.userId !== actorUserId,
    "CANNOT_REMOVE_SELF",
    "The host cannot remove themselves as inactive.",
    409,
  );
  requireRule(
    target.status === "active",
    "PLAYER_NOT_ACTIVE",
    "Only an active player can be removed for inactivity.",
    409,
  );
  requireRule(
    presenceAgeMs(targetLastSeenAt, now) >=
      PRESENCE_THRESHOLDS.removableAfterMs,
    "PLAYER_STILL_CONNECTED",
    "That player is still connected or within the reconnect grace period.",
    409,
  );
  return target;
}
