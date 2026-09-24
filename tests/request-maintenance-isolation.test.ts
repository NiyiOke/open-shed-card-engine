import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createRequestMaintenanceGate } from "../lib/server/request-maintenance";

type MaintenanceCallSite = Readonly<{
  dependencyName: string;
  forbiddenStateNames: readonly string[];
  functionName: string;
  gateName: string;
  intervalName: string;
  source: string;
}>;

const GAME_STORE = source("../lib/server/game-store.ts");
const CHAT_STORE = source("../lib/server/chat-store.ts");
const LIVE_VOICE_CLEANUP = source("../lib/server/live-voice-cleanup.ts");

const CALL_SITES: readonly MaintenanceCallSite[] = Object.freeze([
  {
    source: GAME_STORE,
    functionName: "maybeMaintainRoomLifecycles",
    dependencyName: "maintainRoomLifecycleRows",
    intervalName: "ROOM_MAINTENANCE_INTERVAL_MS",
    gateName: "roomMaintenanceGate",
    forbiddenStateNames: [
      "roomMaintenancePromise",
      "lastRoomMaintenanceAt",
    ],
  },
  {
    source: GAME_STORE,
    functionName: "maybePurgeExpiredGames",
    dependencyName: "purgeExpiredRows",
    intervalName: "PURGE_INTERVAL_MS",
    gateName: "purgeGate",
    forbiddenStateNames: ["purgePromise", "lastPurgeAt"],
  },
  {
    source: CHAT_STORE,
    functionName: "maybeCleanupCommunication",
    dependencyName: "cleanupExpiredCommunicationRows",
    intervalName: "COMMUNICATION_CLEANUP_INTERVAL_MS",
    gateName: "communicationCleanupGate",
    forbiddenStateNames: ["cleanupPromise", "lastCleanupAt"],
  },
  {
    source: LIVE_VOICE_CLEANUP,
    functionName: "maybeReconcileLiveVoiceCleanupJobs",
    dependencyName: "reconcileLiveVoiceCleanupJobs",
    intervalName: "CLEANUP_RECONCILE_INTERVAL_MS",
    gateName: "cleanupReconcileGate",
    forbiddenStateNames: ["reconcilePromise", "lastReconcileAt"],
  },
]);

test("request maintenance never shares an in-flight task across requests", async () => {
  const intervalMs = 100;
  const gate = createRequestMaintenanceGate(intervalMs);
  const neverSettles = new Promise<never>(() => undefined);
  const first = gate.run(1_000, () => neverSettles);

  assert.deepEqual(await gate.run(1_099, async () => "too early"), {
    started: false,
  });
  assert.deepEqual(await gate.run(1_100, async () => "fresh request"), {
    started: true,
    value: "fresh request",
  });

  let firstSettled = false;
  void first.then(
    () => {
      firstSettled = true;
    },
    () => {
      firstSettled = true;
    },
  );
  await Promise.resolve();
  assert.equal(firstSettled, false);
});

test("an older rejection cannot erase a newer successful attempt's cadence", async () => {
  const intervalMs = 100;
  const gate = createRequestMaintenanceGate(intervalMs);
  const older = deferred<void>();
  const olderRun = gate.run(1_000, () => older.promise);

  assert.deepEqual(await gate.run(1_100, async () => "newer"), {
    started: true,
    value: "newer",
  });
  older.reject(new Error("older request was canceled"));
  await assert.rejects(olderRun, /older request was canceled/u);

  let unexpectedRuns = 0;
  assert.deepEqual(
    await gate.run(1_100, async () => {
      unexpectedRuns += 1;
      return "must stay gated";
    }),
    { started: false },
  );
  assert.equal(unexpectedRuns, 0);
});

test("the current failed attempt permits an immediate request-local retry", async () => {
  const gate = createRequestMaintenanceGate(100);
  await assert.rejects(
    gate.run(1_000, async () => {
      throw new Error("current request failed");
    }),
    /current request failed/u,
  );

  assert.deepEqual(await gate.run(1_000, async () => "retried"), {
    started: true,
    value: "retried",
  });
});

test("all request-path maintenance call sites use the guarded scalar gate", () => {
  for (const callSite of CALL_SITES) {
    const topLevelNames = moduleVariableNames(callSite.source);
    for (const forbiddenName of callSite.forbiddenStateNames) {
      assert.equal(
        topLevelNames.has(forbiddenName),
        false,
        `${callSite.functionName} must not retain ${forbiddenName}`,
      );
    }

    assert.match(
      callSite.source,
      new RegExp(
        `const ${callSite.gateName} = createRequestMaintenanceGate\\(\\s*${callSite.intervalName},?\\s*\\)`,
        "u",
      ),
    );
    const implementation = functionSource(
      callSite.source,
      callSite.functionName,
    );
    assert.match(
      implementation,
      new RegExp(
        `await ${callSite.gateName}\\.run\\(now, \\(\\) =>[\\s\\S]*${callSite.dependencyName}\\(`,
        "u",
      ),
    );
    assert.doesNotMatch(implementation, /\.finally\(/u);
  }
});

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  reject(reason?: unknown): void;
  resolve(value: T): void;
}> {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return Object.freeze({ promise, reject, resolve });
}

function functionSource(value: string, functionName: string): string {
  const parsed = parse(value);
  const declaration = parsed.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === functionName,
  );
  assert.ok(declaration, `missing ${functionName}`);
  return declaration.getText(parsed);
}

function moduleVariableNames(value: string): ReadonlySet<string> {
  const parsed = parse(value);
  const names = new Set<string>();
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
    }
  }
  return names;
}

function parse(value: string): ts.SourceFile {
  return ts.createSourceFile(
    "maintenance.ts",
    value,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function source(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
}
