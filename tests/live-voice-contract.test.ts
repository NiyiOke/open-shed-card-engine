import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PROVIDER = source("../lib/server/live-voice-provider.ts");
const STORE = source("../lib/server/live-voice-store.ts");
const CHAT_STORE = source("../lib/server/chat-store.ts");
const CLEANUP = source("../lib/server/live-voice-cleanup.ts");
const GAME_STORE = source("../lib/server/game-store.ts");
const SCHEMA = source("../db/schema.ts");
const RUNTIME = source("../db/runtime.ts");
const ROUTE = source("../app/api/games/[gameId]/voice-session/route.ts");
const BLOCK_ROUTE = source(
  "../app/api/games/[gameId]/players/[playerId]/block/route.ts",
);
const CONTROLLER = source("../app/components/live-voice.ts");
const SHELL = source("../app/components/GameShell.tsx");
const COMMAND_ROUTE = source("../app/api/games/[gameId]/commands/route.ts");
const LISTING_ROUTE = source("../app/api/games/[gameId]/listing/route.ts");

test("voice token issuance is fail-closed, private-table-only, and block-aware", () => {
  assert.match(PROVIDER, /OPEN_SHED_V15_COMMUNICATION_ENABLED/u);
  assert.match(PROVIDER, /OPEN_SHED_V15_LIVE_VOICE_ENABLED/u);
  assert.match(PROVIDER, /OPEN_SHED_LIVEKIT_URL/u);
  assert.match(PROVIDER, /OPEN_SHED_LIVEKIT_API_SECRET/u);
  assert.match(PROVIDER, /environment\[LIVE_VOICE_ENV\.communication\] !== "true"/u);
  assert.match(PROVIDER, /environment\[LIVE_VOICE_ENV\.enabled\] !== "true"/u);
  assert.match(PROVIDER, /serverUrl\.protocol !== "wss:"/u);

  assert.match(STORE, /communication_scope === "invite_only"/u);
  assert.match(STORE, /member\.join_source === "host" \|\| member\.join_source === "invite"/u);
  assert.match(STORE, /FROM profile_blocks b/u);
  assert.doesNotMatch(STORE, /m\.player_id/u);
  assert.match(STORE, /p\.auth_subject[\s\S]*statePlayers\.get\(member\.auth_subject\)/u);
  assert.doesNotMatch(STORE, /LIVE_VOICE_BLOCKED|while a block is active/iu);
  assert.match(STORE, /if \(blocked\) throwVoiceUnavailable\(\)/u);
  assert.match(STORE, /hasPendingLiveVoiceCleanup/u);
  assert.match(STORE, /"LIVE_VOICE_UNAVAILABLE"/u);
  assert.match(STORE, /stateContainsActiveActor|parseActiveVoicePlayers/u);
  assert.doesNotMatch(STORE, /join_code|listing_id|auth_subject[^\n]*return/iu);
});

test("provider cleanup stays credential-gated when rollout switches are off", () => {
  const issuance = sliceBetween(
    PROVIDER,
    "export function getLiveVoiceProviderConfig",
    "export function getLiveVoiceAdminConfig",
  );
  assert.match(issuance, /LIVE_VOICE_ENV\.communication/u);
  assert.match(issuance, /LIVE_VOICE_ENV\.enabled/u);
  assert.match(issuance, /return getLiveVoiceAdminConfig/u);

  const administration = sliceBetween(
    PROVIDER,
    "export function getLiveVoiceAdminConfig",
    "export async function createLiveVoiceToken",
  );
  assert.doesNotMatch(administration, /LIVE_VOICE_ENV\.(?:communication|enabled)/u);
  assert.match(PROVIDER, /revokeLiveVoiceParticipant[\s\S]*getLiveVoiceAdminConfig/u);
  assert.match(PROVIDER, /endLiveVoiceRoom[\s\S]*getLiveVoiceAdminConfig/u);
  assert.match(PROVIDER, /isProviderNotFound/u);
});

test("server grants only short-lived microphone audio and never serializes provider credentials", () => {
  const grant = sliceBetween(PROVIDER, "token.addGrant({", "});");
  assert.match(grant, /roomJoin: true/u);
  assert.match(grant, /canSubscribe: true/u);
  assert.match(grant, /canPublishSources: \[TrackSource\.MICROPHONE\]/u);
  assert.match(grant, /canPublishData: false/u);
  assert.match(grant, /canUpdateOwnMetadata: false/u);
  assert.doesNotMatch(grant, /CAMERA|SCREEN_SHARE|roomAdmin|roomRecord/iu);
  assert.match(PROVIDER, /LIVE_VOICE_TOKEN_TTL_SECONDS = 5 \* 60/u);
  assert.match(PROVIDER, /revokeTokenTs: BigInt\(0\)/u);
  assert.doesNotMatch(PROVIDER, /revokeTokenTs:\s*liveVoiceRevocation/iu);

  const response = sliceBetween(STORE, "return Object.freeze({", "function throwVoiceUnavailable");
  assert.match(response, /serverUrl: provider\.serverUrl/u);
  assert.match(response, /token: access\.token/u);
  assert.doesNotMatch(response, /apiKey|apiSecret/u);
  assert.match(PROVIDER, /opaqueVoiceName\("room"/u);
  assert.match(PROVIDER, /opaqueVoiceName\([\s\S]*"participant"/u);
});

test("minted voice tokens pass a second eligibility read before release", () => {
  const issuance = sliceBetween(
    STORE,
    "const access = await mintToken",
    "return liveVoiceSession",
  );
  assert.match(issuance, /finalEligibility = await readLiveVoiceEligibility/u);
  assert.match(issuance, /finalEligibility\.actorPlayerId === initial\.actorPlayerId/u);
  assert.match(issuance, /cleanupRejectedMint[\s\S]*throw error/u);
  assert.match(STORE, /enqueueLiveVoiceCleanupTargets/u);
  assert.match(STORE, /revokeLiveVoiceParticipant/u);
});

test("voice endpoint accepts no client authority and returns no-store JSON", () => {
  assert.match(ROUTE, /requireRequestUser\(request\)/u);
  assert.match(ROUTE, /assertSafeMutationRequest\(request\)/u);
  assert.match(ROUTE, /assertExactJsonKeys\([\s\S]*body,[\s\S]*\[\]/u);
  assert.match(ROUTE, /createLiveVoiceSession\(user, gameId\)/u);
  assert.doesNotMatch(ROUTE, /playerId|profileId|roomName|token[^A-Za-z]/u);
});

test("joining never opens the microphone and capture needs an explicit unmute action", () => {
  const join = sliceBetween(
    CONTROLLER,
    "async function connect(epoch: number)",
    "function bindRoom",
  );
  assert.match(join, /nextRoom\.connect/u);
  assert.match(join, /status: "joined_muted"/u);
  assert.doesNotMatch(join, /setMicrophoneEnabled\(true/u);
  assert.doesNotMatch(join, /getUserMedia|MediaRecorder/u);

  const microphone = sliceBetween(
    CONTROLLER,
    "async function setMicrophoneEnabled(enabled: boolean)",
    "function isMicrophoneDefinitelyOn",
  );
  assert.match(microphone, /status: "requesting_permission"/u);
  assert.match(microphone, /activeRoom\.localParticipant\.setMicrophoneEnabled/u);
  assert.match(microphone, /echoCancellation: true/u);
  assert.match(microphone, /noiseSuppression: true/u);
  assert.match(microphone, /permission_denied/u);
});

test("voice UI is private-capability gated, consent-first, and mobile operable", () => {
  assert.match(
    SHELL,
    /chatEnabled && \(chatLiveVoiceEnabled \|\| liveVoiceJoined\)/u,
  );
  assert.match(
    SHELL,
    /\{chatLiveVoiceEnabled \|\| liveVoiceJoined \? \(/u,
  );
  assert.match(SHELL, /Live voice is optional and is not recorded by Open Shed/u);
  assert.match(SHELL, /You always join\s+muted/u);
  assert.match(SHELL, /only after you explicitly\s+choose to turn your microphone on/u);
  assert.match(SHELL, />\s*Join muted\s*</u);
  assert.match(SHELL, /Turn microphone on/u);
  assert.match(SHELL, /Mute table voice/u);
  assert.match(SHELL, /Leave voice/u);
  assert.match(SHELL, /await liveVoiceControllerRef\.current\?\.leave\(\)/u);
});

test("table lifecycle and publication use a durable idempotent cleanup outbox", () => {
  assert.match(COMMAND_ROUTE, /reconcileLiveVoiceCleanupForGame\(gameId\)/u);
  assert.match(LISTING_ROUTE, /action === "publish"[\s\S]*reconcileLiveVoiceCleanupForGame\(gameId\)/u);
  assert.match(GAME_STORE, /newlyDepartedPlayerIds[\s\S]*guardedCommandLiveVoiceCleanupStatement/u);
  assert.match(GAME_STORE, /closesEmptyRoom[\s\S]*kind: "room"/u);
  assert.match(GAME_STORE, /guardedEventLiveVoiceCleanupStatement/u);
  assert.match(
    GAME_STORE,
    /publicationVoiceCleanupStatements = \[[\s\S]*state\.players\.map[\s\S]*kind: "room"/u,
  );
  assert.match(
    GAME_STORE,
    /closesEmptyRoom[\s\S]*\[\.\.\.current\.players, \.\.\.result\.state\.players\]/u,
  );
  assert.match(
    GAME_STORE,
    /state\.players\.map\(\(player\) => \(\{[\s\S]*kind: "participant"[\s\S]*kind: "room"/u,
  );
  assert.match(GAME_STORE, /maybeReconcileLiveVoiceCleanupJobs/u);
  assert.match(CLEANUP, /FROM command_receipts receipt[\s\S]*receipt\.request_hash = \?/u);
  assert.match(CLEANUP, /FROM game_events event[\s\S]*event\.kind = 'room_closed'/u);
  assert.match(CLEANUP, /ON CONFLICT\(job_key\) DO UPDATE/u);
  assert.match(CLEANUP, /next_attempt_at = \?/u);
  assert.match(CLEANUP, /CLEANUP_RETRY_MAX_MS/u);
  assert.match(CLEANUP, /CLEANUP_PROVIDER_DEADLINE_MS/u);
  assert.match(CLEANUP, /Promise\.all\([\s\S]*executeCleanupJobWithDeadline/u);
  assert.match(CLEANUP, /attempt_count === -1[\s\S]*attempt_count = -1/u);
  assert.match(CLEANUP, /liveVoiceRevocationProtectionUntil\([\s\S]*now/u);
  assert.match(CLEANUP, /expiredGameLiveVoiceCleanupStatements/u);
  assert.match(CLEANUP, /JOIN json_each/u);
  assert.match(SCHEMA, /liveVoiceCleanupJobs[\s\S]*attemptCount[\s\S]*expiresAt/u);
  assert.match(RUNTIME, /CREATE TABLE IF NOT EXISTS live_voice_cleanup_jobs/u);
  const purge = sliceBetween(
    GAME_STORE,
    "async function purgeExpiredRows",
    "function normalizeJoinCode",
  );
  assert.ok(
    purge.indexOf("expiredGameLiveVoiceCleanupStatements") <
      purge.indexOf("DELETE FROM games"),
  );
  assert.doesNotMatch(
    sliceBetween(purge, "DELETE FROM games", "DELETE FROM mutation_quotas"),
    /live_voice_cleanup_jobs/u,
  );
  assert.doesNotMatch(SCHEMA, /liveVoiceCleanupJobs[\s\S]{0,800}references\(/u);
  assert.doesNotMatch(STORE, /UPDATE games|INSERT INTO game_events|UPDATE game_members/iu);
});

test("blocking disconnects both participants without exposing provider failure", () => {
  assert.match(BLOCK_ROUTE, /setProfileBlock\(user, gameId, playerId, blocked\)/u);
  assert.match(
    CHAT_STORE,
    /\[actor\.player\.playerId, target\.player\.playerId\][\s\S]*guardedBlockLiveVoiceCleanupStatement/u,
  );
  assert.match(CHAT_STORE, /database\.batch\(\[statement, \.\.\.voiceCleanupStatements\]\)/u);
  assert.match(CHAT_STORE, /if \(blocked\) await reconcileLiveVoiceCleanupForGame\(gameId\)/u);
  assert.match(CLEANUP, /FROM profile_blocks block/u);
  assert.match(CLEANUP, /blocker\.auth_subject = \?/u);
  assert.match(CLEANUP, /reconcileLiveVoiceCleanupForGame[\s\S]*catch/u);
});

test("message capability reports provider-backed private eligibility without block leakage", () => {
  assert.match(CHAT_STORE, /liveVoice: boolean/u);
  assert.match(
    CHAT_STORE,
    /liveVoiceAvailable =[\s\S]*privateCommunicationAvailable[\s\S]*getLiveVoiceProviderConfig\(\) !== null/u,
  );
  assert.match(CHAT_STORE, /capabilities: \{[\s\S]*freeText:[\s\S]*liveVoice:/u);
  const capabilitySlice = sliceBetween(
    CHAT_STORE,
    "const liveVoiceAvailable",
    "const cursorRow",
  );
  assert.doesNotMatch(capabilitySlice, /profile_blocks|blocked/iu);
});

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function sliceBetween(value: string, startMarker: string, endMarker: string): string {
  const start = value.indexOf(startMarker);
  const end = value.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing source marker: ${endMarker}`);
  return value.slice(start, end);
}
