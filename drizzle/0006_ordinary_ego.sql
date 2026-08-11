CREATE TABLE `game_message_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`message_id` text NOT NULL,
	`reporter_profile_id` text NOT NULL,
	`reported_profile_id` text NOT NULL,
	`evidence_sender_player_id` text NOT NULL,
	`evidence_sender_display_name` text NOT NULL,
	`evidence_kind` text NOT NULL,
	`evidence_content_id` text NOT NULL,
	`evidence_created_at` integer NOT NULL,
	`reason` text NOT NULL,
	`moderation_state` text DEFAULT 'pending' NOT NULL,
	`command_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_game_message_reports_review` ON `game_message_reports` (`moderation_state`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_game_message_reports_expiry` ON `game_message_reports` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_game_message_reports_reporter_command` ON `game_message_reports` (`reporter_profile_id`,`command_id`);--> statement-breakpoint
CREATE TABLE `game_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`sender_profile_id` text NOT NULL,
	`sender_player_id` text NOT NULL,
	`sender_display_name` text NOT NULL,
	`kind` text NOT NULL,
	`content_id` text NOT NULL,
	`command_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_game_messages_feed` ON `game_messages` (`game_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_game_messages_expiry` ON `game_messages` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_game_messages_sender_command` ON `game_messages` (`sender_profile_id`,`command_id`);--> statement-breakpoint
CREATE TABLE `game_mutes` (
	`game_id` text NOT NULL,
	`muter_profile_id` text NOT NULL,
	`muted_profile_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`game_id`, `muter_profile_id`, `muted_profile_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_game_mutes_muted` ON `game_mutes` (`game_id`,`muted_profile_id`);