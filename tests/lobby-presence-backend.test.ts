import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  classifyLobbyPresence,
  LOBBY_INVITATION_TTL_MS,
  LOBBY_PRESENCE_ENV,
  LOBBY_PRESENCE_THRESHOLDS,
  parseLobbyPresenceEnabled,
} from "../lib/server/lobby-presence-policy";
import { normalizePublicAlias } from "../lib/server/discovery-policy";

const ROOT = resolve(process.cwd());
const STORE = readFileSync(
  join(ROOT, "lib/server/lobby-presence-store.ts"),
  "utf8",
);
const GAME_STORE = readFileSync(join(ROOT, "lib/server/game-store.ts"), "utf8");

test("lobby discovery is independently fail-closed", () => {
  assert.equal(parseLobbyPresenceEnabled({ NODE_ENV: "production" }), false);
  for (const value of ["TRUE", "1", "yes", " true ", "false", ""]) {
    assert.equal(parseLobbyPresenceEnabled({ [LOBBY_PRESENCE_ENV]: value }), false);
  }
  assert.equal(
    parseLobbyPresenceEnabled({ [LOBBY_PRESENCE_ENV]: "true" }),
    true,
  );
});

test("lobby presence exposes only coarse fresh states and expires quickly", () => {
  const now = 1_000_000;
  assert.equal(classifyLobbyPresence(now, now), "online");
  assert.equal(
    classifyLobbyPresence(
      now - LOBBY_PRESENCE_THRESHOLDS.reconnectingAfterMs,
      now,
    ),
    "reconnecting",
  );
  assert.equal(
    classifyLobbyPresence(
      now - LOBBY_PRESENCE_THRESHOLDS.expiresAfterMs,
      now,
    ),
    null,
  );
  assert.equal(LOBBY_INVITATION_TTL_MS, 5 * 60_000);
});

test("stranger-facing aliases reject contact details and hidden controls", () => {
  assert.equal(normalizePublicAlias("Safe Player"), "Safe Player");
  assert.equal(normalizePublicAlias("Call 07123456789"), null);
  assert.equal(normalizePublicAlias("Discord playername"), null);
  assert.equal(normalizePublicAlias("Hidden\u202eAlias"), null);
});

test("backend contract keeps account/table identifiers outside directory feeds", () => {
  const snapshot = sourceFunction(
    STORE,
    "buildLobbyPresenceSnapshot",
    "isEligibleHostBrowser",
  );
  assert.match(snapshot, /presenceId: row\.presence_id/u);
  assert.match(snapshot, /alias: row\.alias/u);
  assert.match(snapshot, /inviteId: row\.id, fromAlias: row\.sender_alias/u);
  assert.doesNotMatch(snapshot, /auth_subject|join_code|game_id AS|nickname/u);
  assert.match(snapshot, /profile_blocks/u);
  assert.match(snapshot, /member\.status <> 'left'/u);
  assert.match(snapshot, /lp\.profile_id <> \?/u);
});

test("send and accept revalidate authority, freshness, blocks and one-seat state", () => {
  const send = sourceFunction(
    STORE,
    "sendLobbyInvitation",
    "respondToLobbyInvitation",
  );
  const accept = sourceFunction(
    STORE,
    "acceptLobbyInvitation",
    "buildLobbyPresenceSnapshot",
  );
  assert.match(send, /game\.host_profile_id = \?/u);
  assert.match(send, /game\.version = \? AND game\.state_hash = \?/u);
  assert.match(send, /host_presence\.last_seen_at > \?/u);
  assert.match(send, /SELECT COUNT\(\*\) FROM game_members member/u);
  assert.match(send, /pair:\$\{sender\.id\}:\$\{recipient!\.profile_id\}/u);
  assert.match(send, /recipient:\$\{recipient!\.profile_id\}/u);
  assert.match(accept, /state = 'accepted'/u);
  assert.match(accept, /communication_scope = CASE/u);
  assert.match(accept, /THEN 'public_safe'/u);
  assert.match(accept, /profile_blocks/u);
  assert.match(accept, /host_presence/u);
  assert.match(accept, /DELETE FROM lobby_presence/u);
  assert.match(accept, /event_floor_version/u);
  assert.match(accept, /await database\.batch\(\[/u);
});

test("sole hosts can durably block an opaque fresh lobby target", () => {
  const block = sourceFunction(
    STORE,
    "blockLobbyPresencePlayer",
    "respondToLobbyInvitation",
  );
  assert.match(block, /operation: "block_lobby_presence"/u);
  assert.match(block, /isEligibleHostBrowser/u);
  assert.match(block, /INSERT OR IGNORE INTO profile_blocks/u);
  assert.match(block, /UPDATE lobby_invitations/u);
  assert.match(block, /lobby_presence_receipts/u);
  assert.match(block, /lobby-presence-block/u);
  assert.match(block, /pair:\$\{blocker\.id\}:\$\{target\.profile_id\}/u);
});

test("simultaneous exact invitation responses recover the terminal replay", () => {
  const respond = sourceFunction(
    STORE,
    "respondToLobbyInvitation",
    "acceptLobbyInvitation",
  );
  const accept = sourceFunction(
    STORE,
    "acceptLobbyInvitation",
    "buildLobbyPresenceSnapshot",
  );
  const recovery = sourceFunction(
    STORE,
    "recoverInvitationResponseRace",
    "invitationResponseFromReplay",
  );
  assert.ok(
    (respond.match(/recoverInvitationResponseRace/gu) ?? []).length >= 2,
    "decline/block must recover both constraint and zero-change races",
  );
  assert.match(accept, /catch \(error\)[\s\S]*recoverInvitationResponseRace/u);
  assert.match(recovery, /isResponseReplay/u);
  assert.match(recovery, /invitationResponseFromReplay/u);
  assert.match(recovery, /response_command_id === input\.commandId/u);
  assert.match(recovery, /"IDEMPOTENCY_KEY_REUSED"/u);
});

test("every table-entry path clears opted-in lobby presence behind a receipt", () => {
  const create = sourceFunction(GAME_STORE, "createGame", "joinGame");
  const manual = sourceFunction(GAME_STORE, "joinGame", "joinPublicRoom");
  const publicJoin = sourceFunction(
    GAME_STORE,
    "joinSelectedPublicRoom",
    "getGame",
  );
  assert.match(create, /DELETE FROM lobby_presence/u);
  assert.match(create, /FROM command_receipts receipt/u);
  assert.ok(
    (manual.match(/guardedLobbyPresenceDeleteStatement/gu) ?? []).length >= 2,
  );
  assert.match(publicJoin, /guardedLobbyPresenceDeleteStatement/u);
  assert.match(publicJoin, /guardedLobbyPresenceExpireStatement/u);
});

test("migration enforces sender and recipient idempotency on real SQLite", (context) => {
  const version = spawnSync("sqlite3", ["--version"], { encoding: "utf8" });
  if (version.status !== 0) {
    context.skip("sqlite3 is unavailable");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "open-shed-lobby-presence-"));
  const databasePath = join(directory, "presence.db");
  try {
    const migrations = readdirSync(join(ROOT, "drizzle"))
      .filter((name) => /^\d{4}_.*\.sql$/u.test(name))
      .sort()
      .map((name) => readFileSync(join(ROOT, "drizzle", name), "utf8"))
      .join("\n");
    const setup = runSqlite(databasePath, migrations);
    assert.equal(setup.status, 0, setup.stderr);

    const insert = (id: string, senderCommand: string, responseCommand: string | null) =>
      `INSERT INTO lobby_invitations (
         id, sender_profile_id, recipient_profile_id, recipient_presence_id,
         game_id, sender_alias, command_id, request_hash, pending_key, state,
         response_command_id, response_action, response_request_hash,
         created_at, expires_at
       ) VALUES (
         '${id}', 'sender', 'recipient', '${id.padEnd(32, "0").slice(0, 32)}',
         'game', 'Host alias', '${senderCommand}', 'hash-${id}', NULL,
         '${responseCommand ? "declined" : "expired"}',
         ${responseCommand ? `'${responseCommand}'` : "NULL"},
         ${responseCommand ? "'decline'" : "NULL"},
         ${responseCommand ? `'response-${id}'` : "NULL"}, 1, 2
       );`;
    assert.equal(runSqlite(databasePath, insert("a", "send-key", null)).status, 0);
    const duplicateSend = runSqlite(
      databasePath,
      insert("b", "send-key", null),
    );
    assert.notEqual(duplicateSend.status, 0);
    assert.match(duplicateSend.stderr, /UNIQUE constraint failed/u);

    assert.equal(runSqlite(databasePath, insert("c", "send-c", "respond-key")).status, 0);
    const duplicateResponse = runSqlite(
      databasePath,
      insert("d", "send-d", "respond-key"),
    );
    assert.notEqual(duplicateResponse.status, 0);
    assert.match(duplicateResponse.stderr, /UNIQUE constraint failed/u);

    const indexes = JSON.parse(
      runSqlite(databasePath, "PRAGMA index_list('lobby_invitations');", true)
        .stdout,
    ) as Array<{ name: string; unique: number }>;
    for (const name of [
      "idx_lobby_invitations_sender_command",
      "idx_lobby_invitations_recipient_response_command",
      "idx_lobby_invitations_pending_key",
    ]) {
      assert.equal(
        indexes.some((entry) => entry.name === name && entry.unique === 1),
        true,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sourceFunction(source: string, startName: string, nextName: string): string {
  const start = source.indexOf(`function ${startName}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  assert.notEqual(start, -1, `${startName} is missing`);
  assert.notEqual(end, -1, `${nextName} is missing after ${startName}`);
  return source.slice(start, end);
}

function runSqlite(
  databasePath: string,
  sql: string,
  json = false,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    "sqlite3",
    [...(json ? ["-json"] : []), databasePath],
    { encoding: "utf8", input: sql },
  );
  return {
    status: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}
