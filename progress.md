Original prompt: Build the extensible foundation for a cross-platform online multiplayer UNO No Mercy-style web game, based on Mattel instruction sheet HVW18, with sign-in, lobbies, complete game logic and durable data; defer rich graphics, sound, video, and chat; publish the site and create a GitHub repository for future contributors.

## Work log

- Initialized the Sites starter and started the local preview.
- Selected a server-authoritative, persistence-backed multiplayer baseline; implementation and rule verification are in progress.
- Added the versioned 168-card manifest, Web Crypto production shuffle with deterministic test fixtures, isolated rules reducer, viewer-safe projection, UNO reaction model, stacking, Mercy, 0/7, every action card, draw recycling, and card-conservation invariants.
- Expanded the automated suite to 35 passing engine and server-guard scenarios. It caught and drove fixes for UNO windows reopening, forced-card privacy, final-effect precedence, roulette exhaustion, departure transients, body limits, and cross-site mutation rejection.
- Added D1-backed profiles, games, memberships, and append-only public event records; generated and inspected the first migration.
- Added authenticated JSON APIs for session, private lobby listing/creation/joining, private game views, bounded event feeds, and versioned durable-idempotent commands. A local two-player create/join/ready/start smoke test passed with opponent hands and draw order redacted.
- Production build passes with all API routes detected.
- Added the responsive lobby/table/hand client, durable game URLs, adaptive reconnect polling, public remote-event updates, success-only leave flow, deterministic browser hooks, and keyboard-accessible card-choice dialogs.
- Hardened the baseline with cryptographic production shuffles, private forced-card projection, atomic persistence design, durable receipts, quotas, lazy retention cleanup, and dependency updates with zero production audit findings.
- Re-ran a real local D1 two-player API flow: create/join/ready/start, private projections, event cursors, durable create/start/leave replays, stale revision rejection, solo and mid-game leave, departed-member access denial, private lobby listing, and streamed oversize rejection all passed.
- Re-ran desktop and 320px browser regressions plus the required gameplay client; deep links, live remote events, ID-based turns, dialog focus/Escape, mobile controls, canvas state, and console checks passed.

## TODO

- Add Durable Object/WebSocket transport when the hosting contract supports it; keep the current command and projection boundary.
- Add provider-backed chat/media only as separately moderated modules, plus deeper automated D1 concurrency and migration integration coverage.

## Pinned baseline rule decisions

- Exact per-card quantities are independently corroborated because Mattel's sheet states 168 cards but does not print the manifest.
- A final card wins before external 0/7/draw effects; Discard All's same-color removals are part of that final play.
- Mercy fires immediately on card 25 for ordinary draws and penalties; roulette adds its revealed batch before checking Mercy.
- Wild +4 reverse, +6, and +10 use the actor's chosen continuing color; roulette uses the target's choice.
- A missing roulette color drains all currently recyclable cards and ends safely rather than looping.
