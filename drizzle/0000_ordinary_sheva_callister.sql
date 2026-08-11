CREATE TABLE `game_events` (
	`game_id` text NOT NULL,
	`version` integer NOT NULL,
	`command_id` text NOT NULL,
	`actor_profile_id` text NOT NULL,
	`kind` text NOT NULL,
	`public_payload_json` text NOT NULL,
	`state_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`game_id`, `version`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_game_events_command` ON `game_events` (`game_id`,`command_id`);--> statement-breakpoint
CREATE TABLE `game_members` (
	`game_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`seat` integer NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`joined_at` integer NOT NULL,
	`left_at` integer,
	PRIMARY KEY(`game_id`, `profile_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_game_members_seat` ON `game_members` (`game_id`,`seat`);--> statement-breakpoint
CREATE INDEX `idx_game_members_profile` ON `game_members` (`profile_id`);--> statement-breakpoint
CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`join_code` text NOT NULL,
	`host_profile_id` text NOT NULL,
	`rules_version` text NOT NULL,
	`protocol_version` integer NOT NULL,
	`status` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`state_json` text NOT NULL,
	`state_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_games_join_code` ON `games` (`join_code`);--> statement-breakpoint
CREATE INDEX `idx_games_status_activity` ON `games` (`status`,`last_activity_at`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`auth_subject` text NOT NULL,
	`nickname` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_profiles_auth_subject` ON `profiles` (`auth_subject`);