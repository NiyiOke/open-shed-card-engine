import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8");
const SHELL = read("app/components/GameShell.tsx");
const HOOK = read("app/components/use-realtime-updates.ts");
const NOTIFIER = read("lib/server/realtime-notify.ts");
const VITE_CONFIG = read("vite.config.ts");

test("GameShell uses realtime only as a content-free invalidation accelerator", () => {
  assert.match(SHELL, /useRealtimeUpdates\(/u);
  assert.match(HOOK, /createRealtimeController\(\{/u);
  assert.match(HOOK, /\/realtime-ticket/u);
  assert.match(HOOK, /body: "\{\}"/u);
  assert.match(HOOK, /topics\.includes\("chat"\)[\s\S]*refreshChat/u);
  assert.match(HOOK, /topics\.includes\("game"\)[\s\S]*refreshGame/u);
  assert.match(HOOK, /refreshGame\(gameId, true\)/u);
  assert.match(HOOK, /if \(!refreshed\) throw/u);
  assert.match(
    SHELL,
    /if \(existing\?\.gameId === gameId\)[\s\S]*trailing[\s\S]*existing\.promise\.then\(\(\) => refreshGame\(gameId\)\)/u,
  );
  assert.match(SHELL, /realtimeState === "live"[\s\S]*30_000[\s\S]*45_000/u);
  assert.match(SHELL, /realtimeState === "live"[\s\S]*25_000/u);
  assert.match(HOOK, /window\.addEventListener\("online", reconnect\)/u);
  assert.match(HOOK, /controller\.stop\(\)/u);
  assert.doesNotMatch(SHELL, /socket\.send\([^)]*(?:GameView|message|hand|player)/u);
});

test("the notifier never follows redirects and remains best effort", () => {
  assert.match(NOTIFIER, /redirect: "manual"/u);
  assert.doesNotMatch(NOTIFIER, /redirect: "error"/u);
  assert.match(NOTIFIER, /catch \{[\s\S]*can never change a committed response/u);
});

test("acceptance-only bindings cannot be packaged by a production build", () => {
  assert.match(
    VITE_CONFIG,
    /process\.env\.NODE_ENV !== "production"[\s\S]*OPEN_SHED_ACCEPTANCE_ENVIRONMENT === "true"/u,
  );
});

test("accepted mutations notify only after their authoritative store operation", () => {
  const routes: Array<{
    path: string;
    mutation: RegExp;
    notification: RegExp;
  }> = [
    {
      path: "app/api/games/[gameId]/commands/route.ts",
      mutation: /const result = await executeGameCommand/u,
      notification: /await notifyRealtimeChange/u,
    },
    {
      path: "app/api/games/[gameId]/messages/route.ts",
      mutation: /const (?:result|sent) = await sendTableMessage/u,
      notification: /await notifyRealtimeChange\(gameId, \["chat"\]\)/u,
    },
    {
      path: "app/api/games/[gameId]/presence/route.ts",
      mutation: /const result = await heartbeatGamePresence/u,
      notification: /await notifyRealtimeChange\(gameId, \["game"\]\)/u,
    },
    {
      path: "app/api/games/[gameId]/listing/route.ts",
      mutation: /const result = await mutateGameListing/u,
      notification: /await notifyRealtimeChange\(gameId, \["game", "chat"\]\)/u,
    },
    {
      path: "app/api/games/join/route.ts",
      mutation: /const joined = await joinGame/u,
      notification: /await notifyRealtimeChange\(view\.gameId/u,
    },
    {
      path: "app/api/public/quick-join/route.ts",
      mutation: /const result = await quickJoinPublicRoom/u,
      notification: /await notifyRealtimeChange\(result\.snapshot\.view\.gameId/u,
    },
    {
      path: "app/api/public/rooms/[listingId]/join/route.ts",
      mutation: /const result = await joinPublicRoom/u,
      notification: /await notifyRealtimeChange\(result\.snapshot\.view\.gameId/u,
    },
  ];
  for (const route of routes) {
    const source = read(route.path);
    assert.match(source, route.mutation, route.path);
    assert.match(source, route.notification, route.path);
    assert.ok(
      source.search(route.mutation) < source.search(route.notification),
      `${route.path} must commit before notifying`,
    );
  }
});

test("durable idempotent replays cannot amplify realtime notifications", () => {
  for (const path of [
    "app/api/games/[gameId]/commands/route.ts",
    "app/api/games/[gameId]/messages/route.ts",
    "app/api/games/[gameId]/listing/route.ts",
    "app/api/games/join/route.ts",
    "app/api/public/quick-join/route.ts",
    "app/api/public/rooms/[listingId]/join/route.ts",
    "app/api/lobby-invites/[inviteId]/respond/route.ts",
  ]) {
    const source = read(path);
    assert.match(source, /!\w+(?:\.invite)?\.replayed/u, path);
  }
});

test("safety stays private while membership changes trigger content-free catch-up", () => {
  const block = read("app/api/games/[gameId]/players/[playerId]/block/route.ts");
  const mute = read("app/api/games/[gameId]/players/[playerId]/mute/route.ts");
  const invitation = read("app/api/lobby-invites/[inviteId]/respond/route.ts");
  assert.match(block, /await setProfileBlock/u);
  assert.match(mute, /await setTableMute/u);
  assert.doesNotMatch(block, /notifyRealtimeChange/u);
  assert.doesNotMatch(mute, /notifyRealtimeChange/u);
  assert.match(invitation, /"snapshot" in result[\s\S]*notifyRealtimeChange/u);
});
