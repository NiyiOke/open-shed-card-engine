import { GameRuleError } from "../game/errors";

export const LOBBY_PRESENCE_ENV =
  "OPEN_SHED_LOBBY_PRESENCE_ENABLED" as const;

export const LOBBY_PRESENCE_THRESHOLDS = Object.freeze({
  reconnectingAfterMs: 15_000,
  expiresAfterMs: 45_000,
});

export const LOBBY_INVITATION_TTL_MS = 5 * 60_000;
export const LOBBY_DIRECTORY_LIMIT = 20;
export const LOBBY_INVITATION_FEED_LIMIT = 10;

export type LobbyPresenceStatus = "online" | "reconnecting";

export function parseLobbyPresenceEnabled(
  environment: Partial<Record<typeof LOBBY_PRESENCE_ENV | "NODE_ENV", string | undefined>>,
): boolean {
  return environment[LOBBY_PRESENCE_ENV] === "true";
}

export function isLobbyPresenceEnabled(): boolean {
  return parseLobbyPresenceEnabled(process.env);
}

export function assertLobbyPresenceEnabled(): void {
  if (!isLobbyPresenceEnabled()) {
    throw new GameRuleError(
      "LOBBY_PRESENCE_DISABLED",
      "Lobby player discovery is not available.",
      404,
    );
  }
}

export function classifyLobbyPresence(
  lastSeenAt: number,
  now: number,
): LobbyPresenceStatus | null {
  if (!Number.isFinite(lastSeenAt) || !Number.isFinite(now)) return null;
  const age = Math.max(0, now - lastSeenAt);
  if (age < LOBBY_PRESENCE_THRESHOLDS.reconnectingAfterMs) return "online";
  if (age < LOBBY_PRESENCE_THRESHOLDS.expiresAfterMs) {
    return "reconnecting";
  }
  return null;
}

export function isFreshLobbyPresence(lastSeenAt: number, now: number): boolean {
  return classifyLobbyPresence(lastSeenAt, now) !== null;
}

