import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = new URL(
  process.env.V15_DISCOVERY_BASE_URL ?? "http://localhost:3000",
);
assert.equal(
  baseUrl.hostname,
  "localhost",
  "The discovery acceptance harness is local-only and refuses non-localhost targets.",
);
assert.equal(
  baseUrl.protocol,
  "http:",
  "The discovery acceptance harness only targets a local HTTP development server.",
);
assert.equal(baseUrl.username, "", "The local target must not contain credentials.");
assert.equal(baseUrl.password, "", "The local target must not contain credentials.");
baseUrl.pathname = "/";
baseUrl.search = "";
baseUrl.hash = "";

const runToken = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
const shortToken = randomBytes(4).toString("hex");
const artifactRoot =
  process.env.V15_DISCOVERY_ARTIFACT_DIR ??
  "/tmp/open-shed-v15-discovery-acceptance";
const artifactDir = path.join(artifactRoot, runToken);
const routeWaitMs = positiveInteger(
  process.env.V15_DISCOVERY_ROUTE_WAIT_MS,
  30_000,
);
const requestTimeoutMs = positiveInteger(
  process.env.V15_DISCOVERY_REQUEST_TIMEOUT_MS,
  12_000,
);

const PUBLIC_AVAILABILITY_KEYS = [
  "enabled",
  "openSeatCount",
  "openSeatCountCapped",
  "tableCount",
  "tableCountCapped",
];
const PUBLIC_ROOM_PAGE_KEYS = ["enabled", "nextCursor", "rooms"];
const PUBLIC_ROOM_CARD_KEYS = [
  "capacity",
  "listingId",
  "occupancy",
  "pace",
  "rulesProfile",
  "waitingAge",
];
const VIEWER_LISTING_KEYS = ["canPublish", "pace", "state", "version"];
const LISTING_ID_PATTERN = /^[0-9a-f]{32}$/;
const GAME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOIN_CODE_PATTERN = /^[A-Z0-9]{6}$/;
const PUBLIC_PACES = new Set(["casual", "quick"]);
const WAITING_AGES = new Set(["just_opened", "recent", "waiting"]);
const EXPECTED_RULES_PROFILE = "merciless-baseline-v1";
const PUBLIC_JOIN_CODES = new Set([
  "PUBLIC_ROOM_FULL",
  "ROOM_CLOSED",
  "PUBLIC_ROOM_UNAVAILABLE",
]);

const identities = {
  primaryHost: identity("primary-host", `AcctHost-${shortToken}`),
  primaryGuest: identity("primary-guest", `AcctGuest-${shortToken}`),
  signedViewer: identity("signed-viewer", `AcctView-${shortToken}`),
  quickGuest: identity("quick-guest", `AcctQuick-${shortToken}`),
  manualHost: identity("manual-host", `AcctManualH-${shortToken}`),
  manualGuest: identity("manual-guest", `AcctManualG-${shortToken}`),
  retryHost: identity("retry-host", `AcctRetry-${shortToken}`),
  fullHost: identity("full-host", `AcctFull-${shortToken}`),
  closedHost: identity("closed-host", `AcctClosed-${shortToken}`),
  unavailableGuest: identity("missing-guest", `AcctMissing-${shortToken}`),
};
const aliases = {
  primaryHost: `Host-${shortToken}`,
  primaryGuest: `Guest-${shortToken}`,
  quickGuest: `Quick-${shortToken}`,
  manualHost: `ManualH-${shortToken}`,
  manualGuest: `ManualG-${shortToken}`,
  retryHost: `Retry-${shortToken}`,
  fullHost: `Full-${shortToken}`,
  closedHost: `Closed-${shortToken}`,
};

let commandSequence = 0;
let databasePath = null;
const browserErrors = [];
const expectedBrowserErrors = [];
const gamesForCleanup = new Map();
const summary = {
  runToken,
  baseUrl: baseUrl.origin,
  discoveryEnabledExternally: true,
  localDatabase: null,
  scenarios: {},
  browserErrors,
  expectedBrowserErrors,
  cleanupErrors: [],
};

await mkdir(artifactDir, { recursive: true });

try {
  await assertLocalServer();
  databasePath = await discoverLocalGameDatabase();
  summary.localDatabase = databasePath;
  assertDiscoverySchema(databasePath);

  summary.scenarios.anonymousContract =
    await proveAnonymousContractDoesNotCreateProfiles(databasePath);
  const primary = await createPrimaryPublicTable(databasePath);
  summary.scenarios.primaryPublish = primary.result;
  summary.scenarios.primaryPublicJoin = await provePublicJoinJourney(
    databasePath,
    primary,
  );
  const pool = await createPublicPool(databasePath, primary);
  summary.scenarios.pageLimits = await provePageLimitsAndSignedOutCards(
    databasePath,
    pool,
  );
  summary.scenarios.quickJoin = await proveQuickJoin(databasePath, pool);
  summary.scenarios.manualJoinUnlists =
    await proveManualCodeJoinUnlists(databasePath);
  summary.scenarios.retryIdempotency =
    await provePublishUnpublishRetry(databasePath);
  summary.scenarios.errorMapping = await provePublicJoinErrorMapping(
    databasePath,
  );

  const unexpectedErrors = browserErrors.filter(
    (entry) => !expectedBrowserErrors.includes(entry),
  );
  assert.deepEqual(
    unexpectedErrors,
    [],
    `Unexpected browser errors: ${JSON.stringify(unexpectedErrors)}`,
  );
  assert.equal(
    expectedBrowserErrors.length,
    1,
    "Exactly one browser network error should come from the deliberate lost-response retry.",
  );

  await writeSummary();
  process.stdout.write(
    `V1.5 discovery acceptance passed. Artifacts: ${artifactDir}\n`,
  );
} catch (error) {
  summary.failure =
    error instanceof Error ? error.stack ?? error.message : String(error);
  await writeSummary();
  throw error;
} finally {
  await cleanupCreatedGames();
  await writeSummary();
}

async function proveAnonymousContractDoesNotCreateProfiles(localDatabase) {
  const beforeProfiles = countProfiles(localDatabase);
  const ready = await waitForDiscoveryRoutes();
  const afterProfiles = countProfiles(localDatabase);
  assert.equal(
    afterProfiles,
    beforeProfiles,
    "Headerless public discovery reads must not create a profile.",
  );
  return {
    profilesBefore: beforeProfiles,
    profilesAfter: afterProfiles,
    availability: ready.availability.body,
    roomCount: ready.rooms.body.rooms.length,
  };
}

async function createPrimaryPublicTable(localDatabase) {
  const created = await createGame(identities.primaryHost, "primary-create");
  assert.equal(
    queryScalar(
      localDatabase,
      `SELECT COUNT(*) AS value FROM games WHERE id = ${sqlString(created.gameId)}`,
    ),
    1,
    "The localhost server and the selected local Miniflare D1 file must refer to the same game database.",
  );
  assertViewerListing(created.listing, "private");

  const ready = await sendGameCommand(
    identities.primaryHost,
    created.gameId,
    created.revision,
    { type: "set_ready", ready: true },
    "primary-ready-secret-event",
  );
  const unready = await sendGameCommand(
    identities.primaryHost,
    created.gameId,
    ready.view.revision,
    { type: "set_ready", ready: false },
    "primary-unready-secret-event",
  );
  const prePublicEvents = queryRows(
    localDatabase,
    `SELECT version, public_payload_json AS payload
     FROM game_events
     WHERE game_id = ${sqlString(created.gameId)}
     ORDER BY version`,
  );
  assert.ok(
    prePublicEvents.some((event) =>
      String(event.payload).includes(identities.primaryHost.name),
    ),
    "The fixture must deliberately contain an account-name event before publication so the event floor is a meaningful privacy test.",
  );
  const prePublicMaxVersion = Math.max(
    ...prePublicEvents.map((event) => Number(event.version)),
  );

  const hostPublication = await publishPrimaryThroughHostDialog(
    created,
    unready.view.revision,
  );
  const publishBody = hostPublication.requestBody;
  const published = hostPublication.response;
  assert.equal(published.status, 200, published.raw);
  assertViewerListing(published.body.listing, "listed");
  assert.equal(published.body.listing.pace, "quick");
  assert.equal(published.body.view.gameId, created.gameId);
  assert.equal(selfPlayer(published.body.view).displayName, aliases.primaryHost);
  assertSensitiveValuesAbsent(published.raw, [identities.primaryHost.name]);

  const replay = await apiRequest(
    identities.primaryHost,
    `/api/games/${encodeURIComponent(created.gameId)}/listing`,
    { method: "POST", body: publishBody },
  );
  assert.equal(replay.status, 200, replay.raw);
  assert.deepEqual(replay.body.listing, published.body.listing);
  assert.equal(replay.body.view.revision, published.body.view.revision);

  const listing = queryOne(
    localDatabase,
    `SELECT l.listing_id AS listingId, l.state, l.pace, l.version,
            l.event_floor_version AS eventFloorVersion,
            l.owner_profile_id AS ownerProfileId,
            p.id AS hostProfileId, p.nickname,
            m.public_discovery_consent_at AS consentAt,
            g.state_json AS stateJson
     FROM public_game_listings l
     JOIN games g ON g.id = l.game_id
     JOIN profiles p ON p.id = g.host_profile_id
     JOIN game_members m
       ON m.game_id = g.id AND m.profile_id = p.id
     WHERE l.game_id = ${sqlString(created.gameId)}`,
  );
  assert.match(listing.listingId, LISTING_ID_PATTERN);
  assert.equal(listing.state, "listed");
  assert.equal(listing.pace, "quick");
  assert.equal(Number(listing.version), published.body.listing.version);
  assert.equal(Number(listing.eventFloorVersion), published.body.view.revision);
  assert.ok(Number(listing.eventFloorVersion) > prePublicMaxVersion);
  assert.equal(listing.ownerProfileId, listing.hostProfileId);
  assert.equal(listing.nickname, aliases.primaryHost);
  assert.ok(Number(listing.consentAt) > 0);
  const publishedState = JSON.parse(listing.stateJson);
  assert.equal(
    publishedState.players.find(
      (player) => player.userId === authSubject(identities.primaryHost),
    )?.displayName ?? publishedState.players[0]?.displayName,
    aliases.primaryHost,
  );
  assertSensitiveValuesAbsent(listing.stateJson, [identities.primaryHost.name]);
  assert.equal(
    queryScalar(
      localDatabase,
      `SELECT COUNT(*) AS value FROM command_receipts
       WHERE command_id = ${sqlString(publishBody.commandId)}`,
    ),
    1,
    "An exact publish replay must retain a single idempotency receipt.",
  );

  const profilesBeforeReads = countProfiles(localDatabase);
  const availability = await publicRequest("/api/public/availability");
  const anonymousRooms = await publicRequest("/api/public/rooms");
  assertPublicAvailabilityResponse(availability);
  assertPublicRoomsResponse(anonymousRooms, 6);
  assert.equal(countProfiles(localDatabase), profilesBeforeReads);
  assert.ok(
    anonymousRooms.body.rooms.some(
      (room) => room.listingId === listing.listingId,
    ),
    "The newly published table must appear in anonymous discovery.",
  );
  assertSensitiveValuesAbsent(
    `${availability.raw}\n${anonymousRooms.raw}`,
    [
      identities.primaryHost.name,
      aliases.primaryHost,
      created.gameId,
      created.joinCode,
    ],
  );
  const privateState = queryOne(
    localDatabase,
    `SELECT g.host_profile_id AS hostProfileId, g.created_at AS createdAt,
            g.state_json AS stateJson
     FROM games g WHERE g.id = ${sqlString(created.gameId)}`,
  );
  const privateStateJson = JSON.parse(privateState.stateJson);
  assertSecretLeavesAbsent(
    availability.body,
    discoverySecretFixture(created, privateState, privateStateJson),
  );
  assertSecretLeavesAbsent(
    anonymousRooms.body,
    discoverySecretFixture(created, privateState, privateStateJson),
  );

  await writeFile(
    path.join(artifactDir, "01-primary-public-contract.json"),
    `${JSON.stringify(
      {
        availability: availability.body,
        rooms: anonymousRooms.body,
      },
      null,
      2,
    )}\n`,
  );

  return {
    actor: identities.primaryHost,
    alias: aliases.primaryHost,
    gameId: created.gameId,
    joinCode: created.joinCode,
    revision: published.body.view.revision,
    listing: published.body.listing,
    listingId: listing.listingId,
    eventFloorVersion: Number(listing.eventFloorVersion),
    prePublicMaxVersion,
    result: {
      gameId: created.gameId,
      listingId: listing.listingId,
      pace: listing.pace,
      exactReplay: true,
    },
  };
}

async function publishPrimaryThroughHostDialog(created, expectedRevision) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    reducedMotion: "reduce",
  });
  try {
    await installIdentity(context, identities.primaryHost);
    const page = await context.newPage();
    watchErrors(page, "primary-host-publish", browserErrors);
    await page.goto(
      new URL(`/?game=${encodeURIComponent(created.gameId)}`, baseUrl).href,
      { waitUntil: "domcontentloaded" },
    );
    const publishButton = page.getByRole("button", {
      name: "List publicly",
    });
    await publishButton.waitFor({ timeout: requestTimeoutMs });
    assert.equal(await publishButton.isEnabled(), true);
    await publishButton.click();

    let dialog = page.getByRole("dialog", {
      name: "List this table publicly?",
    });
    await dialog.waitFor({ timeout: requestTimeoutMs });
    let aliasInput = dialog.locator("#public-host-alias");
    assert.equal(await aliasInput.inputValue(), "");
    assert.equal(await aliasInput.getAttribute("maxlength"), "24");
    assert.equal(await aliasInput.getAttribute("autocomplete"), "off");
    assert.equal(
      await aliasInput.evaluate(
        (element) => element === document.activeElement,
      ),
      true,
      "The host publish dialog must focus its deliberately blank alias input.",
    );
    await page.screenshot({
      path: path.join(artifactDir, "01-host-publish-blank-alias.png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: requestTimeoutMs });
    await waitForFocusRestore(page, publishButton);
    assert.equal(
      await publishButton.evaluate(
        (element) => element === document.activeElement,
      ),
      true,
      "Escape must restore focus to the host's List publicly trigger.",
    );

    await publishButton.click();
    dialog = page.getByRole("dialog", {
      name: "List this table publicly?",
    });
    await dialog.waitFor({ timeout: requestTimeoutMs });
    aliasInput = dialog.locator("#public-host-alias");
    assert.equal(await aliasInput.inputValue(), "");
    await aliasInput.fill(aliases.primaryHost);
    await dialog.getByRole("radio", { name: /Quick/ }).check();
    const requestPromise = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname ===
          `/api/games/${created.gameId}/listing`,
      { timeout: requestTimeoutMs },
    );
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/games/${created.gameId}/listing`,
      { timeout: requestTimeoutMs },
    );
    await dialog
      .getByRole("button", { name: "Confirm & list publicly" })
      .click();
    const [request, response] = await Promise.all([
      requestPromise,
      responsePromise,
    ]);
    const requestBody = request.postDataJSON();
    const responseBody = await response.json();
    assert.equal(response.status(), 200);
    assert.equal(requestBody.expectedRevision, expectedRevision);
    assert.equal(requestBody.expectedListingVersion, created.listing.version);
    assert.equal(requestBody.action, "publish");
    assert.equal(requestBody.alias, aliases.primaryHost);
    assert.equal(requestBody.pace, "quick");
    assert.match(requestBody.commandId, /\S+/);
    await page
      .getByRole("heading", { name: "This table is open" })
      .waitFor({ timeout: requestTimeoutMs });
    await page.screenshot({
      path: path.join(artifactDir, "02-host-published-table.png"),
      fullPage: true,
    });
    return {
      requestBody,
      response: {
        status: response.status(),
        body: responseBody,
        raw: JSON.stringify(responseBody),
      },
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function provePublicJoinJourney(localDatabase, primary) {
  const invalidActor = identity("invalid-alias", `AcctInvalid-${shortToken}`);
  const invalidBefore = profileCountForActor(localDatabase, invalidActor);
  const invalid = await apiRequest(
    invalidActor,
    `/api/public/rooms/${primary.listingId}/join`,
    {
      method: "POST",
      body: { commandId: nextCommandId("invalid-alias"), alias: "x" },
    },
  );
  assert.equal(invalid.status, 400, invalid.raw);
  assert.equal(invalid.body?.error?.code, "INVALID_ALIAS");
  assert.equal(profileCountForActor(localDatabase, invalidActor), invalidBefore);

  const beforeSeats = activeMemberCount(localDatabase, primary.gameId);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 320, height: 900 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  const networkBodies = [];
  let publicJoinRequests = 0;
  try {
    await installIdentity(context, identities.primaryGuest);
    const page = await context.newPage();
    watchErrors(page, "public-join-mobile", browserErrors);
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname ===
          `/api/public/rooms/${primary.listingId}/join`
      ) {
        publicJoinRequests += 1;
      }
    });
    trackApiResponseBodies(page, networkBodies);

    await page.goto(
      new URL(`/?listing=${encodeURIComponent(primary.listingId)}`, baseUrl).href,
      { waitUntil: "domcontentloaded" },
    );
    const dialog = page.getByRole("dialog", { name: "Join this open table?" });
    await dialog.waitFor({ timeout: requestTimeoutMs });
    assert.equal(
      new URL(page.url()).searchParams.get("listing"),
      primary.listingId,
      "The selected listing intent must survive signed-in page boot.",
    );
    const aliasInput = page.locator("#public-room-alias");
    assert.equal(await aliasInput.inputValue(), "");
    assert.equal(await aliasInput.getAttribute("maxlength"), "24");
    assert.equal(await aliasInput.getAttribute("autocomplete"), "off");
    assert.equal(
      await aliasInput.evaluate((element) => element === document.activeElement),
      true,
      "The blank room-alias input must receive initial dialog focus.",
    );
    assert.equal(
      (await dialog.innerText()).includes(identities.primaryGuest.name),
      false,
      "The public join dialog must never prefill or echo the account name.",
    );
    const dialogViewport = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    assert.equal(
      dialogViewport.scrollWidth,
      dialogViewport.clientWidth,
      "The 320px public-join dialog must not introduce horizontal overflow.",
    );
    await page.screenshot({
      path: path.join(artifactDir, "02-public-join-mobile-blank-alias.png"),
      fullPage: true,
    });

    const backButton = dialog.getByRole("button", {
      name: "Back to open tables",
    });
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await backButton.evaluate((element) => element === document.activeElement),
      true,
      "Shift+Tab from the first control must wrap focus to the last enabled control.",
    );
    await page.keyboard.press("Tab");
    assert.equal(
      await aliasInput.evaluate((element) => element === document.activeElement),
      true,
      "Tab from the last enabled control must wrap focus into the dialog.",
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: requestTimeoutMs });
    assert.equal(new URL(page.url()).searchParams.has("listing"), false);

    await page.goto(
      new URL(`/?listing=${encodeURIComponent(primary.listingId)}`, baseUrl).href,
      { waitUntil: "domcontentloaded" },
    );
    const secondDialog = page.getByRole("dialog", {
      name: "Join this open table?",
    });
    await secondDialog.waitFor({ timeout: requestTimeoutMs });
    const secondAliasInput = page.locator("#public-room-alias");
    await secondAliasInput.fill("x");
    await secondDialog
      .getByRole("button", { name: "Confirm alias & join" })
      .tap();
    await secondDialog.getByRole("alert").waitFor({ timeout: requestTimeoutMs });
    assert.equal(
      publicJoinRequests,
      0,
      "A client-invalid alias must not reach the public join endpoint.",
    );

    await secondAliasInput.fill(aliases.primaryGuest);
    networkBodies.length = 0;
    const joinResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/public/rooms/${primary.listingId}/join`,
      { timeout: requestTimeoutMs },
    );
    await secondDialog
      .getByRole("button", { name: "Confirm alias & join" })
      .tap();
    const joinResponse = await joinResponsePromise;
    assert.equal(joinResponse.status(), 200);
    await page
      .locator(".table-status")
      .filter({ hasText: "Lobby" })
      .waitFor({ timeout: requestTimeoutMs });
    registerMember(primary.gameId, identities.primaryGuest);
    await delay(350);

    const bounds = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    assert.equal(
      bounds.scrollWidth,
      bounds.clientWidth,
      "The 320px public-join and lobby journey must not overflow horizontally.",
    );
    const pageText = await page.locator("body").innerText();
    assertSensitiveValuesAbsent(pageText, [
      identities.primaryHost.name,
      identities.primaryGuest.name,
    ]);
    assert.ok(pageText.includes(aliases.primaryHost));
    assert.ok(pageText.includes(aliases.primaryGuest));

    const renderedState = await page.evaluate(() =>
      typeof window.render_game_to_text === "function"
        ? window.render_game_to_text()
        : null,
    );
    assert.ok(renderedState, "The joined lobby must expose text state.");
    assertSensitiveValuesAbsent(renderedState, [
      identities.primaryHost.name,
      identities.primaryGuest.name,
    ]);
    await writeFile(
      path.join(artifactDir, "03-public-join-render-state.json"),
      `${JSON.stringify(JSON.parse(renderedState), null, 2)}\n`,
    );
    await page.screenshot({
      path: path.join(artifactDir, "04-public-join-mobile-lobby.png"),
      fullPage: true,
    });

    const postJoinNetwork = JSON.stringify(networkBodies);
    assertSensitiveValuesAbsent(postJoinNetwork, [
      identities.primaryHost.name,
      identities.primaryGuest.name,
    ]);
    await writeFile(
      path.join(artifactDir, "05-public-join-network.json"),
      `${JSON.stringify(networkBodies, null, 2)}\n`,
    );
  } finally {
    await context.close();
    await browser.close();
  }

  assert.equal(publicJoinRequests, 1);
  assert.equal(
    activeMemberCount(localDatabase, primary.gameId),
    beforeSeats + 1,
    "A successful public join must claim exactly one seat.",
  );
  const member = queryOne(
    localDatabase,
    `SELECT m.join_source AS joinSource,
            m.public_discovery_consent_at AS consentAt,
            m.event_floor_version AS eventFloorVersion,
            p.nickname
     FROM game_members m
     JOIN profiles p ON p.id = m.profile_id
     WHERE m.game_id = ${sqlString(primary.gameId)}
       AND p.auth_subject = ${sqlString(authSubject(identities.primaryGuest))}`,
  );
  assert.equal(member.joinSource, "public");
  assert.ok(Number(member.consentAt) > 0);
  assert.equal(member.nickname, aliases.primaryGuest);
  assert.ok(Number(member.eventFloorVersion) >= primary.eventFloorVersion);
  assert.ok(
    Number(member.eventFloorVersion) > primary.prePublicMaxVersion,
    "A fresh public member's event floor must sit above every deliberate pre-public account-name event.",
  );

  const gameFeed = await apiRequest(
    identities.primaryGuest,
    `/api/games/${encodeURIComponent(primary.gameId)}?afterRevision=0`,
    { method: "GET" },
  );
  assert.equal(gameFeed.status, 200, gameFeed.raw);
  assertSensitiveValuesAbsent(gameFeed.raw, [
    identities.primaryHost.name,
    identities.primaryGuest.name,
  ]);
  assert.ok(
    Number(gameFeed.body.eventCursor) >= Number(member.eventFloorVersion),
    "A fresh afterRevision=0 read must advance to the viewer's privacy floor.",
  );
  const visibleEvents = queryRows(
    localDatabase,
    `SELECT version, public_payload_json AS payload
     FROM game_events
     WHERE game_id = ${sqlString(primary.gameId)}
       AND version >= ${Number(member.eventFloorVersion)}
     ORDER BY version`,
  );
  assertSensitiveValuesAbsent(JSON.stringify(visibleEvents), [
    identities.primaryHost.name,
    identities.primaryGuest.name,
  ]);

  const heartbeat = await apiRequest(
    identities.primaryHost,
    `/api/games/${encodeURIComponent(primary.gameId)}/presence`,
    { method: "POST", body: {} },
  );
  assert.equal(heartbeat.status, 200, heartbeat.raw);
  const lobbyList = await apiRequest(identities.primaryHost, "/api/games", {
    method: "GET",
  });
  assert.equal(lobbyList.status, 200, lobbyList.raw);
  const stableAlias = queryOne(
    localDatabase,
    `SELECT p.nickname, g.state_json AS stateJson
     FROM games g
     JOIN profiles p ON p.id = g.host_profile_id
     WHERE g.id = ${sqlString(primary.gameId)}`,
  );
  assert.equal(
    stableAlias.nickname,
    aliases.primaryHost,
    "Routine heartbeat and lobby-list resolution must not overwrite the explicit public alias.",
  );
  assertSensitiveValuesAbsent(stableAlias.stateJson, [identities.primaryHost.name]);
  assert.equal(
    JSON.parse(stableAlias.stateJson).players[0].displayName,
    aliases.primaryHost,
  );

  return {
    listingId: primary.listingId,
    seatsBefore: beforeSeats,
    seatsAfter: activeMemberCount(localDatabase, primary.gameId),
    aliasWasBlank: true,
    touchJoin: true,
    eventFloorVersion: Number(member.eventFloorVersion),
  };
}

async function createPublicPool(localDatabase, primary) {
  const entries = [primary];
  for (let index = 0; index < 6; index += 1) {
    const actor = identity(
      `pool-host-${index}`,
      `AcctPool${index}-${shortToken}`,
    );
    const alias = `Pool${index}-${shortToken}`;
    const table = await createAndPublish(
      actor,
      alias,
      index % 2 === 0 ? "casual" : "quick",
      `pool-${index}`,
    );
    entries.push(table);
  }
  await heartbeatHosts(entries);
  assert.ok(
    eligibleListingCount(localDatabase, entries.map((entry) => entry.gameId)) >=
      7,
    "The local pool must contain at least seven listed test tables before page-limit checks.",
  );
  return entries;
}

async function provePageLimitsAndSignedOutCards(localDatabase, pool) {
  await heartbeatHosts(pool);
  const beforeProfiles = countProfiles(localDatabase);
  const anonymousAvailability = await publicRequest("/api/public/availability");
  const anonymousRooms = await publicRequest("/api/public/rooms");
  assertPublicAvailabilityResponse(anonymousAvailability);
  assertPublicRoomsResponse(anonymousRooms, 6);
  assert.equal(
    anonymousRooms.body.rooms.length,
    6,
    "With at least seven eligible local tables, an anonymous page must stop at six cards.",
  );
  assert.equal(
    countProfiles(localDatabase),
    beforeProfiles,
    "Headerless availability and room-card reads must remain profile-free.",
  );

  const signedRooms = await apiRequest(
    identities.signedViewer,
    "/api/public/rooms",
    { method: "GET" },
  );
  assertPublicRoomsResponse(signedRooms, 20);
  assert.ok(
    signedRooms.body.rooms.length >= 7,
    "A signed-in viewer must be able to receive more than the anonymous six-card limit.",
  );
  assert.ok(signedRooms.body.rooms.length <= 20);

  const knownSecrets = pool.flatMap((entry) => [
    entry.actor.name,
    entry.alias,
    entry.gameId,
    entry.joinCode,
  ]);
  assertSensitiveValuesAbsent(
    `${anonymousAvailability.raw}\n${anonymousRooms.raw}\n${signedRooms.raw}`,
    knownSecrets,
  );

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  try {
    await context.route("**/api/session", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ signedIn: false, user: null }),
      });
    });
    const page = await context.newPage();
    watchErrors(page, "signed-out-discovery", browserErrors);
    await page.goto(baseUrl.href, { waitUntil: "domcontentloaded" });
    const publicSection = page.getByRole("region", {
      name: /Find a seat/i,
    });
    await publicSection.waitFor({ timeout: requestTimeoutMs });
    const cards = page.locator(".public-table-card");
    assert.equal(await cards.count(), 6);
    const landingText = await publicSection.innerText();
    assertSensitiveValuesAbsent(landingText, knownSecrets);
    const firstIntent = await cards.first().locator("a").getAttribute("href");
    assert.ok(firstIntent);
    const signInUrl = new URL(firstIntent, baseUrl);
    assert.equal(signInUrl.pathname, "/signin-with-chatgpt");
    const returnTo = signInUrl.searchParams.get("return_to");
    assert.match(returnTo ?? "", /^\/\?listing=[0-9a-f]{32}$/);
    const preservedIntent = new URL(returnTo, "https://open-shed.local");
    assert.equal(preservedIntent.pathname, "/");
    assert.deepEqual([...preservedIntent.searchParams.keys()], ["listing"]);
    assert.match(
      preservedIntent.searchParams.get("listing") ?? "",
      LISTING_ID_PATTERN,
    );
    const ctaBounds = await cards.first().locator("a").boundingBox();
    assert.ok(
      ctaBounds && ctaBounds.height >= 44,
      "The signed-out table CTA must expose a touch-sized target.",
    );
    await page.screenshot({
      path: path.join(artifactDir, "06-signed-out-open-tables-desktop.png"),
      fullPage: true,
    });
  } finally {
    await context.close();
    await browser.close();
  }

  await writeFile(
    path.join(artifactDir, "07-public-page-limits.json"),
    `${JSON.stringify(
      {
        availability: anonymousAvailability.body,
        anonymous: anonymousRooms.body,
        authenticated: signedRooms.body,
      },
      null,
      2,
    )}\n`,
  );

  return {
    anonymousCards: anonymousRooms.body.rooms.length,
    signedInCards: signedRooms.body.rooms.length,
    tableCount: anonymousAvailability.body.tableCount,
    openSeatCount: anonymousAvailability.body.openSeatCount,
    profileFreeReads: true,
  };
}

async function proveQuickJoin(localDatabase, pool) {
  await heartbeatHosts(pool);
  const response = await apiRequest(
    identities.quickGuest,
    "/api/public/quick-join",
    {
      method: "POST",
      body: {
        commandId: nextCommandId("quick-join"),
        alias: aliases.quickGuest,
      },
    },
  );
  assert.equal(response.status, 200, response.raw);
  assert.match(response.body.view.gameId, GAME_ID_PATTERN);
  assert.equal(selfPlayer(response.body.view).displayName, aliases.quickGuest);
  assertSensitiveValuesAbsent(response.raw, [identities.quickGuest.name]);
  const target = pool.find(
    (entry) => entry.gameId === response.body.view.gameId,
  );
  assert.ok(target, "Quick join must select one of the eligible local test tables.");
  registerMember(target.gameId, identities.quickGuest);
  const membership = queryOne(
    localDatabase,
    `SELECT m.join_source AS joinSource,
            m.public_discovery_consent_at AS consentAt,
            p.nickname
     FROM game_members m
     JOIN profiles p ON p.id = m.profile_id
     WHERE m.game_id = ${sqlString(target.gameId)}
       AND p.auth_subject = ${sqlString(authSubject(identities.quickGuest))}`,
  );
  assert.equal(membership.joinSource, "public");
  assert.ok(Number(membership.consentAt) > 0);
  assert.equal(membership.nickname, aliases.quickGuest);
  return { gameId: target.gameId, joined: true };
}

async function proveManualCodeJoinUnlists(localDatabase) {
  const table = await createAndPublish(
    identities.manualHost,
    aliases.manualHost,
    "casual",
    "manual",
  );
  const before = activeMemberCount(localDatabase, table.gameId);
  const joined = await apiRequest(
    identities.manualGuest,
    "/api/games/join",
    {
      method: "POST",
      body: {
        commandId: nextCommandId("manual-code-join"),
        joinCode: table.joinCode,
        nickname: aliases.manualGuest,
      },
    },
  );
  assert.equal(joined.status, 200, joined.raw);
  registerMember(table.gameId, identities.manualGuest);
  assert.equal(activeMemberCount(localDatabase, table.gameId), before + 1);
  const listing = queryOne(
    localDatabase,
    `SELECT state, unlisted_at AS unlistedAt, close_reason AS closeReason
     FROM public_game_listings
     WHERE game_id = ${sqlString(table.gameId)}`,
  );
  assert.equal(
    listing.state,
    "unlisted",
    "A successful code/invite join must atomically remove the public listing.",
  );
  assert.ok(Number(listing.unlistedAt) > 0);
  const rooms = await publicRequest("/api/public/rooms");
  assertPublicRoomsResponse(rooms, 6);
  assert.equal(
    rooms.body.rooms.some((room) => room.listingId === table.listingId),
    false,
  );
  return {
    gameId: table.gameId,
    listingId: table.listingId,
    stateAfterJoin: listing.state,
  };
}

async function provePublishUnpublishRetry(localDatabase) {
  const created = await createGame(identities.retryHost, "retry-create");
  const publishBody = {
    commandId: nextCommandId("retry-publish"),
    expectedRevision: created.revision,
    expectedListingVersion: created.listing.version,
    action: "publish",
    alias: aliases.retryHost,
    pace: "quick",
  };
  const firstPublish = await apiRequest(
    identities.retryHost,
    `/api/games/${created.gameId}/listing`,
    { method: "POST", body: publishBody },
  );
  assert.equal(firstPublish.status, 200, firstPublish.raw);
  const replayPublish = await apiRequest(
    identities.retryHost,
    `/api/games/${created.gameId}/listing`,
    { method: "POST", body: publishBody },
  );
  assert.equal(replayPublish.status, 200, replayPublish.raw);
  assert.deepEqual(replayPublish.body.listing, firstPublish.body.listing);
  const listingRow = listingForGame(localDatabase, created.gameId);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    reducedMotion: "reduce",
  });
  const mutationBodies = [];
  let dropped = false;
  try {
    await installIdentity(context, identities.retryHost);
    const page = await context.newPage();
    watchErrors(page, "listing-retry", browserErrors);
    await page.route(
      (url) =>
        url.origin === baseUrl.origin &&
        url.pathname === `/api/games/${created.gameId}/listing`,
      async (route) => {
        const request = route.request();
        if (request.method() !== "POST") {
          await route.continue();
          return;
        }
        mutationBodies.push(request.postDataJSON());
        if (!dropped) {
          dropped = true;
          const committed = await route.fetch();
          assert.equal(committed.status(), 200);
          await committed.body();
          await route.abort("failed");
          return;
        }
        await route.continue();
      },
    );
    await page.goto(
      new URL(`/?game=${encodeURIComponent(created.gameId)}`, baseUrl).href,
      { waitUntil: "domcontentloaded" },
    );
    const makePrivate = page.getByRole("button", { name: "Make private" });
    await makePrivate.waitFor({ timeout: requestTimeoutMs });
    await makePrivate.click();
    let dialog = page.getByRole("dialog", {
      name: "Make this table private?",
    });
    await dialog.waitFor({ timeout: requestTimeoutMs });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: requestTimeoutMs });
    await waitForFocusRestore(page, makePrivate);
    assert.equal(
      await makePrivate.evaluate(
        (element) => element === document.activeElement,
      ),
      true,
      "Escape must close the listing dialog and restore focus to its trigger.",
    );
    await makePrivate.click();
    dialog = page.getByRole("dialog", {
      name: "Make this table private?",
    });
    await dialog.waitFor({ timeout: requestTimeoutMs });
    await page.screenshot({
      path: path.join(artifactDir, "08-unpublish-before-lost-response.png"),
      fullPage: true,
    });
    await dialog
      .getByRole("button", { name: "Confirm & make private" })
      .click();
    await dialog.getByRole("alert").waitFor({ timeout: requestTimeoutMs });
    await dialog
      .getByRole("button", { name: "Confirm & make private" })
      .click();
    await page
      .getByRole("heading", { name: "Private by default" })
      .waitFor({ timeout: requestTimeoutMs });
    await page.screenshot({
      path: path.join(artifactDir, "09-unpublish-after-retry.png"),
      fullPage: true,
    });
    await delay(200);
  } finally {
    await context.close();
    await browser.close();
  }

  assert.equal(mutationBodies.length, 2);
  assert.deepEqual(
    mutationBodies[1],
    mutationBodies[0],
    "A lost-response retry must reuse the exact command ID and request fingerprint.",
  );
  const droppedError = browserErrors.find(
    (entry) =>
      entry.startsWith("listing-retry: console.error:") &&
      entry.includes("net::ERR_FAILED"),
  );
  assert.ok(droppedError, "The simulated dropped response must be observable.");
  expectedBrowserErrors.push(droppedError);
  const after = listingForGame(localDatabase, created.gameId);
  assert.equal(after.state, "unlisted");
  assert.ok(Number(after.version) > Number(listingRow.version));
  assert.equal(
    queryScalar(
      localDatabase,
      `SELECT COUNT(*) AS value FROM command_receipts
       WHERE command_id = ${sqlString(mutationBodies[0].commandId)}`,
    ),
    1,
  );
  return {
    gameId: created.gameId,
    publishReplay: true,
    unpublishLostResponseRetry: true,
    retryCommandId: mutationBodies[0].commandId,
  };
}

async function provePublicJoinErrorMapping(localDatabase) {
  const fullTable = await createAndPublish(
    identities.fullHost,
    aliases.fullHost,
    "quick",
    "full",
  );
  for (let index = 0; index < 4; index += 1) {
    const actor = identity(
      `full-member-${index}`,
      `AcctFM${index}-${shortToken}`,
    );
    const response = await publicListingJoin(
      actor,
      fullTable.listingId,
      `Seat${index}-${shortToken}`,
      `full-seat-${index}`,
    );
    assert.equal(response.status, 200, response.raw);
    registerMember(fullTable.gameId, actor);
  }
  assert.equal(activeMemberCount(localDatabase, fullTable.gameId), 5);
  await heartbeatGame(fullTable.actor, fullTable.gameId);
  const racers = [
    identity("full-racer-a", `AcctRaceA-${shortToken}`),
    identity("full-racer-b", `AcctRaceB-${shortToken}`),
  ];
  const raceResponses = await Promise.all(
    racers.map((actor, index) =>
      publicListingJoin(
        actor,
        fullTable.listingId,
        `Racer${index}-${shortToken}`,
        `full-race-${index}`,
      ),
    ),
  );
  const raceSuccesses = raceResponses
    .map((response, index) => ({ response, actor: racers[index] }))
    .filter(({ response }) => response.status === 200);
  const raceFailures = raceResponses
    .map((response, index) => ({ response, actor: racers[index] }))
    .filter(({ response }) => response.status !== 200);
  assert.equal(raceSuccesses.length, 1, JSON.stringify(raceResponses));
  assert.equal(raceFailures.length, 1, JSON.stringify(raceResponses));
  registerMember(fullTable.gameId, raceSuccesses[0].actor);
  assert.equal(raceFailures[0].response.status, 409);
  assert.equal(
    raceFailures[0].response.body?.error?.code,
    "PUBLIC_ROOM_FULL",
  );
  assert.equal(
    profileCountForActor(localDatabase, raceFailures[0].actor),
    0,
    "A raced-full public join must not create or mutate the losing profile.",
  );

  const closedTable = await createAndPublish(
    identities.closedHost,
    aliases.closedHost,
    "casual",
    "closed",
  );
  const leave = await apiRequest(
    identities.closedHost,
    `/api/games/${closedTable.gameId}/commands`,
    {
      method: "POST",
      body: {
        commandId: nextCommandId("close-public-table"),
        expectedRevision: closedTable.revision,
        command: { type: "leave_game" },
      },
    },
  );
  assert.equal(leave.status, 200, leave.raw);
  const closedJoin = await publicListingJoin(
    identity("closed-guest", `AcctClosedG-${shortToken}`),
    closedTable.listingId,
    `Late-${shortToken}`,
    "closed-public-join",
  );
  assert.equal(closedJoin.status, 410, closedJoin.raw);
  assert.equal(closedJoin.body?.error?.code, "ROOM_CLOSED");

  const unavailableBefore = profileCountForActor(
    localDatabase,
    identities.unavailableGuest,
  );
  const missingListingId = randomBytes(16).toString("hex");
  const unavailable = await publicListingJoin(
    identities.unavailableGuest,
    missingListingId,
    `Missing-${shortToken}`,
    "missing-public-join",
  );
  assert.equal(unavailable.status, 404, unavailable.raw);
  assert.equal(unavailable.body?.error?.code, "PUBLIC_ROOM_UNAVAILABLE");
  assert.equal(
    profileCountForActor(localDatabase, identities.unavailableGuest),
    unavailableBefore,
    "A generic unavailable public join must not create a profile.",
  );

  const observedCodes = new Set([
    raceFailures[0].response.body.error.code,
    closedJoin.body.error.code,
    unavailable.body.error.code,
  ]);
  assert.deepEqual(observedCodes, PUBLIC_JOIN_CODES);
  return {
    full: raceFailures[0].response.body.error.code,
    closed: closedJoin.body.error.code,
    unavailable: unavailable.body.error.code,
  };
}

async function createAndPublish(actor, alias, pace, label) {
  const created = await createGame(actor, `${label}-create`);
  const body = {
    commandId: nextCommandId(`${label}-publish`),
    expectedRevision: created.revision,
    expectedListingVersion: created.listing.version,
    action: "publish",
    alias,
    pace,
  };
  const response = await apiRequest(
    actor,
    `/api/games/${created.gameId}/listing`,
    { method: "POST", body },
  );
  assert.equal(response.status, 200, response.raw);
  assertViewerListing(response.body.listing, "listed");
  const listing = listingForGame(databasePath, created.gameId);
  assert.match(listing.listingId, LISTING_ID_PATTERN);
  return {
    actor,
    alias,
    gameId: created.gameId,
    joinCode: created.joinCode,
    revision: response.body.view.revision,
    listing: response.body.listing,
    listingId: listing.listingId,
  };
}

async function createGame(actor, label) {
  const response = await apiRequest(actor, "/api/games", {
    method: "POST",
    body: {
      commandId: nextCommandId(label),
      nickname: actor.name,
    },
  });
  assert.equal(response.status, 201, response.raw);
  assert.match(response.body.view.gameId, GAME_ID_PATTERN);
  assert.match(response.body.view.joinCode, JOIN_CODE_PATTERN);
  assertViewerListing(response.body.listing, "private");
  const created = {
    gameId: response.body.view.gameId,
    joinCode: response.body.view.joinCode,
    revision: response.body.view.revision,
    listing: response.body.listing,
  };
  gamesForCleanup.set(created.gameId, {
    gameId: created.gameId,
    host: actor,
    members: [actor],
  });
  return created;
}

async function publicListingJoin(actor, listingId, alias, label) {
  return apiRequest(actor, `/api/public/rooms/${listingId}/join`, {
    method: "POST",
    body: { commandId: nextCommandId(label), alias },
  });
}

async function sendGameCommand(
  actor,
  gameId,
  expectedRevision,
  command,
  label,
) {
  const response = await apiRequest(
    actor,
    `/api/games/${encodeURIComponent(gameId)}/commands`,
    {
      method: "POST",
      body: {
        commandId: nextCommandId(label),
        expectedRevision,
        command,
      },
    },
  );
  assert.equal(response.status, 200, response.raw);
  return response.body;
}

async function heartbeatHosts(entries) {
  await Promise.all(
    entries.map((entry) => heartbeatGame(entry.actor, entry.gameId)),
  );
}

async function heartbeatGame(actor, gameId) {
  const response = await apiRequest(actor, `/api/games/${gameId}/presence`, {
    method: "POST",
    body: {},
  });
  assert.equal(response.status, 200, response.raw);
}

async function waitForDiscoveryRoutes() {
  const deadline = Date.now() + routeWaitMs;
  let lastObservation = "No response received.";
  while (Date.now() <= deadline) {
    try {
      const availability = await publicRequest("/api/public/availability");
      const rooms = await publicRequest("/api/public/rooms");
      if (availability.status === 200 && rooms.status === 200) {
        if (
          availability.body?.enabled === false ||
          rooms.body?.enabled === false
        ) {
          throw new Error(
            "Epic 2 discovery is disabled. Start the localhost server externally with OPEN_SHED_V15_DISCOVERY_ENABLED=true before running this harness.",
          );
        }
        assertPublicAvailabilityResponse(availability);
        assertPublicRoomsResponse(rooms, 6);
        return { availability, rooms };
      }
      lastObservation = `availability=${availability.status} rooms=${rooms.status}`;
      if (![404, 500, 503].includes(availability.status)) {
        throw new Error(
          `Discovery availability returned an unexpected status: ${availability.status} ${availability.raw}`,
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Epic 2 discovery is disabled")
      ) {
        throw error;
      }
      lastObservation = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(
    `Epic 2 discovery routes did not become ready within ${routeWaitMs}ms (${lastObservation}). The harness never starts or restarts a shared server.`,
  );
}

async function assertLocalServer() {
  let response;
  try {
    response = await fetch(new URL("/api/session", baseUrl), {
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    throw new Error(
      `No local app is ready at ${baseUrl.origin}. Start the discovery-enabled server externally before running this harness. ${String(error)}`,
    );
  }
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
    `Expected exactly one local Miniflare game SQLite file, found ${candidates.length}. Refusing ambiguous D1 verification.`,
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

function assertDiscoverySchema(localDatabase) {
  const listingTable = queryScalar(
    localDatabase,
    `SELECT COUNT(*) AS value FROM sqlite_master
     WHERE type = 'table' AND name = 'public_game_listings'`,
  );
  assert.equal(
    listingTable,
    1,
    "Local D1 is missing the Epic 2 listing migration. Restart the external local server after the routes compile.",
  );
  const floorColumn = queryScalar(
    localDatabase,
    `SELECT COUNT(*) AS value FROM pragma_table_info('game_members')
     WHERE name = 'event_floor_version'`,
  );
  assert.equal(floorColumn, 1, "Local D1 is missing game_members.event_floor_version.");
}

function assertPublicAvailabilityResponse(response) {
  assert.equal(response.status, 200, response.raw);
  assert.equal(response.headers["set-cookie"], undefined);
  if (response.anonymous) {
    assert.match(response.headers["cache-control"] ?? "", /public/i);
    assert.match(response.headers["cache-control"] ?? "", /max-age=30/i);
  }
  assertPlainObject(response.body, "availability response");
  assertExactKeys(response.body, PUBLIC_AVAILABILITY_KEYS, "availability response");
  assert.equal(response.body.enabled, true);
  assertSafeCount(response.body.tableCount, "tableCount");
  assert.equal(typeof response.body.tableCountCapped, "boolean");
  assertSafeCount(response.body.openSeatCount, "openSeatCount");
  assert.equal(typeof response.body.openSeatCountCapped, "boolean");
  assert.ok(response.body.tableCount <= 20);
  assert.ok(response.body.openSeatCount <= 50);
  assertNoForbiddenPublicKeys(response.body);
}

function assertPublicRoomsResponse(response, maximum) {
  assert.equal(response.status, 200, response.raw);
  assert.equal(response.headers["set-cookie"], undefined);
  assertPlainObject(response.body, "public rooms response");
  assertExactKeys(response.body, PUBLIC_ROOM_PAGE_KEYS, "public rooms response");
  assert.equal(response.body.enabled, true);
  assert.ok(Array.isArray(response.body.rooms));
  assert.ok(
    response.body.rooms.length <= maximum,
    `Public room page exceeded its ${maximum}-card audience limit.`,
  );
  for (const [index, room] of response.body.rooms.entries()) {
    assertPlainObject(room, `public room card ${index}`);
    assertExactKeys(room, PUBLIC_ROOM_CARD_KEYS, `public room card ${index}`);
    assert.match(room.listingId, LISTING_ID_PATTERN);
    assertSafeCount(room.occupancy, `rooms[${index}].occupancy`);
    assert.equal(room.capacity, 6);
    assert.ok(room.occupancy >= 1 && room.occupancy < room.capacity);
    assert.ok(PUBLIC_PACES.has(room.pace));
    assert.equal(room.rulesProfile, EXPECTED_RULES_PROFILE);
    assert.ok(WAITING_AGES.has(room.waitingAge));
  }
  if (response.body.nextCursor !== null) {
    assert.match(response.body.nextCursor, LISTING_ID_PATTERN);
  }
  assertNoForbiddenPublicKeys(response.body);
}

function assertViewerListing(listing, expectedState) {
  assertPlainObject(listing, "viewer listing");
  const keys = Object.keys(listing).sort();
  const expectedKeys = listing.reason
    ? [...VIEWER_LISTING_KEYS, "reason"].sort()
    : VIEWER_LISTING_KEYS;
  assert.deepEqual(keys, expectedKeys);
  assert.equal(listing.state, expectedState);
  assert.equal(typeof listing.canPublish, "boolean");
  if (listing.pace !== null) assert.ok(PUBLIC_PACES.has(listing.pace));
  if (listing.version !== null) {
    assert.ok(Number.isSafeInteger(listing.version) && listing.version >= 0);
  }
}

function assertNoForbiddenPublicKeys(value, trail = "$public") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoForbiddenPublicKeys(entry, `${trail}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    assert.equal(
      isForbiddenPublicKey(normalized),
      false,
      `Forbidden public key ${trail}.${key} crossed the discovery boundary.`,
    );
    assertNoForbiddenPublicKeys(child, `${trail}.${key}`);
  }
}

function isForbiddenPublicKey(normalized) {
  if (normalized === "listingid") return false;
  if (
    [
      "authsubject",
      "chat",
      "connected",
      "event",
      "eventcursor",
      "events",
      "exactpresence",
      "joincode",
      "member",
      "members",
      "message",
      "messages",
      "nickname",
      "online",
      "player",
      "players",
      "presence",
      "presences",
      "roster",
      "servertime",
      "tablecode",
      "timestamp",
    ].includes(normalized)
  ) {
    return true;
  }
  if (
    /(?:game|room|table|profile|player|member|user|account|host|owner)(?:id|uuid)$/u.test(
      normalized,
    )
  ) {
    return true;
  }
  if (/(?:name|alias)$/u.test(normalized)) return true;
  return /(?:created|updated|published|unlisted|joined|left|seen|lastseen|heartbeat|closed|expires|abandoned)(?:at|time|timestamp)$/u.test(
    normalized,
  );
}

function assertSensitiveValuesAbsent(serialized, values) {
  const haystack = String(serialized);
  for (const value of values.filter(Boolean)) {
    assert.equal(
      haystack.includes(String(value)),
      false,
      `Sensitive value ${JSON.stringify(value)} crossed a privacy boundary.`,
    );
  }
}

function assertSecretLeavesAbsent(value, secrets, trail = "$payload") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertSecretLeavesAbsent(entry, secrets, `${trail}[${index}]`),
    );
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assertSecretLeavesAbsent(entry, secrets, `${trail}.${key}`);
    }
    return;
  }
  for (const secret of secrets) {
    const leaked =
      typeof value === "string" && typeof secret === "string"
        ? value.includes(secret)
        : typeof value === "number" &&
          typeof secret === "number" &&
          value === secret;
    assert.equal(leaked, false, `Secret value leaked at ${trail}.`);
  }
}

function discoverySecretFixture(created, stateRow, state) {
  return [
    created.gameId,
    created.joinCode,
    stateRow.hostProfileId,
    state.players[0]?.playerId,
    state.players[0]?.userId,
    identities.primaryHost.name,
    aliases.primaryHost,
    Number(stateRow.createdAt),
    Number(state.updatedAt),
  ].filter((value) => value !== undefined && value !== null);
}

function assertExactKeys(value, expected, label) {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `${label} exposed an unexpected or missing field.`,
  );
}

function assertPlainObject(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
}

function assertSafeCount(value, label) {
  assert.ok(Number.isSafeInteger(value) && value >= 0, `${label} is invalid.`);
}

async function waitForFocusRestore(page, locator) {
  const trigger = await locator.elementHandle();
  assert.ok(trigger, "The dialog trigger disappeared before focus restoration.");
  await page.waitForFunction(
    (element) => element === document.activeElement,
    trigger,
    { timeout: requestTimeoutMs },
  );
}

async function publicRequest(pathname) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method: "GET",
    cache: "no-store",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  return { ...(await readResponse(response)), anonymous: true };
}

async function apiRequest(actor, pathname, { method, body } = {}) {
  const headers = {
    Origin: baseUrl.origin,
    "X-Open-Shed-Dev-User": actor.id,
    "X-Open-Shed-Dev-Name": actor.name,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(new URL(pathname, baseUrl), {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  return readResponse(response);
}

async function readResponse(response) {
  const raw = await response.text();
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
    raw,
  };
}

function listingForGame(localDatabase, gameId) {
  return queryOne(
    localDatabase,
    `SELECT listing_id AS listingId, state, pace, version,
            event_floor_version AS eventFloorVersion,
            unlisted_at AS unlistedAt
     FROM public_game_listings
     WHERE game_id = ${sqlString(gameId)}`,
  );
}

function activeMemberCount(localDatabase, gameId) {
  return queryScalar(
    localDatabase,
    `SELECT COUNT(*) AS value FROM game_members
     WHERE game_id = ${sqlString(gameId)} AND status = 'active'`,
  );
}

function eligibleListingCount(localDatabase, gameIds) {
  const ids = gameIds.map(sqlString).join(", ");
  return queryScalar(
    localDatabase,
    `SELECT COUNT(*) AS value FROM public_game_listings
     WHERE state = 'listed' AND game_id IN (${ids})`,
  );
}

function countProfiles(localDatabase) {
  return queryScalar(localDatabase, "SELECT COUNT(*) AS value FROM profiles");
}

function profileCountForActor(localDatabase, actor) {
  return queryScalar(
    localDatabase,
    `SELECT COUNT(*) AS value FROM profiles
     WHERE auth_subject = ${sqlString(authSubject(actor))}`,
  );
}

function queryScalar(localDatabase, sql) {
  const row = queryOne(localDatabase, sql);
  assert.ok(Object.hasOwn(row, "value"), `Missing scalar value for: ${sql}`);
  return Number(row.value);
}

function queryOne(localDatabase, sql) {
  const rows = queryRows(localDatabase, sql);
  assert.equal(rows.length, 1, `Expected one read-only SQL row for: ${sql}`);
  return rows[0];
}

function queryRows(localDatabase, sql) {
  assert.ok(localDatabase, "The local D1 path has not been resolved.");
  assert.match(
    sql,
    /^\s*(SELECT|WITH)\b/i,
    "Acceptance D1 verification is read-only and only permits targeted SELECT/WITH queries.",
  );
  const output = execFileSync(
    "sqlite3",
    [
      "-batch",
      "-cmd",
      ".timeout 5000",
      "-cmd",
      "PRAGMA query_only=ON",
      "-json",
      localDatabase,
      sql,
    ],
    { encoding: "utf8" },
  ).trim();
  return output ? JSON.parse(output) : [];
}

function selfPlayer(view) {
  const player = view.players.find((candidate) => candidate.isSelf);
  assert.ok(player, "The private game projection must contain the requesting player.");
  return player;
}

function identity(label, name) {
  return {
    id: `v15d-${label}-${runToken}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40),
    name,
  };
}

function authSubject(actor) {
  return `dev:${actor.id}`;
}

function nextCommandId(label) {
  commandSequence += 1;
  return `${label}-${runToken}-${commandSequence}`.slice(0, 80);
}

function registerMember(gameId, actor) {
  const record = gamesForCleanup.get(gameId);
  if (!record) return;
  if (!record.members.some((member) => member.id === actor.id)) {
    record.members.push(actor);
  }
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

function trackApiResponseBodies(page, target) {
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (url.origin !== baseUrl.origin || !url.pathname.startsWith("/api/")) {
      return;
    }
    try {
      target.push({
        method: response.request().method(),
        path: `${url.pathname}${url.search}`,
        status: response.status(),
        body: await response.text(),
      });
    } catch {
      // A deliberately aborted response may not expose a readable body.
    }
  });
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

async function cleanupCreatedGames() {
  if (!databasePath) return;
  const records = [...gamesForCleanup.values()].reverse();
  for (const record of records) {
    const members = [...record.members].reverse();
    for (const actor of members) {
      try {
        await leaveIfOpen(actor, record.gameId);
      } catch (error) {
        summary.cleanupErrors.push({
          gameId: record.gameId,
          actor: actor.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

async function leaveIfOpen(actor, gameId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await apiRequest(
      actor,
      `/api/games/${encodeURIComponent(gameId)}?afterRevision=0`,
      { method: "GET" },
    );
    if (
      snapshot.status === 410 ||
      snapshot.body?.error?.code === "NOT_A_MEMBER" ||
      snapshot.body?.error?.code === "ROOM_CLOSED"
    ) {
      return;
    }
    if (snapshot.status !== 200) return;
    const leave = await apiRequest(
      actor,
      `/api/games/${encodeURIComponent(gameId)}/commands`,
      {
        method: "POST",
        body: {
          commandId: nextCommandId("cleanup-leave"),
          expectedRevision: snapshot.body.view.revision,
          command: { type: "leave_game" },
        },
      },
    );
    if (leave.status === 200 || leave.status === 410) return;
    if (leave.body?.error?.code !== "VERSION_CONFLICT") return;
  }
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
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
