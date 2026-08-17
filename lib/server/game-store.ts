import { ensureDatabaseSchema } from "../../db/runtime";
import {
  createLobbyState,
  joinLobbyState,
  transitionGame,
} from "../game/engine";
import { GameRuleError, requireRule } from "../game/errors";
import { assertGameInvariants } from "../game/invariants";
import { projectGameForUser } from "../game/projection";
import type {
  GameCommand,
  GameContinuityProjection,
  GameEvent,
  GameSeriesView,
  GameState,
  GameView,
  GameWinner,
} from "../game/types";
import { GAME_PROTOCOL_VERSION, RULES_VERSION } from "../game/types";
import type { AuthenticatedUser } from "./auth";
import { cleanNickname } from "./auth";
import {
  buildPublicAvailability,
  buildPublicRoomCard,
  buildPublicRoomsPage,
  PUBLIC_DISCOVERY_DISABLED,
  type PublicAvailability,
  type PublicRoomsPage,
  type ViewerListing,
} from "./discovery-dto";
import {
  createPublicListingId,
  evaluatePublicRoomEligibility,
  isPublicListingId,
  normalizePublicAlias,
  parsePublicPace,
  PUBLIC_ROOM_CAPACITY,
  PUBLIC_ROOM_PAGE_LIMIT_ANONYMOUS,
  PUBLIC_ROOM_PAGE_LIMIT_AUTHENTICATED,
  type PublicPace,
} from "./discovery-policy";
import {
  assertInactiveRemovalPolicy,
  PRESENCE_THRESHOLDS,
  presencePlayer,
  type PresenceSnapshot,
} from "./presence-policy";
import {
  assertHostClaimPolicy,
  buildGameSeriesViewFromAggregate,
  type HostClaimGuard,
  type RoundSeriesRecord,
} from "./game-night-continuity-policy";
import {
  ABANDONED_WAITING_ROOM_CLOSE_AFTER_MS,
  evaluateWaitingRoomLifecycle,
  PUBLIC_HOST_SUPPRESSION_AFTER_MS,
  roomTombstoneExpiresAt,
  type PersistedGameStatus,
  type RoomCloseReason,
  type RoomStatus,
} from "./room-lifecycle-policy";
import {
  expiredGameLiveVoiceCleanupStatements,
  guardedCommandLiveVoiceCleanupStatement,
  guardedEventLiveVoiceCleanupStatement,
  maybeReconcileLiveVoiceCleanupJobs,
  reconcileLiveVoiceCleanupJobs,
} from "./live-voice-cleanup";
import { getV15FeaturePolicy } from "./v15-feature-policy";
import { gameCommandActivityFields } from "./game-command-response";

type ProfileRow = {
  id: string;
  auth_subject: string;
  nickname: string;
};

type GameRow = {
  id: string;
  join_code: string;
  host_profile_id: string;
  rules_version: string;
  protocol_version: number;
  status: string;
  version: number;
  state_json: string;
  state_hash: string;
  room_status: RoomStatus;
  closed_at: number | null;
  close_reason: RoomCloseReason | null;
  abandoned_since: number | null;
  last_activity_at: number;
  expires_at: number;
};

type LifecyclePresenceRow = {
  last_seen_at: number | null;
};

type RoomLifecycleUpdate = {
  roomStatus: RoomStatus;
  closedAt: number | null;
  closeReason: RoomCloseReason | null;
  abandonedSince: number | null;
};

type CommandReceiptRow = {
  actor_profile_id: string;
  command_id: string;
  game_id: string;
  operation: string;
  request_hash: string;
  result_version: number;
};

type EventRow = {
  version: number;
  public_payload_json: string;
};

type PresenceRosterRow = {
  auth_subject: string;
  joined_at: number;
  player_id: string | null;
  last_seen_at: number | null;
};

type GameSeriesProjectionRow = {
  row_kind: "score" | "recent";
  winner_user_id: string;
  wins: number | null;
  completed_rounds: number;
  highest_round: number;
  completion_revision: number | null;
  round_number: number | null;
  winner_reason: string | null;
  completed_at: number | null;
};

type MemberAccessRow = {
  profile_id: string;
  event_floor_version: number;
};

type PublicListingRow = {
  game_id: string;
  listing_id: string;
  owner_profile_id: string;
  state: "listed" | "unlisted" | "closed";
  pace: string;
  version: number;
  event_floor_version: number;
  published_at: number;
  updated_at: number;
  unlisted_at: number | null;
  close_reason: string | null;
};

type PublicAvailabilityRow = {
  table_count: number;
  open_seat_count: number;
};

type PublicRoomRow = {
  listing_id: string;
  pace: string;
  published_at: number;
  occupancy: number;
};

type HostPresenceRow = {
  last_seen_at: number;
};

type PublicJoinTargetRow = GameRow & {
  public_listing_id: string;
  public_listing_owner_profile_id: string;
  public_listing_state: PublicListingRow["state"];
  public_listing_pace: string;
  public_listing_version: number;
};

type PublicJoinFactsRow = {
  host_auth_subject: string | null;
  host_last_seen_at: number | null;
  host_is_active: number;
  occupancy: number;
  all_members_consented: number;
  viewer_already_member: number;
  viewer_blocked: number;
};

export type ListingMutationInput =
  | Readonly<{
      action: "publish";
      alias: string;
      pace: PublicPace;
      commandId: string;
      expectedRevision: number;
      expectedListingVersion: number | null;
    }>
  | Readonly<{
      action: "unpublish";
      commandId: string;
      expectedRevision: number;
      expectedListingVersion: number;
    }>;

export type ListingMutationResult = Readonly<{
  listing: ViewerListing;
  view: GameView;
  replayed: boolean;
}>;

export type GameSnapshot = Readonly<{
  view: GameView;
  events: GameEvent[];
  eventCursor: number;
  presence: PresenceSnapshot;
  listing?: ViewerListing;
}>;

export type ManualJoinResult = Readonly<{
  view: GameView;
  replayed: boolean;
}>;

export type PublicJoinResult = Readonly<{
  snapshot: GameSnapshot;
  replayed: boolean;
}>;

export type GameCommandResult = Readonly<{
  view: GameView | null;
  events: GameEvent[];
  /**
   * The last event-feed revision actually delivered in `events`.
   * Replays deliberately return null because their latest projection does not
   * include the activity that happened at or after the accepted command.
   */
  eventCursor: number | null;
  replayed: boolean;
}>;

type PublicJoinExecutionContext = Readonly<{
  operation: "public_join" | "quick_public_join";
  requestHash: string;
  actorQuotaCharged: boolean;
}>;

type InactiveRemovalCommand = {
  type: "remove_inactive_player";
  targetPlayerId: string;
};

type HostClaimCommand = {
  type: "claim_host";
};

type PersistedHostClaimGuard = HostClaimGuard & {
  previousHostProfileId: string;
  claimantProfileId: string;
};

type InactiveRemovalGuard = {
  targetPlayerId: string;
  targetUserId: string;
  staleCutoff: number;
};

export type LobbySummary = {
  gameId: string;
  joinCode: string;
  phase: GameState["phase"];
  playerCount: number;
  hostName: string;
  updatedAt: number;
  isMember: boolean;
};

const LOBBY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const ACTIVE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const PURGE_INTERVAL_MS = 60_000;
const PURGE_BATCH_SIZE = 12;
const ROOM_MAINTENANCE_INTERVAL_MS = 15_000;
const ROOM_MAINTENANCE_BATCH_SIZE = 12;
const EVENT_FEED_TAIL = 8;
const EVENT_FEED_PAGE = 12;
const OPEN_ROOM_LIFECYCLE: RoomLifecycleUpdate = Object.freeze({
  roomStatus: "open",
  closedAt: null,
  closeReason: null,
  abandonedSince: null,
});

let lastPurgeAt = 0;
let purgePromise: Promise<void> | null = null;
let lastRoomMaintenanceAt = 0;
let roomMaintenancePromise: Promise<void> | null = null;

export async function getPublicAvailability(): Promise<PublicAvailability> {
  if (!getV15FeaturePolicy().discoveryEnabled) {
    return PUBLIC_DISCOVERY_DISABLED;
  }
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maintainRooms(database, now);
  const row = await database
    .prepare(
      `SELECT COUNT(*) AS table_count,
              COALESCE(SUM(? - eligible.occupancy), 0) AS open_seat_count
       FROM (
         SELECT l.game_id,
                (
                  SELECT COUNT(*) FROM game_members occupants
                  WHERE occupants.game_id = g.id AND occupants.status <> 'left'
                ) AS occupancy
         FROM public_game_listings l
         JOIN games g ON g.id = l.game_id
         WHERE l.state = 'listed'
           AND l.owner_profile_id = g.host_profile_id
           AND g.room_status = 'open' AND g.status = 'lobby'
           AND g.expires_at > ?
           AND g.protocol_version = ? AND g.rules_version = ?
           AND EXISTS (
             SELECT 1
             FROM game_members host_member
             JOIN game_presence host_presence
               ON host_presence.game_id = host_member.game_id
              AND host_presence.profile_id = host_member.profile_id
             WHERE host_member.game_id = g.id
               AND host_member.profile_id = g.host_profile_id
               AND host_member.status = 'active'
               AND host_presence.last_seen_at > ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM game_members member_consent
             WHERE member_consent.game_id = g.id
               AND member_consent.status <> 'left'
               AND member_consent.public_discovery_consent_at IS NULL
           )
       ) eligible
       WHERE eligible.occupancy > 0 AND eligible.occupancy < ?`,
    )
    .bind(
      PUBLIC_ROOM_CAPACITY,
      now,
      GAME_PROTOCOL_VERSION,
      RULES_VERSION,
      now - PUBLIC_HOST_SUPPRESSION_AFTER_MS,
      PUBLIC_ROOM_CAPACITY,
    )
    .first<PublicAvailabilityRow>();
  return buildPublicAvailability(
    Number(row?.table_count ?? 0),
    Number(row?.open_seat_count ?? 0),
  );
}

export async function listPublicRooms(
  user: AuthenticatedUser | null,
  cursor: string | null,
): Promise<PublicRoomsPage> {
  if (!getV15FeaturePolicy().discoveryEnabled) {
    return PUBLIC_DISCOVERY_DISABLED;
  }
  requireRule(
    cursor === null || isPublicListingId(cursor),
    "INVALID_CURSOR",
    "The public room cursor is invalid.",
    400,
  );
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maintainRooms(database, now);
  const viewerProfile = user
    ? await findProfileForUser(database, user.userId)
    : null;
  const pageLimit = user
    ? PUBLIC_ROOM_PAGE_LIMIT_AUTHENTICATED
    : PUBLIC_ROOM_PAGE_LIMIT_ANONYMOUS;
  const cursorClause = cursor
    ? "AND l.listing_id < ?"
    : "";
  const viewerClause = viewerProfile
    ? `AND NOT EXISTS (
         SELECT 1 FROM game_members viewer_membership
         WHERE viewer_membership.game_id = g.id
           AND viewer_membership.profile_id = ?
           AND viewer_membership.status <> 'left'
       )
       AND NOT EXISTS (
         SELECT 1
         FROM game_members table_member
         JOIN profile_blocks block_edge
           ON (
             block_edge.blocker_profile_id = ?
             AND block_edge.blocked_profile_id = table_member.profile_id
           ) OR (
             block_edge.blocked_profile_id = ?
             AND block_edge.blocker_profile_id = table_member.profile_id
           )
         WHERE table_member.game_id = g.id
           AND table_member.status <> 'left'
       )`
    : "";
  const bindings: unknown[] = [
    now,
    GAME_PROTOCOL_VERSION,
    RULES_VERSION,
    now - PUBLIC_HOST_SUPPRESSION_AFTER_MS,
    PUBLIC_ROOM_CAPACITY,
  ];
  if (cursor) bindings.push(cursor);
  if (viewerProfile) {
    bindings.push(viewerProfile.id, viewerProfile.id, viewerProfile.id);
  }
  bindings.push(pageLimit + 1);
  const rows = await database
    .prepare(
      `SELECT l.listing_id, l.pace, l.published_at,
              (
                SELECT COUNT(*) FROM game_members occupants
                WHERE occupants.game_id = g.id AND occupants.status <> 'left'
              ) AS occupancy
       FROM public_game_listings l
       JOIN games g ON g.id = l.game_id
       WHERE l.state = 'listed'
         AND l.owner_profile_id = g.host_profile_id
         AND g.room_status = 'open' AND g.status = 'lobby'
         AND g.expires_at > ?
         AND g.protocol_version = ? AND g.rules_version = ?
         AND EXISTS (
           SELECT 1
           FROM game_members host_member
           JOIN game_presence host_presence
             ON host_presence.game_id = host_member.game_id
            AND host_presence.profile_id = host_member.profile_id
           WHERE host_member.game_id = g.id
             AND host_member.profile_id = g.host_profile_id
             AND host_member.status = 'active'
             AND host_presence.last_seen_at > ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM game_members member_consent
           WHERE member_consent.game_id = g.id
             AND member_consent.status <> 'left'
             AND member_consent.public_discovery_consent_at IS NULL
         )
         AND (
           SELECT COUNT(*) FROM game_members occupants
           WHERE occupants.game_id = g.id AND occupants.status <> 'left'
         ) BETWEEN 1 AND (? - 1)
         ${cursorClause}
         ${viewerClause}
       ORDER BY l.listing_id DESC
       LIMIT ?`,
    )
    .bind(...bindings)
    .all<PublicRoomRow>();
  const visibleRows = rows.results.slice(0, pageLimit);
  const cards = visibleRows.map((room) => {
    const pace = parsePublicPace(room.pace);
    requireRule(
      pace,
      "CORRUPT_PUBLIC_LISTING",
      "A public listing is invalid.",
      500,
    );
    return buildPublicRoomCard(
      {
        listingId: room.listing_id,
        occupancy: Number(room.occupancy),
        pace,
        publishedAt: Number(room.published_at),
      },
      now,
    );
  });
  const nextCursor =
    rows.results.length > pageLimit
      ? visibleRows.at(-1)?.listing_id ?? null
      : null;
  return buildPublicRoomsPage(cards, nextCursor);
}

export async function mutateGameListing(
  user: AuthenticatedUser,
  gameId: string,
  input: ListingMutationInput,
): Promise<ListingMutationResult> {
  requireRule(
    getV15FeaturePolicy().discoveryEnabled,
    "DISCOVERY_DISABLED",
    "Public table discovery is not available.",
    404,
  );
  requireRule(
    Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0,
    "INVALID_REVISION",
    "expectedRevision must be a non-negative integer.",
    400,
  );
  requireRule(
    input.expectedListingVersion === null ||
      (Number.isSafeInteger(input.expectedListingVersion) &&
        input.expectedListingVersion >= 0),
    "INVALID_LISTING_VERSION",
    "expectedListingVersion must be null or a non-negative integer.",
    400,
  );
  const alias = input.action === "publish"
    ? normalizePublicAlias(input.alias)
    : null;
  if (input.action === "publish") {
    requireRule(
      alias,
      "INVALID_ALIAS",
      "Use a 2–24 character alias with letters, numbers, spaces, _, apostrophes, or hyphens.",
      400,
    );
    requireRule(
      parsePublicPace(input.pace),
      "INVALID_PACE",
      "pace must be casual or quick.",
      400,
    );
  }

  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maintainRooms(database, now);
  const profile = await findProfileForUser(database, user.userId);
  requireRule(
    profile,
    "NOT_A_MEMBER",
    "You are not a member of this game.",
    403,
  );
  const operation = "game_listing";
  const requestHash = await hashText(
    JSON.stringify({
      operation,
      gameId,
      action: input.action,
      expectedRevision: input.expectedRevision,
      expectedListingVersion: input.expectedListingVersion,
      ...(input.action === "publish"
        ? { alias, pace: input.pace }
        : {}),
    }),
  );
  const existingReceipt = await findCommandReceipt(
    database,
    profile.id,
    input.commandId,
  );
  if (existingReceipt) {
    return listingResultFromReceipt(
      database,
      existingReceipt,
      user,
      operation,
      requestHash,
      gameId,
      now,
    );
  }
  await enforceMutationQuota(database, now, [
    {
      scope: `user:${profile.id}:listing`,
      windowMs: 60_000,
      limit: 20,
    },
  ]);

  const row = await getGameRow(database, gameId);
  const state = await parseAndValidateState(row);
  requireRule(
    row.version === input.expectedRevision &&
      state.revision === input.expectedRevision,
    "VERSION_CONFLICT",
    "The game changed before the listing update. Refresh and try again.",
    409,
  );
  const actor = requireCurrentMember(state, user.userId);
  requireRule(
    state.hostUserId === user.userId && row.host_profile_id === profile.id,
    "HOST_ONLY",
    "Only the current host can change public listing settings.",
    403,
  );
  requireRule(
    actor.status === "active",
    "PLAYER_NOT_ACTIVE",
    "Only an active host can change public listing settings.",
    409,
  );
  await enforceMutationQuota(database, now, [
    { scope: `room:${gameId}:listing`, windowMs: 60_000, limit: 40 },
  ]);
  const listing = await readPublicListingForGame(database, gameId);
  requireRule(
    (listing === null && input.expectedListingVersion === null) ||
      (listing !== null && listing.version === input.expectedListingVersion),
    "VERSION_CONFLICT",
    "The public listing changed. Refresh and try again.",
    409,
  );

  if (input.action === "unpublish") {
    requireRule(
      listing?.state === "listed",
      "VERSION_CONFLICT",
      "The public listing changed. Refresh and try again.",
      409,
    );
    try {
      const batch = await database.batch([
        guardedUnpublishReceiptStatement(
          database,
          row,
          profile.id,
          input.commandId,
          operation,
          requestHash,
          now,
          input.expectedListingVersion,
        ),
        guardedListingVisibilityStatement(
          database,
          gameId,
          profile.id,
          input.commandId,
          requestHash,
          "unlisted",
          "host_unpublished",
          now,
        ),
      ]);
      if ((batch.at(-1)?.meta.changes ?? 0) !== 1) {
        const receipt = await findCommandReceipt(
          database,
          profile.id,
          input.commandId,
        );
        if (receipt) {
          return listingResultFromReceipt(
            database,
            receipt,
            user,
            operation,
            requestHash,
            gameId,
            now,
          );
        }
        throw new GameRuleError(
          "VERSION_CONFLICT",
          "The public listing changed. Refresh and try again.",
          409,
        );
      }
    } catch (error) {
      const receipt = await findCommandReceipt(
        database,
        profile.id,
        input.commandId,
      );
      if (receipt) {
        return listingResultFromReceipt(
          database,
          receipt,
          user,
          operation,
          requestHash,
          gameId,
          now,
        );
      }
      throw error;
    }
    const updatedListing = await readPublicListingForGame(database, gameId);
    return {
      listing: await buildViewerListing(
        database,
        row,
        state,
        user.userId,
        profile.id,
        now,
        updatedListing,
      ),
      view: await projectStoredGameForUser(
        database,
        state,
        user.userId,
        now,
      ),
      replayed: false,
    };
  }

  requireRule(
    state.phase === "lobby",
    "NOT_LOBBY",
    "Only a waiting lobby can be listed publicly.",
    409,
  );
  requireRule(
    state.players.filter((player) => player.status !== "left").length === 1,
    "NOT_SOLE_OCCUPANT",
    "A table can only be published while the host is its sole occupant.",
    409,
  );
  requireRule(
    listing?.state !== "listed",
    "VERSION_CONFLICT",
    "This table is already listed publicly.",
    409,
  );
  const hostPresence = await database
    .prepare(
      `SELECT last_seen_at FROM game_presence
       WHERE game_id = ? AND profile_id = ? LIMIT 1`,
    )
    .bind(gameId, profile.id)
    .first<HostPresenceRow>();
  requireRule(
    hostPresence &&
      Number(hostPresence.last_seen_at) >
        now - PUBLIC_HOST_SUPPRESSION_AFTER_MS,
    "HOST_OFFLINE",
    "Reconnect fully before publishing this table.",
    409,
  );

  const nextState = JSON.parse(JSON.stringify(state)) as GameState;
  const nextHost = nextState.players.find(
    (player) => player.userId === user.userId,
  );
  requireRule(
    nextHost,
    "CORRUPT_GAME_STATE",
    "The host player is missing from stored game state.",
    500,
  );
  nextHost.displayName = alias!;
  nextState.revision += 1;
  nextState.updatedAt = now;
  nextState.processedCommands.push({
    actorUserId: user.userId,
    commandId: input.commandId,
  });
  if (nextState.processedCommands.length > 64) {
    nextState.processedCommands.splice(
      0,
      nextState.processedCommands.length - 64,
    );
  }
  assertGameInvariants(nextState);
  const nextJson = JSON.stringify(nextState);
  const nextHash = await hashText(nextJson);
  const nextListingId = createPublicListingId();
  const nextListingVersion = (listing?.version ?? 0) + 1;
  const events: GameEvent[] = [
    {
      type: "public_listing_published",
      actorPlayerId: actor.playerId,
      message: "The host listed this table publicly.",
    },
  ];
  const publicationVoiceCleanupStatements = [
    ...state.players.map((player) =>
      guardedCommandLiveVoiceCleanupStatement(
        database,
        { kind: "participant", gameId, playerId: player.playerId },
        {
          actorProfileId: profile.id,
          commandId: input.commandId,
          operation,
          requestHash,
          now,
        },
      ),
    ),
    guardedCommandLiveVoiceCleanupStatement(
      database,
      { kind: "room", gameId },
      {
        actorProfileId: profile.id,
        commandId: input.commandId,
        operation,
        requestHash,
        now,
      },
    ),
  ];

  try {
    const batch = await database.batch([
      guardedPublishReceiptStatement(
        database,
        row,
        profile.id,
        input.commandId,
        operation,
        requestHash,
        nextState.revision,
        now,
        input.expectedListingVersion,
      ),
      guardedCommunicationScopeDowngradeStatement(
        database,
        gameId,
        profile.id,
        input.commandId,
        requestHash,
      ),
      guardedProfileNicknameStatement(
        database,
        profile.id,
        alias!,
        now,
        input.commandId,
        requestHash,
        gameId,
      ),
      guardedEventStatement(
        database,
        row,
        nextState.revision,
        input.commandId,
        profile.id,
        events,
        nextHash,
        now,
        requestHash,
      ),
      guardedHostDiscoveryConsentStatement(
        database,
        gameId,
        profile.id,
        now,
        input.commandId,
        requestHash,
      ),
      guardedPublishListingStatement(
        database,
        gameId,
        nextListingId,
        profile.id,
        input.pace,
        nextListingVersion,
        nextState.revision,
        now,
        input.expectedListingVersion,
        input.commandId,
        requestHash,
      ),
      ...publicationVoiceCleanupStatements,
      guardedGameUpdateStatement(
        database,
        row,
        nextState,
        nextJson,
        nextHash,
        now,
        now + LOBBY_LIFETIME_MS,
        profile.id,
        input.commandId,
        requestHash,
      ),
    ]);
    if ((batch.at(-1)?.meta.changes ?? 0) !== 1) {
      const receipt = await findCommandReceipt(
        database,
        profile.id,
        input.commandId,
      );
      if (receipt) {
        return listingResultFromReceipt(
          database,
          receipt,
          user,
          operation,
          requestHash,
          gameId,
          now,
        );
      }
      throw new GameRuleError(
        "VERSION_CONFLICT",
        "The table changed before publication completed. Refresh and try again.",
        409,
      );
    }
  } catch (error) {
    const receipt = await findCommandReceipt(
      database,
      profile.id,
      input.commandId,
    );
    if (receipt) {
      return listingResultFromReceipt(
        database,
        receipt,
        user,
        operation,
        requestHash,
        gameId,
        now,
      );
    }
    throw error;
  }
  const publishedListing = await readPublicListingForGame(database, gameId);
  return {
    listing: await buildViewerListing(
      database,
      { ...row, version: nextState.revision, state_json: nextJson, state_hash: nextHash },
      nextState,
      user.userId,
      profile.id,
      now,
      publishedListing,
    ),
    view: await projectStoredGameForUser(
      database,
      nextState,
      user.userId,
      now,
    ),
    replayed: false,
  };
}

export async function createGame(
  user: AuthenticatedUser,
  nickname: string,
  commandId: string,
): Promise<GameView> {
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maintainRooms(database, now);
  const profile = await getOrCreateProfile(user, nickname, database, now, true);
  const operation = "create_game";
  const requestHash = await hashText(
    JSON.stringify({ operation, nickname: profile.nickname }),
  );
  const existingReceipt = await findCommandReceipt(
    database,
    profile.id,
    commandId,
  );
  if (existingReceipt) {
    return viewFromReceipt(
      database,
      existingReceipt,
      user,
      operation,
      requestHash,
    );
  }
  await enforceMutationQuota(database, now, [
    {
      scope: `user:${profile.id}:create`,
      windowMs: 10 * 60_000,
      limit: 6,
    },
  ]);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const gameId = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    const joinCode = randomJoinCode();
    const state = createLobbyState({
      gameId,
      joinCode,
      hostUserId: user.userId,
      hostPlayerId: playerId,
      hostDisplayName: profile.nickname,
      now,
    });
    state.processedCommands.push({ actorUserId: user.userId, commandId });
    const stateJson = JSON.stringify(state);
    const stateHash = await hashText(stateJson);

    try {
      await database.batch([
        database
          .prepare(
            `INSERT INTO games (
              id, join_code, host_profile_id, rules_version, protocol_version,
              status, communication_scope, version, state_json, state_hash, created_at,
              last_activity_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, 'lobby', 'invite_only', 0, ?, ?, ?, ?, ?)`,
          )
          .bind(
            gameId,
            joinCode,
            profile.id,
            state.rules.version,
            state.protocolVersion,
            stateJson,
            stateHash,
            now,
            now,
            now + LOBBY_LIFETIME_MS,
          ),
        database
          .prepare(
            `INSERT INTO game_members (
              game_id, profile_id, seat, role, status, joined_at, join_source,
              event_floor_version
            ) VALUES (?, ?, 0, 'host', 'active', ?, 'host', 0)`,
          )
          .bind(gameId, profile.id, now),
        presenceUpsertStatement(
          database,
          gameId,
          playerId,
          profile.id,
          now,
        ),
        database
          .prepare(
            `INSERT INTO game_events (
              game_id, version, command_id, actor_profile_id, kind,
              public_payload_json, state_hash, created_at
            ) VALUES (?, 0, ?, ?, 'game_created', '[]', ?, ?)`,
          )
          .bind(gameId, commandId, profile.id, stateHash, now),
        database
          .prepare(
            `INSERT INTO command_receipts (
              actor_profile_id, command_id, game_id, operation,
              request_hash, result_version, created_at
            ) VALUES (?, ?, ?, ?, ?, 0, ?)`,
          )
          .bind(profile.id, commandId, gameId, operation, requestHash, now),
        database
          .prepare(
            `UPDATE lobby_invitations
             SET state = 'expired', pending_key = NULL, responded_at = ?
             WHERE recipient_profile_id = ? AND state = 'pending'
               AND EXISTS (
                 SELECT 1 FROM command_receipts receipt
                 WHERE receipt.actor_profile_id = ? AND receipt.command_id = ?
                   AND receipt.game_id = ? AND receipt.request_hash = ?
               )`,
          )
          .bind(
            now,
            profile.id,
            profile.id,
            commandId,
            gameId,
            requestHash,
          ),
        database
          .prepare(
            `DELETE FROM lobby_presence
             WHERE profile_id = ? AND EXISTS (
               SELECT 1 FROM command_receipts receipt
               WHERE receipt.actor_profile_id = ? AND receipt.command_id = ?
                 AND receipt.game_id = ? AND receipt.request_hash = ?
             )`,
          )
          .bind(profile.id, profile.id, commandId, gameId, requestHash),
      ]);
      return projectStoredGameForUser(database, state, user.userId, now);
    } catch (error) {
      const receipt = await findCommandReceipt(database, profile.id, commandId);
      if (receipt) {
        return viewFromReceipt(
          database,
          receipt,
          user,
          operation,
          requestHash,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("join_code") ||
        message.includes("idx_games_join_code")
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new GameRuleError(
    "JOIN_CODE_UNAVAILABLE",
    "A unique lobby code could not be created. Please try again.",
    503,
  );
}

export async function joinGame(
  user: AuthenticatedUser,
  nickname: string,
  joinCodeInput: string,
  commandId: string,
): Promise<ManualJoinResult> {
  const joinCode = normalizeJoinCode(joinCodeInput);
  const alias = normalizePublicAlias(nickname);
  requireRule(
    alias,
    "INVALID_ALIAS",
    "Use a 2–24 character alias with letters, numbers, spaces, _, apostrophes, or hyphens.",
    400,
  );
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maintainRooms(database, now);
  const initialProfile = await findProfileForUser(database, user.userId);
  const operation = "join_game";
  const requestHash = await hashText(
    JSON.stringify({ operation, joinCode, nickname: alias }),
  );
  const existingReceipt = initialProfile
    ? await findCommandReceipt(database, initialProfile.id, commandId)
    : null;
  if (existingReceipt) {
    return manualJoinResult(await viewFromReceipt(
      database,
      existingReceipt,
      user,
      operation,
      requestHash,
      undefined,
      joinCode,
    ), true);
  }

  let quotaCharged = false;
  const candidateProfileId = crypto.randomUUID();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const storedProfile = await findProfileForUser(database, user.userId);
    const profile: ProfileRow = storedProfile
      ? { ...storedProfile, nickname: alias }
      : {
          id: candidateProfileId,
          auth_subject: user.userId,
          nickname: alias,
        };
    const acceptedReceipt = storedProfile
      ? await findCommandReceipt(database, storedProfile.id, commandId)
      : null;
    if (acceptedReceipt) {
      return manualJoinResult(await viewFromReceipt(
        database,
        acceptedReceipt,
        user,
        operation,
        requestHash,
        undefined,
        joinCode,
      ), true);
    }
    const row = await database
      .prepare(
        `SELECT id, join_code, host_profile_id, rules_version, protocol_version,
                status, version, state_json, state_hash, room_status,
                closed_at, close_reason, abandoned_since, last_activity_at,
                expires_at
         FROM games WHERE join_code = ? LIMIT 1`,
      )
      .bind(joinCode)
      .first<GameRow>();
    requireRule(row, "LOBBY_NOT_FOUND", "No lobby uses that code.", 404);
    requireRule(row.expires_at > now, "LOBBY_EXPIRED", "That lobby has expired.", 410);
    requireOpenRoom(row, "That room is closed and cannot be joined.");
    const current = await parseAndValidateState(row);
    const alreadyActive = current.players.some(
      (player) => player.userId === user.userId && player.status !== "left",
    );
    const recoversAcceptedJoin = current.processedCommands.some(
      (entry) =>
        entry.actorUserId === user.userId && entry.commandId === commandId,
    );
    if (alreadyActive && !recoversAcceptedJoin) {
      return manualJoinResult(
        await projectStoredGameForUser(database, current, user.userId, now),
        true,
      );
    }
    if (!quotaCharged) {
      await enforceMutationQuota(database, now, [
        {
          scope: `auth:${user.userId}:join`,
          windowMs: 60_000,
          limit: 30,
        },
        { scope: `room:${row.id}`, windowMs: 60_000, limit: 240 },
      ]);
      quotaCharged = true;
    }
    const result = joinLobbyState(current, {
      userId: user.userId,
      playerId: crypto.randomUUID(),
      displayName: alias,
      commandId,
      now,
    });
    if (result.replayed) {
      const joined = current.players.find(
        (player) => player.userId === user.userId,
      )!;
      try {
        await database.batch([
          guardedJoinReceiptStatement(
            database,
            row,
            profile.id,
            storedProfile !== null,
            user.userId,
            commandId,
            operation,
            requestHash,
            current.revision,
            now,
          ),
          guardedPublicProfileProvisionStatement(
            database,
            profile.id,
            user.userId,
            alias,
            now,
            commandId,
            requestHash,
            row.id,
          ),
          guardedMembershipUpsertStatement(
            database,
            row.id,
            profile,
            joined,
            now,
            profile.id,
            commandId,
            requestHash,
            current.hostUserId,
            current.revision,
          ),
          guardedPresenceUpsertStatement(
            database,
            row.id,
            joined.playerId,
            profile.id,
            now,
            profile.id,
            commandId,
            requestHash,
          ),
          guardedLobbyPresenceExpireStatement(
            database,
            profile.id,
            now,
            commandId,
            requestHash,
            row.id,
          ),
          guardedLobbyPresenceDeleteStatement(
            database,
            profile.id,
            commandId,
            requestHash,
            row.id,
          ),
        ]);
      } catch (error) {
        const receipt = await findCommandReceipt(database, profile.id, commandId);
        if (!receipt) throw error;
        return manualJoinResult(await viewFromReceipt(
          database,
          receipt,
          user,
          operation,
          requestHash,
          row.id,
          joinCode,
        ), true);
      }
      const receipt = await findCommandReceipt(database, profile.id, commandId);
      if (!receipt) continue;
      return manualJoinResult(await viewFromReceipt(
        database,
        receipt,
        user,
        operation,
        requestHash,
        row.id,
        joinCode,
      ), true);
    }

    const nextJson = JSON.stringify(result.state);
    const nextHash = await hashText(nextJson);
    const joined = result.state.players.find(
      (player) => player.userId === user.userId,
    )!;
    try {
      const batch = await database.batch([
        guardedJoinReceiptStatement(
          database,
          row,
          profile.id,
          storedProfile !== null,
          user.userId,
          commandId,
          operation,
          requestHash,
          result.state.revision,
          now,
        ),
        guardedListingVisibilityStatement(
          database,
          row.id,
          profile.id,
          commandId,
          requestHash,
          "unlisted",
          "private_join",
          now,
        ),
        guardedPublicProfileProvisionStatement(
          database,
          profile.id,
          user.userId,
          alias,
          now,
          commandId,
          requestHash,
          row.id,
        ),
        guardedEventStatement(
          database,
          row,
          result.state.revision,
          commandId,
          profile.id,
          result.events,
          nextHash,
          now,
          requestHash,
        ),
        staleSeatCleanupStatement(
          database,
          row.id,
          joined.seat,
          profile.id,
          profile.id,
          commandId,
          requestHash,
        ),
        guardedMembershipUpsertStatement(
          database,
          row.id,
          profile,
          joined,
          now,
          profile.id,
          commandId,
          requestHash,
          result.state.hostUserId,
          result.state.revision,
        ),
        guardedPresenceUpsertStatement(
          database,
          row.id,
          joined.playerId,
          profile.id,
          now,
          profile.id,
          commandId,
          requestHash,
        ),
        guardedLobbyPresenceExpireStatement(
          database,
          profile.id,
          now,
          commandId,
          requestHash,
          row.id,
        ),
        guardedLobbyPresenceDeleteStatement(
          database,
          profile.id,
          commandId,
          requestHash,
          row.id,
        ),
        guardedGameUpdateStatement(
          database,
          row,
          result.state,
          nextJson,
          nextHash,
          now,
          now + LOBBY_LIFETIME_MS,
          profile.id,
          commandId,
          requestHash,
        ),
      ]);
      if ((batch.at(-1)?.meta.changes ?? 0) !== 1) {
        const receipt = await findCommandReceipt(database, profile.id, commandId);
        if (receipt) {
          return manualJoinResult(await viewFromReceipt(
            database,
            receipt,
            user,
            operation,
            requestHash,
            row.id,
            joinCode,
          ), true);
        }
        continue;
      }
    } catch (error) {
      const receipt = await findCommandReceipt(database, profile.id, commandId);
      if (receipt) {
        return manualJoinResult(await viewFromReceipt(
          database,
          receipt,
          user,
          operation,
          requestHash,
          row.id,
          joinCode,
        ), true);
      }
      throw error;
    }
    return manualJoinResult(
      await projectStoredGameForUser(database, result.state, user.userId, now),
      false,
    );
  }

  throw new GameRuleError(
    "LOBBY_CHANGED",
    "The lobby changed while you were joining. Please try once more.",
    409,
  );
}

function manualJoinResult(view: GameView, replayed: boolean): ManualJoinResult {
  return Object.freeze({ view, replayed });
}

export async function joinPublicRoom(
  user: AuthenticatedUser,
  listingIdInput: string,
  aliasInput: string,
  commandId: string,
): Promise<PublicJoinResult> {
  return joinSelectedPublicRoom(
    user,
    listingIdInput,
    aliasInput,
    commandId,
  );
}

export async function quickJoinPublicRoom(
  user: AuthenticatedUser,
  aliasInput: string,
  commandId: string,
): Promise<PublicJoinResult> {
  requireRule(
    getV15FeaturePolicy().discoveryEnabled,
    "DISCOVERY_DISABLED",
    "Public table discovery is not available.",
    404,
  );
  const alias = normalizePublicAlias(aliasInput);
  requireRule(
    alias,
    "INVALID_ALIAS",
    "Use a 2–24 character alias with letters, numbers, spaces, _, apostrophes, or hyphens.",
    400,
  );
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  const operation = "quick_public_join";
  // The selected opaque locator is deliberately absent. A lost-response retry
  // must resolve the durable receipt instead of selecting from a changed pool.
  const requestHash = await hashText(JSON.stringify({ operation, alias }));
  const existing = await recoverPublicJoinReceipt(
    database,
    user,
    commandId,
    operation,
    requestHash,
  );
  if (existing) return existing;

  try {
    await enforceMutationQuota(database, now, [
      {
        scope: `auth:${user.userId}:public-join`,
        windowMs: 60_000,
        limit: 30,
      },
    ]);
  } catch (error) {
    const recovered = await recoverPublicJoinReceipt(
      database,
      user,
      commandId,
      operation,
      requestHash,
    );
    if (recovered) return recovered;
    throw error;
  }

  const attemptedListingIds = new Set<string>();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const accepted = await recoverPublicJoinReceipt(
      database,
      user,
      commandId,
      operation,
      requestHash,
    );
    if (accepted) return accepted;

    const pool = await listPublicRooms(user, null);
    const candidates = pool.enabled
      ? pool.rooms.filter(
          (room) => !attemptedListingIds.has(room.listingId),
        )
      : [];
    if (candidates.length === 0) break;
    const selected = candidates[secureRandomIndex(candidates.length)];
    attemptedListingIds.add(selected.listingId);
    try {
      return await joinSelectedPublicRoom(
        user,
        selected.listingId,
        alias,
        commandId,
        { operation, requestHash, actorQuotaCharged: true },
      );
    } catch (error) {
      if (!isRetryableQuickSelectionError(error)) throw error;
    }
  }

  // A concurrent identical request can fill the final table between pool read
  // and exhaustion. Its durable receipt wins over the empty-pool response.
  const accepted = await recoverPublicJoinReceipt(
    database,
    user,
    commandId,
    operation,
    requestHash,
  );
  if (accepted) return accepted;
  throw new GameRuleError(
    "NO_ELIGIBLE_PUBLIC_ROOM",
    "No eligible public table is available right now.",
    404,
  );
}

async function joinSelectedPublicRoom(
  user: AuthenticatedUser,
  listingIdInput: string,
  aliasInput: string,
  commandId: string,
  execution?: PublicJoinExecutionContext,
): Promise<PublicJoinResult> {
  requireRule(
    getV15FeaturePolicy().discoveryEnabled,
    "DISCOVERY_DISABLED",
    "Public table discovery is not available.",
    404,
  );
  requireRule(
    isPublicListingId(listingIdInput),
    "PUBLIC_ROOM_UNAVAILABLE",
    "This public table is no longer available.",
    404,
  );
  const listingId = listingIdInput;
  const alias = normalizePublicAlias(aliasInput);
  requireRule(
    alias,
    "INVALID_ALIAS",
    "Use a 2–24 character alias with letters, numbers, spaces, _, apostrophes, or hyphens.",
    400,
  );

  const database = await ensureDatabaseSchema();
  const now = Date.now();
  const operation = execution?.operation ?? "public_join";
  const requestHash = execution?.requestHash ?? await hashText(
    JSON.stringify({ operation, listingId, alias }),
  );
  const initialProfile = await findProfileForUser(database, user.userId);
  const initialReceipt = initialProfile
    ? await findCommandReceipt(database, initialProfile.id, commandId)
    : null;
  if (initialReceipt) {
    return publicJoinSnapshotFromReceipt(
      database,
      initialReceipt,
      user,
      operation,
      requestHash,
    );
  }

  // The actor limiter deliberately runs before resolving the opaque target.
  // This makes guessed locators no cheaper to probe than valid ones.
  if (!execution?.actorQuotaCharged) {
    try {
      await enforceMutationQuota(database, now, [
        {
          scope: `auth:${user.userId}:public-join`,
          windowMs: 60_000,
          limit: 30,
        },
      ]);
    } catch (error) {
      const recovered = await recoverPublicJoinReceipt(
        database,
        user,
        commandId,
        operation,
        requestHash,
      );
      if (recovered) return recovered;
      throw error;
    }
  }
  await maintainRooms(database, now);

  const candidateProfileId = crypto.randomUUID();
  let targetQuotaCharged = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const profile = await findProfileForUser(database, user.userId);
    const actorProfileId = profile?.id ?? candidateProfileId;
    const receipt = profile
      ? await findCommandReceipt(database, profile.id, commandId)
      : null;
    if (receipt) {
      return publicJoinSnapshotFromReceipt(
        database,
        receipt,
        user,
        operation,
        requestHash,
      );
    }

    const target = await readPublicJoinTarget(database, listingId);
    if (!target) throwPublicRoomUnavailable();
    const current = await requireEligiblePublicJoinTarget(
      database,
      target,
      user.userId,
      actorProfileId,
      now,
    );

    if (!targetQuotaCharged) {
      try {
        await enforceMutationQuota(database, now, [
          {
            scope: `room:${target.id}:public-join`,
            windowMs: 60_000,
            limit: 240,
          },
          {
            scope: `listing:${listingId}:public-join`,
            windowMs: 60_000,
            limit: 240,
          },
        ]);
      } catch (error) {
        const recovered = await recoverPublicJoinReceipt(
          database,
          user,
          commandId,
          operation,
          requestHash,
        );
        if (recovered) return recovered;
        throw error;
      }
      targetQuotaCharged = true;
    }

    let joinedResult: ReturnType<typeof joinLobbyState>;
    try {
      joinedResult = joinLobbyState(current, {
        userId: user.userId,
        playerId: crypto.randomUUID(),
        displayName: alias,
        commandId,
        now,
      });
    } catch (error) {
      if (error instanceof GameRuleError && error.code === "LOBBY_FULL") {
        throwPublicRoomFull();
      }
      if (error instanceof GameRuleError) throwPublicRoomUnavailable();
      throw error;
    }
    if (joinedResult.replayed) throwPublicRoomUnavailable();

    const joined = joinedResult.state.players.find(
      (player) => player.userId === user.userId,
    );
    if (!joined) throwPublicRoomUnavailable();
    const nextJson = JSON.stringify(joinedResult.state);
    const nextHash = await hashText(nextJson);
    const eventCommandId = `public-join:${actorProfileId}:${commandId}`;

    try {
      const batch = await database.batch([
        guardedPublicJoinReceiptStatement(
          database,
          target,
          current,
          actorProfileId,
          profile !== null,
          user.userId,
          commandId,
          operation,
          requestHash,
          joinedResult.state.revision,
          now,
        ),
        guardedCommunicationScopeDowngradeStatement(
          database,
          target.id,
          actorProfileId,
          commandId,
          requestHash,
        ),
        guardedPublicProfileProvisionStatement(
          database,
          actorProfileId,
          user.userId,
          alias,
          now,
          commandId,
          requestHash,
          target.id,
        ),
        guardedEventStatement(
          database,
          target,
          joinedResult.state.revision,
          commandId,
          actorProfileId,
          joinedResult.events,
          nextHash,
          now,
          requestHash,
          eventCommandId,
        ),
        staleSeatCleanupStatement(
          database,
          target.id,
          joined.seat,
          actorProfileId,
          actorProfileId,
          commandId,
          requestHash,
        ),
        guardedPublicMembershipUpsertStatement(
          database,
          target.id,
          actorProfileId,
          joined,
          now,
          commandId,
          requestHash,
          joinedResult.state.revision,
        ),
        guardedPresenceUpsertStatement(
          database,
          target.id,
          joined.playerId,
          actorProfileId,
          now,
          actorProfileId,
          commandId,
          requestHash,
        ),
        guardedLobbyPresenceExpireStatement(
          database,
          actorProfileId,
          now,
          commandId,
          requestHash,
          target.id,
        ),
        guardedLobbyPresenceDeleteStatement(
          database,
          actorProfileId,
          commandId,
          requestHash,
          target.id,
        ),
        guardedGameUpdateStatement(
          database,
          target,
          joinedResult.state,
          nextJson,
          nextHash,
          now,
          now + LOBBY_LIFETIME_MS,
          actorProfileId,
          commandId,
          requestHash,
          OPEN_ROOM_LIFECYCLE,
          eventCommandId,
        ),
      ]);
      if ((batch.at(-1)?.meta.changes ?? 0) === 1) {
        return publicJoinResult(await getGame(user, target.id), false);
      }
    } catch (error) {
      const accepted = await findCommandReceipt(
        database,
        actorProfileId,
        commandId,
      );
      if (accepted) {
        return publicJoinSnapshotFromReceipt(
          database,
          accepted,
          user,
          operation,
          requestHash,
        );
      }
      if (!isRetryableMutationConflict(error)) throw error;
    }

    const accepted = await findCommandReceipt(
      database,
      actorProfileId,
      commandId,
    );
    if (accepted) {
      return publicJoinSnapshotFromReceipt(
        database,
        accepted,
        user,
        operation,
        requestHash,
      );
    }
  }

  throwPublicRoomUnavailable();
}

export async function getGame(
  user: AuthenticatedUser,
  gameId: string,
  afterRevision?: number,
): Promise<GameSnapshot> {
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maintainRooms(database, now);
  const row = await getGameRow(database, gameId);
  const state = await parseAndValidateState(row);
  requireRule(
    state.players.some(
      (player) => player.userId === user.userId && player.status !== "left",
    ),
    "NOT_A_MEMBER",
    "You are not a member of this game.",
    403,
  );
  const membership = await database
    .prepare(
      `SELECT m.profile_id, m.event_floor_version
       FROM game_members m
       JOIN profiles p ON p.id = m.profile_id
       WHERE m.game_id = ? AND p.auth_subject = ? AND m.status <> 'left'
       LIMIT 1`,
    )
    .bind(gameId, user.userId)
    .first<MemberAccessRow>();
  requireRule(
    membership,
    "NOT_A_MEMBER",
    "You are not a member of this game.",
    403,
  );
  const feed = await readPublicEventFeed(
    database,
    gameId,
    afterRevision,
    Math.max(0, Number(membership.event_floor_version)),
  );
  const presence = await buildPresenceSnapshot(database, state, now);
  const listing = getV15FeaturePolicy().discoveryEnabled
    ? await buildViewerListing(
        database,
        row,
        state,
        user.userId,
        membership.profile_id,
        now,
      )
    : undefined;
  return {
    view: await projectStoredGameForUser(
      database,
      state,
      user.userId,
      now,
      presence,
    ),
    events: feed.events,
    eventCursor: feed.cursor,
    presence,
    ...(listing ? { listing } : {}),
  };
}

export async function getViewerListingForGame(
  user: AuthenticatedUser,
  gameId: string,
): Promise<ViewerListing | undefined> {
  if (!getV15FeaturePolicy().discoveryEnabled) return undefined;
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maintainRooms(database, now);
  const row = await getGameRow(database, gameId);
  const state = await parseAndValidateState(row);
  requireCurrentMember(state, user.userId);
  const profile = await findProfileForUser(database, user.userId);
  requireRule(
    profile,
    "NOT_A_MEMBER",
    "You are not a member of this game.",
    403,
  );
  return buildViewerListing(
    database,
    row,
    state,
    user.userId,
    profile.id,
    now,
  );
}

export async function getGamePresence(
  user: AuthenticatedUser,
  gameId: string,
): Promise<PresenceSnapshot> {
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maintainRooms(database, now);
  const row = await getGameRow(database, gameId);
  const state = await parseAndValidateState(row);
  requireCurrentMember(state, user.userId);
  return buildPresenceSnapshot(database, state, now);
}

export async function heartbeatGamePresence(
  user: AuthenticatedUser,
  gameId: string,
): Promise<PresenceSnapshot> {
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maintainRooms(database, now);
  const row = await getGameRow(database, gameId);
  const state = await parseAndValidateState(row);
  const player = requireCurrentMember(state, user.userId);
  const profile = await getOrCreateProfile(
    user,
    user.suggestedName,
    database,
    now,
  );
  await enforceMutationQuota(database, now, [
    {
      scope: `user:${profile.id}:presence`,
      windowMs: 60_000,
      // Multiple tabs for the same identity should not make presence flaky.
      limit: 60,
    },
    { scope: `room:${gameId}:presence`, windowMs: 60_000, limit: 360 },
  ]);
  const [result] = await database.batch([
    presenceUpsertStatement(
      database,
      gameId,
      player.playerId,
      profile.id,
      now,
    ),
    database
      .prepare(
        `UPDATE games
         SET abandoned_since = NULL
         WHERE id = ? AND room_status = 'open'`,
      )
      .bind(gameId),
  ]);
  if ((result.meta.changes ?? 0) !== 1) {
    await getGameRow(database, gameId);
  }
  requireRule(
    (result.meta.changes ?? 0) === 1,
    "NOT_A_MEMBER",
    "You are not an active member of this game.",
    403,
  );
  return buildPresenceSnapshot(database, state, now);
}

export async function executeGameCommand(
  user: AuthenticatedUser,
  gameId: string,
  expectedRevision: number,
  commandId: string,
  command: GameCommand,
): Promise<GameCommandResult> {
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maintainRooms(database, now);
  const profile = await getOrCreateProfile(
    user,
    user.suggestedName,
    database,
    now,
  );
  const operation = "game_command";
  const requestHash = await hashText(
    JSON.stringify({ operation, gameId, command }),
  );
  const durableReceipt = await findCommandReceipt(
    database,
    profile.id,
    commandId,
  );
  if (durableReceipt) {
    return replayedGameCommandResult(
      await commandViewFromReceipt(
        database,
        durableReceipt,
        user,
        operation,
        requestHash,
        gameId,
        command.type === "leave_game",
      ),
    );
  }
  await enforceMutationQuota(database, now, [
    {
      scope: `user:${profile.id}:command`,
      windowMs: 60_000,
      limit: 120,
    },
  ]);
  const row = await getGameRow(database, gameId);
  const current = await parseAndValidateState(row);
  const currentActor = current.players.find(
    (player) => player.userId === user.userId && player.status !== "left",
  );
  if (currentActor) {
    await presenceUpsertStatement(
      database,
      gameId,
      currentActor.playerId,
      profile.id,
      now,
    ).run();
  }

  if (
    current.processedCommands.some(
      (entry) =>
        entry.actorUserId === user.userId && entry.commandId === commandId,
    )
  ) {
    await database
      .prepare(
        `INSERT OR IGNORE INTO command_receipts (
          actor_profile_id, command_id, game_id, operation,
          request_hash, result_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        profile.id,
        commandId,
        gameId,
        operation,
        requestHash,
        current.revision,
        now,
      )
      .run();
    const recoveredReceipt = await findCommandReceipt(
      database,
      profile.id,
      commandId,
    );
    requireRule(
      recoveredReceipt,
      "RECEIPT_RECOVERY_FAILED",
      "The accepted command could not be recovered safely.",
      500,
    );
    return replayedGameCommandResult(
      await commandViewFromReceipt(
        database,
        recoveredReceipt,
        user,
        operation,
        requestHash,
        gameId,
        command.type === "leave_game",
      ),
    );
  }

  requireRule(
    currentActor,
    "NOT_A_MEMBER",
    "You are not a member of this game.",
    403,
  );
  await enforceMutationQuota(database, now, [
    { scope: `room:${gameId}`, windowMs: 60_000, limit: 360 },
  ]);

  if (row.version !== expectedRevision || current.revision !== expectedRevision) {
    throw new GameRuleError(
      "VERSION_CONFLICT",
      "The game moved on. Refreshing will show the latest turn.",
      409,
    );
  }
  requireRule(
    current.phase !== "complete" ||
      command.type === "rematch" ||
      command.type === "claim_host" ||
      command.type === "leave_game",
    "GAME_COMPLETE",
    "This game is already complete. Start a rematch, recover hosting, or leave the table.",
    409,
  );
  const inactiveRemoval = readInactiveRemovalCommand(command);
  const inactiveRemovalGuard = inactiveRemoval
    ? await assertInactiveRemovalAllowed(
        database,
        current,
        user.userId,
        inactiveRemoval.targetPlayerId,
        now,
      )
    : null;
  const hostClaim = readHostClaimCommand(command);
  const hostClaimGuard = hostClaim
    ? await assertHostClaimAllowed(
        database,
        current,
        user.userId,
        profile.id,
        now,
      )
    : null;
  const result = transitionGame(current, command, {
    actorUserId: user.userId,
    commandId,
    now,
  });
  const closesEmptyRoom =
    command.type === "leave_game" &&
    result.state.players.every((player) => player.status === "left");
  const roomLifecycle: RoomLifecycleUpdate = closesEmptyRoom
    ? {
        roomStatus: "closed",
        closedAt: now,
        closeReason: "empty",
        abandonedSince: null,
      }
    : {
        roomStatus: "open",
        closedAt: null,
        closeReason: null,
        abandonedSince: null,
      };
  const persistedEvents: GameEvent[] = closesEmptyRoom
    ? [
        ...result.events,
        {
          type: "room_closed",
          actorPlayerId: currentActor?.playerId ?? null,
          message: "The empty room closed.",
          data: { reason: "empty" },
        },
      ]
    : result.events;
  const listingLifecycle = closesEmptyRoom
    ? ({ state: "closed", reason: "empty" } as const)
    : result.state.hostUserId !== current.hostUserId
      ? ({ state: "unlisted", reason: "host_changed" } as const)
      : current.phase === "lobby" && result.state.phase !== "lobby"
        ? ({ state: "unlisted", reason: "game_started" } as const)
        : null;
  const nextJson = JSON.stringify(result.state);
  const nextHash = await hashText(nextJson);
  const expiresAt = closesEmptyRoom
    ? roomTombstoneExpiresAt(now)
    : now +
      (result.state.phase === "lobby" ? LOBBY_LIFETIME_MS : ACTIVE_LIFETIME_MS);
  const memberProfiles = await profilesForState(database, result.state);
  const completedRoundWinner =
    current.phase === "playing" &&
    result.state.phase === "complete" &&
    result.state.winner !== null
      ? result.state.players.find(
          (player) => player.playerId === result.state.winner?.playerId,
        )
      : undefined;
  const completedRoundWinnerProfile = completedRoundWinner
    ? memberProfiles.get(completedRoundWinner.userId)
    : undefined;
  requireRule(
    !completedRoundWinner || completedRoundWinnerProfile,
    "CORRUPT_MEMBERSHIP",
    "The round winner membership record is unavailable.",
    500,
  );
  const memberStatements = result.state.players.map((player) =>
    guardedMembershipUpsertStatement(
      database,
      gameId,
      memberProfiles.get(player.userId)!,
      player,
      now,
      profile.id,
      commandId,
      requestHash,
      result.state.hostUserId,
      0,
    ),
  );
  const actorStillPresent = result.state.players.some(
    (player) => player.userId === user.userId,
  );
  if (!actorStillPresent) {
    memberStatements.push(
      guardedDepartedMemberStatement(
        database,
        gameId,
        profile.id,
        now,
        commandId,
        requestHash,
      ),
    );
  }
  const remainingPlayerIds = new Set(
    result.state.players
      .filter((player) => player.status !== "left")
      .map((player) => player.playerId),
  );
  const newlyDepartedPlayerIds = current.players
    .filter(
      (player) =>
        player.status !== "left" && !remainingPlayerIds.has(player.playerId),
    )
    .map((player) => player.playerId);
  const departedPlayerIds = newlyDepartedPlayerIds.concat(
    result.state.players
      .filter((player) => player.status === "left")
      .map((player) => player.playerId),
  );
  const presenceCleanupStatements = [...new Set(departedPlayerIds)].map(
    (playerId) =>
      guardedPresenceDeleteStatement(
        database,
        gameId,
        playerId,
        profile.id,
        commandId,
        requestHash,
      ),
  );
  const voiceCleanupPlayerIds = new Set(newlyDepartedPlayerIds);
  if (closesEmptyRoom) {
    for (const player of [...current.players, ...result.state.players]) {
      voiceCleanupPlayerIds.add(player.playerId);
    }
  }
  const voiceCleanupStatements = [...voiceCleanupPlayerIds].map(
    (playerId) =>
      guardedCommandLiveVoiceCleanupStatement(
        database,
        { kind: "participant", gameId, playerId },
        {
          actorProfileId: profile.id,
          commandId,
          operation,
          requestHash,
          now,
        },
      ),
  );
  if (closesEmptyRoom) {
    voiceCleanupStatements.push(
      guardedCommandLiveVoiceCleanupStatement(
        database,
        { kind: "room", gameId },
        {
          actorProfileId: profile.id,
          commandId,
          operation,
          requestHash,
          now,
        },
      ),
    );
  }

  try {
    const batch = await database.batch([
      hostClaimGuard
        ? guardedHostClaimReceiptStatement(
            database,
            row,
            profile.id,
            commandId,
            operation,
            requestHash,
            result.state.revision,
            now,
            current.phase,
            hostClaimGuard,
          )
        : inactiveRemovalGuard
        ? guardedInactiveRemovalReceiptStatement(
            database,
            row,
            profile.id,
            commandId,
            operation,
            requestHash,
            result.state.revision,
            now,
            inactiveRemovalGuard,
          )
        : guardedReceiptStatement(
            database,
            row,
            profile.id,
            commandId,
            operation,
            requestHash,
            result.state.revision,
            now,
          ),
      ...(listingLifecycle
        ? [
            guardedListingVisibilityStatement(
              database,
              gameId,
              profile.id,
              commandId,
              requestHash,
              listingLifecycle.state,
              listingLifecycle.reason,
              now,
            ),
          ]
        : []),
      guardedEventStatement(
        database,
        row,
        result.state.revision,
        commandId,
        profile.id,
        persistedEvents,
        nextHash,
        now,
        requestHash,
      ),
      ...(completedRoundWinner && completedRoundWinnerProfile
        ? [
            guardedRoundLedgerStatement(
              database,
              gameId,
              result.state.revision,
              completedRoundWinnerProfile.id,
              completedRoundWinner.displayName,
              result.state.winner!.reason,
              now,
              profile.id,
              commandId,
              requestHash,
              nextHash,
            ),
          ]
        : []),
      ...memberStatements,
      ...presenceCleanupStatements,
      ...voiceCleanupStatements,
      guardedGameUpdateStatement(
        database,
        row,
        result.state,
        nextJson,
        nextHash,
        now,
        expiresAt,
        profile.id,
        commandId,
        requestHash,
        roomLifecycle,
        commandId,
        completedRoundWinner ? result.state.revision : null,
      ),
    ]);
    if ((batch.at(-1)?.meta.changes ?? 0) !== 1) {
      const receipt = await findCommandReceipt(database, profile.id, commandId);
      if (receipt) {
        return replayedGameCommandResult(
          await commandViewFromReceipt(
            database,
            receipt,
            user,
            operation,
            requestHash,
            gameId,
            command.type === "leave_game",
          ),
        );
      }
      // Surface the terminal lifecycle result when this command lost a race
      // with automatic closure; otherwise preserve the normal version-conflict
      // recovery path for an open room.
      await getGameRow(database, gameId);
      if (inactiveRemoval) {
        try {
          await assertInactiveRemovalAllowed(
            database,
            current,
            user.userId,
            inactiveRemoval.targetPlayerId,
            Date.now(),
          );
        } catch (recheckError) {
          if (
            recheckError instanceof GameRuleError &&
            ["CORRUPT_MEMBERSHIP", "PLAYER_NOT_ACTIVE", "PLAYER_NOT_FOUND"].includes(
              recheckError.code,
            )
          ) {
            throw new GameRuleError(
              "VERSION_CONFLICT",
              "That player's state changed before removal completed. Refreshing will show the latest table.",
              409,
            );
          }
          throw recheckError;
        }
      }
      throw new GameRuleError(
        "VERSION_CONFLICT",
        "Another move arrived first. Refreshing will show it.",
        409,
      );
    }
  } catch (error) {
    const receipt = await findCommandReceipt(database, profile.id, commandId);
    if (receipt) {
      return replayedGameCommandResult(
        await commandViewFromReceipt(
          database,
          receipt,
          user,
          operation,
          requestHash,
          gameId,
          command.type === "leave_game",
        ),
      );
    }
    throw error;
  }

  return {
    view: await commandViewForUser(database, result.state, user.userId),
    ...gameCommandActivityFields(
      result.replayed,
      result.state.revision,
      persistedEvents,
    ),
  };
}

function replayedGameCommandResult(view: GameView | null): GameCommandResult {
  return {
    view,
    ...gameCommandActivityFields(true, 0, []),
  };
}

export async function listLobbies(
  user: AuthenticatedUser,
): Promise<{ mine: LobbySummary[] }> {
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maintainRooms(database, now);
  const profile = await getOrCreateProfile(
    user,
    user.suggestedName,
    database,
    now,
  );

  const mineRows = await database
    .prepare(
      `SELECT g.id, g.join_code, g.host_profile_id, g.rules_version,
              g.protocol_version, g.status, g.version, g.state_json,
              g.state_hash, g.room_status, g.closed_at, g.close_reason,
              g.abandoned_since, g.last_activity_at, g.expires_at
       FROM games g
       JOIN game_members m ON m.game_id = g.id
       WHERE m.profile_id = ? AND m.status <> 'left'
         AND g.room_status = 'open' AND g.expires_at > ?
       ORDER BY g.last_activity_at DESC LIMIT 20`,
    )
    .bind(profile.id, now)
    .all<GameRow>();

  return {
    mine: await Promise.all(
      mineRows.results.map((row) => summarize(row, user.userId)),
    ),
  };
}

function readInactiveRemovalCommand(
  command: GameCommand,
): InactiveRemovalCommand | null {
  if (command.type !== "remove_inactive_player") return null;
  requireRule(
    typeof command.targetPlayerId === "string" &&
      command.targetPlayerId.length > 0 &&
      command.targetPlayerId.length <= 100,
    "INVALID_FIELD",
    "targetPlayerId must identify a player in this game.",
    400,
  );
  return command;
}

function readHostClaimCommand(command: GameCommand): HostClaimCommand | null {
  return command.type === "claim_host" ? command : null;
}

function requireCurrentMember(
  state: GameState,
  userId: string,
): GameState["players"][number] {
  const player = state.players.find(
    (candidate) =>
      candidate.userId === userId && candidate.status !== "left",
  );
  requireRule(
    player,
    "NOT_A_MEMBER",
    "You are not a member of this game.",
    403,
  );
  return player;
}

async function buildPresenceSnapshot(
  database: D1Database,
  state: GameState,
  now: number,
): Promise<PresenceSnapshot> {
  const rows = await database
    .prepare(
      `SELECT p.auth_subject, m.joined_at, gp.player_id, gp.last_seen_at
       FROM game_members m
       JOIN profiles p ON p.id = m.profile_id
       LEFT JOIN game_presence gp
         ON gp.game_id = m.game_id AND gp.profile_id = m.profile_id
       WHERE m.game_id = ? AND m.status <> 'left'`,
    )
    .bind(state.gameId)
    .all<PresenceRosterRow>();
  const byUserId = new Map(
    rows.results.map((row) => [row.auth_subject, row] as const),
  );
  return {
    serverTime: now,
    thresholds: PRESENCE_THRESHOLDS,
    players: state.players
      .filter((player) => player.status !== "left")
      .sort((left, right) => left.seat - right.seat)
      .map((player) => {
        const roster = byUserId.get(player.userId);
        const lastSeenAt = Number(
          roster?.last_seen_at ?? roster?.joined_at ?? state.createdAt,
        );
        return presencePlayer(player.playerId, lastSeenAt, now);
      }),
  };
}

async function assertHostClaimAllowed(
  database: D1Database,
  state: GameState,
  actorUserId: string,
  actorProfileId: string,
  now: number,
): Promise<PersistedHostClaimGuard> {
  const presence = await buildPresenceSnapshot(database, state, now);
  const guard = assertHostClaimPolicy(
    state,
    actorUserId,
    presence.players,
    now,
  );
  const previousHostProfile = await findProfileForUser(
    database,
    guard.previousHostUserId,
  );
  requireRule(
    previousHostProfile,
    "CORRUPT_MEMBERSHIP",
    "The current host membership record is unavailable.",
    500,
  );
  return {
    ...guard,
    previousHostProfileId: previousHostProfile.id,
    claimantProfileId: actorProfileId,
  };
}

async function readGameSeriesView(
  database: D1Database,
  state: GameState,
): Promise<GameSeriesView> {
  const currentPlayers = state.players
    .filter((player) => player.status !== "left")
    .sort((left, right) => left.seat - right.seat);
  if (currentPlayers.length === 0) {
    return buildGameSeriesViewFromAggregate(state, {
      completedRounds: 0,
      highestRound: 0,
      winsByUserId: new Map(),
      recentWinners: [],
    });
  }
  const currentValues = currentPlayers.map(() => "(?)").join(", ");
  const currentUserIds = currentPlayers.map((player) => player.userId);
  const rows = await database
    .prepare(
      `WITH current_players(user_id) AS (VALUES ${currentValues}),
       ledger AS (
         SELECT completion_revision, round_number, winner_profile_id,
                winner_reason, completed_at
         FROM game_rounds
         WHERE game_id = ? AND completion_revision <= ?
       ),
       summary AS (
         SELECT COUNT(*) AS completed_rounds,
                COALESCE(MAX(round_number), 0) AS highest_round
         FROM ledger
       ),
       scores AS (
         SELECT current_players.user_id AS winner_user_id,
                COUNT(ledger.completion_revision) AS wins
         FROM current_players
         LEFT JOIN profiles winner_profile
           ON winner_profile.auth_subject = current_players.user_id
         LEFT JOIN ledger
           ON ledger.winner_profile_id = winner_profile.id
         GROUP BY current_players.user_id
       ),
       recent AS (
         SELECT ledger.completion_revision, ledger.round_number,
                winner_profile.auth_subject AS winner_user_id,
                ledger.winner_reason, ledger.completed_at
         FROM ledger
         JOIN profiles winner_profile
           ON winner_profile.id = ledger.winner_profile_id
         JOIN current_players
           ON current_players.user_id = winner_profile.auth_subject
         ORDER BY ledger.round_number DESC
         LIMIT 5
       )
       SELECT 'score' AS row_kind, scores.winner_user_id, scores.wins,
              summary.completed_rounds, summary.highest_round,
              NULL AS completion_revision, NULL AS round_number,
              NULL AS winner_reason, NULL AS completed_at
       FROM scores CROSS JOIN summary
       UNION ALL
       SELECT 'recent' AS row_kind, recent.winner_user_id, NULL AS wins,
              summary.completed_rounds, summary.highest_round,
              recent.completion_revision, recent.round_number,
              recent.winner_reason, recent.completed_at
       FROM recent CROSS JOIN summary`,
    )
    .bind(...currentUserIds, state.gameId, state.revision)
    .all<GameSeriesProjectionRow>();
  requireRule(
    rows.results.length <= currentPlayers.length + 5,
    "CORRUPT_ROUND_LEDGER",
    "Stored game-night scores are unavailable.",
    500,
  );
  const scoreRows = rows.results.filter((row) => row.row_kind === "score");
  const recentRows = rows.results.filter((row) => row.row_kind === "recent");
  requireRule(
    scoreRows.length === currentPlayers.length,
    "CORRUPT_ROUND_LEDGER",
    "Stored game-night scores are unavailable.",
    500,
  );
  const completedRounds = Number(scoreRows[0]?.completed_rounds ?? 0);
  const highestRound = Number(scoreRows[0]?.highest_round ?? 0);
  const winsByUserId = new Map<string, number>();
  for (const row of scoreRows) {
    const wins = Number(row.wins);
    const rowCompletedRounds = Number(row.completed_rounds);
    const rowHighestRound = Number(row.highest_round);
    if (
      typeof row.winner_user_id !== "string" ||
      !currentUserIds.includes(row.winner_user_id) ||
      !Number.isSafeInteger(wins) ||
      wins < 0 ||
      !Number.isSafeInteger(rowCompletedRounds) ||
      rowCompletedRounds < 0 ||
      !Number.isSafeInteger(rowHighestRound) ||
      rowHighestRound < 0 ||
      rowCompletedRounds !== completedRounds ||
      rowHighestRound !== highestRound ||
      row.completion_revision !== null ||
      row.round_number !== null ||
      row.winner_reason !== null ||
      row.completed_at !== null ||
      winsByUserId.has(row.winner_user_id)
    ) {
      throw corruptState();
    }
    winsByUserId.set(row.winner_user_id, wins);
  }
  const currentByUserId = new Map(
    currentPlayers.map((player) => [player.userId, player] as const),
  );
  const recentWinners: RoundSeriesRecord[] = recentRows.map((row) => {
    const completionRevision = Number(row.completion_revision);
    const roundNumber = Number(row.round_number);
    const completedAt = Number(row.completed_at);
    const currentWinner = currentByUserId.get(row.winner_user_id);
    if (
      !Number.isSafeInteger(completionRevision) ||
      completionRevision < 1 ||
      completionRevision > state.revision ||
      !Number.isSafeInteger(roundNumber) ||
      roundNumber < 1 ||
      !currentWinner ||
      row.wins !== null ||
      Number(row.completed_rounds) !== completedRounds ||
      Number(row.highest_round) !== highestRound ||
      (row.winner_reason !== "empty_hand" &&
        row.winner_reason !== "last_active") ||
      !Number.isSafeInteger(completedAt) ||
      completedAt < 0
    ) {
      throw corruptState();
    }
    return {
      completionRevision,
      roundNumber,
      winnerUserId: currentWinner.userId,
      // The immutable snapshot remains in D1 for audit only. A viewer always
      // receives the current in-table alias from state.
      winnerDisplayName: currentWinner.displayName,
      winnerReason: row.winner_reason,
      completedAt,
    };
  });
  return buildGameSeriesViewFromAggregate(state, {
    completedRounds,
    highestRound,
    winsByUserId,
    recentWinners,
  });
}

async function continuityProjectionForUser(
  database: D1Database,
  state: GameState,
  viewerUserId: string,
  now: number,
  presence?: PresenceSnapshot,
): Promise<GameContinuityProjection> {
  const series = await readGameSeriesView(database, state);
  const currentPresence =
    presence ?? (await buildPresenceSnapshot(database, state, now));
  let canClaimHost = false;
  try {
    assertHostClaimPolicy(
      state,
      viewerUserId,
      currentPresence.players,
      now,
    );
    canClaimHost = true;
  } catch (error) {
    if (!(error instanceof GameRuleError)) throw error;
  }
  return {
    series,
    canClaimHost,
  };
}

async function projectStoredGameForUser(
  database: D1Database,
  state: GameState,
  viewerUserId: string,
  now = Date.now(),
  presence?: PresenceSnapshot,
): Promise<GameView> {
  return projectGameForUser(
    state,
    viewerUserId,
    await continuityProjectionForUser(
      database,
      state,
      viewerUserId,
      now,
      presence,
    ),
  );
}

async function assertInactiveRemovalAllowed(
  database: D1Database,
  state: GameState,
  actorUserId: string,
  targetPlayerId: string,
  now: number,
): Promise<InactiveRemovalGuard> {
  const target = state.players.find(
    (player) => player.playerId === targetPlayerId,
  );
  requireRule(target, "PLAYER_NOT_FOUND", "That player is no longer in this game.", 404);
  const row = await database
    .prepare(
      `SELECT m.joined_at, gp.last_seen_at
       FROM game_members m
       JOIN profiles p ON p.id = m.profile_id
       LEFT JOIN game_presence gp
         ON gp.game_id = m.game_id
        AND gp.profile_id = m.profile_id
        AND gp.player_id = ?
       WHERE m.game_id = ? AND p.auth_subject = ? AND m.status = 'active'
       LIMIT 1`,
    )
    .bind(targetPlayerId, state.gameId, target.userId)
    .first<Pick<PresenceRosterRow, "joined_at" | "last_seen_at">>();
  requireRule(
    row,
    "CORRUPT_MEMBERSHIP",
    "The target player's membership record is unavailable.",
    500,
  );
  const lastSeenAt = Number(row.last_seen_at ?? row.joined_at);
  const verifiedTarget = assertInactiveRemovalPolicy(
    state,
    actorUserId,
    targetPlayerId,
    lastSeenAt,
    now,
  );
  return {
    targetPlayerId,
    targetUserId: verifiedTarget.userId,
    staleCutoff: now - PRESENCE_THRESHOLDS.removableAfterMs,
  };
}

async function getOrCreateProfile(
  user: AuthenticatedUser,
  nicknameInput: string,
  database: D1Database,
  now: number,
  updateExistingNickname = false,
): Promise<ProfileRow> {
  const existing = await findProfileForUser(database, user.userId);
  const nickname = cleanNickname(nicknameInput || user.suggestedName);
  if (existing) {
    if (updateExistingNickname && existing.nickname !== nickname) {
      await database
        .prepare("UPDATE profiles SET nickname = ?, updated_at = ? WHERE id = ?")
        .bind(nickname, now, existing.id)
        .run();
      return { ...existing, nickname };
    }
    return existing;
  }

  const profile: ProfileRow = {
    id: crypto.randomUUID(),
    auth_subject: user.userId,
    nickname,
  };
  await database
    .prepare(
      `INSERT OR IGNORE INTO profiles (
        id, auth_subject, nickname, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(profile.id, profile.auth_subject, profile.nickname, now, now)
    .run();
  return (
    (await findProfileForUser(database, user.userId)) ?? profile
  );
}

async function findProfileForUser(
  database: D1Database,
  userId: string,
): Promise<ProfileRow | null> {
  return database
    .prepare(
      `SELECT id, auth_subject, nickname
       FROM profiles WHERE auth_subject = ? LIMIT 1`,
    )
    .bind(userId)
    .first<ProfileRow>();
}

async function readPublicJoinTarget(
  database: D1Database,
  listingId: string,
): Promise<PublicJoinTargetRow | null> {
  return database
    .prepare(
      `SELECT g.id, g.join_code, g.host_profile_id, g.rules_version,
              g.protocol_version, g.status, g.version, g.state_json,
              g.state_hash, g.room_status, g.closed_at, g.close_reason,
              g.abandoned_since, g.last_activity_at, g.expires_at,
              l.listing_id AS public_listing_id,
              l.owner_profile_id AS public_listing_owner_profile_id,
              l.state AS public_listing_state,
              l.pace AS public_listing_pace,
              l.version AS public_listing_version
       FROM public_game_listings l
       JOIN games g ON g.id = l.game_id
       WHERE l.listing_id = ? LIMIT 1`,
    )
    .bind(listingId)
    .first<PublicJoinTargetRow>();
}

async function readPublicJoinFacts(
  database: D1Database,
  gameId: string,
  hostProfileId: string,
  actorProfileId: string,
): Promise<PublicJoinFactsRow> {
  const facts = await database
    .prepare(
      `SELECT
         (SELECT p.auth_subject FROM profiles p WHERE p.id = ? LIMIT 1)
           AS host_auth_subject,
         (SELECT gp.last_seen_at FROM game_presence gp
          WHERE gp.game_id = ? AND gp.profile_id = ? LIMIT 1)
           AS host_last_seen_at,
         EXISTS (
           SELECT 1 FROM game_members hm
           WHERE hm.game_id = ? AND hm.profile_id = ? AND hm.status = 'active'
         ) AS host_is_active,
         (SELECT COUNT(*) FROM game_members members
          WHERE members.game_id = ? AND members.status <> 'left')
           AS occupancy,
         NOT EXISTS (
           SELECT 1 FROM game_members members
           WHERE members.game_id = ? AND members.status <> 'left'
             AND members.public_discovery_consent_at IS NULL
         ) AS all_members_consented,
         EXISTS (
           SELECT 1 FROM game_members membership
           WHERE membership.game_id = ? AND membership.profile_id = ?
             AND membership.status <> 'left'
         ) AS viewer_already_member,
         EXISTS (
           SELECT 1
           FROM game_members members
           JOIN profile_blocks blocks
             ON (
               blocks.blocker_profile_id = ?
               AND blocks.blocked_profile_id = members.profile_id
             ) OR (
               blocks.blocker_profile_id = members.profile_id
               AND blocks.blocked_profile_id = ?
             )
           WHERE members.game_id = ? AND members.status <> 'left'
         ) AS viewer_blocked`,
    )
    .bind(
      hostProfileId,
      gameId,
      hostProfileId,
      gameId,
      hostProfileId,
      gameId,
      gameId,
      gameId,
      actorProfileId,
      actorProfileId,
      actorProfileId,
      gameId,
    )
    .first<PublicJoinFactsRow>();
  if (!facts) throwPublicRoomUnavailable();
  return facts;
}

async function requireEligiblePublicJoinTarget(
  database: D1Database,
  target: PublicJoinTargetRow,
  viewerUserId: string,
  actorProfileId: string,
  now: number,
): Promise<GameState> {
  if (
    !["listed", "unlisted", "closed"].includes(target.public_listing_state) ||
    !parsePublicPace(target.public_listing_pace) ||
    !Number.isSafeInteger(target.public_listing_version) ||
    target.public_listing_version < 1
  ) {
    throwPublicRoomUnavailable();
  }

  let state: GameState;
  try {
    state = await parseAndValidateState(target);
  } catch (error) {
    if (error instanceof GameRuleError) throwPublicRoomUnavailable();
    throw error;
  }
  const facts = await readPublicJoinFacts(
    database,
    target.id,
    target.host_profile_id,
    actorProfileId,
  );
  const stateOccupancy = state.players.filter(
    (player) => player.status !== "left",
  ).length;
  const viewerAlreadyMember =
    Number(facts.viewer_already_member) === 1 ||
    state.players.some(
      (player) =>
        player.userId === viewerUserId && player.status !== "left",
    );
  const viewerBlocked = Number(facts.viewer_blocked) === 1;
  // Identity-sensitive rejections always win over the precise selected-card
  // race responses. A blocked or already-seated viewer must not learn whether
  // the retained locator is now closed or full.
  if (viewerAlreadyMember || viewerBlocked) throwPublicRoomUnavailable();
  // Withdrawing a listing is a privacy boundary. Even if that private room
  // later closes, its formerly public locator must remain indistinguishable
  // from every other unavailable locator.
  if (target.public_listing_state === "unlisted") throwPublicRoomUnavailable();
  if (
    target.public_listing_state === "closed" ||
    target.room_status === "closed"
  ) {
    throwPublicRoomClosed();
  }
  const hostMatches =
    target.public_listing_owner_profile_id === target.host_profile_id &&
    Number(facts.host_is_active) === 1 &&
    facts.host_auth_subject === state.hostUserId;
  const eligibility = evaluatePublicRoomEligibility({
    discoveryEnabled: getV15FeaturePolicy().discoveryEnabled,
    listingState: target.public_listing_state,
    roomStatus: target.room_status,
    gameStatus: target.status as "lobby" | "playing" | "finished",
    expiresAt: Number(target.expires_at),
    protocolVersion: Number(target.protocol_version),
    rulesVersion: target.rules_version,
    ownerMatchesHost: hostMatches,
    hostLastSeenAt:
      facts.host_last_seen_at === null
        ? null
        : Number(facts.host_last_seen_at),
    allMembersConsented:
      Number(facts.all_members_consented) === 1 &&
      Number(facts.occupancy) === stateOccupancy,
    occupancy: Number(facts.occupancy),
    viewerAlreadyMember,
    viewerBlocked,
    now,
  });
  if (eligibility.eligible) return state;
  if (eligibility.reason === "full") throwPublicRoomFull();
  throwPublicRoomUnavailable();
}

function throwPublicRoomUnavailable(): never {
  throw new GameRuleError(
    "PUBLIC_ROOM_UNAVAILABLE",
    "This public table is no longer available.",
    404,
  );
}

function throwPublicRoomFull(): never {
  throw new GameRuleError(
    "PUBLIC_ROOM_FULL",
    "This public table is full.",
    409,
  );
}

function throwPublicRoomClosed(): never {
  throw new GameRuleError(
    "ROOM_CLOSED",
    "This room is closed.",
    410,
  );
}

function secureRandomIndex(length: number): number {
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new TypeError("A non-empty public room pool is required.");
  }
  const uint32Range = 0x1_0000_0000;
  const unbiasedLimit = uint32Range - (uint32Range % length);
  const random = new Uint32Array(1);
  do {
    crypto.getRandomValues(random);
  } while (random[0] >= unbiasedLimit);
  return random[0] % length;
}

function isRetryableQuickSelectionError(error: unknown): boolean {
  return (
    error instanceof GameRuleError &&
    [
      "PUBLIC_ROOM_UNAVAILABLE",
      "PUBLIC_ROOM_FULL",
      "ROOM_CLOSED",
    ].includes(error.code)
  );
}

async function publicJoinSnapshotFromReceipt(
  database: D1Database,
  receipt: CommandReceiptRow,
  user: AuthenticatedUser,
  operation: string,
  requestHash: string,
): Promise<PublicJoinResult> {
  assertReceiptMatches(receipt, operation, requestHash);
  const profile = await findProfileForUser(database, user.userId);
  requireRule(
    profile?.id === receipt.actor_profile_id,
    "IDEMPOTENCY_KEY_REUSED",
    "That commandId was already used for a different request.",
    409,
  );
  return publicJoinResult(await getGame(user, receipt.game_id), true);
}

async function recoverPublicJoinReceipt(
  database: D1Database,
  user: AuthenticatedUser,
  commandId: string,
  operation: string,
  requestHash: string,
): Promise<PublicJoinResult | null> {
  const profile = await findProfileForUser(database, user.userId);
  if (!profile) return null;
  const receipt = await findCommandReceipt(database, profile.id, commandId);
  return receipt
    ? publicJoinSnapshotFromReceipt(
        database,
        receipt,
        user,
        operation,
        requestHash,
      )
    : null;
}

function publicJoinResult(
  snapshot: GameSnapshot,
  replayed: boolean,
): PublicJoinResult {
  return Object.freeze({ snapshot, replayed });
}

function isRetryableMutationConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:SQLITE_)?CONSTRAINT|UNIQUE constraint|constraint failed/i.test(
    message,
  );
}

async function readPublicListingForGame(
  database: D1Database,
  gameId: string,
): Promise<PublicListingRow | null> {
  const listing = await database
    .prepare(
      `SELECT game_id, listing_id, owner_profile_id, state, pace, version,
              event_floor_version, published_at, updated_at, unlisted_at,
              close_reason
       FROM public_game_listings WHERE game_id = ? LIMIT 1`,
    )
    .bind(gameId)
    .first<PublicListingRow>();
  if (!listing) return null;
  requireRule(
    ["listed", "unlisted", "closed"].includes(listing.state) &&
      Number.isSafeInteger(listing.version) &&
      listing.version >= 1,
    "CORRUPT_PUBLIC_LISTING",
    "Stored public listing state is invalid.",
    500,
  );
  return listing;
}

async function buildViewerListing(
  database: D1Database,
  row: GameRow,
  state: GameState,
  viewerUserId: string,
  viewerProfileId: string,
  now: number,
  listing: PublicListingRow | null = null,
): Promise<ViewerListing> {
  const currentListing =
    listing ?? (await readPublicListingForGame(database, row.id));
  const activePlayers = state.players.filter(
    (player) => player.status !== "left",
  );
  const hostPlayer = state.players.find(
    (player) => player.userId === state.hostUserId,
  );
  const isHost =
    viewerUserId === state.hostUserId &&
    viewerProfileId === row.host_profile_id;
  const hostPresence = await database
    .prepare(
      `SELECT last_seen_at FROM game_presence
       WHERE game_id = ? AND profile_id = ? LIMIT 1`,
    )
    .bind(row.id, row.host_profile_id)
    .first<HostPresenceRow>();
  const hostIsLive = Boolean(
    hostPlayer?.status === "active" &&
      hostPresence &&
      Number(hostPresence.last_seen_at) >
        now - PUBLIC_HOST_SUPPRESSION_AFTER_MS,
  );
  const compatibleListedState = Boolean(
    currentListing?.state === "listed" &&
      currentListing.owner_profile_id === row.host_profile_id &&
      row.room_status === "open" &&
      state.phase === "lobby",
  );

  if (compatibleListedState) {
    const pace = parsePublicPace(currentListing!.pace);
    requireRule(
      pace,
      "CORRUPT_PUBLIC_LISTING",
      "Stored public listing pace is invalid.",
      500,
    );
    return {
      state: hostIsLive ? "listed" : "suppressed",
      pace,
      version: currentListing!.version,
      canPublish: false,
      ...(!hostIsLive ? { reason: "HOST_OFFLINE" as const } : {}),
    };
  }

  let reason: ViewerListing["reason"];
  if (!isHost) reason = "NOT_HOST";
  else if (state.phase !== "lobby") reason = "NOT_LOBBY";
  else if (activePlayers.length !== 1) reason = "NOT_SOLE_OCCUPANT";
  else if (!hostIsLive) reason = "HOST_OFFLINE";
  return {
    state: "private",
    pace: null,
    version: currentListing?.version ?? null,
    canPublish: reason === undefined,
    ...(reason ? { reason } : {}),
  };
}

async function listingResultFromReceipt(
  database: D1Database,
  receipt: CommandReceiptRow,
  user: AuthenticatedUser,
  operation: string,
  requestHash: string,
  gameId: string,
  now: number,
): Promise<ListingMutationResult> {
  assertReceiptMatches(receipt, operation, requestHash, gameId);
  const profile = await findProfileForUser(database, user.userId);
  requireRule(
    profile?.id === receipt.actor_profile_id,
    "NOT_A_MEMBER",
    "You are not a member of this game.",
    403,
  );
  const row = await getGameRow(database, gameId);
  const state = await parseAndValidateState(row);
  requireCurrentMember(state, user.userId);
  return {
    listing: await buildViewerListing(
      database,
      row,
      state,
      user.userId,
      profile.id,
      now,
    ),
    view: await projectStoredGameForUser(
      database,
      state,
      user.userId,
      now,
    ),
    replayed: true,
  };
}

async function getGameRow(database: D1Database, gameId: string): Promise<GameRow> {
  const row = await database
    .prepare(
      `SELECT id, join_code, host_profile_id, rules_version, protocol_version,
              status, version, state_json, state_hash, room_status,
              closed_at, close_reason, abandoned_since, last_activity_at,
              expires_at
       FROM games WHERE id = ? LIMIT 1`,
    )
    .bind(gameId)
    .first<GameRow>();
  requireRule(row, "GAME_NOT_FOUND", "Game not found.", 404);
  requireRule(row.expires_at > Date.now(), "GAME_EXPIRED", "This game has expired.", 410);
  requireOpenRoom(row, "This room is closed.");
  return row;
}

function requireOpenRoom(row: GameRow, message: string): void {
  requireRule(row.room_status === "open", "ROOM_CLOSED", message, 410);
}

async function findCommandReceipt(
  database: D1Database,
  profileId: string,
  commandId: string,
): Promise<CommandReceiptRow | null> {
  return database
    .prepare(
      `SELECT actor_profile_id, command_id, game_id, operation,
              request_hash, result_version
       FROM command_receipts
       WHERE actor_profile_id = ? AND command_id = ? LIMIT 1`,
    )
    .bind(profileId, commandId)
    .first<CommandReceiptRow>();
}

function assertReceiptMatches(
  receipt: CommandReceiptRow,
  operation: string,
  requestHash: string,
  expectedGameId?: string,
): void {
  requireRule(
    receipt.operation === operation &&
      receipt.request_hash === requestHash &&
      (!expectedGameId || receipt.game_id === expectedGameId),
    "IDEMPOTENCY_KEY_REUSED",
    "That commandId was already used for a different request.",
    409,
  );
}

async function viewFromReceipt(
  database: D1Database,
  receipt: CommandReceiptRow,
  user: AuthenticatedUser,
  operation: string,
  requestHash: string,
  expectedGameId?: string,
  expectedJoinCode?: string,
): Promise<GameView> {
  assertReceiptMatches(receipt, operation, requestHash, expectedGameId);
  const row = await getGameRow(database, receipt.game_id);
  requireRule(
    !expectedJoinCode || row.join_code === expectedJoinCode,
    "IDEMPOTENCY_KEY_REUSED",
    "That commandId was already used for a different lobby.",
    409,
  );
  const state = await parseAndValidateState(row);
  requireRule(
    state.players.some(
      (player) => player.userId === user.userId && player.status !== "left",
    ),
    "NOT_A_MEMBER",
    "You are not a member of this game.",
    403,
  );
  return projectStoredGameForUser(database, state, user.userId);
}

async function commandViewFromReceipt(
  database: D1Database,
  receipt: CommandReceiptRow,
  user: AuthenticatedUser,
  operation: string,
  requestHash: string,
  gameId: string,
  forceNull: boolean,
): Promise<GameView | null> {
  assertReceiptMatches(receipt, operation, requestHash, gameId);
  if (forceNull) return null;
  const row = await getGameRow(database, receipt.game_id);
  const state = await parseAndValidateState(row);
  return commandViewForUser(database, state, user.userId);
}

async function commandViewForUser(
  database: D1Database,
  state: GameState,
  userId: string,
): Promise<GameView | null> {
  return state.players.some(
    (player) => player.userId === userId && player.status !== "left",
  )
    ? projectStoredGameForUser(database, state, userId)
    : null;
}

function guardedPublicJoinReceiptStatement(
  database: D1Database,
  row: PublicJoinTargetRow,
  state: GameState,
  actorProfileId: string,
  profileWasPresent: boolean,
  actorUserId: string,
  commandId: string,
  operation: string,
  requestHash: string,
  resultVersion: number,
  now: number,
): D1PreparedStatement {
  const existingProfileMode = profileWasPresent ? 1 : 0;
  return database
    .prepare(
      `INSERT INTO command_receipts (
        actor_profile_id, command_id, game_id, operation,
        request_hash, result_version, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE (
        (
          ? = 1
          AND EXISTS (
            SELECT 1 FROM profiles
            WHERE id = ? AND auth_subject = ?
          )
        ) OR (
          ? = 0
          AND NOT EXISTS (
            SELECT 1 FROM profiles WHERE auth_subject = ?
          )
        )
      )
        AND EXISTS (
          SELECT 1
          FROM public_game_listings listing
          JOIN games game ON game.id = listing.game_id
          JOIN game_members host_member
            ON host_member.game_id = game.id
           AND host_member.profile_id = game.host_profile_id
          JOIN profiles host_profile ON host_profile.id = game.host_profile_id
          JOIN game_presence host_presence
            ON host_presence.game_id = game.id
           AND host_presence.profile_id = game.host_profile_id
          WHERE listing.listing_id = ?
            AND listing.game_id = ?
            AND listing.version = ?
            AND listing.state = 'listed'
            AND listing.owner_profile_id = game.host_profile_id
            AND game.id = ?
            AND game.version = ?
            AND game.state_hash = ?
            AND game.room_status = 'open'
            AND game.status = 'lobby'
            AND game.expires_at > ?
            AND game.protocol_version = ?
            AND game.rules_version = ?
            AND host_profile.auth_subject = ?
            AND host_member.status = 'active'
            AND host_presence.last_seen_at > ?
            AND NOT EXISTS (
              SELECT 1 FROM game_members members
              WHERE members.game_id = game.id
                AND members.status <> 'left'
                AND members.public_discovery_consent_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM game_members membership
              WHERE membership.game_id = game.id
                AND membership.profile_id = ?
                AND membership.status <> 'left'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM game_members members
              JOIN profile_blocks blocks
                ON (
                  blocks.blocker_profile_id = ?
                  AND blocks.blocked_profile_id = members.profile_id
                ) OR (
                  blocks.blocker_profile_id = members.profile_id
                  AND blocks.blocked_profile_id = ?
                )
              WHERE members.game_id = game.id
                AND members.status <> 'left'
            )
            AND (
              SELECT COUNT(*) FROM game_members occupants
              WHERE occupants.game_id = game.id
                AND occupants.status <> 'left'
            ) < ?
        )`,
    )
    .bind(
      actorProfileId,
      commandId,
      row.id,
      operation,
      requestHash,
      resultVersion,
      now,
      existingProfileMode,
      actorProfileId,
      actorUserId,
      existingProfileMode,
      actorUserId,
      row.public_listing_id,
      row.id,
      row.public_listing_version,
      row.id,
      row.version,
      row.state_hash,
      now,
      GAME_PROTOCOL_VERSION,
      RULES_VERSION,
      state.hostUserId,
      now - PUBLIC_HOST_SUPPRESSION_AFTER_MS,
      actorProfileId,
      actorProfileId,
      actorProfileId,
      PUBLIC_ROOM_CAPACITY,
    );
}

function guardedPublicProfileProvisionStatement(
  database: D1Database,
  profileId: string,
  authSubject: string,
  alias: string,
  now: number,
  commandId: string,
  requestHash: string,
  gameId: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO profiles (
        id, auth_subject, nickname, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM command_receipts
        WHERE actor_profile_id = ? AND command_id = ?
          AND game_id = ? AND request_hash = ?
      )
      ON CONFLICT(auth_subject) DO UPDATE SET
        nickname = excluded.nickname,
        updated_at = excluded.updated_at
      WHERE profiles.id = excluded.id`,
    )
    .bind(
      profileId,
      authSubject,
      alias,
      now,
      now,
      profileId,
      commandId,
      gameId,
      requestHash,
    );
}

function guardedJoinReceiptStatement(
  database: D1Database,
  row: GameRow,
  profileId: string,
  profileWasPresent: boolean,
  actorUserId: string,
  commandId: string,
  operation: string,
  requestHash: string,
  resultVersion: number,
  now: number,
): D1PreparedStatement {
  const existingProfileMode = profileWasPresent ? 1 : 0;
  return database
    .prepare(
      `INSERT INTO command_receipts (
        actor_profile_id, command_id, game_id, operation,
        request_hash, result_version, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE (
        (
          ? = 1
          AND EXISTS (
            SELECT 1 FROM profiles
            WHERE id = ? AND auth_subject = ?
          )
        ) OR (
          ? = 0
          AND NOT EXISTS (
            SELECT 1 FROM profiles WHERE auth_subject = ?
          )
        )
      )
        AND EXISTS (
          SELECT 1 FROM games
          WHERE id = ? AND join_code = ?
            AND version = ? AND state_hash = ?
            AND room_status = 'open' AND status = 'lobby'
            AND expires_at > ?
        )`,
    )
    .bind(
      profileId,
      commandId,
      row.id,
      operation,
      requestHash,
      resultVersion,
      now,
      existingProfileMode,
      profileId,
      actorUserId,
      existingProfileMode,
      actorUserId,
      row.id,
      row.join_code,
      row.version,
      row.state_hash,
      now,
    );
}

function guardedReceiptStatement(
  database: D1Database,
  row: GameRow,
  profileId: string,
  commandId: string,
  operation: string,
  requestHash: string,
  resultVersion: number,
  now: number,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO command_receipts (
        actor_profile_id, command_id, game_id, operation,
        request_hash, result_version, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM games
        WHERE id = ? AND version = ? AND state_hash = ?
          AND room_status = 'open'
      )`,
    )
    .bind(
      profileId,
      commandId,
      row.id,
      operation,
      requestHash,
      resultVersion,
      now,
      row.id,
      row.version,
      row.state_hash,
    );
}

function guardedPublishReceiptStatement(
  database: D1Database,
  row: GameRow,
  profileId: string,
  commandId: string,
  operation: string,
  requestHash: string,
  resultVersion: number,
  now: number,
  expectedListingVersion: number | null,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO command_receipts (
        actor_profile_id, command_id, game_id, operation,
        request_hash, result_version, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM games g
        JOIN game_members host_member
          ON host_member.game_id = g.id AND host_member.profile_id = ?
        JOIN game_presence host_presence
          ON host_presence.game_id = host_member.game_id
         AND host_presence.profile_id = host_member.profile_id
        WHERE g.id = ? AND g.version = ? AND g.state_hash = ?
          AND g.room_status = 'open' AND g.status = 'lobby'
          AND g.expires_at > ?
          AND g.host_profile_id = ? AND host_member.status = 'active'
          AND host_presence.last_seen_at > ?
          AND (
            SELECT COUNT(*) FROM game_members occupants
            WHERE occupants.game_id = g.id AND occupants.status <> 'left'
          ) = 1
      )
        AND (
          (
            ? IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM public_game_listings
              WHERE game_id = ?
            )
          )
          OR (
            ? IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public_game_listings
              WHERE game_id = ? AND version = ? AND state = 'unlisted'
            )
          )
        )`,
    )
    .bind(
      profileId,
      commandId,
      row.id,
      operation,
      requestHash,
      resultVersion,
      now,
      profileId,
      row.id,
      row.version,
      row.state_hash,
      now,
      profileId,
      now - PUBLIC_HOST_SUPPRESSION_AFTER_MS,
      expectedListingVersion,
      row.id,
      expectedListingVersion,
      row.id,
      expectedListingVersion,
    );
}

function guardedUnpublishReceiptStatement(
  database: D1Database,
  row: GameRow,
  profileId: string,
  commandId: string,
  operation: string,
  requestHash: string,
  now: number,
  expectedListingVersion: number,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO command_receipts (
        actor_profile_id, command_id, game_id, operation,
        request_hash, result_version, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM games g
        JOIN game_members host_member
          ON host_member.game_id = g.id AND host_member.profile_id = ?
        JOIN public_game_listings listing ON listing.game_id = g.id
        WHERE g.id = ? AND g.version = ? AND g.state_hash = ?
          AND g.room_status = 'open' AND g.host_profile_id = ?
          AND host_member.status = 'active'
          AND listing.state = 'listed' AND listing.version = ?
      )`,
    )
    .bind(
      profileId,
      commandId,
      row.id,
      operation,
      requestHash,
      row.version,
      now,
      profileId,
      row.id,
      row.version,
      row.state_hash,
      profileId,
      expectedListingVersion,
    );
}

function guardedHostDiscoveryConsentStatement(
  database: D1Database,
  gameId: string,
  profileId: string,
  now: number,
  commandId: string,
  requestHash: string,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE game_members
       SET public_discovery_consent_at = ?
       WHERE game_id = ? AND profile_id = ? AND status = 'active'
         AND EXISTS (
           SELECT 1 FROM command_receipts
           WHERE actor_profile_id = ? AND command_id = ?
             AND game_id = ? AND request_hash = ?
         )`,
    )
    .bind(
      now,
      gameId,
      profileId,
      profileId,
      commandId,
      gameId,
      requestHash,
    );
}

function guardedCommunicationScopeDowngradeStatement(
  database: D1Database,
  gameId: string,
  receiptProfileId: string,
  commandId: string,
  requestHash: string,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE games
       SET communication_scope = CASE
         WHEN communication_scope = 'invite_only' THEN 'public_safe'
         ELSE communication_scope
       END
       WHERE id = ?
         AND communication_scope IN ('invite_only', 'public_safe')
         AND EXISTS (
           SELECT 1 FROM command_receipts
           WHERE actor_profile_id = ? AND command_id = ?
             AND game_id = ? AND request_hash = ?
         )`,
    )
    .bind(
      gameId,
      receiptProfileId,
      commandId,
      gameId,
      requestHash,
    );
}

function guardedPublishListingStatement(
  database: D1Database,
  gameId: string,
  listingId: string,
  ownerProfileId: string,
  pace: PublicPace,
  version: number,
  eventFloorVersion: number,
  now: number,
  expectedListingVersion: number | null,
  commandId: string,
  requestHash: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO public_game_listings (
        game_id, listing_id, owner_profile_id, state, pace, version,
        event_floor_version, published_at, updated_at, unlisted_at,
        close_reason
      )
      SELECT ?, ?, ?, 'listed', ?, ?, ?, ?, ?, NULL, NULL
      WHERE EXISTS (
        SELECT 1 FROM command_receipts
        WHERE actor_profile_id = ? AND command_id = ?
          AND game_id = ? AND request_hash = ?
      )
      ON CONFLICT(game_id) DO UPDATE SET
        listing_id = excluded.listing_id,
        owner_profile_id = excluded.owner_profile_id,
        state = 'listed',
        pace = excluded.pace,
        version = excluded.version,
        event_floor_version = excluded.event_floor_version,
        published_at = excluded.published_at,
        updated_at = excluded.updated_at,
        unlisted_at = NULL,
        close_reason = NULL
      WHERE public_game_listings.version = ?
        AND public_game_listings.state = 'unlisted'`,
    )
    .bind(
      gameId,
      listingId,
      ownerProfileId,
      pace,
      version,
      eventFloorVersion,
      now,
      now,
      ownerProfileId,
      commandId,
      gameId,
      requestHash,
      expectedListingVersion ?? -1,
    );
}

function guardedListingVisibilityStatement(
  database: D1Database,
  gameId: string,
  receiptProfileId: string,
  commandId: string,
  requestHash: string,
  state: Extract<PublicListingRow["state"], "unlisted" | "closed">,
  closeReason: string,
  now: number,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE public_game_listings
       SET state = ?, version = version + 1, updated_at = ?,
           unlisted_at = ?, close_reason = ?
       WHERE game_id = ? AND state = 'listed'
         AND EXISTS (
           SELECT 1 FROM command_receipts
           WHERE actor_profile_id = ? AND command_id = ?
             AND game_id = ? AND request_hash = ?
         )`,
    )
    .bind(
      state,
      now,
      now,
      closeReason,
      gameId,
      receiptProfileId,
      commandId,
      gameId,
      requestHash,
    );
}

function guardedInactiveRemovalReceiptStatement(
  database: D1Database,
  row: GameRow,
  profileId: string,
  commandId: string,
  operation: string,
  requestHash: string,
  resultVersion: number,
  now: number,
  guard: InactiveRemovalGuard,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO command_receipts (
        actor_profile_id, command_id, game_id, operation,
        request_hash, result_version, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM games
        WHERE id = ? AND version = ? AND state_hash = ?
          AND room_status = 'open'
      )
        AND EXISTS (
          SELECT 1
          FROM game_members m
          JOIN profiles p ON p.id = m.profile_id
          LEFT JOIN game_presence gp
            ON gp.game_id = m.game_id
           AND gp.profile_id = m.profile_id
           AND gp.player_id = ?
          WHERE m.game_id = ?
            AND p.auth_subject = ?
            AND m.status = 'active'
            AND COALESCE(gp.last_seen_at, m.joined_at) <= ?
        )`,
    )
    .bind(
      profileId,
      commandId,
      row.id,
      operation,
      requestHash,
      resultVersion,
      now,
      row.id,
      row.version,
      row.state_hash,
      guard.targetPlayerId,
      row.id,
      guard.targetUserId,
      guard.staleCutoff,
    );
}

function guardedHostClaimReceiptStatement(
  database: D1Database,
  row: GameRow,
  profileId: string,
  commandId: string,
  operation: string,
  requestHash: string,
  resultVersion: number,
  now: number,
  phase: GameState["phase"],
  guard: PersistedHostClaimGuard,
): D1PreparedStatement {
  const eligibleStatus = phase === "complete" ? "non_left" : "active";
  return database
    .prepare(
      `INSERT INTO command_receipts (
        actor_profile_id, command_id, game_id, operation,
        request_hash, result_version, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM games g
        JOIN game_members previous_host
          ON previous_host.game_id = g.id
         AND previous_host.profile_id = ?
        JOIN profiles previous_host_profile
          ON previous_host_profile.id = previous_host.profile_id
        LEFT JOIN game_presence previous_host_presence
          ON previous_host_presence.game_id = previous_host.game_id
         AND previous_host_presence.profile_id = previous_host.profile_id
         AND previous_host_presence.player_id = ?
        JOIN game_members claimant
          ON claimant.game_id = g.id
         AND claimant.profile_id = ?
        JOIN profiles claimant_profile
          ON claimant_profile.id = claimant.profile_id
        LEFT JOIN game_presence claimant_presence
          ON claimant_presence.game_id = claimant.game_id
         AND claimant_presence.profile_id = claimant.profile_id
         AND claimant_presence.player_id = ?
        WHERE g.id = ? AND g.version = ? AND g.state_hash = ?
          AND g.room_status = 'open' AND g.status = ?
          AND g.host_profile_id = ? AND g.expires_at > ?
          AND previous_host_profile.auth_subject = ?
          AND previous_host.seat = ?
          AND previous_host.status <> 'left'
          AND COALESCE(
            previous_host_presence.last_seen_at,
            previous_host.joined_at
          ) <= ?
          AND claimant_profile.auth_subject = ?
          AND claimant.seat = ?
          AND (
            (? = 'non_left' AND claimant.status <> 'left')
            OR (? = 'active' AND claimant.status = 'active')
          )
          AND COALESCE(
            claimant_presence.last_seen_at,
            claimant.joined_at
          ) > ?
          AND NOT EXISTS (
            SELECT 1
            FROM game_members contender
            LEFT JOIN game_presence contender_presence
              ON contender_presence.game_id = contender.game_id
             AND contender_presence.profile_id = contender.profile_id
            WHERE contender.game_id = g.id
              AND contender.profile_id <> previous_host.profile_id
              AND (
                (? = 'non_left' AND contender.status <> 'left')
                OR (? = 'active' AND contender.status = 'active')
              )
              AND COALESCE(
                contender_presence.last_seen_at,
                contender.joined_at
              ) > ?
              AND CASE
                WHEN contender.seat > previous_host.seat
                  THEN contender.seat
                ELSE contender.seat + 100000
              END < CASE
                WHEN claimant.seat > previous_host.seat
                  THEN claimant.seat
                ELSE claimant.seat + 100000
              END
          )
      )`,
    )
    .bind(
      profileId,
      commandId,
      row.id,
      operation,
      requestHash,
      resultVersion,
      now,
      guard.previousHostProfileId,
      guard.previousHostPlayerId,
      guard.claimantProfileId,
      guard.claimantPlayerId,
      row.id,
      row.version,
      row.state_hash,
      databaseStatus(phase),
      guard.previousHostProfileId,
      now,
      guard.previousHostUserId,
      guard.previousHostSeat,
      guard.staleCutoff,
      guard.claimantUserId,
      guard.claimantSeat,
      eligibleStatus,
      eligibleStatus,
      guard.connectedCutoff,
      eligibleStatus,
      eligibleStatus,
      guard.connectedCutoff,
    );
}

function guardedEventStatement(
  database: D1Database,
  row: GameRow,
  version: number,
  commandId: string,
  profileId: string,
  events: GameEvent[],
  stateHash: string,
  now: number,
  requestHash: string,
  eventCommandId = commandId,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO game_events (
        game_id, version, command_id, actor_profile_id, kind,
        public_payload_json, state_hash, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM games g
        JOIN command_receipts r
          ON r.game_id = g.id
         AND r.actor_profile_id = ?
         AND r.command_id = ?
         AND r.request_hash = ?
        WHERE g.id = ? AND g.version = ? AND g.state_hash = ?
          AND g.room_status = 'open'
      )`,
    )
    .bind(
      row.id,
      version,
      eventCommandId,
      profileId,
      events.at(-1)?.type ?? "state_changed",
      JSON.stringify(events),
      stateHash,
      now,
      profileId,
      commandId,
      requestHash,
      row.id,
      row.version,
      row.state_hash,
    );
}

function guardedRoundLedgerStatement(
  database: D1Database,
  gameId: string,
  completionRevision: number,
  winnerProfileId: string,
  winnerDisplayName: string,
  winnerReason: GameWinner["reason"],
  completedAt: number,
  receiptProfileId: string,
  commandId: string,
  requestHash: string,
  stateHash: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO game_rounds (
        game_id, completion_revision, round_number, winner_profile_id,
        winner_display_name, winner_reason, completed_at
      )
      SELECT
        ?, ?,
        COALESCE((
          SELECT MAX(existing.round_number) + 1
          FROM game_rounds existing
          WHERE existing.game_id = ?
        ), 1),
        ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM command_receipts receipt
        WHERE receipt.actor_profile_id = ?
          AND receipt.command_id = ?
          AND receipt.game_id = ?
          AND receipt.request_hash = ?
          AND receipt.result_version = ?
      )
        AND EXISTS (
          SELECT 1 FROM game_events event
          WHERE event.game_id = ?
            AND event.version = ?
            AND event.command_id = ?
            AND event.actor_profile_id = ?
            AND event.state_hash = ?
            AND EXISTS (
              SELECT 1 FROM json_each(event.public_payload_json) payload
              WHERE json_extract(payload.value, '$.type') = 'game_won'
            )
        )`,
    )
    .bind(
      gameId,
      completionRevision,
      gameId,
      winnerProfileId,
      winnerDisplayName,
      winnerReason,
      completedAt,
      receiptProfileId,
      commandId,
      gameId,
      requestHash,
      completionRevision,
      gameId,
      completionRevision,
      commandId,
      receiptProfileId,
      stateHash,
    );
}

function presenceUpsertStatement(
  database: D1Database,
  gameId: string,
  playerId: string,
  profileId: string,
  now: number,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO game_presence (
        game_id, player_id, profile_id, last_seen_at
      )
      SELECT ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM game_members m
        JOIN games g ON g.id = m.game_id
        WHERE m.game_id = ? AND m.profile_id = ?
          AND m.status <> 'left' AND g.room_status = 'open'
      )
      ON CONFLICT(game_id, player_id) DO UPDATE SET
        profile_id = excluded.profile_id,
        last_seen_at = excluded.last_seen_at`,
    )
    .bind(gameId, playerId, profileId, now, gameId, profileId);
}

function guardedPresenceUpsertStatement(
  database: D1Database,
  gameId: string,
  playerId: string,
  profileId: string,
  now: number,
  receiptProfileId: string,
  commandId: string,
  requestHash: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO game_presence (
        game_id, player_id, profile_id, last_seen_at
      )
      SELECT ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM game_members m
        JOIN games g ON g.id = m.game_id
        WHERE m.game_id = ? AND m.profile_id = ?
          AND m.status <> 'left' AND g.room_status = 'open'
      )
        AND EXISTS (
          SELECT 1 FROM command_receipts
          WHERE actor_profile_id = ? AND command_id = ?
            AND game_id = ? AND request_hash = ?
        )
      ON CONFLICT(game_id, player_id) DO UPDATE SET
        profile_id = excluded.profile_id,
        last_seen_at = excluded.last_seen_at`,
    )
    .bind(
      gameId,
      playerId,
      profileId,
      now,
      gameId,
      profileId,
      receiptProfileId,
      commandId,
      gameId,
      requestHash,
    );
}

function guardedProfileNicknameStatement(
  database: D1Database,
  profileId: string,
  nickname: string,
  now: number,
  commandId: string,
  requestHash: string,
  gameId: string,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE profiles
       SET nickname = ?, updated_at = ?
       WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM command_receipts
           WHERE actor_profile_id = ? AND command_id = ?
             AND game_id = ? AND request_hash = ?
         )`,
    )
    .bind(
      nickname,
      now,
      profileId,
      profileId,
      commandId,
      gameId,
      requestHash,
    );
}

function guardedPresenceDeleteStatement(
  database: D1Database,
  gameId: string,
  playerId: string,
  receiptProfileId: string,
  commandId: string,
  requestHash: string,
): D1PreparedStatement {
  return database
    .prepare(
      `DELETE FROM game_presence
       WHERE game_id = ? AND player_id = ?
         AND EXISTS (
           SELECT 1 FROM command_receipts
           WHERE actor_profile_id = ? AND command_id = ?
             AND game_id = ? AND request_hash = ?
         )`,
    )
    .bind(
      gameId,
      playerId,
      receiptProfileId,
      commandId,
      gameId,
      requestHash,
    );
}

function guardedLobbyPresenceExpireStatement(
  database: D1Database,
  profileId: string,
  now: number,
  commandId: string,
  requestHash: string,
  gameId: string,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE lobby_invitations
       SET state = 'expired', pending_key = NULL, responded_at = ?
       WHERE recipient_profile_id = ? AND state = 'pending'
         AND EXISTS (
           SELECT 1 FROM command_receipts receipt
           WHERE receipt.actor_profile_id = ? AND receipt.command_id = ?
             AND receipt.game_id = ? AND receipt.request_hash = ?
         )`,
    )
    .bind(
      now,
      profileId,
      profileId,
      commandId,
      gameId,
      requestHash,
    );
}

function guardedLobbyPresenceDeleteStatement(
  database: D1Database,
  profileId: string,
  commandId: string,
  requestHash: string,
  gameId: string,
): D1PreparedStatement {
  return database
    .prepare(
      `DELETE FROM lobby_presence
       WHERE profile_id = ? AND EXISTS (
         SELECT 1 FROM command_receipts receipt
         WHERE receipt.actor_profile_id = ? AND receipt.command_id = ?
           AND receipt.game_id = ? AND receipt.request_hash = ?
       )`,
    )
    .bind(profileId, profileId, commandId, gameId, requestHash);
}

function staleSeatCleanupStatement(
  database: D1Database,
  gameId: string,
  seat: number,
  joiningProfileId: string,
  receiptProfileId: string,
  commandId: string,
  requestHash: string,
): D1PreparedStatement {
  return database
    .prepare(
      `DELETE FROM game_members
       WHERE game_id = ? AND seat = ? AND profile_id <> ? AND status = 'left'
         AND EXISTS (
           SELECT 1 FROM command_receipts
           WHERE actor_profile_id = ? AND command_id = ?
             AND game_id = ? AND request_hash = ?
         )`,
    )
    .bind(
      gameId,
      seat,
      joiningProfileId,
      receiptProfileId,
      commandId,
      gameId,
      requestHash,
    );
}

function guardedPublicMembershipUpsertStatement(
  database: D1Database,
  gameId: string,
  profileId: string,
  player: GameState["players"][number],
  now: number,
  commandId: string,
  requestHash: string,
  eventFloorVersion: number,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO game_members (
        game_id, profile_id, seat, role, status, joined_at, left_at,
        public_discovery_consent_at, join_source, event_floor_version
      )
      SELECT ?, ?, ?, 'player', 'active', ?, NULL, ?, 'public', ?
      WHERE EXISTS (
        SELECT 1 FROM command_receipts
        WHERE actor_profile_id = ? AND command_id = ?
          AND game_id = ? AND request_hash = ?
      )
      ON CONFLICT(game_id, profile_id) DO UPDATE SET
        seat = excluded.seat,
        role = 'player',
        status = 'active',
        joined_at = excluded.joined_at,
        left_at = NULL,
        public_discovery_consent_at = excluded.public_discovery_consent_at,
        join_source = 'public',
        event_floor_version = excluded.event_floor_version
      WHERE game_members.status = 'left'`,
    )
    .bind(
      gameId,
      profileId,
      player.seat,
      now,
      now,
      eventFloorVersion,
      profileId,
      commandId,
      gameId,
      requestHash,
    );
}

function guardedMembershipUpsertStatement(
  database: D1Database,
  gameId: string,
  profile: ProfileRow,
  player: GameState["players"][number],
  now: number,
  receiptProfileId: string,
  commandId: string,
  requestHash: string,
  hostUserId: string,
  eventFloorVersion = 0,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO game_members (
        game_id, profile_id, seat, role, status, joined_at, left_at,
        join_source, event_floor_version
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM command_receipts
        WHERE actor_profile_id = ? AND command_id = ?
          AND game_id = ? AND request_hash = ?
      )
      ON CONFLICT(game_id, profile_id) DO UPDATE SET
        seat = excluded.seat,
        role = excluded.role,
        status = excluded.status,
        joined_at = CASE
          WHEN game_members.status = 'left' AND excluded.status <> 'left'
            THEN excluded.joined_at
          ELSE game_members.joined_at
        END,
        left_at = CASE
          WHEN game_members.status = 'left' AND excluded.status = 'left'
            THEN game_members.left_at
          ELSE excluded.left_at
        END,
        public_discovery_consent_at = CASE
          WHEN game_members.status = 'left' AND excluded.status <> 'left'
            THEN NULL
          ELSE game_members.public_discovery_consent_at
        END,
        join_source = CASE
          WHEN game_members.status = 'left' AND excluded.status <> 'left'
            THEN excluded.join_source
          ELSE game_members.join_source
        END,
        event_floor_version = CASE
          WHEN game_members.status = 'left' AND excluded.status <> 'left'
            THEN excluded.event_floor_version
          ELSE game_members.event_floor_version
        END`,
    )
    .bind(
      gameId,
      profile.id,
      player.seat,
      player.userId === hostUserId ? "host" : "player",
      player.status,
      now,
      player.status === "left" ? now : null,
      player.userId === hostUserId ? "host" : "invite",
      eventFloorVersion,
      receiptProfileId,
      commandId,
      gameId,
      requestHash,
    );
}

function guardedDepartedMemberStatement(
  database: D1Database,
  gameId: string,
  profileId: string,
  now: number,
  commandId: string,
  requestHash: string,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE game_members
       SET role = 'player', status = 'left', left_at = ?
       WHERE game_id = ? AND profile_id = ?
         AND EXISTS (
           SELECT 1 FROM command_receipts
           WHERE actor_profile_id = ? AND command_id = ?
             AND game_id = ? AND request_hash = ?
         )`,
    )
    .bind(
      now,
      gameId,
      profileId,
      profileId,
      commandId,
      gameId,
      requestHash,
    );
}

function guardedGameUpdateStatement(
  database: D1Database,
  row: GameRow,
  state: GameState,
  stateJson: string,
  stateHash: string,
  now: number,
  expiresAt: number,
  receiptProfileId: string,
  commandId: string,
  requestHash: string,
  roomLifecycle: RoomLifecycleUpdate = OPEN_ROOM_LIFECYCLE,
  eventCommandId = commandId,
  requiredRoundCompletionRevision: number | null = null,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE games
       SET host_profile_id = COALESCE(
             (SELECT id FROM profiles WHERE auth_subject = ? LIMIT 1),
             host_profile_id
           ),
           status = ?, version = ?, state_json = ?, state_hash = ?,
           last_activity_at = ?, expires_at = ?, room_status = ?,
           closed_at = ?, close_reason = ?, abandoned_since = ?
       WHERE id = ? AND version = ? AND state_hash = ?
         AND room_status = 'open'
         AND EXISTS (
           SELECT 1 FROM command_receipts
           WHERE actor_profile_id = ? AND command_id = ?
             AND game_id = ? AND request_hash = ?
         )
         AND EXISTS (
           SELECT 1 FROM game_events
           WHERE game_id = ? AND version = ? AND actor_profile_id = ?
             AND command_id = ? AND state_hash = ?
         )
         AND (
           ? IS NULL OR EXISTS (
             SELECT 1 FROM game_rounds round
             WHERE round.game_id = ? AND round.completion_revision = ?
           )
         )`,
    )
    .bind(
      state.hostUserId,
      databaseStatus(state.phase),
      state.revision,
      stateJson,
      stateHash,
      now,
      expiresAt,
      roomLifecycle.roomStatus,
      roomLifecycle.closedAt,
      roomLifecycle.closeReason,
      roomLifecycle.abandonedSince,
      row.id,
      row.version,
      row.state_hash,
      receiptProfileId,
      commandId,
      row.id,
      requestHash,
      row.id,
      state.revision,
      receiptProfileId,
      eventCommandId,
      stateHash,
      requiredRoundCompletionRevision,
      row.id,
      requiredRoundCompletionRevision,
    );
}

async function profilesForState(
  database: D1Database,
  state: GameState,
): Promise<Map<string, ProfileRow>> {
  const rows = await Promise.all(
    state.players.map(async (player) => {
      const profile = await database
        .prepare(
          `SELECT id, auth_subject, nickname
           FROM profiles WHERE auth_subject = ? LIMIT 1`,
        )
        .bind(player.userId)
        .first<ProfileRow>();
      requireRule(
        profile,
        "CORRUPT_MEMBERSHIP",
        "A game member profile is missing.",
        500,
      );
      return profile;
    }),
  );
  return new Map(rows.map((profile) => [profile.auth_subject, profile]));
}

async function summarize(
  row: GameRow,
  viewerUserId: string,
): Promise<LobbySummary> {
  const state = await parseAndValidateState(row);
  const host = state.players.find((player) => player.userId === state.hostUserId);
  return {
    gameId: state.gameId,
    joinCode: state.joinCode,
    phase: state.phase,
    playerCount: state.players.filter((player) => player.status === "active").length,
    hostName: host?.displayName ?? "Host",
    updatedAt: state.updatedAt,
    isMember: state.players.some(
      (player) => player.userId === viewerUserId && player.status !== "left",
    ),
  };
}

async function parseAndValidateState(row: GameRow): Promise<GameState> {
  let value: unknown;
  try {
    value = JSON.parse(row.state_json);
  } catch {
    throw new GameRuleError("CORRUPT_GAME_STATE", "Stored game state is invalid.", 500);
  }

  if (!isRecord(value)) throw corruptState();
  const state = value as Partial<GameState>;
  const players = Array.isArray(state.players) ? state.players : null;
  if (
    state.schemaVersion !== 1 ||
    state.protocolVersion !== GAME_PROTOCOL_VERSION ||
    !isRecord(state.rules) ||
    state.rules.version !== RULES_VERSION ||
    state.gameId !== row.id ||
    state.joinCode !== row.join_code ||
    state.revision !== row.version ||
    !["lobby", "playing", "complete"].includes(state.phase ?? "") ||
    row.protocol_version !== GAME_PROTOCOL_VERSION ||
    row.rules_version !== RULES_VERSION ||
    row.status !== databaseStatus(state.phase as GameState["phase"]) ||
    !players ||
    !Array.isArray(state.drawPile) ||
    !Array.isArray(state.discardPile) ||
    !Array.isArray(state.mercyReserve) ||
    !Array.isArray(state.unoLiabilities) ||
    !Array.isArray(state.processedCommands)
  ) {
    throw corruptState();
  }

  const playerIds = new Set<string>();
  const userIds = new Set<string>();
  const seats = new Set<number>();
  for (const player of players) {
    if (
      !isRecord(player) ||
      typeof player.playerId !== "string" ||
      typeof player.userId !== "string" ||
      !Number.isSafeInteger(player.seat) ||
      !Array.isArray(player.hand) ||
      playerIds.has(player.playerId) ||
      userIds.has(player.userId) ||
      seats.has(player.seat as number)
    ) {
      throw corruptState();
    }
    playerIds.add(player.playerId);
    userIds.add(player.userId);
    seats.add(player.seat as number);
  }
  if (
    players.length > 0 &&
    !players.some((player) => player.userId === state.hostUserId)
  ) {
    throw corruptState();
  }

  const actualHash = await hashText(row.state_json);
  if (actualHash !== row.state_hash) throw corruptState();

  try {
    assertGameInvariants(state as GameState);
  } catch {
    throw corruptState();
  }
  return state as GameState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function corruptState(): GameRuleError {
  return new GameRuleError(
    "CORRUPT_GAME_STATE",
    "Stored game state failed integrity validation.",
    500,
  );
}

async function readPublicEventFeed(
  database: D1Database,
  gameId: string,
  afterRevision?: number,
  minimumVersion = 0,
): Promise<{ events: GameEvent[]; cursor: number }> {
  const bounds = eventFeedBoundsForViewer(afterRevision, minimumVersion);
  const query = bounds.afterRevision === undefined
    ? database
        .prepare(
          `SELECT version, public_payload_json
           FROM (
             SELECT version, public_payload_json
             FROM game_events
             WHERE game_id = ? AND version >= ?
             ORDER BY version DESC LIMIT ?
           ) recent
           ORDER BY version ASC`,
        )
        .bind(gameId, bounds.minimumVersion, EVENT_FEED_TAIL)
    : database
        .prepare(
          `SELECT version, public_payload_json
           FROM game_events
           WHERE game_id = ? AND version > ? AND version >= ?
           ORDER BY version ASC LIMIT ?`,
        )
        .bind(
          gameId,
          bounds.afterRevision,
          bounds.minimumVersion,
          EVENT_FEED_PAGE,
        );
  const rows = await query.all<EventRow>();
  const events = rows.results.flatMap((row) => parsePublicEvents(row));
  return {
    events,
    cursor:
      rows.results.at(-1)?.version ??
      bounds.afterRevision ??
      Math.max(0, bounds.minimumVersion - 1),
  };
}

export function eventFeedBoundsForViewer(
  afterRevision: number | undefined,
  eventFloorVersion: number,
): Readonly<{ minimumVersion: number; afterRevision: number | undefined }> {
  const minimumVersion =
    Number.isSafeInteger(eventFloorVersion) && eventFloorVersion >= 0
      ? eventFloorVersion
      : 0;
  return Object.freeze({
    minimumVersion,
    afterRevision:
      afterRevision === undefined
        ? undefined
        : Math.max(afterRevision, minimumVersion - 1),
  });
}

function parsePublicEvents(row: EventRow): GameEvent[] {
  let value: unknown;
  try {
    value = JSON.parse(row.public_payload_json);
  } catch {
    throw new GameRuleError(
      "CORRUPT_EVENT_FEED",
      "Stored public events are invalid.",
      500,
    );
  }
  if (!Array.isArray(value) || value.length > 32) {
    throw new GameRuleError(
      "CORRUPT_EVENT_FEED",
      "Stored public events are invalid.",
      500,
    );
  }
  return value.map((event) => {
    if (
      !isRecord(event) ||
      typeof event.type !== "string" ||
      typeof event.message !== "string" ||
      !(
        event.actorPlayerId === null ||
        typeof event.actorPlayerId === "string"
      ) ||
      (event.data !== undefined && !isPublicEventData(event.data))
    ) {
      throw new GameRuleError(
        "CORRUPT_EVENT_FEED",
        "Stored public events are invalid.",
        500,
      );
    }
    return {
      type: event.type,
      actorPlayerId: event.actorPlayerId,
      message: event.message,
      ...(event.data === undefined ? {} : { data: event.data }),
    } as GameEvent;
  });
}

function isPublicEventData(value: unknown): value is GameEvent["data"] {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (entry) =>
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean",
  );
}

type QuotaRule = { scope: string; windowMs: number; limit: number };

async function enforceMutationQuota(
  database: D1Database,
  now: number,
  rules: QuotaRule[],
): Promise<void> {
  for (const rule of rules) {
    const bucketStart = Math.floor(now / rule.windowMs) * rule.windowMs;
    const result = await database
      .prepare(
        `INSERT INTO mutation_quotas (
          scope, bucket_start, count, expires_at
        ) VALUES (?, ?, 1, ?)
        ON CONFLICT(scope, bucket_start) DO UPDATE SET
          count = mutation_quotas.count + 1,
          expires_at = excluded.expires_at
        RETURNING count`,
      )
      .bind(
        rule.scope,
        bucketStart,
        bucketStart + rule.windowMs + 5 * 60_000,
      )
      .first<{ count: number }>();
    const count = Number(result?.count ?? 0);
    if (count > rule.limit) {
      throw new GameRuleError(
        "RATE_LIMITED",
        "Too many write requests. Please wait and try again.",
        429,
      );
    }
  }
}

async function maintainRooms(
  database: D1Database,
  now: number,
): Promise<void> {
  await maybeMaintainRoomLifecycles(database, now);
  await maybePurgeExpiredGames(database, now);
  await maybeReconcileLiveVoiceCleanupJobs(database, now).catch(
    () => undefined,
  );
}

async function maybeMaintainRoomLifecycles(
  database: D1Database,
  now: number,
): Promise<void> {
  if (roomMaintenancePromise) return roomMaintenancePromise;
  if (now - lastRoomMaintenanceAt < ROOM_MAINTENANCE_INTERVAL_MS) return;
  lastRoomMaintenanceAt = now;
  roomMaintenancePromise = maintainRoomLifecycleRows(database, now)
    .catch((error) => {
      lastRoomMaintenanceAt = 0;
      throw error;
    })
    .finally(() => {
      roomMaintenancePromise = null;
    });
  return roomMaintenancePromise;
}

async function maintainRoomLifecycleRows(
  database: D1Database,
  now: number,
): Promise<void> {
  const rows = await database
    .prepare(
      `SELECT g.id, g.join_code, g.host_profile_id, g.rules_version,
              g.protocol_version, g.status, g.version, g.state_json,
              g.state_hash, g.room_status, g.closed_at, g.close_reason,
              g.abandoned_since, g.last_activity_at, g.expires_at
       FROM games g
       WHERE g.room_status = 'open' AND g.expires_at > ?
         AND (
           NOT EXISTS (
             SELECT 1 FROM game_members m
             WHERE m.game_id = g.id AND m.status <> 'left'
           )
           OR g.abandoned_since IS NOT NULL
           OR (
             g.status = 'lobby'
             AND NOT EXISTS (
               SELECT 1
               FROM game_members m
               LEFT JOIN game_presence gp
                 ON gp.game_id = m.game_id
                AND gp.profile_id = m.profile_id
               WHERE m.game_id = g.id AND m.status <> 'left'
                 AND COALESCE(gp.last_seen_at, m.joined_at) > ?
             )
           )
         )
       ORDER BY COALESCE(g.abandoned_since, g.last_activity_at), g.id
       LIMIT ?`,
    )
    .bind(
      now,
      now - PUBLIC_HOST_SUPPRESSION_AFTER_MS,
      ROOM_MAINTENANCE_BATCH_SIZE,
    )
    .all<GameRow>();

  for (const row of rows.results) {
    try {
      await maintainRoomLifecycleRow(database, row, now);
    } catch (error) {
      console.error("Room lifecycle maintenance skipped a candidate.", {
        gameId: row.id,
        code:
          error instanceof GameRuleError
            ? error.code
            : error instanceof Error
              ? error.name
              : "UNKNOWN_ERROR",
      });
    }
  }
}

async function maintainRoomLifecycleRow(
  database: D1Database,
  row: GameRow,
  now: number,
): Promise<void> {
  const presenceRows = await database
    .prepare(
      `SELECT COALESCE(gp.last_seen_at, m.joined_at) AS last_seen_at
       FROM game_members m
       LEFT JOIN game_presence gp
         ON gp.game_id = m.game_id AND gp.profile_id = m.profile_id
       WHERE m.game_id = ? AND m.status <> 'left'
       ORDER BY m.seat`,
    )
    .bind(row.id)
    .all<LifecyclePresenceRow>();
  const memberLastSeenAt = presenceRows.results.map((presence) =>
    presence.last_seen_at === null ? null : Number(presence.last_seen_at),
  );

  if (memberLastSeenAt.length === 0) {
    await closeRoomFromMaintenance(database, row, "empty", now, null);
    return;
  }

  requireRule(
    ["lobby", "playing", "finished"].includes(row.status),
    "CORRUPT_GAME_STATE",
    "Stored game lifecycle status is invalid.",
    500,
  );
  const decision = evaluateWaitingRoomLifecycle({
    roomStatus: row.room_status,
    gameStatus: row.status as PersistedGameStatus,
    abandonedSince: row.abandoned_since,
    memberLastSeenAt,
    now,
  });

  if (decision.action === "close_abandoned") {
    await closeRoomFromMaintenance(
      database,
      row,
      "abandoned",
      now,
      decision.abandonedSince,
    );
    return;
  }
  if (
    decision.action !== "mark_abandoned" &&
    decision.action !== "clear_abandoned"
  ) {
    return;
  }

  const statement = decision.action === "mark_abandoned"
    ? database
        .prepare(
          `UPDATE games
           SET abandoned_since = ?
           WHERE id = ? AND version = ? AND state_hash = ?
             AND room_status = 'open'
             AND (
               (abandoned_since IS NULL AND ? IS NULL)
               OR abandoned_since = ?
             )
             AND NOT EXISTS (
               SELECT 1
               FROM game_members m
               LEFT JOIN game_presence gp
                 ON gp.game_id = m.game_id
                AND gp.profile_id = m.profile_id
               WHERE m.game_id = games.id AND m.status <> 'left'
                 AND COALESCE(gp.last_seen_at, m.joined_at) > ?
             )`,
        )
        .bind(
          decision.abandonedSince,
          row.id,
          row.version,
          row.state_hash,
          row.abandoned_since,
          row.abandoned_since,
          now - PUBLIC_HOST_SUPPRESSION_AFTER_MS,
        )
    : database
        .prepare(
          `UPDATE games
           SET abandoned_since = NULL
           WHERE id = ? AND version = ? AND state_hash = ?
             AND room_status = 'open'
             AND abandoned_since = ?`,
        )
        .bind(
          row.id,
          row.version,
          row.state_hash,
          row.abandoned_since,
        );
  await statement.run();
}

async function closeRoomFromMaintenance(
  database: D1Database,
  row: GameRow,
  reason: Extract<RoomCloseReason, "empty" | "abandoned">,
  now: number,
  abandonedSince: number | null,
): Promise<void> {
  if (reason === "abandoned") {
    requireRule(
      abandonedSince !== null,
      "CORRUPT_GAME_STATE",
      "An abandoned room is missing its lifecycle timestamp.",
      500,
    );
  }
  const state = await parseAndValidateState(row);
  state.revision += 1;
  state.updatedAt = now;
  const stateJson = JSON.stringify(state);
  const stateHash = await hashText(stateJson);
  const commandId = `system-room-close:${crypto.randomUUID()}`;
  const event: GameEvent = {
    type: "room_closed",
    actorPlayerId: null,
    message:
      reason === "empty"
        ? "The empty room closed."
        : "The unattended waiting room closed.",
    data: { reason },
  };
  const eventStatement = reason === "empty"
    ? database
        .prepare(
          `INSERT INTO game_events (
            game_id, version, command_id, actor_profile_id, kind,
            public_payload_json, state_hash, created_at
          )
          SELECT ?, ?, ?, ?, 'room_closed', ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM games g
            WHERE g.id = ? AND g.version = ? AND g.state_hash = ?
              AND g.room_status = 'open'
              AND NOT EXISTS (
                SELECT 1 FROM game_members m
                WHERE m.game_id = g.id AND m.status <> 'left'
              )
          )`,
        )
        .bind(
          row.id,
          state.revision,
          commandId,
          row.host_profile_id,
          JSON.stringify([event]),
          stateHash,
          now,
          row.id,
          row.version,
          row.state_hash,
        )
    : database
        .prepare(
          `INSERT INTO game_events (
            game_id, version, command_id, actor_profile_id, kind,
            public_payload_json, state_hash, created_at
          )
          SELECT ?, ?, ?, ?, 'room_closed', ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM games g
            WHERE g.id = ? AND g.version = ? AND g.state_hash = ?
              AND g.room_status = 'open' AND g.status = 'lobby'
              AND COALESCE(g.abandoned_since, ?) <= ?
              AND NOT EXISTS (
                SELECT 1
                FROM game_members m
                LEFT JOIN game_presence gp
                  ON gp.game_id = m.game_id
                 AND gp.profile_id = m.profile_id
                WHERE m.game_id = g.id AND m.status <> 'left'
                  AND COALESCE(gp.last_seen_at, m.joined_at) > ?
              )
          )`,
        )
        .bind(
          row.id,
          state.revision,
          commandId,
          row.host_profile_id,
          JSON.stringify([event]),
          stateHash,
          now,
          row.id,
          row.version,
          row.state_hash,
          abandonedSince,
          now - ABANDONED_WAITING_ROOM_CLOSE_AFTER_MS,
          now - PUBLIC_HOST_SUPPRESSION_AFTER_MS,
        );

  const batch = await database.batch([
    eventStatement,
    database
      .prepare(
        `DELETE FROM game_presence
         WHERE game_id = ?
           AND EXISTS (
             SELECT 1 FROM game_events
             WHERE game_id = ? AND version = ? AND command_id = ?
               AND state_hash = ?
           )`,
      )
      .bind(row.id, row.id, state.revision, commandId, stateHash),
    database
      .prepare(
        `UPDATE public_game_listings
         SET state = 'closed', version = version + 1, updated_at = ?,
             unlisted_at = ?, close_reason = ?
         WHERE game_id = ? AND state = 'listed'
           AND EXISTS (
             SELECT 1 FROM game_events
             WHERE game_id = ? AND version = ? AND command_id = ?
               AND state_hash = ?
           )`,
      )
      .bind(
        now,
        now,
        reason,
        row.id,
        row.id,
        state.revision,
        commandId,
        stateHash,
      ),
    ...[
      ...state.players.map((player) => ({
        kind: "participant" as const,
        gameId: row.id,
        playerId: player.playerId,
      })),
      { kind: "room" as const, gameId: row.id },
    ].map((target) =>
      guardedEventLiveVoiceCleanupStatement(
        database,
        target,
        {
          version: state.revision,
          commandId,
          stateHash,
          now,
        },
      ),
    ),
    database
      .prepare(
        `UPDATE games
         SET status = ?, version = ?, state_json = ?, state_hash = ?,
             room_status = 'closed', closed_at = ?, close_reason = ?,
             abandoned_since = NULL, last_activity_at = ?, expires_at = ?
         WHERE id = ? AND version = ? AND state_hash = ?
           AND room_status = 'open'
           AND EXISTS (
             SELECT 1 FROM game_events
             WHERE game_id = ? AND version = ? AND command_id = ?
               AND state_hash = ?
           )`,
      )
      .bind(
        databaseStatus(state.phase),
        state.revision,
        stateJson,
        stateHash,
        now,
        reason,
        now,
        roomTombstoneExpiresAt(now),
        row.id,
        row.version,
        row.state_hash,
        row.id,
        state.revision,
        commandId,
        stateHash,
      ),
  ]);

  if ((batch.at(-1)?.meta.changes ?? 0) === 1) {
    await reconcileLiveVoiceCleanupJobs(database, {
      gameId: row.id,
      now,
    }).catch(() => undefined);
    return;
  }
}

async function maybePurgeExpiredGames(
  database: D1Database,
  now: number,
): Promise<void> {
  if (purgePromise) return purgePromise;
  if (now - lastPurgeAt < PURGE_INTERVAL_MS) return;
  lastPurgeAt = now;
  purgePromise = purgeExpiredRows(database, now)
    .catch((error) => {
      lastPurgeAt = 0;
      throw error;
    })
    .finally(() => {
      purgePromise = null;
    });
  return purgePromise;
}

async function purgeExpiredRows(
  database: D1Database,
  now: number,
): Promise<void> {
  await database.batch([
    ...expiredGameLiveVoiceCleanupStatements(database, now),
    database
      .prepare(
        `DELETE FROM game_message_reports WHERE rowid IN (
          SELECT rowid FROM game_message_reports
          WHERE expires_at <= ?
          ORDER BY expires_at, id
          LIMIT 128
        )`,
      )
      .bind(now),
    database
      .prepare(
        `DELETE FROM public_game_listings WHERE rowid IN (
          SELECT listing.rowid FROM public_game_listings listing
          JOIN games g ON g.id = listing.game_id
          WHERE g.expires_at <= ?
          ORDER BY g.expires_at, listing.game_id
          LIMIT 64
        )`,
      )
      .bind(now),
    database
      .prepare(
        `DELETE FROM game_mutes WHERE rowid IN (
          SELECT mute.rowid FROM game_mutes mute
          JOIN games g ON g.id = mute.game_id
          WHERE g.expires_at <= ?
          ORDER BY g.expires_at, mute.game_id,
                   mute.muter_profile_id, mute.muted_profile_id
          LIMIT 128
        )`,
      )
      .bind(now),
    database
      .prepare(
        `DELETE FROM game_message_receipts WHERE rowid IN (
          SELECT receipt.rowid FROM game_message_receipts receipt
          WHERE receipt.expires_at <= ?
          ORDER BY receipt.expires_at, receipt.game_id,
                   receipt.received_at, receipt.message_id,
                   receipt.recipient_profile_id
          LIMIT 128
        )`,
      )
      .bind(now),
    database
      .prepare(
        `DELETE FROM game_messages WHERE rowid IN (
          SELECT message.rowid FROM game_messages message
          WHERE message.expires_at <= ?
          ORDER BY message.expires_at, message.game_id,
                   message.created_at, message.id
          LIMIT 128
        )`,
      )
      .bind(now),
    database
      .prepare(
        `DELETE FROM game_message_cursors WHERE rowid IN (
          SELECT position.rowid FROM game_message_cursors position
          JOIN games g ON g.id = position.game_id
          WHERE g.expires_at <= ?
          ORDER BY g.expires_at, position.game_id, position.sequence
          LIMIT 128
        )`,
      )
      .bind(now),
    database
      .prepare(
        `DELETE FROM game_presence WHERE rowid IN (
          SELECT p.rowid FROM game_presence p
          JOIN games g ON g.id = p.game_id
          WHERE g.expires_at <= ?
          ORDER BY g.expires_at, p.game_id, p.player_id
          LIMIT 128
        )`,
      )
      .bind(now),
    database
      .prepare(
        `DELETE FROM game_events WHERE rowid IN (
          SELECT e.rowid FROM game_events e
          JOIN games g ON g.id = e.game_id
          WHERE g.expires_at <= ?
          ORDER BY g.expires_at, e.game_id, e.version
          LIMIT 128
        )`,
      )
      .bind(now),
    database
      .prepare(
        `DELETE FROM game_rounds WHERE rowid IN (
          SELECT round.rowid FROM game_rounds round
          JOIN games g ON g.id = round.game_id
          WHERE g.expires_at <= ?
          ORDER BY g.expires_at, round.game_id, round.round_number
          LIMIT 128
        )`,
      )
      .bind(now),
    database
      .prepare(
        `DELETE FROM command_receipts WHERE rowid IN (
          SELECT r.rowid FROM command_receipts r
          JOIN games g ON g.id = r.game_id
          WHERE g.expires_at <= ?
          ORDER BY g.expires_at, r.game_id
          LIMIT 128
        )`,
      )
      .bind(now),
    database
      .prepare(
        `DELETE FROM game_members WHERE rowid IN (
          SELECT m.rowid FROM game_members m
          JOIN games g ON g.id = m.game_id
          WHERE g.expires_at <= ?
          ORDER BY g.expires_at, m.game_id
          LIMIT 64
        )`,
      )
      .bind(now),
    database
      .prepare(
        `DELETE FROM games WHERE id IN (
          SELECT g.id FROM games g
          WHERE g.expires_at <= ?
            AND NOT EXISTS (SELECT 1 FROM game_events e WHERE e.game_id = g.id)
            AND NOT EXISTS (SELECT 1 FROM game_rounds round WHERE round.game_id = g.id)
            AND NOT EXISTS (SELECT 1 FROM command_receipts r WHERE r.game_id = g.id)
            AND NOT EXISTS (SELECT 1 FROM game_members m WHERE m.game_id = g.id)
            AND NOT EXISTS (SELECT 1 FROM game_presence p WHERE p.game_id = g.id)
            AND NOT EXISTS (
              SELECT 1 FROM public_game_listings listing
              WHERE listing.game_id = g.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM game_messages message
              WHERE message.game_id = g.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM game_message_cursors position
              WHERE position.game_id = g.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM game_message_receipts receipt
              WHERE receipt.game_id = g.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM game_mutes mute
              WHERE mute.game_id = g.id
            )
          ORDER BY g.expires_at, g.id
          LIMIT ?
        )`,
      )
      .bind(now, PURGE_BATCH_SIZE),
    database
      .prepare(
        `DELETE FROM mutation_quotas WHERE rowid IN (
          SELECT rowid FROM mutation_quotas
          WHERE expires_at <= ? ORDER BY expires_at LIMIT 128
        )`,
      )
      .bind(now),
  ]);
}

function normalizeJoinCode(value: string): string {
  const code = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  requireRule(code.length === 6, "INVALID_JOIN_CODE", "Enter a six-character lobby code.", 400);
  return code;
}

function randomJoinCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function databaseStatus(phase: GameState["phase"]): string {
  if (phase === "playing") return "playing";
  if (phase === "complete") return "finished";
  return "lobby";
}

async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
