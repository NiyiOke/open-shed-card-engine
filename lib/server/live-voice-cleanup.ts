import {
  endLiveVoiceRoom,
  getLiveVoiceAdminConfig,
  liveVoiceRevocationProtectionUntil,
  revokeLiveVoiceParticipant,
} from "./live-voice-provider";
import { createRequestMaintenanceGate } from "./request-maintenance";

export type LiveVoiceCleanupTarget =
  | Readonly<{ kind: "room"; gameId: string }>
  | Readonly<{ kind: "participant"; gameId: string; playerId: string }>;

type CleanupJobRow = {
  job_key: string;
  kind: string;
  game_id: string;
  player_id: string | null;
  requested_at: number;
  attempt_count: number;
};

export type LiveVoiceCleanupResult = Readonly<{
  processed: number;
  succeeded: number;
  failed: number;
}>;

const CLEANUP_JOB_RETENTION_MS = 7 * 24 * 60 * 60_000;
const CLEANUP_RETRY_BASE_MS = 5_000;
const CLEANUP_RETRY_MAX_MS = 60 * 60_000;
const CLEANUP_RECONCILE_INTERVAL_MS = 15_000;
const CLEANUP_RECONCILE_LIMIT = 8;
const CLEANUP_PROVIDER_DEADLINE_MS = 1_500;

// Share only the cadence timestamp across requests. Provider/D1 promises stay
// owned by the request that started them so cancellation cannot poison an
// isolate-wide in-flight cache.
const cleanupReconcileGate = createRequestMaintenanceGate(
  CLEANUP_RECONCILE_INTERVAL_MS,
);

/**
 * Enqueues media cleanup inside the same D1 batch as a durable command.
 * The exact receipt guard prevents a cleanup request from outliving a failed
 * game mutation.
 */
export function guardedCommandLiveVoiceCleanupStatement(
  database: D1Database,
  target: LiveVoiceCleanupTarget,
  guard: Readonly<{
    actorProfileId: string;
    commandId: string;
    operation: string;
    requestHash: string;
    now: number;
  }>,
): D1PreparedStatement {
  return database
    .prepare(
      `${cleanupJobUpsertSql(`EXISTS (
        SELECT 1 FROM command_receipts receipt
        WHERE receipt.actor_profile_id = ? AND receipt.command_id = ?
          AND receipt.game_id = ? AND receipt.operation = ?
          AND receipt.request_hash = ?
      )`)}`,
    )
    .bind(
      ...cleanupJobValues(target, guard.now),
      guard.actorProfileId,
      guard.commandId,
      target.gameId,
      guard.operation,
      guard.requestHash,
    );
}

/** Enqueues a lifecycle cleanup only if its exact room-closure event exists. */
export function guardedEventLiveVoiceCleanupStatement(
  database: D1Database,
  target: LiveVoiceCleanupTarget,
  guard: Readonly<{
    version: number;
    commandId: string;
    stateHash: string;
    now: number;
  }>,
): D1PreparedStatement {
  return database
    .prepare(
      `${cleanupJobUpsertSql(`EXISTS (
        SELECT 1 FROM game_events event
        WHERE event.game_id = ? AND event.version = ?
          AND event.command_id = ? AND event.state_hash = ?
          AND event.kind = 'room_closed'
      )`)}`,
    )
    .bind(
      ...cleanupJobValues(target, guard.now),
      target.gameId,
      guard.version,
      guard.commandId,
      guard.stateHash,
    );
}

/**
 * Records a cleanup fallback for a token that was minted but failed its final
 * eligibility read. The token is never returned before this durable write.
 */
export async function enqueueLiveVoiceCleanupTargets(
  database: D1Database,
  targets: ReadonlyArray<LiveVoiceCleanupTarget>,
  now: number,
): Promise<void> {
  if (!targets.length) return;
  await database.batch(
    targets.map((target) =>
      database
        .prepare(cleanupJobUpsertSql("1 = 1"))
        .bind(...cleanupJobValues(target, now)),
    ),
  );
}

/**
 * Expired open games may be purged without first entering lifecycle closure.
 * These statements snapshot the room and every validated state player into
 * the independent outbox before any game-owned rows can be deleted.
 */
export function expiredGameLiveVoiceCleanupStatements(
  database: D1Database,
  now: number,
): D1PreparedStatement[] {
  const expiresAt = now + CLEANUP_JOB_RETENTION_MS;
  return [
    database
      .prepare(
        `INSERT INTO live_voice_cleanup_jobs (
          job_key, kind, game_id, player_id, requested_at,
          next_attempt_at, attempt_count, expires_at
        )
        SELECT 'room:' || game.id, 'room', game.id, NULL, ?, ?, 0, ?
        FROM games game
        WHERE game.room_status = 'open' AND game.expires_at <= ?
        ON CONFLICT(job_key) DO NOTHING`,
      )
      .bind(now, now, expiresAt, now),
    database
      .prepare(
        `INSERT INTO live_voice_cleanup_jobs (
          job_key, kind, game_id, player_id, requested_at,
          next_attempt_at, attempt_count, expires_at
        )
        SELECT 'participant:' || game.id || ':' ||
                 json_extract(player.value, '$.playerId'),
               'participant', game.id,
               json_extract(player.value, '$.playerId'), ?, ?, 0, ?
        FROM games game
        JOIN json_each(
          CASE WHEN json_valid(game.state_json) THEN game.state_json
               ELSE '{"players":[]}' END,
          '$.players'
        ) player
        WHERE game.room_status = 'open' AND game.expires_at <= ?
          AND typeof(json_extract(player.value, '$.playerId')) = 'text'
          AND length(json_extract(player.value, '$.playerId')) BETWEEN 1 AND 100
          AND json_extract(player.value, '$.playerId')
                NOT GLOB '*[^A-Za-z0-9_-]*'
        ON CONFLICT(job_key) DO NOTHING`,
      )
      .bind(now, now, expiresAt, now),
  ];
}

/** A pending job is also an issuance barrier until its revocation cutoff. */
export async function hasPendingLiveVoiceCleanup(
  database: D1Database,
  gameId: string,
  playerId: string,
  now: number,
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT 1 AS present
       FROM live_voice_cleanup_jobs
       WHERE game_id = ? AND expires_at > ?
         AND (kind = 'room' OR (kind = 'participant' AND player_id = ?))
       LIMIT 1`,
    )
    .bind(gameId, now, playerId)
    .first<{ present: number }>();
  return Boolean(row);
}

/**
 * Enqueues one side of a bilateral disconnect after an authenticated block.
 * The block and both active memberships must still exist in the same batch.
 */
export function guardedBlockLiveVoiceCleanupStatement(
  database: D1Database,
  target: Extract<LiveVoiceCleanupTarget, { kind: "participant" }>,
  guard: Readonly<{
    blockerProfileId: string;
    blockedProfileId: string;
    blockerAuthSubject: string;
    now: number;
  }>,
): D1PreparedStatement {
  return database
    .prepare(
      `${cleanupJobUpsertSql(`EXISTS (
        SELECT 1
        FROM profile_blocks block
        JOIN profiles blocker ON blocker.id = block.blocker_profile_id
        JOIN games game ON game.id = ?
        JOIN game_members blocker_member
          ON blocker_member.game_id = game.id
         AND blocker_member.profile_id = block.blocker_profile_id
         AND blocker_member.status <> 'left'
        JOIN game_members blocked_member
          ON blocked_member.game_id = game.id
         AND blocked_member.profile_id = block.blocked_profile_id
         AND blocked_member.status <> 'left'
        WHERE block.blocker_profile_id = ?
          AND block.blocked_profile_id = ?
          AND blocker.auth_subject = ?
          AND game.room_status = 'open' AND game.expires_at > ?
      )`)}`,
    )
    .bind(
      ...cleanupJobValues(target, guard.now),
      target.gameId,
      guard.blockerProfileId,
      guard.blockedProfileId,
      guard.blockerAuthSubject,
      guard.now,
    );
}

/**
 * Runs due provider administration without exposing an administrative route.
 * Provider failures are converted into bounded exponential retries.
 */
export async function reconcileLiveVoiceCleanupJobs(
  database: D1Database,
  options: Readonly<{
    gameId?: string;
    now?: number;
    limit?: number;
  }> = {},
): Promise<LiveVoiceCleanupResult> {
  const now = options.now ?? Date.now();
  const limit = Math.max(
    1,
    Math.min(CLEANUP_RECONCILE_LIMIT, options.limit ?? CLEANUP_RECONCILE_LIMIT),
  );
  await database
    .prepare(
      `DELETE FROM live_voice_cleanup_jobs WHERE rowid IN (
        SELECT rowid FROM live_voice_cleanup_jobs
        WHERE expires_at <= ?
        ORDER BY expires_at, job_key LIMIT 64
      )`,
    )
    .bind(now)
    .run();

  // Keep jobs durable while provider credentials are absent. Rollout flags do
  // not participate in this administrative configuration check.
  if (!getLiveVoiceAdminConfig()) return emptyCleanupResult();

  const query = options.gameId
    ? database
        .prepare(
          `SELECT job_key, kind, game_id, player_id, requested_at, attempt_count
           FROM live_voice_cleanup_jobs
           WHERE game_id = ? AND next_attempt_at <= ? AND expires_at > ?
           ORDER BY CASE kind WHEN 'room' THEN 0 ELSE 1 END,
                    next_attempt_at, job_key
           LIMIT ?`,
        )
        .bind(options.gameId, now, now, limit)
    : database
        .prepare(
          `SELECT job_key, kind, game_id, player_id, requested_at, attempt_count
           FROM live_voice_cleanup_jobs
           WHERE next_attempt_at <= ? AND expires_at > ?
           ORDER BY next_attempt_at, job_key
           LIMIT ?`,
        )
        .bind(now, now, limit);
  const rows = await query.all<CleanupJobRow>();
  let succeeded = 0;
  let failed = 0;
  const outcomes = await Promise.all(
    rows.results.map(async (row) => ({
      row,
      providerConfirmed: row.attempt_count === -1,
      success:
        row.attempt_count === -1
          ? true
          : await executeCleanupJobWithDeadline(row),
    })),
  );

  for (const { row, providerConfirmed, success } of outcomes) {
    if (providerConfirmed) {
      await database
        .prepare(
          `DELETE FROM live_voice_cleanup_jobs
           WHERE job_key = ? AND requested_at = ? AND attempt_count = -1`,
        )
        .bind(row.job_key, row.requested_at)
        .run();
      succeeded += 1;
      continue;
    }
    if (success) {
      const protectionUntil = liveVoiceRevocationProtectionUntil(
        now,
      );
      await database
        .prepare(
          `UPDATE live_voice_cleanup_jobs
           SET attempt_count = -1, next_attempt_at = ?
           WHERE job_key = ? AND requested_at = ? AND attempt_count = ?`,
        )
        .bind(
          protectionUntil,
          row.job_key,
          row.requested_at,
          row.attempt_count,
        )
        .run();
      succeeded += 1;
      continue;
    }
    await database
      .prepare(
        `UPDATE live_voice_cleanup_jobs
         SET attempt_count = attempt_count + 1, next_attempt_at = ?
         WHERE job_key = ? AND requested_at = ?`,
      )
      .bind(
        now + cleanupRetryDelayMs(row.attempt_count),
        row.job_key,
        row.requested_at,
      )
      .run();
    failed += 1;
  }

  return Object.freeze({
    processed: rows.results.length,
    succeeded,
    failed,
  });
}

/** Bounded request-driven reconciliation used by ordinary room maintenance. */
export async function maybeReconcileLiveVoiceCleanupJobs(
  database: D1Database,
  now: number,
): Promise<LiveVoiceCleanupResult> {
  try {
    const run = await cleanupReconcileGate.run(now, () =>
      reconcileLiveVoiceCleanupJobs(database, { now }),
    );
    return run.started ? run.value : emptyCleanupResult();
  } catch {
    return emptyCleanupResult();
  }
}

/** Route-safe helper: cleanup failures never rewrite a successful mutation. */
export async function reconcileLiveVoiceCleanupForGame(
  gameId: string,
): Promise<LiveVoiceCleanupResult> {
  try {
    const { ensureDatabaseSchema } = await import("../../db/runtime");
    const database = await ensureDatabaseSchema();
    return await reconcileLiveVoiceCleanupJobs(database, { gameId });
  } catch {
    return emptyCleanupResult();
  }
}

function cleanupJobUpsertSql(guardSql: string): string {
  return `INSERT INTO live_voice_cleanup_jobs (
      job_key, kind, game_id, player_id, requested_at,
      next_attempt_at, attempt_count, expires_at
    )
    SELECT ?, ?, ?, ?, ?, ?, 0, ?
    WHERE ${guardSql}
    ON CONFLICT(job_key) DO UPDATE SET
      kind = excluded.kind,
      game_id = excluded.game_id,
      player_id = excluded.player_id,
      requested_at = MAX(
        live_voice_cleanup_jobs.requested_at,
        excluded.requested_at
      ),
      next_attempt_at = MIN(
        live_voice_cleanup_jobs.next_attempt_at,
        excluded.next_attempt_at
      ),
      attempt_count = 0,
      expires_at = MAX(
        live_voice_cleanup_jobs.expires_at,
        excluded.expires_at
      )`;
}

function cleanupJobValues(
  target: LiveVoiceCleanupTarget,
  now: number,
): [string, string, string, string | null, number, number, number] {
  return [
    cleanupJobKey(target),
    target.kind,
    target.gameId,
    target.kind === "participant" ? target.playerId : null,
    now,
    now,
    now + CLEANUP_JOB_RETENTION_MS,
  ];
}

function cleanupJobKey(target: LiveVoiceCleanupTarget): string {
  return target.kind === "room"
    ? `room:${target.gameId}`
    : `participant:${target.gameId}:${target.playerId}`;
}

async function executeCleanupJob(row: CleanupJobRow): Promise<boolean> {
  if (
    !row.game_id ||
    (row.kind !== "room" && row.kind !== "participant") ||
    (row.kind === "room" && row.player_id !== null) ||
    (row.kind === "participant" &&
      (row.player_id === null ||
        !/^[A-Za-z0-9_-]{1,100}$/u.test(row.player_id)))
  ) {
    return false;
  }
  return row.kind === "room"
    ? endLiveVoiceRoom(row.game_id)
    : revokeLiveVoiceParticipant(row.game_id, row.player_id!);
}

async function executeCleanupJobWithDeadline(
  row: CleanupJobRow,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      executeCleanupJob(row),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), CLEANUP_PROVIDER_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function cleanupRetryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(10, Number(attemptCount) || 0));
  return Math.min(
    CLEANUP_RETRY_MAX_MS,
    CLEANUP_RETRY_BASE_MS * 2 ** exponent,
  );
}

function emptyCleanupResult(): LiveVoiceCleanupResult {
  return Object.freeze({ processed: 0, succeeded: 0, failed: 0 });
}
