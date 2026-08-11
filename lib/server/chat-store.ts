import { ensureDatabaseSchema } from "../../db/runtime";
import { GameRuleError, requireRule } from "../game/errors";
import type { GameState, PlayerState } from "../game/types";
import type { AuthenticatedUser } from "./auth";
import {
  assertCommunicationEnabled,
  COMMUNICATION_LIMITS,
  createOpaqueCommunicationId,
  parseCommunicationMessage,
  type CommunicationContentId,
  type CommunicationMessageKind,
  type ReportReasonId,
} from "./communication-policy";

export type TableMessage = Readonly<{
  id: string;
  senderPlayerId: string;
  senderDisplayName: string;
  kind: CommunicationMessageKind;
  contentId: CommunicationContentId;
  createdAt: number;
}>;

export type TableMessagePage = Readonly<{
  messages: TableMessage[];
  nextCursor: string | null;
  serverTime: number;
  viewer: Readonly<{
    mutedPlayerIds: string[];
    blockedPlayerIds: string[];
  }>;
}>;

export type SendTableMessageResult = Readonly<{
  message: TableMessage;
  replayed: boolean;
}>;

export type ReportTableMessageResult = Readonly<{
  received: true;
  replayed: boolean;
}>;

type MemberGameRow = {
  id: string;
  state_json: string;
  room_status: string;
  expires_at: number;
  profile_id: string | null;
  membership_status: string | null;
};

type CurrentMemberContext = {
  gameId: string;
  profileId: string;
  state: GameState;
  player: PlayerState;
};

type TargetMember = {
  profileId: string;
  player: PlayerState;
};

type MessageRow = {
  id: string;
  game_id: string;
  sender_profile_id: string;
  sender_player_id: string;
  sender_display_name: string;
  kind: string;
  content_id: string;
  command_id: string;
  created_at: number;
  expires_at: number;
};

type ScannedMessageRow = MessageRow & {
  viewer_muted: number;
  pair_blocked: number;
};

type CursorRow = {
  id: string;
  created_at: number;
};

type ProfileRow = {
  id: string;
};

type ReceiptRow = {
  actor_profile_id: string;
  command_id: string;
  game_id: string;
  operation: string;
  request_hash: string;
};

type ReportReplayRow = {
  game_id: string;
  message_id: string;
  reason: string;
};

type ReportTargetRow = MessageRow & {
  reporter_profile_id: string;
  state_json: string;
};

type ViewerSafetyRow = {
  profile_id: string;
  auth_subject: string;
  viewer_muted: number;
  viewer_blocked: number;
};

type QuotaRule = {
  scope: string;
  windowMs: number;
  limit: number;
};

const MESSAGE_OPERATION = "chat_message_send";
const REPORT_OPERATION = "chat_message_report";
const COMMUNICATION_CLEANUP_INTERVAL_MS = 5 * 60_000;

let cleanupPromise: Promise<void> | null = null;
let lastCleanupAt = 0;

export async function listTableMessages(
  user: AuthenticatedUser,
  gameId: string,
  cursor: string | null,
): Promise<TableMessagePage> {
  assertCommunicationEnabled();
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maybeCleanupCommunication(database, now);
  const viewer = await requireCurrentMember(database, user, gameId, now);
  const cursorRow = cursor
    ? await requireCursor(database, gameId, cursor)
    : null;

  const query = cursorRow
    ? database.prepare(
        `SELECT message.id, message.game_id, message.sender_profile_id,
                message.sender_player_id, message.sender_display_name,
                message.kind, message.content_id, message.command_id,
                message.created_at, message.expires_at,
                EXISTS (
                  SELECT 1 FROM game_mutes mute
                  WHERE mute.game_id = message.game_id
                    AND mute.muter_profile_id = ?
                    AND mute.muted_profile_id = message.sender_profile_id
                ) AS viewer_muted,
                EXISTS (
                  SELECT 1 FROM profile_blocks block
                  WHERE (
                    block.blocker_profile_id = ?
                    AND block.blocked_profile_id = message.sender_profile_id
                  ) OR (
                    block.blocker_profile_id = message.sender_profile_id
                    AND block.blocked_profile_id = ?
                  )
                ) AS pair_blocked
         FROM game_messages message
         JOIN game_members sender
           ON sender.game_id = message.game_id
          AND sender.profile_id = message.sender_profile_id
          AND sender.status <> 'left'
         WHERE message.game_id = ? AND message.expires_at > ?
           AND (
             message.created_at > ?
             OR (message.created_at = ? AND message.id > ?)
           )
         ORDER BY message.created_at, message.id
         LIMIT ?`,
      )
        .bind(
          viewer.profileId,
          viewer.profileId,
          viewer.profileId,
          gameId,
          now,
          cursorRow.created_at,
          cursorRow.created_at,
          cursorRow.id,
          COMMUNICATION_LIMITS.messageScanLimit,
        )
    : database.prepare(
        `SELECT message.id, message.game_id, message.sender_profile_id,
                message.sender_player_id, message.sender_display_name,
                message.kind, message.content_id, message.command_id,
                message.created_at, message.expires_at,
                EXISTS (
                  SELECT 1 FROM game_mutes mute
                  WHERE mute.game_id = message.game_id
                    AND mute.muter_profile_id = ?
                    AND mute.muted_profile_id = message.sender_profile_id
                ) AS viewer_muted,
                EXISTS (
                  SELECT 1 FROM profile_blocks block
                  WHERE (
                    block.blocker_profile_id = ?
                    AND block.blocked_profile_id = message.sender_profile_id
                  ) OR (
                    block.blocker_profile_id = message.sender_profile_id
                    AND block.blocked_profile_id = ?
                  )
                ) AS pair_blocked
         FROM game_messages message
         JOIN game_members sender
           ON sender.game_id = message.game_id
          AND sender.profile_id = message.sender_profile_id
          AND sender.status <> 'left'
         WHERE message.game_id = ? AND message.expires_at > ?
         ORDER BY message.created_at, message.id
         LIMIT ?`,
      ).bind(
        viewer.profileId,
        viewer.profileId,
        viewer.profileId,
        gameId,
        now,
        COMMUNICATION_LIMITS.messageScanLimit,
      );

  const scanned = await query.all<ScannedMessageRow>();
  const safety = await readViewerSafetyState(database, viewer);
  return {
    messages: scanned.results
      .filter(
        (message) =>
          Number(message.viewer_muted) === 0 &&
          Number(message.pair_blocked) === 0,
      )
      .map(messageDto),
    nextCursor: scanned.results.at(-1)?.id ?? cursor,
    serverTime: now,
    viewer: safety,
  };
}

export async function sendTableMessage(
  user: AuthenticatedUser,
  gameId: string,
  commandId: string,
  kind: CommunicationMessageKind,
  contentId: CommunicationContentId,
): Promise<SendTableMessageResult> {
  assertCommunicationEnabled();
  const normalized = parseCommunicationMessage(kind, contentId);
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maybeCleanupCommunication(database, now);
  const actor = await requireCurrentMember(database, user, gameId, now);
  const requestHash = await hashText(
    JSON.stringify({
      operation: MESSAGE_OPERATION,
      gameId,
      kind: normalized.kind,
      contentId: normalized.contentId,
    }),
  );

  const existingReceipt = await findReceipt(
    database,
    actor.profileId,
    commandId,
  );
  if (existingReceipt) {
    assertReceipt(existingReceipt, MESSAGE_OPERATION, requestHash, gameId);
    return replayMessage(database, actor.profileId, commandId, now);
  }

  await enforceCommunicationQuota(database, now, [
    {
      scope: `user:${actor.profileId}:chat-message`,
      windowMs: 60_000,
      limit: COMMUNICATION_LIMITS.messageUserMinuteLimit,
    },
    {
      scope: `room:${gameId}:chat-message`,
      windowMs: 60_000,
      limit: COMMUNICATION_LIMITS.messageRoomMinuteLimit,
    },
  ]);

  const messageId = createOpaqueCommunicationId();
  const expiresAt = now + COMMUNICATION_LIMITS.messageRetentionMs;
  try {
    const batch = await database.batch([
      database
        .prepare(
          `INSERT INTO command_receipts (
            actor_profile_id, command_id, game_id, operation,
            request_hash, result_version, created_at
          )
          SELECT ?, ?, ?, ?, ?, 0, ?
          WHERE EXISTS (
            SELECT 1
            FROM games game
            JOIN profiles profile ON profile.id = ?
            JOIN game_members member
              ON member.game_id = game.id
             AND member.profile_id = profile.id
             AND member.status <> 'left'
            WHERE game.id = ? AND profile.auth_subject = ?
              AND game.room_status = 'open' AND game.expires_at > ?
              AND NOT EXISTS (
                SELECT 1 FROM game_messages recent
                WHERE recent.game_id = game.id
                  AND recent.sender_profile_id = profile.id
                  AND recent.created_at > ?
              )
          )`,
        )
        .bind(
          actor.profileId,
          commandId,
          gameId,
          MESSAGE_OPERATION,
          requestHash,
          now,
          actor.profileId,
          gameId,
          user.userId,
          now,
          now - COMMUNICATION_LIMITS.messageCooldownMs,
        ),
      database
        .prepare(
          `INSERT INTO game_messages (
            id, game_id, sender_profile_id, sender_player_id,
            sender_display_name, kind, content_id, command_id,
            created_at, expires_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM command_receipts
            WHERE actor_profile_id = ? AND command_id = ?
              AND game_id = ? AND operation = ? AND request_hash = ?
          )`,
        )
        .bind(
          messageId,
          gameId,
          actor.profileId,
          actor.player.playerId,
          actor.player.displayName,
          normalized.kind,
          normalized.contentId,
          commandId,
          now,
          expiresAt,
          actor.profileId,
          commandId,
          gameId,
          MESSAGE_OPERATION,
          requestHash,
        ),
    ]);
    if ((batch.at(-1)?.meta.changes ?? 0) === 1) {
      const row = await findMessageByCommand(
        database,
        actor.profileId,
        commandId,
      );
      requireRule(
        row,
        "MESSAGE_WRITE_FAILED",
        "The message could not be saved.",
        500,
      );
      return { message: messageDto(row), replayed: false };
    }
  } catch (error) {
    const receipt = await findReceipt(database, actor.profileId, commandId);
    if (receipt) {
      assertReceipt(receipt, MESSAGE_OPERATION, requestHash, gameId);
      return replayMessage(database, actor.profileId, commandId, now);
    }
    throw error;
  }

  const racedReceipt = await findReceipt(database, actor.profileId, commandId);
  if (racedReceipt) {
    assertReceipt(racedReceipt, MESSAGE_OPERATION, requestHash, gameId);
    return replayMessage(database, actor.profileId, commandId, now);
  }
  await requireCurrentMember(database, user, gameId, now);
  throw rateLimited();
}

export async function reportTableMessage(
  user: AuthenticatedUser,
  messageId: string,
  commandId: string,
  reason: ReportReasonId,
): Promise<ReportTableMessageResult> {
  assertCommunicationEnabled();
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maybeCleanupCommunication(database, now);
  const profile = await findProfile(database, user.userId);
  requireRule(
    profile,
    "CHAT_MESSAGE_NOT_FOUND",
    "That message is no longer available.",
    404,
  );

  const existingReport = await findReportByCommand(
    database,
    profile.id,
    commandId,
  );
  if (existingReport) {
    requireRule(
      existingReport.message_id === messageId &&
        existingReport.reason === reason,
      "IDEMPOTENCY_KEY_REUSED",
      "That commandId was already used for a different request.",
      409,
    );
    await requireReportReplayAccess(
      database,
      user,
      existingReport.game_id,
      now,
    );
    return { received: true, replayed: true };
  }

  const target = await resolveReportTarget(
    database,
    user.userId,
    messageId,
    now,
  );
  requireRule(
    target.sender_profile_id !== target.reporter_profile_id,
    "CANNOT_REPORT_SELF",
    "You cannot report your own message.",
    400,
  );
  const requestHash = await hashText(
    JSON.stringify({ operation: REPORT_OPERATION, messageId, reason }),
  );
  const existingReceipt = await findReceipt(
    database,
    target.reporter_profile_id,
    commandId,
  );
  if (existingReceipt) {
    assertReceipt(
      existingReceipt,
      REPORT_OPERATION,
      requestHash,
      target.game_id,
    );
    const replay = await findReportByCommand(
      database,
      target.reporter_profile_id,
      commandId,
    );
    requireRule(
      replay && replay.message_id === messageId && replay.reason === reason,
      "REPORT_WRITE_FAILED",
      "The report receipt is incomplete.",
      500,
    );
    return { received: true, replayed: true };
  }

  await enforceCommunicationQuota(database, now, [
    {
      scope: `user:${target.reporter_profile_id}:chat-report`,
      windowMs: 60 * 60_000,
      limit: COMMUNICATION_LIMITS.reportUserHourLimit,
    },
    {
      scope: `room:${target.game_id}:chat-report`,
      windowMs: 60 * 60_000,
      limit: COMMUNICATION_LIMITS.reportRoomHourLimit,
    },
  ]);

  const reportId = createOpaqueCommunicationId();
  const expiresAt = now + COMMUNICATION_LIMITS.reportRetentionMs;
  try {
    const batch = await database.batch([
      database
        .prepare(
          `INSERT INTO command_receipts (
            actor_profile_id, command_id, game_id, operation,
            request_hash, result_version, created_at
          )
          SELECT ?, ?, message.game_id, ?, ?, 0, ?
          FROM game_messages message
          JOIN games game ON game.id = message.game_id
          JOIN game_members viewer
            ON viewer.game_id = message.game_id
           AND viewer.profile_id = ?
           AND viewer.status <> 'left'
          JOIN profiles profile ON profile.id = viewer.profile_id
          WHERE message.id = ? AND message.expires_at > ?
            AND game.room_status = 'open' AND game.expires_at > ?
            AND profile.auth_subject = ?
            AND message.sender_profile_id <> viewer.profile_id`,
        )
        .bind(
          target.reporter_profile_id,
          commandId,
          REPORT_OPERATION,
          requestHash,
          now,
          target.reporter_profile_id,
          messageId,
          now,
          now,
          user.userId,
        ),
      database
        .prepare(
          `INSERT INTO game_message_reports (
            id, game_id, message_id, reporter_profile_id,
            reported_profile_id, evidence_sender_player_id,
            evidence_sender_display_name, evidence_kind,
            evidence_content_id, evidence_created_at, reason,
            moderation_state, command_id, created_at, expires_at
          )
          SELECT ?, message.game_id, message.id, ?,
                 message.sender_profile_id, message.sender_player_id,
                 message.sender_display_name, message.kind,
                 message.content_id, message.created_at, ?,
                 'pending', ?, ?, ?
          FROM game_messages message
          WHERE message.id = ? AND message.expires_at > ?
            AND EXISTS (
              SELECT 1 FROM command_receipts receipt
              WHERE receipt.actor_profile_id = ? AND receipt.command_id = ?
                AND receipt.game_id = message.game_id
                AND receipt.operation = ? AND receipt.request_hash = ?
            )`,
        )
        .bind(
          reportId,
          target.reporter_profile_id,
          reason,
          commandId,
          now,
          expiresAt,
          messageId,
          now,
          target.reporter_profile_id,
          commandId,
          REPORT_OPERATION,
          requestHash,
        ),
    ]);
    if ((batch.at(-1)?.meta.changes ?? 0) === 1) {
      return { received: true, replayed: false };
    }
  } catch (error) {
    const replay = await findReportByCommand(
      database,
      target.reporter_profile_id,
      commandId,
    );
    if (replay) {
      requireRule(
        replay.message_id === messageId && replay.reason === reason,
        "IDEMPOTENCY_KEY_REUSED",
        "That commandId was already used for a different request.",
        409,
      );
      return { received: true, replayed: true };
    }
    const receipt = await findReceipt(
      database,
      target.reporter_profile_id,
      commandId,
    );
    if (receipt) {
      assertReceipt(
        receipt,
        REPORT_OPERATION,
        requestHash,
        target.game_id,
      );
      throw new GameRuleError(
        "REPORT_WRITE_FAILED",
        "The report receipt is incomplete.",
        500,
      );
    }
    throw error;
  }
  throw new GameRuleError(
    "CHAT_MESSAGE_NOT_FOUND",
    "That message is no longer available.",
    404,
  );
}

export async function setTableMute(
  user: AuthenticatedUser,
  gameId: string,
  targetPlayerId: string,
  muted: boolean,
): Promise<{ muted: boolean }> {
  await setSafetyRelationship(user, gameId, targetPlayerId, "mute", muted);
  return { muted };
}

export async function setProfileBlock(
  user: AuthenticatedUser,
  gameId: string,
  targetPlayerId: string,
  blocked: boolean,
): Promise<{ blocked: boolean }> {
  await setSafetyRelationship(user, gameId, targetPlayerId, "block", blocked);
  return { blocked };
}

export async function cleanupExpiredCommunicationRows(
  database: D1Database,
  now: number,
): Promise<void> {
  const messageCutoff = now - COMMUNICATION_LIMITS.messageRetentionMs;
  const reportCutoff = now - COMMUNICATION_LIMITS.reportRetentionMs;
  await database.batch([
    database
      .prepare(
        `DELETE FROM game_message_reports WHERE rowid IN (
          SELECT rowid FROM game_message_reports
          WHERE expires_at <= ?
          ORDER BY expires_at, id LIMIT ?
        )`,
      )
      .bind(now, COMMUNICATION_LIMITS.cleanupBatchSize),
    database
      .prepare(
        `DELETE FROM command_receipts WHERE rowid IN (
          SELECT rowid FROM command_receipts
          WHERE operation = ? AND created_at <= ?
          ORDER BY created_at, actor_profile_id, command_id LIMIT ?
        )`,
      )
      .bind(
        REPORT_OPERATION,
        reportCutoff,
        COMMUNICATION_LIMITS.cleanupBatchSize,
      ),
    database
      .prepare(
        `DELETE FROM command_receipts WHERE rowid IN (
          SELECT rowid FROM command_receipts
          WHERE operation = ? AND created_at <= ?
          ORDER BY created_at, actor_profile_id, command_id LIMIT ?
        )`,
      )
      .bind(
        MESSAGE_OPERATION,
        messageCutoff,
        COMMUNICATION_LIMITS.cleanupBatchSize,
      ),
    database
      .prepare(
        `DELETE FROM game_messages WHERE rowid IN (
          SELECT rowid FROM game_messages
          WHERE expires_at <= ?
          ORDER BY expires_at, id LIMIT ?
        )`,
      )
      .bind(now, COMMUNICATION_LIMITS.cleanupBatchSize),
  ]);
}

async function setSafetyRelationship(
  user: AuthenticatedUser,
  gameId: string,
  targetPlayerId: string,
  relationship: "mute" | "block",
  enabled: boolean,
): Promise<void> {
  assertCommunicationEnabled();
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maybeCleanupCommunication(database, now);
  const actor = await requireCurrentMember(database, user, gameId, now);
  const target = await requireTargetMember(
    database,
    actor,
    targetPlayerId,
  );
  requireRule(
    target.profileId !== actor.profileId,
    relationship === "mute" ? "CANNOT_MUTE_SELF" : "CANNOT_BLOCK_SELF",
    `You cannot ${relationship} yourself.`,
    400,
  );

  const currentlyEnabled = await hasSafetyRelationship(
    database,
    gameId,
    actor.profileId,
    target.profileId,
    relationship,
  );
  if (currentlyEnabled === enabled) return;
  await enforceCommunicationQuota(database, now, [
    {
      scope: `user:${actor.profileId}:chat-safety`,
      windowMs: 60_000,
      limit: COMMUNICATION_LIMITS.relationshipUserMinuteLimit,
    },
    {
      scope: `room:${gameId}:chat-safety`,
      windowMs: 60_000,
      limit: COMMUNICATION_LIMITS.relationshipRoomMinuteLimit,
    },
  ]);

  const statement = safetyRelationshipStatement(
    database,
    actor,
    target,
    relationship,
    enabled,
    now,
    user.userId,
  );
  await statement.run();

  await requireCurrentMember(database, user, gameId, now);
  await requireTargetMember(database, actor, targetPlayerId);
  const finalState = await hasSafetyRelationship(
    database,
    gameId,
    actor.profileId,
    target.profileId,
    relationship,
  );
  requireRule(
    finalState === enabled,
    "SAFETY_ACTION_CONFLICT",
    "The player list changed before that safety action completed.",
    409,
  );
}

function safetyRelationshipStatement(
  database: D1Database,
  actor: CurrentMemberContext,
  target: TargetMember,
  relationship: "mute" | "block",
  enabled: boolean,
  now: number,
  actorUserId: string,
): D1PreparedStatement {
  const membershipGuard = `EXISTS (
    SELECT 1
    FROM games game
    JOIN profiles actor_profile ON actor_profile.id = ?
    JOIN game_members actor_member
      ON actor_member.game_id = game.id
     AND actor_member.profile_id = actor_profile.id
     AND actor_member.status <> 'left'
    JOIN game_members target_member
      ON target_member.game_id = game.id
     AND target_member.profile_id = ?
     AND target_member.status <> 'left'
    WHERE game.id = ? AND game.room_status = 'open'
      AND game.expires_at > ? AND actor_profile.auth_subject = ?
  )`;
  if (relationship === "mute") {
    return enabled
      ? database
          .prepare(
            `INSERT OR IGNORE INTO game_mutes (
              game_id, muter_profile_id, muted_profile_id, created_at
            )
            SELECT ?, ?, ?, ? WHERE ${membershipGuard}`,
          )
          .bind(
            actor.gameId,
            actor.profileId,
            target.profileId,
            now,
            actor.profileId,
            target.profileId,
            actor.gameId,
            now,
            actorUserId,
          )
      : database
          .prepare(
            `DELETE FROM game_mutes
             WHERE game_id = ? AND muter_profile_id = ?
               AND muted_profile_id = ? AND ${membershipGuard}`,
          )
          .bind(
            actor.gameId,
            actor.profileId,
            target.profileId,
            actor.profileId,
            target.profileId,
            actor.gameId,
            now,
            actorUserId,
          );
  }
  return enabled
    ? database
        .prepare(
          `INSERT OR IGNORE INTO profile_blocks (
            blocker_profile_id, blocked_profile_id, created_at
          )
          SELECT ?, ?, ? WHERE ${membershipGuard}`,
        )
        .bind(
          actor.profileId,
          target.profileId,
          now,
          actor.profileId,
          target.profileId,
          actor.gameId,
          now,
          actorUserId,
        )
    : database
        .prepare(
          `DELETE FROM profile_blocks
           WHERE blocker_profile_id = ? AND blocked_profile_id = ?
             AND ${membershipGuard}`,
        )
        .bind(
          actor.profileId,
          target.profileId,
          actor.profileId,
          target.profileId,
          actor.gameId,
          now,
          actorUserId,
        );
}

async function hasSafetyRelationship(
  database: D1Database,
  gameId: string,
  actorProfileId: string,
  targetProfileId: string,
  relationship: "mute" | "block",
): Promise<boolean> {
  const row = relationship === "mute"
    ? await database
        .prepare(
          `SELECT 1 AS present FROM game_mutes
           WHERE game_id = ? AND muter_profile_id = ?
             AND muted_profile_id = ? LIMIT 1`,
        )
        .bind(gameId, actorProfileId, targetProfileId)
        .first<{ present: number }>()
    : await database
        .prepare(
          `SELECT 1 AS present FROM profile_blocks
           WHERE blocker_profile_id = ? AND blocked_profile_id = ? LIMIT 1`,
        )
        .bind(actorProfileId, targetProfileId)
        .first<{ present: number }>();
  return Boolean(row);
}

async function requireCurrentMember(
  database: D1Database,
  user: AuthenticatedUser,
  gameId: string,
  now: number,
): Promise<CurrentMemberContext> {
  const row = await database
    .prepare(
      `SELECT game.id, game.state_json, game.room_status, game.expires_at,
              profile.id AS profile_id, member.status AS membership_status
       FROM games game
       LEFT JOIN profiles profile ON profile.auth_subject = ?
       LEFT JOIN game_members member
         ON member.game_id = game.id AND member.profile_id = profile.id
       WHERE game.id = ? LIMIT 1`,
    )
    .bind(user.userId, gameId)
    .first<MemberGameRow>();
  requireRule(row, "GAME_NOT_FOUND", "Game not found.", 404);
  requireRule(
    row.room_status === "open",
    "ROOM_CLOSED",
    "This room is closed.",
    410,
  );
  requireRule(
    Number(row.expires_at) > now,
    "GAME_EXPIRED",
    "This game has expired.",
    410,
  );
  requireRule(
    row.profile_id && row.membership_status !== null && row.membership_status !== "left",
    "NOT_A_MEMBER",
    "You are not a current member of this game.",
    403,
  );
  const state = parseStoredState(row.state_json);
  const player = state.players.find(
    (candidate) =>
      candidate.userId === user.userId && candidate.status !== "left",
  );
  requireRule(
    player,
    "NOT_A_MEMBER",
    "You are not a current member of this game.",
    403,
  );
  return { gameId, profileId: row.profile_id, state, player };
}

async function requireReportReplayAccess(
  database: D1Database,
  user: AuthenticatedUser,
  gameId: string,
  now: number,
): Promise<void> {
  try {
    await requireCurrentMember(database, user, gameId, now);
  } catch (error) {
    if (
      error instanceof GameRuleError &&
      ["GAME_NOT_FOUND", "ROOM_CLOSED", "GAME_EXPIRED", "NOT_A_MEMBER"].includes(
        error.code,
      )
    ) {
      throw new GameRuleError(
        "CHAT_MESSAGE_NOT_FOUND",
        "That message is no longer available.",
        404,
      );
    }
    throw error;
  }
}

async function requireTargetMember(
  database: D1Database,
  actor: CurrentMemberContext,
  targetPlayerId: string,
): Promise<TargetMember> {
  const player = actor.state.players.find(
    (candidate) =>
      candidate.playerId === targetPlayerId && candidate.status !== "left",
  );
  requireRule(
    player,
    "PLAYER_NOT_FOUND",
    "That player is not a current member of this game.",
    404,
  );
  const row = await database
    .prepare(
      `SELECT profile.id
       FROM profiles profile
       JOIN game_members member ON member.profile_id = profile.id
       WHERE profile.auth_subject = ? AND member.game_id = ?
         AND member.status <> 'left' LIMIT 1`,
    )
    .bind(player.userId, actor.gameId)
    .first<ProfileRow>();
  requireRule(
    row,
    "PLAYER_NOT_FOUND",
    "That player is not a current member of this game.",
    404,
  );
  return { profileId: row.id, player };
}

async function resolveReportTarget(
  database: D1Database,
  actorUserId: string,
  messageId: string,
  now: number,
): Promise<ReportTargetRow> {
  const row = await database
    .prepare(
      `SELECT message.id, message.game_id, message.sender_profile_id,
              message.sender_player_id, message.sender_display_name,
              message.kind, message.content_id, message.command_id,
              message.created_at, message.expires_at,
              viewer_profile.id AS reporter_profile_id, game.state_json
       FROM game_messages message
       JOIN games game ON game.id = message.game_id
       JOIN profiles viewer_profile ON viewer_profile.auth_subject = ?
       JOIN game_members viewer_member
         ON viewer_member.game_id = message.game_id
        AND viewer_member.profile_id = viewer_profile.id
        AND viewer_member.status <> 'left'
       WHERE message.id = ? AND message.expires_at > ?
         AND game.room_status = 'open' AND game.expires_at > ?
       LIMIT 1`,
    )
    .bind(actorUserId, messageId, now, now)
    .first<ReportTargetRow>();
  requireRule(
    row,
    "CHAT_MESSAGE_NOT_FOUND",
    "That message is no longer available.",
    404,
  );
  const state = parseStoredState(row.state_json);
  requireRule(
    state.players.some(
      (player) => player.userId === actorUserId && player.status !== "left",
    ),
    "CHAT_MESSAGE_NOT_FOUND",
    "That message is no longer available.",
    404,
  );
  return row;
}

async function readViewerSafetyState(
  database: D1Database,
  viewer: CurrentMemberContext,
): Promise<TableMessagePage["viewer"]> {
  const rows = await database
    .prepare(
      `SELECT member.profile_id, profile.auth_subject,
              EXISTS (
                SELECT 1 FROM game_mutes mute
                WHERE mute.game_id = member.game_id
                  AND mute.muter_profile_id = ?
                  AND mute.muted_profile_id = member.profile_id
              ) AS viewer_muted,
              EXISTS (
                SELECT 1 FROM profile_blocks block
                WHERE block.blocker_profile_id = ?
                  AND block.blocked_profile_id = member.profile_id
              ) AS viewer_blocked
       FROM game_members member
       JOIN profiles profile ON profile.id = member.profile_id
       WHERE member.game_id = ? AND member.status <> 'left'
         AND member.profile_id <> ?
       ORDER BY member.seat`,
    )
    .bind(
      viewer.profileId,
      viewer.profileId,
      viewer.gameId,
      viewer.profileId,
    )
    .all<ViewerSafetyRow>();
  const currentPlayers = new Map(
    viewer.state.players
      .filter((player) => player.status !== "left")
      .map((player) => [player.userId, player.playerId]),
  );
  const muted = new Set<string>();
  const blocked = new Set<string>();
  for (const row of rows.results) {
    const playerId = currentPlayers.get(row.auth_subject);
    if (!playerId) continue;
    if (Number(row.viewer_muted) !== 0) muted.add(playerId);
    if (Number(row.viewer_blocked) !== 0) blocked.add(playerId);
  }
  return {
    mutedPlayerIds: [...muted],
    blockedPlayerIds: [...blocked],
  };
}

async function requireCursor(
  database: D1Database,
  gameId: string,
  cursor: string,
): Promise<CursorRow> {
  const row = await database
    .prepare(
      `SELECT id, created_at FROM game_messages
       WHERE game_id = ? AND id = ? LIMIT 1`,
    )
    .bind(gameId, cursor)
    .first<CursorRow>();
  requireRule(
    row,
    "INVALID_MESSAGE_CURSOR",
    "The message cursor is not valid for this table.",
    400,
  );
  return row;
}

async function replayMessage(
  database: D1Database,
  profileId: string,
  commandId: string,
  now: number,
): Promise<SendTableMessageResult> {
  const row = await findMessageByCommand(database, profileId, commandId);
  requireRule(
    row && Number(row.expires_at) > now,
    "MESSAGE_EXPIRED",
    "That message is no longer available.",
    409,
  );
  return { message: messageDto(row), replayed: true };
}

async function findMessageByCommand(
  database: D1Database,
  profileId: string,
  commandId: string,
): Promise<MessageRow | null> {
  return database
    .prepare(
      `SELECT id, game_id, sender_profile_id, sender_player_id,
              sender_display_name, kind, content_id, command_id,
              created_at, expires_at
       FROM game_messages
       WHERE sender_profile_id = ? AND command_id = ? LIMIT 1`,
    )
    .bind(profileId, commandId)
    .first<MessageRow>();
}

async function findReceipt(
  database: D1Database,
  actorProfileId: string,
  commandId: string,
): Promise<ReceiptRow | null> {
  return database
    .prepare(
      `SELECT actor_profile_id, command_id, game_id, operation, request_hash
       FROM command_receipts
       WHERE actor_profile_id = ? AND command_id = ? LIMIT 1`,
    )
    .bind(actorProfileId, commandId)
    .first<ReceiptRow>();
}

async function findReportByCommand(
  database: D1Database,
  reporterProfileId: string,
  commandId: string,
): Promise<ReportReplayRow | null> {
  return database
    .prepare(
      `SELECT game_id, message_id, reason
       FROM game_message_reports
       WHERE reporter_profile_id = ? AND command_id = ? LIMIT 1`,
    )
    .bind(reporterProfileId, commandId)
    .first<ReportReplayRow>();
}

function assertReceipt(
  receipt: ReceiptRow,
  operation: string,
  requestHash: string,
  gameId: string,
): void {
  requireRule(
    receipt.operation === operation &&
      receipt.request_hash === requestHash &&
      receipt.game_id === gameId,
    "IDEMPOTENCY_KEY_REUSED",
    "That commandId was already used for a different request.",
    409,
  );
}

async function findProfile(
  database: D1Database,
  authSubject: string,
): Promise<ProfileRow | null> {
  return database
    .prepare("SELECT id FROM profiles WHERE auth_subject = ? LIMIT 1")
    .bind(authSubject)
    .first<ProfileRow>();
}

async function enforceCommunicationQuota(
  database: D1Database,
  now: number,
  rules: QuotaRule[],
): Promise<void> {
  for (const rule of rules) {
    const bucketStart = Math.floor(now / rule.windowMs) * rule.windowMs;
    const row = await database
      .prepare(
        `INSERT INTO mutation_quotas (scope, bucket_start, count, expires_at)
         VALUES (?, ?, 1, ?)
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
    if (Number(row?.count ?? 0) > rule.limit) throw rateLimited();
  }
}

function rateLimited(): GameRuleError {
  return new GameRuleError(
    "RATE_LIMITED",
    "Too many communication requests. Please wait and try again.",
    429,
  );
}

function parseStoredState(value: string): GameState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new GameRuleError(
      "CORRUPT_GAME_STATE",
      "Stored game state is invalid.",
      500,
    );
  }
  requireRule(
    parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as Partial<GameState>).players),
    "CORRUPT_GAME_STATE",
    "Stored game state is invalid.",
    500,
  );
  return parsed as GameState;
}

function messageDto(row: MessageRow): TableMessage {
  let normalized: ReturnType<typeof parseCommunicationMessage>;
  try {
    normalized = parseCommunicationMessage(row.kind, row.content_id);
  } catch {
    throw new GameRuleError(
      "CORRUPT_MESSAGE",
      "Stored table communication is invalid.",
      500,
    );
  }
  return {
    id: row.id,
    senderPlayerId: row.sender_player_id,
    senderDisplayName: row.sender_display_name,
    kind: normalized.kind,
    contentId: normalized.contentId,
    createdAt: Number(row.created_at),
  };
}

async function maybeCleanupCommunication(
  database: D1Database,
  now: number,
): Promise<void> {
  if (cleanupPromise) return cleanupPromise;
  if (now - lastCleanupAt < COMMUNICATION_CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  cleanupPromise = cleanupExpiredCommunicationRows(database, now)
    .catch((error) => {
      lastCleanupAt = 0;
      throw error;
    })
    .finally(() => {
      cleanupPromise = null;
    });
  return cleanupPromise;
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
