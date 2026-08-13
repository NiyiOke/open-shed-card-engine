import assert from "node:assert/strict";
import test from "node:test";
import {
  lobbyPresenceFailureMessage,
  isAmbiguousLobbyMutationFailure,
  parseLobbyPresenceSnapshot,
  pendingLobbyMutation,
  parseLobbyBlockResult,
  parseLobbyInviteResponse,
  parseLobbyInviteSent,
} from "../app/components/lobby-presence";

const presenceId = "a".repeat(32);
const inviteId = "b".repeat(32);

test("lobby presence accepts only the privacy-safe allowlist", () => {
  assert.deepEqual(parseLobbyPresenceSnapshot({
    enabled: true,
    self: { lookingForGame: true, alias: "Night Owl", canBrowse: false },
    players: [{ presenceId, alias: "Card Fox", status: "online", inviteState: "idle" }],
    invites: [{ inviteId, fromAlias: "Table Host" }],
  }), {
    enabled: true,
    self: { lookingForGame: true, alias: "Night Owl", canBrowse: false },
    players: [{ presenceId, alias: "Card Fox", status: "online", inviteState: "idle" }],
    invites: [{ inviteId, fromAlias: "Table Host" }],
  });
  assert.equal(parseLobbyPresenceSnapshot({ enabled: false }), null);
  assert.equal(parseLobbyPresenceSnapshot({
    enabled: true,
    self: { lookingForGame: true, alias: "Night Owl", canBrowse: false },
    players: [{ presenceId: "profile-123", alias: "Card Fox", status: "online", inviteState: "idle" }],
    invites: [],
  }), null);
  for (const tainted of [
    {
      enabled: true,
      self: { lookingForGame: true, alias: "Night Owl", canBrowse: false, email: "secret@example.com" },
      players: [],
      invites: [],
    },
    {
      enabled: true,
      self: { lookingForGame: true, alias: "Night Owl", canBrowse: false },
      players: [{ presenceId, alias: "Card Fox", status: "online", inviteState: "idle", profileId: "secret" }],
      invites: [],
    },
    {
      enabled: true,
      self: { lookingForGame: true, alias: "Night Owl", canBrowse: false },
      players: [],
      invites: [{ inviteId, fromAlias: "Table Host", gameId: "secret" }],
    },
    {
      enabled: true,
      self: { lookingForGame: true, alias: "Night Owl", canBrowse: false },
      players: [],
      invites: [],
      joinCode: "SECRET",
    },
  ]) {
    assert.equal(parseLobbyPresenceSnapshot(tainted), null);
  }
  assert.equal(parseLobbyPresenceSnapshot({
    enabled: true,
    self: { lookingForGame: true, alias: "Night Owl", canBrowse: false },
    players: [{ presenceId, alias: "Card Fox", status: "offline", inviteState: "idle" }],
    invites: [],
  }), null);
  assert.equal(parseLobbyPresenceSnapshot({
    enabled: true,
    self: { lookingForGame: true, alias: null, canBrowse: true },
    players: [],
    invites: [],
  }), null);
  assert.equal(parseLobbyPresenceSnapshot({
    enabled: true,
    self: { lookingForGame: true, alias: "Night Owl", canBrowse: true },
    players: [
      { presenceId, alias: "Card Fox", status: "online", inviteState: "idle" },
      { presenceId, alias: "Card Lynx", status: "online", inviteState: "idle" },
    ],
    invites: [],
  }), null);
  for (const unsafeAlias of ["Discord playername", "07123456789", "name@example.com"]) {
    assert.equal(parseLobbyPresenceSnapshot({
      enabled: true,
      self: { lookingForGame: true, alias: "Night Owl", canBrowse: false },
      players: [{ presenceId, alias: unsafeAlias, status: "online", inviteState: "idle" }],
      invites: [],
    }), null);
  }
});

test("lobby invitation errors remain coarse", () => {
  assert.match(lobbyPresenceFailureMessage("PRESENCE_UNAVAILABLE"), /no longer looking/i);
  assert.match(lobbyPresenceFailureMessage("INVITE_ALREADY_PENDING"), /already/i);
  assert.doesNotMatch(lobbyPresenceFailureMessage("UNKNOWN"), /profile|identifier|code/i);
});

test("invitation mutation responses are allowlisted before command keys clear", () => {
  assert.deepEqual(parseLobbyBlockResult({ blocked: true, replayed: false }), { replayed: false });
  assert.equal(parseLobbyBlockResult({ blocked: true, replayed: false, profileId: "secret" }), null);
  assert.deepEqual(parseLobbyInviteSent({
    invite: { inviteId, state: "sent", replayed: false },
  }), { inviteId, replayed: false });
  assert.equal(parseLobbyInviteSent({
    invite: { inviteId, state: "accepted", replayed: false },
  }), null);
  assert.equal(parseLobbyInviteSent({
    invite: { inviteId, state: "sent", replayed: false, profileId: "secret" },
  }), null);
  assert.deepEqual(parseLobbyInviteResponse({
    invite: { inviteId, state: "blocked", replayed: true },
  }, "decline_and_block"), { state: "blocked", snapshot: null });
  assert.equal(parseLobbyInviteResponse({
    invite: { inviteId, state: "accepted", replayed: false },
  }, "accept"), null);
  assert.deepEqual(parseLobbyInviteResponse({
    invite: { inviteId, state: "accepted", replayed: false },
    snapshot: { view: {} },
  }, "accept"), { state: "accepted", snapshot: { view: {} } });
  assert.equal(parseLobbyInviteResponse({
    invite: { inviteId, state: "accepted", replayed: false, joinCode: "SECRET" },
    snapshot: { view: {} },
  }, "accept"), null);
  assert.equal(parseLobbyInviteResponse({
    invite: { inviteId, state: "declined", replayed: false },
    gameId: "secret",
  }, "decline"), null);
});

test("ambiguous mutation failures retain their exact command for replay", () => {
  assert.equal(isAmbiguousLobbyMutationFailure(new Error("timeout"), "REQUEST_TIMEOUT"), true);
  assert.equal(isAmbiguousLobbyMutationFailure(new SyntaxError("truncated")), true);
  assert.equal(isAmbiguousLobbyMutationFailure(new Error("server"), "INTERNAL_ERROR"), true);
  assert.equal(isAmbiguousLobbyMutationFailure(Object.assign(new Error("gateway"), { status: 502 }), "UPSTREAM_FAILURE"), true);
  assert.equal(isAmbiguousLobbyMutationFailure(new Error("stale"), "INVITE_EXPIRED"), false);
});

test("exact operation fingerprints reuse one durable command id", () => {
  let sequence = 0;
  const create = () => `cmd-${++sequence}`;
  const first = pendingLobbyMutation(null, '{"action":"accept"}', create);
  const replay = pendingLobbyMutation(first, '{"action":"accept"}', create);
  const changed = pendingLobbyMutation(first, '{"action":"decline"}', create);
  assert.equal(replay.commandId, first.commandId);
  assert.notEqual(changed.commandId, first.commandId);
  assert.equal(sequence, 2);
});
