import assert from "node:assert/strict";
import test from "node:test";

import { isAllowedOrigin, readConfig } from "../src/config";

test("realtime is disabled unless explicitly enabled", () => {
  assert.equal(readConfig({}).enabled, false);
  assert.equal(readConfig({ OPEN_SHED_REALTIME_ENABLED: "false" }).enabled, false);
  assert.equal(readConfig({ OPEN_SHED_REALTIME_ENABLED: "TRUE" }).enabled, false);
  assert.equal(readConfig({ OPEN_SHED_REALTIME_ENABLED: "true" }).enabled, true);
});

test("origin allowlist is exact and fails closed", () => {
  const config = readConfig({
    ALLOWED_ORIGINS: '["https://example.com","https://example.com/path","javascript:alert(1)"]',
  });
  assert.equal(isAllowedOrigin("https://example.com", config.allowedOrigins), true);
  assert.equal(isAllowedOrigin("https://example.com/", config.allowedOrigins), false);
  assert.equal(isAllowedOrigin("https://sub.example.com", config.allowedOrigins), false);
  assert.equal(isAllowedOrigin(null, config.allowedOrigins), false);
  assert.deepEqual([...readConfig({ ALLOWED_ORIGINS: "not-json" }).allowedOrigins], []);
});

test("unsafe quota configuration falls back to hard bounded defaults", () => {
  const config = readConfig({
    MAX_CONNECTIONS_PER_ROOM: "10000",
    MAX_READY_CONNECTIONS_PER_SUBJECT: "10000",
    MAX_NOTIFICATIONS_PER_SECOND: "0",
    MAX_BUFFERED_BYTES: "2",
  });
  assert.equal(config.maxConnections, 64);
  assert.equal(config.maxReadyConnectionsPerSubject, 3);
  assert.equal(config.maxNotificationsPerSecond, 20);
  assert.equal(config.maxBufferedBytes, 65_536);
});

test("per-subject ready socket quota has a hard maximum of three", () => {
  assert.equal(readConfig({}).maxReadyConnectionsPerSubject, 3);
  assert.equal(readConfig({ MAX_READY_CONNECTIONS_PER_SUBJECT: "2" }).maxReadyConnectionsPerSubject, 2);
  assert.equal(readConfig({ MAX_READY_CONNECTIONS_PER_SUBJECT: "4" }).maxReadyConnectionsPerSubject, 3);
});
