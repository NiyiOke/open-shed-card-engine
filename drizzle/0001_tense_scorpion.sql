CREATE TABLE `command_receipts` (
	`actor_profile_id` text NOT NULL,
	`command_id` text NOT NULL,
	`game_id` text NOT NULL,
	`operation` text NOT NULL,
	`request_hash` text NOT NULL,
	`result_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`actor_profile_id`, `command_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_command_receipts_game` ON `command_receipts` (`game_id`);--> statement-breakpoint
CREATE INDEX `idx_games_expiry` ON `games` (`expires_at`);