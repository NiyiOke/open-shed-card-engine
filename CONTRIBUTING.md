# Contributing

Thanks for helping Open Shed grow from a reliable rules engine into a broader multiplayer platform.

## Before opening a pull request

1. Open or reference an issue for rule changes, persistent data changes, identity, chat, media, moderation, or transport changes.
2. Keep commercial logos, card artwork, rulebook scans, and copied trade dress out of the repository.
3. Branch from `main` and keep the change focused.
4. Run:

   ```bash
   npm install
   npm run test:unit
   npm run typecheck
   npm run lint
   npm run build
   ```

5. Explain what changed, why, the impact on players or contributors, and how it was verified.

## Engine changes

Rules code must remain independent of React, Vinext, Cloudflare, and D1. Every accepted command must preserve physical-card conservation and keep other players' private state out of projections. Rule tests inject deterministic shuffle fixtures; production randomness stays confined to the explicit shuffle boundary.

A behavioral rules change must:

- create a new immutable rules version rather than changing old game meaning;
- add deterministic transition and rejection tests;
- document effect ordering in `docs/rules-decisions.md`;
- describe replay and migration implications.

## Database changes

Edit `db/schema.ts`, run `npm run db:generate`, inspect the generated SQL, and keep `db/runtime.ts` aligned for local initialization. Never add secrets, real user emails, or private hands to logs/events.

## UI changes

Support keyboard and touch, 320px-wide mobile layouts, reduced motion, visible focus, and text labels in addition to color. Keep `window.render_game_to_text` synchronized with the visible interactive state.

## Conduct

Be respectful, specific, and curious. Harassment, discrimination, deliberate privacy violations, and hostile use of contributor or player data are not accepted. Maintainers may remove content or participation that puts people or the project at risk.
