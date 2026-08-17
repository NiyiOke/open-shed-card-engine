import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCommandActivityDelivery,
  reconcileCommandActivity,
  type ActivityEventLine,
} from "../app/components/game-activity-sync";
import { gameCommandActivityFields } from "../lib/server/game-command-response";

const COMMAND_EVENT = {
  type: "card_played",
  message: "Alex played Blue 2.",
} as const;
const INTERVENING_EVENT = {
  type: "card_drawn",
  message: "Bailey drew a card.",
} as const;

test("the server advertises a cursor only for activity included in the response", () => {
  assert.deepEqual(
    gameCommandActivityFields(false, 11, [COMMAND_EVENT]),
    {
      events: [COMMAND_EVENT],
      eventCursor: 11,
      replayed: false,
    },
  );
  assert.deepEqual(
    gameCommandActivityFields(true, 11, [COMMAND_EVENT]),
    {
      events: [],
      eventCursor: null,
      replayed: true,
    },
    "a replay must not claim that its empty event list delivered the receipt revision",
  );
  assert.throws(
    () => gameCommandActivityFields(false, 1.5, [COMMAND_EVENT]),
    TypeError,
  );
});

test("the client parser fails closed on contradictory replay activity", () => {
  assert.deepEqual(
    parseCommandActivityDelivery({
      ...gameCommandActivityFields(false, 11, [
        { ...COMMAND_EVENT, actorPlayerId: "not-needed-by-the-client" },
      ]),
      view: { revision: 11 },
    }),
    {
      events: [COMMAND_EVENT],
      eventCursor: 11,
      replayed: false,
    },
    "the activity boundary keeps only the public presentation fields it consumes",
  );
  assert.equal(
    parseCommandActivityDelivery({
      events: [],
      eventCursor: 11,
      replayed: true,
    }),
    null,
  );
  assert.equal(
    parseCommandActivityDelivery({
      events: [COMMAND_EVENT],
      eventCursor: null,
      replayed: true,
    }),
    null,
  );
  assert.equal(
    parseCommandActivityDelivery({
      events: [],
      eventCursor: null,
      replayed: false,
    }),
    null,
  );
});

test("a lost response and later replay preserve both the accepted and intervening activity", () => {
  const durableActivity = [
    { revision: 11, event: COMMAND_EVENT },
    { revision: 12, event: INTERVENING_EVENT },
  ] as const;
  let cursor = 10;
  const rendered: ActivityEventLine[] = [];

  // Revision 11 was accepted, but this first response never reached the client.
  gameCommandActivityFields(false, 11, [COMMAND_EVENT]);

  // Another player moves at revision 12 before the original command is retried.
  const replay = parseCommandActivityDelivery(
    gameCommandActivityFields(true, 11, []),
  );
  assert.ok(replay);
  const replayUpdate = reconcileCommandActivity(cursor, 10, replay);
  assert.equal(replayUpdate.eventCursor, 10);
  assert.deepEqual(replayUpdate.eventsToAppend, []);
  cursor = replayUpdate.eventCursor!;

  // Polling from the preserved cursor recovers both events in revision order.
  const recovered = durableActivity.filter(({ revision }) => revision > cursor);
  rendered.push(...recovered.map(({ event }) => event));
  cursor = recovered.at(-1)?.revision ?? cursor;
  assert.equal(cursor, 12);
  assert.deepEqual(rendered, [COMMAND_EVENT, INTERVENING_EVENT]);

  // A repeated durable replay cannot duplicate either recovered event.
  const repeatedReplay = reconcileCommandActivity(cursor, 10, replay);
  const afterRepeatedReplay: ActivityEventLine[] = [
    ...rendered,
    ...repeatedReplay.eventsToAppend,
  ];
  assert.equal(repeatedReplay.eventCursor, 12);
  assert.deepEqual(afterRepeatedReplay, [COMMAND_EVENT, INTERVENING_EVENT]);
});

test("a delivered command appends once and a subsequent poll starts after it", () => {
  const fresh = parseCommandActivityDelivery(
    gameCommandActivityFields(false, 11, [COMMAND_EVENT]),
  );
  assert.ok(fresh);
  const first = reconcileCommandActivity(10, 10, fresh);
  assert.equal(first.eventCursor, 11);
  assert.deepEqual(first.eventsToAppend, [COMMAND_EVENT]);

  const duplicate = reconcileCommandActivity(11, 10, fresh);
  assert.equal(duplicate.eventCursor, 11);
  assert.deepEqual(duplicate.eventsToAppend, []);

  const afterCommand = [
    { revision: 11, event: COMMAND_EVENT },
    { revision: 12, event: INTERVENING_EVENT },
  ].filter(({ revision }) => revision > duplicate.eventCursor!);
  assert.deepEqual(afterCommand.map(({ event }) => event), [INTERVENING_EVENT]);
});

test("non-contiguous command activity waits for polling instead of skipping a gap", () => {
  const fresh = parseCommandActivityDelivery(
    gameCommandActivityFields(false, 11, [COMMAND_EVENT]),
  );
  assert.ok(fresh);
  assert.deepEqual(
    reconcileCommandActivity(9, 10, fresh),
    { eventCursor: 9, eventsToAppend: [] },
  );
});
