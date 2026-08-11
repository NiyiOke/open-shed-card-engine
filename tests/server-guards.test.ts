import assert from "node:assert/strict";
import test from "node:test";
import { GameRuleError } from "../lib/game/errors";
import { assertSafeMutationRequest } from "../lib/server/auth";
import { parseGameCommand } from "../lib/server/command-parser";
import { readJsonObject } from "../lib/server/responses";

test("JSON parsing enforces the actual streamed body size without Content-Length", async () => {
  const request = new Request("https://example.test/api/games", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload: "x".repeat(17_000) }),
  });

  await assert.rejects(
    () => readJsonObject(request),
    (error: unknown) =>
      error instanceof GameRuleError && error.code === "PAYLOAD_TOO_LARGE",
  );
});

test("JSON parsing accepts a bounded object body", async () => {
  const request = new Request("https://example.test/api/games", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commandId: "command_123" }),
  });

  assert.deepEqual(await readJsonObject(request), { commandId: "command_123" });
});

test("mutation guard rejects cross-site JSON requests", () => {
  const request = new Request("https://example.test/api/games", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://attacker.test",
      "Sec-Fetch-Site": "cross-site",
    },
    body: "{}",
  });

  assert.throws(
    () => assertSafeMutationRequest(request),
    (error: unknown) =>
      error instanceof GameRuleError && error.code === "CROSS_SITE_REQUEST",
  );
});

test("command parser rejects unknown privileged command shapes", () => {
  assert.throws(
    () => parseGameCommand({ type: "rewrite_state", actorUserId: "other" }),
    (error: unknown) =>
      error instanceof GameRuleError && error.code === "UNSUPPORTED_COMMAND",
  );
});

test("command parser accepts the exact V1.1 room-management commands", () => {
  assert.deepEqual(parseGameCommand({ type: "rematch" }), {
    type: "rematch",
  });
  assert.deepEqual(
    parseGameCommand({
      type: "remove_inactive_player",
      targetPlayerId: "player-b",
    }),
    {
      type: "remove_inactive_player",
      targetPlayerId: "player-b",
    },
  );
});

test("inactive-player removal parser requires a bounded target player id", () => {
  for (const targetPlayerId of [undefined, "", "x".repeat(101)]) {
    assert.throws(
      () =>
        parseGameCommand({
          type: "remove_inactive_player",
          targetPlayerId,
        }),
      (error: unknown) =>
        error instanceof GameRuleError && error.code === "INVALID_FIELD",
    );
  }
});
