import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const MESSAGE_ROUTE = source(
  "../app/api/games/[gameId]/messages/route.ts",
);
const REPORT_ROUTE = source(
  "../app/api/messages/[messageId]/report/route.ts",
);
const MUTE_ROUTE = source(
  "../app/api/games/[gameId]/players/[playerId]/mute/route.ts",
);
const BLOCK_ROUTE = source(
  "../app/api/games/[gameId]/players/[playerId]/block/route.ts",
);

test("all communication routes fail closed before parsing request bodies", () => {
  for (const route of [MESSAGE_ROUTE, REPORT_ROUTE, MUTE_ROUTE, BLOCK_ROUTE]) {
    const featureGate = route.indexOf("assertCommunicationEnabled();");
    const bodyRead = route.indexOf("readJsonObject(request)");
    assert.ok(featureGate >= 0);
    if (bodyRead >= 0) assert.ok(featureGate < bodyRead);
  }
});

test("message route accepts only the exact curated send envelope", () => {
  assert.match(
    MESSAGE_ROUTE,
    /hasRecognizedFreeTextField\(body, \["commandId", "kind", "contentId"\]\)/u,
  );
  assert.match(MESSAGE_ROUTE, /"FREE_TEXT_DISABLED"/u);
  assert.match(
    MESSAGE_ROUTE,
    /assertExactJsonKeys\([\s\S]*\["commandId", "kind", "contentId"\][\s\S]*"INVALID_MESSAGE"/u,
  );
  assert.match(MESSAGE_ROUTE, /parseCommunicationMessage\(body\.kind, body\.contentId\)/u);
  assert.doesNotMatch(MESSAGE_ROUTE, /body\.(actor|sender|profileId)/u);
});

test("report route accepts no arbitrary evidence or unbounded details", () => {
  assert.match(
    REPORT_ROUTE,
    /hasRecognizedFreeTextField\(body, \["commandId", "reason"\]\)/u,
  );
  assert.match(REPORT_ROUTE, /"FREE_TEXT_DISABLED"/u);
  assert.match(
    REPORT_ROUTE,
    /assertExactJsonKeys\([\s\S]*\["commandId", "reason"\][\s\S]*"INVALID_REPORT"/u,
  );
  assert.match(REPORT_ROUTE, /parseReportReason\(body\.reason\)/u);
});

test("mute and block PUT/DELETE requests require exact empty JSON objects", () => {
  for (const route of [MUTE_ROUTE, BLOCK_ROUTE]) {
    assert.match(route, /export async function PUT/u);
    assert.match(route, /export async function DELETE/u);
    assert.match(
      route,
      /assertExactJsonKeys\([\s\S]*body,[\s\S]*\[\],[\s\S]*"INVALID_SAFETY_ACTION"/u,
    );
    assert.doesNotMatch(route, /commandId/u);
  }
});

test("GET uses only one syntactically opaque cursor", () => {
  assert.match(MESSAGE_ROUTE, /keys\.some\(\(key\) => key !== "cursor"\)/u);
  assert.match(MESSAGE_ROUTE, /searchParams\.getAll\("cursor"\)\.length > 1/u);
  assert.match(MESSAGE_ROUTE, /requireOpaqueCommunicationId/u);
});

function source(relativeUrl: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativeUrl, import.meta.url)),
    "utf8",
  );
}
