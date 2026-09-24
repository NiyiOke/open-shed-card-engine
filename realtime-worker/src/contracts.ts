export const SUBPROTOCOL = "open-shed-realtime-v1" as const;
export const PROTOCOL_VERSION = 1 as const;
export const MAX_PROTOCOL_BYTES = 1_024;
export const TICKET_TTL_MS = 30_000;
export const AUTHORIZATION_LEASE_MS = 60_000;

export const OPAQUE_KEY_PATTERN = /^[A-Za-z0-9_-]{32}$/;
export const SOCKET_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export type RealtimeTopic = "game" | "chat";

export interface TicketClaims {
  v: 1;
  room: string;
  subject: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  leaseUntil: number;
}

export type ServerFrame =
  | { v: 1; type: "ready"; heartbeatMs: number }
  | { v: 1; type: "invalidate"; topics: readonly RealtimeTopic[] }
  | { v: 1; type: "resync_required" };

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function parseBoundedJson(value: string): unknown {
  if (encoder.encode(value).byteLength > MAX_PROTOCOL_BYTES) throw new Error("protocol_frame_too_large");
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("invalid_json");
  }
}

export function parseWebSocketProtocols(value: string | null): string {
  if (value === null || encoder.encode(value).byteLength > MAX_PROTOCOL_BYTES) {
    throw new Error("invalid_websocket_protocols");
  }
  const protocols = value.split(",").map((protocol) => protocol.replace(/^[\t ]+|[\t ]+$/gu, ""));
  if (
    protocols.length !== 2 ||
    protocols.some((protocol) => protocol.length === 0) ||
    new Set(protocols).size !== protocols.length ||
    protocols[0] !== SUBPROTOCOL
  ) {
    throw new Error("invalid_websocket_protocols");
  }
  const match = protocols[1].match(/^auth\.([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u);
  if (!match) throw new Error("invalid_websocket_protocols");
  return match[1];
}

export function parseNotificationBody(value: string): readonly RealtimeTopic[] {
  const parsed = parseBoundedJson(value);
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["v", "topics"]) || parsed.v !== PROTOCOL_VERSION) {
    throw new Error("invalid_notification_body");
  }
  if (
    !Array.isArray(parsed.topics) ||
    parsed.topics.length < 1 ||
    parsed.topics.length > 2 ||
    parsed.topics.some((topic) => topic !== "game" && topic !== "chat") ||
    new Set(parsed.topics).size !== parsed.topics.length
  ) {
    throw new Error("invalid_notification_topics");
  }
  const topics = [...parsed.topics] as RealtimeTopic[];
  if (topics.join(",") !== [...topics].sort().join(",")) throw new Error("notification_topics_not_sorted");
  return topics;
}

export function encodeServerFrame(frame: ServerFrame): string {
  const encoded = JSON.stringify(frame);
  if (encoder.encode(encoded).byteLength > MAX_PROTOCOL_BYTES) throw new Error("server_frame_too_large");
  return encoded;
}

export function isOpaqueKey(value: string): boolean {
  return OPAQUE_KEY_PATTERN.test(value);
}

export function isTicketClaims(value: unknown): value is TicketClaims {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["v", "room", "subject", "nonce", "issuedAt", "expiresAt", "leaseUntil"])
  ) {
    return false;
  }
  return (
    value.v === PROTOCOL_VERSION &&
    typeof value.room === "string" &&
    OPAQUE_KEY_PATTERN.test(value.room) &&
    typeof value.subject === "string" &&
    OPAQUE_KEY_PATTERN.test(value.subject) &&
    typeof value.nonce === "string" &&
    NONCE_PATTERN.test(value.nonce) &&
    Number.isSafeInteger(value.issuedAt) &&
    (value.issuedAt as number) >= 0 &&
    Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt === (value.issuedAt as number) + TICKET_TTL_MS &&
    Number.isSafeInteger(value.leaseUntil) &&
    value.leaseUntil === (value.issuedAt as number) + AUTHORIZATION_LEASE_MS
  );
}
