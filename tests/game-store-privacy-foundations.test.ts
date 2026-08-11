import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizePublicAlias } from "../lib/server/discovery-policy";

const STORE_SOURCE = readFileSync(
  fileURLToPath(new URL("../lib/server/game-store.ts", import.meta.url)),
  "utf8",
);
const JOIN_ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("../app/api/games/join/route.ts", import.meta.url)),
  "utf8",
);

test("viewer event bounds cannot move below a member's event floor", () => {
  assert.match(
    STORE_SOURCE,
    /afterRevision:\s+afterRevision === undefined\s+\? undefined\s+: Math\.max\(afterRevision, minimumVersion - 1\)/u,
  );
  assert.match(
    STORE_SOURCE,
    /Math\.max\(0, Number\(membership\.event_floor_version\)\)/u,
  );
});

test("manual-code join requires an explicit alias without a suggested-name fallback", () => {
  assert.match(JOIN_ROUTE_SOURCE, /typeof body\.nickname !== "string"/u);
  assert.match(JOIN_ROUTE_SOURCE, /"INVALID_ALIAS"/u);
  assert.doesNotMatch(JOIN_ROUTE_SOURCE, /user\.suggestedName/u);
});

test("manual-code join shares the strict public alias policy", () => {
  assert.equal(normalizePublicAlias("x"), null);
  assert.equal(normalizePublicAlias("  Room   Alias  "), "Room Alias");
  const normalization = STORE_SOURCE.indexOf(
    "const alias = normalizePublicAlias(nickname)",
  );
  const databaseLookup = STORE_SOURCE.indexOf(
    "const database = await ensureDatabaseSchema()",
    STORE_SOURCE.indexOf("export async function joinGame"),
  );
  assert.ok(normalization >= 0 && normalization < databaseLookup);
});

test("membership SQL resets the event floor only for a true reactivation", () => {
  assert.match(
    STORE_SOURCE,
    /event_floor_version = CASE\s+WHEN game_members\.status = 'left' AND excluded\.status <> 'left'\s+THEN excluded\.event_floor_version\s+ELSE game_members\.event_floor_version\s+END/u,
  );
  assert.match(
    STORE_SOURCE,
    /WHERE game_id = \? AND version > \? AND version >= \?/u,
  );
});
