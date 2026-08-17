export const REALTIME_SUBPROTOCOL = "open-shed-realtime-v1";
export const REALTIME_FRAME_LIMIT_BYTES = 1_024;

export type RealtimeTopic = "game" | "chat";
export type RealtimeClientState = "disabled" | "connecting" | "live" | "fallback";

export type RealtimeTicketResponse =
  | Readonly<{ enabled: false }>
  | Readonly<{ enabled: true; url: string; ticket: string; expiresAt: number }>;

type SocketLike = {
  readonly readyState: number;
  readonly protocol: string;
  binaryType: BinaryType;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  close(code?: number, reason?: string): void;
};

export type RealtimeControllerOptions = Readonly<{
  requestTicket: () => Promise<unknown>;
  onInvalidate: (topics: readonly RealtimeTopic[]) => Promise<void> | void;
  onStateChange?: (state: RealtimeClientState) => void;
  createSocket?: (url: string, protocols: readonly string[]) => SocketLike;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  random?: () => number;
}>;

export type RealtimeController = Readonly<{
  start(): void;
  reconnectNow(): void;
  stop(): void;
  getState(): RealtimeClientState;
}>;

const HANDSHAKE_TIMEOUT_MS = 3_000;
const INVALIDATION_DEBOUNCE_MS = 75;
const MAX_RECONNECT_DELAY_MS = 30_000;
const OPAQUE_ROOM_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const SOCKET_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const encoder = new TextEncoder();

export function parseRealtimeTicketResponse(value: unknown): RealtimeTicketResponse | null {
  if (!isRecord(value)) return null;
  if (value.enabled === false) {
    return hasExactKeys(value, ["enabled"])
      ? Object.freeze({ enabled: false })
      : null;
  }
  if (
    value.enabled !== true ||
    !hasExactKeys(value, ["enabled", "url", "ticket", "expiresAt"]) ||
    typeof value.url !== "string" ||
    typeof value.ticket !== "string" ||
    value.ticket.length < 40 ||
    encoder.encode(value.ticket).byteLength > REALTIME_FRAME_LIMIT_BYTES - 40 ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) <= 0
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return null;
  }
  const localAcceptanceSocket =
    url.protocol === "ws:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
    typeof window !== "undefined" &&
    window.location.hostname === "localhost";
  const pathParts = url.pathname.split("/").filter(Boolean);
  if (
    (url.protocol !== "wss:" && !localAcceptanceSocket) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    pathParts.length !== 4 ||
    pathParts[0] !== "socket" ||
    !OPAQUE_ROOM_PATTERN.test(pathParts[1] ?? "") ||
    !/^[0-9]{13}$/.test(pathParts[2] ?? "") ||
    Number(pathParts[2]) !== value.expiresAt ||
    !SOCKET_CAPABILITY_PATTERN.test(pathParts[3] ?? "")
  ) {
    return null;
  }
  return Object.freeze({
    enabled: true,
    url: url.toString(),
    ticket: value.ticket,
    expiresAt: value.expiresAt as number,
  });
}

export function createRealtimeController(
  options: RealtimeControllerOptions,
): RealtimeController {
  const createSocket = options.createSocket ?? ((url, protocols) => {
    return new WebSocket(url, [...protocols]);
  });
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const random = options.random ?? Math.random;
  let state: RealtimeClientState = "fallback";
  let stopped = true;
  let lifecycle = 0;
  let attempts = 0;
  let socket: SocketLike | null = null;
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let invalidationTimer: ReturnType<typeof setTimeout> | null = null;
  const queuedTopics = new Set<RealtimeTopic>();

  const setState = (next: RealtimeClientState) => {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next);
  };
  const clearHandshake = () => {
    if (handshakeTimer !== null) clearTimer(handshakeTimer);
    handshakeTimer = null;
  };
  const clearReconnect = () => {
    if (reconnectTimer !== null) clearTimer(reconnectTimer);
    reconnectTimer = null;
  };
  const closeSocket = () => {
    const current = socket;
    socket = null;
    if (!current) return;
    current.onopen = null;
    current.onmessage = null;
    current.onerror = null;
    current.onclose = null;
    try {
      current.close(1000, "client reset");
    } catch {
      // Already closed.
    }
  };
  const flushInvalidations = async (epoch: number) => {
    invalidationTimer = null;
    if (stopped || epoch !== lifecycle || !queuedTopics.size) return;
    const topics = [...queuedTopics].sort();
    queuedTopics.clear();
    try {
      await options.onInvalidate(topics);
    } catch {
      if (!stopped && epoch === lifecycle) {
        setState("fallback");
      }
    }
  };
  const queueInvalidations = (topics: readonly RealtimeTopic[], epoch: number) => {
    for (const topic of topics) queuedTopics.add(topic);
    if (invalidationTimer !== null) return;
    invalidationTimer = setTimer(() => {
      void flushInvalidations(epoch);
    }, INVALIDATION_DEBOUNCE_MS);
  };
  const scheduleReconnect = (epoch: number) => {
    if (stopped || epoch !== lifecycle || reconnectTimer !== null) return;
    setState("fallback");
    const base = Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** Math.min(attempts, 6));
    attempts += 1;
    const jitter = Math.max(0, Math.min(1, random()));
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      void connect(epoch);
    }, Math.floor(base * jitter));
  };
  const failConnection = (epoch: number, code = 1012, reason = "reconnect") => {
    if (epoch !== lifecycle) return;
    clearHandshake();
    const current = socket;
    socket = null;
    if (current) {
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      try {
        current.close(code, reason);
      } catch {
        // Already closed.
      }
    }
    scheduleReconnect(epoch);
  };
  const connect = async (epoch: number) => {
    if (stopped || epoch !== lifecycle || socket) return;
    setState("connecting");
    let parsed: RealtimeTicketResponse | null = null;
    try {
      parsed = parseRealtimeTicketResponse(await options.requestTicket());
    } catch {
      // Polling remains active while the ticket route or companion is down.
    }
    if (stopped || epoch !== lifecycle) return;
    if (!parsed) {
      scheduleReconnect(epoch);
      return;
    }
    if (!parsed.enabled) {
      setState("disabled");
      return;
    }
    if (parsed.expiresAt <= Date.now()) {
      scheduleReconnect(epoch);
      return;
    }

    let nextSocket: SocketLike;
    try {
      nextSocket = createSocket(parsed.url, [
        REALTIME_SUBPROTOCOL,
        `auth.${parsed.ticket}`,
      ]);
    } catch {
      scheduleReconnect(epoch);
      return;
    }
    socket = nextSocket;
    nextSocket.binaryType = "arraybuffer";
    handshakeTimer = setTimer(() => {
      if (socket === nextSocket) {
        failConnection(epoch, 1013, "handshake timeout");
      }
    }, HANDSHAKE_TIMEOUT_MS);
    nextSocket.onopen = () => {
      if (nextSocket.protocol !== REALTIME_SUBPROTOCOL) {
        failConnection(epoch, 1008, "invalid negotiated protocol");
      }
    };
    nextSocket.onmessage = (event) => {
      if (stopped || epoch !== lifecycle || socket !== nextSocket) return;
      if (typeof event.data !== "string") {
        failConnection(epoch, 1008, "text frames required");
        return;
      }
      if (encoder.encode(event.data).byteLength > REALTIME_FRAME_LIMIT_BYTES) {
        failConnection(epoch, 1009, "frame too large");
        return;
      }
      const frame = parseServerFrame(event.data);
      if (!frame) {
        failConnection(epoch, 1008, "invalid frame");
        return;
      }
      if (frame.type === "ready") {
        clearHandshake();
        void Promise.resolve(options.onInvalidate(["game", "chat"]))
          .then(() => {
            if (!stopped && epoch === lifecycle && socket === nextSocket) {
              attempts = 0;
              setState("live");
            }
          })
          .catch(() => failConnection(epoch));
        return;
      }
      if (frame.type === "resync_required") {
        queueInvalidations(["game", "chat"], epoch);
        return;
      }
      queueInvalidations(frame.topics, epoch);
    };
    nextSocket.onerror = () => failConnection(epoch);
    nextSocket.onclose = () => {
      if (socket === nextSocket) {
        clearHandshake();
        socket = null;
      }
      scheduleReconnect(epoch);
    };
  };

  return Object.freeze({
    start() {
      if (!stopped) return;
      stopped = false;
      lifecycle += 1;
      attempts = 0;
      void connect(lifecycle);
    },
    reconnectNow() {
      if (stopped) return;
      lifecycle += 1;
      clearHandshake();
      clearReconnect();
      if (invalidationTimer !== null) clearTimer(invalidationTimer);
      invalidationTimer = null;
      closeSocket();
      queuedTopics.clear();
      void connect(lifecycle);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      lifecycle += 1;
      clearHandshake();
      clearReconnect();
      if (invalidationTimer !== null) clearTimer(invalidationTimer);
      invalidationTimer = null;
      queuedTopics.clear();
      closeSocket();
      setState("fallback");
    },
    getState() {
      return state;
    },
  });
}

type ServerFrame =
  | Readonly<{ v: 1; type: "ready"; heartbeatMs: number }>
  | Readonly<{ v: 1; type: "invalidate"; topics: readonly RealtimeTopic[] }>
  | Readonly<{ v: 1; type: "resync_required" }>;

function parseServerFrame(value: string): ServerFrame | null {
  let frame: unknown;
  try {
    frame = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(frame) || frame.v !== 1) return null;
  if (frame.type === "ready") {
    if (
      !hasExactKeys(frame, ["v", "type", "heartbeatMs"]) ||
      !Number.isSafeInteger(frame.heartbeatMs) ||
      (frame.heartbeatMs as number) < 10_000 ||
      (frame.heartbeatMs as number) > 60_000
    ) return null;
    return { v: 1, type: "ready", heartbeatMs: frame.heartbeatMs as number };
  }
  if (frame.type === "resync_required") {
    return hasExactKeys(frame, ["v", "type"])
      ? { v: 1, type: "resync_required" }
      : null;
  }
  if (
    frame.type !== "invalidate" ||
    !hasExactKeys(frame, ["v", "type", "topics"]) ||
    !Array.isArray(frame.topics) ||
    frame.topics.length < 1 ||
    frame.topics.length > 2 ||
    frame.topics.some((topic) => topic !== "game" && topic !== "chat") ||
    new Set(frame.topics).size !== frame.topics.length
  ) return null;
  return { v: 1, type: "invalidate", topics: [...frame.topics] as RealtimeTopic[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
