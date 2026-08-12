import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  NEXT_RELEASE_LABEL,
  NEXT_RELEASE_PREVIEW,
  RELEASE_NOTES,
  tableRevisionLabel,
} from "../app/components/release-ui";
import {
  APP_RELEASE_LABEL,
  APP_VERSION_LABEL,
} from "../lib/app-version";

const GAME_SHELL_SOURCE = readFileSync(
  new URL("../app/components/GameShell.tsx", import.meta.url),
  "utf8",
);
const LANDING_SOURCE = readFileSync(
  new URL("../app/components/SignedOutLanding.tsx", import.meta.url),
  "utf8",
);
const CSS_SOURCE = readFileSync(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);

test("release UI uses the canonical app version and names the next release", () => {
  assert.equal(APP_VERSION_LABEL, "V1.6.0");
  assert.equal(APP_RELEASE_LABEL, "Open Shed V1.6.0");
  assert.equal(NEXT_RELEASE_LABEL, "V1.6.1");
  assert.match(NEXT_RELEASE_PREVIEW, /stability/i);
  assert.match(NEXT_RELEASE_PREVIEW, /accessibility/i);
  assert.ok(RELEASE_NOTES.some((note) => /host controls/i.test(note)));
  assert.ok(RELEASE_NOTES.some((note) => /series score/i.test(note)));
  assert.ok(RELEASE_NOTES.some((note) => /table revision/i.test(note)));
});

test("table revisions are diagnostic counters, never app-version labels", () => {
  assert.equal(tableRevisionLabel(0), "Table revision 0");
  assert.equal(tableRevisionLabel(42), "Table revision 42");
  assert.equal(tableRevisionLabel(-1), "Table revision 0");
  assert.equal(tableRevisionLabel(1.5), "Table revision 0");
  assert.doesNotMatch(tableRevisionLabel(42), /\bv\d/iu);
  assert.doesNotMatch(GAME_SHELL_SOURCE, /STATE\s+v\{/u);
  assert.match(GAME_SHELL_SOURCE, /tableRevisionLabel\(game\.revision\)/u);
});

test("About and What's New are reachable in signed-in and signed-out modes", () => {
  assert.match(GAME_SHELL_SOURCE, /release-identity--table/u);
  assert.match(GAME_SHELL_SOURCE, /release-identity--lobby/u);
  assert.match(LANDING_SOURCE, /release-identity--public/u);
  assert.match(CSS_SOURCE, /\.release-identity\s*\{[\s\S]*?min-height:\s*44px/u);
  assert.match(CSS_SOURCE, /@media \(max-width: 720px\)[\s\S]*?\.release-dialog/u);
  const releaseSource = readFileSync(
    new URL("../app/components/release-ui.tsx", import.meta.url),
    "utf8",
  );
  assert.match(releaseSource, /requestAnimationFrame\(\(\) => closeButtonRef\.current\?\.focus\(\)\)/u);
  assert.match(releaseSource, /onClose=\{\(\) => triggerRef\.current\?\.focus\(\)\}/u);
  assert.doesNotMatch(releaseSource, /autoFocus/u);
});
