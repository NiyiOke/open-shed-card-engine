import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CHAT_MESSAGE_LIMIT,
  CHAT_PHRASES,
  CHAT_REACTIONS,
  CHAT_REPORT_REASONS,
  parseChatPage,
} from "../app/components/chat-ui";
import { GameRuleError } from "../lib/game/errors";
import {
  COMMUNICATION_LIMITS,
  QUICK_PHRASE_IDS,
  REACTION_IDS,
  REPORT_REASON_IDS,
  createOpaqueCommunicationId,
  parseCommunicationMessage,
  parseReportReason,
} from "../lib/server/communication-policy";

const STORE_SOURCE = source("../lib/server/chat-store.ts");
const GAME_STORE_SOURCE = source("../lib/server/game-store.ts");
const SCHEMA_SOURCE = source("../db/schema.ts");
const RUNTIME_SOURCE = source("../db/runtime.ts");
const SHELL_SOURCE = source("../app/components/GameShell.tsx");
const CSS_SOURCE = source("../app/globals.css");
const HARNESS_SOURCE = source("../scripts/v15-chat-acceptance.mjs");
const ROUTE_SOURCES = [
  source("../app/api/games/[gameId]/messages/route.ts"),
  source("../app/api/messages/[messageId]/report/route.ts"),
  source("../app/api/games/[gameId]/players/[playerId]/mute/route.ts"),
  source("../app/api/games/[gameId]/players/[playerId]/block/route.ts"),
];

const MESSAGE = {
  id: "0123456789abcdef0123456789abcdef",
  senderPlayerId: "11111111-1111-4111-8111-111111111111",
  senderDisplayName: "Safe Alias",
  kind: "phrase",
  contentId: "your_turn",
  createdAt: 1_786_468_000_000,
} as const;

const PAGE = {
  messages: [MESSAGE],
  nextCursor: MESSAGE.id,
  serverTime: 1_786_468_001_000,
  viewer: {
    mutedPlayerIds: ["22222222-2222-4222-8222-222222222222"],
    blockedPlayerIds: ["33333333-3333-4333-8333-333333333333"],
  },
};

test("backend and UI pin one semantic communication vocabulary and its bounds", () => {
  assert.deepEqual(
    CHAT_PHRASES.map(({ id }) => id),
    [...QUICK_PHRASE_IDS],
  );
  assert.deepEqual(
    CHAT_REACTIONS.map(({ id }) => id),
    [...REACTION_IDS],
  );
  assert.deepEqual(
    CHAT_REPORT_REASONS.map(({ id }) => id),
    [...REPORT_REASON_IDS],
  );
  assert.equal(CHAT_MESSAGE_LIMIT, COMMUNICATION_LIMITS.messageScanLimit);
  assert.equal(COMMUNICATION_LIMITS.messageRetentionMs, 86_400_000);
  assert.equal(COMMUNICATION_LIMITS.reportRetentionMs, 7_776_000_000);
  assert.equal(COMMUNICATION_LIMITS.messageCooldownMs, 2_000);

  assert.deepEqual(parseCommunicationMessage("phrase", "your_turn"), {
    kind: "phrase",
    contentId: "your_turn",
  });
  assert.deepEqual(parseCommunicationMessage("reaction", "fire"), {
    kind: "reaction",
    contentId: "fire",
  });
  assertRuleError(
    () => parseCommunicationMessage("text", "your_turn"),
    "INVALID_MESSAGE",
    400,
  );
  assertRuleError(
    () => parseCommunicationMessage("reaction", "your_turn"),
    "INVALID_MESSAGE",
    400,
  );
  assert.equal(parseReportReason("personal_information"), "personal_information");
  assertRuleError(
    () => parseReportReason("free_form_reason"),
    "INVALID_REPORT_REASON",
    400,
  );

  const opaqueIds = new Set(
    Array.from({ length: 64 }, () => createOpaqueCommunicationId()),
  );
  assert.equal(opaqueIds.size, 64);
  for (const id of opaqueIds) assert.match(id, /^[0-9a-f]{32}$/u);
});

test("the public chat page fails closed on recursive private-field additions", () => {
  const accepted = parseChatPage(clone(PAGE));
  assert.deepEqual(accepted, PAGE);

  const privateKeys = [
    "authSubject",
    "commandId",
    "evidence",
    "expiresAt",
    "gameId",
    "joinCode",
    "moderationState",
    "profileId",
    "reason",
    "requestHash",
    "senderProfileId",
    "userId",
  ];
  for (const key of privateKeys) {
    const topLevel = clone(PAGE) as Record<string, unknown>;
    topLevel[key] = "private";
    assert.equal(parseChatPage(topLevel), null, `top-level ${key} must fail`);

    const messageLevel = clone(PAGE);
    (messageLevel.messages[0] as Record<string, unknown>)[key] = "private";
    assert.equal(parseChatPage(messageLevel), null, `message ${key} must fail`);

    const viewerLevel = clone(PAGE);
    (viewerLevel.viewer as Record<string, unknown>)[key] = "private";
    assert.equal(parseChatPage(viewerLevel), null, `viewer ${key} must fail`);
  }

  const duplicateRelationship = clone(PAGE);
  duplicateRelationship.viewer.mutedPlayerIds.push(
    duplicateRelationship.viewer.mutedPlayerIds[0],
  );
  assert.equal(parseChatPage(duplicateRelationship), null);

  const mutableInput = clone(PAGE);
  const projected = parseChatPage(mutableInput);
  assert.ok(projected);
  (mutableInput.messages[0] as { senderDisplayName: string }).senderDisplayName =
    "Changed after parse";
  mutableInput.viewer.mutedPlayerIds.length = 0;
  assert.equal(projected.messages[0].senderDisplayName, "Safe Alias");
  assert.equal(projected.viewer.mutedPlayerIds.length, 1);
});

test("chat mutations are confined to communication, receipt, quota, and safety tables", () => {
  const mutatedTables = new Set(
    [
      ...STORE_SOURCE.matchAll(
        /\bINSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+([a-z_]+)/giu,
      ),
      ...STORE_SOURCE.matchAll(/\bDELETE\s+FROM\s+([a-z_]+)/giu),
    ].map((match) => match[1]),
  );
  assert.deepEqual(
    [...mutatedTables].sort(),
    [
      "command_receipts",
      "game_message_reports",
      "game_messages",
      "game_mutes",
      "mutation_quotas",
      "profile_blocks",
    ],
  );
  assert.doesNotMatch(
    STORE_SOURCE,
    /\b(?:INSERT(?:\s+OR\s+IGNORE)?\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:games|game_events|game_members|game_presence|profiles|public_game_listings)\b/iu,
  );
  assert.doesNotMatch(STORE_SOURCE, /\bUPDATE\s+game_message_reports\b/iu);

  const messageColumns = schemaTableSlice(SCHEMA_SOURCE, "gameMessages", "gameMessageReports");
  assert.match(messageColumns, /contentId/u);
  assert.doesNotMatch(messageColumns, /rendered|freeText|messageText|bodyText|labelText/u);
});

test("chat content cannot enter general logs, game events, or serialized GameState", () => {
  const communicationProductionSource = [STORE_SOURCE, ...ROUTE_SOURCES].join("\n");
  assert.doesNotMatch(
    communicationProductionSource,
    /\b(?:console\.(?:debug|error|info|log|warn)|logger\.|log\.(?:debug|error|info|warn))\s*\(/u,
  );
  assert.doesNotMatch(STORE_SOURCE, /INSERT\s+INTO\s+game_events|UPDATE\s+games/u);
  assert.doesNotMatch(STORE_SOURCE, /state_json\s*=/u);

  const renderHook = SHELL_SOURCE.slice(
    SHELL_SOURCE.indexOf("window.render_game_to_text ="),
    SHELL_SOURCE.indexOf("window.advanceTime ="),
  );
  assert.match(
    renderHook,
    /latest:[\s\S]*senderPlayerId:[\s\S]*kind:[\s\S]*contentId:/u,
  );
  assert.doesNotMatch(renderHook, /chat:[\s\S]*senderDisplayName/u);
});

test("report evidence survives ordinary game purge until its own 90-day boundary", () => {
  assert.doesNotMatch(
    schemaTableSlice(SCHEMA_SOURCE, "gameMessageReports", "gameMutes"),
    /references\(/u,
  );
  const ordinaryPurge = GAME_STORE_SOURCE.slice(
    GAME_STORE_SOURCE.indexOf("async function purgeExpiredRows"),
    GAME_STORE_SOURCE.indexOf("function normalizeJoinCode"),
  );
  assert.match(ordinaryPurge, /DELETE FROM game_message_reports[\s\S]*expires_at <= \?/u);
  assert.match(ordinaryPurge, /DELETE FROM game_messages/u);
  assert.match(ordinaryPurge, /DELETE FROM games WHERE id IN/u);
  const gameDelete = ordinaryPurge.slice(
    ordinaryPurge.indexOf("DELETE FROM games WHERE id IN"),
    ordinaryPurge.indexOf("DELETE FROM mutation_quotas"),
  );
  assert.doesNotMatch(gameDelete, /game_message_reports/u);
  assert.match(
    RUNTIME_SOURCE,
    /CREATE TABLE IF NOT EXISTS game_message_reports[\s\S]*evidence_sender_display_name[\s\S]*expires_at INTEGER NOT NULL/u,
  );
});

test("the UI keeps Chat and Activity distinct and touch-safe at 320px", () => {
  assert.match(SHELL_SOURCE, /id="chat-tab"[\s\S]*id="activity-tab"/u);
  assert.match(SHELL_SOURCE, /role="log"[\s\S]*aria-label="Table chat"/u);
  assert.match(SHELL_SOURCE, /aria-label="Recent game events"/u);
  assert.match(SHELL_SOURCE, /aria-label="Announce new chat messages"/u);
  assert.match(SHELL_SOURCE, /\{chatEnabled \? \([\s\S]*className="sidebar-communication"/u);

  const chatPanel = SHELL_SOURCE.slice(
    SHELL_SOURCE.indexOf('id="chat-panel"'),
    SHELL_SOURCE.indexOf('id="activity-panel"'),
  );
  assert.doesNotMatch(chatPanel, /<textarea|contentEditable|type="text"/u);
  assert.match(chatPanel, /Send “\$\{phrase\.label\}”/u);
  assert.match(chatPanel, /Send \$\{reaction\.label\}/u);

  assert.match(
    CSS_SOURCE,
    /\.chat-safety-controls button \{[\s\S]*min-width: 76px;[\s\S]*min-height: 44px;[\s\S]*flex: 0 0 auto;/u,
  );
  assert.match(
    CSS_SOURCE,
    /\.chat-phrase-grid button,[\s\S]*\.chat-reaction-grid button \{[\s\S]*min-height: 44px;/u,
  );
});

test("the acceptance runner is local-only, query-only, and never controls the server", () => {
  assert.match(HARNESS_SOURCE, /baseUrl\.hostname,[\s\S]*"localhost"/u);
  assert.match(HARNESS_SOURCE, /PRAGMA query_only=ON/u);
  assert.match(HARNESS_SOURCE, /V15_CHAT_EXPECT_MODE/u);
  assert.match(HARNESS_SOURCE, /COMMUNICATION_DISABLED/u);
  assert.match(HARNESS_SOURCE, /network\.json|console\.json|results\.json/u);
  assert.match(HARNESS_SOURCE, /render_game_to_text/u);
  for (const screenshot of [
    "solo-lobby-chat-mobile",
    "mobile-activity-before-chat",
    "mobile-chat-ordered",
    "mobile-report-dialog",
    "mobile-muted-after-refresh",
    "mobile-blocked-after-refresh",
    "mobile-active-game-chat",
  ]) {
    assert.match(HARNESS_SOURCE, new RegExp(screenshot, "u"));
  }
  assert.doesNotMatch(
    HARNESS_SOURCE,
    /(?:npm\s+run\s+dev|vinext\s+(?:dev|start)|kill\s+-|pkill|\.dev\.vars)/u,
  );
});

function assertRuleError(
  operation: () => unknown,
  code: string,
  status: number,
): void {
  assert.throws(operation, (error: unknown) => {
    return (
      error instanceof GameRuleError &&
      error.code === code &&
      error.status === status
    );
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function schemaTableSlice(
  value: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = value.indexOf(startMarker);
  const end = value.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start);
  return value.slice(start, end);
}

function source(relativeUrl: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativeUrl, import.meta.url)),
    "utf8",
  );
}
