# Source provenance and deliberate differences

`source-manifest.json` pins three current Hub files by exact SHA-256, not merely by a potentially dirty Git HEAD. The request builder and parser come from `lib/server/coach-provider.ts`; the six invented scenarios and public rules come from `lib/course/coach-pilot.ts`. `lib/server/live-coach.ts` was inspected to preserve the boundary, not copied into this package.

The existing hosted flow authenticates the signed-in actor, performs the owner-only database admission/reservation, sends at most one request, validates the result and finishes the persisted attempt. Repeated admission for the same request ID does not dispatch again. The separate database migration `20260928185548_open_shed_coach_budget.sql` owns the £10 lifetime cap, prior spend, voice hold, 2p reservation, current-pricing check and ten-second spacing. No part of this package changes or substitutes for that database policy.

The public adaptation removes framework imports and TypeScript types, freezes scenario definitions, resolves scenario IDs internally, requires an injected transport and never loads a credential. It also rejects unexpected extra provider output items and explicitly cancels a body reader on deadline; a lowered test deadline is permitted but cannot exceed the original 20-second bound. These are local teaching-copy differences, **not claims that the hosted implementation has changed**.

The existing hosted one-dispatch policy is unchanged. `runScriptedCorrection` is a separate two-candidate mock demonstration; it cannot accept a network transport or key. A valid second scripted answer is not a successful provider retry.

Official API reference checked on 29 September 2026: [Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs). The Responses API uses `text.format` for JSON Schema output; strict schema configuration does not remove the need to handle refusal or incomplete responses. Semantic correctness and permitted actions remain application/human responsibilities. The package retains the existing model snapshot, not a recommendation to change models or pricing.

Upstream game/rules identity: Open Shed commit `f20a5c15bfb2b1aa943f61f8b17bcbd27f185c40`, `merciless-baseline-v1`. The excerpts are intentionally small; this is not a complete game engine or rule book. No player names, join codes, private hands, opponent cards, chats or draw order are included.
