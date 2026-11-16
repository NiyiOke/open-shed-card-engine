# Session 3 — the server-side Coach adapter

This package contains **runnable Responses API request/response adapter code**, adapted from the existing Hub server and pinned by source hashes. All packaged commands use a **scripted mock transport**. They do not contact OpenAI, load a key, generate a model answer, spend money or change a game.

A real smoke test is a separate trainer-led observation of the existing **owner-only hosted Coach**. The owner keeps their already-approved server-side key and shared £10 campaign controls. Learners do not receive the key or gain paid access through this ZIP. No live smoke test is claimed by this package.

## Start here

Your trainer prepares Node **22.14.0** and editor access. Extract this ZIP into your own working folder, then open a terminal there. Do **not** run npm/pnpm install: there are no runtime dependencies.

Run these separately:

```sh
node --version
node scripts/check-setup.mjs
node --import ./scripts/offline-guard.mjs --test "test/*.test.mjs"
node --import ./scripts/offline-guard.mjs scripts/demo.mjs
node --import ./scripts/offline-guard.mjs --test practice/accept-answer.test.mjs
```

Expected starter evidence: Node `v22.14.0`; setup `ready: true`; **26 core tests pass**; the mock demonstration prints valid, one-correction and exhausted-stop cases; the separate practice suite has **9 tests, 3 pass and 6 intentionally fail**. Save the real failing output before editing. If core tests fail, stop and ask your trainer; do not remove assertions or limits.

The supplied core adapter remains strict. The deliberate learner bug is isolated in `practice/accept-answer.mjs` and is not used by the adapter. Follow `LEARNER.md`, change only that file, and obtain **9 practice tests passing** without changing tests. Then rerun the 26 core tests.

## What the code actually does

| File | Responsibility |
| --- | --- |
| `src/scenarios.mjs` | Six frozen invented scenarios and versioned public rules; no real player data |
| `src/provider.mjs` | Fixed request/schema, explicitly injected transport, one dispatch, byte/deadline limits, validated response |
| `src/scripted.mjs` | In-memory fake HTTP responses and a separate mock-only two-attempt correction exercise |
| `scripts/offline-guard.mjs` | Makes accidental global `fetch` fail in normal teaching commands |
| `practice/` | Separate broken acceptance helper and its visible tests |
| `LIVE-OBSERVATION.md` | Separate controlled hosted demonstration and an honest evidence template |
| `source-manifest.json` | SHA-256 pins for three actual Hub source files and documented adaptations |

The model request uses `text.format` with strict JSON Schema. The application then checks completion, exact model, usage bounds, one text response, exact fields, permitted citation/card and explanation length. It rejects refusals, incomplete responses, extra action fields and unexpected tool output. It cannot prove arbitrary prose is true: one core test deliberately shows false prose passing structural checks so that this limitation remains visible.

## Boundaries to explain in your submission

- The adapter has a fixed Responses endpoint and model snapshot; no caller-supplied URL/model/prompt, tools, response chaining, automatic retries or move execution. It permits six named synthetic scenarios only.
- Input is at most 6,000 bytes; response is at most 32,000 bytes; output allowance is 400 tokens; deadline is at most 20 seconds. Mock tests lower deadlines to milliseconds. These are code checks, not claims about live provider latency, cancellation or billing.
- Every command requires the scripted transport or the offline guard. The adapter never reads `OPENAI_API_KEY` or another environment key and has no default network transport. The guard is not an OS sandbox against someone rewriting files.
- Mock envelopes contain invented `500`/`70` usage fields to test validation; actual usage is `null` and provider requests sent is `0`. Do not report these numbers as measured tokens or cost.
- Local scripted correction can inspect a second canned candidate, then stops. The existing hosted Coach makes **one** paid dispatch per admitted request, with no automatic correction or retry. A timeout does not establish that the provider did no work or charged nothing.
- Hosted authentication, the shared budget reservation, audit history and persistence remain in the Hub. Copying this module into a new endpoint would not preserve those controls. Do not create that endpoint or add a key-loader as this exercise.

This package does not provide learner API provisioning, actual model observations, cloud deployment, production testing, a PR, a grade, or Windows/browser verification. Your trainer allocates the focused contribution task; assessed learner work and acceptance into the shared product remain separate decisions.
