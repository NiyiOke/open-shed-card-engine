import assert from "node:assert/strict";
import test from "node:test";
import {
  createRealtimeController,
  parseRealtimeTicketResponse,
  REALTIME_SUBPROTOCOL,
  type RealtimeClientState,
  type RealtimeTopic,
} from "../app/components/realtime-client";

const VALID_TICKET = Object.freeze({
  enabled: true as const,
  url: `wss://realtime.example.workers.dev/socket/${"A".repeat(32)}/8000000000000/${"B".repeat(22)}`,
  ticket: "ticket." + "x".repeat(80),
  expiresAt: 8_000_000_000_000,
});

class FakeSocket {
  readyState = 0;
  protocol = REALTIME_SUBPROTOCOL;
  binaryType: BinaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closes.push({ code, reason });
  }

  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  message(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function flushMicrotasks() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

test("ticket parser is exact and allows only opaque WSS socket URLs", () => {
  assert.deepEqual(parseRealtimeTicketResponse({ enabled: false }), { enabled: false });
  assert.equal(parseRealtimeTicketResponse({ enabled: false, secret: "canary" }), null);
  assert.deepEqual(parseRealtimeTicketResponse(VALID_TICKET), VALID_TICKET);
  for (const value of [
    { ...VALID_TICKET, profileId: "canary" },
    { ...VALID_TICKET, url: "https://realtime.example/socket/" + "A".repeat(32) },
    { ...VALID_TICKET, url: "wss://realtime.example/socket/" + "A".repeat(32) },
    { ...VALID_TICKET, url: "wss://realtime.example/socket/raw-game-id" },
    { ...VALID_TICKET, url: VALID_TICKET.url + "?ticket=secret" },
    { ...VALID_TICKET, ticket: "short" },
  ]) {
    assert.equal(parseRealtimeTicketResponse(value), null);
  }
});

test("controller authenticates during upgrade, catches up before live, and coalesces hints", async () => {
  const socket = new FakeSocket();
  const states: RealtimeClientState[] = [];
  const invalidations: RealtimeTopic[][] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const controller = createRealtimeController({
    requestTicket: async () => VALID_TICKET,
    createSocket(url, protocols) {
      assert.equal(url, VALID_TICKET.url);
      assert.deepEqual(protocols, [
        REALTIME_SUBPROTOCOL,
        `auth.${VALID_TICKET.ticket}`,
      ]);
      return socket;
    },
    onInvalidate: async (topics) => {
      invalidations.push([...topics]);
    },
    onStateChange: (state) => states.push(state),
    setTimer(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(timer) {
      timers.delete(timer as unknown as number);
    },
  });

  controller.start();
  await flushMicrotasks();
  assert.equal(controller.getState(), "connecting");
  assert.equal(socket.binaryType, "arraybuffer");
  socket.open();
  assert.deepEqual(socket.sent, []);

  socket.message(JSON.stringify({ v: 1, type: "ready", heartbeatMs: 25_000 }));
  await flushMicrotasks();
  assert.deepEqual(invalidations, [["game", "chat"]]);
  assert.equal(controller.getState(), "live");

  socket.message(JSON.stringify({ v: 1, type: "invalidate", topics: ["chat"] }));
  socket.message(JSON.stringify({ v: 1, type: "invalidate", topics: ["game", "chat"] }));
  assert.equal(invalidations.length, 1);
  const debounce = [...timers.values()][0];
  assert.ok(debounce);
  debounce();
  await flushMicrotasks();
  assert.deepEqual(invalidations[1], ["chat", "game"]);
  controller.stop();
  assert.equal(controller.getState(), "fallback");
});

test("malformed, binary, and oversized server frames close fail-closed", async () => {
  for (const data of [
    JSON.stringify({ v: 1, type: "invalidate", topics: ["chat"], body: "secret" }),
    new ArrayBuffer(4),
    "x".repeat(1_025),
  ]) {
    const socket = new FakeSocket();
    const controller = createRealtimeController({
      requestTicket: async () => VALID_TICKET,
      createSocket: () => socket,
      onInvalidate: () => undefined,
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
      random: () => 0.5,
    });
    controller.start();
    await flushMicrotasks();
    socket.open();
    socket.message(data);
    assert.ok(socket.closes.length >= 1);
    assert.ok([1008, 1009].includes(socket.closes[0]?.code ?? 0));
    controller.stop();
  }
});

test("a socket that negotiates any other protocol is rejected", async () => {
  const socket = new FakeSocket();
  socket.protocol = "auth.should-never-be-echoed";
  const controller = createRealtimeController({
    requestTicket: async () => VALID_TICKET,
    createSocket: () => socket,
    onInvalidate: () => undefined,
    setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => undefined,
  });
  controller.start();
  await flushMicrotasks();
  socket.open();
  assert.equal(socket.closes[0]?.code, 1008);
  controller.stop();
});

test("disabled service stays disabled and disposal wins a deferred ticket race", async () => {
  let socketCount = 0;
  const disabled = createRealtimeController({
    requestTicket: async () => ({ enabled: false }),
    createSocket: () => {
      socketCount += 1;
      return new FakeSocket();
    },
    onInvalidate: () => undefined,
  });
  disabled.start();
  await flushMicrotasks();
  assert.equal(disabled.getState(), "disabled");
  assert.equal(socketCount, 0);

  const pending = deferred<unknown>();
  const raced = createRealtimeController({
    requestTicket: () => pending.promise,
    createSocket: () => {
      socketCount += 1;
      return new FakeSocket();
    },
    onInvalidate: () => undefined,
  });
  raced.start();
  raced.stop();
  pending.resolve(VALID_TICKET);
  await flushMicrotasks();
  assert.equal(socketCount, 0);
  assert.equal(raced.getState(), "fallback");
});

test("a stale handshake timer cannot close a newer live socket", async () => {
  const first = new FakeSocket();
  const second = new FakeSocket();
  const sockets = [first, second];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let catchups = 0;
  const controller = createRealtimeController({
    requestTicket: async () => VALID_TICKET,
    createSocket: () => sockets.shift()!,
    onInvalidate: async () => {
      catchups += 1;
    },
    random: () => 0,
    setTimer(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(timer) {
      timers.delete(timer as unknown as number);
    },
  });

  controller.start();
  await flushMicrotasks();
  const staleHandshake = [...timers.values()][0];
  assert.ok(staleHandshake);
  first.onclose?.({} as CloseEvent);
  const reconnect = [...timers.values()][0];
  assert.ok(reconnect);
  reconnect();
  await flushMicrotasks();
  second.open();
  second.message(JSON.stringify({ v: 1, type: "ready", heartbeatMs: 25_000 }));
  await flushMicrotasks();
  assert.equal(controller.getState(), "live");
  assert.equal(catchups, 1);

  staleHandshake();
  assert.deepEqual(second.closes, []);
  assert.equal(controller.getState(), "live");
  controller.stop();
});

test("manual reconnect clears invalidation work from the old socket epoch", async () => {
  const first = new FakeSocket();
  const second = new FakeSocket();
  const sockets = [first, second];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const invalidations: RealtimeTopic[][] = [];
  const controller = createRealtimeController({
    requestTicket: async () => VALID_TICKET,
    createSocket: () => sockets.shift()!,
    onInvalidate: async (topics) => {
      invalidations.push([...topics]);
    },
    setTimer(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(timer) {
      timers.delete(timer as unknown as number);
    },
  });

  controller.start();
  await flushMicrotasks();
  first.open();
  first.message(JSON.stringify({ v: 1, type: "ready", heartbeatMs: 25_000 }));
  await flushMicrotasks();
  first.message(JSON.stringify({ v: 1, type: "invalidate", topics: ["chat"] }));
  const staleDebounce = [...timers.values()][0];
  assert.ok(staleDebounce);

  controller.reconnectNow();
  await flushMicrotasks();
  second.open();
  second.message(JSON.stringify({ v: 1, type: "ready", heartbeatMs: 25_000 }));
  await flushMicrotasks();
  staleDebounce();
  await flushMicrotasks();

  assert.deepEqual(invalidations, [["game", "chat"], ["game", "chat"]]);
  assert.equal(controller.getState(), "live");
  controller.stop();
});
