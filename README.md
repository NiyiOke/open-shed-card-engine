# Open Shed

Open Shed is an original, extensible multiplayer shedding-card game engine and responsive web client. The first rules profile implements the complete gameplay described by Mattel's *UNO Show 'Em No Mercy* instruction sheet, while keeping the code, visual system, and card presentation independently authored.

The project deliberately starts with the difficult foundation: server-authoritative rules, private hands, durable lobbies, cryptographically randomized production shuffles, reconnect-safe turns, and strict state projection. Rich card art, sound, chat, video, and alternate modes are future modules rather than assumptions baked into the engine.

## What works

- 2–6 player online lobbies with one-tap invitation URLs and shareable six-character codes
- ChatGPT sign-in on hosted Sites deployments and isolated local test identities in development
- A versioned 168-card physical deck manifest with unique card instances
- Match-by-color, number, or symbol and mandatory draw-until-playable flow
- Equal-or-higher draw stacking for +2, colored +4, reverse +4, +6, and +10
- Mercy knockout at 25 cards, including the eliminated-card reshuffle reserve
- Mandatory 0 hand rotation and 7 hand swap
- Skip, Reverse, Discard All, Skip Everyone, Wild Reverse Draw 4, Wild Draw 6, Wild Draw 10, and Wild Color Roulette
- Server-ordered UNO declaration and catch windows
- Empty-hand and last-player-standing victories
- Viewer-specific state: your hand and forced drawn card are returned only to you; opponent hands and draw order never leave the server
- Atomic optimistic writes, durable actor-scoped command receipts, append-only public events, bounded mutation quotas, expiry cleanup, and D1 persistence
- Responsive keyboard/touch UI, durable game deep links, a live public event feed, and deterministic `render_game_to_text` / `advanceTime` test hooks
- V1.1 game-night recovery: player presence, explicit connection state, reconnect-safe saved commands, contextual turn guidance, in-game rules, inactive-player grace handling, results, and same-room rematches

## Architecture

```text
Browser clients
  └─ viewer-safe JSON commands + adaptive polling
       └─ Vinext / Cloudflare Worker API
            ├─ trusted Sites identity headers
            ├─ pure versioned rules reducer
            ├─ per-viewer state projection
            └─ D1
                 ├─ authoritative game snapshots
                 ├─ profiles and memberships
                 ├─ public event audit records
                 ├─ durable command receipts
                 ├─ ephemeral player presence
                 └─ bounded mutation quotas
```

The domain engine in `lib/game/` imports no React, Vinext, Cloudflare, or database code. Transport and storage can evolve without rewriting game rules. A future real-time release can replace short polling with one Durable Object and hibernatable WebSocket room per game while preserving commands and `GameView`.

More detail is in [docs/architecture.md](docs/architecture.md). Ambiguous paper-rule decisions are pinned in [docs/rules-decisions.md](docs/rules-decisions.md) so running games remain replayable as the project evolves.

## Local development

Requirements:

- Node.js 22.13 or newer (22.14 is pinned in `.nvmrc`)
- npm

```bash
nvm use
npm install
npm run dev
```

Open `http://localhost:3000`. Local development uses project-local D1 state and a safe local test identity. Use **Switch test player** to simulate another browser participant.

Useful checks:

```bash
npm run test:unit
npm run typecheck
npm run lint
npm run build
npm run test:v11-browser
npm test
```

Schema changes:

```bash
npm run db:generate
```

Inspect every generated SQL migration before committing it. Sites applies committed migrations to the hosted D1 database.

## API shape

- `GET /api/session` — identity state
- `GET|POST /api/games` — lobby directory and creation
- `POST /api/games/join` — code-based join
- `GET /api/games/:gameId` — current viewer-safe snapshot
- `POST /api/games/:gameId/commands` — typed, versioned game mutation
- `GET|POST /api/games/:gameId/presence` — viewer-safe presence snapshot and authenticated heartbeat

Every command supplies a unique `commandId` and `expectedRevision`. Actor identity comes from Sites' trusted server headers, never from the command body. A self-hosted deployment must replace this Sites-specific identity adapter at its ingress boundary.

## Rules provenance

The primary behavior source is Mattel's [English instruction sheet HVW18](https://service.mattel.com/instruction_sheets/HVW18-Eng.pdf). It confirms 168 cards but does not print the per-card inventory. The exact manifest is independently corroborated from physical deck inventories and sums to the official total; that provenance distinction is retained in code comments, tests, and the rules decision record.

This repository contains no Mattel logos, commercial card artwork, manual scans, or copied visual trade dress. UNO and related names are trademarks of Mattel. Open Shed is an unofficial engineering project and is not affiliated with or endorsed by Mattel.

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md). Rule changes require a versioned profile, deterministic tests, and a migration/replay note when they affect persisted games. Security issues should follow [SECURITY.md](SECURITY.md).

Apache-2.0 licensed. See [LICENSE](LICENSE).
