import assert from "node:assert/strict";
import test from "node:test";
import { TokenVerifier } from "livekit-server-sdk";
import {
  createLiveVoiceToken,
  getLiveVoiceAdminConfig,
  getLiveVoiceProviderConfig,
  LIVE_VOICE_ENV,
  LIVE_VOICE_REVOCATION_BARRIER_MS,
  LIVE_VOICE_TOKEN_TTL_SECONDS,
  liveVoiceRevocationProtectionUntil,
  opaqueVoiceName,
} from "../lib/server/live-voice-provider";

const VALID_ENVIRONMENT = {
  [LIVE_VOICE_ENV.communication]: "true",
  [LIVE_VOICE_ENV.enabled]: "true",
  [LIVE_VOICE_ENV.serverUrl]: "wss://open-shed-test.livekit.cloud",
  [LIVE_VOICE_ENV.apiKey]: "test-api-key",
  [LIVE_VOICE_ENV.apiSecret]: "test-api-secret-that-is-long-enough",
} as const;

test("live voice configuration defaults off and requires exact true", () => {
  assert.equal(getLiveVoiceProviderConfig({}), null);
  for (const enabled of ["TRUE", "1", "yes", " true ", "false"]) {
    assert.equal(
      getLiveVoiceProviderConfig({ ...VALID_ENVIRONMENT, [LIVE_VOICE_ENV.enabled]: enabled }),
      null,
    );
  }
  assert.equal(
    getLiveVoiceProviderConfig({
      ...VALID_ENVIRONMENT,
      [LIVE_VOICE_ENV.communication]: "false",
    }),
    null,
  );
});

test("provider administration remains available when issuance is switched off", () => {
  const disabledIssuance = {
    ...VALID_ENVIRONMENT,
    [LIVE_VOICE_ENV.communication]: "false",
    [LIVE_VOICE_ENV.enabled]: "false",
  } as const;
  assert.equal(getLiveVoiceProviderConfig(disabledIssuance), null);
  assert.deepEqual(getLiveVoiceAdminConfig(disabledIssuance), {
    serverUrl: "wss://open-shed-test.livekit.cloud",
    apiKey: VALID_ENVIRONMENT[LIVE_VOICE_ENV.apiKey],
    apiSecret: VALID_ENVIRONMENT[LIVE_VOICE_ENV.apiSecret],
  });
  assert.equal(getLiveVoiceAdminConfig({}), null);
});

test("live voice configuration accepts only a bare secure websocket origin", () => {
  const config = getLiveVoiceProviderConfig(VALID_ENVIRONMENT);
  assert.deepEqual(config, {
    serverUrl: "wss://open-shed-test.livekit.cloud",
    apiKey: VALID_ENVIRONMENT[LIVE_VOICE_ENV.apiKey],
    apiSecret: VALID_ENVIRONMENT[LIVE_VOICE_ENV.apiSecret],
  });
  assert.equal(Object.isFrozen(config), true);

  for (const serverUrl of [
    "ws://open-shed-test.livekit.cloud",
    "https://open-shed-test.livekit.cloud",
    "wss://user:pass@open-shed-test.livekit.cloud",
    "wss://open-shed-test.livekit.cloud/path",
    "wss://open-shed-test.livekit.cloud/?token=secret",
  ]) {
    assert.equal(
      getLiveVoiceProviderConfig({
        ...VALID_ENVIRONMENT,
        [LIVE_VOICE_ENV.serverUrl]: serverUrl,
      }),
      null,
    );
    assert.equal(
      getLiveVoiceAdminConfig({
        ...VALID_ENVIRONMENT,
        [LIVE_VOICE_ENV.serverUrl]: serverUrl,
      }),
      null,
    );
  }
});

test("voice tokens are room-bound, short lived, microphone-only and data-disabled", async () => {
  const config = getLiveVoiceProviderConfig(VALID_ENVIRONMENT);
  assert.ok(config);
  const now = 1_800_000_000_000;
  const result = await createLiveVoiceToken(config, {
    roomName: "osr_0123456789abcdef0123456789abcdef",
    participantIdentity: "osp_0123456789abcdef0123456789abcdef",
    now,
  });
  assert.equal(
    result.expiresAt,
    now + LIVE_VOICE_TOKEN_TTL_SECONDS * 1_000,
  );

  const claims = await new TokenVerifier(config.apiKey, config.apiSecret).verify(
    result.token,
  );
  assert.equal(claims.sub, "osp_0123456789abcdef0123456789abcdef");
  assert.equal(claims.video?.room, "osr_0123456789abcdef0123456789abcdef");
  assert.equal(claims.video?.roomJoin, true);
  assert.equal(claims.video?.canSubscribe, true);
  assert.equal(claims.video?.canPublish, true);
  assert.equal(claims.video?.canPublishData, false);
  assert.deepEqual(claims.video?.canPublishSources, ["microphone"]);
  assert.equal(claims.video?.roomAdmin, undefined);
  assert.equal(claims.video?.roomRecord, undefined);
});

test("provider revocation barrier covers the full default cutoff buffer", () => {
  const now = 1_800_000_000_999;
  assert.equal(LIVE_VOICE_REVOCATION_BARRIER_MS, 61_000);
  assert.equal(
    liveVoiceRevocationProtectionUntil(now),
    1_800_000_061_999,
  );
});

test("provider-facing room and participant identities are deterministic and opaque", async () => {
  const room = await opaqueVoiceName("room", "private-game-id-canary");
  const participant = await opaqueVoiceName(
    "participant",
    "private-game-id-canary:private-player-id-canary",
  );
  assert.match(room, /^osr_[a-f0-9]{32}$/);
  assert.match(participant, /^osp_[a-f0-9]{32}$/);
  assert.equal(room.includes("canary"), false);
  assert.equal(participant.includes("canary"), false);
  assert.notEqual(room.slice(4), participant.slice(4));
  assert.equal(await opaqueVoiceName("room", "private-game-id-canary"), room);
});
