import { ensureDatabaseSchema } from "../../db/runtime";
import { joinLobbyState } from "../game/engine";
import { GameRuleError, requireRule } from "../game/errors";
import { assertGameInvariants } from "../game/invariants";
import type { GameState } from "../game/types";
import type { AuthenticatedUser } from "./auth";
import { normalizePublicAlias } from "./discovery-policy";
import {
  LOBBY_PRESENCE_DISABLED,
  lobbyPresenceSelf,
  type LobbyDirectoryPlayer,
  type LobbyInvitationCard,
  type LobbyInvitationResponse,
  type LobbyInvitationSent,
  type LobbyPresenceBlockResult,
  type LobbyPresenceSnapshot,
} from "./lobby-presence-dto";
import {
  classifyLobbyPresence,
  isFreshLobbyPresence,
  isLobbyPresenceEnabled,
  LOBBY_DIRECTORY_LIMIT,
  LOBBY_INVITATION_FEED_LIMIT,
  LOBBY_INVITATION_TTL_MS,
  LOBBY_PRESENCE_THRESHOLDS,
} from "./lobby-presence-policy";
import { getGame, type GameSnapshot } from "./game-store";

type ProfileRow = {
  id: string;
  auth_subject: string;
  nickname: string;
};

type PresenceRow = {
  profile_id: string;
  presence_id: string;
  alias: string;
  last_seen_at: number;
  expires_at: number;
};

type DirectoryRow = PresenceRow & {
  sent_invite: number;
};

type InvitationFeedRow = {
  id: string;
  sender_alias: string;
};

type InvitationRow = {
  id: string;
  sender_profile_id: string;
  recipient_profile_id: string;
  recipient_presence_id: string;
  game_id: string;
  sender_alias: string;
  command_id: string;
  request_hash: string;
  state: string;
  response_command_id: string | null;
  response_action: string | null;
  response_request_hash: string | null;
  accepted_alias: string | null;
  accepted_revision: number | null;
  expires_at: number;
};

type GameRow = {
  id: string;
  join_code: string;
  host_profile_id: string;
  status: string;
  room_status: string;
  version: number;
  state_json: string;
  state_hash: string;
  expires_at: number;
};

type QuotaRule = { scope: string; windowMs: number; limit: number };

const PRESENCE_RECEIPT_TTL_MS = 24 * 60 * 60_000;
const LOBBY_GAME_LIFETIME_MS = 24 * 60 * 60_000;

export async function getLobbyPresence(
  user: AuthenticatedUser,
): Promise<LobbyPresenceSnapshot> {
  if (!isLobbyPresenceEnabled()) return LOBBY_PRESENCE_DISABLED;
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  const profile = await getOrCreateProfile(database, user, now);
  await expireLobbyRows(database, now);
  return buildLobbyPresenceSnapshot(database, profile, now);
}

export async function setLobbyPresence(
  user: AuthenticatedUser,
  input:
    | Readonly<{ commandId: string; lookingForGame: false }>
    | Readonly<{ commandId: string; lookingForGame: true; alias: string }>,
): Promise<LobbyPresenceSnapshot> {
  requireFeature();
  const alias = input.lookingForGame
    ? requirePublicAlias(input.alias, "Enter a public lobby alias.")
    : null;
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  const profile = await getOrCreateProfile(database, user, now);
  const requestHash = await hashText(
    JSON.stringify({ operation: "set_lobby_presence", lookingForGame: input.lookingForGame, alias }),
  );
  const receipt = await database
    .prepare(
      `SELECT request_hash FROM lobby_presence_receipts
       WHERE actor_profile_id = ? AND command_id = ? LIMIT 1`,
    )
    .bind(profile.id, input.commandId)
    .first<{ request_hash: string }>();
  if (receipt) {
    assertSameRequest(receipt.request_hash, requestHash);
    return buildLobbyPresenceSnapshot(database, profile, now);
  }

  await enforceQuota(database, now, [
    { scope: `profile:${profile.id}:lobby-presence`, windowMs: 60_000, limit: 20 },
  ]);
  if (alias !== null) {
    const activeMembership = await hasActiveOpenMembership(database, profile.id, now);
    requireRule(
      !activeMembership,
      "LOBBY_PRESENCE_UNAVAILABLE",
      "Leave your current table before looking for a game.",
      409,
    );
  }

  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO lobby_presence_receipts (
             actor_profile_id, command_id, request_hash, created_at, expires_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(profile.id, input.commandId, requestHash, now, now + PRESENCE_RECEIPT_TTL_MS),
      alias === null
        ? database.prepare(`DELETE FROM lobby_presence WHERE profile_id = ?`).bind(profile.id)
        : database
            .prepare(
              `INSERT INTO lobby_presence (
                 profile_id, presence_id, alias, last_seen_at, expires_at,
                 created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(profile_id) DO UPDATE SET
                 presence_id = excluded.presence_id,
                 alias = excluded.alias,
                 last_seen_at = excluded.last_seen_at,
                 expires_at = excluded.expires_at,
                 updated_at = excluded.updated_at`,
            )
            .bind(
              profile.id,
              createOpaqueId(),
              alias,
              now,
              now + LOBBY_PRESENCE_THRESHOLDS.expiresAfterMs,
              now,
              now,
            ),
      // Every explicit toggle rotates or removes the locator. Retire any
      // invitation addressed to the previous locator in that same batch.
      database
        .prepare(
          `UPDATE lobby_invitations
           SET state = 'expired', pending_key = NULL, responded_at = ?
           WHERE recipient_profile_id = ? AND state = 'pending'
             AND recipient_presence_id <> COALESCE(
               (SELECT presence_id FROM lobby_presence WHERE profile_id = ?),
               ''
             )`,
        )
        .bind(now, profile.id, profile.id),
    ]);
  } catch (error) {
    const accepted = await database
      .prepare(
        `SELECT request_hash FROM lobby_presence_receipts
         WHERE actor_profile_id = ? AND command_id = ? LIMIT 1`,
      )
      .bind(profile.id, input.commandId)
      .first<{ request_hash: string }>();
    if (!accepted) throw error;
    assertSameRequest(accepted.request_hash, requestHash);
  }
  return buildLobbyPresenceSnapshot(database, profile, now);
}

export async function heartbeatLobbyPresence(
  user: AuthenticatedUser,
): Promise<LobbyPresenceSnapshot> {
  requireFeature();
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  const profile = await getOrCreateProfile(database, user, now);
  await enforceQuota(database, now, [
    {
      scope: `profile:${profile.id}:lobby-presence-heartbeat`,
      windowMs: 60_000,
      limit: 12,
    },
  ]);
  // The expiry condition is deliberate: a backgrounded/expired opt-in never
  // resurrects without a fresh explicit toggle and a rotated locator.
  await database
    .prepare(
      `UPDATE lobby_presence
       SET last_seen_at = ?, expires_at = ?, updated_at = ?
       WHERE profile_id = ? AND expires_at > ?
         AND NOT EXISTS (
           SELECT 1 FROM game_members member
           JOIN games game ON game.id = member.game_id
           WHERE member.profile_id = lobby_presence.profile_id
             AND member.status <> 'left'
             AND game.room_status = 'open' AND game.expires_at > ?
         )`,
    )
    .bind(
      now,
      now + LOBBY_PRESENCE_THRESHOLDS.expiresAfterMs,
      now,
      profile.id,
      now,
      now,
    )
    .run();
  await expireLobbyRows(database, now);
  return buildLobbyPresenceSnapshot(database, profile, now);
}

export async function clearLobbyPresenceForProfile(
  database: D1Database,
  profileId: string,
  now: number,
): Promise<void> {
  await database.batch([
    database.prepare(`DELETE FROM lobby_presence WHERE profile_id = ?`).bind(profileId),
    database
      .prepare(
        `UPDATE lobby_invitations
         SET state = 'expired', pending_key = NULL, responded_at = ?
         WHERE recipient_profile_id = ? AND state = 'pending'`,
      )
      .bind(now, profileId),
  ]);
}

export async function sendLobbyInvitation(
  user: AuthenticatedUser,
  gameId: string,
  input: Readonly<{ commandId: string; presenceId: string; senderAlias: string }>,
): Promise<LobbyInvitationSent> {
  requireFeature();
  requireOpaqueId(input.presenceId, "The player is no longer available.");
  const senderAlias = requirePublicAlias(
    input.senderAlias,
    "Enter a public invitation alias.",
  );
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  const sender = await getOrCreateProfile(database, user, now);
  await expireLobbyRows(database, now);
  const requestHash = await hashText(
    JSON.stringify({ operation: "send_lobby_invite", gameId, presenceId: input.presenceId, senderAlias }),
  );

  const existing = await findSentInvitation(database, sender.id, input.commandId);
  if (existing) return replaySentInvitation(existing, requestHash);
  // After exact replay recovery, charge the actor before resolving the opaque
  // locator so valid locators are no cheaper to probe than unknown ones.
  await enforceQuota(database, now, [
    { scope: `profile:${sender.id}:lobby-invite-send`, windowMs: 60_000, limit: 12 },
  ]);

  const game = await readGame(database, gameId);
  const state = game ? parseStoredState(game) : null;
  const activePlayers = state?.players.filter((player) => player.status !== "left") ?? [];
  const hostPresenceFresh = game
    ? await hasFreshGamePresence(database, game.id, sender.id, now)
    : false;
  requireRule(
    game && state &&
      game.host_profile_id === sender.id &&
      state.hostUserId === user.userId &&
      game.room_status === "open" &&
      game.status === "lobby" &&
      game.expires_at > now &&
      hostPresenceFresh &&
      activePlayers.length === 1 &&
      activePlayers[0]?.userId === user.userId,
    "LOBBY_INVITATION_UNAVAILABLE",
    "This invitation is no longer available.",
    404,
  );
  const recipient = await database
    .prepare(
      `SELECT profile_id, presence_id, alias, last_seen_at, expires_at
       FROM lobby_presence WHERE presence_id = ? LIMIT 1`,
    )
    .bind(input.presenceId)
    .first<PresenceRow>();
  await requireEligibleRecipient(database, recipient, sender.id, now);
  await enforceQuota(database, now, [
    {
      scope: `pair:${sender.id}:${recipient!.profile_id}:lobby-invite`,
      windowMs: 10 * 60_000,
      limit: 2,
    },
    {
      scope: `recipient:${recipient!.profile_id}:lobby-invite`,
      windowMs: 60 * 60_000,
      limit: 20,
    },
  ]);
  const inviteId = createOpaqueId();
  const pendingKey = `${gameId}:${recipient!.profile_id}`;
  try {
    const insert = database
      .prepare(
        `INSERT INTO lobby_invitations (
           id, sender_profile_id, recipient_profile_id, recipient_presence_id,
           game_id, sender_alias, command_id, request_hash, pending_key, state,
           created_at, expires_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM games game
           WHERE game.id = ? AND game.host_profile_id = ?
             AND game.version = ? AND game.state_hash = ?
             AND game.room_status = 'open' AND game.status = 'lobby'
             AND game.expires_at > ?
             AND 1 = (
               SELECT COUNT(*) FROM game_members member
               WHERE member.game_id = game.id AND member.status <> 'left'
             )
             AND EXISTS (
               SELECT 1 FROM game_presence host_presence
               WHERE host_presence.game_id = game.id
                 AND host_presence.profile_id = game.host_profile_id
                 AND host_presence.last_seen_at > ?
             )
         )
           AND EXISTS (
             SELECT 1 FROM lobby_presence target
             WHERE target.profile_id = ? AND target.presence_id = ?
               AND target.expires_at > ? AND target.last_seen_at > ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM game_members member
             JOIN games active_game ON active_game.id = member.game_id
             WHERE member.profile_id = ? AND member.status <> 'left'
               AND active_game.room_status = 'open' AND active_game.expires_at > ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM profile_blocks block
             WHERE (block.blocker_profile_id = ? AND block.blocked_profile_id = ?)
                OR (block.blocker_profile_id = ? AND block.blocked_profile_id = ?)
           )`,
      )
      .bind(
        inviteId,
        sender.id,
        recipient!.profile_id,
        recipient!.presence_id,
        gameId,
        senderAlias,
        input.commandId,
        requestHash,
        pendingKey,
        now,
        now + LOBBY_INVITATION_TTL_MS,
        gameId,
        sender.id,
        game!.version,
        game!.state_hash,
        now,
        now - LOBBY_PRESENCE_THRESHOLDS.expiresAfterMs,
        recipient!.profile_id,
        recipient!.presence_id,
        now,
        now - LOBBY_PRESENCE_THRESHOLDS.expiresAfterMs,
        recipient!.profile_id,
        now,
        sender.id,
        recipient!.profile_id,
        recipient!.profile_id,
        sender.id,
      );
    const inserted = await database.batch([insert]);
    if (Number(inserted[0]?.meta.changes ?? 0) !== 1) {
      throw unavailableInvitation();
    }
  } catch (error) {
    const accepted = await findSentInvitation(database, sender.id, input.commandId);
    if (accepted) return replaySentInvitation(accepted, requestHash);
    const pending = await database
      .prepare(
        `SELECT id, sender_profile_id, recipient_profile_id, recipient_presence_id,
                game_id, sender_alias, command_id, request_hash, state,
                response_command_id, response_action, response_request_hash,
                accepted_alias, accepted_revision, expires_at
         FROM lobby_invitations WHERE pending_key = ? LIMIT 1`,
      )
      .bind(pendingKey)
      .first<InvitationRow>();
    if (pending) {
      throw unavailableInvitation();
    }
    throw error;
  }
  return Object.freeze({
    invite: Object.freeze({ inviteId, state: "sent" as const, replayed: false }),
  });
}

export async function blockLobbyPresencePlayer(
  user: AuthenticatedUser,
  presenceId: string,
  commandId: string,
): Promise<LobbyPresenceBlockResult> {
  requireFeature();
  requireOpaqueId(presenceId, "This player is no longer available.");
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  const blocker = await getOrCreateProfile(database, user, now);
  const requestHash = await hashText(
    JSON.stringify({ operation: "block_lobby_presence", presenceId }),
  );
  const receipt = await database
    .prepare(
      `SELECT request_hash FROM lobby_presence_receipts
       WHERE actor_profile_id = ? AND command_id = ? LIMIT 1`,
    )
    .bind(blocker.id, commandId)
    .first<{ request_hash: string }>();
  if (receipt) {
    assertSameRequest(receipt.request_hash, requestHash);
    return Object.freeze({ blocked: true, replayed: true });
  }

  // Keep valid opaque locators no cheaper to probe than stale or unknown ones.
  await enforceQuota(database, now, [
    {
      scope: `profile:${blocker.id}:lobby-presence-block`,
      windowMs: 60_000,
      limit: 12,
    },
  ]);
  const target = await database
    .prepare(
      `SELECT profile_id, presence_id, alias, last_seen_at, expires_at
       FROM lobby_presence WHERE presence_id = ? LIMIT 1`,
    )
    .bind(presenceId)
    .first<PresenceRow>();
  requireRule(
    target &&
      target.profile_id !== blocker.id &&
      target.expires_at > now &&
      isFreshLobbyPresence(Number(target.last_seen_at), now) &&
      await isEligibleHostBrowser(database, blocker.id, now) &&
      !(await hasActiveOpenMembership(database, target.profile_id, now)),
    "LOBBY_INVITATION_UNAVAILABLE",
    "This player is no longer available.",
    404,
  );
  await enforceQuota(database, now, [
    {
      scope: `pair:${blocker.id}:${target.profile_id}:lobby-presence-block`,
      windowMs: 60 * 60_000,
      limit: 4,
    },
  ]);

  try {
    const batch = await database.batch([
      database
        .prepare(
          `INSERT INTO lobby_presence_receipts (
             actor_profile_id, command_id, request_hash, created_at, expires_at
           ) SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM lobby_presence target
             WHERE target.profile_id = ? AND target.presence_id = ?
               AND target.expires_at > ? AND target.last_seen_at > ?
               AND NOT EXISTS (
                 SELECT 1 FROM game_members member
                 JOIN games game ON game.id = member.game_id
                 WHERE member.profile_id = target.profile_id
                   AND member.status <> 'left'
                   AND game.room_status = 'open' AND game.expires_at > ?
               )
           )
           AND EXISTS (
             SELECT 1 FROM games game
             WHERE game.host_profile_id = ? AND game.room_status = 'open'
               AND game.status = 'lobby' AND game.expires_at > ?
               AND 1 = (
                 SELECT COUNT(*) FROM game_members member
                 WHERE member.game_id = game.id AND member.status <> 'left'
               )
               AND EXISTS (
                 SELECT 1 FROM game_presence host_presence
                 WHERE host_presence.game_id = game.id
                   AND host_presence.profile_id = game.host_profile_id
                   AND host_presence.last_seen_at > ?
               )
           )`,
        )
        .bind(
          blocker.id,
          commandId,
          requestHash,
          now,
          now + PRESENCE_RECEIPT_TTL_MS,
          target.profile_id,
          presenceId,
          now,
          now - LOBBY_PRESENCE_THRESHOLDS.expiresAfterMs,
          now,
          blocker.id,
          now,
          now - LOBBY_PRESENCE_THRESHOLDS.expiresAfterMs,
        ),
      database
        .prepare(
          `INSERT OR IGNORE INTO profile_blocks (
             blocker_profile_id, blocked_profile_id, created_at
           ) SELECT ?, ?, ? WHERE EXISTS (
             SELECT 1 FROM lobby_presence_receipts receipt
             WHERE receipt.actor_profile_id = ? AND receipt.command_id = ?
               AND receipt.request_hash = ?
           )`,
        )
        .bind(
          blocker.id,
          target.profile_id,
          now,
          blocker.id,
          commandId,
          requestHash,
        ),
      database
        .prepare(
          `UPDATE lobby_invitations
           SET state = 'expired', pending_key = NULL, responded_at = ?
           WHERE state = 'pending'
             AND (
               (sender_profile_id = ? AND recipient_profile_id = ?)
               OR (sender_profile_id = ? AND recipient_profile_id = ?)
             )
             AND EXISTS (
               SELECT 1 FROM lobby_presence_receipts receipt
               WHERE receipt.actor_profile_id = ? AND receipt.command_id = ?
                 AND receipt.request_hash = ?
             )`,
        )
        .bind(
          now,
          blocker.id,
          target.profile_id,
          target.profile_id,
          blocker.id,
          blocker.id,
          commandId,
          requestHash,
        ),
    ]);
    requireRule(
      Number(batch[0]?.meta.changes ?? 0) === 1,
      "LOBBY_INVITATION_UNAVAILABLE",
      "This player is no longer available.",
      404,
    );
  } catch (error) {
    const accepted = await database
      .prepare(
        `SELECT request_hash FROM lobby_presence_receipts
         WHERE actor_profile_id = ? AND command_id = ? LIMIT 1`,
      )
      .bind(blocker.id, commandId)
      .first<{ request_hash: string }>();
    if (!accepted) throw error;
    assertSameRequest(accepted.request_hash, requestHash);
    return Object.freeze({ blocked: true, replayed: true });
  }
  return Object.freeze({ blocked: true, replayed: false });
}

export async function respondToLobbyInvitation(
  user: AuthenticatedUser,
  inviteId: string,
  input: Readonly<{
    commandId: string;
    action: "accept" | "decline" | "decline_and_block";
  }>,
): Promise<LobbyInvitationResponse> {
  requireFeature();
  requireOpaqueId(inviteId, "This invitation is no longer available.");
  const database = await ensureDatabaseSchema();
  const now = Date.now();
  const recipient = await getOrCreateProfile(database, user, now);
  await expireLobbyRows(database, now);
  const invite = await readInvitation(database, inviteId);
  const responseRequestHash = await hashText(
    JSON.stringify({ operation: "respond_lobby_invite", inviteId, action: input.action }),
  );
  if (isResponseReplay(invite, recipient.id, input, responseRequestHash)) {
    return invitationResponseFromReplay(database, user, invite!, input.action);
  }
  await assertUnusedResponseCommand(
    database,
    recipient.id,
    input.commandId,
    responseRequestHash,
  );
  await enforceQuota(database, now, [
    { scope: `profile:${recipient.id}:lobby-invite-response`, windowMs: 60_000, limit: 20 },
  ]);
  requireRule(
    invite &&
      invite.recipient_profile_id === recipient.id &&
      invite.state === "pending" &&
      invite.expires_at > now,
    "LOBBY_INVITATION_UNAVAILABLE",
    "This invitation is no longer available.",
    404,
  );

  if (input.action !== "accept") {
    const nextState = input.action === "decline_and_block" ? "blocked" : "declined";
    let batch: D1Result<unknown>[];
    try {
      batch = await database.batch([
      database
        .prepare(
          `UPDATE lobby_invitations
           SET state = ?, pending_key = NULL, response_command_id = ?,
               response_action = ?, response_request_hash = ?, responded_at = ?
           WHERE id = ? AND recipient_profile_id = ? AND state = 'pending'
             AND expires_at > ?`,
        )
        .bind(
          nextState,
          input.commandId,
          input.action,
          responseRequestHash,
          now,
          inviteId,
          recipient.id,
          now,
        ),
      ...(input.action === "decline_and_block"
        ? [
            database
              .prepare(
                `INSERT OR IGNORE INTO profile_blocks (
                   blocker_profile_id, blocked_profile_id, created_at
                 ) SELECT ?, ?, ? WHERE EXISTS (
                   SELECT 1 FROM lobby_invitations invite
                   WHERE invite.id = ? AND invite.recipient_profile_id = ?
                     AND invite.state = 'blocked'
                     AND invite.response_command_id = ?
                     AND invite.response_request_hash = ?
                 )`,
              )
              .bind(
                recipient.id,
                invite.sender_profile_id,
                now,
                inviteId,
                recipient.id,
                input.commandId,
                responseRequestHash,
              ),
            database
              .prepare(
                `UPDATE lobby_invitations
                 SET state = 'expired', pending_key = NULL, responded_at = ?
                 WHERE state = 'pending'
                   AND (
                     (sender_profile_id = ? AND recipient_profile_id = ?)
                     OR (sender_profile_id = ? AND recipient_profile_id = ?)
                   )
                   AND EXISTS (
                     SELECT 1 FROM profile_blocks block
                     WHERE block.blocker_profile_id = ?
                       AND block.blocked_profile_id = ?
                   )`,
              )
              .bind(
                now,
                recipient.id,
                invite.sender_profile_id,
                invite.sender_profile_id,
                recipient.id,
                recipient.id,
                invite.sender_profile_id,
              ),
          ]
        : []),
      ]);
    } catch (error) {
      const recovered = await recoverInvitationResponseRace(
        database,
        user,
        recipient.id,
        inviteId,
        input,
        responseRequestHash,
      );
      if (recovered) return recovered;
      if (isConstraintFailure(error)) {
        throw new GameRuleError(
          "IDEMPOTENCY_KEY_REUSED",
          "That commandId was already used for another invitation.",
          409,
        );
      }
      throw error;
    }
    if (Number(batch[0]?.meta.changes ?? 0) !== 1) {
      const recovered = await recoverInvitationResponseRace(
        database,
        user,
        recipient.id,
        inviteId,
        input,
        responseRequestHash,
      );
      if (recovered) return recovered;
      throw unavailableInvitation();
    }
    return Object.freeze({
      invite: Object.freeze({ inviteId, state: nextState, replayed: false }),
    });
  }

  return acceptLobbyInvitation(
    database,
    user,
    recipient,
    invite,
    input.commandId,
    responseRequestHash,
    now,
  );
}

async function acceptLobbyInvitation(
  database: D1Database,
  user: AuthenticatedUser,
  recipient: ProfileRow,
  invite: InvitationRow,
  commandId: string,
  responseRequestHash: string,
  now: number,
): Promise<LobbyInvitationResponse> {
  const presence = await database
    .prepare(
      `SELECT profile_id, presence_id, alias, last_seen_at, expires_at
       FROM lobby_presence WHERE profile_id = ? LIMIT 1`,
    )
    .bind(recipient.id)
    .first<PresenceRow>();
  requireRule(
    presence &&
      presence.presence_id === invite.recipient_presence_id &&
      presence.expires_at > now &&
      isFreshLobbyPresence(Number(presence.last_seen_at), now),
    "LOBBY_INVITATION_UNAVAILABLE",
    "This invitation is no longer available.",
    404,
  );
  const game = await readGame(database, invite.game_id);
  const current = game ? parseStoredState(game) : null;
  const activePlayers = current?.players.filter((player) => player.status !== "left") ?? [];
  requireRule(
    game && current &&
      game.host_profile_id === invite.sender_profile_id &&
      game.room_status === "open" && game.status === "lobby" && game.expires_at > now &&
      await hasFreshGamePresence(database, game.id, invite.sender_profile_id, now) &&
      activePlayers.length === 1 && activePlayers[0]?.userId === current.hostUserId,
    "LOBBY_INVITATION_UNAVAILABLE",
    "This invitation is no longer available.",
    404,
  );
  requireRule(
    !(await hasBilateralBlock(database, recipient.id, invite.sender_profile_id)),
    "LOBBY_INVITATION_UNAVAILABLE",
    "This invitation is no longer available.",
    404,
  );
  const nextState = structuredClone(current);
  const host = nextState.players.find((player) => player.userId === nextState.hostUserId);
  requireRule(host, "LOBBY_INVITATION_UNAVAILABLE", "This invitation is no longer available.", 404);
  host.displayName = invite.sender_alias;
  const joinedResult = joinLobbyState(nextState, {
    userId: user.userId,
    playerId: crypto.randomUUID(),
    displayName: presence.alias,
    commandId,
    now,
  });
  const joined = joinedResult.state.players.find((player) => player.userId === user.userId)!;
  assertGameInvariants(joinedResult.state);
  const nextJson = JSON.stringify(joinedResult.state);
  const nextHash = await hashText(nextJson);
  const publicEvents = JSON.stringify(joinedResult.events);
  const eventFloor = joinedResult.state.revision;

  let batch: D1Result<unknown>[];
  try {
    batch = await database.batch([
    database
      .prepare(
        `UPDATE lobby_invitations
         SET state = 'accepted', pending_key = NULL, response_command_id = ?,
             response_action = 'accept', response_request_hash = ?,
             accepted_alias = ?, accepted_revision = ?,
             responded_at = ?
         WHERE id = ? AND recipient_profile_id = ? AND state = 'pending'
           AND recipient_presence_id = ? AND expires_at > ?
           AND EXISTS (
             SELECT 1 FROM lobby_presence lp
             WHERE lp.profile_id = lobby_invitations.recipient_profile_id
               AND lp.presence_id = lobby_invitations.recipient_presence_id
               AND lp.expires_at > ? AND lp.last_seen_at > ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM profile_blocks b
             WHERE (b.blocker_profile_id = recipient_profile_id AND b.blocked_profile_id = sender_profile_id)
                OR (b.blocked_profile_id = recipient_profile_id AND b.blocker_profile_id = sender_profile_id)
           )
           AND EXISTS (
             SELECT 1 FROM games g
             WHERE g.id = lobby_invitations.game_id
               AND g.host_profile_id = lobby_invitations.sender_profile_id
               AND g.version = ? AND g.state_hash = ?
               AND g.room_status = 'open' AND g.status = 'lobby' AND g.expires_at > ?
           )
           AND EXISTS (
             SELECT 1 FROM game_presence host_presence
             WHERE host_presence.game_id = lobby_invitations.game_id
               AND host_presence.profile_id = lobby_invitations.sender_profile_id
               AND host_presence.last_seen_at > ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM game_members existing_member
             JOIN games existing_game ON existing_game.id = existing_member.game_id
             WHERE existing_member.profile_id = recipient_profile_id
               AND existing_member.status <> 'left'
               AND existing_game.room_status = 'open'
               AND existing_game.expires_at > ?
           )
           AND 1 = (
             SELECT COUNT(*) FROM game_members gm
             WHERE gm.game_id = lobby_invitations.game_id AND gm.status <> 'left'
           )`,
      )
      .bind(
        commandId,
        responseRequestHash,
        presence.alias,
        joinedResult.state.revision,
        now,
        invite.id,
        recipient.id,
        invite.recipient_presence_id,
        now,
        now,
        now - LOBBY_PRESENCE_THRESHOLDS.expiresAfterMs,
        game!.version,
        game!.state_hash,
        now,
        now - LOBBY_PRESENCE_THRESHOLDS.expiresAfterMs,
        now,
      ),
    database
      .prepare(
        `UPDATE games SET communication_scope =
           CASE WHEN communication_scope = 'invite_only' THEN 'public_safe'
                ELSE communication_scope END
         WHERE id = ? AND EXISTS (
           SELECT 1 FROM lobby_invitations i
           WHERE i.id = ? AND i.state = 'accepted'
             AND i.response_command_id = ? AND i.accepted_revision = ?
         )`,
      )
      .bind(game!.id, invite.id, commandId, joinedResult.state.revision),
    database
      .prepare(
        `UPDATE profiles SET nickname = ?, updated_at = ? WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM lobby_invitations i
           WHERE i.id = ? AND i.state = 'accepted' AND i.response_command_id = ?
         )`,
      )
      .bind(invite.sender_alias, now, invite.sender_profile_id, invite.id, commandId),
    database
      .prepare(
        `UPDATE profiles SET nickname = ?, updated_at = ? WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM lobby_invitations i
           WHERE i.id = ? AND i.state = 'accepted' AND i.response_command_id = ?
         )`,
      )
      .bind(presence.alias, now, recipient.id, invite.id, commandId),
    database
      .prepare(
        `INSERT INTO game_events (
           game_id, version, command_id, actor_profile_id, kind,
           public_payload_json, state_hash, created_at
         ) SELECT ?, ?, ?, ?, 'lobby_invite_accept', ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM lobby_invitations i
           WHERE i.id = ? AND i.state = 'accepted' AND i.response_command_id = ?
         )`,
      )
      .bind(
        game!.id,
        joinedResult.state.revision,
        `lobby-invite:${invite.id}:${commandId}`,
        recipient.id,
        publicEvents,
        nextHash,
        now,
        invite.id,
        commandId,
      ),
    database
      .prepare(
        `DELETE FROM game_members
         WHERE game_id = ? AND seat = ? AND profile_id <> ? AND status = 'left'
           AND EXISTS (
             SELECT 1 FROM lobby_invitations i
             WHERE i.id = ? AND i.state = 'accepted'
               AND i.response_command_id = ? AND i.accepted_revision = ?
           )`,
      )
      .bind(
        game!.id,
        joined.seat,
        recipient.id,
        invite.id,
        commandId,
        joinedResult.state.revision,
      ),
    database
      .prepare(
        `INSERT INTO game_members (
           game_id, profile_id, seat, role, status, joined_at,
           public_discovery_consent_at, join_source, event_floor_version
         ) SELECT ?, ?, ?, 'player', 'active', ?, NULL, 'lobby_invite', ?
         WHERE EXISTS (
           SELECT 1 FROM lobby_invitations i
           WHERE i.id = ? AND i.state = 'accepted' AND i.response_command_id = ?
         )
         ON CONFLICT(game_id, profile_id) DO UPDATE SET
           seat = excluded.seat, role = 'player', status = 'active',
           joined_at = excluded.joined_at, left_at = NULL,
           public_discovery_consent_at = excluded.public_discovery_consent_at,
           join_source = excluded.join_source,
           event_floor_version = excluded.event_floor_version`,
      )
      .bind(
        game!.id,
        recipient.id,
        joined.seat,
        now,
        eventFloor,
        invite.id,
        commandId,
      ),
    database
      .prepare(
        `INSERT INTO game_presence (game_id, player_id, profile_id, last_seen_at)
         SELECT ?, ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM lobby_invitations i
           WHERE i.id = ? AND i.state = 'accepted' AND i.response_command_id = ?
         )
         ON CONFLICT(game_id, profile_id) DO UPDATE SET
           player_id = excluded.player_id, last_seen_at = excluded.last_seen_at`,
      )
      .bind(game!.id, joined.playerId, recipient.id, now, invite.id, commandId),
    database
      .prepare(
        `UPDATE public_game_listings
         SET state = 'unlisted', version = version + 1, updated_at = ?,
             unlisted_at = ?, close_reason = 'lobby_invite'
         WHERE game_id = ? AND state = 'listed'
           AND EXISTS (
             SELECT 1 FROM lobby_invitations i
             WHERE i.id = ? AND i.state = 'accepted' AND i.response_command_id = ?
           )`,
      )
      .bind(now, now, game!.id, invite.id, commandId),
    database
      .prepare(
        `DELETE FROM lobby_presence WHERE profile_id = ? AND EXISTS (
           SELECT 1 FROM lobby_invitations i
           WHERE i.id = ? AND i.state = 'accepted' AND i.response_command_id = ?
         )`,
      )
      .bind(recipient.id, invite.id, commandId),
    database
      .prepare(
        `UPDATE lobby_invitations
         SET state = 'expired', pending_key = NULL, responded_at = ?
         WHERE (recipient_profile_id = ? OR game_id = ?)
           AND state = 'pending' AND id <> ?
           AND EXISTS (
             SELECT 1 FROM lobby_invitations accepted
             WHERE accepted.id = ? AND accepted.state = 'accepted'
               AND accepted.response_command_id = ?
           )`,
      )
      .bind(
        now,
        recipient.id,
        game!.id,
        invite.id,
        invite.id,
        commandId,
      ),
    database
      .prepare(
        `UPDATE games
         SET version = ?, state_json = ?, state_hash = ?,
             communication_scope = CASE
               WHEN communication_scope = 'invite_only' THEN 'public_safe'
               ELSE communication_scope END,
             last_activity_at = ?
             , expires_at = ?
         WHERE id = ? AND version = ? AND state_hash = ?
           AND room_status = 'open' AND status = 'lobby'
           AND EXISTS (
             SELECT 1 FROM lobby_invitations i
             WHERE i.id = ? AND i.state = 'accepted' AND i.response_command_id = ?
               AND i.accepted_revision = ?
           )`,
      )
      .bind(
        joinedResult.state.revision,
        nextJson,
        nextHash,
        now,
        now + LOBBY_GAME_LIFETIME_MS,
        game!.id,
        game!.version,
        game!.state_hash,
        invite.id,
        commandId,
        joinedResult.state.revision,
      ),
    ]);
  } catch (error) {
    const recovered = await recoverInvitationResponseRace(
      database,
      user,
      recipient.id,
      invite.id,
      { commandId, action: "accept" },
      responseRequestHash,
    );
    if (recovered) return recovered;
    if (isConstraintFailure(error)) {
      throw new GameRuleError(
        "IDEMPOTENCY_KEY_REUSED",
        "That commandId was already used for another invitation.",
        409,
      );
    }
    throw error;
  }
  if (Number(batch[0]?.meta.changes ?? 0) !== 1 || Number(batch.at(-1)?.meta.changes ?? 0) !== 1) {
    const accepted = await readInvitation(database, invite.id);
    if (
      isResponseReplay(
        accepted,
        recipient.id,
        { commandId, action: "accept" },
        responseRequestHash,
      )
    ) {
      return invitationResponseFromReplay(database, user, accepted!, "accept");
    }
    throw unavailableInvitation();
  }
  return Object.freeze({
    invite: Object.freeze({ inviteId: invite.id, state: "accepted" as const, replayed: false }),
    snapshot: await getGame(user, game!.id),
  });
}

async function buildLobbyPresenceSnapshot(
  database: D1Database,
  profile: ProfileRow,
  now: number,
): Promise<LobbyPresenceSnapshot> {
  const ownPresence = await database
    .prepare(
      `SELECT profile_id, presence_id, alias, last_seen_at, expires_at
       FROM lobby_presence WHERE profile_id = ? AND expires_at > ? LIMIT 1`,
    )
    .bind(profile.id, now)
    .first<PresenceRow>();
  const optedIn = Boolean(
    ownPresence && isFreshLobbyPresence(Number(ownPresence.last_seen_at), now),
  );
  const canHostBrowse = await isEligibleHostBrowser(database, profile.id, now);
  // Seekers need only their invitation feed; the directory is disclosed to a
  // verified sole host who can act on it, reducing unnecessary peer exposure.
  const canBrowse = canHostBrowse;
  const players: LobbyDirectoryPlayer[] = [];
  if (canBrowse) {
    const rows = await database
      .prepare(
        `SELECT lp.profile_id, lp.presence_id, lp.alias, lp.last_seen_at,
                lp.expires_at,
                EXISTS (
                  SELECT 1 FROM lobby_invitations invite
                  WHERE invite.sender_profile_id = ?
                    AND invite.recipient_profile_id = lp.profile_id
                    AND invite.state = 'pending' AND invite.expires_at > ?
                ) AS sent_invite
         FROM lobby_presence lp
         WHERE lp.profile_id <> ? AND lp.expires_at > ? AND lp.last_seen_at > ?
           AND NOT EXISTS (
             SELECT 1 FROM profile_blocks b
             WHERE (b.blocker_profile_id = ? AND b.blocked_profile_id = lp.profile_id)
                OR (b.blocked_profile_id = ? AND b.blocker_profile_id = lp.profile_id)
           )
           AND NOT EXISTS (
             SELECT 1 FROM game_members member
             JOIN games game ON game.id = member.game_id
             WHERE member.profile_id = lp.profile_id AND member.status <> 'left'
               AND game.room_status = 'open' AND game.expires_at > ?
           )
         ORDER BY lp.updated_at DESC, lp.presence_id DESC LIMIT ?`,
      )
      .bind(
        profile.id,
        now,
        profile.id,
        now,
        now - LOBBY_PRESENCE_THRESHOLDS.expiresAfterMs,
        profile.id,
        profile.id,
        now,
        LOBBY_DIRECTORY_LIMIT,
      )
      .all<DirectoryRow>();
    for (const row of rows.results) {
      const status = classifyLobbyPresence(Number(row.last_seen_at), now);
      if (!status) continue;
      players.push(Object.freeze({
        presenceId: row.presence_id,
        alias: row.alias,
        status,
        inviteState: Number(row.sent_invite) === 1 ? "sent" : "idle",
      }));
    }
  }
  const invites: LobbyInvitationCard[] = [];
  if (optedIn) {
    const rows = await database
      .prepare(
        `SELECT invite.id, invite.sender_alias
         FROM lobby_invitations invite
         JOIN games game ON game.id = invite.game_id
         WHERE invite.recipient_profile_id = ? AND invite.state = 'pending'
           AND invite.recipient_presence_id = ? AND invite.expires_at > ?
           AND game.room_status = 'open' AND game.status = 'lobby' AND game.expires_at > ?
           AND game.host_profile_id = invite.sender_profile_id
           AND 1 = (
             SELECT COUNT(*) FROM game_members member
             WHERE member.game_id = game.id AND member.status <> 'left'
           )
           AND EXISTS (
             SELECT 1 FROM game_presence host_presence
             WHERE host_presence.game_id = game.id
               AND host_presence.profile_id = game.host_profile_id
               AND host_presence.last_seen_at > ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM profile_blocks b
             WHERE (b.blocker_profile_id = invite.recipient_profile_id AND b.blocked_profile_id = invite.sender_profile_id)
                OR (b.blocked_profile_id = invite.recipient_profile_id AND b.blocker_profile_id = invite.sender_profile_id)
           )
         ORDER BY invite.created_at DESC LIMIT ?`,
      )
      .bind(
        profile.id,
        ownPresence!.presence_id,
        now,
        now,
        now - LOBBY_PRESENCE_THRESHOLDS.expiresAfterMs,
        LOBBY_INVITATION_FEED_LIMIT,
      )
      .all<InvitationFeedRow>();
    for (const row of rows.results) {
      invites.push(Object.freeze({ inviteId: row.id, fromAlias: row.sender_alias }));
    }
  }
  return Object.freeze({
    enabled: true,
    self: lobbyPresenceSelf(optedIn ? ownPresence!.alias : null, canBrowse),
    players: Object.freeze(players),
    invites: Object.freeze(invites),
  });
}

async function isEligibleHostBrowser(
  database: D1Database,
  profileId: string,
  now: number,
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT 1 AS eligible FROM games game
       WHERE game.host_profile_id = ? AND game.room_status = 'open'
         AND game.status = 'lobby' AND game.expires_at > ?
         AND EXISTS (
           SELECT 1 FROM game_presence host_presence
           WHERE host_presence.game_id = game.id
             AND host_presence.profile_id = game.host_profile_id
             AND host_presence.last_seen_at > ?
         )
         AND 1 = (
           SELECT COUNT(*) FROM game_members member
           WHERE member.game_id = game.id AND member.status <> 'left'
         )
       LIMIT 1`,
    )
    .bind(
      profileId,
      now,
      now - LOBBY_PRESENCE_THRESHOLDS.expiresAfterMs,
    )
    .first<{ eligible: number }>();
  return Boolean(row);
}

async function requireEligibleRecipient(
  database: D1Database,
  recipient: PresenceRow | null,
  senderProfileId: string,
  now: number,
): Promise<void> {
  requireRule(
    recipient &&
      recipient.profile_id !== senderProfileId &&
      recipient.expires_at > now &&
      isFreshLobbyPresence(Number(recipient.last_seen_at), now) &&
      !(await hasActiveOpenMembership(database, recipient.profile_id, now)) &&
      !(await hasBilateralBlock(database, senderProfileId, recipient.profile_id)),
    "LOBBY_INVITATION_UNAVAILABLE",
    "This player is no longer available.",
    404,
  );
}

async function hasActiveOpenMembership(
  database: D1Database,
  profileId: string,
  now: number,
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT 1 AS active FROM game_members member
       JOIN games game ON game.id = member.game_id
       WHERE member.profile_id = ? AND member.status <> 'left'
         AND game.room_status = 'open' AND game.expires_at > ? LIMIT 1`,
    )
    .bind(profileId, now)
    .first<{ active: number }>();
  return Boolean(row);
}

async function hasFreshGamePresence(
  database: D1Database,
  gameId: string,
  profileId: string,
  now: number,
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT 1 AS live FROM game_presence
       WHERE game_id = ? AND profile_id = ? AND last_seen_at > ? LIMIT 1`,
    )
    .bind(
      gameId,
      profileId,
      now - LOBBY_PRESENCE_THRESHOLDS.expiresAfterMs,
    )
    .first<{ live: number }>();
  return Boolean(row);
}

async function hasBilateralBlock(
  database: D1Database,
  first: string,
  second: string,
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT 1 AS blocked FROM profile_blocks
       WHERE (blocker_profile_id = ? AND blocked_profile_id = ?)
          OR (blocker_profile_id = ? AND blocked_profile_id = ?) LIMIT 1`,
    )
    .bind(first, second, second, first)
    .first<{ blocked: number }>();
  return Boolean(row);
}

async function findSentInvitation(
  database: D1Database,
  senderProfileId: string,
  commandId: string,
): Promise<InvitationRow | null> {
  return database
    .prepare(
      `SELECT id, sender_profile_id, recipient_profile_id, recipient_presence_id,
              game_id, sender_alias, command_id, request_hash, state,
              response_command_id, response_action, response_request_hash,
              accepted_alias, accepted_revision, expires_at
       FROM lobby_invitations
       WHERE sender_profile_id = ? AND command_id = ? LIMIT 1`,
    )
    .bind(senderProfileId, commandId)
    .first<InvitationRow>();
}

async function readInvitation(
  database: D1Database,
  inviteId: string,
): Promise<InvitationRow | null> {
  return database
    .prepare(
      `SELECT id, sender_profile_id, recipient_profile_id, recipient_presence_id,
              game_id, sender_alias, command_id, request_hash, state,
              response_command_id, response_action, response_request_hash,
              accepted_alias, accepted_revision, expires_at
       FROM lobby_invitations WHERE id = ? LIMIT 1`,
    )
    .bind(inviteId)
    .first<InvitationRow>();
}

async function assertUnusedResponseCommand(
  database: D1Database,
  recipientProfileId: string,
  commandId: string,
  requestHash: string,
): Promise<void> {
  const existing = await database
    .prepare(
      `SELECT response_request_hash FROM lobby_invitations
       WHERE recipient_profile_id = ? AND response_command_id = ? LIMIT 1`,
    )
    .bind(recipientProfileId, commandId)
    .first<{ response_request_hash: string | null }>();
  if (!existing) return;
  assertSameRequest(existing.response_request_hash ?? "", requestHash);
  throw new GameRuleError(
    "IDEMPOTENCY_KEY_REUSED",
    "That commandId was already used for another invitation.",
    409,
  );
}

function replaySentInvitation(
  invite: InvitationRow,
  requestHash: string,
): LobbyInvitationSent {
  assertSameRequest(invite.request_hash, requestHash);
  return Object.freeze({
    invite: Object.freeze({ inviteId: invite.id, state: "sent" as const, replayed: true }),
  });
}

function isResponseReplay(
  invite: InvitationRow | null,
  recipientProfileId: string,
  input: { commandId: string; action: string },
  requestHash: string,
): boolean {
  return Boolean(
    invite && invite.recipient_profile_id === recipientProfileId &&
      invite.response_command_id === input.commandId &&
      invite.response_action === input.action &&
      invite.response_request_hash === requestHash,
  );
}

async function recoverInvitationResponseRace(
  database: D1Database,
  user: AuthenticatedUser,
  recipientProfileId: string,
  inviteId: string,
  input: {
    commandId: string;
    action: "accept" | "decline" | "decline_and_block";
  },
  requestHash: string,
): Promise<LobbyInvitationResponse | null> {
  const latest = await readInvitation(database, inviteId);
  if (isResponseReplay(latest, recipientProfileId, input, requestHash)) {
    return invitationResponseFromReplay(database, user, latest!, input.action);
  }
  if (
    latest?.recipient_profile_id === recipientProfileId &&
    latest.response_command_id === input.commandId
  ) {
    throw new GameRuleError(
      "IDEMPOTENCY_KEY_REUSED",
      "That commandId was already used for a different response.",
      409,
    );
  }
  await assertUnusedResponseCommand(
    database,
    recipientProfileId,
    input.commandId,
    requestHash,
  );
  return null;
}

async function invitationResponseFromReplay(
  database: D1Database,
  user: AuthenticatedUser,
  invite: InvitationRow,
  action: "accept" | "decline" | "decline_and_block",
): Promise<LobbyInvitationResponse> {
  if (action === "accept" && invite.state === "accepted") {
    const snapshot: GameSnapshot = await getGame(user, invite.game_id);
    return Object.freeze({
      invite: Object.freeze({ inviteId: invite.id, state: "accepted" as const, replayed: true }),
      snapshot,
    });
  }
  const state = action === "decline_and_block" ? "blocked" : "declined";
  requireRule(invite.state === state, "IDEMPOTENCY_KEY_REUSED", "That commandId was already used.", 409);
  return Object.freeze({
    invite: Object.freeze({ inviteId: invite.id, state, replayed: true }),
  });
}

async function expireLobbyRows(database: D1Database, now: number): Promise<void> {
  await database.batch([
    database
      .prepare(
        `UPDATE lobby_invitations SET state = 'expired', pending_key = NULL,
             responded_at = ?
         WHERE state = 'pending' AND expires_at <= ?`,
      )
      .bind(now, now),
    database.prepare(`DELETE FROM lobby_presence WHERE expires_at <= ?`).bind(now),
    database.prepare(`DELETE FROM lobby_presence_receipts WHERE expires_at <= ?`).bind(now),
    database
      .prepare(
        `DELETE FROM lobby_invitations WHERE rowid IN (
           SELECT rowid FROM lobby_invitations
           WHERE state <> 'pending'
             AND COALESCE(responded_at, expires_at) <= ?
           ORDER BY COALESCE(responded_at, expires_at) LIMIT 64
         )`,
      )
      .bind(now - PRESENCE_RECEIPT_TTL_MS),
  ]);
}

async function getOrCreateProfile(
  database: D1Database,
  user: AuthenticatedUser,
  now: number,
): Promise<ProfileRow> {
  const existing = await database
    .prepare(`SELECT id, auth_subject, nickname FROM profiles WHERE auth_subject = ? LIMIT 1`)
    .bind(user.userId)
    .first<ProfileRow>();
  if (existing) return existing;
  const profile = { id: crypto.randomUUID(), auth_subject: user.userId, nickname: user.suggestedName };
  await database
    .prepare(
      `INSERT OR IGNORE INTO profiles (id, auth_subject, nickname, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(profile.id, profile.auth_subject, profile.nickname, now, now)
    .run();
  return (
    (await database
      .prepare(`SELECT id, auth_subject, nickname FROM profiles WHERE auth_subject = ? LIMIT 1`)
      .bind(user.userId)
      .first<ProfileRow>()) ?? profile
  );
}

async function readGame(database: D1Database, gameId: string): Promise<GameRow | null> {
  return database
    .prepare(
      `SELECT id, join_code, host_profile_id, status, room_status, version,
              state_json, state_hash, expires_at FROM games WHERE id = ? LIMIT 1`,
    )
    .bind(gameId)
    .first<GameRow>();
}

function parseStoredState(row: GameRow): GameState {
  try {
    const state = JSON.parse(row.state_json) as GameState;
    assertGameInvariants(state);
    requireRule(state.gameId === row.id && state.revision === row.version, "CORRUPT_GAME_STATE", "Stored game state is invalid.", 500);
    return state;
  } catch (error) {
    if (error instanceof GameRuleError) throw error;
    throw new GameRuleError("CORRUPT_GAME_STATE", "Stored game state is invalid.", 500);
  }
}

async function enforceQuota(database: D1Database, now: number, rules: QuotaRule[]): Promise<void> {
  for (const rule of rules) {
    const bucketStart = Math.floor(now / rule.windowMs) * rule.windowMs;
    const result = await database
      .prepare(
        `INSERT INTO mutation_quotas (scope, bucket_start, count, expires_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(scope, bucket_start) DO UPDATE SET
           count = mutation_quotas.count + 1, expires_at = excluded.expires_at
         RETURNING count`,
      )
      .bind(rule.scope, bucketStart, bucketStart + rule.windowMs + 5 * 60_000)
      .first<{ count: number }>();
    if (Number(result?.count ?? 0) > rule.limit) {
      throw new GameRuleError("RATE_LIMITED", "Too many requests. Please wait and try again.", 429);
    }
  }
}

function requireFeature(): void {
  if (!isLobbyPresenceEnabled()) {
    throw new GameRuleError("LOBBY_PRESENCE_DISABLED", "Lobby player discovery is not available.", 404);
  }
}

function requirePublicAlias(value: unknown, message: string): string {
  const alias = normalizePublicAlias(value);
  requireRule(alias, "INVALID_ALIAS", message, 400);
  return alias;
}

function requireOpaqueId(value: unknown, message: string): asserts value is string {
  requireRule(typeof value === "string" && /^[0-9a-f]{32}$/u.test(value), "LOBBY_INVITATION_UNAVAILABLE", message, 404);
}

function createOpaqueId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertSameRequest(stored: string, actual: string): void {
  requireRule(stored === actual, "IDEMPOTENCY_KEY_REUSED", "That commandId was already used for a different request.", 409);
}

function unavailableInvitation(): GameRuleError {
  return new GameRuleError("LOBBY_INVITATION_UNAVAILABLE", "This invitation is no longer available.", 404);
}

function isConstraintFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:SQLITE_)?CONSTRAINT|UNIQUE constraint|constraint failed/iu.test(
    message,
  );
}
