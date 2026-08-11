# Security policy

Please do not open a public issue for a vulnerability that could expose identities,
private hands, draw order, authentication material, cross-game data, moderation
evidence, or unauthorized game control.

Use the repository's [private security advisory form](https://github.com/NiyiOke/open-shed-card-engine/security/advisories/new)
when available. Include the affected revision, reproduction steps, impact, and a
minimal proof of concept. Do not include real player data, table links, or chat.

Ordinary gameplay, display, connection, and accessibility problems can use the
in-game **Report issue** flow. It creates an editable public draft and deliberately
omits table identifiers, player names, hands, chat, and account data.

The supported security surface is the latest `main` branch and current hosted
release. Maintainers will acknowledge a complete report as soon as practical,
validate severity, coordinate a fix, and credit reporters who want attribution.

Important invariants:

- hosted identity comes only from Sites-injected server headers; self-hosters must
  replace that adapter with verified identity;
- every mutation checks membership, phase, turn, and game revision;
- the server creates viewer-specific projections;
- opponent hands, draw order, RNG state, and auth subjects do not enter client
  payloads or public logs;
- game commands are durably idempotent, related snapshot/event writes are atomic,
  cross-origin mutations are rejected, and authenticated mutation quotas bound abuse.
