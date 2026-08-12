import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  expiredGameLiveVoiceCleanupStatements,
  reconcileLiveVoiceCleanupJobs,
} from "../lib/server/live-voice-cleanup";
import { LIVE_VOICE_ENV } from "../lib/server/live-voice-provider";

test("expired room cleanup snapshots room and validated state participants", () => {
  const prepared: Array<{ sql: string; bindings: unknown[] }> = [];
  const database = captureDatabase(prepared);
  const statements = expiredGameLiveVoiceCleanupStatements(
    database,
    1_800_000_000_000,
  );

  assert.equal(statements.length, 2);
  assert.match(prepared[0]!.sql, /FROM games game/u);
  assert.match(prepared[0]!.sql, /game\.room_status = 'open'/u);
  assert.match(prepared[0]!.sql, /game\.expires_at <= \?/u);
  assert.match(prepared[1]!.sql, /JOIN json_each/u);
  assert.match(prepared[1]!.sql, /json_extract\(player\.value, '\$\.playerId'\)/u);
  assert.match(prepared[1]!.sql, /NOT GLOB '\*\[\^A-Za-z0-9_-\]\*'/u);
  assert.deepEqual(prepared[0]!.bindings, [
    1_800_000_000_000,
    1_800_000_000_000,
    1_800_604_800_000,
    1_800_000_000_000,
  ]);
  assert.deepEqual(prepared[1]!.bindings, prepared[0]!.bindings);
});

test("SQLite preserves expiry cleanup after the game is deleted and ages a confirmed sentinel", (context) => {
  const version = spawnSync("sqlite3", ["--version"], { encoding: "utf8" });
  if (version.status !== 0) {
    context.skip("sqlite3 is unavailable");
    return;
  }

  const prepared: Array<{ sql: string; bindings: unknown[] }> = [];
  expiredGameLiveVoiceCleanupStatements(
    captureDatabase(prepared),
    1_800_000_000_000,
  );
  const directory = mkdtempSync(join(tmpdir(), "open-shed-voice-sqlite-"));
  const databasePath = join(directory, "voice.db");
  try {
    const stateJson = JSON.stringify({
      players: [
        { playerId: "player-host" },
        { playerId: "player-guest" },
        { playerId: "invalid!player" },
      ],
    }).replaceAll("'", "''");
    const setup = runSqlite(
      databasePath,
      `CREATE TABLE games (
         id TEXT PRIMARY KEY,
         room_status TEXT NOT NULL,
         state_json TEXT NOT NULL,
         expires_at INTEGER NOT NULL
       );
       CREATE TABLE live_voice_cleanup_jobs (
         job_key TEXT PRIMARY KEY NOT NULL,
         kind TEXT NOT NULL,
         game_id TEXT NOT NULL,
         player_id TEXT,
         requested_at INTEGER NOT NULL,
         next_attempt_at INTEGER NOT NULL,
         attempt_count INTEGER NOT NULL DEFAULT 0,
         expires_at INTEGER NOT NULL
       );
       INSERT INTO games VALUES (
         'expired-game', 'open', '${stateJson}', 1799999999999
       );
       INSERT INTO games VALUES (
         'future-game', 'open', '{"players":[{"playerId":"future"}]}',
         1800000000001
       );
       BEGIN;
       ${bindIntegerSql(prepared[0]!)};
       ${bindIntegerSql(prepared[1]!)};
       DELETE FROM games WHERE id = 'expired-game';
       COMMIT;`,
    );
    assert.equal(setup.status, 0, setup.stderr);

    const jobs = JSON.parse(
      runSqlite(
        databasePath,
        `SELECT job_key, kind, game_id, player_id, attempt_count
         FROM live_voice_cleanup_jobs ORDER BY job_key;`,
        true,
      ).stdout,
    ) as Array<Record<string, unknown>>;
    assert.deepEqual(jobs, [
      {
        job_key: "participant:expired-game:player-guest",
        kind: "participant",
        game_id: "expired-game",
        player_id: "player-guest",
        attempt_count: 0,
      },
      {
        job_key: "participant:expired-game:player-host",
        kind: "participant",
        game_id: "expired-game",
        player_id: "player-host",
        attempt_count: 0,
      },
      {
        job_key: "room:expired-game",
        kind: "room",
        game_id: "expired-game",
        player_id: null,
        attempt_count: 0,
      },
    ]);

    const participant = jobs[0]!.job_key;
    const sentinel = runSqlite(
      databasePath,
      `UPDATE live_voice_cleanup_jobs
       SET attempt_count = -1, next_attempt_at = 1800000061000
       WHERE job_key = '${participant}'
         AND requested_at = 1800000000000 AND attempt_count = 0;
       SELECT attempt_count, next_attempt_at
       FROM live_voice_cleanup_jobs WHERE job_key = '${participant}';`,
      true,
    );
    assert.equal(sentinel.status, 0, sentinel.stderr);
    assert.deepEqual(JSON.parse(sentinel.stdout), [
      { attempt_count: -1, next_attempt_at: 1_800_000_061_000 },
    ]);

    const deletion = runSqlite(
      databasePath,
      `DELETE FROM live_voice_cleanup_jobs
       WHERE job_key = '${participant}'
         AND requested_at = 1800000000000 AND attempt_count = -1;
       SELECT count(*) AS remaining
       FROM live_voice_cleanup_jobs WHERE job_key = '${participant}';`,
      true,
    );
    assert.equal(deletion.status, 0, deletion.stderr);
    assert.deepEqual(JSON.parse(deletion.stdout), [{ remaining: 0 }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a provider-confirmed sentinel expires without a second provider call", async () => {
  const originals = new Map<string, string | undefined>();
  const environment = {
    [LIVE_VOICE_ENV.serverUrl]: "wss://voice.example.test",
    [LIVE_VOICE_ENV.apiKey]: "test-api-key",
    [LIVE_VOICE_ENV.apiSecret]: "test-api-secret",
  };
  for (const [key, value] of Object.entries(environment)) {
    originals.set(key, process.env[key]);
    process.env[key] = value;
  }

  const executed: Array<{ sql: string; bindings: unknown[] }> = [];
  const now = 1_800_000_061_000;
  const database = {
    prepare(sql: string) {
      let bindings: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bindings = values;
          return statement;
        },
        async run() {
          executed.push({ sql, bindings });
          return {} as D1Result<unknown>;
        },
        async all<T>() {
          assert.match(sql, /SELECT job_key, kind, game_id/u);
          return {
            results: [
              {
                job_key: "participant:game-1:player-1",
                kind: "participant",
                game_id: "game-1",
                player_id: "player-1",
                requested_at: now - 61_000,
                attempt_count: -1,
              },
            ],
          } as unknown as D1Result<T>;
        },
      };
      return statement;
    },
  } as unknown as D1Database;

  try {
    const result = await reconcileLiveVoiceCleanupJobs(database, { now });
    assert.deepEqual(result, { processed: 1, succeeded: 1, failed: 0 });
    assert.equal(
      executed.some(({ sql }) =>
        /attempt_count = -1/u.test(sql) && /DELETE FROM/u.test(sql)
      ),
      true,
    );
    assert.equal(executed.some(({ sql }) => /UPDATE live_voice_cleanup_jobs/u.test(sql)), false);
  } finally {
    for (const [key, value] of originals) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

function captureDatabase(
  prepared: Array<{ sql: string; bindings: unknown[] }>,
): D1Database {
  return {
    prepare(sql: string) {
      const record = { sql, bindings: [] as unknown[] };
      prepared.push(record);
      const statement = {
        bind(...values: unknown[]) {
          record.bindings = values;
          return statement;
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function bindIntegerSql(record: {
  sql: string;
  bindings: unknown[];
}): string {
  let index = 0;
  const sql = record.sql.replaceAll("?", () => {
    const value = record.bindings[index];
    index += 1;
    assert.equal(typeof value, "number");
    return String(value);
  });
  assert.equal(index, record.bindings.length);
  return sql;
}

function runSqlite(
  databasePath: string,
  sql: string,
  json = false,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    "sqlite3",
    [...(json ? ["-json"] : []), databasePath],
    {
      encoding: "utf8",
      input: sql,
    },
  );
  return {
    status: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}
