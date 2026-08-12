import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RuntimeErrorFallback } from "../app/components/RuntimeErrorFallback";
import {
  auditClientPerformance,
  parseVinextClientAssetManifest,
  type ClientPerformanceBudget,
} from "../lib/build/client-performance-budget";

const GAME_SHELL_PATH = fileURLToPath(
  new URL("../app/components/GameShell.tsx", import.meta.url),
);
const LIVE_VOICE_PATH = fileURLToPath(
  new URL("../app/components/live-voice.ts", import.meta.url),
);
const GAME_TABLE_CANVAS_PATH = fileURLToPath(
  new URL("../app/components/GameTableCanvas.tsx", import.meta.url),
);
const GAME_STORE_PATH = fileURLToPath(
  new URL("../lib/server/game-store.ts", import.meta.url),
);
const LIVE_VOICE_CLEANUP_PATH = fileURLToPath(
  new URL("../lib/server/live-voice-cleanup.ts", import.meta.url),
);

const GAME_SHELL = readFileSync(GAME_SHELL_PATH, "utf8");
const LIVE_VOICE = readFileSync(LIVE_VOICE_PATH, "utf8");
const GAME_TABLE_CANVAS = readFileSync(GAME_TABLE_CANVAS_PATH, "utf8");
const GAME_STORE = readFileSync(GAME_STORE_PATH, "utf8");
const LIVE_VOICE_CLEANUP = readFileSync(LIVE_VOICE_CLEANUP_PATH, "utf8");

test("runtime error fallback offers recovery without reflecting error details", () => {
  const markup = renderToStaticMarkup(
    createElement(RuntimeErrorFallback, { reset: () => undefined }),
  );
  assert.match(markup, /The table view hit a snag/u);
  assert.match(markup, /Try again/u);
  assert.match(markup, /Reload page/u);
  assert.match(markup, /Back to games/u);
  assert.doesNotMatch(markup, /stack|digest|identifier|Error:/iu);

  const routeBoundary = readFileSync(
    fileURLToPath(new URL("../app/error.tsx", import.meta.url)),
    "utf8",
  );
  const globalBoundary = readFileSync(
    fileURLToPath(new URL("../app/global-error.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(routeBoundary, /^"use client";/u);
  assert.match(routeBoundary, /RuntimeErrorFallback reset=\{reset\}/u);
  assert.match(globalBoundary, /^"use client";/u);
  assert.match(globalBoundary, /<html lang="en">[\s\S]*<body>/u);
  assert.doesNotMatch(`${routeBoundary}\n${globalBoundary}`, /error\.message|error\.stack|digest/u);
});

test("polling and render loops remain bounded and clean up browser resources", () => {
  assert.doesNotMatch(GAME_SHELL, /setInterval\(/u);
  assert.match(
    GAME_SHELL,
    /if \(existing\?\.gameId === gameId\) return existing\.promise/u,
  );
  assert.match(GAME_SHELL, /pollFailureCountRef\.current \+ 1, 5/u);
  assert.match(GAME_SHELL, /Math\.min\(15_000, 1_500 \* 2 \*\* pollFailureCountRef\.current\)/u);
  assert.match(GAME_SHELL, /document\.hidden \? Math\.max\(10_000, visibleDelay\)/u);
  assert.match(GAME_SHELL, /controller\?\.abort\(\)/u);
  assert.equal(
    occurrences(GAME_SHELL, 'window.addEventListener("focus", refreshNow)'),
    occurrences(GAME_SHELL, 'window.removeEventListener("focus", refreshNow)'),
  );
  assert.equal(
    occurrences(GAME_SHELL, 'window.addEventListener("online", refreshNow)'),
    occurrences(GAME_SHELL, 'window.removeEventListener("online", refreshNow)'),
  );
  assert.match(GAME_TABLE_CANVAS, /Math\.min\(window\.devicePixelRatio \|\| 1, 2\)/u);
  assert.match(GAME_TABLE_CANVAS, /observer\.disconnect\(\)/u);
  assert.match(GAME_TABLE_CANVAS, /removeEventListener\("open-shed-step", render\)/u);
});

test("heavy voice code stays behind one dynamic client import", () => {
  assert.doesNotMatch(GAME_SHELL, /["']livekit-client["']/u);
  assert.equal(occurrences(LIVE_VOICE, '() => import("livekit-client")'), 1);
  assert.match(LIVE_VOICE, /^import type \{[\s\S]*?\} from "livekit-client";/mu);
  assert.doesNotMatch(LIVE_VOICE, /^import \{[\s\S]*?\} from "livekit-client";/mu);

  // Source ceilings are early warnings; the post-build CI gate measures the
  // real emitted chunks.
  assert.ok(statSync(GAME_SHELL_PATH).size <= 230_000);
  assert.ok(statSync(LIVE_VOICE_PATH).size <= 38_000);
  assert.ok(statSync(GAME_STORE_PATH).size <= 175_000);
});

test("server maintenance work keeps explicit cadence, batch, and provider bounds", () => {
  assert.match(GAME_STORE, /const PURGE_INTERVAL_MS = 60_000/u);
  assert.match(GAME_STORE, /const PURGE_BATCH_SIZE = 12/u);
  assert.match(GAME_STORE, /const ROOM_MAINTENANCE_INTERVAL_MS = 15_000/u);
  assert.match(GAME_STORE, /const ROOM_MAINTENANCE_BATCH_SIZE = 12/u);
  assert.match(LIVE_VOICE_CLEANUP, /const CLEANUP_RECONCILE_LIMIT = 8/u);
  assert.match(LIVE_VOICE_CLEANUP, /const CLEANUP_PROVIDER_DEADLINE_MS = 1_500/u);
  assert.match(LIVE_VOICE_CLEANUP, /Promise\.race\(/u);
});

test("client asset manifest parser is JSON-only", () => {
  const manifest = parseVinextClientAssetManifest(
    'export default {"appBootstrapPreinitModules":[],"lazyChunks":[],"dynamicPreloads":{}};',
  );
  assert.deepEqual(manifest.appBootstrapPreinitModules, []);
  assert.throws(
    () => parseVinextClientAssetManifest("export default globalThis.manifest;"),
    /CLIENT_ASSET_MANIFEST_FORMAT/u,
  );
  assert.throws(
    () => parseVinextClientAssetManifest('export default {"dynamicPreloads":{}};'),
    /CLIENT_ASSET_MANIFEST_SHAPE/u,
  );
});

test("client performance audit accepts a split build and rejects eager LiveKit", () => {
  const manifest = parseVinextClientAssetManifest(
    `export default ${JSON.stringify({
      appBootstrapPreinitModules: ["/_next/runtime.js"],
      lazyChunks: ["_next/game.js", "_next/livekit.js"],
      dynamicPreloads: {
        "virtual:vinext-app-browser-entry": ["_next/index.js", "_next/runtime.js"],
        "app/components/GameShell.tsx": ["_next/game.js", "_next/index.js"],
        "node_modules/livekit-client/dist/livekit-client.esm.mjs": ["_next/livekit.js"],
      },
    })};`,
  );
  const generousBudget: ClientPerformanceBudget = {
    initialJavaScriptBytes: 1_000,
    largestInitialChunkBytes: 1_000,
    liveKitChunkBytes: 1_000,
    totalJavaScriptBytes: 2_000,
    totalCssBytes: 1_000,
  };
  const assets = {
    "_next/runtime.js": 100,
    "_next/index.js": 200,
    "_next/game.js": 300,
    "_next/livekit.js": 400,
    "_next/index.css": 50,
  };
  const healthy = auditClientPerformance(manifest, assets, generousBudget);
  assert.equal(healthy.initialJavaScriptBytes, 600);
  assert.equal(healthy.liveKitChunkBytes, 400);
  assert.deepEqual(healthy.errors, []);

  const eagerManifest = {
    ...manifest,
    appBootstrapPreinitModules: [
      ...manifest.appBootstrapPreinitModules,
      "/_next/livekit.js",
    ],
  };
  const eager = auditClientPerformance(eagerManifest, assets, {
    ...generousBudget,
    largestInitialChunkBytes: 250,
  });
  assert.ok(eager.errors.some((entry) => entry.includes("LiveKit became eager")));
  assert.ok(eager.errors.some((entry) => entry.includes("Largest initial chunk")));
});

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}
