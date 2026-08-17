# Open Shed realtime companion

This is a separate, default-off Cloudflare Worker with one hibernating Durable Object per opaque table room. It transports invalidation hints only. Open Shed Sites, its authenticated HTTP APIs, and D1 remain authoritative for game state, chat, membership, moderation, and presence. Polling remains mandatory for dropped hints, disabled rollout, network transitions, and Worker outages.

The companion never broadcasts cards, hands, chat text, raw game identifiers, player identifiers, names, profiles, membership, tickets, or opaque subjects. It is byte-compatible with [`lib/server/realtime-ticket.ts`](../lib/server/realtime-ticket.ts), [`lib/server/realtime-notify.ts`](../lib/server/realtime-notify.ts), and [`app/components/realtime-client.ts`](../app/components/realtime-client.ts).

## WebSocket contract

1. Sites authenticates the user, verifies current game membership, and issues a signed ticket from same-origin `POST /api/games/:gameId/realtime-ticket`.
2. The browser opens `wss://<worker>/socket/<opaque-room>/<ticket-expires-at>/<route-capability>` with exactly these two ordered WebSocket protocols:

```text
open-shed-realtime-v1
auth.<payload>.<signature>
```

3. Before resolving a Durable Object ID, the edge requires a real WebSocket upgrade, no query string, an exact allowlisted `Origin`, a protocol header of at most 1 KiB, exactly the two unique tokens above, a valid expiry-bound route capability, and a valid unexpired ticket bound to the route room and expiry.
4. The edge forwards only the verified claims—not the bearer ticket—to the room. The Durable Object atomically consumes the one-use ticket nonce and checks the room and per-subject quotas before accepting the server socket or returning HTTP 101.
5. The 101 response selects only `open-shed-realtime-v1`. No client data frame is required or supported. The Durable Object immediately sends `ready`; any later client data frame closes with 1008.
6. On every server hint the browser refetches the relevant authoritative Sites endpoint, and it keeps slow polling active while the socket is live.

The only server frames are:

```json
{"v":1,"type":"ready","heartbeatMs":25000}
{"v":1,"type":"invalidate","topics":["game"]}
{"v":1,"type":"invalidate","topics":["chat","game"]}
{"v":1,"type":"resync_required"}
```

Every protocol header, request body, and server frame is at most 1 KiB. There is no state, content, room, ticket, cursor, sequence, or identity field in a server frame.

## Exact ticket and route format

Ticket:

```text
base64url(UTF8(JSON claims)) + "." + base64url(HMAC-SHA256(secret, signingInput))
```

Signing input:

```text
open-shed-realtime-v1.<base64url claims>
```

Claims contain exactly:

```json
{
  "v": 1,
  "room": "<32 base64url characters>",
  "subject": "<32 base64url characters>",
  "nonce": "<22 base64url characters>",
  "issuedAt": 1800000000000,
  "expiresAt": 1800000030000,
  "leaseUntil": 1800000060000
}
```

- `room = base64url(first 24 bytes of HMAC-SHA256(secret, "open-shed-realtime-v1.room." + gameId))`.
- `subject = base64url(first 24 bytes of HMAC-SHA256(secret, "open-shed-realtime-v1.subject." + stableAuthSubject))`.
- `nonce` is 16 cryptographically random bytes encoded as base64url.
- `expiresAt = issuedAt + 30000`; `leaseUntil = issuedAt + 60000`.
- `routeCapability = base64url(first 16 bytes of HMAC-SHA256(secret, "open-shed-realtime-v1.route." + room + "." + expiresAt))`.
- The edge accepts a route expiry only from five seconds in the past through 35 seconds in the future and verifies the capability before Durable Object selection.
- The Durable Object stores a SHA-256 hash of the ticket nonce until ticket expiry. Replays are rejected before upgrade with HTTP 409, including after hibernation or restart.
- `subject` exists only in the serialized ready-socket attachment for the hibernation-safe quota. It is never logged, returned, or broadcast.
- The shared secret must be 32–256 UTF-8 bytes without control characters and must never reach browser code.

The ticket is necessarily present transiently in the request's `Sec-WebSocket-Protocol` header so the upgrade can be authenticated before a room exists. TLS protects it in transit and its 30-second one-use lifetime limits exposure. Worker observability, logs, and traces are explicitly disabled in `wrangler.jsonc`. Do not log request headers, enable request logging, configure `Sec-WebSocket-Protocol` as a custom Logpush field, or include headers in error reporting. A deployment review must inspect `wrangler tail`/Logpush configuration with a canary ticket before enabling production traffic. The 101 response must echo only the base protocol, and the browser must verify `socket.protocol` equals it.

## Exact post-commit notification

After and only after a D1 transaction commits, Sites sends:

```http
POST /notify/<opaque-room>
Content-Type: application/json
Open-Shed-Realtime-Signature: <base64url HMAC-SHA256 signature>
Open-Shed-Realtime-Timestamp: <13-digit Unix milliseconds>
Open-Shed-Realtime-Nonce: <22 base64url characters / 16 random bytes>

{"v":1,"topics":["chat","game"]}
```

Topics are one or two unique alphabetically sorted values from `chat` and `game`. The signing input is:

```text
open-shed-realtime-v1.notify.<opaque-room>.<timestamp>.<nonce>.<exact request body bytes>
```

The edge requires a valid `Content-Length` and returns HTTP 411 before reading a chunked or otherwise lengthless request. It rejects a declared length above 1024 bytes before reading and also bounds the body reader to 1024 bytes to fail closed on any ingress mismatch. If a mismatched stream exceeds the declared limit, the reader drains and discards the remainder before returning HTTP 413; application memory remains bounded. The edge then accepts timestamps from 30 seconds in the past through five seconds in the future and verifies the room/time/nonce/body-bound signature before Durable Object selection. The room persistently consumes a hash of every notification nonce for 35 seconds before rate limiting or broadcasting. An exact replay returns HTTP 409 and cannot broadcast twice.

Delivery is best-effort: a D1 commit and Worker request cannot be one atomic transaction. Periodic authoritative polling is the recovery path.

## Quotas, hibernation, and close behavior

- 64 ready sockets per room by default, hard capped at 256.
- At most three ready sockets may share an opaque subject in a room. The configuration may lower but never raise this limit. A fourth is rejected before upgrade with HTTP 429.
- 20 notifications per second per room by default. Excess traffic sends one `resync_required` and returns HTTP 429.
- Above half the 64 KiB buffer limit, a socket receives `resync_required` and closes with 1013; a socket already beyond the limit closes immediately.
- 1008 means unsupported client data; 1011 means invalid server state/send failure; 1013 means reconnect and use polling; 4000 means the authorization lease expired.
- One-use ticket and notification nonces survive Durable Object hibernation in SQLite storage. Opaque subjects and lease deadlines survive in serialized ready-socket attachments. There is no unauthenticated or pending socket state.

## Local verification

Use Node 24 with the nested pinned dependencies:

```bash
cd realtime-worker
cp dev.vars.example .dev.vars
npm run typecheck
npm test
npm run check
npm run dev
```

`npm test` includes cross-service signing compatibility, strict protocol parsing, route and notification edge authorization, body-stream limits, privacy, and hard configuration caps. `npm run check` also makes development and production Wrangler dry-run bundles in the root ignored `dist/` directory; it does not deploy.

## Production rollout

This directory has no credentials. Development leaves `OPEN_SHED_REALTIME_ENABLED` absent, while the production environment opts in explicitly; either environment still fails closed until the shared production secret is installed. Sites has its own independent exact-`true` switch and remains on polling until that switch is enabled.

Infrastructure still required:

- Cloudflare account authentication and account selection for Wrangler.
- A final Worker hostname or custom domain for Sites `OPEN_SHED_REALTIME_URL`.
- One independent random `OPEN_SHED_REALTIME_SHARED_SECRET`, configured identically in Sites and the Worker.
- The exact production Sites origin in `ALLOWED_ORIGINS` (the current Sites origin is preconfigured).
- Explicit review that Worker observability remains off and no account-level/custom HTTP logs capture `Sec-WebSocket-Protocol`.

Recommended rollout:

1. Run `npm run check`, the root suite, and the real workerd/Chromium WebSocket acceptance harness.
2. Authenticate Wrangler, run `wrangler deploy --dry-run --env production`, and inspect the `v1` SQLite Durable Object migration and disabled observability settings.
3. Deploy the production Worker before installing its shared secret. Although the production switch is explicit, the missing secret keeps its transport fail-closed.
4. Generate one independent random secret, install it with `wrangler secret put OPEN_SHED_REALTIME_SHARED_SECRET --env production`, and configure the identical value plus the Worker URL in Sites while leaving the Sites `OPEN_SHED_REALTIME_ENABLED` switch off. Never put the secret in source or `wrangler.jsonc`.
5. Deploy the Sites release with realtime still off, then inspect a direct canary upgrade and Cloudflare logging configuration to prove the auth protocol token is absent from logs.
6. Enable the Sites switch for the staged rollout while monitoring rejection rates, 1011/1013 closes, reconnects, and authoritative refetch latency.
7. Retain polling permanently as the rollback and missed-hint recovery path; disabling the Sites switch requires no Worker or database rollback.

The `v1` migration creates `RealtimeRoom` as a SQLite-backed Durable Object class. Durable Object migrations cannot be rolled back; retain the class and use forward migrations.
