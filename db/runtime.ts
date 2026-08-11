import { getRawDb } from "./index";

let schemaPromise: Promise<void> | null = null;

export async function ensureDatabaseSchema(): Promise<D1Database> {
  const database = getRawDb();
  schemaPromise ??= initialize(database).catch((error) => {
    schemaPromise = null;
    throw error;
  });
  await schemaPromise;
  return database;
}

async function initialize(database: D1Database): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY NOT NULL,
      auth_subject TEXT NOT NULL,
      nickname TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_auth_subject
      ON profiles(auth_subject)`,
    `CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY NOT NULL,
      join_code TEXT NOT NULL,
      host_profile_id TEXT NOT NULL,
      rules_version TEXT NOT NULL,
      protocol_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      state_json TEXT NOT NULL,
      state_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_games_join_code
      ON games(join_code)`,
    `CREATE INDEX IF NOT EXISTS idx_games_status_activity
      ON games(status, last_activity_at)`,
    `CREATE INDEX IF NOT EXISTS idx_games_expiry
      ON games(expires_at)`,
    `CREATE TABLE IF NOT EXISTS game_members (
      game_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      seat INTEGER NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      left_at INTEGER,
      PRIMARY KEY (game_id, profile_id)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_game_members_seat
      ON game_members(game_id, seat)`,
    `CREATE INDEX IF NOT EXISTS idx_game_members_profile
      ON game_members(profile_id)`,
    `CREATE TABLE IF NOT EXISTS game_presence (
      game_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (game_id, player_id)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_game_presence_profile
      ON game_presence(game_id, profile_id)`,
    `CREATE INDEX IF NOT EXISTS idx_game_presence_activity
      ON game_presence(game_id, last_seen_at)`,
    `CREATE TABLE IF NOT EXISTS game_events (
      game_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      command_id TEXT NOT NULL,
      actor_profile_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      public_payload_json TEXT NOT NULL,
      state_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (game_id, version)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_game_events_command
      ON game_events(game_id, command_id)`,
    `CREATE TABLE IF NOT EXISTS command_receipts (
      actor_profile_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (actor_profile_id, command_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_command_receipts_game
      ON command_receipts(game_id)`,
    `CREATE TABLE IF NOT EXISTS mutation_quotas (
      scope TEXT NOT NULL,
      bucket_start INTEGER NOT NULL,
      count INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (scope, bucket_start)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_mutation_quotas_expiry
      ON mutation_quotas(expires_at)`,
  ];

  await database.batch(
    statements.map((statement) => database.prepare(statement)),
  );
  await database.prepare("PRAGMA optimize").run();
}
