import { ensureDatabaseSchema } from "../../db/runtime";
import { GameRuleError, requireRule } from "../game/errors";
import type { GameState, PlayerState } from "../game/types";
import type { AuthenticatedUser } from "./auth";
import {
  guardedBlockLiveVoiceCleanupStatement,
  reconcileLiveVoiceCleanupForGame,
} from "./live-voice-cleanup";
import { getLiveVoiceProviderConfig } from "./live-voice-provider";
import {
  assertCommunicationEnabled,
  assertFreeTextEnabled,
  COMMUNICATION_LIMITS,
  createOpaqueCommunicationId,
  parseCommunicationMessage,
  parseFreeTextMessage,
  type CommunicationContentId,
  type CommunicationMessage,
  type CuratedCommunicationMessageKind,
  type ReportReasonId,
} from "./communication-policy";
import { getV15FeaturePolicy } from "./v15-feature-policy";

type TableMessageBase = Readonly<{
  id: string;
  senderPlayerId: string;
  senderDisplayName: string;
  createdAt: number;
}>;

export type TableMessage =
  | (TableMessageBase &
      Readonly<{
        kind: CuratedCommunicationMessageKind;
        contentId: CommunicationContentId;
      }>)
  | (TableMessageBase & Readonly<{ kind: "text"; body: string }>);

export type TableMessagePage = Readonly<{
  messages: TableMessage[];
  nextCursor: string | null;
  serverTime: number;
  viewer: Readonly<{
    mutedPlayerIds: string[];
    blockedPlayerIds: string[];
    capabilities: Readonly<{
      freeText: boolean;
      liveVoice: boolean;
    }>;
  }>;
}>;

export type ListTableMessagesResult = Readonly<{
  page: TableMessagePage;
  /** True when the supplied opaque position no longer belongs to this feed. */
  cursorRebased: boolean;
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
  communication_scope: string;
  expires_at: number;
  profile_id: string | null;
  membership_status: string | null;
  joined_at: number | null;
};

type CurrentMemberContext = {
  gameId: string;
  profileId: string;
  state: GameState;
  player: PlayerState;
  communicationScope: string;
  joinedAt: number;
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
  body_text: string | null;
  command_id: string;
  created_at: number;
  expires_at: number;
};

type ScannedMessageRow = MessageRow & {
  cursor_sequence: number;
  viewer_muted: number;
  pair_blocked: number;
};

type CursorRow = {
  sequence: number;
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
};

type ViewerSafetyRow = {
  profile_id: string;
  auth_subject: string;
  viewer_muted: number;
  viewer_blocked: number;
};

type ViewerSafetyState = Readonly<{
  mutedPlayerIds: string[];
  blockedPlayerIds: string[];
}>;

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
): Promise<ListTableMessagesResult> {
  assertCommunicationEnabled();
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maybeCleanupCommunication(database, now);
  const viewer = await requireCurrentMember(database, user, gameId, now);
  const privateCommunicationAvailable =
    await isInviteOnlyCommunicationAvailable(database, viewer);
  const freeTextAvailable =
    getV15FeaturePolicy().freeTextEnabled && privateCommunicationAvailable;
  const liveVoiceAvailable =
    privateCommunicationAvailable && getLiveVoiceProviderConfig() !== null;
  const cursorRow = cursor
    ? await findCursor(database, gameId, cursor, viewer.joinedAt)
    : null;
  const cursorRebased = cursor !== null && cursorRow === null;

  const query = cursorRow
    ? database.prepare(
        `SELECT message.id, message.game_id, message.sender_profile_id,
                message.sender_player_id, message.sender_display_name,
                message.kind, message.content_id, message.body_text,
                message.command_id,
                message.created_at, message.expires_at,
                position.sequence AS cursor_sequence,
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
         JOIN game_message_cursors position
           ON position.cursor_id = message.id
          AND position.game_id = message.game_id
         JOIN game_members sender
           ON sender.game_id = message.game_id
          AND sender.profile_id = message.sender_profile_id
          AND sender.status <> 'left'
         WHERE message.game_id = ? AND message.expires_at > ?
           AND message.created_at > ?
           AND (? = 1 OR message.kind <> 'text')
           AND position.sequence > ?
         ORDER BY position.sequence
         LIMIT ?`,
      )
        .bind(
          viewer.profileId,
          viewer.profileId,
          viewer.profileId,
          gameId,
          now,
          viewer.joinedAt,
          freeTextAvailable ? 1 : 0,
          cursorRow.sequence,
          COMMUNICATION_LIMITS.messageScanLimit,
        )
    : database.prepare(
        `SELECT message.id, message.game_id, message.sender_profile_id,
                message.sender_player_id, message.sender_display_name,
                message.kind, message.content_id, message.body_text,
                message.command_id,
                message.created_at, message.expires_at,
                position.sequence AS cursor_sequence,
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
         JOIN game_message_cursors position
           ON position.cursor_id = message.id
          AND position.game_id = message.game_id
         JOIN game_members sender
           ON sender.game_id = message.game_id
          AND sender.profile_id = message.sender_profile_id
          AND sender.status <> 'left'
         WHERE message.game_id = ? AND message.expires_at > ?
           AND message.created_at > ?
           AND (? = 1 OR message.kind <> 'text')
         ORDER BY position.sequence DESC
         LIMIT ?`,
      ).bind(
        viewer.profileId,
        viewer.profileId,
        viewer.profileId,
        gameId,
        now,
        viewer.joinedAt,
        freeTextAvailable ? 1 : 0,
        COMMUNICATION_LIMITS.messageScanLimit,
      );

  const scanned = await query.all<ScannedMessageRow>();
  // Initial loads and explicit cursor rebases scan backward for the newest
  // bounded window, then restore commit order for the UI and receipt writer.
  const scannedRows = cursorRow
    ? scanned.results
    : [...scanned.results].reverse();
  const safety = await readViewerSafetyState(database, viewer);
  const visibleRows = scannedRows.filter(
    (message) =>
      Number(message.viewer_muted) === 0 &&
      Number(message.pair_blocked) === 0,
  );
  const messages = visibleRows.map(messageDto);
  await recordMessageReceipts(
    database,
    user,
    viewer,
    visibleRows,
    now,
    freeTextAvailable,
  );
  return {
    cursorRebased,
    page: {
      messages,
      nextCursor: scannedRows.at(-1)?.id ?? (cursorRow ? cursor : null),
      serverTime: now,
      viewer: {
        ...safety,
        capabilities: {
          freeText: freeTextAvailable,
          liveVoice: liveVoiceAvailable,
        },
      },
    },
  };
}

export async function sendTableMessage(
  user: AuthenticatedUser,
  gameId: string,
  commandId: string,
  message: CommunicationMessage,
): Promise<SendTableMessageResult> {
  assertCommunicationEnabled();
  const normalized =
    message.kind === "text"
      ? parseFreeTextMessage(message.body)
      : parseCommunicationMessage(message.kind, message.contentId);
  if (normalized.kind === "text") assertFreeTextEnabled();
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  await maybeCleanupCommunication(database, now);
  const actor = await requireCurrentMember(database, user, gameId, now);
  const requestHash = await hashText(
    JSON.stringify({
      operation: MESSAGE_OPERATION,
      gameId,
      kind: normalized.kind,
      ...(normalized.kind === "text"
        ? { body: normalized.body }
        : { contentId: normalized.contentId }),
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
  if (normalized.kind === "text") {
    await requireFreeTextAvailable(database, actor);
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
              AND (
                ? = 0 OR (
                  game.communication_scope = 'invite_only'
                  AND NOT EXISTS (
                    SELECT 1 FROM game_members communication_member
                    WHERE communication_member.game_id = game.id
                      AND communication_member.status <> 'left'
                      AND COALESCE(communication_member.join_source, '')
                        NOT IN ('host', 'invite')
                  )
                )
              )
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
          normalized.kind === "text" ? 1 : 0,
          now - COMMUNICATION_LIMITS.messageCooldownMs,
        ),
      database
        .prepare(
          `INSERT INTO game_message_cursors (
             cursor_id, game_id, created_at
           )
           SELECT ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM command_receipts
             WHERE actor_profile_id = ? AND command_id = ?
               AND game_id = ? AND operation = ? AND request_hash = ?
           )`,
        )
        .bind(
          messageId,
          gameId,
          now,
          actor.profileId,
          commandId,
          gameId,
          MESSAGE_OPERATION,
          requestHash,
        ),
      database
        .prepare(
          `INSERT INTO game_messages (
            id, game_id, sender_profile_id, sender_player_id,
            sender_display_name, kind, content_id, command_id,
            body_text, created_at, expires_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM command_receipts
            WHERE actor_profile_id = ? AND command_id = ?
              AND game_id = ? AND operation = ? AND request_hash = ?
          ) AND EXISTS (
            SELECT 1 FROM game_message_cursors position
            WHERE position.cursor_id = ? AND position.game_id = ?
          )`,
        )
        .bind(
          messageId,
          gameId,
          actor.profileId,
          actor.player.playerId,
          actor.player.displayName,
          normalized.kind,
          normalized.kind === "text" ? "" : normalized.contentId,
          commandId,
          normalized.kind === "text" ? normalized.body : null,
          now,
          expiresAt,
          actor.profileId,
          commandId,
          gameId,
          MESSAGE_OPERATION,
          requestHash,
          messageId,
          gameId,
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
  const currentActor = await requireCurrentMember(database, user, gameId, now);
  if (normalized.kind === "text") {
    await requireFreeTextAvailable(database, currentActor);
  }
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
      existingReport.message_id,
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
          JOIN profiles profile ON profile.id = ? AND profile.auth_subject = ?
          WHERE message.id = ? AND message.expires_at > ?
            AND message.sender_profile_id <> profile.id
            AND (
              EXISTS (
                SELECT 1
                FROM games game
                JOIN game_members viewer
                  ON viewer.game_id = game.id
                 AND viewer.profile_id = profile.id
                 AND viewer.status <> 'left'
                WHERE game.id = message.game_id
                  AND game.room_status = 'open' AND game.expires_at > ?
              ) OR EXISTS (
                SELECT 1 FROM game_message_receipts receipt
                WHERE receipt.game_id = message.game_id
                  AND receipt.message_id = message.id
                  AND receipt.recipient_profile_id = profile.id
                  AND receipt.expires_at > ?
              )
            )`,
        )
        .bind(
          target.reporter_profile_id,
          commandId,
          REPORT_OPERATION,
          requestHash,
          now,
          target.reporter_profile_id,
          user.userId,
          messageId,
          now,
          now,
          now,
        ),
      database
        .prepare(
          `INSERT INTO game_message_reports (
            id, game_id, message_id, reporter_profile_id,
            reported_profile_id, evidence_sender_player_id,
            evidence_sender_display_name, evidence_kind,
            evidence_content_id, evidence_body_text, evidence_created_at, reason,
            moderation_state, command_id, created_at, expires_at
          )
          SELECT ?, message.game_id, message.id, ?,
                 message.sender_profile_id, message.sender_player_id,
                 message.sender_display_name, message.kind,
                 message.content_id, message.body_text, message.created_at, ?,
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
  if (blocked) await reconcileLiveVoiceCleanupForGame(gameId);
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
        `DELETE FROM game_message_cursors WHERE rowid IN (
          SELECT position.rowid
          FROM game_message_cursors position
          LEFT JOIN games game ON game.id = position.game_id
          WHERE game.id IS NULL OR game.expires_at <= ?
          ORDER BY position.sequence LIMIT ?
        )`,
      )
      .bind(now, COMMUNICATION_LIMITS.cleanupBatchSize),
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
        `DELETE FROM game_message_receipts WHERE rowid IN (
          SELECT rowid FROM game_message_receipts
          WHERE expires_at <= ?
          ORDER BY expires_at, recipient_profile_id, message_id LIMIT ?
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

async function isInviteOnlyCommunicationAvailable(
  database: D1Database,
  viewer: CurrentMemberContext,
): Promise<boolean> {
  if (viewer.communicationScope !== "invite_only") return false;
  const invalidMember = await database
    .prepare(
      `SELECT 1 AS present
       FROM game_members
       WHERE game_id = ? AND status <> 'left'
         AND COALESCE(join_source, '') NOT IN ('host', 'invite')
       LIMIT 1`,
    )
    .bind(viewer.gameId)
    .first<{ present: number }>();
  return !invalidMember;
}

async function requireFreeTextAvailable(
  database: D1Database,
  viewer: CurrentMemberContext,
): Promise<void> {
  assertFreeTextEnabled();
  requireRule(
    await isInviteOnlyCommunicationAvailable(database, viewer),
    "FREE_TEXT_UNAVAILABLE",
    "Free-text chat is available only at private invite-only tables.",
    403,
  );
}

async function recordMessageReceipts(
  database: D1Database,
  user: AuthenticatedUser,
  viewer: CurrentMemberContext,
  messages: ScannedMessageRow[],
  now: number,
  freeTextAvailable: boolean,
): Promise<void> {
  const received = messages.filter(
    (message) => message.sender_profile_id !== viewer.profileId,
  );
  if (!received.length) return;
  await database.batch(
    received.map((message) =>
      database
        .prepare(
          `INSERT OR IGNORE INTO game_message_receipts (
             game_id, message_id, recipient_profile_id, received_at, expires_at
           )
           SELECT message.game_id, message.id, recipient.id, ?, message.expires_at
           FROM game_messages message
           JOIN games game ON game.id = message.game_id
           JOIN profiles recipient ON recipient.id = ? AND recipient.auth_subject = ?
           JOIN game_members recipient_member
             ON recipient_member.game_id = message.game_id
            AND recipient_member.profile_id = recipient.id
            AND recipient_member.status <> 'left'
           JOIN game_members sender_member
             ON sender_member.game_id = message.game_id
            AND sender_member.profile_id = message.sender_profile_id
            AND sender_member.status <> 'left'
           WHERE message.id = ? AND message.game_id = ?
             AND message.expires_at > ?
             AND message.created_at > recipient_member.joined_at
             AND game.room_status = 'open' AND game.expires_at > ?
             AND message.sender_profile_id <> recipient.id
             AND (? = 1 OR message.kind <> 'text')
             AND NOT EXISTS (
               SELECT 1 FROM game_mutes mute
               WHERE mute.game_id = message.game_id
                 AND mute.muter_profile_id = recipient.id
                 AND mute.muted_profile_id = message.sender_profile_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM profile_blocks block
               WHERE (
                 block.blocker_profile_id = recipient.id
                 AND block.blocked_profile_id = message.sender_profile_id
               ) OR (
                 block.blocker_profile_id = message.sender_profile_id
                 AND block.blocked_profile_id = recipient.id
               )
             )`,
        )
        .bind(
          now,
          viewer.profileId,
          user.userId,
          message.id,
          viewer.gameId,
          now,
          now,
          freeTextAvailable ? 1 : 0,
        ),
    ),
  );
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
  const voiceCleanupStatements = relationship === "block" && enabled
    ? [actor.player.playerId, target.player.playerId].map((playerId) =>
        guardedBlockLiveVoiceCleanupStatement(
          database,
          { kind: "participant", gameId, playerId },
          {
            blockerProfileId: actor.profileId,
            blockedProfileId: target.profileId,
            blockerAuthSubject: user.userId,
            now,
          },
        )
      )
    : [];
  if (currentlyEnabled === enabled) {
    if (voiceCleanupStatements.length) {
      await database.batch(voiceCleanupStatements);
    }
    return;
  }
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
  if (voiceCleanupStatements.length) {
    await database.batch([statement, ...voiceCleanupStatements]);
  } else {
    await statement.run();
  }

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
      `SELECT game.id, game.state_json, game.room_status,
              game.communication_scope, game.expires_at,
              profile.id AS profile_id, member.status AS membership_status,
              member.joined_at
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
  return {
    gameId,
    profileId: row.profile_id,
    state,
    player,
    communicationScope: row.communication_scope,
    joinedAt: Number(row.joined_at),
  };
}

async function requireReportReplayAccess(
  database: D1Database,
  user: AuthenticatedUser,
  messageId: string,
  now: number,
): Promise<void> {
  const row = await database
    .prepare(
      `SELECT 1 AS present
       FROM game_messages message
       JOIN profiles profile ON profile.auth_subject = ?
       WHERE message.id = ? AND message.expires_at > ?
         AND (
           EXISTS (
             SELECT 1
             FROM games game
             JOIN game_members member
               ON member.game_id = game.id
              AND member.profile_id = profile.id
              AND member.status <> 'left'
             WHERE game.id = message.game_id
               AND game.room_status = 'open' AND game.expires_at > ?
           ) OR EXISTS (
             SELECT 1 FROM game_message_receipts receipt
             WHERE receipt.game_id = message.game_id
               AND receipt.message_id = message.id
               AND receipt.recipient_profile_id = profile.id
               AND receipt.expires_at > ?
           )
         )
       LIMIT 1`,
    )
    .bind(user.userId, messageId, now, now, now)
    .first<{ present: number }>();
  requireRule(
    row,
    "CHAT_MESSAGE_NOT_FOUND",
    "That message is no longer available.",
    404,
  );
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
              message.kind, message.content_id, message.body_text,
              message.command_id,
              message.created_at, message.expires_at,
              viewer_profile.id AS reporter_profile_id
       FROM game_messages message
       JOIN profiles viewer_profile ON viewer_profile.auth_subject = ?
       WHERE message.id = ? AND message.expires_at > ?
         AND (
           EXISTS (
             SELECT 1
             FROM games game
             JOIN game_members viewer_member
               ON viewer_member.game_id = game.id
              AND viewer_member.profile_id = viewer_profile.id
              AND viewer_member.status <> 'left'
             WHERE game.id = message.game_id
               AND game.room_status = 'open' AND game.expires_at > ?
           ) OR EXISTS (
             SELECT 1 FROM game_message_receipts receipt
             WHERE receipt.game_id = message.game_id
               AND receipt.message_id = message.id
               AND receipt.recipient_profile_id = viewer_profile.id
               AND receipt.expires_at > ?
           )
         )
       LIMIT 1`,
    )
    .bind(actorUserId, messageId, now, now, now)
    .first<ReportTargetRow>();
  requireRule(
    row,
    "CHAT_MESSAGE_NOT_FOUND",
    "That message is no longer available.",
    404,
  );
  return row;
}

async function readViewerSafetyState(
  database: D1Database,
  viewer: CurrentMemberContext,
): Promise<ViewerSafetyState> {
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

async function findCursor(
  database: D1Database,
  gameId: string,
  cursor: string,
  joinedAt: number,
): Promise<CursorRow | null> {
  return database
    .prepare(
      `SELECT sequence FROM game_message_cursors
       WHERE game_id = ? AND cursor_id = ? AND created_at > ? LIMIT 1`,
    )
    .bind(gameId, cursor, joinedAt)
    .first<CursorRow>();
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
              sender_display_name, kind, content_id, body_text, command_id,
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
  const base = {
    id: row.id,
    senderPlayerId: row.sender_player_id,
    senderDisplayName: row.sender_display_name,
    createdAt: Number(row.created_at),
  };
  try {
    if (row.kind === "text") {
      requireRule(
        row.content_id === "" && row.body_text !== null,
        "CORRUPT_MESSAGE",
        "Stored table communication is invalid.",
        500,
      );
      const normalized = parseFreeTextMessage(row.body_text);
      return { ...base, kind: "text", body: normalized.body };
    }
    requireRule(
      row.body_text === null,
      "CORRUPT_MESSAGE",
      "Stored table communication is invalid.",
      500,
    );
    const normalized = parseCommunicationMessage(row.kind, row.content_id);
    return {
      ...base,
      kind: normalized.kind,
      contentId: normalized.contentId,
    };
  } catch {
    throw new GameRuleError(
      "CORRUPT_MESSAGE",
      "Stored table communication is invalid.",
      500,
    );
  }
}

async function maybeCleanupCommunication(
  database: D1Database,
  now: number,
): Promise<void> {
  if (cleanupPromise) return cleanupPromise;
  if (now - lastCleanupAt < COMMUNICATION_CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  cleanupPromise = cleanupExpiredCommunicationRows(database, now)
    .catch(() => {
      lastCleanupAt = 0;
      // Retention maintenance is best-effort on the request path. A transient
      // D1 cleanup failure must not take down an otherwise valid chat read,
      // send, report, mute, or block operation; the next request retries it.
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
