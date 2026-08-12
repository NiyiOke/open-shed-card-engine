import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const profiles = sqliteTable(
  "profiles",
  {
    id: text("id").primaryKey(),
    authSubject: text("auth_subject").notNull(),
    nickname: text("nickname").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("idx_profiles_auth_subject").on(table.authSubject)],
);

export const games = sqliteTable(
  "games",
  {
    id: text("id").primaryKey(),
    joinCode: text("join_code").notNull(),
    hostProfileId: text("host_profile_id").notNull(),
    rulesVersion: text("rules_version").notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    status: text("status").notNull(),
    roomStatus: text("room_status").notNull().default("open"),
    closedAt: integer("closed_at"),
    closeReason: text("close_reason"),
    abandonedSince: integer("abandoned_since"),
    communicationScope: text("communication_scope")
      .notNull()
      .default("invite_only"),
    version: integer("version").notNull().default(0),
    stateJson: text("state_json").notNull(),
    stateHash: text("state_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    lastActivityAt: integer("last_activity_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_games_join_code").on(table.joinCode),
    index("idx_games_status_activity").on(table.status, table.lastActivityAt),
    index("idx_games_room_status_abandoned").on(
      table.roomStatus,
      table.abandonedSince,
    ),
    index("idx_games_room_status_closed").on(
      table.roomStatus,
      table.closedAt,
    ),
    index("idx_games_expiry").on(table.expiresAt),
  ],
);

export const gameMembers = sqliteTable(
  "game_members",
  {
    gameId: text("game_id").notNull(),
    profileId: text("profile_id").notNull(),
    seat: integer("seat").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull(),
    joinedAt: integer("joined_at").notNull(),
    leftAt: integer("left_at"),
    publicDiscoveryConsentAt: integer("public_discovery_consent_at"),
    joinSource: text("join_source"),
    eventFloorVersion: integer("event_floor_version").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.gameId, table.profileId] }),
    uniqueIndex("idx_game_members_seat").on(table.gameId, table.seat),
    index("idx_game_members_profile").on(table.profileId),
  ],
);

export const publicGameListings = sqliteTable(
  "public_game_listings",
  {
    gameId: text("game_id").primaryKey(),
    listingId: text("listing_id").notNull(),
    ownerProfileId: text("owner_profile_id").notNull(),
    state: text("state").notNull(),
    pace: text("pace").notNull(),
    version: integer("version").notNull(),
    eventFloorVersion: integer("event_floor_version").notNull(),
    publishedAt: integer("published_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    unlistedAt: integer("unlisted_at"),
    closeReason: text("close_reason"),
  },
  (table) => [
    uniqueIndex("idx_public_game_listings_listing_id").on(table.listingId),
    index("idx_public_game_listings_state_updated").on(
      table.state,
      table.updatedAt,
    ),
    index("idx_public_game_listings_owner").on(table.ownerProfileId),
  ],
);

export const profileBlocks = sqliteTable(
  "profile_blocks",
  {
    blockerProfileId: text("blocker_profile_id").notNull(),
    blockedProfileId: text("blocked_profile_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockerProfileId, table.blockedProfileId] }),
    index("idx_profile_blocks_blocked").on(table.blockedProfileId),
  ],
);

export const gameMessages = sqliteTable(
  "game_messages",
  {
    id: text("id").primaryKey(),
    gameId: text("game_id").notNull(),
    senderProfileId: text("sender_profile_id").notNull(),
    senderPlayerId: text("sender_player_id").notNull(),
    senderDisplayName: text("sender_display_name").notNull(),
    kind: text("kind").notNull(),
    contentId: text("content_id").notNull(),
    bodyText: text("body_text"),
    commandId: text("command_id").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("idx_game_messages_feed").on(
      table.gameId,
      table.createdAt,
      table.id,
    ),
    index("idx_game_messages_expiry").on(table.expiresAt),
    uniqueIndex("idx_game_messages_sender_command").on(
      table.senderProfileId,
      table.commandId,
    ),
  ],
);

export const gameMessageReports = sqliteTable(
  "game_message_reports",
  {
    id: text("id").primaryKey(),
    gameId: text("game_id").notNull(),
    messageId: text("message_id").notNull(),
    reporterProfileId: text("reporter_profile_id").notNull(),
    reportedProfileId: text("reported_profile_id").notNull(),
    evidenceSenderPlayerId: text("evidence_sender_player_id").notNull(),
    evidenceSenderDisplayName: text("evidence_sender_display_name").notNull(),
    evidenceKind: text("evidence_kind").notNull(),
    evidenceContentId: text("evidence_content_id").notNull(),
    evidenceBodyText: text("evidence_body_text"),
    evidenceCreatedAt: integer("evidence_created_at").notNull(),
    reason: text("reason").notNull(),
    moderationState: text("moderation_state").notNull().default("pending"),
    commandId: text("command_id").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("idx_game_message_reports_review").on(
      table.moderationState,
      table.createdAt,
    ),
    index("idx_game_message_reports_expiry").on(table.expiresAt),
    uniqueIndex("idx_game_message_reports_reporter_command").on(
      table.reporterProfileId,
      table.commandId,
    ),
  ],
);

export const gameMessageReceipts = sqliteTable(
  "game_message_receipts",
  {
    gameId: text("game_id").notNull(),
    messageId: text("message_id").notNull(),
    recipientProfileId: text("recipient_profile_id").notNull(),
    receivedAt: integer("received_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.recipientProfileId, table.messageId] }),
    index("idx_game_message_receipts_game").on(table.gameId),
    index("idx_game_message_receipts_expiry").on(table.expiresAt),
  ],
);

export const gameMutes = sqliteTable(
  "game_mutes",
  {
    gameId: text("game_id").notNull(),
    muterProfileId: text("muter_profile_id").notNull(),
    mutedProfileId: text("muted_profile_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.gameId, table.muterProfileId, table.mutedProfileId],
    }),
    index("idx_game_mutes_muted").on(table.gameId, table.mutedProfileId),
  ],
);

export const liveVoiceCleanupJobs = sqliteTable(
  "live_voice_cleanup_jobs",
  {
    jobKey: text("job_key").primaryKey(),
    kind: text("kind").notNull(),
    gameId: text("game_id").notNull(),
    playerId: text("player_id"),
    requestedAt: integer("requested_at").notNull(),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("idx_live_voice_cleanup_due").on(
      table.nextAttemptAt,
      table.jobKey,
    ),
    index("idx_live_voice_cleanup_game").on(table.gameId, table.jobKey),
    index("idx_live_voice_cleanup_expiry").on(table.expiresAt),
  ],
);

export const gamePresence = sqliteTable(
  "game_presence",
  {
    gameId: text("game_id").notNull(),
    playerId: text("player_id").notNull(),
    profileId: text("profile_id").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.gameId, table.playerId] }),
    uniqueIndex("idx_game_presence_profile").on(table.gameId, table.profileId),
    index("idx_game_presence_activity").on(table.gameId, table.lastSeenAt),
  ],
);

export const gameEvents = sqliteTable(
  "game_events",
  {
    gameId: text("game_id").notNull(),
    version: integer("version").notNull(),
    commandId: text("command_id").notNull(),
    actorProfileId: text("actor_profile_id").notNull(),
    kind: text("kind").notNull(),
    publicPayloadJson: text("public_payload_json").notNull(),
    stateHash: text("state_hash").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.gameId, table.version] }),
    uniqueIndex("idx_game_events_command").on(table.gameId, table.commandId),
  ],
);

export const commandReceipts = sqliteTable(
  "command_receipts",
  {
    actorProfileId: text("actor_profile_id").notNull(),
    commandId: text("command_id").notNull(),
    gameId: text("game_id").notNull(),
    operation: text("operation").notNull(),
    requestHash: text("request_hash").notNull(),
    resultVersion: integer("result_version").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.actorProfileId, table.commandId] }),
    index("idx_command_receipts_game").on(table.gameId),
  ],
);

export const mutationQuotas = sqliteTable(
  "mutation_quotas",
  {
    scope: text("scope").notNull(),
    bucketStart: integer("bucket_start").notNull(),
    count: integer("count").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.bucketStart] }),
    index("idx_mutation_quotas_expiry").on(table.expiresAt),
  ],
);
