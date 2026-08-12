import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const RUNTIME_SOURCE = readFileSync(
  fileURLToPath(new URL("../db/runtime.ts", import.meta.url)),
  "utf8",
);

test("production requests return the D1 binding before legacy schema bootstrap", () => {
  const start = RUNTIME_SOURCE.indexOf(
    "export async function ensureDatabaseSchema",
  );
  const end = RUNTIME_SOURCE.indexOf("async function initialize", start);
  assert.ok(start >= 0 && end > start);
  const hotPath = RUNTIME_SOURCE.slice(start, end);

  const binding = hotPath.indexOf("const database = getRawDb()");
  const productionReturn = hotPath.indexOf(
    'if (process.env.NODE_ENV === "production") return database',
  );
  const bootstrap = hotPath.indexOf("schemaPromise ??= initialize(database)");
  assert.ok(binding >= 0);
  assert.ok(productionReturn > binding);
  assert.ok(bootstrap > productionReturn);
  assert.doesNotMatch(
    withoutLineComments(hotPath.slice(binding, productionReturn)),
    /await|\.batch\(|\.prepare\(|PRAGMA|CREATE |ALTER |UPDATE /u,
  );
});

test("DDL, compatibility backfill, and optimization remain local-only", () => {
  const initializer = RUNTIME_SOURCE.slice(
    RUNTIME_SOURCE.indexOf("async function initialize"),
  );
  assert.match(initializer, /CREATE TABLE IF NOT EXISTS profiles/u);
  assert.match(initializer, /PRAGMA table_info/u);
  assert.match(initializer, /SET communication_scope = 'public_safe'/u);
  assert.match(initializer, /PRAGMA optimize/u);

  const beforeInitializer = RUNTIME_SOURCE.slice(
    0,
    RUNTIME_SOURCE.indexOf("async function initialize"),
  );
  assert.doesNotMatch(
    withoutLineComments(beforeInitializer),
    /CREATE TABLE|CREATE INDEX|ALTER TABLE|PRAGMA|SET communication_scope/u,
  );
});

function withoutLineComments(value: string): string {
  return value.replace(/^\s*\/\/.*$/gmu, "");
}
