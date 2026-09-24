import type { GameSnapshot } from "./game-store";
import type { LobbyPresenceStatus } from "./lobby-presence-policy";

export type LobbyPresenceSelf = Readonly<{
  lookingForGame: boolean;
  alias: string | null;
  canBrowse: boolean;
}>;

export type LobbyDirectoryPlayer = Readonly<{
  presenceId: string;
  alias: string;
  status: LobbyPresenceStatus;
  inviteState: "idle" | "sent";
}>;

export type LobbyInvitationCard = Readonly<{
  inviteId: string;
  fromAlias: string;
}>;

export type LobbyPresenceSnapshot =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      self: LobbyPresenceSelf;
      players: readonly LobbyDirectoryPlayer[];
      invites: readonly LobbyInvitationCard[];
    }>;

export type LobbyInvitationSent = Readonly<{
  invite: Readonly<{
    inviteId: string;
    state: "sent";
    replayed: boolean;
  }>;
}>;

export type LobbyPresenceBlockResult = Readonly<{
  blocked: true;
  replayed: boolean;
}>;

export type LobbyInvitationResponse =
  | Readonly<{
      invite: Readonly<{
        inviteId: string;
        state: "declined" | "blocked";
        replayed: boolean;
      }>;
    }>
  | Readonly<{
      invite: Readonly<{
        inviteId: string;
        state: "accepted";
        replayed: boolean;
      }>;
      snapshot: GameSnapshot;
    }>;

export const LOBBY_PRESENCE_DISABLED = Object.freeze({
  enabled: false,
}) satisfies LobbyPresenceSnapshot;

export function lobbyPresenceSelf(
  alias: string | null,
  canBrowse = alias !== null,
): LobbyPresenceSelf {
  return Object.freeze({
    lookingForGame: alias !== null,
    alias,
    canBrowse,
  });
}
