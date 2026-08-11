import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_MESSAGE_LIMIT,
  CHAT_PHRASES,
  CHAT_REACTIONS,
  CHAT_REPORT_REASONS,
  chatContentPresentation,
  parseChatPage,
} from "../app/components/chat-ui";

const MESSAGE = {
  id: "0123456789abcdef0123456789abcdef",
  senderPlayerId: "11111111-1111-4111-8111-111111111111",
  senderDisplayName: "Table Ace",
  kind: "phrase",
  contentId: "nice_play",
  createdAt: 1_786_468_000_000,
} as const;

test("chat parser accepts only the exact viewer-safe page contract", () => {
  assert.deepEqual(
    parseChatPage({
      messages: [MESSAGE],
      nextCursor: MESSAGE.id,
      serverTime: 1_786_468_001_000,
      viewer: {
        mutedPlayerIds: ["22222222-2222-4222-8222-222222222222"],
        blockedPlayerIds: [],
      },
    }),
    {
      messages: [MESSAGE],
      nextCursor: MESSAGE.id,
      serverTime: 1_786_468_001_000,
      viewer: {
        mutedPlayerIds: ["22222222-2222-4222-8222-222222222222"],
        blockedPlayerIds: [],
      },
    },
  );

  assert.equal(
    parseChatPage({
      messages: [MESSAGE],
      nextCursor: null,
      serverTime: 1_786_468_001_000,
      viewer: { mutedPlayerIds: [], blockedPlayerIds: [] },
      leakedProfile: "never",
    }),
    null,
  );
  assert.equal(
    parseChatPage({
      messages: [{ ...MESSAGE, profileId: "secret" }],
      nextCursor: null,
      serverTime: 1_786_468_001_000,
      viewer: { mutedPlayerIds: [], blockedPlayerIds: [] },
    }),
    null,
  );
});

test("chat parser fails closed for invalid semantic IDs, cursors, and bounds", () => {
  const page = (message: unknown, nextCursor: unknown = null) => ({
    messages: [message],
    nextCursor,
    serverTime: 1_786_468_001_000,
    viewer: { mutedPlayerIds: [], blockedPlayerIds: [] },
  });
  assert.equal(parseChatPage(page({ ...MESSAGE, contentId: "write_anything" })), null);
  assert.equal(parseChatPage(page({ ...MESSAGE, kind: "text" })), null);
  assert.equal(parseChatPage(page(MESSAGE, "page-2")), null);
  assert.equal(parseChatPage(page({ ...MESSAGE, senderDisplayName: " Bad alias " })), null);
  assert.equal(
    parseChatPage({
      messages: Array.from({ length: CHAT_MESSAGE_LIMIT + 1 }, (_, index) => ({
        ...MESSAGE,
        id: index.toString(16).padStart(32, "0"),
      })),
      nextCursor: null,
      serverTime: 1_786_468_001_000,
      viewer: { mutedPlayerIds: [], blockedPlayerIds: [] },
    }),
    null,
  );
});

test("the UI exposes exactly the curated phrase, reaction, and report allowlists", () => {
  assert.deepEqual(
    CHAT_PHRASES.map(({ id }) => id),
    ["your_turn", "nice_play", "one_second", "ready", "good_game", "rematch"],
  );
  assert.deepEqual(
    CHAT_REACTIONS.map(({ id }) => id),
    ["wave", "clap", "laugh", "surprised", "thinking", "fire"],
  );
  assert.deepEqual(
    CHAT_REPORT_REASONS.map(({ id }) => id),
    [
      "harassment",
      "hate",
      "sexual_grooming",
      "threat_self_harm",
      "personal_information",
      "spam_scam",
      "cheating",
      "other",
    ],
  );
  assert.deepEqual(chatContentPresentation("phrase", "your_turn"), {
    icon: null,
    label: "Your turn",
  });
  assert.deepEqual(chatContentPresentation("reaction", "fire"), {
    icon: "🔥",
    label: "Fire",
  });
  assert.equal(chatContentPresentation("phrase", "custom"), null);
});
