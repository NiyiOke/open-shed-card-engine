# Private table communication

Open Shed treats an invite-only table as an access boundary, not as an
unmoderated social network. Public/open tables stay on curated phrases and
reactions. Richer communication is available only while a table has never been
public and every active member entered as the host or through a private invite.

## Rollout switches

Every capability fails closed and requires the exact string `true`.

```text
OPEN_SHED_V15_COMMUNICATION_ENABLED=true
OPEN_SHED_V15_FREE_TEXT_ENABLED=true
OPEN_SHED_V15_LIVE_VOICE_ENABLED=true
```

Free text additionally depends on the server-owned room scope. The first public
listing irreversibly changes that scope to `public_safe`; unlisting later does
not restore private text or voice. Existing public-sourced rooms are migrated to
`public_safe`.

Live voice additionally requires all three provider values:

```text
OPEN_SHED_LIVEKIT_URL=wss://<project>.livekit.cloud
OPEN_SHED_LIVEKIT_API_KEY=<server-only key>
OPEN_SHED_LIVEKIT_API_SECRET=<server-only secret>
```

The API key and secret belong in the hosted environment only. Never commit them
to `.env`, `.dev.vars`, fixtures, browser code, screenshots, or issue reports.
With missing/invalid credentials the voice endpoint returns
`LIVE_VOICE_UNAVAILABLE` and the UI remains fail-closed.

## Bounded natural text

- Plain text only, 160 graphemes after NFKC normalization.
- Hidden controls, bidi overrides, links, email, phone numbers, social handles,
  and common contact-exchange patterns are rejected server-side.
- Sender identity is derived from authenticated membership; clients cannot
  provide a sender or room identity.
- Existing two-second cooldown, user/room quotas, durable idempotency, mute,
  bilateral block, report, and 24-hour expiry continue to apply.
- Reports snapshot the exact normalized message in a restricted 90-day evidence
  row. A player who leaves may report an exact message they previously received
  for the remainder of its 24-hour lifetime, without regaining feed access.
- Text never enters `GameState`, game revisions/events, analytics, or general
  application logs.

## Live voice

The app integrates LiveKit through a provider-neutral controller and a
server-issued, five-minute room token. The token is restricted to room join,
subscription, and microphone tracks; camera, screen sharing, data publishing,
recording, and room administration are not granted. Provider-facing room and
participant identities are deterministic opaque hashes rather than game IDs,
profile IDs, or account names.

Player consent and lifecycle rules:

- No auto-join and no auto-unmute.
- Joining is listen-only. The browser asks for microphone permission only when
  the player explicitly presses Unmute.
- A visible mic state, one-tap mute, output mute, leave, block, and connection
  state remain available during play.
- Changing/leaving a table stops local tracks. Leaving/removal revokes the
  provider participant; closing or publicly listing the room ends the provider
  room.
- A bilateral block prevents future voice tokens. Blocking while connected
  queues and immediately attempts to disconnect both the blocker and the
  blocked participant so the pair can no longer exchange audio. Token denial
  uses the same generic unavailable response as other ineligible voice states;
  an incoming block is not disclosed.
- Token issuance checks eligibility before minting and then repeats the complete
  room, membership, scope, block, and participant-identity check after minting
  but before returning the token. A concurrent block, leave, or public listing
  therefore rejects the request and records participant cleanup rather than
  releasing a stale credential.
- Participant revocation and room termination use a durable D1 cleanup outbox.
  The causal command, listing change, block, or maintenance closure and its
  cleanup job commit in one batch. Lost-response command replays, ordinary room
  maintenance, and the successful mutation route all retry due jobs with capped
  backoff. Every room-ending path snapshots both room and valid state-player
  participant cleanup; expired rooms enqueue those jobs before their game rows
  are purged, and the jobs survive that purge.
- A provider-confirmed participant revocation remains an issuance barrier for
  61 seconds after LiveKit's provider-clock cutoff. The sentinel then expires
  without issuing a second revocation or sliding the cutoff; failed provider
  calls remain retryable with capped backoff.
- Disabling communication or live-voice issuance does not disable provider
  administration: valid server credentials can still revoke participants and
  end rooms. Provider failures never roll back or rewrite a successful safety
  or gameplay mutation.
- Open Shed does not record or transcribe live voice. Provider and application
  diagnostics must not log audio, SDP, ICE candidates, IP addresses, tokens, or
  participant content.

LiveKit's server-generated join tokens and microphone-only publish grants are
documented in [Tokens and grants](https://docs.livekit.io/home/server/generating-tokens/).
The browser integration follows LiveKit's guidance to keep room lifecycle under
explicit application control and render remote audio through the SDK.

## Voice notes

Stored voice notes are deliberately not part of this slice. They require a
private R2 binding, codec/container validation, duration and byte caps,
authorized streaming, evidence retention, and a hard object-deletion mechanism.
The current Sites project has no R2 binding or scheduler, so claiming 24-hour
physical deletion would be inaccurate. Add voice notes only after those storage
and lifecycle dependencies are configured and tested.

## Operational launch gates

Do not widen rich communication merely because the code and switches exist.
Before an external cohort, name moderation/urgent-harm owners, publish community
and retention rules, complete the target-market child-access/privacy review,
exercise report/block/sanction/deletion flows, and verify that the switches can
disable text and voice without a deploy. ChatGPT sign-in supplies identity; it
must not be presented as age verification.

The current cleanup worker is request-driven and retains jobs for seven days.
It retries during ordinary room traffic, but cannot promise a wall-clock retry
when the deployment receives no subsequent requests. Before enabling live
voice externally, configure a private scheduled reconciliation trigger or
verify and monitor a provider-side maximum room lifetime/automatic close policy.
This is a launch blocker, not an eventual-consistency claim the current hosting
contract can guarantee on its own.
