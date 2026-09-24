# Architecture

## Product boundary

Open Shed is a turn-based multiplayer foundation optimized for correctness, privacy, portability, and recoverability. It supports moderated table communication and optional realtime refresh signals without moving rules, private projections, or durable writes into the transport layer. Turn timers, stored media, and rich commercial card art remain outside the current boundary.

## Authoritative command path

1. The browser authenticates through Sites and sends a typed command with a unique command ID and expected game revision.
2. The API derives the actor from trusted request headers and rejects cross-origin mutations.
3. D1 returns the current private snapshot.
4. The pure reducer validates phase, turn ownership, card ownership, choices, and the pinned rules profile.
5. Global invariants verify card conservation, unique physical IDs, a valid active turn, and the Mercy threshold.
6. A single guarded D1 batch writes the command receipt, public event, membership metadata, and snapshot only when the stored revision and hash still match.
7. The server returns a projection built specifically for the requesting player; polling can request bounded public events after its last revision.

The client never submits an actor ID, decides whether a card is legal, sees another hand, or receives the shuffled draw order.

## Durable model

- `profiles` maps a Sites-local authentication subject to a public profile and nickname. Email is not stored.
- `games` holds the current authoritative snapshot, revision, hash, rules/protocol versions, status, and expiry.
- `game_members` provides membership lookup and stable seats.
- `game_events` records one public event bundle and resulting state hash per accepted revision.
- `command_receipts` makes create, join, and gameplay mutations durably idempotent for each actor.
- `game_presence` stores each active member's last server-observed heartbeat without mixing transient connectivity into rules state.
- `mutation_quotas` bounds authenticated create/join/command churn in fixed, expiring windows.

Local runtime initialization is idempotent and mirrors the generated Drizzle migrations. Hosted deployments use the migrations under `drizzle/` and the logical `DB` binding in `.openai/hosting.json`. Normal requests perform bounded lazy deletion of expired games, related audit rows, receipts, memberships, and quota buckets.

## Rules boundary

`lib/game/engine.ts` is isolated from React, transport, and storage. Conformance tests inject a numeric shuffle fixture; production games use Web Crypto at the explicit shuffle boundary and never derive deck order from public room identifiers. The engine owns:

- deck setup and physical card movement
- legal matching and forced draw
- effect ordering
- turn navigation through active seats
- penalties, stacking, UNO liabilities, and Mercy
- terminal victory

`lib/game/projection.ts` is the privacy boundary. It returns the requesting player's hand and legal actions, opponent card counts, public table state, and no hidden draw/RNG data.

## Synchronization baseline

The browser always retains authoritative HTTP synchronization. Without realtime it adaptively polls every 1.5 seconds while a visible round is active, uses a low-rate five-second poll on complete tables, and backs off while hidden. It refreshes on focus, reconnect, and visibility changes, aborts stale-room requests, and keeps the active game in a durable URL. A single in-flight mutation envelope is stored in the browser session and retried with the same command ID after a lost response. Mutation responses contain the new projection; stale commands receive a conflict and trigger resynchronization.

When explicitly enabled, a separate hibernating Durable Object companion sends only content-free `game`/`chat` invalidation hints over WebSockets. Every hint triggers the same authenticated Sites read used by polling; the socket never carries a `GameView`, event, message, cursor, name, identifier, or mutation. A `ready` connection becomes live only after its authoritative catch-up succeeds. Duplicate hints are coalesced, an invalidation during an in-flight read queues a trailing refresh, and low-rate 25–30 second polling remains active to recover a missed hint. A failed handshake, closed Worker, offline transition, or kill switch immediately restores the original polling cadence.

Presence uses a separate heartbeat path and server clock: players progress from live to reconnecting to disconnected, while host removal is unavailable until the server revalidates a two-minute inactive grace period. Completed tables continue low-rate heartbeats so a waiting player can observe a rematch without being falsely classified as removable.

Sites and D1 remain authoritative because the Sites binding contract exposes D1/R2 but not Durable Objects. The realtime coordinator is therefore a separately deployed companion with an opaque room namespace; stateless Worker memory and the companion's Durable Object state are never game authority.

## Growth path

The stable seams are the command union, rules profile, `GameState`, event bundle, viewer projection, and repository boundary.

- Real-time updates: retain notification-only hibernating Durable Objects, viewer-specific Sites refetches, bounded one-use tickets, and permanent HTTP recovery; never widen sockets into a second rules or chat authority.
- Communication: keep curated/public chat, private text, reports, and voice authorization in separate moderated boundaries; never mix them into authoritative rules state.
- Sound: map public event kinds to optional client audio cues.
- Live voice: the provider-neutral LiveKit adapter supplies managed WebRTC signaling/TURN, explicit consent, listen-only join, microphone-only grants, and lifecycle revocation; keep it independently disabled until provider credentials and operational safety gates are configured.
- Voice notes/video: require separate private media storage/lifecycle or a specialist provider, with explicit retention, consent, block/report, and moderation controls.
- New modes: add a new rules profile and card manifest; never mutate the meaning of an in-progress game's pinned version.
- Replays: retain private command payloads in an access-controlled audit store and verify hashes against snapshots.

## Known baseline limits

- Safety polling and invalidation-triggered refetches still increase read volume with audience size.
- D1 serializes authoritative writes at its primary; the current room Durable Object accelerates notification only and does not change write locality.
- No scheduler binding means expiry cleanup is bounded and lazy during normal requests.
- Hosted identity currently means a user able to complete ChatGPT sign-in; generic email/social identity is abstracted but not implemented.
- Trusted identity headers are a Sites ingress contract; self-hosters must replace that adapter with verified sessions or tokens.
- The public event record is intentionally minimal and is not yet a complete private replay log.
