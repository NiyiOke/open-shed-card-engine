import assert from "node:assert/strict";
import test from "node:test";
import {
  ABANDONED_WAITING_ROOM_CLOSE_AFTER_MS,
  classifyPublicHostVisibility,
  CLOSED_ROOM_TOMBSTONE_MS,
  evaluateWaitingRoomLifecycle,
  hasLiveOrReconnectingPresence,
  isRoomTombstoneExpired,
  PUBLIC_HOST_SUPPRESSION_AFTER_MS,
  roomTombstoneExpiresAt,
} from "../lib/server/room-lifecycle-policy";

const NOW = 1_000_000;

test("public host visibility suppresses at the exact 45-second boundary", () => {
  assert.equal(
    classifyPublicHostVisibility(
      NOW - PUBLIC_HOST_SUPPRESSION_AFTER_MS + 1,
      NOW,
    ),
    "eligible",
  );
  assert.equal(
    classifyPublicHostVisibility(
      NOW - PUBLIC_HOST_SUPPRESSION_AFTER_MS,
      NOW,
    ),
    "suppressed",
  );
  assert.equal(classifyPublicHostVisibility(null, NOW), "suppressed");
});

test("any live or reconnecting member keeps a waiting room attended", () => {
  assert.equal(
    hasLiveOrReconnectingPresence(
      [null, NOW - PUBLIC_HOST_SUPPRESSION_AFTER_MS + 1],
      NOW,
    ),
    true,
  );
  assert.equal(
    hasLiveOrReconnectingPresence(
      [null, NOW - PUBLIC_HOST_SUPPRESSION_AFTER_MS],
      NOW,
    ),
    false,
  );
});

test("an unattended waiting room first records its abandonment time", () => {
  assert.deepEqual(
    evaluateWaitingRoomLifecycle({
      roomStatus: "open",
      gameStatus: "lobby",
      abandonedSince: null,
      memberLastSeenAt: [NOW - PUBLIC_HOST_SUPPRESSION_AFTER_MS],
      now: NOW,
    }),
    {
      action: "mark_abandoned",
      attended: false,
      abandonedSince: NOW,
      shouldClose: false,
    },
  );
});

test("an abandoned waiting room closes at the exact five-minute boundary", () => {
  const abandonedSince = NOW - ABANDONED_WAITING_ROOM_CLOSE_AFTER_MS;
  assert.equal(
    evaluateWaitingRoomLifecycle({
      roomStatus: "open",
      gameStatus: "lobby",
      abandonedSince: abandonedSince + 1,
      memberLastSeenAt: [null],
      now: NOW,
    }).action,
    "none",
  );
  assert.deepEqual(
    evaluateWaitingRoomLifecycle({
      roomStatus: "open",
      gameStatus: "lobby",
      abandonedSince,
      memberLastSeenAt: [null],
      now: NOW,
    }),
    {
      action: "close_abandoned",
      attended: false,
      abandonedSince,
      shouldClose: true,
    },
  );
});

test("a late first sweep closes from the actual disconnected boundary", () => {
  const lastSeenAt =
    NOW -
    PUBLIC_HOST_SUPPRESSION_AFTER_MS -
    ABANDONED_WAITING_ROOM_CLOSE_AFTER_MS;
  assert.deepEqual(
    evaluateWaitingRoomLifecycle({
      roomStatus: "open",
      gameStatus: "lobby",
      abandonedSince: null,
      memberLastSeenAt: [lastSeenAt],
      now: NOW,
    }),
    {
      action: "close_abandoned",
      attended: false,
      abandonedSince: lastSeenAt + PUBLIC_HOST_SUPPRESSION_AFTER_MS,
      shouldClose: true,
    },
  );
});

test("a reconnect clears waiting-room abandonment", () => {
  assert.deepEqual(
    evaluateWaitingRoomLifecycle({
      roomStatus: "open",
      gameStatus: "lobby",
      abandonedSince: NOW - 120_000,
      memberLastSeenAt: [NOW - 1_000],
      now: NOW,
    }),
    {
      action: "clear_abandoned",
      attended: true,
      abandonedSince: null,
      shouldClose: false,
    },
  );
});

test("abandonment does not close active games and stale markers are cleared", () => {
  const decision = evaluateWaitingRoomLifecycle({
    roomStatus: "open",
    gameStatus: "playing",
    abandonedSince: NOW - ABANDONED_WAITING_ROOM_CLOSE_AFTER_MS,
    memberLastSeenAt: [null],
    now: NOW,
  });
  assert.equal(decision.action, "clear_abandoned");
  assert.equal(decision.shouldClose, false);
  assert.equal(decision.abandonedSince, null);
});

test("closed rooms are never evaluated for a second automatic close", () => {
  const abandonedSince = NOW - ABANDONED_WAITING_ROOM_CLOSE_AFTER_MS;
  assert.deepEqual(
    evaluateWaitingRoomLifecycle({
      roomStatus: "closed",
      gameStatus: "lobby",
      abandonedSince,
      memberLastSeenAt: [],
      now: NOW,
    }),
    {
      action: "none",
      attended: false,
      abandonedSince,
      shouldClose: false,
    },
  );
});

test("closed-room tombstones expire at exactly 24 hours", () => {
  const closedAt = NOW;
  assert.equal(
    roomTombstoneExpiresAt(closedAt),
    closedAt + CLOSED_ROOM_TOMBSTONE_MS,
  );
  assert.equal(
    isRoomTombstoneExpired(
      closedAt,
      closedAt + CLOSED_ROOM_TOMBSTONE_MS - 1,
    ),
    false,
  );
  assert.equal(
    isRoomTombstoneExpired(
      closedAt,
      closedAt + CLOSED_ROOM_TOMBSTONE_MS,
    ),
    true,
  );
});
