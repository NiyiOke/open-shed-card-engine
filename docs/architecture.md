# Architecture

## Product boundary

Open Shed is a turn-based multiplayer foundation. The first release optimizes for correctness, privacy, portability, and recoverability. It does not attempt sub-second action broadcasting, turn timers, chat, media calls, or rich commercial card art.

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

The browser adaptively polls every 1.5 seconds while visible and backs off while hidden. It refreshes on focus, reconnect, and visibility changes, aborts stale-room requests, and keeps the active game in a durable URL. Mutation responses contain the new projection, avoiding a redundant immediate read. Stale commands receive a conflict and trigger resynchronization.

Short polling is intentional because the Sites binding contract currently exposes D1 and R2, not Durable Objects. Stateless Worker memory is never used as room authority.

## Growth path

The stable seams are the command union, rules profile, `GameState`, event bundle, viewer projection, and repository boundary.

- Real-time updates: move per-game coordination to Durable Objects and broadcast the same public events over hibernatable WebSockets.
- Chat: add a separate moderated bounded context; do not mix messages into authoritative rules state.
- Sound: map public event kinds to optional client audio cues.
- Video/voice: add WebRTC signaling, STUN/TURN, consent, block/report controls, and a specialist provider.
- New modes: add a new rules profile and card manifest; never mutate the meaning of an in-progress game's pinned version.
- Replays: retain private command payloads in an access-controlled audit store and verify hashes against snapshots.

## Known baseline limits

- Polling increases read volume with audience size.
- D1 serializes writes at its primary; globally distributed competitive play will eventually benefit from one Durable Object per room.
- No scheduler binding means expiry cleanup is bounded and lazy during normal requests.
- Hosted identity currently means a user able to complete ChatGPT sign-in; generic email/social identity is abstracted but not implemented.
- Trusted identity headers are a Sites ingress contract; self-hosters must replace that adapter with verified sessions or tokens.
- The public event record is intentionally minimal and is not yet a complete private replay log.
