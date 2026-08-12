import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_MESSAGE_LIMIT,
  CHAT_PHRASES,
  CHAT_REACTIONS,
  CHAT_REPORT_REASONS,
  CHAT_TEXT_MAX_GRAPHEMES,
  chatContentPresentation,
  countChatGraphemes,
  parseChatPage,
  prepareChatText,
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
        capabilities: { freeText: false, liveVoice: false },
      },
    }),
    {
      messages: [MESSAGE],
      nextCursor: MESSAGE.id,
      serverTime: 1_786_468_001_000,
      viewer: {
        mutedPlayerIds: ["22222222-2222-4222-8222-222222222222"],
        blockedPlayerIds: [],
        capabilities: { freeText: false, liveVoice: false },
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
      messages: [MESSAGE],
      nextCursor: null,
      serverTime: 1_786_468_001_000,
      viewer: { mutedPlayerIds: [], blockedPlayerIds: [] },
    }),
    null,
  );
  assert.equal(
    parseChatPage({
      messages: [{ ...MESSAGE, profileId: "secret" }],
      nextCursor: null,
      serverTime: 1_786_468_001_000,
      viewer: {
        mutedPlayerIds: [],
        blockedPlayerIds: [],
        capabilities: { freeText: false, liveVoice: false },
      },
    }),
    null,
  );
});

test("private capability admits only exact, normalized, bounded text DTOs", () => {
  const textMessage = {
    id: "abcdef0123456789abcdef0123456789",
    senderPlayerId: "22222222-2222-4222-8222-222222222222",
    senderDisplayName: "Invite Ace",
    kind: "text",
    body: "Good luck — have fun!",
    createdAt: 1_786_468_000_001,
  } as const;
  const page = (freeText: boolean, message: unknown) => ({
    messages: [message],
    nextCursor: null,
    serverTime: 1_786_468_001_000,
    viewer: {
      mutedPlayerIds: [],
      blockedPlayerIds: [],
      capabilities: { freeText, liveVoice: false },
    },
  });

  assert.deepEqual(parseChatPage(page(true, textMessage))?.messages, [textMessage]);
  assert.equal(parseChatPage(page(false, textMessage)), null);
  assert.equal(parseChatPage(page(true, { ...textMessage, contentId: "nice_play" })), null);
  assert.equal(parseChatPage(page(true, { ...textMessage, body: " padded " })), null);
  assert.equal(parseChatPage(page(true, { ...textMessage, body: "line\tbreak" })), null);
  assert.equal(
    parseChatPage(page(true, { ...textMessage, body: "x".repeat(CHAT_TEXT_MAX_GRAPHEMES + 1) })),
    null,
  );
  assert.equal(
    parseChatPage({
      ...page(true, textMessage),
      viewer: {
        mutedPlayerIds: [],
        blockedPlayerIds: [],
        capabilities: { freeText: true, liveVoice: false, voice: true },
      },
    }),
    null,
  );
});

test("the composer counts graphemes and prepares normalized plain text", () => {
  assert.equal(countChatGraphemes("👨‍👩‍👧‍👦"), 1);
  assert.equal(prepareChatText("  hello  "), "hello");
  assert.equal(prepareChatText("Ａ card"), "A card");
  assert.equal(prepareChatText("\t"), null);
  assert.equal(prepareChatText("x".repeat(CHAT_TEXT_MAX_GRAPHEMES + 1)), null);
});

test("chat parser fails closed for invalid semantic IDs, cursors, and bounds", () => {
  const page = (message: unknown, nextCursor: unknown = null) => ({
    messages: [message],
    nextCursor,
    serverTime: 1_786_468_001_000,
    viewer: {
      mutedPlayerIds: [],
      blockedPlayerIds: [],
      capabilities: { freeText: false, liveVoice: false },
    },
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
      viewer: {
        mutedPlayerIds: [],
        blockedPlayerIds: [],
        capabilities: { freeText: false, liveVoice: false },
      },
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
