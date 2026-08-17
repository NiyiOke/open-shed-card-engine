import {
  MAX_PROTOCOL_BYTES,
  type TicketClaims,
  isTicketClaims,
} from "./contracts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const SIGNING_DOMAIN = "open-shed-realtime-v1";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid_base64url");
  const remainder = value.length % 4;
  if (remainder === 1) throw new Error("invalid_base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - remainder) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("invalid_base64url");
  }
  const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (toBase64Url(decoded) !== value) throw new Error("invalid_base64url");
  return decoded;
}

function assertSecret(secret: string): void {
  const bytes = encoder.encode(secret);
  if (bytes.byteLength < 32 || bytes.byteLength > 256) throw new Error("invalid_shared_secret");
  for (const character of secret) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) throw new Error("invalid_shared_secret");
  }
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  assertSecret(secret);
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await importHmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

async function verifyHmac(secret: string, value: string, signature: Uint8Array): Promise<boolean> {
  const key = await importHmacKey(secret);
  const signatureCopy = new Uint8Array(signature.byteLength);
  signatureCopy.set(signature);
  return crypto.subtle.verify("HMAC", key, signatureCopy, encoder.encode(value));
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toBase64Url(new Uint8Array(digest));
}

export async function deriveOpaqueKey(
  secret: string,
  namespace: "room" | "subject",
  value: string,
): Promise<string> {
  if (value.length === 0) throw new Error("opaque_key_input_required");
  const digest = await hmac(secret, `${SIGNING_DOMAIN}.${namespace}.${value}`);
  return toBase64Url(digest.slice(0, 24));
}

export async function deriveSocketCapability(
  secret: string,
  room: string,
  expiresAt: number,
): Promise<string> {
  if (
    !/^[A-Za-z0-9_-]{32}$/u.test(room) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < 0
  ) throw new Error("invalid_socket_capability_input");
  const digest = await hmac(secret, `${SIGNING_DOMAIN}.route.${room}.${expiresAt}`);
  return toBase64Url(digest.slice(0, 16));
}

export async function verifySocketCapability(
  secret: string,
  room: string,
  expiresAt: number,
  capability: string,
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{22}$/u.test(capability)) return false;
  const expected = encoder.encode(await deriveSocketCapability(secret, room, expiresAt));
  const actual = encoder.encode(capability);
  let difference = expected.byteLength ^ actual.byteLength;
  const length = Math.max(expected.byteLength, actual.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |=
      (expected[index % Math.max(1, expected.byteLength)] ?? 0) ^
      (actual[index % Math.max(1, actual.byteLength)] ?? 0);
  }
  return difference === 0;
}

export async function signTicket(secret: string, claims: TicketClaims): Promise<string> {
  if (!isTicketClaims(claims)) throw new Error("invalid_ticket_claims");
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = toBase64Url(await hmac(secret, `${SIGNING_DOMAIN}.${payload}`));
  const ticket = `${payload}.${signature}`;
  if (encoder.encode(ticket).byteLength > MAX_PROTOCOL_BYTES - 40) throw new Error("ticket_too_large");
  return ticket;
}

export async function verifyTicket(secret: string, ticket: string, nowMs = Date.now()): Promise<TicketClaims> {
  if (encoder.encode(ticket).byteLength > MAX_PROTOCOL_BYTES - 40) throw new Error("invalid_ticket");
  const parts = ticket.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("invalid_ticket");
  let signature: Uint8Array;
  try {
    signature = fromBase64Url(parts[1]);
  } catch {
    throw new Error("invalid_ticket");
  }
  if (
    signature.byteLength !== 32 ||
    !(await verifyHmac(secret, `${SIGNING_DOMAIN}.${parts[0]}`, signature))
  ) {
    throw new Error("invalid_ticket");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(fromBase64Url(parts[0]))) as unknown;
  } catch {
    throw new Error("invalid_ticket");
  }
  if (!isTicketClaims(parsed) || parsed.issuedAt > nowMs + 5_000 || parsed.expiresAt < nowMs) {
    throw new Error("invalid_or_expired_ticket");
  }
  return parsed;
}

export interface NotificationSigningInput {
  room: string;
  timestamp: number;
  nonce: string;
  body: string;
}

function notificationSigningValue(input: NotificationSigningInput): string {
  if (
    !/^[A-Za-z0-9_-]{32}$/u.test(input.room) ||
    !Number.isSafeInteger(input.timestamp) ||
    input.timestamp < 0 ||
    !/^[A-Za-z0-9_-]{22}$/u.test(input.nonce)
  ) {
    throw new Error("invalid_notification_signing_input");
  }
  return `${SIGNING_DOMAIN}.notify.${input.room}.${input.timestamp}.${input.nonce}.${input.body}`;
}

export async function signNotification(
  secret: string,
  input: NotificationSigningInput,
): Promise<string> {
  return toBase64Url(await hmac(secret, notificationSigningValue(input)));
}

export async function verifyNotificationSignature(
  secret: string,
  input: NotificationSigningInput,
  signatureHeader: string,
): Promise<boolean> {
  let signature: Uint8Array;
  try {
    signature = fromBase64Url(signatureHeader);
  } catch {
    return false;
  }
  if (signature.byteLength !== 32) return false;
  let signingValue: string;
  try {
    signingValue = notificationSigningValue(input);
  } catch {
    return false;
  }
  return verifyHmac(secret, signingValue, signature);
}
