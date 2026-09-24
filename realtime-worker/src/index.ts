import { DurableObject } from "cloudflare:workers";

import { PayloadTooLargeError, readBoundedUtf8Body } from "./bounded-body";
import { isAllowedOrigin, readConfig, type EnvConfig } from "./config";
import {
  MAX_PROTOCOL_BYTES,
  NONCE_PATTERN,
  SUBPROTOCOL,
  encodeServerFrame,
  isOpaqueKey,
  isTicketClaims,
  parseNotificationBody,
  parseWebSocketProtocols,
  type RealtimeTopic,
  type ServerFrame,
  type TicketClaims,
} from "./contracts";
import { sha256Base64Url, verifyTicket } from "./crypto";
import {
  authorizeNotification,
  authorizeSocketRoute,
  parseNotificationRoom,
  parseSocketRoute,
  type VerifiedNotification,
} from "./edge-auth";

interface Env {
  REALTIME_ROOMS: DurableObjectNamespace<RealtimeRoom>;
  OPEN_SHED_REALTIME_ENABLED?: string;
  OPEN_SHED_REALTIME_SHARED_SECRET?: string;
  ENVIRONMENT?: string;
  ALLOWED_ORIGINS?: string;
  MAX_CONNECTIONS_PER_ROOM?: string;
  MAX_READY_CONNECTIONS_PER_SUBJECT?: string;
  MAX_NOTIFICATIONS_PER_SECOND?: string;
  MAX_BUFFERED_BYTES?: string;
  HEARTBEAT_MS?: string;
}

interface ReadyAttachment {
  v: 1;
  state: "ready";
  subject: string;
  leaseUntil: number;
}

interface NotificationWindow {
  startedAtMs: number;
  count: number;
  resyncSent: boolean;
}

type AdmissionResult =
  | { status: "accepted"; client: WebSocket; server: WebSocket }
  | { status: "replay" }
  | { status: "room_quota" }
  | { status: "subject_quota" };

const encoder = new TextEncoder();
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};
const CLOSE = { leaseExpired: 4000 } as const;
const INTERNAL_HEADERS = {
  room: "X-Open-Shed-Internal-Room",
  subject: "X-Open-Shed-Internal-Subject",
  nonce: "X-Open-Shed-Internal-Ticket-Nonce",
  issuedAt: "X-Open-Shed-Internal-Ticket-Issued-At",
  expiresAt: "X-Open-Shed-Internal-Ticket-Expires-At",
  leaseUntil: "X-Open-Shed-Internal-Lease-Until",
  notificationTimestamp: "X-Open-Shed-Internal-Notification-Timestamp",
  notificationNonce: "X-Open-Shed-Internal-Notification-Nonce",
} as const;

function jsonResponse(status: number, body: Record<string, unknown>, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...NO_STORE_HEADERS, ...extraHeaders },
  });
}

function isUpgradeRequest(request: Request): boolean {
  return request.method === "GET" && request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

function hasRequiredSecret(env: Env): env is Env & { OPEN_SHED_REALTIME_SHARED_SECRET: string } {
  const secret = env.OPEN_SHED_REALTIME_SHARED_SECRET;
  if (typeof secret !== "string") return false;
  const bytes = encoder.encode(secret);
  if (bytes.byteLength < 32 || bytes.byteLength > 256) return false;
  return !Array.from(secret).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function socketInternalRequest(claims: TicketClaims): Request {
  return new Request("https://realtime-room.internal/socket", {
    method: "GET",
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": SUBPROTOCOL,
      [INTERNAL_HEADERS.room]: claims.room,
      [INTERNAL_HEADERS.subject]: claims.subject,
      [INTERNAL_HEADERS.nonce]: claims.nonce,
      [INTERNAL_HEADERS.issuedAt]: String(claims.issuedAt),
      [INTERNAL_HEADERS.expiresAt]: String(claims.expiresAt),
      [INTERNAL_HEADERS.leaseUntil]: String(claims.leaseUntil),
    },
  });
}

function notificationInternalRequest(
  room: string,
  body: string,
  authorization: VerifiedNotification,
): Request {
  return new Request("https://realtime-room.internal/notify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [INTERNAL_HEADERS.room]: room,
      [INTERNAL_HEADERS.notificationTimestamp]: String(authorization.timestamp),
      [INTERNAL_HEADERS.notificationNonce]: authorization.nonce,
    },
    body,
  });
}

function parseIntegerHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name) ?? "";
  if (!/^\d{13}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseInternalTicketClaims(request: Request, room: string): TicketClaims | null {
  const issuedAt = parseIntegerHeader(request.headers, INTERNAL_HEADERS.issuedAt);
  const expiresAt = parseIntegerHeader(request.headers, INTERNAL_HEADERS.expiresAt);
  const leaseUntil = parseIntegerHeader(request.headers, INTERNAL_HEADERS.leaseUntil);
  if (issuedAt === null || expiresAt === null || leaseUntil === null) return null;
  const claims: TicketClaims = {
    v: 1,
    room,
    subject: request.headers.get(INTERNAL_HEADERS.subject) ?? "",
    nonce: request.headers.get(INTERNAL_HEADERS.nonce) ?? "",
    issuedAt,
    expiresAt,
    leaseUntil,
  };
  return isTicketClaims(claims) ? claims : null;
}

async function handleSocket(
  request: Request,
  env: Env,
  config: EnvConfig,
  room: string,
  expiresAt: number,
  capability: string,
): Promise<Response> {
  if (!isUpgradeRequest(request)) return jsonResponse(426, { error: "websocket_upgrade_required" });
  if (!isAllowedOrigin(request.headers.get("Origin"), config.allowedOrigins)) {
    return jsonResponse(403, { error: "origin_not_allowed" });
  }
  if (new URL(request.url).search !== "") {
    return jsonResponse(400, { error: "query_parameters_not_allowed" });
  }

  let ticket: string;
  try {
    ticket = parseWebSocketProtocols(request.headers.get("Sec-WebSocket-Protocol"));
  } catch {
    return jsonResponse(426, { error: "unsupported_websocket_subprotocol" }, {
      "Sec-WebSocket-Protocol": SUBPROTOCOL,
    });
  }
  const routeAuthorized = await authorizeSocketRoute(
    env.OPEN_SHED_REALTIME_SHARED_SECRET!,
    { room, expiresAt, capability },
  );
  if (!routeAuthorized) return jsonResponse(404, { error: "not_found" });

  let claims: TicketClaims;
  try {
    claims = await verifyTicket(env.OPEN_SHED_REALTIME_SHARED_SECRET!, ticket);
  } catch {
    return jsonResponse(401, { error: "authorization_failed" });
  }
  if (claims.room !== room || claims.expiresAt !== expiresAt) {
    return jsonResponse(401, { error: "authorization_failed" });
  }

  // Capability, ticket, time, room, and Origin are all verified before a DO ID is resolved.
  const stub = env.REALTIME_ROOMS.get(env.REALTIME_ROOMS.idFromName(room));
  return stub.fetch(socketInternalRequest(claims));
}

async function handleNotification(request: Request, env: Env, room: string): Promise<Response> {
  if (request.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" }, { Allow: "POST" });
  if (request.headers.get("Content-Type") !== "application/json") {
    return jsonResponse(415, { error: "content_type_must_be_application_json" });
  }
  const contentLengthHeader = request.headers.get("Content-Length");
  if (contentLengthHeader === null) {
    return jsonResponse(411, { error: "content_length_required" });
  }
  const contentLength = Number(contentLengthHeader);
  if (!/^\d+$/u.test(contentLengthHeader) || !Number.isSafeInteger(contentLength)) {
    return jsonResponse(400, { error: "invalid_content_length" });
  }
  if (contentLength > MAX_PROTOCOL_BYTES) return jsonResponse(413, { error: "request_too_large" });

  let body: string;
  try {
    body = await readBoundedUtf8Body(request, MAX_PROTOCOL_BYTES);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return jsonResponse(413, { error: "request_too_large" });
    return jsonResponse(400, { error: "invalid_notification_body" });
  }
  if (encoder.encode(body).byteLength !== contentLength) {
    return jsonResponse(400, { error: "content_length_mismatch" });
  }
  try {
    parseNotificationBody(body);
  } catch {
    return jsonResponse(400, { error: "invalid_notification_body" });
  }
  const authorization = await authorizeNotification(
    env.OPEN_SHED_REALTIME_SHARED_SECRET!,
    room,
    body,
    request.headers,
  );
  if (authorization === null) return jsonResponse(401, { error: "invalid_signature" });

  // Body, signature, timestamp, and nonce are verified before a DO ID is resolved.
  const stub = env.REALTIME_ROOMS.get(env.REALTIME_ROOMS.idFromName(room));
  return stub.fetch(notificationInternalRequest(room, body, authorization));
}

export const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const config = readConfig(env);
    if (url.pathname === "/healthz" && request.method === "GET") {
      return jsonResponse(200, {
        service: "open-shed-realtime",
        enabled: config.enabled && hasRequiredSecret(env),
        protocol: SUBPROTOCOL,
      });
    }
    if (!config.enabled) return jsonResponse(503, { error: "realtime_disabled" });
    if (!hasRequiredSecret(env)) return jsonResponse(503, { error: "realtime_not_configured" });
    if (config.environment === "production" && url.protocol !== "https:") {
      return jsonResponse(400, { error: "https_required" });
    }

    const socket = parseSocketRoute(url.pathname);
    if (socket !== null) {
      return handleSocket(request, env, config, socket.room, socket.expiresAt, socket.capability);
    }
    const room = parseNotificationRoom(url.pathname);
    if (room !== null) return handleNotification(request, env, room);
    return jsonResponse(404, { error: "not_found" });
  },
} satisfies ExportedHandler<Env>;

export default worker;

export class RealtimeRoom extends DurableObject<Env> {
  private readonly config: EnvConfig;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = readConfig(env);
  }

  async fetch(request: Request): Promise<Response> {
    const room = request.headers.get(INTERNAL_HEADERS.room) ?? "";
    if (!isOpaqueKey(room)) return jsonResponse(400, { error: "invalid_internal_room" });
    const pathname = new URL(request.url).pathname;
    if (pathname === "/socket" && request.method === "GET") return this.acceptConnection(request, room);
    if (pathname === "/notify" && request.method === "POST") return this.notify(request);
    return jsonResponse(404, { error: "not_found" });
  }

  private async acceptConnection(request: Request, room: string): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse(426, { error: "websocket_upgrade_required" });
    }
    if (request.headers.get("Sec-WebSocket-Protocol") !== SUBPROTOCOL) {
      return jsonResponse(426, { error: "unsupported_websocket_subprotocol" });
    }
    const claims = parseInternalTicketClaims(request, room);
    const nowMs = Date.now();
    if (
      claims === null ||
      claims.issuedAt > nowMs + 5_000 ||
      claims.expiresAt < nowMs ||
      claims.leaseUntil <= nowMs
    ) {
      return jsonResponse(401, { error: "authorization_failed" });
    }

    const admission = await this.admitConnection(claims);
    if (admission.status === "replay") return jsonResponse(409, { error: "ticket_replayed" });
    if (admission.status === "room_quota") {
      return jsonResponse(429, { error: "room_connection_quota_exceeded" }, { "Retry-After": "5" });
    }
    if (admission.status === "subject_quota") {
      return jsonResponse(429, { error: "subject_connection_quota_exceeded" }, { "Retry-After": "5" });
    }

    this.send(admission.server, { v: 1, type: "ready", heartbeatMs: this.config.heartbeatMs });
    await this.scheduleEarlierAlarm(Math.min(claims.expiresAt, claims.leaseUntil));
    return new Response(null, {
      status: 101,
      webSocket: admission.client,
      headers: { "Sec-WebSocket-Protocol": SUBPROTOCOL },
    });
  }

  async webSocketMessage(socket: WebSocket): Promise<void> {
    socket.close(1008, "client messages are not supported");
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    socket.close(1011, "connection error");
  }

  async alarm(): Promise<void> {
    const nowMs = Date.now();
    let nextAlarmMs: number | null = null;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.readAttachment(socket);
      if (attachment === null) {
        socket.close(1011, "invalid connection state");
      } else if (attachment.leaseUntil <= nowMs) {
        socket.close(CLOSE.leaseExpired, "connection lease expired");
      } else {
        nextAlarmMs = this.earlier(nextAlarmMs, attachment.leaseUntil);
      }
    }
    const nonceEntries = await this.ctx.storage.list<number>({ prefix: "nonce:" });
    const expiredKeys: string[] = [];
    for (const [key, expiresAt] of nonceEntries) {
      if (expiresAt <= nowMs) expiredKeys.push(key);
      else nextAlarmMs = this.earlier(nextAlarmMs, expiresAt);
    }
    if (expiredKeys.length > 0) await this.ctx.storage.delete(expiredKeys);
    if (nextAlarmMs !== null) await this.ctx.storage.setAlarm(nextAlarmMs);
  }

  private async notify(request: Request): Promise<Response> {
    let body: string;
    try {
      body = await readBoundedUtf8Body(request, MAX_PROTOCOL_BYTES);
    } catch (error) {
      return jsonResponse(error instanceof PayloadTooLargeError ? 413 : 400, {
        error: error instanceof PayloadTooLargeError ? "request_too_large" : "invalid_notification_body",
      });
    }
    let topics: readonly RealtimeTopic[];
    try {
      topics = parseNotificationBody(body);
    } catch {
      return jsonResponse(400, { error: "invalid_notification_body" });
    }
    const nonce = request.headers.get(INTERNAL_HEADERS.notificationNonce) ?? "";
    const timestamp = parseIntegerHeader(request.headers, INTERNAL_HEADERS.notificationTimestamp);
    const nowMs = Date.now();
    if (
      !NONCE_PATTERN.test(nonce) ||
      timestamp === null ||
      timestamp < nowMs - 30_000 ||
      timestamp > nowMs + 5_000
    ) {
      return jsonResponse(400, { error: "invalid_internal_notification" });
    }
    if (!(await this.consumeNotificationNonce(nonce))) {
      return jsonResponse(409, { error: "notification_replayed" });
    }
    const rate = await this.takeNotificationSlot();
    if (!rate.allowed) {
      if (!rate.resyncAlreadySent) this.broadcast({ v: 1, type: "resync_required" });
      return jsonResponse(429, { error: "notification_rate_exceeded" }, { "Retry-After": "1" });
    }
    this.broadcast({ v: 1, type: "invalidate", topics });
    return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
  }

  private async consumeNotificationNonce(nonce: string): Promise<boolean> {
    const expiresAt = Date.now() + 35_000;
    const key = `nonce:notification:${await sha256Base64Url(nonce)}`;
    const accepted = await this.ctx.blockConcurrencyWhile(async () => {
      const existing = await this.ctx.storage.get<number>(key);
      if (existing !== undefined && existing >= Date.now()) return false;
      await this.ctx.storage.put(key, expiresAt);
      return true;
    });
    if (accepted) await this.scheduleEarlierAlarm(expiresAt);
    return accepted;
  }

  private async takeNotificationSlot(): Promise<{ allowed: boolean; resyncAlreadySent: boolean }> {
    const nowMs = Date.now();
    return this.ctx.blockConcurrencyWhile(async () => {
      const previous = await this.ctx.storage.get<NotificationWindow>("notification-window");
      const window = !previous || nowMs - previous.startedAtMs >= 1_000
        ? { startedAtMs: nowMs, count: 0, resyncSent: false }
        : previous;
      window.count += 1;
      const allowed = window.count <= this.config.maxNotificationsPerSecond;
      const resyncAlreadySent = window.resyncSent;
      if (!allowed) window.resyncSent = true;
      await this.ctx.storage.put("notification-window", window);
      return { allowed, resyncAlreadySent };
    });
  }

  private async admitConnection(claims: TicketClaims): Promise<AdmissionResult> {
    const key = `nonce:ticket:${await sha256Base64Url(claims.nonce)}`;
    return this.ctx.blockConcurrencyWhile(async () => {
      const existing = await this.ctx.storage.get<number>(key);
      if (existing !== undefined && existing >= Date.now()) return { status: "replay" };
      const sockets = this.ctx.getWebSockets();
      if (sockets.length >= this.config.maxConnections) return { status: "room_quota" };
      const readyForSubject = sockets.reduce((count, candidate) => {
        const attachment = this.readAttachment(candidate);
        return count + (attachment?.subject === claims.subject ? 1 : 0);
      }, 0);
      if (readyForSubject >= this.config.maxReadyConnectionsPerSubject) {
        return { status: "subject_quota" };
      }

      await this.ctx.storage.put(key, claims.expiresAt);
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server, [SUBPROTOCOL]);
      server.serializeAttachment({
        v: 1,
        state: "ready",
        subject: claims.subject,
        leaseUntil: claims.leaseUntil,
      } satisfies ReadyAttachment);
      return { status: "accepted", client, server };
    });
  }

  private broadcast(frame: ServerFrame): void {
    const nowMs = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.readAttachment(socket);
      if (attachment === null) continue;
      if (attachment.leaseUntil <= nowMs) {
        socket.close(CLOSE.leaseExpired, "connection lease expired");
        continue;
      }
      if (socket.bufferedAmount > this.config.maxBufferedBytes / 2) {
        this.sendResyncAndClose(socket);
        continue;
      }
      this.send(socket, frame);
    }
  }

  private sendResyncAndClose(socket: WebSocket): void {
    if (socket.bufferedAmount <= this.config.maxBufferedBytes) {
      this.send(socket, { v: 1, type: "resync_required" });
    }
    socket.close(1013, "reconnect and use polling fallback");
  }

  private send(socket: WebSocket, frame: ServerFrame): boolean {
    try {
      socket.send(encodeServerFrame(frame));
      return true;
    } catch {
      socket.close(1011, "send failed");
      return false;
    }
  }

  private readAttachment(socket: WebSocket): ReadyAttachment | null {
    try {
      const value = socket.deserializeAttachment() as Partial<ReadyAttachment> | null;
      if (
        !value ||
        value.v !== 1 ||
        value.state !== "ready" ||
        typeof value.subject !== "string" ||
        !isOpaqueKey(value.subject) ||
        typeof value.leaseUntil !== "number" ||
        !Number.isSafeInteger(value.leaseUntil)
      ) return null;
      return value as ReadyAttachment;
    } catch {
      return null;
    }
  }

  private async scheduleEarlierAlarm(timestampMs: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || timestampMs < existing) await this.ctx.storage.setAlarm(timestampMs);
  }

  private earlier(current: number | null, candidate: number): number {
    return current === null || candidate < current ? candidate : current;
  }
}
