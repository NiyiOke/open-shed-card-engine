import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const baseUrl = new URL(
  process.env.V162_LOBBY_BASE_URL ?? "http://localhost:3121",
);
assert.equal(
  baseUrl.hostname,
  "localhost",
  "The V1.6.2 lobby-presence harness refuses non-localhost targets.",
);
assert.equal(
  baseUrl.protocol,
  "http:",
  "The V1.6.2 lobby-presence harness only targets local HTTP development.",
);
assert.equal(baseUrl.username, "", "The local target must not contain credentials.");
assert.equal(baseUrl.password, "", "The local target must not contain credentials.");
baseUrl.pathname = "/";
baseUrl.search = "";
baseUrl.hash = "";

const runToken = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
const shortToken = randomBytes(3).toString("hex");
const artifactRoot =
  process.env.V162_LOBBY_ARTIFACT_DIR ??
  "/tmp/open-shed-v162-lobby-presence-acceptance";
const artifactDir = path.join(artifactRoot, runToken);
const requestTimeoutMs = positiveInteger(
  process.env.V162_LOBBY_REQUEST_TIMEOUT_MS,
  15_000,
);
const routeWaitMs = positiveInteger(
  process.env.V162_LOBBY_ROUTE_WAIT_MS,
  30_000,
);

const OPAQUE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const GAME_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const JOIN_CODE_PATTERN = /^[A-Z0-9]{6}$/u;
const PRESENCE_KEYS = ["enabled", "invites", "players", "self"];
const SELF_KEYS = ["alias", "canBrowse", "lookingForGame"];
const PLAYER_KEYS = ["alias", "inviteState", "presenceId", "status"];
const INVITE_CARD_KEYS = ["fromAlias", "inviteId"];
const SENT_INVITE_KEYS = ["invite"];
const SENT_INVITE_DETAIL_KEYS = ["inviteId", "replayed", "state"];
const FORBIDDEN_DIRECTORY_KEYS = new Set([
  "authSubject",
  "auth_subject",
  "createdAt",
  "created_at",
  "displayName",
  "email",
  "expiresAt",
  "expires_at",
  "gameId",
  "game_id",
  "joinCode",
  "join_code",
  "lastSeenAt",
  "last_seen_at",
  "nickname",
  "profileId",
  "profile_id",
  "tableCode",
  "updatedAt",
  "updated_at",
  "userId",
  "user_id",
]);

const identities = {
  freshnessHost: identity("fresh-host", `Fresh Host Account ${shortToken}`),
  staleSeeker: identity("stale-seeker", `Stale Seeker Account ${shortToken}`),
  manualSeeker: identity("manual-seeker", `Manual Seeker Account ${shortToken}`),
  uiHost: identity("ui-host", `UI Host Account ${shortToken}`),
  uiSeeker: identity("ui-seeker", `UI Seeker Account ${shortToken}`),
  blockHost: identity("block-host", `Block Host Account ${shortToken}`),
  blockSeeker: identity("block-seeker", `Block Seeker Account ${shortToken}`),
  hostSafetyHost: identity("host-safety-host", `Host Safety Account ${shortToken}`),
  hostSafetySeeker: identity("host-safety-seeker", `Safety Seeker Account ${shortToken}`),
  quotaHost: identity("quota-host", `Quota Host Account ${shortToken}`),
  quotaSeeker: identity("quota-seeker", `Quota Seeker Account ${shortToken}`),
  createClear: identity("create-clear", `Create Clear Account ${shortToken}`),
  manualHost: identity("manual-host", `Manual Host Account ${shortToken}`),
  manualGuest: identity("manual-guest", `Manual Guest Account ${shortToken}`),
  publicHost: identity("public-host", `Public Host Account ${shortToken}`),
  publicGuest: identity("public-guest", `Public Guest Account ${shortToken}`),
  quickGuest: identity("quick-guest", `Quick Guest Account ${shortToken}`),
  raceHost: identity("race-host", `Race Host Account ${shortToken}`),
  raceA: identity("race-a", `Race A Account ${shortToken}`),
  raceB: identity("race-b", `Race B Account ${shortToken}`),
  overflow: identity("overflow", `Overflow Account ${shortToken}`),
};

const gamesForCleanup = new Map();
const optedInActors = new Map();
const browserErrors = [];
const expectedBrowserErrors = [];
let databasePath = null;
let commandSequence = 0;

const summary = {
  runToken,
  baseUrl: baseUrl.origin,
  localDatabase: null,
  scenarios: {},
  browserErrors,
  expectedBrowserErrors,
  cleanupErrors: [],
};

await mkdir(artifactDir, { recursive: true });

try {
  summary.scenarios.defaultOff = proveDefaultOffPolicy();
  await assertLocalServer();
  databasePath = await discoverLocalGameDatabase();
  summary.localDatabase = databasePath;
  assertLobbyPresenceSchema(databasePath);
  await waitForLobbyPresenceRoute();

  summary.scenarios.authRecovery = await proveInviteAuthRecoveryUi();
  summary.scenarios.freshnessAndSoleHost =
    await provePresenceFreshnessAndSoleHostBrowse();
  summary.scenarios.atomicInviteUi =
    await proveAtomicInviteWithLostBrowserResponse();
  summary.scenarios.blockAndReplay = await proveDeclineAndBlock();
  summary.scenarios.hostBlockUi = await proveHostBlockUi();
  summary.scenarios.quotas = await provePairAndRecipientQuotas();
  summary.scenarios.entryClearing = await proveAllEntryPathsClearPresence();
  summary.scenarios.concurrentSeat = await proveConcurrentInvitationSeat();

  const unexpectedErrors = browserErrors.filter(
    (entry) => !expectedBrowserErrors.includes(entry),
  );
  assert.deepEqual(
    unexpectedErrors,
    [],
    `Unexpected browser errors: ${JSON.stringify(unexpectedErrors)}`,
  );

  await writeSummary();
  process.stdout.write(
    `V1.6.2 lobby-presence acceptance passed. Artifacts: ${artifactDir}\n`,
  );
} catch (error) {
  summary.failure =
    error instanceof Error ? error.stack ?? error.message : String(error);
  await writeSummary();
  throw error;
} finally {
  await cleanupOptedInActors();
  await cleanupCreatedGames();
  await writeSummary();
}

function proveDefaultOffPolicy() {
  const policyUrl = pathToFileURL(
    path.join(process.cwd(), "lib/server/lobby-presence-policy.ts"),
  ).href;
  const script = `
    import { parseLobbyPresenceEnabled } from ${JSON.stringify(policyUrl)};
    const values = [
      parseLobbyPresenceEnabled({ NODE_ENV: "production" }),
      parseLobbyPresenceEnabled({ OPEN_SHED_LOBBY_PRESENCE_ENABLED: "TRUE" }),
      parseLobbyPresenceEnabled({ OPEN_SHED_LOBBY_PRESENCE_ENABLED: "1" }),
      parseLobbyPresenceEnabled({ OPEN_SHED_LOBBY_PRESENCE_ENABLED: "true" })
    ];
    process.stdout.write(JSON.stringify(values));
  `;
  const environment = { ...process.env };
  delete environment.OPEN_SHED_LOBBY_PRESENCE_ENABLED;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { encoding: "utf8", env: environment },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [false, false, false, true]);
  return {
    absent: "disabled",
    nonCanonicalValues: "disabled",
    exactTrue: "enabled",
  };
}

async function proveInviteAuthRecoveryUi() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 320, height: 900 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  try {
    await context.route("**/api/session", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ user: null }),
      });
    });
    const page = await context.newPage();
    watchErrors(page, "signed-out-invite", browserErrors);
    await page.goto(new URL("/?join=ABC123", baseUrl).href, {
      waitUntil: "domcontentloaded",
    });
    const help = page.getByLabel("Invite sign-in help");
    await help.waitFor({ timeout: requestTimeoutMs });
    await expectText(help, /shares only basic identity/i);
    const details = help.locator("details");
    await details.locator("summary").click();
    await expectText(details, /Safari or Chrome/i);
    await expectText(details, /managed workspace may require admin approval/i);

    const signIn = page.getByRole("link", { name: /Sign in to play/i });
    const href = await signIn.getAttribute("href");
    assert.ok(href, "The signed-out invitation page must expose its sign-in URL.");
    const signInUrl = new URL(href, baseUrl);
    assert.equal(signInUrl.pathname, "/signin-with-chatgpt");
    assert.equal(
      signInUrl.searchParams.get("return_to"),
      "/?join=ABC123",
      "The private invitation must survive the authentication round trip exactly.",
    );
    await assertNoHorizontalOverflow(page, "signed-out invitation help");
    await assertMinimumSize(signIn, 44, "signed-out invitation sign-in action");
    await page.screenshot({
      path: path.join(artifactDir, "01-signed-out-invite-help-mobile.png"),
      fullPage: true,
    });
    return {
      returnTo: signInUrl.searchParams.get("return_to"),
      externalBrowserRecovery: true,
      managedWorkspaceGuidance: true,
      mobileWidth: 320,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function provePresenceFreshnessAndSoleHostBrowse() {
  const seeker = identities.staleSeeker;
  const seekerAlias = `Night Owl ${shortToken}`;
  const initial = await getLobbyPresence(seeker);
  assertPresenceSnapshot(initial, {
    lookingForGame: false,
    canBrowse: false,
  });

  const blank = await apiRequest(seeker, "/api/lobby-presence", {
    method: "PUT",
    body: {
      commandId: nextCommandId("blank-presence"),
      lookingForGame: true,
      alias: "",
    },
  });
  assertApiError(blank, 400, "INVALID_ALIAS");
  assert.equal(presenceCountForActor(databasePath, seeker), 0);
  const contactAlias = await apiRequest(seeker, "/api/lobby-presence", {
    method: "PUT",
    body: {
      commandId: nextCommandId("contact-presence"),
      lookingForGame: true,
      alias: "Call 07123456789",
    },
  });
  assertApiError(contactAlias, 400, "INVALID_ALIAS");
  assert.equal(presenceCountForActor(databasePath, seeker), 0);

  const optedIn = await setLobbyPresence(seeker, seekerAlias, "fresh-opt-in");
  assertPresenceSnapshot(optedIn, {
    lookingForGame: true,
    canBrowse: false,
    alias: seekerAlias,
  });
  assert.equal(optedIn.body.players.length, 0);
  optedInActors.set(seeker.id, seeker);

  const host = await createGame(identities.freshnessHost, "fresh-host-create");
  await heartbeatGame(identities.freshnessHost, host.gameId);
  const online = await getLobbyPresence(identities.freshnessHost);
  assertPresenceSnapshot(online, {
    lookingForGame: false,
    canBrowse: true,
  });
  const onlineCard = requireDirectoryPlayer(online.body, seekerAlias);
  assert.equal(onlineCard.status, "online");
  assertDirectorySecretsAbsent(online.body, [
    seeker.name,
    identities.freshnessHost.name,
    host.gameId,
    host.joinCode,
    authSubject(seeker),
  ]);

  await delay(15_500);
  await heartbeatGame(identities.freshnessHost, host.gameId);
  const reconnecting = await getLobbyPresence(identities.freshnessHost);
  assert.equal(
    requireDirectoryPlayer(reconnecting.body, seekerAlias).status,
    "reconnecting",
  );

  await delay(30_000);
  await heartbeatGame(identities.freshnessHost, host.gameId);
  const expired = await getLobbyPresence(identities.freshnessHost);
  assert.equal(
    expired.body.players.some((player) => player.alias === seekerAlias),
    false,
  );
  assert.equal(presenceCountForActor(databasePath, seeker), 0);

  await setLobbyPresence(
    identities.manualSeeker,
    `Manual ${shortToken}`,
    "sole-manual-opt-in",
  );
  optedInActors.set(identities.manualSeeker.id, identities.manualSeeker);
  const manualJoin = await joinGame(
    identities.manualSeeker,
    host.joinCode,
    `Manual ${shortToken}`,
    "sole-manual-join",
  );
  registerMember(host.gameId, identities.manualSeeker);
  assert.equal(manualJoin.body.view.gameId, host.gameId);
  assert.equal(presenceCountForActor(databasePath, identities.manualSeeker), 0);
  optedInActors.delete(identities.manualSeeker.id);
  const noLongerSole = await getLobbyPresence(identities.freshnessHost);
  assertPresenceSnapshot(noLongerSole, {
    lookingForGame: false,
    canBrowse: false,
  });
  assert.deepEqual(noLongerSole.body.players, []);

  return {
    invalidBlankAliasCreatesPresence: false,
    onlineBeforeMs: 15_000,
    reconnectingFromMs: 15_000,
    hiddenAtMs: 45_000,
    onlySoleHostBrowses: true,
    manualJoinClearsPresence: true,
  };
}

async function proveAtomicInviteWithLostBrowserResponse() {
  const seekerAlias = `Seeker-${shortToken}`.padEnd(24, "X").slice(0, 24);
  const hostAlias = `Host-${shortToken}`.padEnd(24, "Y").slice(0, 24);
  assert.equal(seekerAlias.length, 24);
  assert.equal(hostAlias.length, 24);
  const browser = await chromium.launch({ headless: true });
  const seekerContext = await browser.newContext({
    viewport: { width: 320, height: 900 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  const hostContext = await browser.newContext({
    viewport: { width: 320, height: 900 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  try {
    await installIdentity(seekerContext, identities.uiSeeker);
    const seekerPage = await seekerContext.newPage();
    watchErrors(seekerPage, "invitee-mobile", browserErrors);
    await seekerPage.goto(baseUrl.href, { waitUntil: "domcontentloaded" });
    const lookingHeading = seekerPage.getByRole("heading", {
      name: "Looking for a game?",
    });
    await lookingHeading.waitFor({ timeout: requestTimeoutMs });
    const aliasInput = seekerPage.getByLabel("Public lobby alias");
    assert.equal(
      await aliasInput.inputValue(),
      "",
      "The opt-in alias must not inherit the account identity.",
    );
    await aliasInput.focus();
    assert.equal(await isFocused(aliasInput), true);
    await aliasInput.fill(seekerAlias);
    const showLooking = seekerPage.getByRole("button", {
      name: "Show me as looking",
    });
    await assertMinimumSize(showLooking, 44, "mobile lobby opt-in action");
    await showLooking.click();
    await seekerPage
      .getByText(`Online as ${seekerAlias}`)
      .waitFor({ timeout: requestTimeoutMs });
    await waitForFocus(
      seekerPage.locator(".lobby-presence-panel"),
      "Successful lobby opt-in must hand focus to the updated status region.",
    );
    optedInActors.set(identities.uiSeeker.id, identities.uiSeeker);
    await assertNoHorizontalOverflow(seekerPage, "mobile lobby opt-in");
    await seekerPage.screenshot({
      path: path.join(artifactDir, "02-opted-in-player-mobile.png"),
      fullPage: true,
    });

    const created = await createGame(identities.uiHost, "ui-host-create");
    await delay(20);
    const preJoinMessage = await apiRequest(
      identities.uiHost,
      `/api/games/${created.gameId}/messages`,
      {
        method: "POST",
        body: {
          commandId: nextCommandId("prejoin-phrase"),
          kind: "phrase",
          contentId: "ready",
        },
      },
    );
    assert.equal(preJoinMessage.status, 200, preJoinMessage.raw);

    await installIdentity(hostContext, identities.uiHost);
    const hostPage = await hostContext.newPage();
    watchErrors(hostPage, "host-invite-mobile", browserErrors);
    await hostPage.goto(
      new URL(`/?game=${encodeURIComponent(created.gameId)}`, baseUrl).href,
      { waitUntil: "domcontentloaded" },
    );
    const playerCard = hostPage
      .getByRole("listitem")
      .filter({ hasText: seekerAlias });
    await playerCard.waitFor({ timeout: requestTimeoutMs });
    const inviteButton = playerCard.getByRole("button", {
      name: `Invite ${seekerAlias}`,
    });
    await inviteButton.click();
    let dialog = hostPage.getByRole("dialog", {
      name: `Invite ${seekerAlias}?`,
    });
    await dialog.waitFor({ timeout: requestTimeoutMs });
    let hostAliasInput = dialog.getByLabel("Your public invitation alias");
    assert.equal(await hostAliasInput.inputValue(), "");
    assert.equal(await isFocused(hostAliasInput), true);
    await expectText(dialog, /quick phrases only/i);
    await expectText(dialog, /no free text or live voice/i);
    await hostPage.screenshot({
      path: path.join(artifactDir, "03-host-invite-blank-alias-mobile.png"),
      fullPage: true,
    });
    await hostPage.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: requestTimeoutMs });
    assert.equal(
      await isFocused(inviteButton),
      true,
      "Closing the invitation disclosure must restore trigger focus.",
    );

    await inviteButton.click();
    dialog = hostPage.getByRole("dialog", { name: `Invite ${seekerAlias}?` });
    await dialog.waitFor({ timeout: requestTimeoutMs });
    hostAliasInput = dialog.getByLabel("Your public invitation alias");
    assert.equal(await hostAliasInput.inputValue(), "");
    const directBlank = await apiRequest(
      identities.uiHost,
      `/api/games/${created.gameId}/lobby-invites`,
      {
        method: "POST",
        body: {
          commandId: nextCommandId("blank-host-alias"),
          presenceId: presenceIdForActor(databasePath, identities.uiSeeker),
          senderAlias: "",
        },
      },
    );
    assertApiError(directBlank, 400, "INVALID_ALIAS");
    const directContactAlias = await apiRequest(
      identities.uiHost,
      `/api/games/${created.gameId}/lobby-invites`,
      {
        method: "POST",
        body: {
          commandId: nextCommandId("contact-host-alias"),
          presenceId: presenceIdForActor(databasePath, identities.uiSeeker),
          senderAlias: "Discord playername",
        },
      },
    );
    assertApiError(directContactAlias, 400, "INVALID_ALIAS");
    await hostAliasInput.fill(hostAlias);
    const confirmSend = dialog.getByRole("button", {
      name: "Confirm & send invite",
    });
    await assertMinimumSize(confirmSend, 44, "mobile invitation confirm action");
    await confirmSend.click();
    await dialog.waitFor({ state: "detached", timeout: requestTimeoutMs });
    await hostPage
      .getByText(`Invitation sent to ${seekerAlias}.`)
      .waitFor({ timeout: requestTimeoutMs });
    await waitForFocus(
      hostPage.locator(".lobby-presence-directory"),
      "Successful invitation send must hand focus to the updated directory.",
    );

    await seekerPage.reload({ waitUntil: "domcontentloaded" });
    const inviteCard = seekerPage
      .locator(".incoming-lobby-invite")
      .filter({ hasText: hostAlias });
    await inviteCard.waitFor({ timeout: requestTimeoutMs });
    await expectText(inviteCard, /invited you to a waiting table/i);
    const inviteSnapshot = await getLobbyPresence(identities.uiSeeker);
    assert.equal(inviteSnapshot.body.invites.length, 1);
    assertDirectorySecretsAbsent(inviteSnapshot.body, [
      identities.uiHost.name,
      identities.uiSeeker.name,
      created.gameId,
      created.joinCode,
      authSubject(identities.uiHost),
      authSubject(identities.uiSeeker),
    ]);
    const inviteId = inviteSnapshot.body.invites[0].inviteId;
    const declineAndBlock = inviteCard.getByRole("button", {
      name: `Decline and block ${hostAlias}`,
    });
    await declineAndBlock.click();
    const inviteeBlockGroup = inviteCard.getByRole("group", {
      name: `Block ${hostAlias}`,
    });
    await inviteeBlockGroup.waitFor({ timeout: requestTimeoutMs });
    await expectText(inviteeBlockGroup, /lasting safety action/i);
    const inviteeConfirmBlock = inviteeBlockGroup.getByRole("button", {
      name: "Confirm block",
    });
    assert.equal(
      await isFocused(inviteeConfirmBlock),
      true,
      "Opening the invitee block confirmation must focus its informed confirm action.",
    );
    await inviteeBlockGroup.getByRole("button", { name: "Cancel" }).click();
    await inviteeBlockGroup.waitFor({ state: "detached", timeout: requestTimeoutMs });
    await waitForFocus(
      declineAndBlock,
      "Canceling the invitee block confirmation must restore trigger focus.",
    );
    const respondPath = `/api/lobby-invites/${inviteId}/respond`;
    let firstRequestBody = null;
    let firstResponseBody = null;
    let dropped = false;
    let settleFirstDrop;
    const firstDropSettled = new Promise((resolve) => {
      settleFirstDrop = resolve;
    });
    await seekerPage.route(`**${respondPath}`, async (route) => {
      if (dropped) {
        await route.continue();
        return;
      }
      dropped = true;
      firstRequestBody = route.request().postDataJSON();
      const serverResponse = await route.fetch();
      firstResponseBody = await serverResponse.json();
      assert.equal(serverResponse.status(), 200);
      await route.abort("connectionreset");
      settleFirstDrop();
    });
    const accept = inviteCard.getByRole("button", {
      name: `Accept invitation from ${hostAlias}`,
    });
    await assertMinimumSize(accept, 44, "mobile invitation accept action");
    await accept.click();
    await firstDropSettled;
    assert.ok(
      firstResponseBody,
      "The dropped accept request must commit server-side before the network reset.",
    );
    await seekerPage.unroute(`**${respondPath}`);

    const secondResponsePromise = seekerPage.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === respondPath,
      { timeout: requestTimeoutMs },
    );
    const secondRequestPromise = seekerPage.waitForRequest(
      (request) =>
        request.method() === "POST" && new URL(request.url()).pathname === respondPath,
      { timeout: requestTimeoutMs },
    );
    await accept.click();
    const [secondRequest, secondResponse] = await Promise.all([
      secondRequestPromise,
      secondResponsePromise,
    ]);
    const secondRequestBody = secondRequest.postDataJSON();
    const secondResponseBody = await secondResponse.json();
    assert.equal(secondResponse.status(), 200);
    assert.equal(firstRequestBody.commandId, secondRequestBody.commandId);
    assert.deepEqual(firstRequestBody, secondRequestBody);
    assert.deepEqual(Object.keys(firstResponseBody).sort(), ["invite", "snapshot"]);
    assert.deepEqual(Object.keys(secondResponseBody).sort(), ["invite", "snapshot"]);
    assert.equal(firstResponseBody.invite.replayed, false);
    assert.equal(secondResponseBody.invite.replayed, true);
    assert.equal(secondResponseBody.invite.state, "accepted");
    assert.equal(secondResponseBody.snapshot.view.gameId, created.gameId);
    await seekerPage.waitForURL(
      (url) => url.searchParams.get("game") === created.gameId,
      { timeout: requestTimeoutMs },
    );
    registerMember(created.gameId, identities.uiSeeker);
    optedInActors.delete(identities.uiSeeker.id);

    await seekerPage
      .getByText("Ready up to begin", { exact: true })
      .waitFor({ timeout: requestTimeoutMs });
    await assertNoHorizontalOverflow(seekerPage, "accepted invitation mobile table");
    const rendered = await seekerPage.evaluate(() =>
      typeof window.render_game_to_text === "function"
        ? window.render_game_to_text()
        : null,
    );
    assert.ok(rendered, "The accepted table must expose semantic game state.");
    const renderedState = JSON.parse(rendered);
    assert.equal(renderedState.mode, "lobby");
    assert.equal(renderedState.game.id, created.gameId);
    await writeFile(
      path.join(artifactDir, "04-accepted-invitation-state.json"),
      `${JSON.stringify(renderedState, null, 2)}\n`,
    );
    await seekerPage.screenshot({
      path: path.join(artifactDir, "04-accepted-invitation-mobile.png"),
      fullPage: true,
    });

    const gameRow = queryOne(
      databasePath,
      `SELECT communication_scope AS communicationScope, version,
              state_json AS stateJson
       FROM games WHERE id = ${sqlString(created.gameId)}`,
    );
    assert.equal(gameRow.communicationScope, "public_safe");
    const storedState = JSON.parse(gameRow.stateJson);
    assert.deepEqual(
      storedState.players
        .filter((player) => player.status !== "left")
        .map((player) => player.displayName)
        .sort(),
      [hostAlias, seekerAlias].sort(),
    );
    assertSensitiveValuesAbsent(gameRow.stateJson, [
      identities.uiHost.name,
      identities.uiSeeker.name,
    ]);
    const membership = queryOne(
      databasePath,
      `SELECT member.join_source AS joinSource,
              member.public_discovery_consent_at AS publicConsent,
              member.event_floor_version AS eventFloor,
              member.joined_at AS joinedAt,
              profile.nickname
       FROM game_members member
       JOIN profiles profile ON profile.id = member.profile_id
       WHERE member.game_id = ${sqlString(created.gameId)}
         AND profile.auth_subject = ${sqlString(authSubject(identities.uiSeeker))}`,
    );
    assert.equal(membership.joinSource, "lobby_invite");
    assert.equal(membership.publicConsent, null);
    assert.equal(Number(membership.eventFloor), Number(gameRow.version));
    assert.equal(membership.nickname, seekerAlias);
    const hostProfile = queryOne(
      databasePath,
      `SELECT nickname FROM profiles
       WHERE auth_subject = ${sqlString(authSubject(identities.uiHost))}`,
    );
    assert.equal(hostProfile.nickname, hostAlias);
    const preJoinMessageRow = queryOne(
      databasePath,
      `SELECT created_at AS createdAt FROM game_messages
       WHERE game_id = ${sqlString(created.gameId)}
         AND content_id = 'ready'`,
    );
    assert.ok(Number(preJoinMessageRow.createdAt) < Number(membership.joinedAt));
    const chat = await apiRequest(
      identities.uiSeeker,
      `/api/games/${created.gameId}/messages`,
      { method: "GET" },
    );
    assert.equal(chat.status, 200, chat.raw);
    assert.deepEqual(chat.body.messages, []);
    assert.deepEqual(chat.body.viewer.capabilities, {
      freeText: false,
      liveVoice: false,
    });
    const textDenied = await apiRequest(
      identities.uiSeeker,
      `/api/games/${created.gameId}/messages`,
      {
        method: "POST",
        body: {
          commandId: nextCommandId("public-safe-text"),
          kind: "text",
          body: "This must remain private-safe",
        },
      },
    );
    assertApiError(textDenied, 403, "FREE_TEXT_UNAVAILABLE");
    assert.equal(presenceCountForActor(databasePath, identities.uiSeeker), 0);
    assert.equal(activeMemberCount(databasePath, created.gameId), 2);
    assert.ok(
      secondResponseBody.snapshot.events.every(
        (event) =>
          !event.message.includes(identities.uiHost.name) &&
          !event.message.includes(identities.uiSeeker.name),
      ),
    );
    assert.ok(secondResponseBody.snapshot.events.length > 0);

    const abortedErrors = browserErrors.filter(
      (entry) =>
        entry.startsWith("invitee-mobile:") &&
        /ERR_(?:FAILED|CONNECTION_RESET)|Failed to load resource/iu.test(entry),
    );
    expectedBrowserErrors.push(...abortedErrors);

    return {
      gameId: created.gameId,
      firstResponseDropped: true,
      exactCommandReplay: true,
      replayed: secondResponseBody.invite.replayed,
      communicationScope: gameRow.communicationScope,
      activeMembers: activeMemberCount(databasePath, created.gameId),
      eventFloor: Number(membership.eventFloor),
      preJoinChatHidden: chat.body.messages.length === 0,
      freeText: chat.body.viewer.capabilities.freeText,
      liveVoice: chat.body.viewer.capabilities.liveVoice,
      maximumAliasLength: seekerAlias.length,
      mobileWidth: 320,
    };
  } finally {
    await seekerContext.close();
    await hostContext.close();
    await browser.close();
  }
}

async function proveDeclineAndBlock() {
  const seekerAlias = `Blockable ${shortToken}`;
  const senderAlias = `Block Host ${shortToken}`;
  await setLobbyPresence(
    identities.blockSeeker,
    seekerAlias,
    "block-seeker-opt-in",
  );
  optedInActors.set(identities.blockSeeker.id, identities.blockSeeker);
  const game = await createGame(identities.blockHost, "block-host-create");
  await heartbeatGame(identities.blockHost, game.gameId);
  const hostDirectory = await getLobbyPresence(identities.blockHost);
  const presenceId = requireDirectoryPlayer(hostDirectory.body, seekerAlias).presenceId;
  const sent = await sendInvitation(
    identities.blockHost,
    game.gameId,
    presenceId,
    senderAlias,
    "block-send",
  );
  const inviteId = sent.body.invite.inviteId;
  const responseCommand = nextCommandId("decline-block");
  const blocked = await respondToInvitation(
    identities.blockSeeker,
    inviteId,
    responseCommand,
    "decline_and_block",
  );
  assert.equal(blocked.status, 200, blocked.raw);
  assert.deepEqual(blocked.body, {
    invite: { inviteId, state: "blocked", replayed: false },
  });
  const replay = await respondToInvitation(
    identities.blockSeeker,
    inviteId,
    responseCommand,
    "decline_and_block",
  );
  assert.equal(replay.status, 200, replay.raw);
  assert.equal(replay.body.invite.replayed, true);
  const mismatch = await respondToInvitation(
    identities.blockSeeker,
    inviteId,
    responseCommand,
    "decline",
  );
  assertApiError(mismatch, 409, "IDEMPOTENCY_KEY_REUSED");

  const afterBlock = await getLobbyPresence(identities.blockHost);
  assert.equal(
    afterBlock.body.players.some((player) => player.alias === seekerAlias),
    false,
  );
  const future = await sendInvitation(
    identities.blockHost,
    game.gameId,
    presenceId,
    senderAlias,
    "blocked-future",
    false,
  );
  assertApiError(future, 404, "LOBBY_INVITATION_UNAVAILABLE");
  assert.equal(
    queryScalar(
      databasePath,
      `SELECT COUNT(*) AS value FROM profile_blocks block
       JOIN profiles blocker ON blocker.id = block.blocker_profile_id
       JOIN profiles blocked ON blocked.id = block.blocked_profile_id
       WHERE blocker.auth_subject = ${sqlString(authSubject(identities.blockSeeker))}
         AND blocked.auth_subject = ${sqlString(authSubject(identities.blockHost))}`,
    ),
    1,
  );
  return {
    declinedAndBlocked: true,
    exactReplay: true,
    bodyMismatchRejected: true,
    bilateralDirectoryFilter: true,
    futureInviteIsGeneric: true,
  };
}

async function proveHostBlockUi() {
  const seekerAlias = `Safety-${shortToken}`.padEnd(24, "Z").slice(0, 24);
  await setLobbyPresence(
    identities.hostSafetySeeker,
    seekerAlias,
    "host-safety-seeker-opt-in",
  );
  optedInActors.set(identities.hostSafetySeeker.id, identities.hostSafetySeeker);
  const game = await createGame(identities.hostSafetyHost, "host-safety-create");
  await heartbeatGame(identities.hostSafetyHost, game.gameId);
  const directory = await getLobbyPresence(identities.hostSafetyHost);
  assertPresenceSnapshot(directory, {
    lookingForGame: false,
    canBrowse: true,
  });
  requireDirectoryPlayer(directory.body, seekerAlias);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 320, height: 900 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  try {
    await installIdentity(context, identities.hostSafetyHost);
    const page = await context.newPage();
    watchErrors(page, "host-block-mobile", browserErrors);
    await page.goto(
      new URL(`/?game=${encodeURIComponent(game.gameId)}`, baseUrl).href,
      { waitUntil: "domcontentloaded" },
    );
    const playerCard = page
      .getByRole("listitem")
      .filter({ hasText: seekerAlias });
    await playerCard.waitFor({ timeout: Math.max(requestTimeoutMs, 30_000) });
    const trigger = playerCard.getByRole("button", {
      name: `Hide and block ${seekerAlias}`,
    });
    await assertMinimumSize(trigger, 44, "mobile host block trigger");
    await trigger.click();
    let group = playerCard.getByRole("group", { name: `Block ${seekerAlias}` });
    await group.waitFor({ timeout: requestTimeoutMs });
    await expectText(group, /lasting safety action/i);
    let confirm = group.getByRole("button", { name: "Confirm block" });
    assert.equal(
      await isFocused(confirm),
      true,
      "Opening the host block confirmation must focus its informed confirm action.",
    );
    await group.getByRole("button", { name: "Cancel" }).click();
    await group.waitFor({ state: "detached", timeout: requestTimeoutMs });
    await waitForFocus(
      trigger,
      "Canceling the host block confirmation must restore trigger focus.",
    );

    await trigger.click();
    group = playerCard.getByRole("group", { name: `Block ${seekerAlias}` });
    await group.waitFor({ timeout: requestTimeoutMs });
    confirm = group.getByRole("button", { name: "Confirm block" });
    await confirm.click();
    await playerCard.waitFor({ state: "detached", timeout: requestTimeoutMs });
    await page
      .getByText(`${seekerAlias} is hidden and blocked.`, { exact: true })
      .waitFor({ timeout: requestTimeoutMs });
    await waitForFocus(
      page.locator(".lobby-presence-directory"),
      "Successful host block must hand focus to the updated directory.",
    );
    await assertNoHorizontalOverflow(page, "host block confirmation mobile");
    await page.screenshot({
      path: path.join(artifactDir, "05-host-block-confirmation-mobile.png"),
      fullPage: true,
    });
    assert.equal(
      queryScalar(
        databasePath,
        `SELECT COUNT(*) AS value FROM profile_blocks block
         JOIN profiles blocker ON blocker.id = block.blocker_profile_id
         JOIN profiles blocked ON blocked.id = block.blocked_profile_id
         WHERE blocker.auth_subject = ${sqlString(authSubject(identities.hostSafetyHost))}
           AND blocked.auth_subject = ${sqlString(authSubject(identities.hostSafetySeeker))}`,
      ),
      1,
    );
    return {
      informedConfirmation: true,
      cancelRestoresFocus: true,
      confirmBlocksAndHides: true,
      maximumAliasLength: seekerAlias.length,
      mobileWidth: 320,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function provePairAndRecipientQuotas() {
  await waitForMinuteWindow(8_000);
  const seekerAlias = `Quota Target ${shortToken}`;
  await setLobbyPresence(
    identities.quotaSeeker,
    seekerAlias,
    "quota-seeker-opt-in",
  );
  optedInActors.set(identities.quotaSeeker.id, identities.quotaSeeker);
  const pairGame = await createGame(identities.quotaHost, "quota-pair-create");
  await heartbeatGame(identities.quotaHost, pairGame.gameId);
  const directory = await getLobbyPresence(identities.quotaHost);
  const presenceId = requireDirectoryPlayer(directory.body, seekerAlias).presenceId;

  for (let index = 1; index <= 2; index += 1) {
    const sent = await sendInvitation(
      identities.quotaHost,
      pairGame.gameId,
      presenceId,
      `Pair Host ${shortToken}`,
      `pair-send-${index}`,
    );
    const declined = await respondToInvitation(
      identities.quotaSeeker,
      sent.body.invite.inviteId,
      nextCommandId(`pair-decline-${index}`),
      "decline",
    );
    assert.equal(declined.status, 200, declined.raw);
  }
  const pairLimited = await sendInvitation(
    identities.quotaHost,
    pairGame.gameId,
    presenceId,
    `Pair Host ${shortToken}`,
    "pair-send-3",
    false,
  );
  assertApiError(pairLimited, 429, "RATE_LIMITED");

  let recipientLimited = null;
  const recipientQuotaHosts = [];
  for (let index = 0; index < 19; index += 1) {
    if (index % 6 === 0) {
      await heartbeatLobbyPresence(identities.quotaSeeker);
    }
    const actor = identity(
      `quota-recipient-${index}`,
      `Recipient Quota Host ${index} ${shortToken}`,
    );
    recipientQuotaHosts.push(actor);
    const game = await createGame(actor, `recipient-quota-create-${index}`);
    await heartbeatGame(actor, game.gameId);
    const sent = await sendInvitation(
      actor,
      game.gameId,
      presenceId,
      `Quota H${index} ${shortToken}`,
      `recipient-quota-send-${index}`,
      index < 18,
    );
    if (index < 18) {
      const declined = await respondToInvitation(
        identities.quotaSeeker,
        sent.body.invite.inviteId,
        nextCommandId(`recipient-quota-decline-${index}`),
        "decline",
      );
      assert.equal(declined.status, 200, declined.raw);
    } else {
      recipientLimited = sent;
    }
  }
  assert.ok(recipientLimited);
  assertApiError(recipientLimited, 429, "RATE_LIMITED");

  const quotaProfile = profileIdForActor(databasePath, identities.quotaSeeker);
  const recipientCount = queryScalar(
    databasePath,
    `SELECT MAX(count) AS value FROM mutation_quotas
     WHERE scope = ${sqlString(`recipient:${quotaProfile}:lobby-invite`)}`,
  );
  const pairProfile = profileIdForActor(databasePath, identities.quotaHost);
  const pairCount = queryScalar(
    databasePath,
    `SELECT MAX(count) AS value FROM mutation_quotas
     WHERE scope = ${sqlString(`pair:${pairProfile}:${quotaProfile}:lobby-invite`)}`,
  );
  assert.equal(pairCount, 3);
  assert.equal(recipientCount, 21);

  return {
    pairLimit: 2,
    pairThirdAttemptCount: pairCount,
    recipientLimit: 20,
    recipientTwentyFirstAttemptCount: recipientCount,
    quotaHosts: recipientQuotaHosts.length + 1,
  };
}

async function proveAllEntryPathsClearPresence() {
  const createAlias = `Create Clear ${shortToken}`;
  await setLobbyPresence(
    identities.createClear,
    createAlias,
    "create-clear-opt-in",
  );
  optedInActors.set(identities.createClear.id, identities.createClear);
  const createdBySeeker = await createGame(
    identities.createClear,
    "create-clears-presence",
  );
  assert.equal(presenceCountForActor(databasePath, identities.createClear), 0);
  optedInActors.delete(identities.createClear.id);

  const manualGame = await createGame(identities.manualHost, "manual-clear-host");
  await setLobbyPresence(
    identities.manualGuest,
    `Manual Clear ${shortToken}`,
    "manual-clear-opt-in",
  );
  optedInActors.set(identities.manualGuest.id, identities.manualGuest);
  const manualJoin = await joinGame(
    identities.manualGuest,
    manualGame.joinCode,
    `Manual Clear ${shortToken}`,
    "manual-clear-join",
  );
  assert.equal(manualJoin.status, 200, manualJoin.raw);
  registerMember(manualGame.gameId, identities.manualGuest);
  assert.equal(presenceCountForActor(databasePath, identities.manualGuest), 0);
  optedInActors.delete(identities.manualGuest.id);

  const publicGame = await createGame(identities.publicHost, "public-clear-host");
  await publishGame(
    identities.publicHost,
    publicGame,
    `Public Host ${shortToken}`,
    "public-clear-publish",
  );
  const listingId = queryOne(
    databasePath,
    `SELECT listing_id AS listingId FROM public_game_listings
     WHERE game_id = ${sqlString(publicGame.gameId)} AND state = 'listed'`,
  ).listingId;
  assert.match(listingId, OPAQUE_ID_PATTERN);

  await setLobbyPresence(
    identities.publicGuest,
    `Public Clear ${shortToken}`,
    "public-clear-opt-in",
  );
  optedInActors.set(identities.publicGuest.id, identities.publicGuest);
  const publicJoin = await apiRequest(
    identities.publicGuest,
    `/api/public/rooms/${listingId}/join`,
    {
      method: "POST",
      body: {
        commandId: nextCommandId("selected-public-clear-join"),
        alias: `Public Clear ${shortToken}`,
      },
    },
  );
  assert.equal(publicJoin.status, 200, publicJoin.raw);
  registerMember(publicGame.gameId, identities.publicGuest);
  assert.equal(presenceCountForActor(databasePath, identities.publicGuest), 0);
  optedInActors.delete(identities.publicGuest.id);

  await setLobbyPresence(
    identities.quickGuest,
    `Quick Clear ${shortToken}`,
    "quick-clear-opt-in",
  );
  optedInActors.set(identities.quickGuest.id, identities.quickGuest);
  const quickJoin = await apiRequest(identities.quickGuest, "/api/public/quick-join", {
    method: "POST",
    body: {
      commandId: nextCommandId("quick-clear-join"),
      alias: `Quick Clear ${shortToken}`,
    },
  });
  assert.equal(quickJoin.status, 200, quickJoin.raw);
  registerMember(quickJoin.body.view.gameId, identities.quickGuest);
  assert.equal(presenceCountForActor(databasePath, identities.quickGuest), 0);
  optedInActors.delete(identities.quickGuest.id);

  return {
    create: { gameId: createdBySeeker.gameId, cleared: true },
    manualCodeJoin: { gameId: manualGame.gameId, cleared: true },
    selectedPublicJoin: { gameId: publicGame.gameId, cleared: true },
    quickJoin: { gameId: quickJoin.body.view.gameId, cleared: true },
    atomicLobbyInvitation: { cleared: true },
  };
}

async function proveConcurrentInvitationSeat() {
  const aliasA = `Race A ${shortToken}`;
  const aliasB = `Race B ${shortToken}`;
  await setLobbyPresence(identities.raceA, aliasA, "race-a-opt-in");
  await setLobbyPresence(identities.raceB, aliasB, "race-b-opt-in");
  optedInActors.set(identities.raceA.id, identities.raceA);
  optedInActors.set(identities.raceB.id, identities.raceB);

  const game = await createGame(identities.raceHost, "race-host-create");
  await heartbeatGame(identities.raceHost, game.gameId);
  const directory = await getLobbyPresence(identities.raceHost);
  const locatorA = requireDirectoryPlayer(directory.body, aliasA).presenceId;
  const locatorB = requireDirectoryPlayer(directory.body, aliasB).presenceId;
  const sentA = await sendInvitation(
    identities.raceHost,
    game.gameId,
    locatorA,
    `Race Host ${shortToken}`,
    "race-send-a",
  );
  const sentB = await sendInvitation(
    identities.raceHost,
    game.gameId,
    locatorB,
    `Race Host ${shortToken}`,
    "race-send-b",
  );

  const [acceptedA, acceptedB] = await Promise.all([
    respondToInvitation(
      identities.raceA,
      sentA.body.invite.inviteId,
      nextCommandId("race-accept-a"),
      "accept",
    ),
    respondToInvitation(
      identities.raceB,
      sentB.body.invite.inviteId,
      nextCommandId("race-accept-b"),
      "accept",
    ),
  ]);
  const accepted = [
    { actor: identities.raceA, response: acceptedA },
    { actor: identities.raceB, response: acceptedB },
  ].filter((entry) => entry.response.status === 200);
  const rejected = [acceptedA, acceptedB].filter(
    (response) => response.status === 404,
  );
  assert.equal(accepted.length, 1, `${acceptedA.raw}\n${acceptedB.raw}`);
  assert.equal(rejected.length, 1, `${acceptedA.raw}\n${acceptedB.raw}`);
  assert.equal(rejected[0].body.error.code, "LOBBY_INVITATION_UNAVAILABLE");
  registerMember(game.gameId, accepted[0].actor);
  optedInActors.delete(accepted[0].actor.id);
  assert.equal(activeMemberCount(databasePath, game.gameId), 2);
  assert.equal(
    queryScalar(
      databasePath,
      `SELECT COUNT(*) AS value FROM lobby_invitations
       WHERE game_id = ${sqlString(game.gameId)} AND state = 'accepted'`,
    ),
    1,
  );

  const fillers = [];
  for (let index = 0; index < 4; index += 1) {
    const actor = identity(`race-fill-${index}`, `Race Filler ${index} ${shortToken}`);
    fillers.push(actor);
    const joined = await joinGame(
      actor,
      game.joinCode,
      `Filler ${index} ${shortToken}`,
      `race-fill-${index}`,
    );
    assert.equal(joined.status, 200, joined.raw);
    registerMember(game.gameId, actor);
  }
  assert.equal(activeMemberCount(databasePath, game.gameId), 6);

  await setLobbyPresence(
    identities.overflow,
    `Overflow ${shortToken}`,
    "overflow-opt-in",
  );
  optedInActors.set(identities.overflow.id, identities.overflow);
  const overflow = await joinGame(
    identities.overflow,
    game.joinCode,
    `Overflow ${shortToken}`,
    "overflow-join",
    false,
  );
  assertApiError(overflow, 409, "LOBBY_FULL");
  assert.equal(activeMemberCount(databasePath, game.gameId), 6);
  assert.equal(presenceCountForActor(databasePath, identities.overflow), 1);

  return {
    concurrentAccepts: 2,
    accepted: 1,
    rejectedUnavailable: 1,
    finalCapacity: 6,
    seventhSeatRejected: true,
    unsuccessfulJoinRetainsOptIn: true,
  };
}

async function waitForLobbyPresenceRoute() {
  const deadline = Date.now() + routeWaitMs;
  let observation = "No response.";
  while (Date.now() <= deadline) {
    try {
      const response = await getLobbyPresence(identities.staleSeeker);
      if (response.status === 200 && response.body?.enabled === true) return;
      observation = `${response.status} ${response.raw}`;
      if (response.body?.error?.code === "LOBBY_PRESENCE_DISABLED") {
        throw new Error(
          "Lobby presence is disabled. Start the local server with OPEN_SHED_LOBBY_PRESENCE_ENABLED=true.",
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Lobby presence is disabled")
      ) {
        throw error;
      }
      observation = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(
    `Lobby presence routes did not become ready within ${routeWaitMs}ms (${observation}).`,
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
      `No local app is ready at ${baseUrl.origin}. Start one externally before this harness. ${String(error)}`,
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
    `Expected one local Miniflare D1 SQLite file, found ${candidates.length}.`,
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

function assertLobbyPresenceSchema(localDatabase) {
  for (const table of [
    "lobby_presence",
    "lobby_presence_receipts",
    "lobby_invitations",
  ]) {
    assert.equal(
      queryScalar(
        localDatabase,
        `SELECT COUNT(*) AS value FROM sqlite_master
         WHERE type = 'table' AND name = ${sqlString(table)}`,
      ),
      1,
      `Local D1 is missing ${table}.`,
    );
  }
  for (const index of [
    "idx_lobby_presence_locator",
    "idx_lobby_invitations_sender_command",
    "idx_lobby_invitations_recipient_response_command",
    "idx_lobby_invitations_pending_key",
  ]) {
    assert.equal(
      queryScalar(
        localDatabase,
        `SELECT COUNT(*) AS value FROM sqlite_master
         WHERE type = 'index' AND name = ${sqlString(index)}`,
      ),
      1,
      `Local D1 is missing ${index}.`,
    );
  }
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
  const game = {
    gameId: response.body.view.gameId,
    joinCode: response.body.view.joinCode,
    revision: response.body.view.revision,
    listing: response.body.listing,
  };
  gamesForCleanup.set(game.gameId, {
    gameId: game.gameId,
    host: actor,
    members: [actor],
  });
  return game;
}

async function joinGame(actor, joinCode, alias, label, expectSuccess = true) {
  const response = await apiRequest(actor, "/api/games/join", {
    method: "POST",
    body: {
      commandId: nextCommandId(label),
      joinCode,
      nickname: alias,
    },
  });
  if (expectSuccess) assert.equal(response.status, 200, response.raw);
  return response;
}

async function publishGame(actor, game, alias, label) {
  const response = await apiRequest(
    actor,
    `/api/games/${game.gameId}/listing`,
    {
      method: "POST",
      body: {
        action: "publish",
        alias,
        pace: "casual",
        commandId: nextCommandId(label),
        expectedRevision: game.revision,
        expectedListingVersion: game.listing.version,
      },
    },
  );
  assert.equal(response.status, 200, response.raw);
  return response;
}

async function setLobbyPresence(actor, alias, label) {
  const response = await apiRequest(actor, "/api/lobby-presence", {
    method: "PUT",
    body: {
      commandId: nextCommandId(label),
      lookingForGame: true,
      alias,
    },
  });
  assert.equal(response.status, 200, response.raw);
  assertPresenceSnapshot(response, {
    lookingForGame: true,
    alias,
  });
  return response;
}

async function stopLobbyPresence(actor, label) {
  return apiRequest(actor, "/api/lobby-presence", {
    method: "PUT",
    body: {
      commandId: nextCommandId(label),
      lookingForGame: false,
    },
  });
}

async function getLobbyPresence(actor) {
  return apiRequest(actor, "/api/lobby-presence", { method: "GET" });
}

async function heartbeatLobbyPresence(actor) {
  const response = await apiRequest(actor, "/api/lobby-presence/heartbeat", {
    method: "POST",
    body: {},
  });
  assert.equal(response.status, 200, response.raw);
  return response;
}

async function heartbeatGame(actor, gameId) {
  const response = await apiRequest(actor, `/api/games/${gameId}/presence`, {
    method: "POST",
    body: {},
  });
  assert.equal(response.status, 200, response.raw);
  return response;
}

async function sendInvitation(
  actor,
  gameId,
  presenceId,
  senderAlias,
  label,
  expectSuccess = true,
) {
  const response = await apiRequest(
    actor,
    `/api/games/${gameId}/lobby-invites`,
    {
      method: "POST",
      body: {
        commandId: nextCommandId(label),
        presenceId,
        senderAlias,
      },
    },
  );
  if (expectSuccess) {
    assert.equal(response.status, 201, response.raw);
    assertExactKeys(response.body, SENT_INVITE_KEYS, "send invitation response");
    assertExactKeys(
      response.body.invite,
      SENT_INVITE_DETAIL_KEYS,
      "send invitation detail",
    );
    assert.match(response.body.invite.inviteId, OPAQUE_ID_PATTERN);
    assert.equal(response.body.invite.state, "sent");
    assert.equal(typeof response.body.invite.replayed, "boolean");
  }
  return response;
}

async function respondToInvitation(actor, inviteId, commandId, action) {
  return apiRequest(actor, `/api/lobby-invites/${inviteId}/respond`, {
    method: "POST",
    body: { commandId, action },
  });
}

function assertPresenceSnapshot(
  response,
  { lookingForGame, canBrowse, alias },
) {
  assert.equal(response.status, 200, response.raw);
  assertExactKeys(response.body, PRESENCE_KEYS, "lobby presence response");
  assert.equal(response.body.enabled, true);
  assertExactKeys(response.body.self, SELF_KEYS, "lobby presence self");
  assert.equal(response.body.self.lookingForGame, lookingForGame);
  if (canBrowse !== undefined) {
    assert.equal(response.body.self.canBrowse, canBrowse);
  }
  if (alias !== undefined) assert.equal(response.body.self.alias, alias);
  assert.equal(
    response.body.self.lookingForGame,
    response.body.self.alias !== null,
  );
  assert.ok(Array.isArray(response.body.players));
  assert.ok(response.body.players.length <= 20);
  for (const player of response.body.players) {
    assertExactKeys(player, PLAYER_KEYS, "lobby directory player");
    assert.match(player.presenceId, OPAQUE_ID_PATTERN);
    assert.ok(player.status === "online" || player.status === "reconnecting");
    assert.ok(player.inviteState === "idle" || player.inviteState === "sent");
  }
  assert.ok(Array.isArray(response.body.invites));
  assert.ok(response.body.invites.length <= 10);
  for (const invite of response.body.invites) {
    assertExactKeys(invite, INVITE_CARD_KEYS, "incoming lobby invitation");
    assert.match(invite.inviteId, OPAQUE_ID_PATTERN);
  }
  assertNoForbiddenKeys(response.body);
}

function requireDirectoryPlayer(snapshot, alias) {
  const player = snapshot.players.find((candidate) => candidate.alias === alias);
  assert.ok(player, `Expected ${alias} in the privacy-safe lobby directory.`);
  return player;
}

function assertDirectorySecretsAbsent(snapshot, secrets) {
  assertNoForbiddenKeys(snapshot);
  assertSensitiveValuesAbsent(JSON.stringify(snapshot), secrets);
}

function assertNoForbiddenKeys(value, pathLabel = "$presence") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoForbiddenKeys(entry, `${pathLabel}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    assert.equal(
      FORBIDDEN_DIRECTORY_KEYS.has(key),
      false,
      `Forbidden lobby-directory key ${key} appeared at ${pathLabel}.`,
    );
    assertNoForbiddenKeys(entry, `${pathLabel}.${key}`);
  }
}

function assertExactKeys(value, expected, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), label);
}

function assertApiError(response, status, code) {
  assert.equal(response.status, status, response.raw);
  assert.equal(response.body?.error?.code, code, response.raw);
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
    cache: "no-store",
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

function presenceCountForActor(localDatabase, actor) {
  return queryScalar(
    localDatabase,
    `SELECT COUNT(*) AS value FROM lobby_presence presence
     JOIN profiles profile ON profile.id = presence.profile_id
     WHERE profile.auth_subject = ${sqlString(authSubject(actor))}`,
  );
}

function presenceIdForActor(localDatabase, actor) {
  const row = queryOne(
    localDatabase,
    `SELECT presence.presence_id AS presenceId
     FROM lobby_presence presence
     JOIN profiles profile ON profile.id = presence.profile_id
     WHERE profile.auth_subject = ${sqlString(authSubject(actor))}`,
  );
  assert.match(row.presenceId, OPAQUE_ID_PATTERN);
  return row.presenceId;
}

function profileIdForActor(localDatabase, actor) {
  const row = queryOne(
    localDatabase,
    `SELECT id FROM profiles
     WHERE auth_subject = ${sqlString(authSubject(actor))}`,
  );
  return row.id;
}

function activeMemberCount(localDatabase, gameId) {
  return queryScalar(
    localDatabase,
    `SELECT COUNT(*) AS value FROM game_members
     WHERE game_id = ${sqlString(gameId)} AND status <> 'left'`,
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
    /^\s*(SELECT|WITH)\b/iu,
    "Acceptance D1 inspection is read-only.",
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

async function expectText(locator, pattern) {
  const text = await locator.innerText();
  assert.match(text, pattern);
}

async function isFocused(locator) {
  return locator.evaluate((element) => element === document.activeElement);
}

async function waitForFocus(locator, message) {
  const deadline = Date.now() + requestTimeoutMs;
  while (Date.now() <= deadline) {
    if (await isFocused(locator)) return;
    await delay(20);
  }
  assert.fail(message);
}

async function assertMinimumSize(locator, minimum, label) {
  const box = await locator.boundingBox();
  assert.ok(box, `${label} must be visible.`);
  assert.ok(
    box.width >= minimum && box.height >= minimum,
    `${label} measured ${box.width}×${box.height}; expected at least ${minimum}×${minimum}.`,
  );
}

async function assertNoHorizontalOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(
    Math.max(dimensions.scroll, dimensions.body) <= dimensions.viewport + 1,
    `${label} overflows horizontally: ${JSON.stringify(dimensions)}`,
  );
}

async function cleanupOptedInActors() {
  for (const actor of optedInActors.values()) {
    try {
      const response = await stopLobbyPresence(actor, "cleanup-opt-out");
      if (![200, 404, 409].includes(response.status)) {
        summary.cleanupErrors.push({
          actor: actor.id,
          operation: "lobby-opt-out",
          status: response.status,
          body: response.raw,
        });
      }
    } catch (error) {
      summary.cleanupErrors.push({
        actor: actor.id,
        operation: "lobby-opt-out",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function cleanupCreatedGames() {
  for (const record of [...gamesForCleanup.values()].reverse()) {
    for (const actor of [...record.members].reverse()) {
      try {
        await leaveIfOpen(actor, record.gameId);
      } catch (error) {
        summary.cleanupErrors.push({
          actor: actor.id,
          gameId: record.gameId,
          operation: "leave",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

async function leaveIfOpen(actor, gameId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snapshot = await apiRequest(
      actor,
      `/api/games/${encodeURIComponent(gameId)}?afterRevision=0`,
      { method: "GET" },
    );
    if (
      snapshot.status === 410 ||
      ["NOT_A_MEMBER", "ROOM_CLOSED", "GAME_NOT_FOUND"].includes(
        snapshot.body?.error?.code,
      )
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

function identity(label, name) {
  return {
    id: `v162-${label}-${runToken}`
      .replace(/[^a-zA-Z0-9_-]/gu, "")
      .slice(0, 40),
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

function assertSensitiveValuesAbsent(value, secrets) {
  const text = String(value);
  for (const secret of secrets.filter(Boolean)) {
    assert.equal(
      text.includes(String(secret)),
      false,
      `Privacy-sensitive value leaked into an allowlisted response: ${secret}`,
    );
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

async function waitForMinuteWindow(minimumRemainingMs) {
  const position = Date.now() % 60_000;
  const remaining = 60_000 - position;
  if (remaining < minimumRemainingMs) await delay(remaining + 100);
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
