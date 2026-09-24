import assert from "node:assert/strict";
import test from "node:test";
import {
  getRealtimeConfig,
  issueRealtimeTicket,
  REALTIME_AUTHORIZATION_LEASE_MS,
  REALTIME_ENV,
  REALTIME_PROTOCOL,
  REALTIME_TICKET_TTL_MS,
  signRealtimeNotification,
  verifyRealtimeTicket,
} from "../lib/server/realtime-ticket";

const SECRET = "test-shared-secret-with-at-least-thirty-two-bytes";
const VALID_ENV = {
  [REALTIME_ENV.enabled]: "true",
  [REALTIME_ENV.serverUrl]: "https://open-shed-realtime.example.workers.dev",
  [REALTIME_ENV.sharedSecret]: SECRET,
} as const;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function equivalentNonCanonicalBase64Url(value: string): string {
  const remainder = value.length % 4;
  const unusedBits = remainder === 2 ? 4 : remainder === 3 ? 2 : 0;
  assert.ok(unusedBits > 0, "Fixture must end in unused base64url pad bits.");
  const finalIndex = BASE64URL_ALPHABET.indexOf(value.at(-1) ?? "");
  assert.ok(finalIndex >= 0);
  const replacement = BASE64URL_ALPHABET[finalIndex ^ 1];
  assert.ok(replacement);
  return `${value.slice(0, -1)}${replacement}`;
}

async function signTicketPayload(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${REALTIME_PROTOCOL}.${payload}`),
  ));
  return Buffer.from(signature).toString("base64url");
}

test("realtime configuration defaults off and accepts only a bare HTTPS origin", () => {
  assert.equal(getRealtimeConfig({}), null);
  for (const enabled of ["TRUE", "1", "yes", "on", " true ", "false"]) {
    assert.equal(getRealtimeConfig({ ...VALID_ENV, [REALTIME_ENV.enabled]: enabled }), null);
  }
  for (const serverUrl of [
    "http://open-shed-realtime.example.workers.dev",
    "wss://open-shed-realtime.example.workers.dev",
    "https://user:secret@open-shed-realtime.example.workers.dev",
    "https://open-shed-realtime.example.workers.dev/socket",
    "https://open-shed-realtime.example.workers.dev/?ticket=secret",
  ]) {
    assert.equal(
      getRealtimeConfig({ ...VALID_ENV, [REALTIME_ENV.serverUrl]: serverUrl }),
      null,
    );
  }
  assert.equal(
    getRealtimeConfig({
      ...VALID_ENV,
      [REALTIME_ENV.sharedSecret]: "too-short",
    }),
    null,
  );
  assert.deepEqual(getRealtimeConfig(VALID_ENV), {
    httpOrigin: "https://open-shed-realtime.example.workers.dev",
    websocketOrigin: "wss://open-shed-realtime.example.workers.dev",
    sharedSecret: SECRET,
  });
});

test("acceptance-only local transport requires the exact flag and a non-production localhost", () => {
  const local = {
    ...VALID_ENV,
    [REALTIME_ENV.serverUrl]: "http://localhost:8787",
  } as const;
  assert.equal(getRealtimeConfig(local, "test"), null);
  assert.equal(
    getRealtimeConfig({ ...local, OPEN_SHED_ACCEPTANCE_ENVIRONMENT: "TRUE" }, "test"),
    null,
  );
  assert.equal(
    getRealtimeConfig({ ...local, OPEN_SHED_ACCEPTANCE_ENVIRONMENT: "true" }, "production"),
    null,
  );
  assert.equal(
    getRealtimeConfig({
      ...local,
      [REALTIME_ENV.serverUrl]: "http://realtime.example.test:8787",
      OPEN_SHED_ACCEPTANCE_ENVIRONMENT: "true",
    }, "test"),
    null,
  );
  assert.deepEqual(
    getRealtimeConfig({ ...local, OPEN_SHED_ACCEPTANCE_ENVIRONMENT: "true" }, "test"),
    {
      httpOrigin: "http://localhost:8787",
      websocketOrigin: "ws://localhost:8787",
      sharedSecret: SECRET,
    },
  );
  assert.deepEqual(getRealtimeConfig(VALID_ENV, "production"), {
    httpOrigin: "https://open-shed-realtime.example.workers.dev",
    websocketOrigin: "wss://open-shed-realtime.example.workers.dev",
    sharedSecret: SECRET,
  });
});

test("tickets are short-lived, opaque, room-bound, signed, and never put in the URL", async () => {
  const config = getRealtimeConfig(VALID_ENV);
  assert.ok(config);
  const now = 1_800_000_000_000;
  const gameCanary = "private-game-id-canary";
  const subjectCanary = "private-sites-user-id-canary";
  const ticket = await issueRealtimeTicket(config, {
    gameId: gameCanary,
    authSubject: subjectCanary,
    now,
    nonceBytes: Uint8Array.from({ length: 16 }, (_, index) => index),
  });

  assert.equal(ticket.enabled, true);
  assert.match(
    ticket.url,
    /^wss:\/\/[^/]+\/socket\/[A-Za-z0-9_-]{32}\/[0-9]{13}\/[A-Za-z0-9_-]{22}$/u,
  );
  assert.equal(ticket.url.includes(ticket.ticket), false);
  assert.equal(ticket.url.includes(gameCanary), false);
  assert.equal(ticket.url.includes(subjectCanary), false);
  assert.equal(ticket.ticket.includes(gameCanary), false);
  assert.equal(ticket.ticket.includes(subjectCanary), false);
  assert.equal(ticket.expiresAt, now + REALTIME_TICKET_TTL_MS);

  const claims = await verifyRealtimeTicket(config, ticket.ticket, now + 1_000);
  assert.ok(claims);
  assert.equal(claims.v, 1);
  assert.match(claims.room, /^[A-Za-z0-9_-]{32}$/u);
  assert.match(claims.subject, /^[A-Za-z0-9_-]{32}$/u);
  assert.match(claims.nonce, /^[A-Za-z0-9_-]{22}$/u);
  assert.equal(claims.issuedAt, now);
  assert.equal(claims.expiresAt, now + REALTIME_TICKET_TTL_MS);
  assert.equal(claims.leaseUntil, now + REALTIME_AUTHORIZATION_LEASE_MS);
  assert.equal(await verifyRealtimeTicket(config, ticket.ticket, claims.expiresAt + 1), null);
});

test("tampering, extra claims, invalid timing, and another secret fail closed", async () => {
  const config = getRealtimeConfig(VALID_ENV);
  assert.ok(config);
  const now = 1_800_000_000_000;
  const issued = await issueRealtimeTicket(config, {
    gameId: "game",
    authSubject: "subject",
    now,
    nonceBytes: new Uint8Array(16).fill(7),
  });
  const [payload, signature] = issued.ticket.split(".");
  assert.ok(payload && signature);
  assert.equal(
    await verifyRealtimeTicket(config, `${payload}.${signature.slice(0, -1)}A`, now),
    null,
  );
  assert.equal(
    await verifyRealtimeTicket({ sharedSecret: `${SECRET}-other` }, issued.ticket, now),
    null,
  );
  assert.equal(await verifyRealtimeTicket(config, `${issued.ticket}.extra`, now), null);
  assert.equal(await verifyRealtimeTicket(config, "not-a-ticket", now), null);
  assert.equal(
    await verifyRealtimeTicket(config, issued.ticket, now - 5_001),
    null,
  );

  const nonCanonicalPayload = equivalentNonCanonicalBase64Url(payload);
  assert.deepEqual(
    Buffer.from(nonCanonicalPayload, "base64url"),
    Buffer.from(payload, "base64url"),
    "The hostile fixture must differ only in unused base64url pad bits.",
  );
  const validSignatureForNonCanonicalText = await signTicketPayload(nonCanonicalPayload);
  assert.equal(
    await verifyRealtimeTicket(
      config,
      `${nonCanonicalPayload}.${validSignatureForNonCanonicalText}`,
      now,
    ),
    null,
  );
});

test("notification signatures are deterministic, body-bound, and namespaced", async () => {
  const body = JSON.stringify({ v: 1, topics: ["chat", "game"] });
  const input = {
    room: "A".repeat(32),
    timestamp: 1_900_000_000_000,
    nonce: "B".repeat(22),
    body,
  } as const;
  const signature = await signRealtimeNotification(SECRET, input);
  assert.match(signature, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(await signRealtimeNotification(SECRET, input), signature);
  assert.notEqual(
    await signRealtimeNotification(SECRET, { ...input, room: "C".repeat(32) }),
    signature,
  );
  assert.notEqual(
    await signRealtimeNotification(SECRET, { ...input, timestamp: input.timestamp + 1 }),
    signature,
  );
  assert.notEqual(
    await signRealtimeNotification(SECRET, { ...input, nonce: "D".repeat(22) }),
    signature,
  );
  assert.notEqual(
    await signRealtimeNotification(SECRET, {
      ...input,
      body: JSON.stringify({ v: 1, topics: ["game"] }),
    }),
    signature,
  );
  assert.equal(body.includes(REALTIME_PROTOCOL), false);
});
