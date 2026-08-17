export type GameCommandActivityFields<Event> = Readonly<{
  events: Event[];
  eventCursor: number | null;
  replayed: boolean;
}>;

/**
 * Describe only activity actually delivered by a command response. A durable
 * replay may project newer game state, but it must never claim that its empty
 * event list covers the receipt revision (or any later revision).
 */
export function gameCommandActivityFields<Event>(
  replayed: boolean,
  resultRevision: number,
  events: readonly Event[],
): GameCommandActivityFields<Event> {
  if (replayed) {
    return { events: [], eventCursor: null, replayed: true };
  }
  if (!Number.isSafeInteger(resultRevision) || resultRevision < 0) {
    throw new TypeError("A delivered command event cursor must be a valid revision.");
  }
  return {
    events: [...events],
    eventCursor: resultRevision,
    replayed: false,
  };
}
