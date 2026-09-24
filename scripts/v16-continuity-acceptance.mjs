import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = new URL(
  process.env.V16_CONTINUITY_BASE_URL ?? "http://localhost:3118",
);
assert.equal(
  ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname),
  true,
  "The V1.6 continuity harness is local-only and refuses non-loopback targets.",
);
assert.equal(baseUrl.protocol, "http:", "The local target must use HTTP.");
assert.equal(baseUrl.username, "", "The local target must not contain credentials.");
assert.equal(baseUrl.password, "", "The local target must not contain credentials.");
baseUrl.pathname = "/";
baseUrl.search = "";
baseUrl.hash = "";

const runToken = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
const shortToken = randomBytes(3).toString("hex");
const artifactRoot =
  process.env.V16_CONTINUITY_ARTIFACT_DIR ??
  "/tmp/open-shed-v16-continuity-acceptance";
const artifactDir = path.join(artifactRoot, runToken);
const HOST_CLAIM_GRACE_MS = 120_000;
const browserErrors = [];
const expectedDisabledChatErrors = [];
const fixtures = [];
let databasePath = null;
let commandSequence = 0;

const summary = {
  runToken,
  baseUrl: baseUrl.origin,
  localDatabase: null,
  scenarios: {},
  browserErrors,
  expectedDisabledChatErrors,
  cleanupErrors: [],
};

await mkdir(artifactDir, { recursive: true });

try {
  await assertLocalServer();
  databasePath = await discoverLocalGameDatabase();
  summary.localDatabase = databasePath;
  assertContinuitySchema(databasePath);

  summary.scenarios.atomicRace = await proveAtomicClaimRace(databasePath);
  summary.scenarios.hostHeartbeat =
    await proveHostHeartbeatCancelsClaim(databasePath);
  summary.scenarios.browserContinuity =
    await proveBrowserContinuityAndRoundLedger(databasePath);

  assert.deepEqual(
    browserErrors,
    [],
    `Unexpected browser errors: ${JSON.stringify(browserErrors)}`,
  );
  await writeSummary();
  process.stdout.write(
    `V1.6 game-night continuity acceptance passed. Artifacts: ${artifactDir}\n`,
  );
} catch (error) {
  summary.failure =
    error instanceof Error ? error.stack ?? error.message : String(error);
  await writeSummary();
  throw error;
} finally {
  await cleanupFixtures();
  await writeSummary();
}

async function proveBrowserContinuityAndRoundLedger(localDatabase) {
  const actors = createActors("journey");
  const fixture = await createStartedGame(actors);
  fixtures.push(fixture);
  assertFixtureInDatabase(localDatabase, fixture.gameId);

  const beforeClaimRow = readGameStateRow(localDatabase, fixture.gameId);
  const beforeClaimState = JSON.parse(beforeClaimRow.stateJson);
  assert.equal(beforeClaimState.phase, "playing");
  const initialRevision = beforeClaimState.revision;

  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 820 },
      reducedMotion: "reduce",
    });
    const disabledChatProbe = await apiRequest(
      actors.nextHost,
      `/api/games/${encodeURIComponent(fixture.gameId)}/messages`,
      { method: "GET" },
    );
    assert.equal(disabledChatProbe.status, 404, disabledChatProbe.raw);
    assert.equal(
      disabledChatProbe.body?.error?.code,
      "COMMUNICATION_DISABLED",
      "Only the known fail-closed chat response may explain a messages-route 404.",
    );
    expectedDisabledChatErrors.push(
      `404 /api/games/${fixture.gameId}/messages COMMUNICATION_DISABLED`,
    );
    await installIdentity(context, actors.nextHost);
    const page = await context.newPage();
    watchErrors(page, "continuity", browserErrors, expectedDisabledChatErrors);
    await page.goto(
      new URL(`/?game=${encodeURIComponent(fixture.gameId)}`, baseUrl).href,
      { waitUntil: "domcontentloaded" },
    );
    await page.getByText("Your hand", { exact: true }).waitFor({ timeout: 10_000 });

    const belowBoundary = await readGame(actors.nextHost, fixture.gameId);
    assert.equal(belowBoundary.view.revision, initialRevision);
    backdatePresence(
      localDatabase,
      fixture.gameId,
      fixture.playerIds.host,
      belowBoundary.presence.serverTime - (HOST_CLAIM_GRACE_MS - 1_000),
    );
    const beforeBoundaryView = await readGame(actors.nextHost, fixture.gameId);
    assert.equal(beforeBoundaryView.view.revision, initialRevision);
    assert.equal(beforeBoundaryView.view.legalActions.canClaimHost, false);
    assert.ok(
      beforeBoundaryView.presence.serverTime -
        hostPresence(beforeBoundaryView, fixture.playerIds.host).lastSeenAt <
        HOST_CLAIM_GRACE_MS,
      "The server must deny recovery below the two-minute boundary.",
    );
    await refreshBrowserNow(page);
    assert.equal(
      await page.getByRole("button", { name: "Keep table going", exact: true }).count(),
      0,
      "The recovery CTA must remain absent below the server boundary.",
    );

    const exactBoundaryLastSeen =
      beforeBoundaryView.presence.serverTime - HOST_CLAIM_GRACE_MS;
    backdatePresence(
      localDatabase,
      fixture.gameId,
      fixture.playerIds.host,
      exactBoundaryLastSeen,
    );
    assert.equal(
      beforeBoundaryView.presence.serverTime - exactBoundaryLastSeen,
      HOST_CLAIM_GRACE_MS,
      "The qualifying fixture must be anchored at exactly 120 seconds.",
    );
    const boundaryView = await readGame(actors.nextHost, fixture.gameId);
    assert.equal(boundaryView.view.revision, initialRevision);
    assert.equal(boundaryView.view.legalActions.canClaimHost, true);

    await refreshBrowserNow(page);
    const claimButton = page.getByRole("button", {
      name: "Keep table going",
      exact: true,
    });
    await claimButton.waitFor({ timeout: 10_000 });
    const beforeUiState = await renderedGameState(page);
    assert.equal(beforeUiState.game.revision, initialRevision);
    assert.equal(beforeUiState.game.legalActions.canClaimHost, true);

    await assertNoHorizontalOverflow(page, "desktop host-recovery view");
    await assertMinimumControlSize(claimButton, 44, "desktop recovery CTA");
    await page.screenshot({
      path: path.join(artifactDir, "01-host-recovery-desktop.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 320, height: 900 });
    await assertNoHorizontalOverflow(page, "320px host-recovery view");
    await assertMinimumControlSize(claimButton, 44, "mobile recovery CTA");
    await page.screenshot({
      path: path.join(artifactDir, "02-host-recovery-mobile.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 820 });

    const claimRequestPromise = page.waitForRequest(
      (request) =>
        request.url().endsWith(`/api/games/${fixture.gameId}/commands`) &&
        request.method() === "POST" &&
        request.postDataJSON()?.command?.type === "claim_host",
      { timeout: 10_000 },
    );
    const claimResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/games/${fixture.gameId}/commands`) &&
        response.request().postDataJSON()?.command?.type === "claim_host",
      { timeout: 10_000 },
    );
    await claimButton.click();
    const [claimRequest, claimResponse] = await Promise.all([
      claimRequestPromise,
      claimResponsePromise,
    ]);
    assert.equal(claimResponse.status(), 200);
    const claimBody = claimRequest.postDataJSON();
    assert.deepEqual(claimBody.command, { type: "claim_host" });
    const acceptedClaim = await claimResponse.json();
    assert.equal(acceptedClaim.replayed, false);
    assert.equal(acceptedClaim.view.isHost, true);
    assert.equal(acceptedClaim.view.phase, "playing");
    assert.equal(acceptedClaim.view.revision, initialRevision + 1);

    const replayedClaim = await apiRequest(
      actors.nextHost,
      `/api/games/${encodeURIComponent(fixture.gameId)}/commands`,
      { method: "POST", body: claimBody },
    );
    assert.equal(replayedClaim.status, 200, replayedClaim.raw);
    assert.equal(replayedClaim.body.replayed, true);
    assert.deepEqual(replayedClaim.body.events, []);
    assert.equal(replayedClaim.body.view.revision, acceptedClaim.view.revision);

    const afterClaimRow = readGameStateRow(localDatabase, fixture.gameId);
    const afterClaimState = JSON.parse(afterClaimRow.stateJson);
    assert.equal(afterClaimState.hostUserId, afterClaimState.players.find(
      (player) => player.playerId === fixture.playerIds.nextHost,
    ).userId);
    assert.deepEqual(
      normalizeAuthorityMutation(afterClaimState),
      normalizeAuthorityMutation(beforeClaimState),
      "Host recovery may change authority metadata, but not cards, players, phase, or turn state.",
    );
    assert.equal(afterClaimState.phase, "playing");
    assert.equal(afterClaimState.currentPlayerId, beforeClaimState.currentPlayerId);
    assert.equal(
      queryScalar(
        localDatabase,
        `SELECT COUNT(*) AS value FROM game_events
         WHERE game_id = ${sqlString(fixture.gameId)} AND kind = 'host_claimed'`,
      ),
      1,
    );
    assert.equal(
      queryScalar(
        localDatabase,
        `SELECT COUNT(*) AS value FROM command_receipts
         WHERE game_id = ${sqlString(fixture.gameId)}
           AND command_id = ${sqlString(claimBody.commandId)}`,
      ),
      1,
    );

    const memberships = queryRows(
      localDatabase,
      `SELECT p.auth_subject AS userId, m.seat, m.role, m.status
       FROM game_members m JOIN profiles p ON p.id = m.profile_id
       WHERE m.game_id = ${sqlString(fixture.gameId)} ORDER BY m.seat`,
    );
    const originalHostMembership = memberships.find(
      (member) => member.userId === beforeClaimState.hostUserId,
    );
    const claimantMembership = memberships.find(
      (member) => member.userId === afterClaimState.hostUserId,
    );
    assert.deepEqual(
      {
        role: originalHostMembership?.role,
        status: originalHostMembership?.status,
        seat: Number(originalHostMembership?.seat),
      },
      { role: "player", status: "active", seat: 0 },
      "The prior host must remain seated and active.",
    );
    assert.equal(claimantMembership?.role, "host");
    assert.equal(claimantMembership?.status, "active");

    const rivalLeave = await sendCommand(
      actors.rival,
      fixture.gameId,
      acceptedClaim.view.revision,
      { type: "leave_game" },
      "journey-rival-leave",
    );
    assert.equal(rivalLeave.view, null);
    const continued = await readGame(actors.nextHost, fixture.gameId);
    assert.equal(continued.view.phase, "playing");
    assert.equal(continued.view.isHost, true);

    const completionBody = commandEnvelope(
      continued.view.revision,
      { type: "leave_game" },
      "journey-dropped-completion",
    );
    const droppedStatus = await sendAndDropResponseBody(
      actors.host,
      `/api/games/${encodeURIComponent(fixture.gameId)}/commands`,
      completionBody,
    );
    assert.equal(droppedStatus, 200);
    const completionReplay = await apiRequest(
      actors.host,
      `/api/games/${encodeURIComponent(fixture.gameId)}/commands`,
      { method: "POST", body: completionBody },
    );
    assert.equal(completionReplay.status, 200, completionReplay.raw);
    assert.equal(completionReplay.body.replayed, true);
    assert.equal(completionReplay.body.view, null);

    const completed = await readGame(actors.nextHost, fixture.gameId);
    assert.equal(completed.view.phase, "complete");
    assert.equal(completed.view.winner.playerId, fixture.playerIds.nextHost);
    assert.equal(completed.view.series.roundNumber, 1);
    assert.equal(completed.view.series.completedRounds, 1);
    assert.deepEqual(completed.view.series.scores, [
      {
        playerId: fixture.playerIds.nextHost,
        displayName: actors.nextHost.name,
        wins: 1,
      },
    ]);
    assert.deepEqual(
      completed.view.series.recentWinners.map((winner) => ({
        roundNumber: winner.roundNumber,
        displayName: winner.displayName,
        reason: winner.reason,
      })),
      [{ roundNumber: 1, displayName: actors.nextHost.name, reason: "last_active" }],
    );
    const roundRows = queryRows(
      localDatabase,
      `SELECT completion_revision AS completionRevision,
              round_number AS roundNumber, winner_reason AS winnerReason
       FROM game_rounds WHERE game_id = ${sqlString(fixture.gameId)}`,
    );
    assert.equal(roundRows.length, 1, "A dropped/replayed completion must record one round.");
    assert.deepEqual(
      {
        completionRevision: Number(roundRows[0].completionRevision),
        roundNumber: Number(roundRows[0].roundNumber),
        winnerReason: roundRows[0].winnerReason,
      },
      {
        completionRevision: completed.view.revision,
        roundNumber: 1,
        winnerReason: "last_active",
      },
    );

    await refreshBrowserNow(page);
    await page
      .getByRole("heading", { name: `${actors.nextHost.name} wins.` })
      .waitFor({ timeout: 10_000 });
    await page.getByRole("heading", { name: "Round wins" }).waitFor();
    await page.getByText("1 win", { exact: true }).waitFor();
    const rematchButton = page.getByRole("button", {
      name: "Play round 2",
      exact: true,
    });
    await rematchButton.waitFor();
    await assertNoHorizontalOverflow(page, "desktop result view");
    await assertMinimumControlSize(rematchButton, 44, "desktop rematch CTA");
    await page.screenshot({
      path: path.join(artifactDir, "03-round-one-result-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 320, height: 900 });
    await assertNoHorizontalOverflow(page, "320px result view");
    await assertMinimumControlSize(rematchButton, 44, "mobile rematch CTA");
    await page.screenshot({
      path: path.join(artifactDir, "04-round-one-result-mobile.png"),
      fullPage: true,
    });
    await writeFile(
      path.join(artifactDir, "04-round-one-result-state.json"),
      `${JSON.stringify(await renderedGameState(page), null, 2)}\n`,
    );

    const rematchResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/games/${fixture.gameId}/commands`) &&
        response.request().postDataJSON()?.command?.type === "rematch",
      { timeout: 10_000 },
    );
    await rematchButton.click();
    const rematchResponse = await rematchResponsePromise;
    assert.equal(rematchResponse.status(), 200);
    const rematchPayload = await rematchResponse.json();
    assert.equal(rematchPayload.view.phase, "lobby");
    assert.equal(rematchPayload.view.series.roundNumber, 2);
    assert.equal(rematchPayload.view.series.completedRounds, 1);
    assert.equal(rematchPayload.view.series.scores[0].wins, 1);
    await page.getByRole("button", { name: "I’m ready" }).waitFor();
    const rematchRead = await readGame(actors.nextHost, fixture.gameId);
    assert.equal(rematchRead.view.series.roundNumber, 2);
    assert.equal(rematchRead.view.series.completedRounds, 1);
    assert.equal(
      queryScalar(
        localDatabase,
        `SELECT COUNT(*) AS value FROM game_rounds
         WHERE game_id = ${sqlString(fixture.gameId)}`,
      ),
      1,
    );

    return {
      gameId: fixture.gameId,
      boundary: {
        belowBoundaryCanClaim: false,
        qualifyingAgeMs: HOST_CLAIM_GRACE_MS,
        equalRevision: initialRevision,
      },
      acceptedClaimRevision: acceptedClaim.view.revision,
      claimReplay: replayedClaim.body.replayed,
      completionResponseDroppedBeforeBodyRead: true,
      completionReplay: completionReplay.body.replayed,
      ledgerRows: roundRows.length,
      rematchRoundNumber: rematchRead.view.series.roundNumber,
      screenshots: [
        "01-host-recovery-desktop.png",
        "02-host-recovery-mobile.png",
        "03-round-one-result-desktop.png",
        "04-round-one-result-mobile.png",
      ],
    };
  } finally {
    await context?.close();
    await browser.close();
  }
}

async function proveAtomicClaimRace(localDatabase) {
  const actors = createActors("race");
  const fixture = await createStartedGame(actors);
  fixtures.push(fixture);
  assertFixtureInDatabase(localDatabase, fixture.gameId);
  const observed = await readGame(actors.nextHost, fixture.gameId);
  backdatePresence(
    localDatabase,
    fixture.gameId,
    fixture.playerIds.host,
    observed.presence.serverTime - HOST_CLAIM_GRACE_MS,
  );

  const rivalPreflight = await apiRequest(
    actors.rival,
    `/api/games/${encodeURIComponent(fixture.gameId)}/commands`,
    {
      method: "POST",
      body: commandEnvelope(
        observed.view.revision,
        { type: "claim_host" },
        "race-rival-preflight",
      ),
    },
  );
  assert.equal(rivalPreflight.status, 409, rivalPreflight.raw);
  assert.equal(rivalPreflight.body.error.code, "HOST_CLAIM_NOT_NEXT");

  const raceBodies = [
    commandEnvelope(
      observed.view.revision,
      { type: "claim_host" },
      "race-claim-a",
    ),
    commandEnvelope(
      observed.view.revision,
      { type: "claim_host" },
      "race-claim-b",
    ),
  ];
  const raceResponses = await Promise.all(
    raceBodies.map((body) =>
      apiRequest(
        actors.nextHost,
        `/api/games/${encodeURIComponent(fixture.gameId)}/commands`,
        { method: "POST", body },
      ),
    ),
  );
  const acceptedIndexes = raceResponses
    .map((response, index) => ({ response, index }))
    .filter(({ response }) => response.status === 200);
  const rejected = raceResponses.filter((response) => response.status === 409);
  assert.equal(acceptedIndexes.length, 1, "Exactly one simultaneous claim may commit.");
  assert.equal(rejected.length, 1, "The competing simultaneous claim must conflict.");
  assert.equal(
    ["VERSION_CONFLICT", "ALREADY_HOST"].includes(rejected[0].body.error.code),
    true,
    rejected[0].raw,
  );

  const acceptedIndex = acceptedIndexes[0].index;
  const replay = await apiRequest(
    actors.nextHost,
    `/api/games/${encodeURIComponent(fixture.gameId)}/commands`,
    { method: "POST", body: raceBodies[acceptedIndex] },
  );
  assert.equal(replay.status, 200, replay.raw);
  assert.equal(replay.body.replayed, true);

  const staleRival = await apiRequest(
    actors.rival,
    `/api/games/${encodeURIComponent(fixture.gameId)}/commands`,
    {
      method: "POST",
      body: commandEnvelope(
        observed.view.revision,
        { type: "claim_host" },
        "race-stale-rival",
      ),
    },
  );
  assert.equal(staleRival.status, 409, staleRival.raw);
  assert.equal(staleRival.body.error.code, "VERSION_CONFLICT");
  assert.equal(
    queryScalar(
      localDatabase,
      `SELECT COUNT(*) AS value FROM game_events
       WHERE game_id = ${sqlString(fixture.gameId)} AND kind = 'host_claimed'`,
    ),
    1,
  );
  assert.equal(
    queryScalar(
      localDatabase,
      `SELECT COUNT(*) AS value FROM command_receipts
       WHERE game_id = ${sqlString(fixture.gameId)}
         AND command_id IN (${raceBodies.map((body) => sqlString(body.commandId)).join(", ")})`,
    ),
    1,
  );

  return {
    gameId: fixture.gameId,
    simultaneousRequests: 2,
    admitted: 1,
    competingCode: rejected[0].body.error.code,
    deterministicRivalCode: rivalPreflight.body.error.code,
    staleRivalCode: staleRival.body.error.code,
    replayed: replay.body.replayed,
  };
}

async function proveHostHeartbeatCancelsClaim(localDatabase) {
  const actors = createActors("heartbeat", false);
  const fixture = await createStartedGame(actors);
  fixtures.push(fixture);
  assertFixtureInDatabase(localDatabase, fixture.gameId);
  const observed = await readGame(actors.nextHost, fixture.gameId);
  backdatePresence(
    localDatabase,
    fixture.gameId,
    fixture.playerIds.host,
    observed.presence.serverTime - HOST_CLAIM_GRACE_MS,
  );
  const eligible = await readGame(actors.nextHost, fixture.gameId);
  assert.equal(eligible.view.legalActions.canClaimHost, true);

  const heartbeat = await apiRequest(
    actors.host,
    `/api/games/${encodeURIComponent(fixture.gameId)}/presence`,
    { method: "POST", body: {} },
  );
  assert.equal(heartbeat.status, 200, heartbeat.raw);
  const hostEntry = heartbeat.body.players.find(
    (player) => player.playerId === fixture.playerIds.host,
  );
  assert.equal(hostEntry.status, "live");

  const blocked = await apiRequest(
    actors.nextHost,
    `/api/games/${encodeURIComponent(fixture.gameId)}/commands`,
    {
      method: "POST",
      body: commandEnvelope(
        eligible.view.revision,
        { type: "claim_host" },
        "heartbeat-blocked-claim",
      ),
    },
  );
  assert.equal(blocked.status, 409, blocked.raw);
  assert.equal(blocked.body.error.code, "HOST_STILL_CONNECTED");
  const afterHeartbeat = await readGame(actors.nextHost, fixture.gameId);
  assert.equal(afterHeartbeat.view.isHost, false);
  assert.equal(afterHeartbeat.view.revision, eligible.view.revision);
  assert.equal(afterHeartbeat.view.legalActions.canClaimHost, false);
  assert.equal(
    queryScalar(
      localDatabase,
      `SELECT COUNT(*) AS value FROM game_events
       WHERE game_id = ${sqlString(fixture.gameId)} AND kind = 'host_claimed'`,
    ),
    0,
  );

  return {
    gameId: fixture.gameId,
    eligibleBeforeHeartbeat: true,
    hostPresenceAfterHeartbeat: hostEntry.status,
    rejectedCode: blocked.body.error.code,
    revisionUnchanged: afterHeartbeat.view.revision,
  };
}

async function createStartedGame(actors) {
  const created = await createGame(actors.host, `${actors.label}-create`);
  const fixture = {
    gameId: created.gameId,
    joinCode: created.joinCode,
    actors: [actors.host, actors.nextHost, ...(actors.rival ? [actors.rival] : [])],
    playerIds: { host: created.selfPlayerId, nextHost: null, rival: null },
  };
  let revision = created.revision;
  const nextJoined = await joinGame(
    actors.nextHost,
    created.joinCode,
    `${actors.label}-next-join`,
  );
  revision = nextJoined.revision;
  fixture.playerIds.nextHost = nextJoined.selfPlayerId;
  if (actors.rival) {
    const rivalJoined = await joinGame(
      actors.rival,
      created.joinCode,
      `${actors.label}-rival-join`,
    );
    revision = rivalJoined.revision;
    fixture.playerIds.rival = rivalJoined.selfPlayerId;
  }
  for (const [index, actor] of fixture.actors.entries()) {
    const ready = await sendCommand(
      actor,
      created.gameId,
      revision,
      { type: "set_ready", ready: true },
      `${actors.label}-ready-${index}`,
    );
    revision = ready.view.revision;
  }
  const started = await sendCommand(
    actors.host,
    created.gameId,
    revision,
    { type: "start_game" },
    `${actors.label}-start`,
  );
  assert.equal(started.view.phase, "playing");
  return fixture;
}

function createActors(label, includeRival = true) {
  const suffix = `${label}-${shortToken}`;
  return {
    label,
    host: identity(`v16-${suffix}-h`, `Host ${label} ${shortToken}`),
    nextHost: identity(`v16-${suffix}-a`, `Next ${label} ${shortToken}`),
    rival: includeRival
      ? identity(`v16-${suffix}-b`, `Rival ${label} ${shortToken}`)
      : null,
  };
}

async function assertLocalServer() {
  const response = await fetch(new URL("/api/session", baseUrl));
  assert.equal(response.ok, true, `The local app is not ready at ${baseUrl.origin}.`);
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

function assertContinuitySchema(localDatabase) {
  assert.equal(
    queryScalar(
      localDatabase,
      "SELECT COUNT(*) AS value FROM sqlite_master WHERE type = 'table' AND name = 'game_rounds'",
    ),
    1,
    "The V1.6 round ledger migration must be applied before acceptance.",
  );
}

function assertFixtureInDatabase(localDatabase, gameId) {
  assert.equal(
    queryScalar(
      localDatabase,
      `SELECT COUNT(*) AS value FROM games WHERE id = ${sqlString(gameId)}`,
    ),
    1,
    "The selected SQLite database and localhost server must share the exact fixture.",
  );
}

function backdatePresence(localDatabase, gameId, playerId, lastSeenAt) {
  const result = queryOne(
    localDatabase,
    `UPDATE game_presence SET last_seen_at = ${Math.trunc(lastSeenAt)}
     WHERE game_id = ${sqlString(gameId)} AND player_id = ${sqlString(playerId)};
     SELECT changes() AS changes`,
  );
  assert.equal(Number(result.changes), 1, "Exactly one scoped presence row must change.");
}

function hostPresence(snapshot, playerId) {
  const entry = snapshot.presence.players.find(
    (player) => player.playerId === playerId,
  );
  assert.ok(entry, "The host must be present in the server roster.");
  return entry;
}

function readGameStateRow(localDatabase, gameId) {
  return queryOne(
    localDatabase,
    `SELECT state_json AS stateJson, state_hash AS stateHash, version,
            host_profile_id AS hostProfileId
     FROM games WHERE id = ${sqlString(gameId)}`,
  );
}

function normalizeAuthorityMutation(state) {
  const normalized = structuredClone(state);
  normalized.hostUserId = "<authority>";
  normalized.revision = 0;
  normalized.updatedAt = 0;
  normalized.processedCommands = [];
  return normalized;
}

async function createGame(actor, label) {
  const response = await apiRequest(actor, "/api/games", {
    method: "POST",
    body: { commandId: nextCommandId(label), nickname: actor.name },
  });
  assert.equal(response.status, 201, response.raw);
  return {
    gameId: response.body.view.gameId,
    joinCode: response.body.view.joinCode,
    revision: response.body.view.revision,
    selfPlayerId: selfPlayer(response.body.view).playerId,
  };
}

async function joinGame(actor, joinCode, label) {
  const response = await apiRequest(actor, "/api/games/join", {
    method: "POST",
    body: { commandId: nextCommandId(label), joinCode, nickname: actor.name },
  });
  assert.equal(response.status, 200, response.raw);
  return {
    revision: response.body.view.revision,
    selfPlayerId: selfPlayer(response.body.view).playerId,
  };
}

async function readGame(actor, gameId) {
  const response = await apiRequest(
    actor,
    `/api/games/${encodeURIComponent(gameId)}`,
    { method: "GET" },
  );
  assert.equal(response.status, 200, response.raw);
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
  assert.equal(response.status, 200, response.raw);
  return response.body;
}

async function sendAndDropResponseBody(actor, pathname, body) {
  const controller = new AbortController();
  const response = await fetch(new URL(pathname, baseUrl), {
    method: "POST",
    headers: requestHeaders(actor, true),
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  const status = response.status;
  // The server has committed and returned headers. Deliberately discard the
  // body to model a client losing the result before application code sees it.
  controller.abort();
  return status;
}

async function apiRequest(actor, pathname, { method, body } = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: requestHeaders(actor, body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let responseBody = null;
  try {
    responseBody = raw ? JSON.parse(raw) : null;
  } catch {
    responseBody = null;
  }
  return { status: response.status, body: responseBody, raw };
}

function requestHeaders(actor, json) {
  return {
    Origin: baseUrl.origin,
    "X-Open-Shed-Dev-User": actor.id,
    "X-Open-Shed-Dev-Name": actor.name,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

function commandEnvelope(expectedRevision, command, label) {
  return {
    commandId: nextCommandId(label),
    expectedRevision,
    command,
  };
}

function nextCommandId(label) {
  commandSequence += 1;
  return `${label}-${runToken}-${commandSequence}`.slice(0, 80);
}

function selfPlayer(view) {
  const player = view.players.find((candidate) => candidate.isSelf);
  assert.ok(player, "The viewer projection must identify its player.");
  return player;
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

async function refreshBrowserNow(page) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(250);
}

async function renderedGameState(page) {
  const raw = await page.evaluate(() =>
    typeof window.render_game_to_text === "function"
      ? window.render_game_to_text()
      : null,
  );
  assert.ok(raw, "The game client must expose render_game_to_text().");
  return JSON.parse(raw);
}

async function assertNoHorizontalOverflow(page, label) {
  const dimensions = await page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth;
    const offenders = [...document.querySelectorAll("body *")]
      .flatMap((element) => {
        const box = element.getBoundingClientRect();
        return box.left < -0.5 || box.right > clientWidth + 0.5
          ? [{
              selector: [
                element.tagName.toLowerCase(),
                element.id ? `#${element.id}` : "",
                ...[...element.classList].map((name) => `.${name}`),
              ].join(""),
              left: Math.round(box.left * 10) / 10,
              right: Math.round(box.right * 10) / 10,
              width: Math.round(box.width * 10) / 10,
            }]
          : [];
      })
      .sort((left, right) => right.right - left.right)
      .slice(0, 12);
    return {
      clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      offenders,
    };
  });
  assert.equal(
    dimensions.scrollWidth,
    dimensions.clientWidth,
    `${label} must not overflow horizontally. Offenders: ${JSON.stringify(dimensions.offenders)}`,
  );
}

async function assertMinimumControlSize(locator, minimum, label) {
  const box = await locator.boundingBox();
  assert.ok(box, `${label} must be visible.`);
  assert.ok(box.height >= minimum, `${label} height must be at least ${minimum}px.`);
  assert.ok(box.width >= minimum, `${label} width must be at least ${minimum}px.`);
}

function watchErrors(page, label, target, expectedDisabledChatTarget) {
  page.on("pageerror", (error) => {
    target.push(`${label}: pageerror: ${String(error)}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      const text = message.text();
      if (
        text ===
          "Failed to load resource: the server responded with a status of 404 (Not Found)" &&
        /^\/api\/games\/[^/]+\/messages$/u.test(
          safePathname(message.location().url),
        ) &&
        expectedDisabledChatTarget.some((entry) =>
          entry.includes("COMMUNICATION_DISABLED"),
        )
      ) {
        // The preflight above proved this exact route is fail-closed with the
        // COMMUNICATION_DISABLED code. Never suppress an arbitrary 404.
        return;
      }
      target.push(`${label}: console.error: ${text}`);
    }
  });
}

function safePathname(value) {
  try {
    return new URL(value).pathname;
  } catch {
    return "";
  }
}

function queryScalar(localDatabase, sql) {
  const row = queryOne(localDatabase, sql);
  return Number(row.value);
}

function queryOne(localDatabase, sql) {
  const rows = queryRows(localDatabase, sql);
  assert.equal(rows.length, 1, `Expected exactly one SQL row for: ${sql}`);
  return rows[0];
}

function queryRows(localDatabase, sql) {
  const output = execFileSync(
    "sqlite3",
    ["-batch", "-cmd", ".timeout 5000", "-json", localDatabase, sql],
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

async function cleanupFixtures() {
  for (const fixture of fixtures) {
    try {
      for (let pass = 0; pass < 2; pass += 1) {
        for (const actor of fixture.actors) {
          const snapshot = await apiRequest(
            actor,
            `/api/games/${encodeURIComponent(fixture.gameId)}`,
            { method: "GET" },
          );
          if (snapshot.status !== 200) continue;
          const response = await apiRequest(
            actor,
            `/api/games/${encodeURIComponent(fixture.gameId)}/commands`,
            {
              method: "POST",
              body: commandEnvelope(
                snapshot.body.view.revision,
                { type: "leave_game" },
                "cleanup-leave",
              ),
            },
          );
          if (![200, 409, 410].includes(response.status)) {
            throw new Error(`Cleanup returned ${response.status}: ${response.raw}`);
          }
        }
      }
    } catch (error) {
      summary.cleanupErrors.push({
        gameId: fixture.gameId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function writeSummary() {
  await writeFile(
    path.join(artifactDir, "results.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
}
