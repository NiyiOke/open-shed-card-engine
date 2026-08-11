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
  GameEvent,
  GameState,
  GameView,
} from "../game/types";
import { GAME_PROTOCOL_VERSION, RULES_VERSION } from "../game/types";
import type { AuthenticatedUser } from "./auth";
import { cleanNickname } from "./auth";
import {
  assertInactiveRemovalPolicy,
  PRESENCE_THRESHOLDS,
  presencePlayer,
  type PresenceSnapshot,
} from "./presence-policy";

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
  expires_at: number;
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

type InactiveRemovalCommand = {
  type: "remove_inactive_player";
  targetPlayerId: string;
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
const EVENT_FEED_TAIL = 8;
const EVENT_FEED_PAGE = 12;

let lastPurgeAt = 0;
let purgePromise: Promise<void> | null = null;

export async function createGame(
  user: AuthenticatedUser,
  nickname: string,
  commandId: string,
): Promise<GameView> {
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maybePurgeExpiredGames(database, now);
  const profile = await getOrCreateProfile(user, nickname, database, now);
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
              status, version, state_json, state_hash, created_at,
              last_activity_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, 'lobby', 0, ?, ?, ?, ?, ?)`,
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
              game_id, profile_id, seat, role, status, joined_at
            ) VALUES (?, ?, 0, 'host', 'active', ?)`,
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
      ]);
      return projectGameForUser(state, user.userId);
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
): Promise<GameView> {
  const joinCode = normalizeJoinCode(joinCodeInput);
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maybePurgeExpiredGames(database, now);
  const profile = await getOrCreateProfile(user, nickname, database, now);
  const operation = "join_game";
  const requestHash = await hashText(
    JSON.stringify({ operation, joinCode, nickname: profile.nickname }),
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
      undefined,
      joinCode,
    );
  }

  let quotaCharged = false;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const row = await database
      .prepare(
        `SELECT id, join_code, host_profile_id, rules_version, protocol_version,
                status, version, state_json, state_hash, expires_at
         FROM games WHERE join_code = ? LIMIT 1`,
      )
      .bind(joinCode)
      .first<GameRow>();
    requireRule(row, "LOBBY_NOT_FOUND", "No lobby uses that code.", 404);
    requireRule(row.expires_at > now, "LOBBY_EXPIRED", "That lobby has expired.", 410);
    if (!quotaCharged) {
      await enforceMutationQuota(database, now, [
        {
          scope: `user:${profile.id}:join`,
          windowMs: 60_000,
          limit: 30,
        },
        { scope: `room:${row.id}`, windowMs: 60_000, limit: 240 },
      ]);
      quotaCharged = true;
    }
    const current = await parseAndValidateState(row);
    const result = joinLobbyState(current, {
      userId: user.userId,
      playerId: crypto.randomUUID(),
      displayName: profile.nickname,
      commandId,
      now,
    });
    if (result.replayed) {
      try {
        await database.batch([
          membershipUpsertStatement(
            database,
            current,
            profile,
            current.players.find((player) => player.userId === user.userId)!,
            now,
          ),
          presenceUpsertStatement(
            database,
            row.id,
            current.players.find((player) => player.userId === user.userId)!
              .playerId,
            profile.id,
            now,
          ),
          receiptStatement(
            database,
            profile.id,
            commandId,
            row.id,
            operation,
            requestHash,
            current.revision,
            now,
          ),
        ]);
      } catch (error) {
        const receipt = await findCommandReceipt(database, profile.id, commandId);
        if (!receipt) throw error;
        return viewFromReceipt(
          database,
          receipt,
          user,
          operation,
          requestHash,
          row.id,
          joinCode,
        );
      }
      return projectGameForUser(current, user.userId);
    }

    const nextJson = JSON.stringify(result.state);
    const nextHash = await hashText(nextJson);
    const joined = result.state.players.find(
      (player) => player.userId === user.userId,
    )!;
    try {
      const batch = await database.batch([
        guardedReceiptStatement(
          database,
          row,
          profile.id,
          commandId,
          operation,
          requestHash,
          result.state.revision,
          now,
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
          return viewFromReceipt(
            database,
            receipt,
            user,
            operation,
            requestHash,
            row.id,
            joinCode,
          );
        }
        continue;
      }
    } catch (error) {
      const receipt = await findCommandReceipt(database, profile.id, commandId);
      if (receipt) {
        return viewFromReceipt(
          database,
          receipt,
          user,
          operation,
          requestHash,
          row.id,
          joinCode,
        );
      }
      throw error;
    }
    return projectGameForUser(result.state, user.userId);
  }

  throw new GameRuleError(
    "LOBBY_CHANGED",
    "The lobby changed while you were joining. Please try once more.",
    409,
  );
}

export async function getGame(
  user: AuthenticatedUser,
  gameId: string,
  afterRevision?: number,
): Promise<{
  view: GameView;
  events: GameEvent[];
  eventCursor: number;
  presence: PresenceSnapshot;
}> {
  const database = await ensureDatabaseSchema();
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
  const feed = await readPublicEventFeed(database, gameId, afterRevision);
  const presence = await buildPresenceSnapshot(database, state, Date.now());
  return {
    view: projectGameForUser(state, user.userId),
    events: feed.events,
    eventCursor: feed.cursor,
    presence,
  };
}

export async function getGamePresence(
  user: AuthenticatedUser,
  gameId: string,
): Promise<PresenceSnapshot> {
  const database = await ensureDatabaseSchema();
  const row = await getGameRow(database, gameId);
  const state = await parseAndValidateState(row);
  requireCurrentMember(state, user.userId);
  return buildPresenceSnapshot(database, state, Date.now());
}

export async function heartbeatGamePresence(
  user: AuthenticatedUser,
  gameId: string,
): Promise<PresenceSnapshot> {
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maybePurgeExpiredGames(database, now);
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
  const result = await presenceUpsertStatement(
    database,
    gameId,
    player.playerId,
    profile.id,
    now,
  ).run();
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
): Promise<{ view: GameView | null; events: GameEvent[]; replayed: boolean }> {
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maybePurgeExpiredGames(database, now);
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
    return {
      view: await commandViewFromReceipt(
        database,
        durableReceipt,
        user,
        operation,
        requestHash,
        gameId,
        command.type === "leave_game",
      ),
      events: [],
      replayed: true,
    };
  }
  await enforceMutationQuota(database, now, [
    {
      scope: `user:${profile.id}:command`,
      windowMs: 60_000,
      limit: 120,
    },
    { scope: `room:${gameId}`, windowMs: 60_000, limit: 360 },
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
    return {
      view: await commandViewFromReceipt(
        database,
        recoveredReceipt,
        user,
        operation,
        requestHash,
        gameId,
        command.type === "leave_game",
      ),
      events: [],
      replayed: true,
    };
  }

  if (row.version !== expectedRevision || current.revision !== expectedRevision) {
    throw new GameRuleError(
      "VERSION_CONFLICT",
      "The game moved on. Refreshing will show the latest turn.",
      409,
    );
  }
  requireRule(
    current.phase !== "complete" || command.type === "rematch",
    "GAME_COMPLETE",
    "This game is already complete. Start a rematch to play again.",
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
  const result = transitionGame(current, command, {
    actorUserId: user.userId,
    commandId,
    now,
  });
  const nextJson = JSON.stringify(result.state);
  const nextHash = await hashText(nextJson);
  const expiresAt =
    now +
    (result.state.phase === "lobby" ? LOBBY_LIFETIME_MS : ACTIVE_LIFETIME_MS);
  const memberProfiles = await profilesForState(database, result.state);
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
  const departedPlayerIds = current.players
    .filter(
      (player) =>
        player.status !== "left" && !remainingPlayerIds.has(player.playerId),
    )
    .map((player) => player.playerId)
    .concat(
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

  try {
    const batch = await database.batch([
      inactiveRemovalGuard
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
      ...memberStatements,
      ...presenceCleanupStatements,
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
      ),
    ]);
    if ((batch.at(-1)?.meta.changes ?? 0) !== 1) {
      const receipt = await findCommandReceipt(database, profile.id, commandId);
      if (receipt) {
        return {
          view: await commandViewFromReceipt(
            database,
            receipt,
            user,
            operation,
            requestHash,
            gameId,
            command.type === "leave_game",
          ),
          events: [],
          replayed: true,
        };
      }
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
      return {
        view: await commandViewFromReceipt(
          database,
          receipt,
          user,
          operation,
          requestHash,
          gameId,
          command.type === "leave_game",
        ),
        events: [],
        replayed: true,
      };
    }
    throw error;
  }

  return {
    view: commandViewForUser(result.state, user.userId),
    events: result.events,
    replayed: result.replayed,
  };
}

export async function listLobbies(
  user: AuthenticatedUser,
): Promise<{ mine: LobbySummary[] }> {
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maybePurgeExpiredGames(database, now);
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
              g.state_hash, g.expires_at
       FROM games g
       JOIN game_members m ON m.game_id = g.id
       WHERE m.profile_id = ? AND m.status <> 'left' AND g.expires_at > ?
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
): Promise<ProfileRow> {
  const existing = await database
    .prepare(
      `SELECT id, auth_subject, nickname FROM profiles WHERE auth_subject = ? LIMIT 1`,
    )
    .bind(user.userId)
    .first<ProfileRow>();
  const nickname = cleanNickname(nicknameInput || user.suggestedName);
  if (existing) {
    if (existing.nickname !== nickname) {
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
    (await database
      .prepare(
        `SELECT id, auth_subject, nickname FROM profiles WHERE auth_subject = ? LIMIT 1`,
      )
      .bind(user.userId)
      .first<ProfileRow>()) ?? profile
  );
}

async function getGameRow(database: D1Database, gameId: string): Promise<GameRow> {
  const row = await database
    .prepare(
      `SELECT id, join_code, host_profile_id, rules_version, protocol_version,
              status, version, state_json, state_hash, expires_at
       FROM games WHERE id = ? LIMIT 1`,
    )
    .bind(gameId)
    .first<GameRow>();
  requireRule(row, "GAME_NOT_FOUND", "Game not found.", 404);
  requireRule(row.expires_at > Date.now(), "GAME_EXPIRED", "This game has expired.", 410);
  return row;
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
  return projectGameForUser(state, user.userId);
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
  return commandViewForUser(state, user.userId);
}

function commandViewForUser(state: GameState, userId: string): GameView | null {
  return state.players.some(
    (player) => player.userId === userId && player.status !== "left",
  )
    ? projectGameForUser(state, userId)
    : null;
}

function receiptStatement(
  database: D1Database,
  profileId: string,
  commandId: string,
  gameId: string,
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      profileId,
      commandId,
      gameId,
      operation,
      requestHash,
      resultVersion,
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
      )`,
    )
    .bind(
      row.id,
      version,
      commandId,
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

function membershipUpsertStatement(
  database: D1Database,
  state: GameState,
  profile: ProfileRow,
  player: GameState["players"][number],
  now: number,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO game_members (
        game_id, profile_id, seat, role, status, joined_at, left_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(game_id, profile_id) DO UPDATE SET
        seat = excluded.seat,
        role = excluded.role,
        status = excluded.status,
        left_at = excluded.left_at`,
    )
    .bind(
      state.gameId,
      profile.id,
      player.seat,
      state.hostUserId === player.userId ? "host" : "player",
      player.status,
      now,
      player.status === "left" ? now : null,
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
        SELECT 1 FROM game_members
        WHERE game_id = ? AND profile_id = ? AND status <> 'left'
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
        SELECT 1 FROM game_members
        WHERE game_id = ? AND profile_id = ? AND status <> 'left'
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
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO game_members (
        game_id, profile_id, seat, role, status, joined_at, left_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM command_receipts
        WHERE actor_profile_id = ? AND command_id = ?
          AND game_id = ? AND request_hash = ?
      )
      ON CONFLICT(game_id, profile_id) DO UPDATE SET
        seat = excluded.seat,
        role = excluded.role,
        status = excluded.status,
        left_at = excluded.left_at`,
    )
    .bind(
      gameId,
      profile.id,
      player.seat,
      player.userId === hostUserId ? "host" : "player",
      player.status,
      now,
      player.status === "left" ? now : null,
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
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE games
       SET host_profile_id = COALESCE(
             (SELECT id FROM profiles WHERE auth_subject = ? LIMIT 1),
             host_profile_id
           ),
           status = ?, version = ?, state_json = ?, state_hash = ?,
           last_activity_at = ?, expires_at = ?
       WHERE id = ? AND version = ? AND state_hash = ?
         AND EXISTS (
           SELECT 1 FROM command_receipts
           WHERE actor_profile_id = ? AND command_id = ?
             AND game_id = ? AND request_hash = ?
         )
         AND EXISTS (
           SELECT 1 FROM game_events
           WHERE game_id = ? AND version = ? AND actor_profile_id = ?
             AND command_id = ? AND state_hash = ?
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
      commandId,
      stateHash,
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
): Promise<{ events: GameEvent[]; cursor: number }> {
  const query = afterRevision === undefined
    ? database
        .prepare(
          `SELECT version, public_payload_json
           FROM (
             SELECT version, public_payload_json
             FROM game_events
             WHERE game_id = ?
             ORDER BY version DESC LIMIT ?
           ) recent
           ORDER BY version ASC`,
        )
        .bind(gameId, EVENT_FEED_TAIL)
    : database
        .prepare(
          `SELECT version, public_payload_json
           FROM game_events
           WHERE game_id = ? AND version > ?
           ORDER BY version ASC LIMIT ?`,
        )
        .bind(gameId, afterRevision, EVENT_FEED_PAGE);
  const rows = await query.all<EventRow>();
  const events = rows.results.flatMap((row) => parsePublicEvents(row));
  return {
    events,
    cursor:
      rows.results.at(-1)?.version ??
      afterRevision ??
      0,
  };
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
  const statements = rules.map((rule) => {
    const bucketStart = Math.floor(now / rule.windowMs) * rule.windowMs;
    return database
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
      );
  });
  const results = await database.batch<{ count: number }>(statements);
  for (let index = 0; index < rules.length; index += 1) {
    const count = Number(results[index]?.results?.[0]?.count ?? 0);
    if (count > rules[index].limit) {
      throw new GameRuleError(
        "RATE_LIMITED",
        "Too many write requests. Please wait and try again.",
        429,
      );
    }
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
            AND NOT EXISTS (SELECT 1 FROM command_receipts r WHERE r.game_id = g.id)
            AND NOT EXISTS (SELECT 1 FROM game_members m WHERE m.game_id = g.id)
            AND NOT EXISTS (SELECT 1 FROM game_presence p WHERE p.game_id = g.id)
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
