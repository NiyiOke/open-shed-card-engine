import assert from "node:assert/strict";
import test from "node:test";

import { enforceRealtimeTicketQuota } from "../lib/server/realtime-ticket-store";

test("ticket quotas are layered, bounded, and hide raw account and game identifiers", async () => {
  const bindings: unknown[][] = [];
  const database = {
    prepare(sql: string) {
      assert.match(sql, /INSERT INTO mutation_quotas/u);
      return {
        bind(...values: unknown[]) {
          bindings.push(values);
          return { first: async () => ({ count: 1 }) };
        },
      };
    },
  } as unknown as D1Database;

  await enforceRealtimeTicketQuota("private-user-canary", "private-game-canary", {
    database,
    now: 1_800_000_000_000,
  });

  assert.equal(bindings.length, 3);
  assert.match(String(bindings[0]?.[0]), /^realtime:profile-game:/u);
  assert.match(String(bindings[1]?.[0]), /^realtime:profile:/u);
  assert.match(String(bindings[2]?.[0]), /^realtime:room:/u);
  assert.equal(JSON.stringify(bindings).includes("private-user-canary"), false);
  assert.equal(JSON.stringify(bindings).includes("private-game-canary"), false);
});

test("the profile-game quota fails closed before broader buckets are charged", async () => {
  let statements = 0;
  const database = {
    prepare() {
      statements += 1;
      return {
        bind() {
          return { first: async () => ({ count: 11 }) };
        },
      };
    },
  } as unknown as D1Database;

  await assert.rejects(
    () => enforceRealtimeTicketQuota("user", "game", { database, now: 0 }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "RATE_LIMITED");
      return true;
    },
  );
  assert.equal(statements, 1);
});
