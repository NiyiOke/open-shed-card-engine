export const PUBLIC_HOST_SUPPRESSION_AFTER_MS = 45_000;
export const ABANDONED_WAITING_ROOM_CLOSE_AFTER_MS = 5 * 60_000;
export const CLOSED_ROOM_TOMBSTONE_MS = 24 * 60 * 60_000;

export type RoomStatus = "open" | "closed";
export type PersistedGameStatus = "lobby" | "playing" | "finished";
export type RoomCloseReason =
  | "empty"
  | "abandoned"
  | "host_closed"
  | "expired";
export type PublicHostVisibility = "eligible" | "suppressed";

export type WaitingRoomLifecycleAction =
  | "none"
  | "mark_abandoned"
  | "clear_abandoned"
  | "close_abandoned";

export type WaitingRoomLifecycleInput = {
  roomStatus: RoomStatus;
  gameStatus: PersistedGameStatus;
  abandonedSince: number | null;
  memberLastSeenAt: Array<number | null>;
  now: number;
};

export type WaitingRoomLifecycleDecision = {
  action: WaitingRoomLifecycleAction;
  attended: boolean;
  abandonedSince: number | null;
  shouldClose: boolean;
};

export function presenceAgeMs(
  lastSeenAt: number | null,
  now: number,
): number {
  if (
    lastSeenAt === null ||
    !Number.isFinite(lastSeenAt) ||
    !Number.isFinite(now)
  ) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, now - lastSeenAt);
}

export function classifyPublicHostVisibility(
  lastSeenAt: number | null,
  now: number,
): PublicHostVisibility {
  return presenceAgeMs(lastSeenAt, now) >=
    PUBLIC_HOST_SUPPRESSION_AFTER_MS
    ? "suppressed"
    : "eligible";
}

export function hasLiveOrReconnectingPresence(
  memberLastSeenAt: Array<number | null>,
  now: number,
): boolean {
  return memberLastSeenAt.some(
    (lastSeenAt) =>
      presenceAgeMs(lastSeenAt, now) < PUBLIC_HOST_SUPPRESSION_AFTER_MS,
  );
}

/**
 * Applies only to open waiting rooms. The timer begins when the latest known
 * member crosses the 45-second disconnected boundary; if no timestamp exists,
 * the first unattended observation starts it. A live/reconnecting heartbeat
 * clears the timer.
 */
export function evaluateWaitingRoomLifecycle(
  input: WaitingRoomLifecycleInput,
): WaitingRoomLifecycleDecision {
  if (input.roomStatus === "closed") {
    return {
      action: "none",
      attended: false,
      abandonedSince: input.abandonedSince,
      shouldClose: false,
    };
  }

  if (input.gameStatus !== "lobby") {
    return {
      action: input.abandonedSince === null ? "none" : "clear_abandoned",
      attended: hasLiveOrReconnectingPresence(
        input.memberLastSeenAt,
        input.now,
      ),
      abandonedSince: null,
      shouldClose: false,
    };
  }

  const attended = hasLiveOrReconnectingPresence(
    input.memberLastSeenAt,
    input.now,
  );
  if (attended) {
    return {
      action: input.abandonedSince === null ? "none" : "clear_abandoned",
      attended: true,
      abandonedSince: null,
      shouldClose: false,
    };
  }

  if (input.abandonedSince === null) {
    const abandonedSince = deriveAbandonedSince(
      input.memberLastSeenAt,
      input.now,
    );
    const shouldClose =
      input.now - abandonedSince >=
      ABANDONED_WAITING_ROOM_CLOSE_AFTER_MS;
    return {
      action: shouldClose ? "close_abandoned" : "mark_abandoned",
      attended: false,
      abandonedSince,
      shouldClose,
    };
  }

  const abandonedFor = Math.max(0, input.now - input.abandonedSince);
  const shouldClose =
    abandonedFor >= ABANDONED_WAITING_ROOM_CLOSE_AFTER_MS;
  return {
    action: shouldClose ? "close_abandoned" : "none",
    attended: false,
    abandonedSince: input.abandonedSince,
    shouldClose,
  };
}

export function roomTombstoneExpiresAt(closedAt: number): number {
  return closedAt + CLOSED_ROOM_TOMBSTONE_MS;
}

export function isRoomTombstoneExpired(
  closedAt: number,
  now: number,
): boolean {
  return now >= roomTombstoneExpiresAt(closedAt);
}

function deriveAbandonedSince(
  memberLastSeenAt: Array<number | null>,
  now: number,
): number {
  const lastObservedPresence = memberLastSeenAt.reduce<number | null>(
    (latest, entry) => {
      if (entry === null || !Number.isFinite(entry)) return latest;
      return latest === null ? entry : Math.max(latest, entry);
    },
    null,
  );
  return lastObservedPresence === null
    ? now
    : Math.min(now, lastObservedPresence + PUBLIC_HOST_SUPPRESSION_AFTER_MS);
}
