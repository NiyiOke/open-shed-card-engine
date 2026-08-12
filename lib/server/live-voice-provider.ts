import {
  AccessToken,
  RoomServiceClient,
  TrackSource,
} from "livekit-server-sdk";

export const LIVE_VOICE_ENV = {
  communication: "OPEN_SHED_V15_COMMUNICATION_ENABLED",
  enabled: "OPEN_SHED_V15_LIVE_VOICE_ENABLED",
  serverUrl: "OPEN_SHED_LIVEKIT_URL",
  apiKey: "OPEN_SHED_LIVEKIT_API_KEY",
  apiSecret: "OPEN_SHED_LIVEKIT_API_SECRET",
} as const;

export const LIVE_VOICE_TOKEN_TTL_SECONDS = 5 * 60;
export const LIVE_VOICE_REVOCATION_BARRIER_MS = 61_000;

type LiveVoiceEnvironment = Partial<
  Record<(typeof LIVE_VOICE_ENV)[keyof typeof LIVE_VOICE_ENV], string | undefined>
>;

export type LiveVoiceProviderConfig = Readonly<{
  serverUrl: string;
  apiKey: string;
  apiSecret: string;
}>;

export type LiveVoiceToken = Readonly<{
  token: string;
  expiresAt: number;
}>;

/**
 * Token issuance fails closed unless both rollout switches and every provider
 * value are configured. Administrative cleanup deliberately has a separate
 * configuration path so turning voice off cannot strand an existing room.
 */
export function getLiveVoiceProviderConfig(
  environment: LiveVoiceEnvironment = process.env as LiveVoiceEnvironment,
): LiveVoiceProviderConfig | null {
  if (
    environment[LIVE_VOICE_ENV.communication] !== "true" ||
    environment[LIVE_VOICE_ENV.enabled] !== "true"
  ) return null;

  return getLiveVoiceAdminConfig(environment);
}

/**
 * Provider administration is credential-gated, not rollout-gated. This path
 * can only revoke participants or end rooms; it never issues browser tokens.
 */
export function getLiveVoiceAdminConfig(
  environment: LiveVoiceEnvironment = process.env as LiveVoiceEnvironment,
): LiveVoiceProviderConfig | null {
  const rawServerUrl = environment[LIVE_VOICE_ENV.serverUrl];
  const apiKey = environment[LIVE_VOICE_ENV.apiKey];
  const apiSecret = environment[LIVE_VOICE_ENV.apiSecret];
  if (!rawServerUrl || !apiKey || !apiSecret) return null;

  let serverUrl: URL;
  try {
    serverUrl = new URL(rawServerUrl);
  } catch {
    return null;
  }
  if (serverUrl.protocol !== "wss:" || serverUrl.username || serverUrl.password) {
    return null;
  }
  if (serverUrl.pathname !== "/" || serverUrl.search || serverUrl.hash) {
    return null;
  }
  if (!isProviderCredential(apiKey) || !isProviderCredential(apiSecret)) {
    return null;
  }

  return Object.freeze({
    serverUrl: serverUrl.toString().replace(/\/$/, ""),
    apiKey,
    apiSecret,
  });
}

export async function createLiveVoiceToken(
  config: LiveVoiceProviderConfig,
  input: Readonly<{
    roomName: string;
    participantIdentity: string;
    now?: number;
  }>,
): Promise<LiveVoiceToken> {
  const now = input.now ?? Date.now();
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: input.participantIdentity,
    ttl: LIVE_VOICE_TOKEN_TTL_SECONDS,
  });
  token.addGrant({
    room: input.roomName,
    roomJoin: true,
    canSubscribe: true,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canPublishData: false,
    canUpdateOwnMetadata: false,
  });
  return Object.freeze({
    token: await token.toJwt(),
    expiresAt: now + LIVE_VOICE_TOKEN_TTL_SECONDS * 1_000,
  });
}

export async function opaqueVoiceName(
  namespace: "room" | "participant",
  value: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`open-shed:${namespace}:${value}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `${namespace === "room" ? "osr" : "osp"}_${hex(digest).slice(0, 32)}`;
}

/** Best-effort revocation after a player leaves or is removed. */
export async function revokeLiveVoiceParticipant(
  gameId: string,
  playerId: string,
): Promise<boolean> {
  const config = getLiveVoiceAdminConfig();
  if (!config) return false;
  try {
    const roomName = await opaqueVoiceName("room", gameId);
    const participantIdentity = await opaqueVoiceName(
      "participant",
      `${gameId}:${playerId}`,
    );
    await roomService(config).removeParticipant(roomName, participantIdentity, {
      // Zero delegates the cutoff to LiveKit's current clock and documented
      // default buffer. Explicit stale/future timestamps can be rejected.
      revokeTokenTs: BigInt(0),
    });
    return true;
  } catch {
    // Gameplay mutations must not fail because the optional media provider is
    // unavailable. The browser also tears down tracks on membership changes.
    return false;
  }
}

export function liveVoiceRevocationProtectionUntil(now: number): number {
  return now + LIVE_VOICE_REVOCATION_BARRIER_MS;
}

/** Best-effort room termination when a table closes or becomes public. */
export async function endLiveVoiceRoom(gameId: string): Promise<boolean> {
  const config = getLiveVoiceAdminConfig();
  if (!config) return false;
  try {
    await roomService(config).deleteRoom(await opaqueVoiceName("room", gameId));
    return true;
  } catch (error) {
    if (isProviderNotFound(error)) return true;
    return false;
  }
}

function isProviderNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return (
    candidate.status === 404 ||
    candidate.code === "not_found" ||
    candidate.code === "NOT_FOUND"
  );
}

function isProviderCredential(value: string): boolean {
  if (value.length < 8 || value.length > 512) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (/\s/u.test(character) || codePoint < 32 || codePoint === 127) return false;
  }
  return true;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function roomService(config: LiveVoiceProviderConfig): RoomServiceClient {
  const apiUrl = new URL(config.serverUrl);
  apiUrl.protocol = "https:";
  return new RoomServiceClient(
    apiUrl.toString().replace(/\/$/, ""),
    config.apiKey,
    config.apiSecret,
  );
}
