import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shell = readFileSync(new URL("../app/components/GameShell.tsx", import.meta.url), "utf8");
const panels = readFileSync(new URL("../app/components/LobbyPresencePanels.tsx", import.meta.url), "utf8");
const landing = readFileSync(new URL("../app/components/SignedOutLanding.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

test("lobby presence stays opt-in, alias-only, and host-gated", () => {
  assert.match(panels, /Public lobby alias/u);
  assert.match(panels, /This starts blank\. Avoid your real name/u);
  assert.match(shell, /lobbyPresence\?\.self\.canBrowse/u);
  assert.match(shell, /activePlayers\.length === 1/u);
  assert.match(panels, /player\.status === "online" \? "Online" : "Reconnecting"/u);
  assert.match(panels, /Decline &amp; block/u);
  assert.match(panels, /Hide &amp; block/u);
  assert.match(panels, /Confirm block/u);
  assert.doesNotMatch(panels, /lastSeenAt|profileId/u);
});

test("heartbeat is limited to an opted-in browser and mutations replay exact bodies", () => {
  assert.match(shell, /if \(!game && lobbyPresence\?\.self\.lookingForGame\)/u);
  assert.match(shell, /pendingLobbyMutation\(lobbyPresenceMutationRef\.current, fingerprint, commandId\)/u);
  assert.match(shell, /pendingLobbyMutation\(lobbyInviteMutationRef\.current, fingerprint, commandId\)/u);
  assert.match(shell, /pendingLobbyMutation\(lobbyInviteResponseMutationRef\.current, fingerprint, commandId\)/u);
  assert.match(shell, /pendingLobbyMutation\(lobbyBlockMutationRef\.current, fingerprint, commandId\)/u);
  assert.match(shell, /isAmbiguousLobbyMutationFailure/u);
  assert.match(shell, /Preserve the last verified snapshot and retry transient failures/u);
  assert.match(shell, /Object\.keys\(response\)\.length === 1/u);
  assert.match(shell, /lobbyInviteResponsePendingRef/u);
});

test("incoming invitations and durable blocks remain accessible and informed", () => {
  assert.match(panels, /role="status"/u);
  assert.match(panels, /lasting safety action/u);
  assert.match(panels, /confirmInviteBlockButtonRef\.current\?\.focus/u);
  assert.match(panels, /confirmBlockButtonRef\.current\?\.focus/u);
  assert.match(panels, /blockTriggerRef\.current\?\.focus/u);
  assert.match(panels, /Accept invitation from \$\{invite\.fromAlias\}/u);
  assert.match(panels, /Invite \$\{player\.alias\}/u);
  assert.match(panels, /focusRequest > 0/u);
  assert.match(shell, /Your lobby visibility ended/u);
});

test("public aliases never inherit account or table identity", () => {
  assert.match(shell, /const \[lobbyPresenceAlias, setLobbyPresenceAlias\] = useState\(""\)/u);
  assert.match(shell, /const \[lobbyInviteHostAlias, setLobbyInviteHostAlias\] = useState\(""\)/u);
  assert.match(shell, /setLobbyInviteHostAlias\(""\)/u);
  assert.doesNotMatch(shell, /setLobbyPresenceAlias\(session|setLobbyInviteHostAlias\(nickname/u);
});

test("acceptance consumes only the atomic snapshot and sender confirms public-safe chat", () => {
  assert.match(shell, /const snapshot = parsedResponse\.snapshot/u);
  assert.match(shell, /enterGame\(/u);
  assert.match(shell, /quick phrases only, with no free text or live voice/u);
  assert.match(shell, /senderAlias/u);
  assert.doesNotMatch(shell, /parseLobbyInviteJoinIntent/u);
});

test("invite authentication recovery is bounded and mobile-safe", () => {
  assert.match(shell, /Open this link in Safari or Chrome/u);
  assert.match(shell, /Sign in with ChatGPT shares only basic identity/u);
  assert.match(landing, /managed workspace may require admin approval/iu);
  assert.match(css, /\.public-invite-auth/u);
  assert.match(css, /\.incoming-invite-actions > \*/u);
  assert.match(css, /\.incoming-lobby-invite strong,[\s\S]*?overflow-wrap: anywhere/u);
  assert.match(css, /\.lobby-player-invite-panel h2[\s\S]*?overflow-wrap: anywhere/u);
});
