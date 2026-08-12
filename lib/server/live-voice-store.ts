import { GameRuleError, requireRule } from "../game/errors";
import type { AuthenticatedUser } from "./auth";
import {
  enqueueLiveVoiceCleanupTargets,
  hasPendingLiveVoiceCleanup,
  reconcileLiveVoiceCleanupJobs,
} from "./live-voice-cleanup";
import {
  createLiveVoiceToken,
  getLiveVoiceProviderConfig,
  opaqueVoiceName,
  revokeLiveVoiceParticipant,
  type LiveVoiceProviderConfig,
  type LiveVoiceToken,
} from "./live-voice-provider";

type VoiceMemberRow = {
  profile_id: string;
  auth_subject: string;
  join_source: string | null;
  actor: number;
};

type VoiceRoomRow = {
  id: string;
  room_status: string;
  status: string;
  communication_scope: string;
  state_json: string;
  expires_at: number;
};

type VoiceParticipant = Readonly<{
  identity: string;
  playerId: string;
  displayName: string;
}>;

type LiveVoiceEligibility = Readonly<{
  actorProfileId: string;
  actorPlayerId: string;
  participantIdentity: string;
  participants: ReadonlyArray<VoiceParticipant>;
}>;

/** @internal Test seams; production callers use the two-argument form. */
export type LiveVoiceSessionDependencies = Readonly<{
  database?: D1Database;
  provider?: LiveVoiceProviderConfig;
  now?: () => number;
  mintToken?: typeof createLiveVoiceToken;
  cleanupRejectedMint?: (
    database: D1Database,
    gameId: string,
    playerId: string,
    issuedAt: number,
  ) => Promise<void>;
}>;

export type LiveVoiceSession = Readonly<{
  provider: "livekit";
  serverUrl: string;
  token: string;
  expiresAt: number;
  participantIdentity: string;
  participants: ReadonlyArray<VoiceParticipant>;
}>;

export async function createLiveVoiceSession(
  user: AuthenticatedUser,
  gameId: string,
  dependencies: LiveVoiceSessionDependencies = {},
): Promise<LiveVoiceSession> {
  const provider = dependencies.provider ?? getLiveVoiceProviderConfig();
  if (!provider) throwVoiceUnavailable();

  const database = dependencies.database ?? await productionDatabase();
  const clock = dependencies.now ?? Date.now;
  const issuedAt = clock();
  const initial = await readLiveVoiceEligibility(
    database,
    user,
    gameId,
    issuedAt,
  );
  await enforceVoiceSessionQuota(database, issuedAt, [
    { scope: `user:${initial.actorProfileId}:live-voice`, limit: 10 },
    { scope: `room:${gameId}:live-voice`, limit: 30 },
  ]);

  const roomName = await opaqueVoiceName("room", gameId);
  const mintToken = dependencies.mintToken ?? createLiveVoiceToken;
  const access = await mintToken(provider, {
    roomName,
    participantIdentity: initial.participantIdentity,
    now: issuedAt,
  });

  let finalEligibility: LiveVoiceEligibility;
  try {
    finalEligibility = await readLiveVoiceEligibility(
      database,
      user,
      gameId,
      clock(),
    );
    requireRule(
      finalEligibility.actorPlayerId === initial.actorPlayerId &&
        finalEligibility.participantIdentity === initial.participantIdentity,
      "LIVE_VOICE_UNAVAILABLE",
      "Live voice is temporarily unavailable for this table.",
      409,
    );
  } catch (error) {
    const cleanupRejectedMint =
      dependencies.cleanupRejectedMint ?? cleanupMintedParticipant;
    await cleanupRejectedMint(
      database,
      gameId,
      initial.actorPlayerId,
      issuedAt,
    ).catch(() => undefined);
    throw error;
  }

  return liveVoiceSession(provider, access, finalEligibility);
}

async function productionDatabase(): Promise<D1Database> {
  const { ensureDatabaseSchema } = await import("../../db/runtime");
  return ensureDatabaseSchema();
}

async function readLiveVoiceEligibility(
  database: D1Database,
  user: AuthenticatedUser,
  gameId: string,
  now: number,
): Promise<LiveVoiceEligibility> {
  const room = await database
    .prepare(
      `SELECT id, room_status, status, communication_scope, state_json, expires_at
       FROM games
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(gameId)
    .first<VoiceRoomRow>();
  requireRule(room, "NOT_A_MEMBER", "You are not a member of this game.", 403);
  requireRule(
    room.room_status === "open" && room.expires_at > now,
    "ROOM_CLOSED",
    "This room is closed.",
    410,
  );
  requireRule(
    room.communication_scope === "invite_only",
    "LIVE_VOICE_PRIVATE_ONLY",
    "Live voice is available only in invite-only tables.",
    409,
  );

  const members = await database
    .prepare(
      `SELECT m.profile_id, p.auth_subject, m.join_source,
              CASE WHEN p.auth_subject = ? THEN 1 ELSE 0 END AS actor
       FROM game_members m
       JOIN profiles p ON p.id = m.profile_id
       WHERE m.game_id = ?
         AND m.status <> 'left'
       ORDER BY m.seat, m.profile_id`,
    )
    .bind(user.userId, gameId)
    .all<VoiceMemberRow>();
  const activeMembers = members.results ?? [];
  const actor = activeMembers.find((member) => Number(member.actor) === 1);
  requireRule(actor, "NOT_A_MEMBER", "You are not a member of this game.", 403);
  requireRule(
    activeMembers.every(
      (member) => member.join_source === "host" || member.join_source === "invite",
    ),
    "LIVE_VOICE_PRIVATE_ONLY",
    "Live voice is available only in invite-only tables.",
    409,
  );

  const statePlayers = parseActiveVoicePlayers(room.state_json);
  requireRule(
    statePlayers &&
      statePlayers.size === activeMembers.length &&
      activeMembers.every((member) => statePlayers.has(member.auth_subject)),
    "VOICE_SESSION_FAILED",
    "The voice participant list is inconsistent.",
    500,
  );
  const actorState = statePlayers.get(user.userId);
  requireRule(
    actorState,
    "NOT_A_MEMBER",
    "You are not a member of this game.",
    403,
  );

  const blocked = await database
    .prepare(
      `SELECT 1 AS blocked
       FROM profile_blocks b
       JOIN game_members other
         ON other.game_id = ?
        AND other.status <> 'left'
       WHERE other.profile_id <> ?
         AND (
           (b.blocker_profile_id = ? AND b.blocked_profile_id = other.profile_id)
           OR
           (b.blocked_profile_id = ? AND b.blocker_profile_id = other.profile_id)
         )
       LIMIT 1`,
    )
    .bind(gameId, actor.profile_id, actor.profile_id, actor.profile_id)
    .first<{ blocked: number }>();
  if (blocked) throwVoiceUnavailable();
  if (
    await hasPendingLiveVoiceCleanup(
      database,
      gameId,
      actorState.playerId,
      now,
    )
  ) throwVoiceUnavailable();

  const participantRows = await Promise.all(
    activeMembers.map(async (member) => {
      const statePlayer = statePlayers.get(member.auth_subject);
      requireRule(
        statePlayer,
        "VOICE_SESSION_FAILED",
        "The voice participant list is inconsistent.",
        500,
      );
      return Object.freeze({
        identity: await opaqueVoiceName(
          "participant",
          `${gameId}:${statePlayer.playerId}`,
        ),
        playerId: statePlayer.playerId,
        displayName: statePlayer.displayName,
      });
    }),
  );
  const participant = participantRows.find(
    (candidate) => candidate.playerId === actorState.playerId,
  );
  requireRule(
    participant,
    "VOICE_SESSION_FAILED",
    "The voice participant could not be resolved.",
    500,
  );

  return Object.freeze({
    actorProfileId: actor.profile_id,
    actorPlayerId: actorState.playerId,
    participantIdentity: participant.identity,
    participants: Object.freeze(participantRows),
  });
}

async function cleanupMintedParticipant(
  database: D1Database,
  gameId: string,
  playerId: string,
  issuedAt: number,
): Promise<void> {
  try {
    await enqueueLiveVoiceCleanupTargets(
      database,
      [{ kind: "participant", gameId, playerId }],
      issuedAt,
    );
  } catch {
    await revokeLiveVoiceParticipant(gameId, playerId).catch(() => false);
    return;
  }
  await reconcileLiveVoiceCleanupJobs(database, {
    gameId,
    now: Date.now(),
  }).catch(() => undefined);
}

function liveVoiceSession(
  provider: LiveVoiceProviderConfig,
  access: LiveVoiceToken,
  eligibility: LiveVoiceEligibility,
): LiveVoiceSession {
  return Object.freeze({
    provider: "livekit",
    serverUrl: provider.serverUrl,
    token: access.token,
    expiresAt: access.expiresAt,
    participantIdentity: eligibility.participantIdentity,
    participants: eligibility.participants,
  });
}

function throwVoiceUnavailable(): never {
  throw new GameRuleError(
    "LIVE_VOICE_UNAVAILABLE",
    "Live voice is temporarily unavailable for this table.",
    404,
  );
}

async function enforceVoiceSessionQuota(
  database: D1Database,
  now: number,
  rules: ReadonlyArray<Readonly<{ scope: string; limit: number }>>,
): Promise<void> {
  const windowMs = 60_000;
  const bucketStart = Math.floor(now / windowMs) * windowMs;
  for (const rule of rules) {
    const row = await database
      .prepare(
        `INSERT INTO mutation_quotas (scope, bucket_start, count, expires_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(scope, bucket_start) DO UPDATE SET
           count = mutation_quotas.count + 1,
           expires_at = excluded.expires_at
         RETURNING count`,
      )
      .bind(rule.scope, bucketStart, bucketStart + windowMs + 5 * 60_000)
      .first<{ count: number }>();
    if (Number(row?.count ?? 0) > rule.limit) {
      throw new GameRuleError(
        "RATE_LIMITED",
        "Too many voice session requests. Please wait and try again.",
        429,
      );
    }
  }
}

function parseActiveVoicePlayers(
  stateJson: string,
): Map<string, { playerId: string; displayName: string }> | null {
  try {
    const state = JSON.parse(stateJson) as {
      players?: Array<{
        userId?: unknown;
        playerId?: unknown;
        displayName?: unknown;
        status?: unknown;
      }>;
    };
    if (!Array.isArray(state.players)) return null;
    const players = new Map<string, { playerId: string; displayName: string }>();
    const playerIds = new Set<string>();
    for (const player of state.players) {
      if (player.status === "left") continue;
      if (
        typeof player.playerId !== "string" ||
        !/^[A-Za-z0-9_-]{1,100}$/u.test(player.playerId) ||
        typeof player.userId !== "string" ||
        typeof player.displayName !== "string" ||
        player.displayName.length < 1 ||
        player.displayName.length > 48
      ) return null;
      if (players.has(player.userId) || playerIds.has(player.playerId)) return null;
      playerIds.add(player.playerId);
      players.set(player.userId, {
        playerId: player.playerId,
        displayName: player.displayName,
      });
    }
    return players;
  } catch {
    return null;
  }
}
