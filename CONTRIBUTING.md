# Contributing

Thanks for helping Open Shed grow from a reliable rules engine into a broader multiplayer platform.

## Contribution workflow

1. Fork the repository and branch from the latest `main`.
2. Open or reference an issue before substantial work on rules, persistent data,
   identity, chat, media, moderation, or transport.
3. Keep the change focused and avoid mixing unrelated refactors into the same pull request.
4. Open a pull request using the repository template and respond to review feedback.

Pull requests are merged only after required checks pass and a maintainer approves
them; maintainers may request changes or decline work that conflicts with the
project's rules, privacy, accessibility, security, or scope. Contributors cannot
deploy the hosted game or publish releases.

## Before opening a pull request

1. Keep commercial logos, card artwork, rulebook scans, copied trade dress, secrets,
   and private player data out of the repository.
2. Run:

   ```bash
   npm ci
   npm run test:unit
   npm run typecheck
   npm run lint
   npm run build
   npm run test:performance
   ```

3. For realtime Worker changes, also run:

   ```bash
   npm ci --prefix realtime-worker
   npm run check --prefix realtime-worker
   ```

4. Explain what changed, why, the impact on players or contributors, and how it was verified.

Use invented test data in issues and pull requests. Never publish a live table URL,
code or identifier; a player name, hand, or chat message; account data; authentication
material; or a production log containing any of those. Report security problems using
the private process in [SECURITY.md](SECURITY.md).

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

Be respectful, specific, and curious. Harassment, discrimination, deliberate privacy violations, and hostile use of contributor or player data are not accepted. Maintainers may remove content or participation that puts people or the project at risk. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for the full policy.

## Contribution license

By submitting a contribution, you confirm that you have the right to submit it and
agree that it is licensed under the repository's Apache License 2.0, as described in
section 5 of that license.
