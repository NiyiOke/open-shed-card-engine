import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL("../drizzle/0011_dazzling_hemingway.sql", import.meta.url),
  ),
  "utf8",
);

test("migration backfills deterministic positions for legacy same-ms messages", () => {
  using database = legacyDatabase();
  const createdAt = 1_786_970_000_000;
  const laterId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const earlierId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  insertMessage(database, laterId, "game-a", createdAt);
  insertMessage(database, earlierId, "game-a", createdAt);

  applyMigration(database);

  assert.deepEqual(readFeed(database, "game-a"), [earlierId, laterId]);
  assert.deepEqual(
    (database
      .prepare(
        `SELECT cursor_id AS cursorId, sequence
         FROM game_message_cursors ORDER BY sequence`,
      )
      .all() as { cursorId: string; sequence: number }[]).map((row) => ({
        cursorId: row.cursorId,
        sequence: row.sequence,
      })),
    [
      { cursorId: earlierId, sequence: 1 },
      { cursorId: laterId, sequence: 2 },
    ],
  );
});

test("same-millisecond commits follow D1 allocation order rather than random ID order", () => {
  using database = migratedDatabase();
  const createdAt = 1_786_970_001_000;
  const firstCommitted = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const secondCommitted = "11111111111111111111111111111111";

  commitMessage(database, firstCommitted, "game-a", createdAt);
  commitMessage(database, secondCommitted, "game-a", createdAt);

  assert.ok(secondCommitted < firstCommitted, "fixture must oppose lexical order");
  assert.deepEqual(readFeed(database, "game-a"), [firstCommitted, secondCommitted]);
});

test("a cursor remains usable after its one-day message row is removed", () => {
  using database = migratedDatabase();
  const expiredId = "22222222222222222222222222222222";
  const nextId = "33333333333333333333333333333333";
  commitMessage(database, expiredId, "game-a", 1_786_970_002_000);
  const expiredPosition = database
    .prepare(
      `SELECT sequence FROM game_message_cursors
       WHERE game_id = ? AND cursor_id = ?`,
    )
    .get("game-a", expiredId) as { sequence: number };

  database.prepare("DELETE FROM game_messages WHERE id = ?").run(expiredId);
  commitMessage(database, nextId, "game-a", 1_786_970_003_000);

  assert.deepEqual(
    (database
      .prepare(
        `SELECT message.id
         FROM game_messages message
         JOIN game_message_cursors position
           ON position.cursor_id = message.id
          AND position.game_id = message.game_id
         WHERE message.game_id = ? AND position.sequence > ?
         ORDER BY position.sequence`,
      )
      .all("game-a", expiredPosition.sequence) as { id: string }[]).map(
        ({ id }) => ({ id }),
      ),
    [{ id: nextId }],
  );
});

test("initial and rebased reads return the latest bounded window chronologically", () => {
  using database = migratedDatabase();
  const ids = Array.from({ length: 60 }, (_, index) => opaqueId(index + 1));
  for (const [index, id] of ids.entries()) {
    commitMessage(database, id, "game-a", 1_786_970_100_000 + index);
  }

  const descendingWindow = database
    .prepare(
      `SELECT message.id
       FROM game_messages message
       JOIN game_message_cursors position
         ON position.cursor_id = message.id
        AND position.game_id = message.game_id
       WHERE message.game_id = ?
       ORDER BY position.sequence DESC
       LIMIT ?`,
    )
    .all("game-a", 48) as { id: string }[];
  const chronologicalWindow = descendingWindow.reverse().map(({ id }) => id);

  assert.deepEqual(chronologicalWindow, ids.slice(-48));
  assert.equal(chronologicalWindow.at(-1), ids.at(-1));
});

function legacyDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(
    `CREATE TABLE game_messages (
       id TEXT PRIMARY KEY NOT NULL,
       game_id TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
  );
  return database;
}

function migratedDatabase(): DatabaseSync {
  const database = legacyDatabase();
  applyMigration(database);
  return database;
}

function applyMigration(database: DatabaseSync): void {
  for (const statement of MIGRATION.split("--> statement-breakpoint")) {
    const sql = statement.trim();
    if (sql) database.exec(sql);
  }
}

function insertMessage(
  database: DatabaseSync,
  id: string,
  gameId: string,
  createdAt: number,
): void {
  database
    .prepare(
      "INSERT INTO game_messages (id, game_id, created_at) VALUES (?, ?, ?)",
    )
    .run(id, gameId, createdAt);
}

function commitMessage(
  database: DatabaseSync,
  id: string,
  gameId: string,
  createdAt: number,
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `INSERT INTO game_message_cursors (cursor_id, game_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(id, gameId, createdAt);
    insertMessage(database, id, gameId, createdAt);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function readFeed(database: DatabaseSync, gameId: string): string[] {
  return (
    database
      .prepare(
        `SELECT message.id
         FROM game_messages message
         JOIN game_message_cursors position
           ON position.cursor_id = message.id
          AND position.game_id = message.game_id
         WHERE message.game_id = ?
         ORDER BY position.sequence`,
      )
      .all(gameId) as { id: string }[]
  ).map(({ id }) => id);
}

function opaqueId(value: number): string {
  return value.toString(16).padStart(32, "0");
}
