export type ActivityEventLine = Readonly<{
  type: string;
  message: string;
}>;

export type CommandActivityDelivery = Readonly<{
  events: ActivityEventLine[];
  /** The last activity revision represented by `events`, or null on replay. */
  eventCursor: number | null;
  replayed: boolean;
}>;

export type CommandActivityReconciliation = Readonly<{
  eventCursor: number | null;
  eventsToAppend: ActivityEventLine[];
}>;

const MAX_COMMAND_EVENTS = 32;
const MAX_EVENT_TYPE_LENGTH = 96;
const MAX_EVENT_MESSAGE_LENGTH = 1_024;

/**
 * Parse only the activity-delivery portion of a command response. The response
 * may also contain its viewer projection and listing, which are intentionally
 * outside this helper's boundary.
 */
export function parseCommandActivityDelivery(
  value: unknown,
): CommandActivityDelivery | null {
  if (
    !isRecord(value) ||
    typeof value.replayed !== "boolean" ||
    !Array.isArray(value.events) ||
    value.events.length > MAX_COMMAND_EVENTS
  ) {
    return null;
  }

  const eventCursor = value.eventCursor;
  if (
    eventCursor !== null &&
    (!Number.isSafeInteger(eventCursor) || (eventCursor as number) < 0)
  ) {
    return null;
  }
  if (
    (value.replayed && (eventCursor !== null || value.events.length !== 0)) ||
    (!value.replayed && eventCursor === null)
  ) {
    return null;
  }

  const events: ActivityEventLine[] = [];
  for (const candidate of value.events) {
    if (
      !isRecord(candidate) ||
      !isBoundedText(candidate.type, MAX_EVENT_TYPE_LENGTH) ||
      !isBoundedText(candidate.message, MAX_EVENT_MESSAGE_LENGTH)
    ) {
      return null;
    }
    events.push({ type: candidate.type, message: candidate.message });
  }

  return {
    events,
    eventCursor: eventCursor as number | null,
    replayed: value.replayed,
  };
}

/**
 * Advance activity only when a fresh response delivers the immediately next
 * command revision. A replay can contain a much newer GameView, but it carries
 * no activity, so the caller's cursor must remain unchanged and polling can
 * recover both the accepted command and any intervening moves in order.
 */
export function reconcileCommandActivity(
  currentEventCursor: number | null,
  expectedGameRevision: number,
  delivery: CommandActivityDelivery,
): CommandActivityReconciliation {
  const current = isRevision(currentEventCursor) ? currentEventCursor : null;
  const deliveredCursor = isRevision(delivery.eventCursor)
    ? delivery.eventCursor
    : null;
  if (delivery.replayed || current === null || deliveredCursor === null) {
    return { eventCursor: current, eventsToAppend: [] };
  }

  if (current >= deliveredCursor) {
    return { eventCursor: current, eventsToAppend: [] };
  }

  const isContiguousDelivery =
    isRevision(expectedGameRevision) &&
    current === expectedGameRevision &&
    deliveredCursor === expectedGameRevision + 1;
  if (!isContiguousDelivery) {
    return { eventCursor: current, eventsToAppend: [] };
  }

  return {
    eventCursor: deliveredCursor,
    eventsToAppend: delivery.events,
  };
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBoundedText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        (codePoint <= 31 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) ||
        codePoint === 127
      );
    })
  );
}
