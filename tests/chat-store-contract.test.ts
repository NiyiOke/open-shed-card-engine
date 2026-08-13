import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const STORE_SOURCE = readFileSync(
  fileURLToPath(new URL("../lib/server/chat-store.ts", import.meta.url)),
  "utf8",
);
const SCHEMA_SOURCE = readFileSync(
  fileURLToPath(new URL("../db/schema.ts", import.meta.url)),
  "utf8",
);
const GAME_STORE_SOURCE = readFileSync(
  fileURLToPath(new URL("../lib/server/game-store.ts", import.meta.url)),
  "utf8",
);

test("every operation derives its actor from current non-left membership", () => {
  assert.match(
    STORE_SOURCE,
    /profile\.auth_subject = \?[\s\S]*member\.status <> 'left'/u,
  );
  assert.match(
    STORE_SOURCE,
    /candidate\.userId === user\.userId && candidate\.status !== "left"/u,
  );
  assert.match(
    STORE_SOURCE,
    /sender_profile_id, sender_player_id,[\s\S]*actor\.profileId,[\s\S]*actor\.player\.playerId,[\s\S]*actor\.player\.displayName/u,
  );
  assert.doesNotMatch(STORE_SOURCE, /body\.(actor|sender|profile)/u);
});

test("send idempotency is body-bound and checked before quotas", () => {
  const receiptLookup = STORE_SOURCE.indexOf("const existingReceipt = await findReceipt(");
  const quota = STORE_SOURCE.indexOf("await enforceCommunicationQuota", receiptLookup);
  assert.ok(receiptLookup >= 0 && quota > receiptLookup);
  assert.match(
    STORE_SOURCE,
    /operation: MESSAGE_OPERATION,[\s\S]*gameId,[\s\S]*kind: normalized\.kind,[\s\S]*body: normalized\.body[\s\S]*contentId: normalized\.contentId/u,
  );
  assert.match(STORE_SOURCE, /"IDEMPOTENCY_KEY_REUSED"/u);
  assert.match(
    STORE_SOURCE,
    /operation = \? AND request_hash = \?/u,
  );
});

test("free text is fail-closed to private invite-only membership", () => {
  assert.match(STORE_SOURCE, /getV15FeaturePolicy\(\)\.freeTextEnabled/u);
  assert.match(
    STORE_SOURCE,
    /viewer\.communicationScope !== "invite_only"/u,
  );
  assert.match(
    STORE_SOURCE,
    /COALESCE\(join_source, ''\) NOT IN \('host', 'invite'\)/u,
  );
  assert.match(
    STORE_SOURCE,
    /INSERT INTO command_receipts[\s\S]*game\.communication_scope = 'invite_only'[\s\S]*communication_member\.status <> 'left'[\s\S]*NOT IN \('host', 'invite'\)/u,
  );
  assert.match(
    STORE_SOURCE,
    /\? = 1 OR message\.kind <> 'text'/u,
  );
});

test("the true two-second cooldown is inside the receipt-first guarded batch", () => {
  assert.match(
    STORE_SOURCE,
    /INSERT INTO command_receipts[\s\S]*NOT EXISTS \([\s\S]*FROM game_messages recent[\s\S]*recent\.created_at > \?/u,
  );
  assert.match(
    STORE_SOURCE,
    /now - COMMUNICATION_LIMITS\.messageCooldownMs/u,
  );
  assert.match(
    STORE_SOURCE,
    /INSERT INTO game_messages[\s\S]*WHERE EXISTS \([\s\S]*FROM command_receipts/u,
  );
});

test("feed scans are bounded, stable, current-member-only, and advance past hidden rows", () => {
  assert.match(
    STORE_SOURCE,
    /JOIN game_members sender[\s\S]*sender\.status <> 'left'/u,
  );
  assert.match(
    STORE_SOURCE,
    /ORDER BY message\.created_at, message\.id[\s\S]*LIMIT \?/u,
  );
  assert.match(
    STORE_SOURCE,
    /Number\(message\.viewer_muted\) === 0[\s\S]*Number\(message\.pair_blocked\) === 0/u,
  );
  assert.match(
    STORE_SOURCE,
    /nextCursor: scanned\.results\.at\(-1\)\?\.id \?\? cursor/u,
  );
  assert.match(
    STORE_SOURCE,
    /blocker_profile_id = \?[\s\S]*blocked_profile_id = message\.sender_profile_id[\s\S]*blocker_profile_id = message\.sender_profile_id/u,
  );
});

test("cursors and target player IDs are scoped back to the active room", () => {
  assert.match(
    STORE_SOURCE,
    /FROM game_messages[\s\S]*WHERE game_id = \? AND id = \? AND created_at > \? LIMIT 1/u,
  );
  assert.match(
    STORE_SOURCE,
    /profile\.auth_subject = \? AND member\.game_id = \?[\s\S]*member\.status <> 'left'/u,
  );
  assert.match(
    STORE_SOURCE,
    /viewer_member\.game_id = game\.id[\s\S]*viewer_member\.status <> 'left'[\s\S]*game\.id = message\.game_id/u,
  );
});

test("message feeds and cursors cannot cross the viewer join boundary", () => {
  assert.match(
    STORE_SOURCE,
    /message\.created_at > \?/u,
  );
  assert.match(
    STORE_SOURCE,
    /message\.created_at > recipient_member\.joined_at/u,
  );
  assert.match(
    STORE_SOURCE,
    /requireCursor\(database, gameId, cursor, viewer\.joinedAt\)/u,
  );
});

test("reports atomically snapshot allowlisted evidence without foreign keys", () => {
  assert.match(
    STORE_SOURCE,
    /INSERT INTO game_message_reports[\s\S]*message\.sender_profile_id, message\.sender_player_id,[\s\S]*message\.sender_display_name, message\.kind,[\s\S]*message\.content_id, message\.body_text, message\.created_at/u,
  );
  assert.match(STORE_SOURCE, /moderation_state[\s\S]*'pending'/u);
  assert.match(SCHEMA_SOURCE, /reportRetentionMs|gameMessageReports/u);
  assert.doesNotMatch(SCHEMA_SOURCE, /gameMessageReports[\s\S]{0,2600}references\(/u);
});

test("post-exit reports require an exact unexpired delivery receipt", () => {
  assert.match(
    STORE_SOURCE,
    /INSERT OR IGNORE INTO game_message_receipts[\s\S]*message\.id = \?[\s\S]*recipient_profile_id/u,
  );
  assert.match(
    STORE_SOURCE,
    /receipt\.game_id = message\.game_id[\s\S]*receipt\.message_id = message\.id[\s\S]*receipt\.recipient_profile_id = viewer_profile\.id[\s\S]*receipt\.expires_at > \?/u,
  );
  assert.match(
    STORE_SOURCE,
    /message\.sender_profile_id <> profile\.id/u,
  );
  assert.match(STORE_SOURCE, /DELETE FROM game_message_receipts/u);
});

test("mute/block writes are isolated from game state and presence", () => {
  const start = STORE_SOURCE.indexOf("async function setSafetyRelationship");
  const end = STORE_SOURCE.indexOf("async function hasSafetyRelationship", start);
  const slice = STORE_SOURCE.slice(start, end);
  assert.match(slice, /game_mutes/u);
  assert.match(slice, /profile_blocks/u);
  assert.doesNotMatch(slice, /UPDATE games|game_presence|state_json/u);
  assert.match(slice, /target\.profileId !== actor\.profileId/u);
});

test("game purge removes ephemeral chat but never couples report evidence to game deletion", () => {
  assert.match(
    GAME_STORE_SOURCE,
    /DELETE FROM game_message_reports[\s\S]*WHERE expires_at <= \?/u,
  );
  assert.match(GAME_STORE_SOURCE, /DELETE FROM game_messages/u);
  assert.match(GAME_STORE_SOURCE, /DELETE FROM game_message_receipts/u);
  assert.match(GAME_STORE_SOURCE, /DELETE FROM game_mutes/u);
  const deleteGame = GAME_STORE_SOURCE.slice(
    GAME_STORE_SOURCE.indexOf("`DELETE FROM games WHERE id IN"),
    GAME_STORE_SOURCE.indexOf("DELETE FROM mutation_quotas"),
  );
  assert.match(deleteGame, /NOT EXISTS \([\s\S]*FROM game_messages/u);
  assert.match(deleteGame, /NOT EXISTS \([\s\S]*FROM game_message_receipts/u);
  assert.match(deleteGame, /NOT EXISTS \([\s\S]*FROM game_mutes/u);
  assert.doesNotMatch(deleteGame, /game_message_reports/u);
});

test("request-path retention cleanup is best-effort and retries after failure", () => {
  const start = STORE_SOURCE.indexOf("async function maybeCleanupCommunication");
  const slice = STORE_SOURCE.slice(start);
  assert.match(slice, /cleanupExpiredCommunicationRows\(database, now\)/u);
  assert.match(slice, /\.catch\(\(\) => \{[\s\S]*lastCleanupAt = 0/u);
  assert.doesNotMatch(slice, /\.catch\(\(error\)[\s\S]*throw error/u);
});
