import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE_BIN = process.execPath;
const WRANGLER_BIN = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const REALTIME_WRANGLER_BIN = path.join(
  ROOT,
  "realtime-worker",
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);
const VINEXT_BIN = path.join(ROOT, "node_modules", "vinext", "dist", "cli.js");
const SECRET = "local-sites-integration-realtime-secret-32-bytes";
const SUBPROTOCOL = "open-shed-realtime-v1";
const START_TIMEOUT_MS = 30_000;
const PROMPT_FETCH_MS = 3_000;
const POLLING_RECOVERY_MS = 32_000;
const runToken = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;

const actors = {
  host: { id: `rt-host-${runToken}`.slice(0, 40), name: "Realtime Host" },
  guest: { id: `rt-guest-${runToken}`.slice(0, 40), name: "Realtime Guest" },
};
let commandSequence = 0;

function nextCommandId(label) {
  commandSequence += 1;
  return `${label}-${runToken}-${commandSequence}`.slice(0, 80);
}

function boundedLog(buffer, chunk) {
  const next = `${buffer}${String(chunk)}`;
  return next.length > 48_000 ? next.slice(-48_000) : next;
}

async function getFreePort() {
  const server = net.createServer();
  server.unref();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  server.close();
  await once(server, "close");
  return address.port;
}

async function waitFor(check, timeoutMs, label, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Timed out waiting for ${label}.${lastError ? ` Last error: ${String(lastError)}` : ""}`,
  );
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGINT");
  const timer = setTimeout(() => child.kill("SIGKILL"), 4_000);
  try {
    await once(child, "exit");
  } finally {
    clearTimeout(timer);
  }
}

async function startRealtimeWorker({ port, stateDirectory, allowedOrigin }) {
  const args = [
    REALTIME_WRANGLER_BIN,
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
    "info",
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
    "MAX_NOTIFICATIONS_PER_SECOND:100",
    "--var",
    "MAX_BUFFERED_BYTES:65536",
    "--var",
    "HEARTBEAT_MS:10000",
  ];
  const child = spawn(NODE_BIN, args, {
    cwd: path.join(ROOT, "realtime-worker"),
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
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Worker exited ${child.exitCode}.\n${logs}`);
    const response = await fetch(`${origin}/healthz`).catch(() => null);
    return response?.ok;
  }, START_TIMEOUT_MS, "realtime worker readiness");
  return { child, logs: () => logs, port };
}

async function startHttpBridge({ port, upstreamPort }) {
  const stats = {
    notificationRequests: [],
    droppedNotifications: 0,
    websocketUpgrades: 0,
  };
  let dropNextNotification = false;
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://bridge.invalid").pathname;
    if (
      request.method !== "POST" ||
      !/^\/notify\/[A-Za-z0-9_-]{32}$/u.test(pathname)
    ) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not_found"}');
      return;
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
      total += chunk.length;
      if (total > 2_048) {
        response.writeHead(413);
        response.end();
        return;
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const record = {
      at: Date.now(),
      body,
      contentLength: request.headers["content-length"] ?? null,
      transferEncoding: request.headers["transfer-encoding"] ?? null,
      upstreamStatus: null,
      dropped: false,
    };
    stats.notificationRequests.push(record);
    if (dropNextNotification) {
      dropNextNotification = false;
      stats.droppedNotifications += 1;
      record.dropped = true;
      response.writeHead(503, { connection: "close", "content-length": "0" });
      response.end();
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (name === "host" || name === "connection" || value === undefined) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const upstream = await fetch(`http://127.0.0.1:${upstreamPort}${request.url}`, {
      method: "POST",
      headers,
      body,
    });
    record.upstreamStatus = upstream.status;
    const upstreamBody = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      "cache-control": upstream.headers.get("cache-control") ?? "no-store",
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "content-length": String(upstreamBody.length),
    });
    response.end(upstreamBody);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, client, head) => {
    stats.websocketUpgrades += 1;
    const upstream = net.createConnection({ host: "127.0.0.1", port: upstreamPort });
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    upstream.once("connect", () => {
      const headerLines = [];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        headerLines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
      }
      upstream.write(
        `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headerLines.join("\r\n")}\r\n\r\n`,
      );
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.once("error", () => client.destroy());
    client.once("error", () => upstream.destroy());
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    stats,
    dropNext() {
      assert.equal(dropNextNotification, false, "Only one dropped notification may be armed.");
      dropNextNotification = true;
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close");
    },
  };
}

async function migrateFreshD1({ persistenceDirectory, workDirectory }) {
  const configPath = path.join(workDirectory, "wrangler-d1-acceptance.json");
  await writeFile(configPath, JSON.stringify({
    name: "open-shed-sites-realtime-acceptance",
    main: path.join(ROOT, "worker", "index.ts"),
    compatibility_date: "2026-05-22",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [{
      binding: "DB",
      database_name: "site-creator-d1",
      database_id: "00000000-0000-4000-8000-000000000000",
      migrations_dir: path.join(ROOT, "drizzle"),
    }],
  }, null, 2));
  const output = execFileSync(NODE_BIN, [
    WRANGLER_BIN,
    "d1",
    "migrations",
    "apply",
    "site-creator-d1",
    "--local",
    "--persist-to",
    persistenceDirectory,
    "--config",
    configPath,
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
      WRANGLER_LOG_PATH: path.join(workDirectory, "wrangler-d1.log"),
    },
    encoding: "utf8",
  });
  assert.match(output, /0011_dazzling_hemingway\.sql/u);
  return output;
}

async function startSitesServer({ port, persistenceDirectory, realtimeUrl, workDirectory }) {
  const child = spawn(NODE_BIN, [VINEXT_BIN, "dev", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NO_COLOR: "1",
      OPEN_SHED_ACCEPTANCE_PERSIST_PATH: persistenceDirectory,
      MINIFLARE_REGISTRY_PATH: path.join(workDirectory, "miniflare-registry"),
      WRANGLER_LOG_PATH: path.join(workDirectory, "wrangler-sites.log"),
      WRANGLER_WRITE_LOGS: "false",
      OPEN_SHED_ACCEPTANCE_ENVIRONMENT: "true",
      OPEN_SHED_V15_COMMUNICATION_ENABLED: "true",
      OPEN_SHED_V15_FREE_TEXT_ENABLED: "true",
      OPEN_SHED_REALTIME_ENABLED: "true",
      OPEN_SHED_REALTIME_URL: realtimeUrl,
      OPEN_SHED_REALTIME_SHARED_SECRET: SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs = boundedLog(logs, chunk);
  });
  child.stderr.on("data", (chunk) => {
    logs = boundedLog(logs, chunk);
  });
  const baseUrl = `http://localhost:${port}`;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Sites exited ${child.exitCode}.\n${logs}`);
    const response = await fetch(`${baseUrl}/api/session`, {
      headers: devHeaders(actors.host, baseUrl),
    }).catch(() => null);
    return response?.ok;
  }, START_TIMEOUT_MS, "Sites server readiness", 100);
  return { child, logs: () => logs, baseUrl };
}

function devHeaders(actor, baseUrl, json = false) {
  return {
    Origin: baseUrl,
    "X-Open-Shed-Dev-User": actor.id,
    "X-Open-Shed-Dev-Name": actor.name,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function apiRequest(baseUrl, actor, pathname, { method, body } = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: devHeaders(actor, baseUrl, body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
  });
  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    // Assertion messages retain the raw body.
  }
  return { status: response.status, body: parsed, raw };
}

async function createPrivateTable(baseUrl) {
  const created = await apiRequest(baseUrl, actors.host, "/api/games", {
    body: { commandId: nextCommandId("create"), nickname: "Realtime Host" },
  });
  assert.equal(created.status, 201, created.raw);
  const joined = await apiRequest(baseUrl, actors.guest, "/api/games/join", {
    body: {
      commandId: nextCommandId("join"),
      joinCode: created.body.view.joinCode,
      nickname: "Realtime Guest",
    },
  });
  assert.equal(joined.status, 200, joined.raw);
  assert.equal(joined.body.view.gameId, created.body.view.gameId);
  return {
    gameId: created.body.view.gameId,
    hostPlayerId: created.body.view.players.find((player) => player.isSelf).playerId,
    guestPlayerId: joined.body.view.players.find((player) => player.isSelf).playerId,
  };
}

async function currentGame(baseUrl, actor, gameId) {
  const response = await apiRequest(
    baseUrl,
    actor,
    `/api/games/${encodeURIComponent(gameId)}?afterRevision=0`,
  );
  assert.equal(response.status, 200, response.raw);
  return response.body.view;
}

async function setReady(baseUrl, actor, gameId, ready, commandId = nextCommandId("ready")) {
  const view = await currentGame(baseUrl, actor, gameId);
  const body = {
    commandId,
    expectedRevision: view.revision,
    command: { type: "set_ready", ready },
  };
  const response = await apiRequest(
    baseUrl,
    actor,
    `/api/games/${encodeURIComponent(gameId)}/commands`,
    { body },
  );
  assert.equal(response.status, 200, response.raw);
  return { response, body };
}

function installIdentity(context, actor) {
  return context.addInitScript((identity) => {
    localStorage.setItem("open-shed-dev-identity", JSON.stringify(identity));
  }, actor);
}

async function renderGame(page) {
  const serialized = await page.evaluate(() => window.render_game_to_text?.() ?? null);
  return serialized ? JSON.parse(serialized) : null;
}

function installPresenceSuppression(page, gameId) {
  return page.route(`**/api/games/${gameId}/presence`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "ROUTE_NOT_FOUND", message: "Suppressed for deterministic acceptance." },
      }),
    });
  });
}

async function openGameBrowser(browser, baseUrl, actor, gameId, label) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await installIdentity(context, actor);
  const page = await context.newPage();
  await installPresenceSuppression(page, gameId);
  const traffic = [];
  const sockets = [];
  const consoleErrors = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() !== "GET") return;
    if (url.pathname === `/api/games/${gameId}`) {
      traffic.push({ kind: "game", at: Date.now(), afterRevision: url.searchParams.get("afterRevision") });
    } else if (url.pathname === `/api/games/${gameId}/messages`) {
      traffic.push({ kind: "chat", at: Date.now() });
    }
  });
  page.on("websocket", (socket) => {
    const record = { url: socket.url(), sent: [], received: [] };
    sockets.push(record);
    socket.on("framesent", (frame) => record.sent.push(frame.payload));
    socket.on("framereceived", (frame) => record.received.push(frame.payload));
  });
  page.on("pageerror", (error) => consoleErrors.push({
    at: Date.now(),
    message: `${label}: ${String(error)}`,
  }));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push({
      at: Date.now(),
      message: `${label}: ${message.text()}`,
    });
  });
  const cdp = await context.newCDPSession(page);
  const connectionRequests = [];
  const connectionResponses = [];
  const sentProtocolFrames = [];
  await cdp.send("Network.enable");
  cdp.on("Network.webSocketWillSendHandshakeRequest", (event) => connectionRequests.push(event));
  cdp.on("Network.webSocketHandshakeResponseReceived", (event) => connectionResponses.push(event));
  cdp.on("Network.webSocketFrameSent", (event) => sentProtocolFrames.push({
    at: Date.now(),
    opcode: event.response.opcode,
    payloadData: event.response.payloadData,
  }));
  await page.goto(`${baseUrl}/?game=${encodeURIComponent(gameId)}`, { waitUntil: "domcontentloaded" });
  await waitFor(async () => {
    const state = await renderGame(page);
    return state?.game?.id === gameId && state.realtime === "live" ? state : null;
  }, START_TIMEOUT_MS, `${label} live game shell`, 100);
  return {
    context,
    page,
    traffic,
    sockets,
    consoleErrors,
    connectionRequests,
    connectionResponses,
    sentProtocolFrames,
  };
}

function countTraffic(session, kind, after = 0) {
  return session.traffic.filter((entry) => entry.kind === kind && entry.at >= after).length;
}

function latestTraffic(session, kind, after) {
  return session.traffic.find((entry) => entry.kind === kind && entry.at >= after) ?? null;
}

function assertDeliveredNotification(record, expectedTopics) {
  assert.ok(record, `Expected a ${expectedTopics.join("+")} notification request.`);
  assert.equal(record.dropped, false);
  assert.equal(record.transferEncoding, null, "Sites must not send notify as chunked transfer.");
  assert.equal(
    record.contentLength,
    String(Buffer.byteLength(record.body)),
    "Sites/workerd must supply the exact notify Content-Length.",
  );
  assert.equal(record.upstreamStatus, 202, "The realtime Worker must accept the signed notify.");
  assert.deepEqual(JSON.parse(record.body), { v: 1, topics: expectedTopics });
}

function findNotification(records, expectedTopics, after) {
  return records.find((record) => {
    if (record.at < after || record.dropped) return false;
    try {
      return JSON.stringify(JSON.parse(record.body)?.topics) === JSON.stringify(expectedTopics);
    } catch {
      return false;
    }
  });
}

async function main() {
  assert.ok(Number(process.versions.node.split(".")[0]) >= 22);
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), "open-shed-sites-realtime-"));
  const artifactsDirectory = path.join(workDirectory, "artifacts");
  const d1Persistence = path.join(workDirectory, "fresh-d1-state");
  const realtimePersistence = path.join(workDirectory, "realtime-state");
  await mkdir(artifactsDirectory, { recursive: true });
  const appPort = await getFreePort();
  const workerPort = await getFreePort();
  const tlsPort = await getFreePort();
  const appOrigin = `http://localhost:${appPort}`;
  let realtimeWorker;
  let tlsBridge;
  let sites;
  let browser;
  let hostSession;
  let guestSession;
  const summary = {
    runToken,
    freshD1: true,
    scenarios: {},
    privacy: {},
  };

  try {
    const migrationOutput = await migrateFreshD1({
      persistenceDirectory: d1Persistence,
      workDirectory,
    });
    assert.match(migrationOutput, /0011_dazzling_hemingway\.sql/u);
    realtimeWorker = await startRealtimeWorker({
      port: workerPort,
      stateDirectory: realtimePersistence,
      allowedOrigin: appOrigin,
    });
    tlsBridge = await startHttpBridge({ port: tlsPort, upstreamPort: workerPort });
    sites = await startSitesServer({
      port: appPort,
      persistenceDirectory: d1Persistence,
      realtimeUrl: `http://localhost:${tlsPort}`,
      workDirectory,
    });
    const table = await createPrivateTable(sites.baseUrl);
    tlsBridge.stats.notificationRequests.length = 0;

    browser = await chromium.launch({ headless: true });
    hostSession = await openGameBrowser(browser, sites.baseUrl, actors.host, table.gameId, "host");
    guestSession = await openGameBrowser(browser, sites.baseUrl, actors.guest, table.gameId, "guest");
    tlsBridge.stats.notificationRequests.length = 0;

    const chatCommandId = nextCommandId("chat");
    const chatMutationAt = Date.now();
    const chat = await apiRequest(
      sites.baseUrl,
      actors.host,
      `/api/games/${encodeURIComponent(table.gameId)}/messages`,
      {
        body: { commandId: chatCommandId, kind: "phrase", contentId: "nice_play" },
      },
    );
    assert.equal(chat.status, 200, chat.raw);
    assert.equal(chat.body.replayed, false);
    await waitFor(async () => {
      const state = await renderGame(guestSession.page);
      return state?.game?.chat?.latest?.some((message) => message.contentId === "nice_play");
    }, PROMPT_FETCH_MS, "peer chat authoritative fetch");
    const chatFetch = latestTraffic(guestSession, "chat", chatMutationAt);
    assert.ok(chatFetch, "A chat invalidation must trigger a peer message GET.");
    const chatNotification = findNotification(
      tlsBridge.stats.notificationRequests,
      ["chat"],
      chatMutationAt,
    );
    assertDeliveredNotification(chatNotification, ["chat"]);
    summary.notificationTransport = {
      contentLength: chatNotification.contentLength,
      actualBytes: Buffer.byteLength(chatNotification.body),
      transferEncoding: chatNotification.transferEncoding,
      upstreamStatus: chatNotification.upstreamStatus,
    };
    summary.scenarios.chatPrompt = { latencyMs: chatFetch.at - chatMutationAt };

    const gameMutationAt = Date.now();
    const readyOne = await setReady(sites.baseUrl, actors.host, table.gameId, true);
    await waitFor(async () => {
      const state = await renderGame(guestSession.page);
      return state?.game?.revision >= readyOne.response.body.view.revision ? state : null;
    }, PROMPT_FETCH_MS, "peer game authoritative fetch");
    const gameFetch = latestTraffic(guestSession, "game", gameMutationAt);
    assert.ok(gameFetch, "A game invalidation must trigger a peer game GET.");
    assertDeliveredNotification(
      findNotification(tlsBridge.stats.notificationRequests, ["game"], gameMutationAt),
      ["game"],
    );
    summary.scenarios.gamePrompt = { latencyMs: gameFetch.at - gameMutationAt };

    const notifyCountBeforeReplay = tlsBridge.stats.notificationRequests.length;
    const replay = await apiRequest(
      sites.baseUrl,
      actors.host,
      `/api/games/${encodeURIComponent(table.gameId)}/commands`,
      { body: readyOne.body },
    );
    assert.equal(replay.status, 200, replay.raw);
    assert.equal(replay.body.replayed, true);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(
      tlsBridge.stats.notificationRequests.length,
      notifyCountBeforeReplay,
      "A replayed command must not notify the companion.",
    );
    summary.scenarios.commandReplay = { replayed: true, notificationSent: false };

    let heldResponse = null;
    let releaseHeld;
    let resolveHeld;
    const heldStarted = new Promise((resolve) => {
      resolveHeld = resolve;
    });
    const heldRelease = new Promise((resolve) => {
      releaseHeld = resolve;
    });
    let intercepted = false;
    const staleGameTrafficBefore = countTraffic(guestSession, "game");
    await guestSession.page.route(`**/api/games/${table.gameId}?afterRevision=*`, async (route) => {
      if (intercepted) {
        await route.continue();
        return;
      }
      intercepted = true;
      heldResponse = await route.fetch();
      resolveHeld();
      await heldRelease;
      await route.fulfill({ response: heldResponse });
    });
    await guestSession.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await heldStarted;
    const staleBaseline = await renderGame(guestSession.page);
    const staleMutation = await setReady(sites.baseUrl, actors.host, table.gameId, false);
    releaseHeld();
    await waitFor(async () => {
      const state = await renderGame(guestSession.page);
      return state?.game?.revision >= staleMutation.response.body.view.revision ? state : null;
    }, PROMPT_FETCH_MS, "trailing authoritative catch-up after stale GET");
    await guestSession.page.unroute(`**/api/games/${table.gameId}?afterRevision=*`);
    assert.ok(
      countTraffic(guestSession, "game") >= staleGameTrafficBefore + 2,
      "The held stale GET must be followed by a trailing game GET.",
    );
    const afterStale = await renderGame(guestSession.page);
    assert.equal(afterStale.realtime, "live");
    summary.scenarios.trailingCatchUp = {
      baselineRevision: staleBaseline.game.revision,
      convergedRevision: afterStale.game.revision,
      trailingFetchObserved: true,
    };

    await new Promise((resolve) => setTimeout(
      resolve,
      Math.max(0, chatMutationAt + 2_200 - Date.now()),
    ));
    tlsBridge.dropNext();
    const droppedChatAt = Date.now();
    const droppedChat = await apiRequest(
      sites.baseUrl,
      actors.host,
      `/api/games/${encodeURIComponent(table.gameId)}/messages`,
      {
        body: {
          commandId: nextCommandId("dropped-chat"),
          kind: "phrase",
          contentId: "good_game",
        },
      },
    );
    assert.equal(droppedChat.status, 200, droppedChat.raw);
    assert.equal(tlsBridge.stats.droppedNotifications, 1);
    await waitFor(async () => {
      const state = await renderGame(guestSession.page);
      return state?.game?.chat?.latest?.some((message) => message.contentId === "good_game");
    }, POLLING_RECOVERY_MS, "dropped-chat polling recovery", 100);
    const droppedChatFetch = latestTraffic(guestSession, "chat", droppedChatAt);
    assert.ok(droppedChatFetch, "Chat polling must recover a dropped invalidation.");
    summary.scenarios.droppedChatHint = {
      recoveredByPolling: true,
      latencyMs: droppedChatFetch.at - droppedChatAt,
    };

    tlsBridge.dropNext();
    const dropMutationAt = Date.now();
    const dropped = await setReady(sites.baseUrl, actors.host, table.gameId, true);
    assert.equal(tlsBridge.stats.droppedNotifications, 2);
    const recovered = await waitFor(async () => {
      const state = await renderGame(guestSession.page);
      return state?.game?.revision >= dropped.response.body.view.revision ? state : null;
    }, POLLING_RECOVERY_MS, "dropped-hint polling recovery", 100);
    const pollingFetch = latestTraffic(guestSession, "game", dropMutationAt);
    assert.ok(pollingFetch, "Polling must issue an authoritative game GET after a dropped hint.");
    summary.scenarios.droppedHint = {
      recoveredByPolling: true,
      latencyMs: pollingFetch.at - dropMutationAt,
      convergedRevision: recovered.game.revision,
    };

    const notifyBeforeSafety = tlsBridge.stats.notificationRequests.length;
    for (const relationship of ["mute", "block"]) {
      const result = await apiRequest(
        sites.baseUrl,
        actors.guest,
        `/api/games/${encodeURIComponent(table.gameId)}/players/${encodeURIComponent(table.hostPlayerId)}/${relationship}`,
        { method: "PUT", body: {} },
      );
      assert.equal(result.status, 200, result.raw);
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(
      tlsBridge.stats.notificationRequests.length,
      notifyBeforeSafety,
      "Viewer-local mute/block changes must not broadcast.",
    );
    summary.scenarios.viewerSafety = { muteBroadcast: false, blockBroadcast: false };

    const fallbackStarted = Date.now();
    const workerKilledAt = fallbackStarted;
    const gameGetsBeforeKill = countTraffic(guestSession, "game");
    await stopChild(realtimeWorker.child);
    realtimeWorker = null;
    await waitFor(async () => (await renderGame(guestSession.page))?.realtime === "fallback", 4_000, "fallback after companion loss");
    await waitFor(
      () => countTraffic(guestSession, "game") > gameGetsBeforeKill,
      5_000,
      "fallback safety poll after companion loss",
    );
    const directReadStarted = Date.now();
    const directRead = await currentGame(sites.baseUrl, actors.guest, table.gameId);
    const directReadLatencyMs = Date.now() - directReadStarted;
    assert.ok(directRead.revision >= recovered.game.revision);
    assert.ok(directReadLatencyMs < 2_000, "The authoritative API must remain responsive without realtime.");
    summary.scenarios.workerLoss = {
      fallbackLatencyMs: Date.now() - fallbackStarted,
      fallbackPollObserved: true,
      authoritativeReadLatencyMs: directReadLatencyMs,
    };

    const allSessions = [hostSession, guestSession];
    const realtimeSockets = allSessions.flatMap((session) => session.sockets)
      .filter((socket) => new URL(socket.url).pathname.startsWith("/socket/"));
    assert.ok(realtimeSockets.length >= 2, "Both identities must establish a realtime WebSocket.");
    assert.equal(
      realtimeSockets.flatMap((socket) => socket.sent).length,
      0,
      "Browsers must send no realtime data frames.",
    );
    for (const socket of realtimeSockets) {
      assert.equal(socket.url.includes(table.gameId), false);
      assert.equal(socket.url.includes(actors.host.id), false);
      assert.equal(socket.url.includes(actors.guest.id), false);
      for (const frame of socket.received) {
        assert.doesNotMatch(frame, /gameId|userId|displayName|cardId|message|content/iu);
      }
    }
    for (const session of allSessions) {
      assert.ok(session.connectionResponses.some((event) => {
        const header = Object.entries(event.response.headers)
          .find(([name]) => name.toLowerCase() === "sec-websocket-protocol")?.[1];
        return event.response.status === 101 && header === SUBPROTOCOL;
      }));
      const unexpectedErrors = session.consoleErrors.filter((entry) => (
        entry.at < workerKilledAt &&
        !/Failed to load resource: the server responded with a status of 404/iu.test(entry.message)
      ));
      assert.deepEqual(unexpectedErrors, []);
    }
    summary.privacy = {
      browserSockets: realtimeSockets.length,
      clientDataFrames: 0,
      serverFramesContentFree: true,
      negotiatedProtocol: SUBPROTOCOL,
    };

    const hostState = await renderGame(hostSession.page);
    const guestState = await renderGame(guestSession.page);
    await hostSession.page.screenshot({
      path: path.join(artifactsDirectory, "host-after-worker-loss.png"),
      fullPage: true,
    });
    await guestSession.page.screenshot({
      path: path.join(artifactsDirectory, "guest-after-worker-loss.png"),
      fullPage: true,
    });
    await writeFile(
      path.join(artifactsDirectory, "render-states.json"),
      `${JSON.stringify({
        host: { revision: hostState.game.revision, realtime: hostState.realtime },
        guest: { revision: guestState.game.revision, realtime: guestState.realtime },
      }, null, 2)}\n`,
    );
    await writeFile(
      path.join(artifactsDirectory, "acceptance-summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    console.log("Sites/D1 realtime integration acceptance passed:");
    console.log("- fresh isolated D1 and two independent browser identities");
    console.log("- actual private chat/game mutations cause prompt peer authoritative fetches");
    console.log("- stale in-flight GET receives a mandatory trailing catch-up fetch");
    console.log("- dropped chat/game hints converge by polling; replay and viewer-local safety do not broadcast");
    console.log("- companion loss falls back immediately while authoritative Sites APIs stay responsive");
    console.log(`Artifacts: ${artifactsDirectory}`);
  } catch (error) {
    if (tlsBridge) console.error(`Bridge stats: ${JSON.stringify(tlsBridge.stats)}`);
    if (realtimeWorker) console.error(realtimeWorker.logs());
    if (sites) console.error(sites.logs());
    await writeFile(
      path.join(artifactsDirectory, "failure.txt"),
      error instanceof Error ? error.stack ?? error.message : String(error),
    ).catch(() => undefined);
    await writeFile(
      path.join(artifactsDirectory, "failure-diagnostics.json"),
      `${JSON.stringify({
        bridge: tlsBridge?.stats ?? null,
        browsers: [hostSession, guestSession].filter(Boolean).map((session) => ({
          sockets: session.sockets,
          sentProtocolFrames: session.sentProtocolFrames,
          connectionStatuses: session.connectionResponses.map((event) => event.response.status),
          consoleErrors: session.consoleErrors,
        })),
      }, null, 2)}\n`,
    ).catch(() => undefined);
    throw error;
  } finally {
    await hostSession?.context.close().catch(() => undefined);
    await guestSession?.context.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await stopChild(sites?.child).catch(() => undefined);
    await tlsBridge?.stop().catch(() => undefined);
    await stopChild(realtimeWorker?.child).catch(() => undefined);
  }
}

await main();
