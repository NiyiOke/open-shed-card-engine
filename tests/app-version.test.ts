import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  APP_BUILD_ID,
  APP_RELEASE_IDENTITY,
  APP_RELEASE_LABEL,
  APP_VERSION,
  APP_VERSION_LABEL,
  PUBLIC_BUILD_ID_ENV,
  PUBLIC_BUILD_ID_MAX_LENGTH,
  normalizePublicBuildId,
} from "../lib/app-version";

test("application release identity is canonical and matches package metadata", () => {
  const packageMetadata = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  const lockMetadata = JSON.parse(
    readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
  ) as { version?: unknown; packages?: Record<string, { version?: unknown }> };

  assert.equal(APP_VERSION, "1.6.1");
  assert.equal(APP_VERSION_LABEL, "V1.6.1");
  assert.equal(APP_RELEASE_LABEL, "Open Shed V1.6.1");
  assert.equal(packageMetadata.version, APP_VERSION);
  assert.equal(lockMetadata.version, APP_VERSION);
  assert.equal(lockMetadata.packages?.[""]?.version, APP_VERSION);
  assert.deepEqual(APP_RELEASE_IDENTITY, {
    appVersion: APP_VERSION,
    buildId: APP_BUILD_ID,
  });
  assert.equal(Object.isFrozen(APP_RELEASE_IDENTITY), true);
});

test("optional public build identifiers are short opaque ASCII slugs", () => {
  assert.equal(PUBLIC_BUILD_ID_ENV, "NEXT_PUBLIC_OPEN_SHED_BUILD_ID");
  assert.equal(normalizePublicBuildId(undefined), null);
  assert.equal(normalizePublicBuildId(null), null);
  assert.equal(normalizePublicBuildId("  release-2026.08.12_01  "), "release-2026.08.12_01");
  assert.equal(normalizePublicBuildId("799fcfb"), "799fcfb");

  for (const unsafe of [
    "contains spaces",
    "https://build.example/private",
    "key=value",
    "person@example.com",
    "../secret",
    "-leading",
    "trailing-",
    "x".repeat(PUBLIC_BUILD_ID_MAX_LENGTH + 1),
  ]) {
    assert.equal(normalizePublicBuildId(unsafe), null);
  }
});

test("document metadata exposes only the canonical release, not table state", () => {
  const layoutSource = readFileSync(
    new URL("../app/layout.tsx", import.meta.url),
    "utf8",
  );
  assert.match(layoutSource, /generator:\s*APP_RELEASE_LABEL/u);
  assert.match(layoutSource, /"open-shed-version":\s*APP_VERSION/u);
  assert.doesNotMatch(layoutSource, /STATE v|game\.revision/u);
});
