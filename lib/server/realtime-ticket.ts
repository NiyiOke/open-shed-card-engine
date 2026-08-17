import { GameRuleError } from "../game/errors";

export const REALTIME_PROTOCOL = "open-shed-realtime-v1";
export const REALTIME_TICKET_TTL_MS = 30_000;
export const REALTIME_AUTHORIZATION_LEASE_MS = 60_000;
export const REALTIME_MAX_FRAME_BYTES = 1_024;

export const REALTIME_ENV = Object.freeze({
  enabled: "OPEN_SHED_REALTIME_ENABLED",
  serverUrl: "OPEN_SHED_REALTIME_URL",
  sharedSecret: "OPEN_SHED_REALTIME_SHARED_SECRET",
} as const);

export type RealtimeEnvironment = Partial<
  Record<(typeof REALTIME_ENV)[keyof typeof REALTIME_ENV], string | undefined>
> & Readonly<{
  OPEN_SHED_ACCEPTANCE_ENVIRONMENT?: string | undefined;
}>;

export type RealtimeConfig = Readonly<{
  httpOrigin: string;
  websocketOrigin: string;
  sharedSecret: string;
}>;

export type RealtimeTicketClaims = Readonly<{
  v: 1;
  room: string;
  subject: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  leaseUntil: number;
}>;

export type RealtimeTicket = Readonly<{
  enabled: true;
  url: string;
  ticket: string;
  expiresAt: number;
}>;

const OPAQUE_KEY_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const SOCKET_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const textEncoder = new TextEncoder();

export function getRealtimeConfig(
  environment: RealtimeEnvironment = process.env as unknown as RealtimeEnvironment,
  nodeEnvironment: string | undefined = process.env.NODE_ENV,
): RealtimeConfig | null {
  if (environment[REALTIME_ENV.enabled] !== "true") return null;
  const rawUrl = environment[REALTIME_ENV.serverUrl];
  const sharedSecret = environment[REALTIME_ENV.sharedSecret];
  if (
    typeof rawUrl !== "string" ||
    typeof sharedSecret !== "string" ||
    sharedSecret.length < 32 ||
    sharedSecret.length > 256 ||
    hasControlCharacter(sharedSecret)
  ) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const localAcceptanceTransport =
    nodeEnvironment !== "production" &&
    environment.OPEN_SHED_ACCEPTANCE_ENVIRONMENT === "true" &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (
    (url.protocol !== "https:" && !localAcceptanceTransport) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    return null;
  }

  return Object.freeze({
    httpOrigin: url.origin,
    websocketOrigin: `${localAcceptanceTransport ? "ws" : "wss"}://${url.host}`,
    sharedSecret,
  });
}

export async function issueRealtimeTicket(
  config: RealtimeConfig,
  input: Readonly<{
    gameId: string;
    authSubject: string;
    now?: number;
    nonceBytes?: Uint8Array;
  }>,
): Promise<RealtimeTicket> {
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new GameRuleError(
      "REALTIME_UNAVAILABLE",
      "Real-time updates are temporarily unavailable.",
      503,
    );
  }
  const nonceBytes = input.nonceBytes ?? crypto.getRandomValues(new Uint8Array(16));
  if (nonceBytes.byteLength !== 16) {
    throw new Error("Realtime ticket nonces must contain exactly 16 bytes.");
  }
  const room = await opaqueRealtimeKey(
    config.sharedSecret,
    "room",
    input.gameId,
  );
  const subject = await opaqueRealtimeKey(
    config.sharedSecret,
    "subject",
    input.authSubject,
  );
  const claims: RealtimeTicketClaims = Object.freeze({
    v: 1,
    room,
    subject,
    nonce: base64UrlEncode(nonceBytes),
    issuedAt: now,
    expiresAt: now + REALTIME_TICKET_TTL_MS,
    leaseUntil: now + REALTIME_AUTHORIZATION_LEASE_MS,
  });
  const encodedClaims = base64UrlEncode(
    textEncoder.encode(JSON.stringify(claims)),
  );
  const signature = await signRealtimeValue(
    config.sharedSecret,
    `${REALTIME_PROTOCOL}.${encodedClaims}`,
  );
  const ticket = `${encodedClaims}.${signature}`;
  const socketCapability = await opaqueRealtimeSocketCapability(
    config.sharedSecret,
    room,
    claims.expiresAt,
  );
  const url = `${config.websocketOrigin}/socket/${room}/${claims.expiresAt}/${socketCapability}`;
  if (textEncoder.encode(ticket).byteLength > REALTIME_MAX_FRAME_BYTES - 40) {
    throw new Error("Realtime ticket exceeded the protocol frame limit.");
  }
  return Object.freeze({ enabled: true, url, ticket, expiresAt: claims.expiresAt });
}

export async function verifyRealtimeTicket(
  config: Pick<RealtimeConfig, "sharedSecret">,
  ticket: string,
  now = Date.now(),
): Promise<RealtimeTicketClaims | null> {
  if (
    typeof ticket !== "string" ||
    textEncoder.encode(ticket).byteLength > REALTIME_MAX_FRAME_BYTES - 40
  ) {
    return null;
  }
  const parts = ticket.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expectedSignature = await signRealtimeValue(
    config.sharedSecret,
    `${REALTIME_PROTOCOL}.${parts[0]}`,
  );
  if (!constantTimeEqual(parts[1], expectedSignature)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      base64UrlDecode(parts[0]),
    )) as unknown;
  } catch {
    return null;
  }
  if (!isRealtimeTicketClaims(parsed)) return null;
  if (parsed.issuedAt > now + 5_000 || parsed.expiresAt < now) return null;
  return Object.freeze({ ...parsed });
}

export async function signRealtimeNotification(
  sharedSecret: string,
  input: Readonly<{
    room: string;
    timestamp: number;
    nonce: string;
    body: string;
  }>,
): Promise<string> {
  if (
    !OPAQUE_KEY_PATTERN.test(input.room) ||
    !Number.isSafeInteger(input.timestamp) ||
    input.timestamp < 0 ||
    !NONCE_PATTERN.test(input.nonce)
  ) {
    throw new Error("Invalid real-time notification signing input.");
  }
  return signRealtimeValue(
    sharedSecret,
    `${REALTIME_PROTOCOL}.notify.${input.room}.${input.timestamp}.${input.nonce}.${input.body}`,
  );
}

export async function opaqueRealtimeRoomKey(
  sharedSecret: string,
  gameId: string,
): Promise<string> {
  return opaqueRealtimeKey(sharedSecret, "room", gameId);
}

export async function opaqueRealtimeSocketCapability(
  sharedSecret: string,
  room: string,
  expiresAt: number,
): Promise<string> {
  if (
    !OPAQUE_KEY_PATTERN.test(room) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < 0
  ) {
    throw new Error("Invalid real-time socket route input.");
  }
  const signature = await hmacBytes(
    sharedSecret,
    `${REALTIME_PROTOCOL}.route.${room}.${expiresAt}`,
  );
  const capability = base64UrlEncode(signature.slice(0, 16));
  if (!SOCKET_CAPABILITY_PATTERN.test(capability)) {
    throw new Error("Invalid real-time socket capability.");
  }
  return capability;
}

async function opaqueRealtimeKey(
  sharedSecret: string,
  namespace: "room" | "subject",
  value: string,
): Promise<string> {
  const signature = await hmacBytes(
    sharedSecret,
    `${REALTIME_PROTOCOL}.${namespace}.${value}`,
  );
  return base64UrlEncode(signature.slice(0, 24));
}

async function signRealtimeValue(
  sharedSecret: string,
  value: string,
): Promise<string> {
  return base64UrlEncode(await hmacBytes(sharedSecret, value));
}

async function hmacBytes(sharedSecret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(sharedSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, textEncoder.encode(value)),
  );
}

function isRealtimeTicketClaims(value: unknown): value is RealtimeTicketClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, [
    "v",
    "room",
    "subject",
    "nonce",
    "issuedAt",
    "expiresAt",
    "leaseUntil",
  ])) return false;
  return (
    record.v === 1 &&
    typeof record.room === "string" &&
    OPAQUE_KEY_PATTERN.test(record.room) &&
    typeof record.subject === "string" &&
    OPAQUE_KEY_PATTERN.test(record.subject) &&
    typeof record.nonce === "string" &&
    NONCE_PATTERN.test(record.nonce) &&
    Number.isSafeInteger(record.issuedAt) &&
    Number.isSafeInteger(record.expiresAt) &&
    Number.isSafeInteger(record.leaseUntil) &&
    (record.issuedAt as number) >= 0 &&
    record.expiresAt === (record.issuedAt as number) + REALTIME_TICKET_TTL_MS &&
    record.leaseUntil ===
      (record.issuedAt as number) + REALTIME_AUTHORIZATION_LEASE_MS
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid base64url");
  const padding = (4 - (value.length % 4)) % 4;
  const binary = atob(
    `${value.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat(padding)}`,
  );
  const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64UrlEncode(decoded) !== value) throw new Error("Non-canonical base64url");
  return decoded;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |=
      (leftBytes[index % Math.max(1, leftBytes.byteLength)] ?? 0) ^
      (rightBytes[index % Math.max(1, rightBytes.byteLength)] ?? 0);
  }
  return difference === 0;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}
