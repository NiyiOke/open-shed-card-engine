import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import WebSocket from "ws";

import {
  issueRealtimeTicket,
  signRealtimeNotification,
} from "../lib/server/realtime-ticket.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIRECTORY = path.join(ROOT, "realtime-worker");
const WRANGLER_BIN = path.join(
  WORKER_DIRECTORY,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);
const SECRET = "local-realtime-acceptance-secret-32-bytes-minimum";
const SUBPROTOCOL = "open-shed-realtime-v1";
const RAW_GAME_ID = "private-game-acceptance-canary";
const RAW_SUBJECT = "private-user-acceptance-canary";
const FRAME_TIMEOUT_MS = 4_000;
const START_TIMEOUT_MS = 20_000;

function boundedLog(buffer, chunk) {
  const next = `${buffer}${String(chunk)}`;
  return next.length > 24_000 ? next.slice(-24_000) : next;
}

async function getFreePort() {
  const server = net.createServer();
  server.unref();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const { port } = address;
  server.close();
  await once(server, "close");
  return port;
}

function waitForSocketEvent(socket, event, timeoutMs = FRAME_TIMEOUT_MS, label = "socket") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(
        `Timed out waiting for WebSocket ${event} (${label}); readyState=${socket.readyState}.`,
      ));
    }, timeoutMs);
    const onEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(event, onEvent);
      if (event !== "error") socket.off("error", onError);
    };
    socket.once(event, onEvent);
    if (event !== "error") socket.once("error", onError);
  });
}

function nextTextFrame(socket, timeoutMs = FRAME_TIMEOUT_MS) {
  const frame = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for a WebSocket message."));
    }, timeoutMs);
    const onMessage = (data, isBinary) => {
      cleanup();
      if (isBinary) {
        reject(new Error("Expected a text WebSocket frame."));
        return;
      }
      resolve(String(data));
    };
    const onClose = (code, reason) => {
      cleanup();
      reject(new Error(`Socket closed before a frame (${code}: ${String(reason)}).`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.once("message", onMessage);
    socket.once("close", onClose);
  });
  void frame.catch(() => undefined);
  return frame;
}

async function expectNoFrame(socket, durationMs = 250) {
  await new Promise((resolve, reject) => {
    const onMessage = (data) => {
      cleanup();
      reject(new Error(`Unexpected frame received: ${String(data)}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, durationMs);
    socket.on("message", onMessage);
  });
}

function socketProtocols(ticket) {
  return [SUBPROTOCOL, `auth.${ticket}`];
}

async function openSocket(url, origin, ticket) {
  const socket = new WebSocket(url, socketProtocols(ticket), { origin });
  let upgradeStatus = null;
  let negotiatedProtocol = null;
  const ready = nextTextFrame(socket);
  // The close path can reject this before the HTTP-upgrade promise settles.
  // Attach a handler immediately so Node does not classify it as unhandled;
  // the awaited promise below still preserves the original failure.
  void ready.catch(() => undefined);
  socket.once("upgrade", (response) => {
    upgradeStatus = response.statusCode;
    negotiatedProtocol = response.headers["sec-websocket-protocol"];
  });
  await waitForSocketEvent(socket, "open");
  assert.equal(upgradeStatus, 101, "The transport must perform a real HTTP 101 upgrade.");
  assert.equal(negotiatedProtocol, SUBPROTOCOL);
  assert.equal(socket.protocol, SUBPROTOCOL);
  assert.deepEqual(JSON.parse(await ready), {
    v: 1,
    type: "ready",
    heartbeatMs: 10_000,
  });
  return socket;
}

async function expectUpgradeRejection(url, origin, protocols, expectedStatus) {
  const socket = new WebSocket(url, protocols, { origin });
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for HTTP ${expectedStatus}.`));
    }, FRAME_TIMEOUT_MS);
    const onUnexpectedResponse = (_request, response) => {
      const result = response.statusCode;
      response.resume();
      cleanup();
      resolve(result);
    };
    const onOpen = () => {
      cleanup();
      reject(new Error("A rejected WebSocket unexpectedly opened."));
    };
    const onError = () => {
      // ws emits an error after unexpected-response on some Node releases.
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("unexpected-response", onUnexpectedResponse);
      socket.off("open", onOpen);
      socket.off("error", onError);
    };
    socket.once("unexpected-response", onUnexpectedResponse);
    socket.once("open", onOpen);
    socket.on("error", onError);
  });
  socket.on("error", () => undefined);
  socket.terminate();
  assert.equal(status, expectedStatus);
}

async function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = waitForSocketEvent(socket, "close").catch(() => undefined);
  socket.close(1000, "acceptance complete");
  await closed;
}

async function postNotification(httpOrigin, notification) {
  return fetch(`${httpOrigin}/notify/${notification.room}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "open-shed-realtime-signature": notification.signature,
      "open-shed-realtime-timestamp": String(notification.timestamp),
      "open-shed-realtime-nonce": notification.nonce,
    },
    body: notification.body,
  });
}

async function postChunkedNotification(httpOrigin, notification, chunks) {
  const target = new URL(`/notify/${notification.room}`, httpOrigin);
  return new Promise((resolve, reject) => {
    let socketClosed = Promise.resolve();
    const request = http.request(target, {
      method: "POST",
      agent: false,
      headers: {
        connection: "close",
        "content-type": "application/json",
        "open-shed-realtime-signature": notification.signature,
        "open-shed-realtime-timestamp": String(notification.timestamp),
        "open-shed-realtime-nonce": notification.nonce,
      },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body = boundedLog(body, chunk);
      });
      response.once("end", () => {
        void socketClosed.then(() => resolve({ status: response.statusCode, body }));
      });
    });
    request.once("socket", (socket) => {
      socketClosed = socket.destroyed
        ? Promise.resolve()
        : once(socket, "close").then(() => undefined);
    });
    request.once("error", reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

async function createNotification(body, overrides = {}) {
  const ticket = await issueTicket();
  const pathParts = new URL(ticket.url).pathname.split("/").filter(Boolean);
  const room = pathParts[1];
  assert.match(room ?? "", /^[A-Za-z0-9_-]{32}$/u);
  const timestamp = overrides.timestamp ?? Date.now();
  const nonce = overrides.nonce ?? Buffer.from(
    crypto.getRandomValues(new Uint8Array(16)),
  ).toString("base64url");
  const signature = overrides.signature ?? await signRealtimeNotification(SECRET, {
    room,
    timestamp,
    nonce,
    body,
  });
  return { body, room, timestamp, nonce, signature };
}

async function notify(httpOrigin, topics, overrides) {
  const notification = await createNotification(JSON.stringify({ v: 1, topics }), overrides);
  const response = await postNotification(httpOrigin, notification);
  return { response, ...notification };
}

function issueTicket(overrides = {}) {
  const { websocketOrigin = "ws://realtime.invalid", ...inputOverrides } = overrides;
  return issueRealtimeTicket(
    {
      httpOrigin: "http://realtime.invalid",
      websocketOrigin,
      sharedSecret: SECRET,
    },
    {
      gameId: RAW_GAME_ID,
      authSubject: RAW_SUBJECT,
      ...inputOverrides,
    },
  );
}

function mutateLastCharacter(value) {
  const replacement = value.endsWith("A") ? "B" : "A";
  return `${value.slice(0, -1)}${replacement}`;
}

function assertContentFree(value, label) {
  assert.equal(value.includes(RAW_GAME_ID), false, `${label} leaked the game identifier.`);
  assert.equal(value.includes(RAW_SUBJECT), false, `${label} leaked the auth subject.`);
  assert.doesNotMatch(
    value,
    /displayName|profile|hand|cardId|message|content|gameId|userId/iu,
    `${label} contained an authoritative or private payload field.`,
  );
}

async function startFixturePage(port) {
  let authoritativeRevision = 1;
  const server = http.createServer((request, response) => {
    if (request.url === "/projection") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ revision: authoritativeRevision }));
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    response.end(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Open Shed realtime acceptance</title></head>
  <body>
    <main><h1>Realtime transport acceptance</h1><pre id="state">waiting</pre></main>
  </body>
</html>`);
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${port}`,
    incrementRevision() {
      authoritativeRevision += 1;
      return authoritativeRevision;
    },
    async stop() {
      server.close();
      await once(server, "close");
    },
  };
}

async function startWorker({ port, stateDirectory, allowedOrigin }) {
  const args = [
    WRANGLER_BIN,
    "dev",
    "--config",
    "wrangler.jsonc",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    stateDirectory,
    "--show-interactive-dev-session",
    "false",
    "--log-level",
    "warn",
    "--var",
    "OPEN_SHED_REALTIME_ENABLED:true",
    "--var",
    `OPEN_SHED_REALTIME_SHARED_SECRET:${SECRET}`,
    "--var",
    "ENVIRONMENT:development",
    "--var",
    `ALLOWED_ORIGINS:["${allowedOrigin}"]`,
    "--var",
    "MAX_CONNECTIONS_PER_ROOM:16",
    "--var",
    "MAX_READY_CONNECTIONS_PER_SUBJECT:3",
    "--var",
    "MAX_NOTIFICATIONS_PER_SECOND:2",
    "--var",
    "MAX_BUFFERED_BYTES:65536",
    "--var",
    "HEARTBEAT_MS:10000",
  ];
  const child = spawn(process.execPath, args, {
    cwd: WORKER_DIRECTORY,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs = boundedLog(logs, chunk);
  });
  child.stderr.on("data", (chunk) => {
    logs = boundedLog(logs, chunk);
  });

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Wrangler exited before readiness (${child.exitCode}).\n${logs}`);
    }
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) {
        const health = await response.json();
        assert.deepEqual(health, {
          service: "open-shed-realtime",
          enabled: true,
          protocol: SUBPROTOCOL,
        });
        return {
          child,
          logs: () => logs,
          httpOrigin: origin,
          websocketOrigin: `ws://127.0.0.1:${port}`,
        };
      }
    } catch {
      // Keep polling while workerd starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGKILL");
  throw new Error(`Wrangler did not become ready.\n${logs}`);
}

async function stopWorker(worker) {
  if (!worker || worker.child.exitCode !== null) return;
  worker.child.kill("SIGINT");
  const timer = setTimeout(() => worker.child.kill("SIGKILL"), 4_000);
  try {
    await once(worker.child, "exit");
  } finally {
    clearTimeout(timer);
  }
}

async function runBrowserProbe({ worker, fixture, artifactsDirectory }) {
  const ticket = await issueTicket({ websocketOrigin: worker.websocketOrigin });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const handshakeRequests = [];
  const handshakes = [];
  const socketUrls = [];
  const sentFrames = [];
  const receivedFrames = [];
  await cdp.send("Network.enable");
  cdp.on("Network.webSocketWillSendHandshakeRequest", (event) => {
    handshakeRequests.push(event);
  });
  cdp.on("Network.webSocketHandshakeResponseReceived", (event) => {
    handshakes.push(event);
  });
  page.on("websocket", (socket) => {
    socketUrls.push(socket.url());
    socket.on("framesent", (event) => sentFrames.push(event.payload));
    socket.on("framereceived", (event) => receivedFrames.push(event.payload));
  });

  try {
    await page.goto(fixture.origin, { waitUntil: "domcontentloaded" });
    await page.evaluate(({ url, protocol, signedTicket }) => {
      window.__realtimeAcceptance = { frames: [], projectionRevision: 0 };
      const state = document.querySelector("#state");
      const render = () => {
        state.textContent = JSON.stringify(window.__realtimeAcceptance, null, 2);
      };
      const refreshProjection = async () => {
        const response = await fetch("/projection", { cache: "no-store" });
        const payload = await response.json();
        window.__realtimeAcceptance.projectionRevision = payload.revision;
        render();
      };
      void refreshProjection();
      window.__realtimeAcceptance.poll = setInterval(refreshProjection, 100);
      const socket = new WebSocket(url, [protocol, `auth.${signedTicket}`]);
      window.__realtimeAcceptance.socket = socket;
      socket.addEventListener("open", () => {
        window.__realtimeAcceptance.negotiatedProtocol = socket.protocol;
        render();
      });
      socket.addEventListener("message", (event) => {
        window.__realtimeAcceptance.frames.push(event.data);
        render();
      });
      socket.addEventListener("close", (event) => {
        window.__realtimeAcceptance.close = { code: event.code, reason: event.reason };
        render();
      });
    }, { url: ticket.url, protocol: SUBPROTOCOL, signedTicket: ticket.ticket });

    await page.waitForFunction(() => {
      return window.__realtimeAcceptance.frames.some((frame) => {
        try {
          return JSON.parse(frame).type === "ready";
        } catch {
          return false;
        }
      });
    });
    // Cloudflare currently makes a hibernatable DO eligible after ten idle
    // seconds. Delivery after this pause covers the idle/rehydration path when
    // the local runtime elects to evict it.
    await new Promise((resolve) => setTimeout(resolve, 10_500));
    const framePromise = page.waitForFunction(() => {
      return window.__realtimeAcceptance.frames.some((frame) => {
        try {
          return JSON.parse(frame).type === "invalidate";
        } catch {
          return false;
        }
      });
    }, undefined, { timeout: FRAME_TIMEOUT_MS });
    const delivered = await notify(worker.httpOrigin, ["chat", "game"]);
    assert.equal(delivered.response.status, 202);
    try {
      await framePromise;
    } catch (error) {
      const connection = await page.evaluate(() => ({
        readyState: window.__realtimeAcceptance.socket?.readyState ?? null,
        protocol: window.__realtimeAcceptance.socket?.protocol ?? null,
        close: window.__realtimeAcceptance.close ?? null,
        frames: window.__realtimeAcceptance.frames,
      })).catch(() => null);
      const healthStatus = await fetch(`${worker.httpOrigin}/healthz`)
        .then((response) => response.status)
        .catch(() => null);
      const diagnosticPath = path.join(artifactsDirectory, "idle-delivery-failure.json");
      await mkdir(artifactsDirectory, { recursive: true });
      const diagnostic = `${JSON.stringify({
        notificationStatus: delivered.response.status,
        connection,
        observedFrames: receivedFrames,
        worker: {
          exitCode: worker.child.exitCode,
          healthStatus,
          logTail: worker.logs(),
        },
      }, null, 2)}\n`;
      assert.equal(diagnostic.includes(ticket.ticket), false, "Idle diagnostic leaked a signed ticket.");
      assert.equal(diagnostic.includes(RAW_GAME_ID), false, "Idle diagnostic leaked the room canary.");
      assert.equal(diagnostic.includes(RAW_SUBJECT), false, "Idle diagnostic leaked the identity canary.");
      await writeFile(diagnosticPath, diagnostic, "utf8");
      throw new Error(`Idle invalidation was not observed; diagnostic: ${diagnosticPath}`, {
        cause: error,
      });
    }

    const currentRevision = await page.evaluate(() => {
      return window.__realtimeAcceptance.projectionRevision;
    });
    const nextRevision = fixture.incrementRevision();
    await page.waitForFunction((expected) => {
      return window.__realtimeAcceptance.projectionRevision === expected;
    }, nextRevision);
    assert.equal(nextRevision, currentRevision + 1, "Safety polling must recover a dropped hint.");

    assert.equal(handshakeRequests.length, 1);
    assert.equal(handshakes.length, 1);
    assert.equal(handshakes[0].response.status, 101);
    assert.deepEqual(socketUrls, [ticket.url]);
    assert.equal(new URL(socketUrls[0]).search, "");
    assert.equal(sentFrames.length, 0, "Authentication must not use a client data frame.");
    const negotiatedProtocol = await page.evaluate(() => {
      return window.__realtimeAcceptance.negotiatedProtocol;
    });
    assert.equal(negotiatedProtocol, SUBPROTOCOL);
    const requestProtocolHeader = Object.entries(handshakeRequests[0].request.headers)
      .find(([name]) => name.toLowerCase() === "sec-websocket-protocol")?.[1] ?? "";
    const responseProtocolHeader = Object.entries(handshakes[0].response.headers)
      .find(([name]) => name.toLowerCase() === "sec-websocket-protocol")?.[1] ?? "";
    assert.equal(requestProtocolHeader, `${SUBPROTOCOL}, auth.${ticket.ticket}`);
    assert.equal(responseProtocolHeader, SUBPROTOCOL);
    assert.deepEqual(receivedFrames.map((frame) => JSON.parse(frame)), [
      { v: 1, type: "ready", heartbeatMs: 10_000 },
      { v: 1, type: "invalidate", topics: ["chat", "game"] },
    ]);
    assertContentFree(ticket.url, "Browser WebSocket URL");
    assertContentFree(requestProtocolHeader, "Browser protocol header");
    for (const frame of receivedFrames) assertContentFree(frame, "Browser server frame");

    await mkdir(artifactsDirectory, { recursive: true });
    const screenshotPath = path.join(artifactsDirectory, "browser-realtime-probe.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const capturePath = path.join(artifactsDirectory, "browser-transport-capture.json");
    const capture = {
      connectionUpgrade: {
        status: handshakes[0].response.status,
        offeredProtocols: [SUBPROTOCOL, "signed-authentication-token-redacted"],
        negotiatedProtocol,
      },
      clientDataFrameCount: sentFrames.length,
      serverFrames: receivedFrames.map((frame) => JSON.parse(frame)),
      safetyPollingRevision: nextRevision,
      privacyScan: {
        rawRoomCanaryAbsent: true,
        rawIdentityCanaryAbsent: true,
        signedTicketAbsent: true,
      },
    };
    const captureJson = `${JSON.stringify(capture, null, 2)}\n`;
    assertContentFree(captureJson, "Browser capture artifact");
    assert.equal(captureJson.includes(ticket.ticket), false);
    await writeFile(capturePath, captureJson, "utf8");
    return {
      screenshotPath,
      capturePath,
      browserTicket: ticket.ticket,
      handshakeRequests,
      handshakes,
      sentFrames,
      receivedFrames,
    };
  } finally {
    await page.evaluate(() => {
      clearInterval(window.__realtimeAcceptance?.poll);
      window.__realtimeAcceptance?.socket?.close(1000, "acceptance complete");
    }).catch(() => undefined);
    await browser.close();
  }
}

async function main() {
  const major = Number(process.versions.node.split(".")[0]);
  assert.ok(major >= 22, "Use the bundled Node 22+ runtime for realtime acceptance.");
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), "open-shed-realtime-acceptance-"));
  const stateDirectory = path.join(workDirectory, "miniflare-state");
  const artifactsDirectory = path.join(workDirectory, "artifacts");
  const workerPort = await getFreePort();
  const pagePort = await getFreePort();
  const fixture = await startFixturePage(pagePort);
  let worker;
  let authenticated;
  let preRestartLogs = "";
  const peers = [];

  try {
    worker = await startWorker({
      port: workerPort,
      stateDirectory,
      allowedOrigin: fixture.origin,
    });

    const firstTicket = await issueTicket({ websocketOrigin: worker.websocketOrigin });
    const firstUrl = new URL(firstTicket.url);
    assert.equal(firstUrl.search, "");
    assert.match(
      firstUrl.pathname,
      /^\/socket\/[A-Za-z0-9_-]{32}\/\d{13}\/[A-Za-z0-9_-]{22}$/u,
    );
    assertContentFree(firstTicket.url, "WebSocket URL");

    await expectUpgradeRejection(
      firstTicket.url,
      "https://wrong.example",
      socketProtocols(firstTicket.ticket),
      403,
    );
    await expectUpgradeRejection(
      `${firstTicket.url}?ticket=forbidden`,
      fixture.origin,
      socketProtocols(firstTicket.ticket),
      400,
    );
    await expectUpgradeRejection(firstTicket.url, fixture.origin, [SUBPROTOCOL], 426);

    const tamperedRoute = new URL(firstTicket.url);
    const tamperedParts = tamperedRoute.pathname.split("/");
    const capabilityIndex = tamperedParts.length - 1;
    tamperedParts[capabilityIndex] = mutateLastCharacter(tamperedParts[capabilityIndex]);
    tamperedRoute.pathname = tamperedParts.join("/");
    await expectUpgradeRejection(
      tamperedRoute.toString(),
      fixture.origin,
      socketProtocols(firstTicket.ticket),
      404,
    );

    const expiredTicket = await issueTicket({
      websocketOrigin: worker.websocketOrigin,
      now: Date.now() - 36_000,
    });
    await expectUpgradeRejection(
      expiredTicket.url,
      fixture.origin,
      socketProtocols(expiredTicket.ticket),
      404,
    );

    await expectUpgradeRejection(
      firstTicket.url,
      fixture.origin,
      socketProtocols(mutateLastCharacter(firstTicket.ticket)),
      401,
    );

    const wrongRoomTicket = await issueTicket({
      websocketOrigin: worker.websocketOrigin,
      gameId: "different-private-game-canary",
      nonceBytes: new Uint8Array(16).fill(7),
    });
    await expectUpgradeRejection(
      firstTicket.url,
      fixture.origin,
      socketProtocols(wrongRoomTicket.ticket),
      401,
    );

    authenticated = await openSocket(firstTicket.url, fixture.origin, firstTicket.ticket);

    const deliveredFrame = nextTextFrame(authenticated);
    const delivered = await notify(worker.httpOrigin, ["chat"]);
    assert.equal(delivered.response.status, 202);
    assert.deepEqual(JSON.parse(await deliveredFrame), {
      v: 1,
      type: "invalidate",
      topics: ["chat"],
    });
    const replayedNotify = await postNotification(worker.httpOrigin, delivered);
    assert.equal(replayedNotify.status, 409);
    await expectNoFrame(authenticated);

    const noInvalidation = expectNoFrame(authenticated);
    const rejectedNotify = await notify(worker.httpOrigin, ["game"], {
      signature: "A".repeat(43),
    });
    assert.equal(rejectedNotify.response.status, 401);
    await noInvalidation;

    const exactLimitBody = "x".repeat(1_024);
    const exactLimit = await createNotification(exactLimitBody);
    const exactLimitResult = await postNotification(worker.httpOrigin, exactLimit);
    assert.equal(
      exactLimitResult.status,
      400,
      "A declared 1024-byte schema-invalid body must reach validation, not overflow.",
    );

    const oversizedBody = "x".repeat(1_025);
    const oversized = await createNotification(oversizedBody);
    const oversizedResult = await postNotification(worker.httpOrigin, oversized);
    assert.equal(
      oversizedResult.status,
      413,
      "A declared body over 1024 bytes must be rejected before parsing.",
    );

    for (const [label, notification, chunks] of [
      ["exact-limit", exactLimit, [exactLimitBody.slice(0, 512), exactLimitBody.slice(512)]],
      ["oversized", oversized, [oversizedBody.slice(0, 512), oversizedBody.slice(512)]],
    ]) {
      const result = await postChunkedNotification(worker.httpOrigin, notification, chunks);
      assert.equal(
        result.status,
        411,
        `A ${label} chunked request without Content-Length must be rejected before streaming. ${result.body}`,
      );
    }
    await expectNoFrame(authenticated);

    const overflowNonceWasNotConsumed = await createNotification(
      JSON.stringify({ v: 1, topics: ["game"] }),
      { nonce: oversized.nonce },
    );
    const overflowRecoveryFrame = nextTextFrame(authenticated);
    const overflowRecovery = await postNotification(worker.httpOrigin, overflowNonceWasNotConsumed);
    assert.equal(overflowRecovery.status, 202);
    assert.equal(JSON.parse(await overflowRecoveryFrame).type, "invalidate");

    for (let index = 0; index < 2; index += 1) {
      const peerTicket = await issueTicket({ websocketOrigin: worker.websocketOrigin });
      peers.push(await openSocket(peerTicket.url, fixture.origin, peerTicket.ticket));
    }
    const quotaTicket = await issueTicket({ websocketOrigin: worker.websocketOrigin });
    await expectUpgradeRejection(
      quotaTicket.url,
      fixture.origin,
      socketProtocols(quotaTicket.ticket),
      429,
    );
    for (const peer of peers.splice(0)) await closeSocket(peer);

    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const rateFrames = [];
    const collectRateFrames = (data) => rateFrames.push(String(data));
    authenticated.on("message", collectRateFrames);
    const rateResults = await Promise.all([
      notify(worker.httpOrigin, ["chat"]),
      notify(worker.httpOrigin, ["game"]),
      notify(worker.httpOrigin, ["chat", "game"]),
    ]);
    assert.deepEqual(rateResults.map(({ response }) => response.status).sort(), [202, 202, 429]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    authenticated.off("message", collectRateFrames);
    const parsedRateFrames = rateFrames.map((frame) => JSON.parse(frame));
    assert.equal(parsedRateFrames.filter((frame) => frame.type === "invalidate").length, 2);
    assert.equal(parsedRateFrames.filter((frame) => frame.type === "resync_required").length, 1);
    for (const frame of rateFrames) assertContentFree(frame, "Rate-limit server frame");

    await closeSocket(authenticated);
    authenticated = undefined;
    preRestartLogs = worker.logs();
    await stopWorker(worker);
    worker = undefined;

    worker = await startWorker({
      port: workerPort,
      stateDirectory,
      allowedOrigin: fixture.origin,
    });
    await expectUpgradeRejection(
      firstTicket.url,
      fixture.origin,
      socketProtocols(firstTicket.ticket),
      409,
    );

    const restartObserverTicket = await issueTicket({ websocketOrigin: worker.websocketOrigin });
    const restartObserver = await openSocket(
      restartObserverTicket.url,
      fixture.origin,
      restartObserverTicket.ticket,
    );
    const persistentNotificationReplay = await postNotification(worker.httpOrigin, delivered);
    assert.equal(
      persistentNotificationReplay.status,
      409,
      "Consumed notification nonces must survive a local Worker restart.",
    );
    await expectNoFrame(restartObserver);
    await closeSocket(restartObserver);

    const browserProbe = await runBrowserProbe({ worker, fixture, artifactsDirectory });
    const workerLogs = `${preRestartLogs}\n${worker.logs()}`;
    assertContentFree(workerLogs, "Wrangler/workerd logs");
    assert.equal(workerLogs.includes(firstTicket.ticket), false, "Logs leaked a signed ticket.");
    assert.equal(workerLogs.includes(`auth.${firstTicket.ticket}`), false, "Logs leaked the auth protocol.");
    assert.equal(workerLogs.includes(browserProbe.browserTicket), false, "Logs leaked a browser ticket.");
    console.log("Realtime acceptance passed:");
    console.log("- real Node and Chromium HTTP 101 upgrades");
    console.log("- exact two-token pre-upgrade authentication and base-only protocol negotiation");
    console.log("- invalid, expired, tampered, wrong-room, replay, and fourth-subject gates before 101");
    console.log("- signed invalidations, strict Content-Length/body bounding, and resync-on-rate-limit");
    console.log("- persisted nonce replay defense across a local Worker restart");
    console.log("- zero browser client frames, content-free capture, idle delivery, and polling recovery");
    console.log(`Artifacts: ${artifactsDirectory}`);
    console.log(`Screenshot: ${browserProbe.screenshotPath}`);
    console.log(`Frame capture: ${browserProbe.capturePath}`);
  } catch (error) {
    if (worker) {
      console.error(worker.logs());
    }
    throw error;
  } finally {
    await closeSocket(authenticated).catch(() => undefined);
    for (const peer of peers) await closeSocket(peer).catch(() => undefined);
    await stopWorker(worker).catch(() => undefined);
    await fixture.stop().catch(() => undefined);
  }
}

await main();
