import assert from "node:assert/strict";
import test from "node:test";
import { GameRuleError } from "../lib/game/errors";
import {
  COMMUNICATION_LIMITS,
  COMMUNICATION_MESSAGE_KINDS,
  createOpaqueCommunicationId,
  hasRecognizedFreeTextField,
  parseCommunicationMessage,
  parseReportReason,
  QUICK_PHRASE_IDS,
  REACTION_IDS,
  REPORT_REASON_IDS,
  requireOpaqueCommunicationId,
} from "../lib/server/communication-policy";

test("safe communication allowlists are exact and stable", () => {
  assert.deepEqual(COMMUNICATION_MESSAGE_KINDS, ["phrase", "reaction"]);
  assert.deepEqual(QUICK_PHRASE_IDS, [
    "your_turn",
    "nice_play",
    "one_second",
    "ready",
    "good_game",
    "rematch",
  ]);
  assert.deepEqual(REACTION_IDS, [
    "wave",
    "clap",
    "laugh",
    "surprised",
    "thinking",
    "fire",
  ]);
  assert.deepEqual(REPORT_REASON_IDS, [
    "harassment",
    "hate",
    "sexual_grooming",
    "threat_self_harm",
    "personal_information",
    "spam_scam",
    "cheating",
    "other",
  ]);
});

test("message content IDs are bound to their declared kind", () => {
  assert.deepEqual(parseCommunicationMessage("phrase", "your_turn"), {
    kind: "phrase",
    contentId: "your_turn",
  });
  assert.deepEqual(parseCommunicationMessage("reaction", "fire"), {
    kind: "reaction",
    contentId: "fire",
  });
  for (const [kind, contentId] of [
    ["phrase", "fire"],
    ["reaction", "your_turn"],
    ["text", "hello"],
    ["phrase", "nice_play\u0000"],
    ["ｐｈｒａｓｅ", "your_turn"],
  ] as const) {
    assert.throws(
      () => parseCommunicationMessage(kind, contentId),
      (error: unknown) =>
        error instanceof GameRuleError && error.code === "INVALID_MESSAGE",
    );
  }
});

test("report reasons reject arbitrary and Unicode-lookalike values", () => {
  assert.equal(parseReportReason("harassment"), "harassment");
  for (const reason of ["", "abuse", "ｈａｔｅ", "other\nnotes"]) {
    assert.throws(
      () => parseReportReason(reason),
      (error: unknown) =>
        error instanceof GameRuleError &&
        error.code === "INVALID_REPORT_REASON",
    );
  }
});

test("recognized free-text keys include NFKC lookalikes", () => {
  assert.equal(
    hasRecognizedFreeTextField(
      { commandId: "command_123", kind: "phrase", contentId: "ready" },
      ["commandId", "kind", "contentId"],
    ),
    false,
  );
  assert.equal(
    hasRecognizedFreeTextField({ "ｍｅｓｓａｇｅ": "hello" }, []),
    true,
  );
  assert.equal(hasRecognizedFreeTextField({ details: "hello" }, []), true);
});

test("opaque communication IDs contain no semantic data", () => {
  const ids = new Set(
    Array.from({ length: 128 }, () => createOpaqueCommunicationId()),
  );
  assert.equal(ids.size, 128);
  for (const id of ids) {
    assert.match(id, /^[a-f0-9]{32}$/u);
    assert.equal(
      requireOpaqueCommunicationId(id, "BAD", "bad"),
      id,
    );
  }
  for (const id of ["", "A".repeat(32), "a".repeat(31), "room:a".repeat(6)]) {
    assert.throws(() => requireOpaqueCommunicationId(id, "BAD", "bad"));
  }
});

test("retention, paging, and rate limits remain bounded", () => {
  assert.equal(COMMUNICATION_LIMITS.messageRetentionMs, 24 * 60 * 60_000);
  assert.equal(COMMUNICATION_LIMITS.reportRetentionMs, 90 * 24 * 60 * 60_000);
  assert.equal(COMMUNICATION_LIMITS.messageScanLimit, 48);
  assert.equal(COMMUNICATION_LIMITS.messageCooldownMs, 2_000);
  assert.equal(COMMUNICATION_LIMITS.messageUserMinuteLimit, 10);
  assert.equal(COMMUNICATION_LIMITS.messageRoomMinuteLimit, 60);
  assert.ok(COMMUNICATION_LIMITS.reportUserHourLimit > 0);
  assert.ok(COMMUNICATION_LIMITS.reportRoomHourLimit >= 6);
});
