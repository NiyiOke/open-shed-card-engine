import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = new URL(
  process.env.V15_LIFECYCLE_BASE_URL ?? "http://localhost:3000",
);
assert.equal(
  baseUrl.hostname,
  "localhost",
  "The lifecycle acceptance script is local-only and refuses non-localhost targets.",
);

const runToken = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
const artifactRoot =
  process.env.V15_LIFECYCLE_ARTIFACT_DIR ??
  "/tmp/open-shed-v15-lifecycle-acceptance";
const artifactDir = path.join(artifactRoot, runToken);
const tombstoneLifetimeMs = 24 * 60 * 60_000;
const maintenanceDeadlineMs = 20_000;

const identities = {
  singleHost: identity(`v15-a-${runToken}`, "V1.5 Solo Host"),
  closedGuest: identity(`v15-c-${runToken}`, "V1.5 Closed Guest"),
  tableHost: identity(`v15-h-${runToken}`, "V1.5 Table Host"),
  tableGuest: identity(`v15-g-${runToken}`, "V1.5 Table Guest"),
  abandonedHost: identity(`v15-s-${runToken}`, "V1.5 Stale Host"),
};

let commandSequence = 0;
const consoleErrors = [];
const summary = {
  runToken,
  baseUrl: baseUrl.origin,
  localDatabase: null,
  scenarios: {},
  consoleErrors,
};

await mkdir(artifactDir, { recursive: true });

try {
  await assertLocalServer();
  const databasePath = await discoverLocalGameDatabase();
  summary.localDatabase = databasePath;

  summary.scenarios.explicitFinalLeave =
    await proveExplicitFinalLeave(databasePath);
  summary.scenarios.completedTableLeave =
    await proveCompletedTableLeave(databasePath);
  summary.scenarios.abandonedRoom =
    await proveAbandonedRoomClose(databasePath);

  assert.deepEqual(
    consoleErrors,
    [],
    `Unexpected browser errors: ${JSON.stringify(consoleErrors)}`,
  );
  await writeSummary();
  process.stdout.write(
    `V1.5 room lifecycle acceptance passed. Artifacts: ${artifactDir}\n`,
  );
} catch (error) {
  summary.failure = error instanceof Error ? error.stack ?? error.message : String(error);
  await writeSummary();
  throw error;
}

async function proveExplicitFinalLeave(databasePath) {
  const created = await createGame(identities.singleHost, "solo-create");
  const gameId = created.gameId;
  const joinCode = created.joinCode;
  const leaveBody = commandEnvelope(
    created.revision,
    { type: "leave_game" },
    "solo-final-leave",
  );

  const firstLeave = await apiRequest(
    identities.singleHost,
    `/api/games/${encodeURIComponent(gameId)}/commands`,
    { method: "POST", body: leaveBody },
  );
  assert.equal(firstLeave.status, 200);
  assert.equal(firstLeave.body.view, null);
  assert.equal(firstLeave.body.replayed, false);
  assert.deepEqual(eventTypes(firstLeave.body), [
    "player_left",
    "room_emptied",
    "room_closed",
  ]);
  assert.equal(firstLeave.body.events.at(-1)?.data?.reason, "empty");

  const replay = await apiRequest(
    identities.singleHost,
    `/api/games/${encodeURIComponent(gameId)}/commands`,
    { method: "POST", body: leaveBody },
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.body.view, null);
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.events, []);

  await expectApiError(
    identities.singleHost,
    `/api/games/${encodeURIComponent(gameId)}`,
    { method: "GET" },
    410,
    "ROOM_CLOSED",
  );
  await expectApiError(
    identities.closedGuest,
    "/api/games/join",
    {
      method: "POST",
      body: {
        commandId: nextCommandId("closed-join"),
        joinCode,
        nickname: identities.closedGuest.name,
      },
    },
    410,
    "ROOM_CLOSED",
  );

  const lobbyList = await apiRequest(identities.singleHost, "/api/games", {
    method: "GET",
  });
  assert.equal(lobbyList.status, 200);
  assert.equal(
    lobbyList.body.mine.some((room) => room.gameId === gameId),
    false,
  );

  const tombstone = queryOne(
    databasePath,
    `SELECT room_status AS roomStatus,
            close_reason AS closeReason,
            closed_at AS closedAt,
            expires_at AS expiresAt,
            (SELECT COUNT(*) FROM game_presence p
             WHERE p.game_id = games.id) AS presenceCount
     FROM games WHERE id = ${sqlString(gameId)}`,
  );
  assert.equal(tombstone.roomStatus, "closed");
  assert.equal(tombstone.closeReason, "empty");
  assert.equal(Number(tombstone.presenceCount), 0);
  assert.equal(
    Number(tombstone.expiresAt) - Number(tombstone.closedAt),
    tombstoneLifetimeMs,
  );

  const member = queryOne(
    databasePath,
    `SELECT status, left_at AS leftAt
     FROM game_members WHERE game_id = ${sqlString(gameId)}`,
  );
  assert.equal(member.status, "left");
  assert.equal(Number.isFinite(Number(member.leftAt)), true);

  return {
    gameId,
    joinCode,
    closedAt: Number(tombstone.closedAt),
    replayed: replay.body.replayed,
  };
}

async function proveCompletedTableLeave(databasePath) {
  const created = await createGame(identities.tableHost, "table-create");
  const joined = await joinGame(
    identities.tableGuest,
    created.joinCode,
    "table-join",
  );

  const hostReady = await sendCommand(
    identities.tableHost,
    created.gameId,
    joined.revision,
    { type: "set_ready", ready: true },
    "host-ready",
  );
  const guestReady = await sendCommand(
    identities.tableGuest,
    created.gameId,
    hostReady.view.revision,
    { type: "set_ready", ready: true },
    "guest-ready",
  );
  const started = await sendCommand(
    identities.tableHost,
    created.gameId,
    guestReady.view.revision,
    { type: "start_game" },
    "start-game",
  );
  assert.equal(started.view.phase, "playing");

  const guestLeave = await sendCommand(
    identities.tableGuest,
    created.gameId,
    started.view.revision,
    { type: "leave_game" },
    "guest-leave",
  );
  assert.equal(guestLeave.view, null);
  assert.deepEqual(eventTypes(guestLeave), ["game_won", "player_left"]);

  const completed = await readGame(identities.tableHost, created.gameId);
  assert.equal(completed.view.phase, "complete");
  assert.equal(completed.view.legalActions.canLeave, true);
  assert.equal(completed.view.isHost, true);

  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    await installIdentity(context, identities.tableHost);
    const page = await context.newPage();
    watchErrors(page, "completed-host", consoleErrors);
    await page.goto(
      new URL(`/?game=${encodeURIComponent(created.gameId)}`, baseUrl).href,
      { waitUntil: "domcontentloaded" },
    );

    const leaveButton = page
      .getByRole("button", { name: "Leave table and go back" })
      .first();
    await leaveButton.waitFor({ timeout: 8_000 });
    await page.screenshot({
      path: path.join(artifactDir, "01-completed-host-before-leave.png"),
      fullPage: true,
    });
    const renderedState = await page.evaluate(() =>
      typeof window.render_game_to_text === "function"
        ? window.render_game_to_text()
        : null,
    );
    assert.ok(renderedState, "The completed table must expose text state.");
    const parsedState = JSON.parse(renderedState);
    assert.equal(parsedState.mode, "complete");
    assert.equal(parsedState.game.id, created.gameId);
    await writeFile(
      path.join(artifactDir, "01-completed-host-state.json"),
      `${JSON.stringify(parsedState, null, 2)}\n`,
    );

    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/games/${created.gameId}/commands`) &&
        response.request().method() === "POST",
      { timeout: 8_000 },
    );
    await leaveButton.click();
    const response = await responsePromise;
    const requestBody = response.request().postDataJSON();
    assert.deepEqual(requestBody.command, { type: "leave_game" });
    assert.equal(response.status(), 200);
    const responseBody = await response.json();
    assert.equal(responseBody.view, null);
    assert.deepEqual(eventTypes(responseBody), [
      "player_left",
      "room_emptied",
      "room_closed",
    ]);

    await page
      .getByRole("button", { name: "Create a table" })
      .waitFor({ timeout: 8_000 });
    assert.equal(new URL(page.url()).searchParams.has("game"), false);
    const closedRoomCard = page.locator(".room-card", {
      hasText: created.joinCode,
    });
    await page.getByRole("button", { name: "Refresh rooms" }).click();
    await closedRoomCard.waitFor({ state: "detached", timeout: 8_000 });
    await page.screenshot({
      path: path.join(artifactDir, "02-host-lobby-after-close.png"),
      fullPage: true,
    });
  } finally {
    await context?.close();
    await browser.close();
  }

  const room = queryOne(
    databasePath,
    `SELECT room_status AS roomStatus, close_reason AS closeReason
     FROM games WHERE id = ${sqlString(created.gameId)}`,
  );
  assert.deepEqual(room, { roomStatus: "closed", closeReason: "empty" });

  const members = queryRows(
    databasePath,
    `SELECT m.seat, m.status, m.role
     FROM game_members m
     WHERE m.game_id = ${sqlString(created.gameId)}
     ORDER BY m.seat`,
  );
  assert.equal(members.length, 2);
  assert.equal(members.every((member) => member.status === "left"), true);

  return {
    gameId: created.gameId,
    joinCode: created.joinCode,
    winner: completed.view.winner?.displayName ?? null,
    browserClosed: true,
  };
}

async function proveAbandonedRoomClose(databasePath) {
  const created = await createGame(identities.abandonedHost, "stale-create");
  const firstRead = await readGame(identities.abandonedHost, created.gameId);
  const serverTime = Number(firstRead.presence.serverTime);
  assert.equal(Number.isFinite(serverTime), true);

  const staleAt = serverTime - 45_000 - 5 * 60_000 - 1;
  const presenceUpdate = queryOne(
    databasePath,
    `UPDATE game_presence
       SET last_seen_at = ${staleAt}
     WHERE game_id = ${sqlString(created.gameId)};
     SELECT changes() AS changes`,
  );
  assert.equal(Number(presenceUpdate.changes), 1);

  const gameUpdate = queryOne(
    databasePath,
    `UPDATE games
       SET abandoned_since = 0,
           last_activity_at = 0
     WHERE id = ${sqlString(created.gameId)}
       AND room_status = 'open';
     SELECT changes() AS changes`,
  );
  assert.equal(Number(gameUpdate.changes), 1);

  const startedAt = Date.now();
  const deadline = startedAt + maintenanceDeadlineMs;
  let closedResponse = null;
  while (Date.now() < deadline) {
    const response = await apiRequest(
      identities.abandonedHost,
      `/api/games/${encodeURIComponent(created.gameId)}`,
      { method: "GET" },
    );
    if (
      response.status === 410 &&
      response.body?.error?.code === "ROOM_CLOSED"
    ) {
      closedResponse = response;
      break;
    }
    assert.equal(response.status, 200);
    await delay(250);
  }
  assert.ok(
    closedResponse,
    `The abandoned room did not close within ${maintenanceDeadlineMs}ms.`,
  );

  const room = queryOne(
    databasePath,
    `SELECT room_status AS roomStatus,
            close_reason AS closeReason,
            abandoned_since AS abandonedSince,
            closed_at AS closedAt,
            (SELECT COUNT(*) FROM game_presence p
             WHERE p.game_id = games.id) AS presenceCount
     FROM games WHERE id = ${sqlString(created.gameId)}`,
  );
  assert.equal(room.roomStatus, "closed");
  assert.equal(room.closeReason, "abandoned");
  assert.equal(room.abandonedSince, null);
  assert.equal(Number(room.presenceCount), 0);
  assert.equal(Number.isFinite(Number(room.closedAt)), true);

  const eventRow = queryOne(
    databasePath,
    `SELECT kind, public_payload_json AS publicPayload
     FROM game_events
     WHERE game_id = ${sqlString(created.gameId)}
     ORDER BY version DESC LIMIT 1`,
  );
  assert.equal(eventRow.kind, "room_closed");
  const events = JSON.parse(eventRow.publicPayload);
  assert.equal(events.at(-1)?.type, "room_closed");
  assert.equal(events.at(-1)?.data?.reason, "abandoned");

  const lobbyList = await apiRequest(identities.abandonedHost, "/api/games", {
    method: "GET",
  });
  assert.equal(lobbyList.status, 200);
  assert.equal(
    lobbyList.body.mine.some((candidate) => candidate.gameId === created.gameId),
    false,
  );

  return {
    gameId: created.gameId,
    joinCode: created.joinCode,
    serverTime,
    staleAt,
    closedAfterMs: Date.now() - startedAt,
  };
}

async function assertLocalServer() {
  const response = await fetch(new URL("/api/session", baseUrl));
  assert.equal(
    response.ok,
    true,
    `The local app is not ready at ${baseUrl.origin}.`,
  );
}

async function discoverLocalGameDatabase() {
  const databaseDirectory = path.join(
    process.cwd(),
    ".wrangler/state/v3/d1/miniflare-D1DatabaseObject",
  );
  const entries = await readdir(databaseDirectory, { withFileTypes: true });
  const candidates = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".sqlite") &&
        entry.name !== "metadata.sqlite",
    )
    .map((entry) => path.join(databaseDirectory, entry.name));
  assert.equal(
    candidates.length,
    1,
    `Expected exactly one local Miniflare game SQLite file, found ${candidates.length}.`,
  );

  const realDirectory = await realpath(databaseDirectory);
  const realCandidate = await realpath(candidates[0]);
  assert.equal(
    realCandidate.startsWith(`${realDirectory}${path.sep}`),
    true,
    "The game database must remain inside local Miniflare state.",
  );
  return realCandidate;
}

async function createGame(actor, label) {
  const response = await apiRequest(actor, "/api/games", {
    method: "POST",
    body: {
      commandId: nextCommandId(label),
      nickname: actor.name,
    },
  });
  assert.equal(response.status, 201);
  assert.match(response.body.view.gameId, /^[a-f0-9-]{36}$/i);
  assert.match(response.body.view.joinCode, /^[A-Z0-9]{6}$/);
  return {
    gameId: response.body.view.gameId,
    joinCode: response.body.view.joinCode,
    revision: response.body.view.revision,
  };
}

async function joinGame(actor, joinCode, label) {
  const response = await apiRequest(actor, "/api/games/join", {
    method: "POST",
    body: {
      commandId: nextCommandId(label),
      joinCode,
      nickname: actor.name,
    },
  });
  assert.equal(response.status, 200);
  return {
    gameId: response.body.view.gameId,
    revision: response.body.view.revision,
  };
}

async function readGame(actor, gameId) {
  const response = await apiRequest(
    actor,
    `/api/games/${encodeURIComponent(gameId)}`,
    { method: "GET" },
  );
  assert.equal(response.status, 200);
  return response.body;
}

async function sendCommand(actor, gameId, expectedRevision, command, label) {
  const response = await apiRequest(
    actor,
    `/api/games/${encodeURIComponent(gameId)}/commands`,
    {
      method: "POST",
      body: commandEnvelope(expectedRevision, command, label),
    },
  );
  assert.equal(
    response.status,
    200,
    `Command ${command.type} failed: ${JSON.stringify(response.body)}`,
  );
  return response.body;
}

function commandEnvelope(expectedRevision, command, label) {
  return {
    commandId: nextCommandId(label),
    expectedRevision,
    command,
  };
}

async function expectApiError(
  actor,
  pathname,
  options,
  expectedStatus,
  expectedCode,
) {
  const response = await apiRequest(actor, pathname, options);
  assert.equal(response.status, expectedStatus);
  assert.equal(response.body?.error?.code, expectedCode);
  return response;
}

async function apiRequest(actor, pathname, { method, body } = {}) {
  const requestHeaders = {
    Origin: baseUrl.origin,
    "X-Open-Shed-Dev-User": actor.id,
    "X-Open-Shed-Dev-Name": actor.name,
  };
  if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
  const response = await fetch(new URL(pathname, baseUrl), {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let responseBody = null;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }
  return { status: response.status, body: responseBody };
}

function queryOne(databasePath, sql) {
  const rows = queryRows(databasePath, sql);
  assert.equal(rows.length, 1, `Expected one SQL row for: ${sql}`);
  return rows[0];
}

function queryRows(databasePath, sql) {
  const output = execFileSync(
    "sqlite3",
    [
      "-batch",
      "-cmd",
      ".timeout 5000",
      "-json",
      databasePath,
      sql,
    ],
    { encoding: "utf8" },
  ).trim();
  return output ? JSON.parse(output) : [];
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function identity(id, name) {
  return { id, name };
}

function nextCommandId(label) {
  commandSequence += 1;
  return `${label}-${runToken}-${commandSequence}`.slice(0, 80);
}

function eventTypes(responseBody) {
  return (responseBody.events ?? []).map((event) => event.type);
}

async function installIdentity(context, actor) {
  await context.addInitScript(
    ({ id, name }) => {
      localStorage.setItem(
        "open-shed-dev-identity",
        JSON.stringify({ id, name }),
      );
    },
    actor,
  );
}

function watchErrors(page, label, target) {
  page.on("pageerror", (error) => {
    target.push(`${label}: pageerror: ${String(error)}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      target.push(`${label}: console.error: ${message.text()}`);
    }
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeSummary() {
  await writeFile(
    path.join(artifactDir, "results.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
}
