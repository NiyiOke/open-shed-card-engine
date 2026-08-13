import { isValidRoomAlias, normalizeRoomAlias } from "./public-discovery";

export const LOBBY_PRESENCE_POLL_MS = 10_000;

export type LobbyPresencePlayer = {
  presenceId: string;
  alias: string;
  status: "online" | "reconnecting";
  inviteState: "idle" | "sent";
};

export type LobbyInvite = {
  inviteId: string;
  fromAlias: string;
};

export type LobbyPresenceSnapshot = {
  enabled: true;
  self: { lookingForGame: boolean; alias: string | null; canBrowse: boolean };
  players: LobbyPresencePlayer[];
  invites: LobbyInvite[];
};

const OPAQUE_ID = /^[0-9a-f]{32}$/u;

export function parseLobbyPresenceSnapshot(value: unknown): LobbyPresenceSnapshot | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["enabled", "self", "players", "invites"]) ||
    value.enabled !== true ||
    !isRecord(value.self) ||
    !hasExactKeys(value.self, ["lookingForGame", "alias", "canBrowse"])
  ) return null;
  if (
    typeof value.self.lookingForGame !== "boolean" ||
    typeof value.self.canBrowse !== "boolean" ||
    (value.self.alias !== null &&
      (typeof value.self.alias !== "string" || !isValidRoomAlias(value.self.alias))) ||
    !Array.isArray(value.players) ||
    value.players.length > 20 ||
    !Array.isArray(value.invites) ||
    value.invites.length > 10
  ) {
    return null;
  }
  if (value.self.lookingForGame !== (value.self.alias !== null)) return null;

  const players: LobbyPresencePlayer[] = [];
  const playerIds = new Set<string>();
  for (const entry of value.players) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["presenceId", "alias", "status", "inviteState"]) ||
      typeof entry.presenceId !== "string" ||
      !OPAQUE_ID.test(entry.presenceId) ||
      typeof entry.alias !== "string" ||
      !isValidRoomAlias(entry.alias) ||
      (entry.status !== "online" && entry.status !== "reconnecting") ||
      (entry.inviteState !== "idle" && entry.inviteState !== "sent")
    ) {
      return null;
    }
    if (playerIds.has(entry.presenceId)) return null;
    playerIds.add(entry.presenceId);
    players.push({
      presenceId: entry.presenceId,
      alias: normalizeRoomAlias(entry.alias),
      status: entry.status,
      inviteState: entry.inviteState,
    });
  }

  const invites: LobbyInvite[] = [];
  const inviteIds = new Set<string>();
  for (const entry of value.invites) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["inviteId", "fromAlias"]) ||
      typeof entry.inviteId !== "string" ||
      !OPAQUE_ID.test(entry.inviteId) ||
      typeof entry.fromAlias !== "string" ||
      !isValidRoomAlias(entry.fromAlias)
    ) {
      return null;
    }
    if (inviteIds.has(entry.inviteId)) return null;
    inviteIds.add(entry.inviteId);
    invites.push({
      inviteId: entry.inviteId,
      fromAlias: normalizeRoomAlias(entry.fromAlias),
    });
  }

  return {
    enabled: true,
    self: {
      lookingForGame: value.self.lookingForGame,
      alias: value.self.alias === null ? null : normalizeRoomAlias(value.self.alias),
      canBrowse: value.self.canBrowse,
    },
    players,
    invites,
  };
}

export function parseLobbyInviteSent(value: unknown): { inviteId: string; replayed: boolean } | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["invite"]) ||
    !isRecord(value.invite) ||
    !hasExactKeys(value.invite, ["inviteId", "state", "replayed"])
  ) return null;
  if (
    typeof value.invite.inviteId !== "string" ||
    !OPAQUE_ID.test(value.invite.inviteId) ||
    value.invite.state !== "sent" ||
    typeof value.invite.replayed !== "boolean"
  ) {
    return null;
  }
  return { inviteId: value.invite.inviteId, replayed: value.invite.replayed };
}

export function parseLobbyBlockResult(value: unknown): { replayed: boolean } | null {
  if (
    !isRecord(value) ||
    value.blocked !== true ||
    typeof value.replayed !== "boolean" ||
    Object.keys(value).some((key) => key !== "blocked" && key !== "replayed")
  ) {
    return null;
  }
  return { replayed: value.replayed };
}

export function parseLobbyInviteResponse(
  value: unknown,
  action: "accept" | "decline" | "decline_and_block",
): { state: "accepted" | "declined" | "blocked"; snapshot: unknown | null } | null {
  if (!isRecord(value) || !isRecord(value.invite)) return null;
  const expectedState = action === "accept"
    ? "accepted"
    : action === "decline_and_block"
      ? "blocked"
      : "declined";
  if (
    !hasExactKeys(value.invite, ["inviteId", "state", "replayed"]) ||
    typeof value.invite.inviteId !== "string" ||
    !OPAQUE_ID.test(value.invite.inviteId) ||
    value.invite.state !== expectedState ||
    typeof value.invite.replayed !== "boolean"
  ) {
    return null;
  }
  if (action === "accept") {
    if (!hasExactKeys(value, ["invite", "snapshot"])) return null;
    if (!isRecord(value.snapshot)) return null;
    return { state: "accepted", snapshot: value.snapshot };
  }
  if (!hasExactKeys(value, ["invite"])) return null;
  return { state: expectedState, snapshot: null };
}

export function lobbyPresenceFailureMessage(code?: string): string {
  if (code === "INVALID_ALIAS" || code === "ALIAS_REQUIRED") {
    return "Choose a 2–24 character public lobby alias.";
  }
  if (code === "INVITE_ALREADY_PENDING") return "That player already has your invitation.";
  if (code === "INVITE_EXPIRED" || code === "PRESENCE_UNAVAILABLE") {
    return "That player is no longer looking for a game. Refresh the lobby.";
  }
  if (code === "ROOM_CLOSED" || code === "NOT_LOBBY") {
    return "That waiting table is no longer available.";
  }
  return "Lobby invitations are unavailable right now. Try again in a moment.";
}

export function isAmbiguousLobbyMutationFailure(failure: unknown, code?: string): boolean {
  if (failure instanceof TypeError || failure instanceof SyntaxError) return true;
  if (!code) return true;
  if (["REQUEST_TIMEOUT", "INTERNAL_ERROR", "SERVICE_UNAVAILABLE", "DATABASE_UNAVAILABLE"].includes(code)) {
    return true;
  }
  const status = (failure as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 500;
}

export type PendingLobbyMutation = { commandId: string; fingerprint: string };

export function pendingLobbyMutation(
  current: PendingLobbyMutation | null,
  fingerprint: string,
  createCommandId: () => string,
): PendingLobbyMutation {
  return current?.fingerprint === fingerprint
    ? current
    : { commandId: createCommandId(), fingerprint };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}
