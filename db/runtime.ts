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
      room_status TEXT NOT NULL DEFAULT 'open',
      closed_at INTEGER,
      close_reason TEXT,
      abandoned_since INTEGER,
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
      public_discovery_consent_at INTEGER,
      join_source TEXT,
      event_floor_version INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (game_id, profile_id)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_game_members_seat
      ON game_members(game_id, seat)`,
    `CREATE INDEX IF NOT EXISTS idx_game_members_profile
      ON game_members(profile_id)`,
    `CREATE TABLE IF NOT EXISTS public_game_listings (
      game_id TEXT PRIMARY KEY NOT NULL,
      listing_id TEXT NOT NULL,
      owner_profile_id TEXT NOT NULL,
      state TEXT NOT NULL,
      pace TEXT NOT NULL,
      version INTEGER NOT NULL,
      event_floor_version INTEGER NOT NULL,
      published_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      unlisted_at INTEGER,
      close_reason TEXT
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_public_game_listings_listing_id
      ON public_game_listings(listing_id)`,
    `CREATE INDEX IF NOT EXISTS idx_public_game_listings_state_updated
      ON public_game_listings(state, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_public_game_listings_owner
      ON public_game_listings(owner_profile_id)`,
    `CREATE TABLE IF NOT EXISTS profile_blocks (
      blocker_profile_id TEXT NOT NULL,
      blocked_profile_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (blocker_profile_id, blocked_profile_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_profile_blocks_blocked
      ON profile_blocks(blocked_profile_id)`,
    `CREATE TABLE IF NOT EXISTS game_messages (
      id TEXT PRIMARY KEY NOT NULL,
      game_id TEXT NOT NULL,
      sender_profile_id TEXT NOT NULL,
      sender_player_id TEXT NOT NULL,
      sender_display_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      content_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_game_messages_feed
      ON game_messages(game_id, created_at, id)`,
    `CREATE INDEX IF NOT EXISTS idx_game_messages_expiry
      ON game_messages(expires_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_game_messages_sender_command
      ON game_messages(sender_profile_id, command_id)`,
    `CREATE TABLE IF NOT EXISTS game_message_reports (
      id TEXT PRIMARY KEY NOT NULL,
      game_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      reporter_profile_id TEXT NOT NULL,
      reported_profile_id TEXT NOT NULL,
      evidence_sender_player_id TEXT NOT NULL,
      evidence_sender_display_name TEXT NOT NULL,
      evidence_kind TEXT NOT NULL,
      evidence_content_id TEXT NOT NULL,
      evidence_created_at INTEGER NOT NULL,
      reason TEXT NOT NULL,
      moderation_state TEXT NOT NULL DEFAULT 'pending',
      command_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_game_message_reports_review
      ON game_message_reports(moderation_state, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_game_message_reports_expiry
      ON game_message_reports(expires_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_game_message_reports_reporter_command
      ON game_message_reports(reporter_profile_id, command_id)`,
    `CREATE TABLE IF NOT EXISTS game_mutes (
      game_id TEXT NOT NULL,
      muter_profile_id TEXT NOT NULL,
      muted_profile_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (game_id, muter_profile_id, muted_profile_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_game_mutes_muted
      ON game_mutes(game_id, muted_profile_id)`,
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
  await ensureColumn(
    database,
    "games",
    "room_status",
    "ALTER TABLE games ADD COLUMN room_status TEXT NOT NULL DEFAULT 'open'",
  );
  await ensureColumn(
    database,
    "games",
    "closed_at",
    "ALTER TABLE games ADD COLUMN closed_at INTEGER",
  );
  await ensureColumn(
    database,
    "games",
    "close_reason",
    "ALTER TABLE games ADD COLUMN close_reason TEXT",
  );
  await ensureColumn(
    database,
    "games",
    "abandoned_since",
    "ALTER TABLE games ADD COLUMN abandoned_since INTEGER",
  );
  await ensureColumn(
    database,
    "game_members",
    "public_discovery_consent_at",
    "ALTER TABLE game_members ADD COLUMN public_discovery_consent_at INTEGER",
  );
  await ensureColumn(
    database,
    "game_members",
    "join_source",
    "ALTER TABLE game_members ADD COLUMN join_source TEXT",
  );
  await ensureColumn(
    database,
    "game_members",
    "event_floor_version",
    "ALTER TABLE game_members ADD COLUMN event_floor_version INTEGER NOT NULL DEFAULT 0",
  );
  await database
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_games_room_status_abandoned
       ON games(room_status, abandoned_since)`,
    )
    .run();
  await database
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_games_room_status_closed
       ON games(room_status, closed_at)`,
    )
    .run();
  await database.prepare("PRAGMA optimize").run();
}

async function ensureColumn(
  database: D1Database,
  table: "games" | "game_members",
  column: string,
  alterStatement: string,
): Promise<void> {
  const columns = await database
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>();
  if (columns.results.some((entry) => entry.name === column)) return;
  try {
    await database.prepare(alterStatement).run();
  } catch (error) {
    // Another isolate may have initialized the same legacy database first.
    const refreshed = await database
      .prepare(`PRAGMA table_info(${table})`)
      .all<{ name: string }>();
    if (refreshed.results.some((entry) => entry.name === column)) return;
    throw error;
  }
}
