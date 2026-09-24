## What changed

Describe the problem and the approach taken. Link the related issue with `Closes #…` when applicable.

## How to test

List the checks you ran and any manual steps reviewers should repeat.

## Player impact

Describe any visible behavior, compatibility, privacy, accessibility, or performance impact. Write `None` when there is none.

## Contributor checklist

- [ ] I kept this pull request focused and documented any user-facing behavior changes.
- [ ] I added or updated tests where the behavior can be tested automatically.
- [ ] I ran the relevant checks (`npm run test:unit`, `npm run typecheck`, `npm run lint`, `npm run build`, and `npm run test:performance`).
- [ ] For UI changes, I checked keyboard and touch use, visible focus, reduced motion, and a 320px-wide layout.
- [ ] For rules changes, I added an immutable rules version plus deterministic transition and rejection tests.
- [ ] For database changes, I generated and inspected the migration and kept the local runtime schema aligned.
- [ ] For realtime Worker changes, I ran `npm run check --prefix realtime-worker`.
- [ ] I did not include live table codes or join links, player identities, private hands, chat content, authentication data, secrets, or sensitive logs in code, fixtures, screenshots, or descriptions.
- [ ] I have the right to submit these changes and understand that my contribution is offered under the repository's Apache-2.0 license.

## Screenshots or recordings

Add these only when they help explain a visual change. Use synthetic test data and redact private game information before uploading.

## Maintainer review

Opening a pull request does not merge or deploy it automatically. A maintainer must approve it, all required checks must pass, and review conversations must be resolved before merge.
