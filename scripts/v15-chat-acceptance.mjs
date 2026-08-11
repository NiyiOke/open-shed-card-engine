import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = new URL(
  process.env.V15_CHAT_BASE_URL ?? "http://localhost:3000",
);
assert.equal(
  baseUrl.hostname,
  "localhost",
  "The chat acceptance harness is local-only and refuses non-localhost targets.",
);
assert.equal(
  baseUrl.protocol,
  "http:",
  "The chat acceptance harness only targets a local HTTP development server.",
);
assert.equal(baseUrl.username, "", "The local target must not contain credentials.");
assert.equal(baseUrl.password, "", "The local target must not contain credentials.");
baseUrl.pathname = "/";
baseUrl.search = "";
baseUrl.hash = "";

const expectedMode = process.env.V15_CHAT_EXPECT_MODE ?? "enabled";
assert.ok(
  expectedMode === "enabled" || expectedMode === "disabled",
  "V15_CHAT_EXPECT_MODE must be enabled or disabled.",
);

const runToken = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
const shortToken = randomBytes(4).toString("hex");
const artifactRoot =
  process.env.V15_CHAT_ARTIFACT_DIR ?? "/tmp/open-shed-v15-chat-acceptance";
const artifactDir = path.join(artifactRoot, runToken);
const requestTimeoutMs = positiveInteger(
  process.env.V15_CHAT_REQUEST_TIMEOUT_MS,
  12_000,
);
const routeWaitMs = positiveInteger(
  process.env.V15_CHAT_ROUTE_WAIT_MS,
  30_000,
);
const pollWaitMs = positiveInteger(process.env.V15_CHAT_POLL_WAIT_MS, 12_000);
const applicationLogPath = path.resolve(
  process.env.V15_CHAT_LOG_PATH ?? ".wrangler/wrangler.log",
);
const messageRetentionMs = 86_400_000;
const reportRetentionMs = 7_776_000_000;

const phrases = [
  ["your_turn", "Your turn"],
  ["nice_play", "Nice play"],
  ["one_second", "One second"],
  ["ready", "Ready"],
  ["good_game", "Good game"],
  ["rematch", "Rematch?"],
];
const reactions = [
  ["wave", "Wave"],
  ["clap", "Clap"],
  ["laugh", "Laugh"],
  ["surprised", "Surprised"],
  ["thinking", "Thinking"],
  ["fire", "Fire"],
];
const reactionIcons = {
  wave: "👋",
  clap: "👏",
  laugh: "😄",
  surprised: "😮",
  thinking: "🤔",
  fire: "🔥",
};
const reportReasons = [
  "harassment",
  "hate",
  "sexual_grooming",
  "threat_self_harm",
  "personal_information",
  "spam_scam",
  "cheating",
  "other",
];
const messageSequence = [
  ...phrases.map(([contentId, label]) => ({
    kind: "phrase",
    contentId,
    label,
  })),
  ...reactions.map(([contentId, label]) => ({
    kind: "reaction",
    contentId,
    label,
  })),
];

const identities = {
  host: identity("host", `SECRET_CHAT_HOST_${shortToken}`),
  guest: identity("guest", `SECRET_CHAT_GUEST_${shortToken}`),
  outsider: identity("outsider", `SECRET_CHAT_OUTSIDER_${shortToken}`),
  foreignHost: identity("foreign-host", `SECRET_CHAT_FOREIGN_${shortToken}`),
};
const aliases = {
  host: `ChatHost-${shortToken}`,
  guest: `ChatGuest-${shortToken}`,
  foreignHost: `OtherHost-${shortToken}`,
};

const restrictedValues = new Set([
  ...Object.values(identities).map((actor) => actor.name),
  ...Object.values(aliases),
  ...messageSequence.flatMap(({ contentId, label }) => [contentId, label]),
  ...reportReasons,
]);
const browserConsole = [];
const networkTraffic = [];
const cleanupErrors = [];
const gamesForCleanup = new Map();
const actorLastSendAt = new Map();
let databasePath = null;
let commandSequence = 0;
let logStartOffset = 0;

const summary = {
  runToken,
  baseUrl: baseUrl.origin,
  expectedMode,
  localDatabase: null,
  scenarios: {},
  browserConsole,
  networkTraffic,
  cleanupErrors,
};

await mkdir(artifactDir, { recursive: true });

try {
  await assertLocalServer();
  databasePath = await discoverLocalGameDatabase();
  summary.localDatabase = databasePath;
  assertCommunicationSchema(databasePath);
  logStartOffset = await applicationLogOffset();

  if (expectedMode === "disabled") {
    summary.scenarios.featureDisabled = await proveFeatureDisabled(databasePath);
  } else {
    const main = await createSharedTable(
      identities.host,
      aliases.host,
      identities.guest,
      aliases.guest,
      "main",
    );
    const scopeTable = await createSharedTable(
      identities.host,
      aliases.host,
      identities.guest,
      aliases.guest,
      "scope",
    );
    const foreign = await createGame(
      identities.foreignHost,
      aliases.foreignHost,
      "foreign",
    );

    await waitForCommunicationRoutes(main.gameId);
    summary.scenarios.adversarialBoundaries =
      await proveAdversarialBoundaries(databasePath, main, foreign);
    const browserSession = await openChatBrowsers(main, foreign);
    try {
      const exchange = await proveAllowlistedExchange(
        databasePath,
        main,
        browserSession,
      );
      summary.scenarios.allowlistedExchange = exchange.result;
      summary.scenarios.idempotency = await proveMessageIdempotency(
        databasePath,
        main,
        exchange,
      );
      summary.scenarios.report = await proveReportEvidence(
        databasePath,
        main,
        exchange,
        browserSession,
      );
      summary.scenarios.mute = await proveMuteScope(
        databasePath,
        main,
        scopeTable,
        browserSession,
      );
      summary.scenarios.block = await provePersistentBlock(
        databasePath,
        main,
        scopeTable,
        browserSession,
      );
      summary.scenarios.gameIsolation = await proveGameStateIsolation(
        databasePath,
        main,
        browserSession,
      );
      summary.scenarios.mobileAccessibility =
        await proveMobileAccessibility(browserSession);
    } finally {
      await browserSession.close();
    }
    summary.scenarios.retention = await proveRetentionContracts(
      databasePath,
      main,
    );
    summary.scenarios.leaveDenial = await proveLeaveDenial(databasePath, main);
    summary.scenarios.logRedaction = await proveGeneralLogRedaction(
      databasePath,
      main,
    );
  }

  const unexpectedConsole = browserConsole.filter(
    (entry) =>
      entry.type === "error" ||
      entry.type === "pageerror" ||
      entry.type === "restricted",
  );
  assert.deepEqual(
    unexpectedConsole,
    [],
    `Unexpected browser errors: ${JSON.stringify(unexpectedConsole)}`,
  );
  await writeArtifacts();
  process.stdout.write(
    `V1.5 chat acceptance (${expectedMode}) passed. Artifacts: ${artifactDir}\n`,
  );
} catch (error) {
  summary.failure = redactRestricted(
    error instanceof Error ? error.stack ?? error.message : String(error),
  );
  await writeArtifacts();
  throw error;
} finally {
  await cleanupCreatedGames();
  await writeArtifacts();
}

async function proveFeatureDisabled(localDatabase) {
  const table = await createGame(
    identities.host,
    aliases.host,
    "disabled",
  );
  const before = communicationCounts(localDatabase, table.gameId);
  const get = await apiRequest(
    identities.host,
    `/api/games/${encodeURIComponent(table.gameId)}/messages`,
    { method: "GET" },
  );
  assertApiError(get, 404, "COMMUNICATION_DISABLED");
  const post = await apiRequest(
    identities.host,
    `/api/games/${encodeURIComponent(table.gameId)}/messages`,
    {
      method: "POST",
      body: {
        commandId: nextCommandId("disabled-send"),
        kind: "phrase",
        contentId: "your_turn",
      },
    },
  );
  assertApiError(post, 404, "COMMUNICATION_DISABLED");
  assert.deepEqual(communicationCounts(localDatabase, table.gameId), before);
  return { readsRejected: true, writesRejected: true, rowsChanged: false };
}

async function proveAdversarialBoundaries(localDatabase, main, foreign) {
  const before = communicationCounts(localDatabase, main.gameId);
  const profileBefore = profileCountForActor(localDatabase, identities.outsider);
  const invalidBodies = [
    {
      label: "free-text",
      body: { commandId: nextCommandId("text"), text: "do not store me" },
      code: "FREE_TEXT_DISABLED",
    },
    {
      label: "message-body",
      body: { commandId: nextCommandId("body"), body: "do not store me" },
      code: "FREE_TEXT_DISABLED",
    },
    {
      label: "spoofed-sender",
      body: {
        commandId: nextCommandId("spoof"),
        kind: "phrase",
        contentId: "your_turn",
        senderPlayerId: main.guestPlayerId,
      },
      code: "INVALID_MESSAGE",
    },
    {
      label: "invalid-kind",
      body: {
        commandId: nextCommandId("kind"),
        kind: "free_text",
        contentId: "your_turn",
      },
      code: "INVALID_MESSAGE",
    },
    {
      label: "invalid-content",
      body: {
        commandId: nextCommandId("content"),
        kind: "reaction",
        contentId: "your_turn",
      },
      code: "INVALID_MESSAGE",
    },
  ];
  for (const scenario of invalidBodies) {
    const response = await apiRequest(
      identities.host,
      `/api/games/${encodeURIComponent(main.gameId)}/messages`,
      { method: "POST", body: scenario.body },
    );
    assertApiError(response, 400, scenario.code);
    assert.deepEqual(
      communicationCounts(localDatabase, main.gameId),
      before,
      `${scenario.label} must not create a communication row.`,
    );
  }

  const outsiderRead = await apiRequest(
    identities.outsider,
    `/api/games/${encodeURIComponent(main.gameId)}/messages`,
    { method: "GET" },
  );
  assertApiError(outsiderRead, 403, "NOT_A_MEMBER");
  const outsiderSend = await apiRequest(
    identities.outsider,
    `/api/games/${encodeURIComponent(main.gameId)}/messages`,
    {
      method: "POST",
      body: {
        commandId: nextCommandId("outsider-send"),
        kind: "phrase",
        contentId: "your_turn",
      },
    },
  );
  assertApiError(outsiderSend, 403, "NOT_A_MEMBER");
  assert.equal(
    profileCountForActor(localDatabase, identities.outsider),
    profileBefore,
    "Rejected chat access must not provision an outsider profile.",
  );
  assert.deepEqual(communicationCounts(localDatabase, main.gameId), before);

  const crossRoomRead = await apiRequest(
    identities.host,
    `/api/games/${encodeURIComponent(foreign.gameId)}/messages`,
    { method: "GET" },
  );
  assertApiError(crossRoomRead, 403, "NOT_A_MEMBER");

  for (const messageId of ["0".repeat(32), "not-an-opaque-message-id"]) {
    const report = await apiRequest(
      identities.guest,
      `/api/messages/${encodeURIComponent(messageId)}/report`,
      {
        method: "POST",
        body: {
          commandId: nextCommandId("missing-report"),
          reason: "harassment",
        },
      },
    );
    if (messageId.length === 32) {
      assertApiError(report, 404, "CHAT_MESSAGE_NOT_FOUND");
    } else {
      assert.equal(report.status, 400, report.raw);
    }
  }

  return {
    invalidBodies: invalidBodies.length,
    outsiderDenied: true,
    crossRoomDenied: true,
    rowsChanged: false,
  };
}

async function proveAllowlistedExchange(localDatabase, main, browserSession) {
  await browserSession.openActivityBeforeMessages();
  const records = [];
  for (const [index, item] of messageSequence.entries()) {
    const actor = index % 2 === 0 ? identities.host : identities.guest;
    await waitForActorSendWindow(actor);
    const commandId = nextCommandId(`allowlisted-${item.kind}`);
    const body = { commandId, kind: item.kind, contentId: item.contentId };
    const response = await apiRequest(
      actor,
      `/api/games/${encodeURIComponent(main.gameId)}/messages`,
      { method: "POST", body },
    );
    assert.equal(response.status, 200, response.raw);
    assertExactKeys(response.body, ["message", "replayed"], "message send");
    assert.equal(response.body.replayed, false);
    assertMessageDto(response.body.message);
    assert.equal(response.body.message.kind, item.kind);
    assert.equal(response.body.message.contentId, item.contentId);
    assert.equal(
      response.body.message.senderPlayerId,
      actor === identities.host ? main.hostPlayerId : main.guestPlayerId,
    );
    assert.equal(
      response.body.message.senderDisplayName,
      actor === identities.host ? aliases.host : aliases.guest,
    );
    actorLastSendAt.set(actor.id, Date.now());
    records.push({ actor, item, commandId, body, message: response.body.message });
  }

  const hostPage = await readMessages(identities.host, main.gameId);
  const guestPage = await readMessages(identities.guest, main.gameId);
  assert.deepEqual(
    hostPage.messages.map(({ kind, contentId }) => ({ kind, contentId })),
    messageSequence.map(({ kind, contentId }) => ({ kind, contentId })),
  );
  assert.deepEqual(guestPage.messages, hostPage.messages);
  assert.equal(hostPage.nextCursor, records.at(-1).message.id);
  assert.equal(guestPage.nextCursor, records.at(-1).message.id);
  assert.deepEqual(hostPage.viewer, {
    mutedPlayerIds: [],
    blockedPlayerIds: [],
  });

  const stored = queryRows(
    localDatabase,
    `SELECT id, sender_player_id AS senderPlayerId,
            sender_display_name AS senderDisplayName, kind,
            content_id AS contentId, command_id AS commandId,
            created_at AS createdAt, expires_at AS expiresAt
     FROM game_messages
     WHERE game_id = ${sqlString(main.gameId)}
     ORDER BY created_at ASC, id ASC`,
  );
  assert.equal(stored.length, messageSequence.length);
  assert.deepEqual(
    stored.map(({ kind, contentId }) => ({ kind, contentId })),
    messageSequence.map(({ kind, contentId }) => ({ kind, contentId })),
  );
  for (const row of stored) {
    assert.equal(Number(row.expiresAt) - Number(row.createdAt), messageRetentionMs);
  }

  await browserSession.proveUnreadAndOrderedLog(records);
  return {
    records,
    result: {
      phraseCount: phrases.length,
      reactionCount: reactions.length,
      exchangedByBothMembers: true,
      chronological: true,
      unreadClearedOnChatOpen: true,
    },
  };
}

async function proveMessageIdempotency(localDatabase, main, exchange) {
  const original = exchange.records[0];
  const before = messageCount(localDatabase, main.gameId);
  const replay = await apiRequest(
    original.actor,
    `/api/games/${encodeURIComponent(main.gameId)}/messages`,
    { method: "POST", body: original.body },
  );
  assert.equal(replay.status, 200, replay.raw);
  assertExactKeys(replay.body, ["message", "replayed"], "message replay");
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.message, original.message);
  assert.equal(messageCount(localDatabase, main.gameId), before);

  const mismatch = await apiRequest(
    original.actor,
    `/api/games/${encodeURIComponent(main.gameId)}/messages`,
    {
      method: "POST",
      body: {
        ...original.body,
        contentId: original.item.contentId === "your_turn" ? "nice_play" : "your_turn",
      },
    },
  );
  assertApiError(mismatch, 409, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(messageCount(localDatabase, main.gameId), before);
  return { replayed: true, duplicateRows: 0, bodyReuseRejected: true };
}

async function proveReportEvidence(
  localDatabase,
  main,
  exchange,
  browserSession,
) {
  const target = exchange.records.find(
    (record) => record.actor === identities.host,
  );
  assert.ok(target, "The exchange must contain a host message to report.");
  await browserSession.proveReportDialog(target.message);

  const commandId = nextCommandId("report");
  const body = { commandId, reason: "sexual_grooming" };
  const report = await apiRequest(
    identities.guest,
    `/api/messages/${encodeURIComponent(target.message.id)}/report`,
    { method: "POST", body },
  );
  assert.equal(report.status, 200, report.raw);
  assert.deepEqual(report.body, { received: true, replayed: false });

  const evidence = queryOne(
    localDatabase,
    `SELECT game_id AS gameId, message_id AS messageId,
            evidence_sender_player_id AS senderPlayerId,
            evidence_sender_display_name AS senderDisplayName,
            evidence_kind AS kind, evidence_content_id AS contentId,
            evidence_created_at AS messageCreatedAt, reason,
            moderation_state AS moderationState,
            command_id AS commandId, created_at AS createdAt,
            expires_at AS expiresAt
     FROM game_message_reports
     WHERE reporter_profile_id = ${profileIdSql(localDatabase, identities.guest)}
       AND command_id = ${sqlString(commandId)}`,
  );
  assert.deepEqual(
    {
      gameId: evidence.gameId,
      messageId: evidence.messageId,
      senderPlayerId: evidence.senderPlayerId,
      senderDisplayName: evidence.senderDisplayName,
      kind: evidence.kind,
      contentId: evidence.contentId,
      messageCreatedAt: Number(evidence.messageCreatedAt),
    },
    {
      gameId: main.gameId,
      messageId: target.message.id,
      senderPlayerId: target.message.senderPlayerId,
      senderDisplayName: target.message.senderDisplayName,
      kind: target.message.kind,
      contentId: target.message.contentId,
      messageCreatedAt: target.message.createdAt,
    },
  );
  assert.equal(evidence.reason, body.reason);
  assert.equal(evidence.moderationState, "pending");
  assert.equal(Number(evidence.expiresAt) - Number(evidence.createdAt), reportRetentionMs);

  const replay = await apiRequest(
    identities.guest,
    `/api/messages/${encodeURIComponent(target.message.id)}/report`,
    { method: "POST", body },
  );
  assert.equal(replay.status, 200, replay.raw);
  assert.deepEqual(replay.body, { received: true, replayed: true });
  assert.equal(reportCount(localDatabase, main.gameId), 1);
  assert.deepEqual(
    queryOne(
      localDatabase,
      `SELECT message_id AS messageId, evidence_sender_player_id AS senderPlayerId,
              evidence_sender_display_name AS senderDisplayName,
              evidence_kind AS kind, evidence_content_id AS contentId,
              evidence_created_at AS messageCreatedAt, reason,
              moderation_state AS moderationState, created_at AS createdAt,
              expires_at AS expiresAt
       FROM game_message_reports
       WHERE reporter_profile_id = ${profileIdSql(localDatabase, identities.guest)}
         AND command_id = ${sqlString(commandId)}`,
    ),
    {
      messageId: evidence.messageId,
      senderPlayerId: evidence.senderPlayerId,
      senderDisplayName: evidence.senderDisplayName,
      kind: evidence.kind,
      contentId: evidence.contentId,
      messageCreatedAt: evidence.messageCreatedAt,
      reason: evidence.reason,
      moderationState: evidence.moderationState,
      createdAt: evidence.createdAt,
      expiresAt: evidence.expiresAt,
    },
    "A report replay must not rewrite its immutable evidence snapshot.",
  );

  const mismatch = await apiRequest(
    identities.guest,
    `/api/messages/${encodeURIComponent(target.message.id)}/report`,
    {
      method: "POST",
      body: { commandId, reason: "hate" },
    },
  );
  assertApiError(mismatch, 409, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(reportCount(localDatabase, main.gameId), 1);

  for (const reason of ["not_a_reason", ""]) {
    const badReason = await apiRequest(
      identities.guest,
      `/api/messages/${encodeURIComponent(target.message.id)}/report`,
      {
        method: "POST",
        body: { commandId: nextCommandId("bad-report"), reason },
      },
    );
    assert.equal(badReason.status, 400, badReason.raw);
  }
  assert.equal(reportCount(localDatabase, main.gameId), 1);
  return {
    received: true,
    replayed: true,
    immutableEvidence: true,
    retentionMs: reportRetentionMs,
  };
}

async function proveMuteScope(
  localDatabase,
  main,
  scopeTable,
  browserSession,
) {
  const gameBefore = gameIntegrity(localDatabase, main.gameId);
  const mute = await relationshipRequest(
    identities.guest,
    main.gameId,
    main.hostPlayerId,
    "mute",
    "PUT",
  );
  assert.equal(mute.status, 200, mute.raw);
  assert.deepEqual(mute.body, { muted: true });
  assert.deepEqual(gameIntegrity(localDatabase, main.gameId), gameBefore);

  const mainMessage = await sendMessage(
    identities.host,
    main.gameId,
    "phrase",
    "your_turn",
    "muted-main",
  );
  const guestMain = await readMessages(identities.guest, main.gameId);
  assert.equal(
    guestMain.messages.some((message) => message.id === mainMessage.id),
    false,
  );
  assert.deepEqual(guestMain.viewer.mutedPlayerIds, [main.hostPlayerId]);
  assert.deepEqual(guestMain.viewer.blockedPlayerIds, []);
  const hostMain = await readMessages(identities.host, main.gameId);
  assert.equal(
    hostMain.messages.some((message) => message.id === mainMessage.id),
    true,
  );

  const scopedMessage = await sendMessage(
    identities.host,
    scopeTable.gameId,
    "reaction",
    "wave",
    "mute-scope",
  );
  const guestScope = await readMessages(identities.guest, scopeTable.gameId);
  assert.equal(
    guestScope.messages.some((message) => message.id === scopedMessage.id),
    true,
    "A mute must not cross the table boundary.",
  );
  assert.deepEqual(guestScope.viewer.mutedPlayerIds, []);

  await browserSession.provePersistedRelationship(
    "mute",
    main.hostPlayerId,
    mainMessage,
  );

  const unmute = await relationshipRequest(
    identities.guest,
    main.gameId,
    main.hostPlayerId,
    "mute",
    "DELETE",
  );
  assert.equal(unmute.status, 200, unmute.raw);
  assert.deepEqual(unmute.body, { muted: false });
  const after = await readMessages(identities.guest, main.gameId);
  assert.deepEqual(after.viewer.mutedPlayerIds, []);
  assert.equal(
    after.messages.some((message) => message.id === mainMessage.id),
    true,
  );
  return {
    tableScoped: true,
    refreshPersistent: true,
    announcementsSuppressed: true,
    gameRevisionChanged: false,
  };
}

async function provePersistentBlock(
  localDatabase,
  main,
  scopeTable,
  browserSession,
) {
  const gameBefore = gameIntegrity(localDatabase, main.gameId);
  const membershipBefore = membershipIntegrity(localDatabase, main.gameId);
  const eventCountBefore = gameEventCount(localDatabase, main.gameId);
  const block = await relationshipRequest(
    identities.guest,
    main.gameId,
    main.hostPlayerId,
    "block",
    "PUT",
  );
  assert.equal(block.status, 200, block.raw);
  assert.deepEqual(block.body, { blocked: true });
  assert.deepEqual(gameIntegrity(localDatabase, main.gameId), gameBefore);
  assert.deepEqual(membershipIntegrity(localDatabase, main.gameId), membershipBefore);
  assert.equal(gameEventCount(localDatabase, main.gameId), eventCountBefore);

  const mainMessage = await sendMessage(
    identities.host,
    main.gameId,
    "reaction",
    "clap",
    "blocked-main",
  );
  const scopeMessage = await sendMessage(
    identities.host,
    scopeTable.gameId,
    "phrase",
    "good_game",
    "blocked-scope",
  );
  const mainFeed = await readMessages(identities.guest, main.gameId);
  const scopeFeed = await readMessages(identities.guest, scopeTable.gameId);
  assert.equal(mainFeed.messages.some(({ id }) => id === mainMessage.id), false);
  assert.equal(scopeFeed.messages.some(({ id }) => id === scopeMessage.id), false);
  assert.deepEqual(mainFeed.viewer.blockedPlayerIds, [main.hostPlayerId]);
  assert.deepEqual(scopeFeed.viewer.blockedPlayerIds, [scopeTable.hostPlayerId]);
  assert.equal(
    blockCount(localDatabase, identities.guest, identities.host),
    1,
    "A block must be one persistent profile relationship.",
  );
  await browserSession.provePersistedRelationship(
    "block",
    main.hostPlayerId,
    mainMessage,
  );

  const unblock = await relationshipRequest(
    identities.guest,
    main.gameId,
    main.hostPlayerId,
    "block",
    "DELETE",
  );
  assert.equal(unblock.status, 200, unblock.raw);
  assert.deepEqual(unblock.body, { blocked: false });
  assert.equal(blockCount(localDatabase, identities.guest, identities.host), 0);
  assert.deepEqual(gameIntegrity(localDatabase, main.gameId), gameBefore);
  assert.deepEqual(membershipIntegrity(localDatabase, main.gameId), membershipBefore);
  assert.equal(gameEventCount(localDatabase, main.gameId), eventCountBefore);
  return {
    persistentAcrossTables: true,
    silent: true,
    currentGameChanged: false,
    membershipChanged: false,
  };
}

async function proveGameStateIsolation(localDatabase, main, browserSession) {
  const beforeFailure = gameIntegrity(localDatabase, main.gameId);
  const beforeEvents = gameEventCount(localDatabase, main.gameId);
  const failed = await apiRequest(
    identities.host,
    `/api/games/${encodeURIComponent(main.gameId)}/messages`,
    {
      method: "POST",
      body: {
        commandId: nextCommandId("isolation-text"),
        message: "this field must never enter the game",
      },
    },
  );
  assertApiError(failed, 400, "FREE_TEXT_DISABLED");
  assert.deepEqual(gameIntegrity(localDatabase, main.gameId), beforeFailure);
  assert.equal(gameEventCount(localDatabase, main.gameId), beforeEvents);

  let snapshot = await readGame(identities.host, main.gameId);
  let hostReady = await sendGameCommand(
    identities.host,
    main.gameId,
    snapshot.view.revision,
    { type: "set_ready", ready: true },
    "isolation-host-ready",
  );
  let guestReady = await sendGameCommand(
    identities.guest,
    main.gameId,
    hostReady.view.revision,
    { type: "set_ready", ready: true },
    "isolation-guest-ready",
  );
  const started = await sendGameCommand(
    identities.host,
    main.gameId,
    guestReady.view.revision,
    { type: "start_game" },
    "isolation-start",
  );
  assert.equal(started.view.phase, "playing");

  const turnActor = started.view.players.find(
    (player) => player.playerId === started.view.currentPlayerId,
  )?.displayName === aliases.host
    ? identities.host
    : identities.guest;
  snapshot = await readGame(turnActor, main.gameId);
  const rowBeforeCardFailure = gameIntegrity(localDatabase, main.gameId);
  const chatFailure = await apiRequest(
    turnActor,
    `/api/games/${encodeURIComponent(main.gameId)}/messages`,
    {
      method: "POST",
      body: {
        commandId: nextCommandId("card-turn-chat-failure"),
        kind: "reaction",
        contentId: "not_allowed",
      },
    },
  );
  assertApiError(chatFailure, 400, "INVALID_MESSAGE");
  assert.deepEqual(gameIntegrity(localDatabase, main.gameId), rowBeforeCardFailure);

  const command = legalTurnCommand(snapshot.view);
  const cardResult = await sendGameCommand(
    turnActor,
    main.gameId,
    snapshot.view.revision,
    command,
    "card-after-chat-failure",
  );
  assert.equal(cardResult.view.revision, snapshot.view.revision + 1);
  assert.notDeepEqual(gameIntegrity(localDatabase, main.gameId), rowBeforeCardFailure);
  await browserSession.captureRenderState("after-card-action", {
    phase: cardResult.view.phase,
    revision: cardResult.view.revision,
  });
  return {
    failedChatChangedGame: false,
    legalCardActionSucceeded: true,
    revisionDelta: 1,
  };
}

async function proveMobileAccessibility(browserSession) {
  return browserSession.proveMobileAccessibility();
}

async function proveRetentionContracts(localDatabase, main) {
  const messages = queryRows(
    localDatabase,
    `SELECT created_at AS createdAt, expires_at AS expiresAt
     FROM game_messages WHERE game_id = ${sqlString(main.gameId)}`,
  );
  assert.ok(messages.length >= messageSequence.length);
  for (const message of messages) {
    assert.equal(
      Number(message.expiresAt) - Number(message.createdAt),
      messageRetentionMs,
    );
  }
  const reports = queryRows(
    localDatabase,
    `SELECT created_at AS createdAt, expires_at AS expiresAt,
            moderation_state AS moderationState
     FROM game_message_reports WHERE game_id = ${sqlString(main.gameId)}`,
  );
  assert.ok(reports.length >= 1);
  for (const report of reports) {
    assert.equal(
      Number(report.expiresAt) - Number(report.createdAt),
      reportRetentionMs,
    );
    assert.equal(report.moderationState, "pending");
  }
  return {
    messageRetentionMs,
    reportRetentionMs,
    messageRowsChecked: messages.length,
    reportRowsChecked: reports.length,
  };
}

async function proveLeaveDenial(localDatabase, main) {
  const snapshot = await readGame(identities.guest, main.gameId);
  const left = await sendGameCommand(
    identities.guest,
    main.gameId,
    snapshot.view.revision,
    { type: "leave_game" },
    "chat-member-leave",
  );
  assert.equal(left.view, null);
  const before = communicationCounts(localDatabase, main.gameId);
  const messageId = queryOne(
    localDatabase,
    `SELECT id FROM game_messages
     WHERE game_id = ${sqlString(main.gameId)}
     ORDER BY created_at ASC, id ASC LIMIT 1`,
  ).id;
  const attempts = [
    await apiRequest(
      identities.guest,
      `/api/games/${encodeURIComponent(main.gameId)}/messages`,
      { method: "GET" },
    ),
    await apiRequest(
      identities.guest,
      `/api/games/${encodeURIComponent(main.gameId)}/messages`,
      {
        method: "POST",
        body: {
          commandId: nextCommandId("left-send"),
          kind: "phrase",
          contentId: "ready",
        },
      },
    ),
    await apiRequest(
      identities.guest,
      `/api/messages/${encodeURIComponent(messageId)}/report`,
      {
        method: "POST",
        body: {
          commandId: nextCommandId("left-report"),
          reason: "harassment",
        },
      },
    ),
    await relationshipRequest(
      identities.guest,
      main.gameId,
      main.hostPlayerId,
      "mute",
      "PUT",
    ),
    await relationshipRequest(
      identities.guest,
      main.gameId,
      main.hostPlayerId,
      "block",
      "PUT",
    ),
  ];
  for (const [index, attempt] of attempts.entries()) {
    if (index === 2) {
      assertApiError(attempt, 404, "CHAT_MESSAGE_NOT_FOUND");
    } else {
      assertApiError(attempt, 403, "NOT_A_MEMBER");
    }
  }
  assert.deepEqual(communicationCounts(localDatabase, main.gameId), before);
  return { readDenied: true, allMutationsDenied: true, rowsChanged: false };
}

async function proveGeneralLogRedaction(localDatabase, main) {
  const gameEvents = queryRows(
    localDatabase,
    `SELECT public_payload_json AS payload
     FROM game_events WHERE game_id = ${sqlString(main.gameId)}`,
  )
    .map((row) => row.payload)
    .join("\n");
  assertNoCommunicationContent(gameEvents, "game events");

  const logSegment = await readApplicationLogSince(logStartOffset);
  assertNoGeneralLogContent(logSegment, "general application log");
  for (const entry of browserConsole) {
    assertNoGeneralLogContent(entry.text ?? "", "browser console");
  }
  return {
    gameEventsContainMessageContent: false,
    generalLogContainsRestrictedContent: false,
    consoleContainsRestrictedContent: false,
    inspectedLogBytes: Buffer.byteLength(logSegment),
  };
}

async function createSharedTable(host, hostAlias, guest, guestAlias, label) {
  const created = await createGame(host, hostAlias, `${label}-create`);
  const joined = await joinGame(
    guest,
    created.joinCode,
    guestAlias,
    `${label}-join`,
  );
  assert.equal(joined.view.gameId, created.gameId);
  registerMember(created.gameId, guest);
  return {
    ...created,
    revision: joined.view.revision,
    hostPlayerId: selfPlayer(created.view).playerId,
    guestPlayerId: selfPlayer(joined.view).playerId,
  };
}

async function createGame(actor, alias, label) {
  const response = await apiRequest(actor, "/api/games", {
    method: "POST",
    body: { commandId: nextCommandId(label), nickname: alias },
  });
  assert.equal(response.status, 201, response.raw);
  assert.ok(response.body?.view, "Create must return a private game view.");
  const record = {
    gameId: response.body.view.gameId,
    joinCode: response.body.view.joinCode,
    revision: response.body.view.revision,
    view: response.body.view,
    members: [actor],
  };
  gamesForCleanup.set(record.gameId, record);
  return record;
}

async function joinGame(actor, joinCode, alias, label) {
  const response = await apiRequest(actor, "/api/games/join", {
    method: "POST",
    body: {
      commandId: nextCommandId(label),
      joinCode,
      nickname: alias,
    },
  });
  assert.equal(response.status, 200, response.raw);
  return response.body;
}

async function readGame(actor, gameId) {
  const response = await apiRequest(
    actor,
    `/api/games/${encodeURIComponent(gameId)}?afterRevision=0`,
    { method: "GET" },
  );
  assert.equal(response.status, 200, response.raw);
  return response.body;
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

function legalTurnCommand(view) {
  if (view.legalActions.canAcceptPenalty) return { type: "accept_penalty" };
  if (view.legalActions.canDrawUntilPlayable) {
    return { type: "draw_until_playable" };
  }
  const cardId = view.legalActions.playableCardIds[0];
  assert.ok(cardId, "The current player must have a legal turn action.");
  const card = view.hand.find((candidate) => candidate.id === cardId);
  assert.ok(card, "A playable card must be present in the private hand.");
  const command = { type: "play_card", cardId };
  if (
    String(card.kind).startsWith("wild_") &&
    card.kind !== "wild_color_roulette"
  ) {
    command.chosenColor = "red";
  }
  if (card.kind === "number" && card.number === 7) {
    command.swapTargetId = view.players.find(
      (player) => player.playerId !== view.currentPlayerId && player.status === "active",
    )?.playerId;
  }
  return command;
}

async function sendMessage(actor, gameId, kind, contentId, label) {
  await waitForActorSendWindow(actor);
  const response = await apiRequest(
    actor,
    `/api/games/${encodeURIComponent(gameId)}/messages`,
    {
      method: "POST",
      body: {
        commandId: nextCommandId(label),
        kind,
        contentId,
      },
    },
  );
  assert.equal(response.status, 200, response.raw);
  assertExactKeys(response.body, ["message", "replayed"], "message send");
  assert.equal(response.body.replayed, false);
  assertMessageDto(response.body.message);
  actorLastSendAt.set(actor.id, Date.now());
  return response.body.message;
}

async function readMessages(actor, gameId, cursor = null) {
  const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const response = await apiRequest(
    actor,
    `/api/games/${encodeURIComponent(gameId)}/messages${suffix}`,
    { method: "GET" },
  );
  assert.equal(response.status, 200, response.raw);
  assertChatPage(response.body);
  return response.body;
}

async function relationshipRequest(
  actor,
  gameId,
  playerId,
  relationship,
  method,
) {
  assert.ok(relationship === "mute" || relationship === "block");
  return apiRequest(
    actor,
    `/api/games/${encodeURIComponent(gameId)}/players/${encodeURIComponent(playerId)}/${relationship}`,
    { method, body: {} },
  );
}

async function waitForActorSendWindow(actor) {
  const previous = actorLastSendAt.get(actor.id);
  if (!previous) return;
  const remaining = previous + 2_100 - Date.now();
  if (remaining > 0) await delay(remaining);
}

async function waitForCommunicationRoutes(gameId) {
  const deadline = Date.now() + routeWaitMs;
  let observation = "no response";
  while (Date.now() < deadline) {
    const response = await apiRequest(
      identities.host,
      `/api/games/${encodeURIComponent(gameId)}/messages`,
      { method: "GET" },
    );
    if (response.status === 200) {
      assertChatPage(response.body);
      return;
    }
    observation = `${response.status} ${response.body?.error?.code ?? response.raw}`;
    if (
      response.body?.error?.code === "COMMUNICATION_DISABLED" ||
      response.body?.error?.code === "FEATURE_DISABLED"
    ) {
      throw new Error(
        `Epic 3 communication is disabled at ${baseUrl.origin}. Start the external local server with OPEN_SHED_V15_COMMUNICATION_ENABLED=true, or run V15_CHAT_EXPECT_MODE=disabled.`,
      );
    }
    await delay(300);
  }
  throw new Error(
    `Epic 3 communication routes did not become ready within ${routeWaitMs}ms (${observation}). The harness never starts or restarts a shared server.`,
  );
}

function assertChatPage(value) {
  assertPlainObject(value, "chat page");
  assertExactKeys(
    value,
    ["messages", "nextCursor", "serverTime", "viewer"],
    "chat page",
  );
  assert.ok(Array.isArray(value.messages));
  assert.ok(value.messages.length <= 48);
  for (const message of value.messages) assertMessageDto(message);
  for (let index = 1; index < value.messages.length; index += 1) {
    const previous = value.messages[index - 1];
    const current = value.messages[index];
    assert.equal(
      previous.createdAt < current.createdAt ||
        (previous.createdAt === current.createdAt && previous.id < current.id),
      true,
      "Chat messages must remain chronological by createdAt and opaque ID.",
    );
  }
  if (value.nextCursor !== null) assert.match(value.nextCursor, /^[a-f0-9]{32}$/);
  assert.equal(Number.isSafeInteger(value.serverTime), true);
  assert.ok(value.serverTime >= 0);
  assertPlainObject(value.viewer, "chat viewer state");
  assertExactKeys(
    value.viewer,
    ["mutedPlayerIds", "blockedPlayerIds"],
    "chat viewer state",
  );
  for (const field of ["mutedPlayerIds", "blockedPlayerIds"]) {
    assert.ok(Array.isArray(value.viewer[field]));
    assert.equal(new Set(value.viewer[field]).size, value.viewer[field].length);
    for (const playerId of value.viewer[field]) {
      assert.equal(typeof playerId, "string");
      assert.ok(playerId.length > 0 && playerId.length <= 128);
    }
  }
}

function assertMessageDto(value) {
  assertPlainObject(value, "chat message");
  assertExactKeys(
    value,
    [
      "contentId",
      "createdAt",
      "id",
      "kind",
      "senderDisplayName",
      "senderPlayerId",
    ],
    "chat message",
  );
  assert.match(value.id, /^[a-f0-9]{32}$/);
  assert.equal(typeof value.senderPlayerId, "string");
  assert.ok(value.senderPlayerId.length > 0 && value.senderPlayerId.length <= 128);
  assert.equal(typeof value.senderDisplayName, "string");
  assert.ok(
    value.senderDisplayName.length > 0 && value.senderDisplayName.length <= 48,
  );
  const allowed = value.kind === "phrase" ? phrases : reactions;
  assert.equal(
    allowed.some(([contentId]) => contentId === value.contentId),
    true,
  );
  assert.equal(Number.isSafeInteger(value.createdAt), true);
  assert.ok(value.createdAt >= 0);
}

function assertApiError(response, status, code) {
  assert.equal(response.status, status, response.raw);
  assert.equal(response.body?.error?.code, code, response.raw);
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} keys`);
}

function assertPlainObject(value, label) {
  assert.equal(
    typeof value === "object" && value !== null && !Array.isArray(value),
    true,
    `${label} must be a plain object.`,
  );
}

function communicationCounts(localDatabase, gameId) {
  return {
    messages: messageCount(localDatabase, gameId),
    reports: reportCount(localDatabase, gameId),
    mutes: queryScalar(
      localDatabase,
      `SELECT COUNT(*) AS value FROM game_mutes
       WHERE game_id = ${sqlString(gameId)}`,
    ),
  };
}

function messageCount(localDatabase, gameId) {
  return queryScalar(
    localDatabase,
    `SELECT COUNT(*) AS value FROM game_messages
     WHERE game_id = ${sqlString(gameId)}`,
  );
}

function reportCount(localDatabase, gameId) {
  return queryScalar(
    localDatabase,
    `SELECT COUNT(*) AS value FROM game_message_reports
     WHERE game_id = ${sqlString(gameId)}`,
  );
}

function gameEventCount(localDatabase, gameId) {
  return queryScalar(
    localDatabase,
    `SELECT COUNT(*) AS value FROM game_events
     WHERE game_id = ${sqlString(gameId)}`,
  );
}

function gameIntegrity(localDatabase, gameId) {
  return queryOne(
    localDatabase,
    `SELECT version, state_hash AS stateHash, state_json AS stateJson,
            host_profile_id AS hostProfileId, room_status AS roomStatus
     FROM games WHERE id = ${sqlString(gameId)}`,
  );
}

function membershipIntegrity(localDatabase, gameId) {
  return queryRows(
    localDatabase,
    `SELECT profile_id AS profileId, seat, role, status,
            joined_at AS joinedAt, left_at AS leftAt
     FROM game_members WHERE game_id = ${sqlString(gameId)}
     ORDER BY seat ASC, profile_id ASC`,
  );
}

function blockCount(localDatabase, blocker, blocked) {
  return queryScalar(
    localDatabase,
    `SELECT COUNT(*) AS value FROM profile_blocks
     WHERE blocker_profile_id = ${profileIdSql(localDatabase, blocker)}
       AND blocked_profile_id = ${profileIdSql(localDatabase, blocked)}`,
  );
}

function profileCountForActor(localDatabase, actor) {
  return queryScalar(
    localDatabase,
    `SELECT COUNT(*) AS value FROM profiles
     WHERE auth_subject = ${sqlString(authSubject(actor))}`,
  );
}

function profileIdSql(_localDatabase, actor) {
  return `(SELECT id FROM profiles WHERE auth_subject = ${sqlString(authSubject(actor))} LIMIT 1)`;
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
    "Acceptance D1 verification is read-only and permits only targeted SELECT/WITH queries.",
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

async function openChatBrowsers(main, soloTable) {
  const browser = await chromium.launch({ headless: true });
  const hostContext = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    reducedMotion: "reduce",
  });
  const guestContext = await browser.newContext({
    viewport: { width: 320, height: 900 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  const soloContext = await browser.newContext({
    viewport: { width: 320, height: 900 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  await Promise.all([
    installIdentity(hostContext, identities.host),
    installIdentity(guestContext, identities.guest),
    installIdentity(soloContext, identities.foreignHost),
  ]);
  const hostPage = await hostContext.newPage();
  const guestPage = await guestContext.newPage();
  const soloPage = await soloContext.newPage();
  watchBrowser(hostPage, "host-desktop");
  watchBrowser(guestPage, "guest-mobile");
  watchBrowser(soloPage, "solo-mobile");
  trackBrowserTraffic(hostPage, "host-desktop");
  trackBrowserTraffic(guestPage, "guest-mobile");
  trackBrowserTraffic(soloPage, "solo-mobile");

  try {
    await Promise.all([
      openGamePage(hostPage, main.gameId),
      openGamePage(guestPage, main.gameId),
      openGamePage(soloPage, soloTable.gameId),
    ]);
    await ensureSidebarOpen(soloPage);
    await soloPage.locator("#chat-tab").waitFor({ timeout: pollWaitMs });
    await soloPage.locator("#activity-tab").waitFor({ timeout: pollWaitMs });
    await soloPage.locator("#chat-tab").tap();
    const soloLog = soloPage.getByRole("log", { name: "Table chat" });
    await soloLog.waitFor({ timeout: pollWaitMs });
    for (const [, label] of phrases) {
      await soloPage
        .getByRole("button", { name: `Send “${label}”` })
        .waitFor({ timeout: pollWaitMs });
    }
    for (const [, label] of reactions) {
      await soloPage
        .getByRole("button", { name: `Send ${label}` })
        .waitFor({ timeout: pollWaitMs });
    }
    await soloPage.screenshot({
      path: path.join(artifactDir, "01-solo-lobby-chat-mobile.png"),
      fullPage: true,
    });
    summary.scenarios.soloLobbyChat = {
      chatTabVisible: true,
      activityTabVisible: true,
      phraseControls: phrases.length,
      reactionControls: reactions.length,
    };
  } finally {
    await soloContext.close();
  }

  const session = {
    hostPage,
    guestPage,
    async openActivityBeforeMessages() {
      await ensureSidebarOpen(guestPage);
      const activityTab = guestPage.locator("#activity-tab");
      await activityTab.tap();
      await assertSelectedTab(guestPage, "activity");
      const activityText = await guestPage.locator("#activity-panel").innerText();
      for (const { label } of messageSequence) {
        assert.equal(
          activityText.includes(label),
          false,
          "Activity must not render chat message content.",
        );
      }
      await guestPage.screenshot({
        path: path.join(artifactDir, "02-mobile-activity-before-chat.png"),
        fullPage: true,
      });
    },
    async proveUnreadAndOrderedLog(records) {
      const expectedUnread = records.filter(
        (record) => record.actor === identities.host,
      ).length;
      await waitForValue(
        async () =>
          Number(
            (await guestPage.locator("#chat-tab .chat-unread").textContent()) ??
              0,
          ),
        expectedUnread,
        "chat unread count",
      );
      assert.equal(await guestPage.locator("#activity-panel").isVisible(), true);
      const activityText = await guestPage.locator("#activity-panel").innerText();
      for (const { label } of messageSequence) {
        assert.equal(activityText.includes(label), false);
      }

      await guestPage.locator("#chat-tab").tap();
      await assertSelectedTab(guestPage, "chat");
      const log = guestPage.getByRole("log", { name: "Table chat" });
      await waitForValue(
        () => log.locator(".chat-message").count(),
        records.length,
        "rendered chat message count",
      );
      const rendered = await log
        .locator(".chat-message__content")
        .allTextContents();
      assert.deepEqual(
        rendered.map((value) => value.trim()),
        records.map((record) =>
          record.item.kind === "reaction"
            ? `${reactionIcons[record.item.contentId]}${record.item.label}`
            : record.item.label,
        ),
      );
      assert.equal(await guestPage.locator("#chat-tab .chat-unread").count(), 0);

      const announcement = guestPage.getByRole("switch");
      assert.equal(await announcement.getAttribute("aria-checked"), "true");
      await announcement.tap();
      assert.equal(await announcement.getAttribute("aria-checked"), "false");
      await announcement.tap();
      assert.equal(await announcement.getAttribute("aria-checked"), "true");
      await this.captureRenderState("allowlisted-exchange");
      await guestPage.screenshot({
        path: path.join(artifactDir, "03-mobile-chat-ordered.png"),
        fullPage: true,
      });
    },
    async proveReportDialog(message) {
      await ensureChatOpen(guestPage);
      const article = guestPage.locator(
        `.chat-message[data-message-id="${cssEscape(message.id)}"]`,
      );
      await article.waitFor({ timeout: pollWaitMs });
      const actions = article.getByLabel(
        `Actions for message from ${message.senderDisplayName}`,
      );
      await actions.tap();
      const reportTrigger = article.getByRole("button", { name: "Report" });
      await reportTrigger.tap();
      const dialog = guestPage.getByRole("dialog", {
        name: "Report this message?",
      });
      await dialog.waitFor({ timeout: pollWaitMs });
      assert.equal(
        await dialog.evaluate((element) => element.contains(document.activeElement)),
        true,
        "The report dialog must take focus.",
      );
      for (const reason of [
        "Harassment or bullying",
        "Hateful conduct",
        "Sexual content or grooming",
        "Threats or self-harm",
        "Sharing personal information",
        "Spam or scam",
        "Cheating or unfair play",
        "Something else",
      ]) {
        await dialog.getByRole("radio", { name: reason }).waitFor();
      }
      await guestPage.screenshot({
        path: path.join(artifactDir, "04-mobile-report-dialog.png"),
        fullPage: true,
      });
      await guestPage.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached", timeout: pollWaitMs });
      assert.equal(
        await reportTrigger.evaluate(
          (element) => element === document.activeElement,
        ),
        true,
        "Escape must restore the message-action trigger.",
      );
    },
    async provePersistedRelationship(relationship, playerId, hiddenMessage) {
      await guestPage.reload({ waitUntil: "domcontentloaded" });
      await waitForGamePage(guestPage);
      await ensureChatOpen(guestPage);
      const safety = guestPage.locator(".chat-safety-controls");
      await safety.waitFor({ timeout: pollWaitMs });
      await safety.locator("summary").tap();
      const expectedAction = relationship === "mute" ? "Unmute" : "Unblock";
      const safetyAction = safety.getByRole("button", { name: expectedAction });
      await safetyAction.waitFor();
      const actionBox = await safetyAction.boundingBox();
      assert.ok(actionBox, `${expectedAction} must have a rendered touch target.`);
      assert.ok(
        actionBox.width >= 44 && actionBox.height >= 44,
        `${expectedAction} must provide a 44 by 44px touch target at 320px.`,
      );
      assert.equal(
        await guestPage.locator(`[data-message-id="${cssEscape(hiddenMessage.id)}"]`).count(),
        0,
        `${relationship} must keep the sender's message filtered after refresh.`,
      );
      const rendered = await renderGameToText(guestPage);
      assert.equal(rendered.game?.chat?.unread ?? 0, 0);
      assert.equal(
        (rendered.game?.chat?.latest ?? []).some(
          (message) => message.senderPlayerId === playerId,
        ),
        false,
      );
      await writeRenderArtifact(`relationship-${relationship}`, rendered);
      await guestPage.screenshot({
        path: path.join(
          artifactDir,
          relationship === "mute"
            ? "05-mobile-muted-after-refresh.png"
            : "06-mobile-blocked-after-refresh.png",
        ),
        fullPage: true,
      });
    },
    async captureRenderState(label, expectedGame = null) {
      if (expectedGame) {
        await Promise.all(
          [hostPage, guestPage].map((page) =>
            page.waitForFunction(
              ({ phase, revision }) => {
                if (typeof window.render_game_to_text !== "function") return false;
                const rendered = JSON.parse(window.render_game_to_text());
                return (
                  rendered?.mode === phase &&
                  Number(rendered?.game?.revision) >= revision
                );
              },
              expectedGame,
              { timeout: pollWaitMs },
            ),
          ),
        );
      }
      const [hostState, guestState] = await Promise.all([
        renderGameToText(hostPage),
        renderGameToText(guestPage),
      ]);
      await Promise.all([
        writeRenderArtifact(`${label}-host`, hostState),
        writeRenderArtifact(`${label}-guest`, guestState),
      ]);
      return { hostState, guestState };
    },
    async proveMobileAccessibility() {
      await guestPage.reload({ waitUntil: "domcontentloaded" });
      await waitForGamePage(guestPage);
      await ensureChatOpen(guestPage);
      const viewport = await guestPage.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      assert.equal(
        viewport.scrollWidth,
        viewport.clientWidth,
        "The 320px chat journey must not introduce horizontal overflow.",
      );
      const controls = guestPage.locator(
        ".chat-phrase-grid button, .chat-reaction-grid button, #chat-tab, #activity-tab, .chat-message-actions summary",
      );
      const controlCount = await controls.count();
      assert.ok(controlCount >= phrases.length + reactions.length + 2);
      for (let index = 0; index < controlCount; index += 1) {
        const box = await controls.nth(index).boundingBox();
        if (!box) continue;
        assert.ok(box.height >= 44, `Chat touch target ${index} is shorter than 44px.`);
        assert.ok(box.width >= 44, `Chat touch target ${index} is narrower than 44px.`);
      }
      const feedMetrics = await guestPage.locator(".chat-feed").evaluate((feed) => ({
        clientHeight: feed.clientHeight,
        scrollHeight: feed.scrollHeight,
        overflowY: getComputedStyle(feed).overflowY,
      }));
      assert.ok(feedMetrics.clientHeight <= 250);
      assert.ok(["auto", "scroll"].includes(feedMetrics.overflowY));
      assert.ok(feedMetrics.scrollHeight >= feedMetrics.clientHeight);
      const overlap = await guestPage.evaluate(() => {
        const coach = document.querySelector(".table-status");
        const chat = document.querySelector("#chat-panel");
        if (!coach || !chat) return true;
        const left = coach.getBoundingClientRect();
        const right = chat.getBoundingClientRect();
        return !(
          left.right <= right.left ||
          right.right <= left.left ||
          left.bottom <= right.top ||
          right.bottom <= left.top
        );
      });
      assert.equal(overlap, false, "Chat must not cover Turn Coach at 320px.");
      await guestPage.screenshot({
        path: path.join(artifactDir, "07-mobile-active-game-chat.png"),
        fullPage: true,
      });
      return {
        viewportWidth: viewport.clientWidth,
        horizontalOverflow: false,
        minimumTouchTarget: 44,
        boundedScroll: true,
        turnCoachObscured: false,
      };
    },
    async close() {
      await Promise.allSettled([hostContext.close(), guestContext.close()]);
      await browser.close();
    },
  };
  return session;
}

async function openGamePage(page, gameId) {
  await page.goto(new URL(`/?game=${encodeURIComponent(gameId)}`, baseUrl).href, {
    waitUntil: "domcontentloaded",
  });
  await waitForGamePage(page);
}

async function waitForGamePage(page) {
  await page.locator(".table-status").waitFor({ timeout: pollWaitMs });
  await ensureSidebarOpen(page);
  await page.locator("#chat-tab").waitFor({ timeout: pollWaitMs });
  await page.locator("#activity-tab").waitFor({ timeout: pollWaitMs });
}

async function ensureSidebarOpen(page) {
  const toggle = page.locator(".sidebar-toggle");
  if (await toggle.isVisible()) {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") {
      await toggle.tap();
    }
    await page.locator(".sidebar-details-panel.is-open").waitFor({
      timeout: pollWaitMs,
    });
  }
}

async function ensureChatOpen(page) {
  await ensureSidebarOpen(page);
  const tab = page.locator("#chat-tab");
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.tap();
  await assertSelectedTab(page, "chat");
  await page.getByRole("log", { name: "Table chat" }).waitFor({
    timeout: pollWaitMs,
  });
}

async function assertSelectedTab(page, selected) {
  const chat = page.locator("#chat-tab");
  const activity = page.locator("#activity-tab");
  assert.equal(await chat.getAttribute("aria-selected"), String(selected === "chat"));
  assert.equal(
    await activity.getAttribute("aria-selected"),
    String(selected === "activity"),
  );
  assert.equal(await page.locator("#chat-panel").isVisible(), selected === "chat");
  assert.equal(
    await page.locator("#activity-panel").isVisible(),
    selected === "activity",
  );
}

async function renderGameToText(page) {
  const serialized = await page.evaluate(() =>
    typeof window.render_game_to_text === "function"
      ? window.render_game_to_text()
      : null,
  );
  assert.ok(serialized, "The game page must expose render_game_to_text().");
  return JSON.parse(serialized);
}

async function writeRenderArtifact(label, state) {
  await writeFile(
    path.join(artifactDir, `render-${safeFileLabel(label)}.json`),
    `${JSON.stringify(state, null, 2)}\n`,
  );
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

function watchBrowser(page, label) {
  page.on("pageerror", (error) => {
    browserConsole.push({
      label,
      type: "pageerror",
      text: redactRestricted(String(error)),
    });
  });
  page.on("console", (message) => {
    const raw = message.text();
    const restricted = containsGeneralLogContent(raw);
    browserConsole.push({
      label,
      type: restricted ? "restricted" : message.type(),
      text: redactRestricted(raw),
      location: sanitizeLocation(message.location()),
    });
  });
}

function trackBrowserTraffic(page, label) {
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (url.origin !== baseUrl.origin || !url.pathname.startsWith("/api/")) {
      return;
    }
    const request = response.request();
    let responseBody = null;
    try {
      const raw = await response.text();
      responseBody = raw ? JSON.parse(raw) : null;
    } catch {
      responseBody = null;
    }
    networkTraffic.push({
      label,
      method: request.method(),
      path: sanitizeApiPath(`${url.pathname}${url.search}`),
      status: response.status(),
      request: summarizeJson(request.postDataJSON?.() ?? null),
      response: summarizeJson(responseBody),
    });
    if (networkTraffic.length > 300) networkTraffic.splice(0, 50);
  });
}

async function assertLocalServer() {
  let response;
  try {
    response = await fetch(new URL("/api/session", baseUrl), {
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    throw new Error(
      `No local app is ready at ${baseUrl.origin}. Start the externally managed local server before running this harness. ${String(error)}`,
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

function assertCommunicationSchema(localDatabase) {
  for (const table of [
    "game_messages",
    "game_message_reports",
    "game_mutes",
    "profile_blocks",
  ]) {
    assert.equal(
      queryScalar(
        localDatabase,
        `SELECT COUNT(*) AS value FROM sqlite_master
         WHERE type = 'table' AND name = ${sqlString(table)}`,
      ),
      1,
      `Local D1 is missing ${table}. Restart the external server after migration.`,
    );
  }
  const messageColumns = new Set(
    queryRows(localDatabase, "SELECT name FROM pragma_table_info('game_messages')").map(
      (row) => row.name,
    ),
  );
  for (const column of [
    "sender_player_id",
    "sender_display_name",
    "kind",
    "content_id",
    "command_id",
    "created_at",
    "expires_at",
  ]) {
    assert.equal(messageColumns.has(column), true, `Missing game_messages.${column}`);
  }
  assert.equal(messageColumns.has("body"), false);
  assert.equal(messageColumns.has("text"), false);
  assert.equal(messageColumns.has("message"), false);
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
  const parsed = await readResponse(response);
  networkTraffic.push({
    label: `api:${actor.id}`,
    method: method ?? (body === undefined ? "GET" : "POST"),
    path: sanitizeApiPath(pathname),
    status: parsed.status,
    request: summarizeJson(body ?? null),
    response: summarizeJson(parsed.body),
  });
  return parsed;
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

async function cleanupCreatedGames() {
  if (!databasePath) return;
  for (const record of [...gamesForCleanup.values()].reverse()) {
    for (const actor of [...record.members].reverse()) {
      try {
        await leaveIfOpen(actor, record.gameId);
      } catch (error) {
        cleanupErrors.push({
          gameId: record.gameId,
          actor: actor.id,
          error: redactRestricted(
            error instanceof Error ? error.message : String(error),
          ),
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
      ["NOT_A_MEMBER", "ROOM_CLOSED"].includes(snapshot.body?.error?.code)
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
    id: `v15c-${label}-${runToken}`
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 48),
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

function selfPlayer(view) {
  const player = view.players.find((candidate) => candidate.isSelf);
  assert.ok(player, "The private game projection must contain its viewer.");
  return player;
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

async function waitForValue(read, expected, label) {
  const deadline = Date.now() + pollWaitMs;
  let current;
  while (Date.now() < deadline) {
    current = await read();
    if (Object.is(current, expected)) return;
    await delay(150);
  }
  assert.equal(current, expected, `${label} did not settle before timeout.`);
}

async function applicationLogOffset() {
  try {
    return (await stat(applicationLogPath)).size;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return 0;
    throw error;
  }
}

async function readApplicationLogSince(offset) {
  let file;
  try {
    file = await open(applicationLogPath, "r");
    const fileSize = (await file.stat()).size;
    if (fileSize <= offset) return "";
    const buffer = Buffer.alloc(fileSize - offset);
    await file.read(buffer, 0, buffer.length, offset);
    return buffer.toString("utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return "";
    }
    throw error;
  } finally {
    await file?.close();
  }
}

function assertNoCommunicationContent(value, label) {
  const text = String(value);
  const ids = messageSequence.map(({ contentId }) => contentId).join("|");
  const reasons = reportReasons.join("|");
  assert.doesNotMatch(
    text,
    new RegExp(`(?:contentId|content_id)[^a-z0-9]+(?:${ids})`, "iu"),
    `${label} contains chat content IDs.`,
  );
  assert.doesNotMatch(
    text,
    new RegExp(`(?:reason)[^a-z0-9]+(?:${reasons})`, "iu"),
    `${label} contains report reasons.`,
  );
}

function assertNoGeneralLogContent(value, label) {
  const text = String(value);
  for (const secret of [
    ...Object.values(identities).map((actor) => actor.name),
    ...Object.values(aliases),
  ]) {
    assert.equal(text.includes(secret), false, `${label} contains a private name.`);
  }
  assertNoCommunicationContent(text, label);
}

function containsGeneralLogContent(value) {
  try {
    assertNoGeneralLogContent(value, "captured browser console");
    return false;
  } catch {
    return true;
  }
}

function redactRestricted(value) {
  let text = String(value);
  const ordered = [...restrictedValues].sort((left, right) => right.length - left.length);
  for (const restricted of ordered) {
    if (!restricted) continue;
    text = text.replaceAll(restricted, "[REDACTED]");
  }
  return text;
}

function summarizeJson(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (typeof value !== "object") return { type: typeof value };
  const output = { keys: Object.keys(value).sort() };
  if (value.error && typeof value.error === "object") {
    output.errorCode = value.error.code ?? null;
  }
  if (Array.isArray(value.messages)) output.messageCount = value.messages.length;
  if (typeof value.replayed === "boolean") output.replayed = value.replayed;
  if (typeof value.received === "boolean") output.received = value.received;
  if (typeof value.muted === "boolean") output.muted = value.muted;
  if (typeof value.blocked === "boolean") output.blocked = value.blocked;
  return output;
}

function sanitizeApiPath(value) {
  return String(value)
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, ":gameId")
    .replace(/[0-9a-f]{32}/gu, ":opaqueId")
    .replace(/cursor=[^&]+/gu, "cursor=:opaqueCursor");
}

function sanitizeLocation(location) {
  if (!location || typeof location !== "object") return null;
  return {
    url: location.url ? sanitizeApiPath(location.url) : "",
    lineNumber: location.lineNumber ?? null,
    columnNumber: location.columnNumber ?? null,
  };
}

function safeFileLabel(label) {
  return String(label).replace(/[^a-z0-9_-]+/giu, "-").slice(0, 80);
}

function cssEscape(value) {
  return String(value).replace(/[^a-z0-9_-]/giu, (character) => `\\${character}`);
}

async function writeArtifacts() {
  await Promise.all([
    writeFile(
      path.join(artifactDir, "network.json"),
      `${JSON.stringify(networkTraffic, null, 2)}\n`,
    ),
    writeFile(
      path.join(artifactDir, "console.json"),
      `${JSON.stringify(browserConsole, null, 2)}\n`,
    ),
    writeFile(
      path.join(artifactDir, "results.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    ),
  ]);
}
