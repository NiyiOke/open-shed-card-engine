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
- Selected the layered Option 1 card direction and began the implementation: added an exhaustive card-presentation model, a reusable semantic DOM card face, Phosphor action icons, a generated charcoal material texture, and shared hand/table card rendering without changing rules logic.
- Finished Option 1 card QA: corrected the initial dense overlap, verified live remote turns, playable/focus cues, wild-choice focus restoration, a 320px horizontally scrollable hand, and a clean fresh-tab console. The design comparison passes with no P0/P1/P2 findings; 47 unit tests, typecheck, lint, production build, and the production dependency audit pass.
- Replaced the unsupported local-development `window.prompt()` identity switcher with an in-page modal: labelled form, trimmed 28-character names, inline empty-name errors, one-shot identity writes, initial input focus, trapped Tab navigation, Escape/Cancel focus restoration, and inert background content.
- Verified the test-player switch end to end in isolated and live browser sessions: no native JS dialog, one DOM dialog, whitespace validation, forward/backward focus trap, Escape/Cancel restoration, successful identity save + reload, usable 320×900 layout, matching `render_game_to_text`, and zero page/console errors. All 47 unit tests, TypeScript, scoped lint, diff checks, and the production build pass (build requires the bundled modern Node runtime; the shell default Node 20 lacks `fs.promises.glob`).
- Rebuilt the signed-out experience as a player-facing front door: a restrained Option 1 card fan, direct sign-in and rules paths, share-link-safe authentication return targets, quick facts, complete turn flow, power rules, illustrated colored/wild action references, pinned online edge-case decisions, and an official-source/unofficial-project disclaimer. The responsive implementation uses semantic sections, native keyboard-operable disclosures, and the real in-game `CardFace` system rather than decorative stand-ins; TypeScript and scoped lint pass.
- Finished signed-out landing QA in a true production-mode unauthenticated session. At 1903×914 and 320×900, the hero, rules anchors, 2×2 mobile card stage, action-card guide, final CTA, and footer have no horizontal overflow; shared-room sign-in preserves the deep link; all 10 action types and pinned UNO/Mercy/Roulette/final-card decisions were independently copy-checked. The required game client reports `mode: signed-out` with no console errors. All 47 unit tests, full lint/typecheck, the final production build, and the production dependency audit pass.

## TODO

- Add Durable Object/WebSocket transport when the hosting contract supports it; keep the current command and projection boundary.
- Add provider-backed chat/media only as separately moderated modules, plus deeper automated D1 concurrency and migration integration coverage.

## Pinned baseline rule decisions

- Exact per-card quantities are independently corroborated because Mattel's sheet states 168 cards but does not print the manifest.
- A final card wins before external 0/7/draw effects; Discard All's same-color removals are part of that final play.
- Mercy fires immediately on card 25 for ordinary draws and penalties; roulette adds its revealed batch before checking Mercy.
- Wild +4 reverse, +6, and +10 use the actor's chosen continuing color; roulette uses the target's choice.
- A missing roulette color drains all currently recyclable cards and ends safely rather than looping.
