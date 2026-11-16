# Session 3 learner route

Outcome: explain and test the boundary between untrusted model text and an accepted, reviewable answer. Read `README.md` and keep the local mock evidence separate from any supervised real observation.

## 45-minute taught lesson

1. **0–8 minutes:** run setup and the 26 core tests. Identify the browser, trusted server, transport and validator. No key belongs in browser code or this repository.
2. **8–18 minutes:** trace `coachProviderBody('players')`. The application supplies the scenario, exact public rules and permitted synthetic card. Identify the fixed model, `store: false`, JSON Schema and absence of tools.
3. **18–28 minutes:** trace a scripted response through `requestCoach` and `parseCoachResponse`. A successful HTTP response is not yet an accepted answer. Examine malformed JSON, an invented card and a refusal.
4. **28–36 minutes:** run the demonstration. Explain why one mock correction is finite and why the hosted path does not automatically retry a paid or uncertain request.
5. **36–45 minutes:** compare structural validity with factual accuracy. If the owner is available, observe the separately authorised hosted demonstration in `LIVE-OBSERVATION.md`. If not, mark it pending; do not invent observations.

## 60–90-minute supervised practice

**Observe (10–15 minutes).** Run the separate practice command from README. Record the actual command and expected 3-pass/6-fail output. The bug accepts any parsed object containing a text explanation, including invented cards and extra action fields.

**Repair (20–30 minutes).** Change only `practice/accept-answer.mjs`. Its `acceptAnswer(text, scenarioId)` returns a boolean; it must not send a request, modify a game or throw on malformed input.

Requirements:

- The scenario ID must exist in the public `COACH_SCENARIOS` list.
- Parse the supplied JSON text safely. Require an object, not null or an array.
- Require exactly `kind`, `ruleId`, `cardId`, `explanation`; reject missing or extra properties.
- Match `kind` and `ruleId` to the named scenario. Only `suggest` permits `practice-red-3`; every other scenario requires `cardId: null`.
- Require a string explanation of 10–1,200 characters. This checks size, not whether its words are true.

Suggested AI-assistant request:

```text
Read README.md, LEARNER.md and the two practice/accept-answer files.
Explain the failing tests, then change only practice/accept-answer.mjs.
Use the supplied public scenario contract. Do not change tests or core
code, install dependencies, access the network, read trainer-private
files, use credentials, commit, push or edit another package.
Run the practice and core commands and explain the evidence honestly.
```

**Verify (10–15 minutes).** Run the same practice command: expected 9/9 passing. Rerun all 26 core tests and the mock demonstration. Explain one rejected case and why the adapter still needs human source review. The public core validator is a readable worked example; understanding and explaining your own change matters more than copying it.

**Review and record (20–30 minutes).** Review your small diff with your trainer and follow the course's approved branch/PR workflow in your own connected workspace. Do not copy `_trainer`, private live observations, keys, local output or other learners' work into Git. This ZIP itself does not push, connect a repository, create Hub evidence or submit your declaration. The published Hub milestone remains authoritative for exact required evidence fields.

Record:

| Evidence | What to preserve |
| --- | --- |
| Provenance | Edition, source-manifest SHA pins, Node version and actual run date |
| Baseline | Original practice failure and passing supplied core suite |
| Focused change | Exact changed file and your explanation of the acceptance boundary |
| Verification | Actual practice/core output and valid/corrected/stopped mock traces |
| Real demonstration | Separately labelled owner-led observation, or explicitly pending |
| Explanation | Why no key/client authority/action/retry was added; what mocks do not prove |

The mock checks do not satisfy the separate real-model smoke requirement. If you only observe an owner demonstration, label yourself an observer; do not claim that you personally called a model or deployed this adapter.
