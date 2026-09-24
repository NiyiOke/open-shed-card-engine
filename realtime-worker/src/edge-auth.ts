import { NONCE_PATTERN, SOCKET_CAPABILITY_PATTERN, isOpaqueKey } from "./contracts";
import { verifyNotificationSignature, verifySocketCapability } from "./crypto";

export interface SocketRoute {
  room: string;
  expiresAt: number;
  capability: string;
}

export interface VerifiedNotification {
  timestamp: number;
  nonce: string;
}

export function parseSocketRoute(pathname: string): SocketRoute | null {
  const match = pathname.match(/^\/socket\/([A-Za-z0-9_-]{32})\/(\d{13})\/([A-Za-z0-9_-]{22})$/u);
  if (!match || !isOpaqueKey(match[1]) || !SOCKET_CAPABILITY_PATTERN.test(match[3])) return null;
  const expiresAt = Number(match[2]);
  if (!Number.isSafeInteger(expiresAt)) return null;
  return { room: match[1], expiresAt, capability: match[3] };
}

export function parseNotificationRoom(pathname: string): string | null {
  const match = pathname.match(/^\/notify\/([A-Za-z0-9_-]{32})$/u);
  return match && isOpaqueKey(match[1]) ? match[1] : null;
}

export async function authorizeSocketRoute(
  secret: string,
  route: SocketRoute,
  nowMs = Date.now(),
): Promise<boolean> {
  if (route.expiresAt < nowMs - 5_000 || route.expiresAt > nowMs + 35_000) return false;
  return verifySocketCapability(secret, route.room, route.expiresAt, route.capability).catch(() => false);
}

export async function authorizeNotification(
  secret: string,
  room: string,
  body: string,
  headers: Headers,
  nowMs = Date.now(),
): Promise<VerifiedNotification | null> {
  const timestampHeader = headers.get("Open-Shed-Realtime-Timestamp") ?? "";
  const nonce = headers.get("Open-Shed-Realtime-Nonce") ?? "";
  if (!/^\d{13}$/u.test(timestampHeader) || !NONCE_PATTERN.test(nonce)) return null;
  const timestamp = Number(timestampHeader);
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < nowMs - 30_000 ||
    timestamp > nowMs + 5_000
  ) return null;
  const signature = headers.get("Open-Shed-Realtime-Signature") ?? "";
  const verified = await verifyNotificationSignature(
    secret,
    { room, timestamp, nonce, body },
    signature,
  ).catch(() => false);
  return verified ? { timestamp, nonce } : null;
}
