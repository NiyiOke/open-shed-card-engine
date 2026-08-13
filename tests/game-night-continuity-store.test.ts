import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(process.cwd());
const STORE_SOURCE = readFileSync(
  join(ROOT, "lib/server/game-store.ts"),
  "utf8",
);
const RUNTIME_SOURCE = readFileSync(join(ROOT, "db/runtime.ts"), "utf8");

test("host claim persistence revalidates authority, presence, and cyclic priority", () => {
  const claimGuard = sourceFunction(
    STORE_SOURCE,
    "guardedHostClaimReceiptStatement",
    "guardedEventStatement",
  );

  assert.match(claimGuard, /g\.host_profile_id = \?/u);
  assert.match(claimGuard, /g\.version = \? AND g\.state_hash = \?/u);
  assert.match(claimGuard, /g\.room_status = 'open'/u);
  assert.match(claimGuard, /previous_host\.status <> 'left'/u);
  assert.match(
    claimGuard,
    /previous_host_presence\.last_seen_at,[\s\S]*previous_host\.joined_at[\s\S]*<= \?/u,
  );
  assert.match(
    claimGuard,
    /claimant_presence\.last_seen_at,[\s\S]*claimant\.joined_at[\s\S]*> \?/u,
  );
  assert.match(claimGuard, /NOT EXISTS \([\s\S]*FROM game_members contender/u);
  assert.match(claimGuard, /contender\.seat \+ 100000/u);
  assert.match(claimGuard, /claimant\.seat \+ 100000/u);
  assert.match(claimGuard, /phase === "complete" \? "non_left" : "active"/u);
});

test("round completion is an immutable receipt-and-event-guarded dependency", () => {
  const ledger = sourceFunction(
    STORE_SOURCE,
    "guardedRoundLedgerStatement",
    "presenceUpsertStatement",
  );
  const gameUpdate = sourceFunction(
    STORE_SOURCE,
    "guardedGameUpdateStatement",
    "databaseStatus",
  );

  assert.match(ledger, /INSERT INTO game_rounds/u);
  assert.doesNotMatch(ledger, /ON CONFLICT|INSERT OR|UPDATE game_rounds/u);
  assert.match(ledger, /FROM command_receipts receipt/u);
  assert.match(ledger, /receipt\.result_version = \?/u);
  assert.match(ledger, /FROM game_events event/u);
  assert.match(ledger, /json_extract\(payload\.value, '\$\.type'\) = 'game_won'/u);
  assert.match(ledger, /MAX\(existing\.round_number\) \+ 1/u);
  assert.match(gameUpdate, /FROM game_rounds round/u);
  assert.match(gameUpdate, /round\.completion_revision = \?/u);
  assert.doesNotMatch(STORE_SOURCE, /UPDATE game_rounds/u);
  assert.match(STORE_SOURCE, /DELETE FROM game_rounds WHERE rowid IN/u);
  assert.match(
    STORE_SOURCE,
    /NOT EXISTS \(SELECT 1 FROM game_rounds round WHERE round\.game_id = g\.id\)/u,
  );
});

test("viewer series reads aggregate the ledger and hard-limit recent winners", () => {
  const projectionRead = sourceFunction(
    STORE_SOURCE,
    "readGameSeriesView",
    "continuityProjectionForUser",
  );

  assert.match(
    projectionRead,
    /WHERE game_id = \? AND completion_revision <= \?/u,
  );
  assert.match(projectionRead, /SELECT COUNT\(\*\) AS completed_rounds/u);
  assert.match(projectionRead, /MAX\(round_number\)/u);
  assert.match(projectionRead, /COUNT\(ledger\.completion_revision\) AS wins/u);
  assert.match(projectionRead, /GROUP BY current_players\.user_id/u);
  assert.match(projectionRead, /ORDER BY ledger\.round_number DESC[\s\S]*LIMIT 5/u);
  assert.equal((projectionRead.match(/FROM game_rounds/gu) ?? []).length, 1);
  assert.doesNotMatch(projectionRead, /Promise\.all/u);
  assert.doesNotMatch(projectionRead, /winner_display_name/u);
  assert.doesNotMatch(
    projectionRead,
    /ORDER BY round\.round_number ASC/u,
  );
});

test("the exact viewer SQL excludes ledger rows newer than the projected state", (context) => {
  const version = spawnSync("sqlite3", ["--version"], { encoding: "utf8" });
  if (version.status !== 0) {
    context.skip("sqlite3 is unavailable");
    return;
  }
  const projectionRead = sourceFunction(
    STORE_SOURCE,
    "readGameSeriesView",
    "continuityProjectionForUser",
  );
  const template = projectionRead.match(/\.prepare\(\s*`([\s\S]*?)`,\s*\)/u)?.[1];
  assert.ok(template, "readGameSeriesView SQL template is missing");
  const query = bindSqliteSql(
    template.replace("${currentValues}", "(?), (?)"),
    ["user-a", "user-b", "game-1", 10],
  );
  const result = runSqlite(
    ":memory:",
    `CREATE TABLE profiles (id TEXT PRIMARY KEY, auth_subject TEXT NOT NULL);
     CREATE TABLE game_rounds (
       game_id TEXT NOT NULL,
       completion_revision INTEGER NOT NULL,
       round_number INTEGER NOT NULL,
       winner_profile_id TEXT NOT NULL,
       winner_reason TEXT NOT NULL,
       completed_at INTEGER NOT NULL
     );
     INSERT INTO profiles VALUES
       ('profile-a', 'user-a'), ('profile-b', 'user-b');
     INSERT INTO game_rounds VALUES
       ('game-1', 5, 1, 'profile-a', 'empty_hand', 500),
       ('game-1', 15, 2, 'profile-b', 'last_active', 1500);
     ${query};`,
    true,
  );
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
  const scores = rows.filter((row) => row.row_kind === "score");
  const recent = rows.filter((row) => row.row_kind === "recent");
  assert.deepEqual(
    scores.map((row) => [
      row.winner_user_id,
      row.wins,
      row.completed_rounds,
      row.highest_round,
    ]),
    [
      ["user-a", 1, 1, 1],
      ["user-b", 0, 1, 1],
    ],
  );
  assert.deepEqual(
    recent.map((row) => [
      row.winner_user_id,
      row.completion_revision,
      row.round_number,
    ]),
    [["user-a", 5, 1]],
  );
});

test("migration 0009 backfills the proven win event before a later completed-table leave", (context) => {
  const version = spawnSync("sqlite3", ["--version"], { encoding: "utf8" });
  if (version.status !== 0) {
    context.skip("sqlite3 is unavailable");
    return;
  }

  const directory = mkdtempSync(join(tmpdir(), "open-shed-continuity-"));
  const databasePath = join(directory, "continuity.db");
  try {
    const migrationDirectory = join(ROOT, "drizzle");
    const migrations = readdirSync(migrationDirectory)
      .filter((name) => /^000\d_.*\.sql$/u.test(name))
      .sort();
    const continuityIndex = migrations.indexOf("0009_lovely_miek.sql");
    assert.ok(continuityIndex >= 0);
    const beforeContinuity = migrations
      .slice(0, continuityIndex)
      .map((name) => readFileSync(join(migrationDirectory, name), "utf8"))
      .join("\n");
    const continuity = readFileSync(
      join(migrationDirectory, migrations[continuityIndex]),
      "utf8",
    );
    const winRevision = 40;
    const currentRevision = 42;
    const winCompletedAt = 1_900_000_000_040;
    const state = JSON.stringify({
      updatedAt: 1_900_000_000_042,
      winner: { playerId: "player-winner", reason: "empty_hand" },
      players: [
        {
          playerId: "player-winner",
          userId: "user-winner",
          displayName: "Winner snapshot",
        },
        {
          playerId: "player-host",
          userId: "user-host",
          displayName: "Host snapshot",
        },
      ],
    }).replaceAll("'", "''");
    const winEvents = JSON.stringify([
      {
        type: "card_played",
        actorPlayerId: "player-winner",
        message: "Winner snapshot played their final card.",
      },
      {
        type: "game_won",
        actorPlayerId: "player-winner",
        message: "Winner snapshot won.",
        data: { reason: "empty_hand" },
      },
    ]).replaceAll("'", "''");
    const laterLeaveEvents = JSON.stringify([
      {
        type: "player_left",
        actorPlayerId: "player-host",
        message: "Host snapshot left the game.",
      },
    ]).replaceAll("'", "''");
    const setup = runSqlite(
      databasePath,
      `${beforeContinuity}
       INSERT INTO profiles VALUES
         ('profile-host', 'user-host', 'Host now', 1, 1),
         ('profile-winner', 'user-winner', 'Winner now', 1, 1);
       INSERT INTO games (
         id, join_code, host_profile_id, rules_version, protocol_version,
         status, version, state_json, state_hash, created_at,
         last_activity_at, expires_at
       ) VALUES (
         'game-finished', 'ROUND1', 'profile-host',
         'merciless-baseline-v1', 1, 'finished', ${currentRevision},
         '${state}', 'state-hash', 1, 1900000000042, 2000000000000
       );
       INSERT INTO game_events (
         game_id, version, command_id, actor_profile_id, kind,
         public_payload_json, state_hash, created_at
       ) VALUES
         (
           'game-finished', ${winRevision}, 'winning-command',
           'profile-winner', 'game_won', '${winEvents}',
           'winning-state-hash', ${winCompletedAt}
         ),
         (
           'game-finished', ${currentRevision}, 'later-leave',
           'profile-host', 'player_left', '${laterLeaveEvents}',
           'state-hash', 1900000000042
         );
       ${continuity}`,
    );
    assert.equal(setup.status, 0, setup.stderr);

    const rows = JSON.parse(
      runSqlite(
        databasePath,
        `SELECT game_id, completion_revision, round_number,
                winner_profile_id, winner_display_name, winner_reason,
                completed_at
         FROM game_rounds;`,
        true,
      ).stdout,
    ) as Array<Record<string, unknown>>;
    assert.deepEqual(rows, [
      {
        game_id: "game-finished",
        completion_revision: winRevision,
        round_number: 1,
        winner_profile_id: "profile-winner",
        winner_display_name: "Winner snapshot",
        winner_reason: "empty_hand",
        completed_at: winCompletedAt,
      },
    ]);

    const indexes = JSON.parse(
      runSqlite(databasePath, "PRAGMA index_list('game_rounds');", true).stdout,
    ) as Array<{ name: string; unique: number }>;
    assert.equal(
      indexes.some(
        (index) => index.name === "idx_game_rounds_number" && index.unique === 1,
      ),
      true,
    );

    const duplicateRound = runSqlite(
      databasePath,
      `INSERT INTO game_rounds VALUES (
         'game-finished', 43, 1, 'profile-winner',
         'Changed snapshot', 'last_active', 1900000000043
       );`,
    );
    assert.notEqual(duplicateRound.status, 0);
    assert.match(duplicateRound.stderr, /UNIQUE constraint failed/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migration omits an unproven completed snapshot instead of inventing a round", (context) => {
  const version = spawnSync("sqlite3", ["--version"], { encoding: "utf8" });
  if (version.status !== 0) {
    context.skip("sqlite3 is unavailable");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "open-shed-unproven-round-"));
  const databasePath = join(directory, "continuity.db");
  try {
    const migrationDirectory = join(ROOT, "drizzle");
    const migrations = readdirSync(migrationDirectory)
      .filter((name) => /^000\d_.*\.sql$/u.test(name))
      .sort();
    const continuityIndex = migrations.indexOf("0009_lovely_miek.sql");
    assert.ok(continuityIndex >= 0);
    const beforeContinuity = migrations
      .slice(0, continuityIndex)
      .map((name) => readFileSync(join(migrationDirectory, name), "utf8"))
      .join("\n");
    const continuity = readFileSync(
      join(migrationDirectory, migrations[continuityIndex]),
      "utf8",
    );
    const state = JSON.stringify({
      winner: { playerId: "player-winner", reason: "last_active" },
      players: [
        {
          playerId: "player-winner",
          userId: "user-winner",
          displayName: "Unproven winner",
        },
      ],
    }).replaceAll("'", "''");
    const setup = runSqlite(
      databasePath,
      `${beforeContinuity}
       INSERT INTO profiles VALUES
         ('profile-winner', 'user-winner', 'Current alias', 1, 1);
       INSERT INTO games (
         id, join_code, host_profile_id, rules_version, protocol_version,
         status, version, state_json, state_hash, created_at,
         last_activity_at, expires_at
       ) VALUES (
         'unproven-game', 'NOEVNT', 'profile-winner',
         'merciless-baseline-v1', 1, 'finished', 9,
         '${state}', 'state-hash', 1, 9, 2000000000000
       );
       ${continuity}
       SELECT COUNT(*) AS count FROM game_rounds;`,
      true,
    );
    assert.equal(setup.status, 0, setup.stderr);
    assert.deepEqual(JSON.parse(setup.stdout), [{ count: 0 }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("local runtime backfill also requires event-derived completion facts", () => {
  const backfillStart = RUNTIME_SOURCE.indexOf("WITH eligible_games AS");
  const backfillEnd = RUNTIME_SOURCE.indexOf("FROM valid_completions", backfillStart);
  assert.notEqual(backfillStart, -1);
  assert.notEqual(backfillEnd, -1);
  const backfill = RUNTIME_SOURCE.slice(backfillStart, backfillEnd + 40);

  assert.match(backfill, /JOIN game_events event/u);
  assert.match(backfill, /event\.version BETWEEN 1 AND g\.current_version/u);
  assert.match(backfill, /json_each\([\s\S]*event\.public_payload_json/u);
  assert.match(backfill, /'\$\.type'\) = 'game_won'/u);
  assert.match(backfill, /event\.created_at AS completed_at/u);
  assert.doesNotMatch(backfill, /g\.version,[\s\S]*AS completion_revision/u);
  assert.doesNotMatch(backfill, /updatedAt|last_activity_at/u);
});

function sourceFunction(
  source: string,
  startName: string,
  nextName: string,
): string {
  const start = source.indexOf(`function ${startName}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  assert.notEqual(start, -1, `${startName} is missing`);
  assert.notEqual(end, -1, `${nextName} is missing after ${startName}`);
  return source.slice(start, end);
}

function runSqlite(
  databasePath: string,
  sql: string,
  json = false,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    "sqlite3",
    [...(json ? ["-json"] : []), databasePath],
    { encoding: "utf8", input: sql },
  );
  return {
    status: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

function bindSqliteSql(sql: string, bindings: readonly unknown[]): string {
  let index = 0;
  const bound = sql.replaceAll("?", () => {
    assert.ok(index < bindings.length, "missing SQLite test binding");
    const value = bindings[index];
    index += 1;
    if (typeof value === "number") return String(value);
    if (typeof value !== "string") {
      throw new TypeError("SQLite test bindings must be strings or numbers.");
    }
    return `'${value.replaceAll("'", "''")}'`;
  });
  assert.equal(index, bindings.length, "unused SQLite test binding");
  return bound;
}
