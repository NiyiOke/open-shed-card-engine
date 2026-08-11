CREATE TABLE `profile_blocks` (
	`blocker_profile_id` text NOT NULL,
	`blocked_profile_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`blocker_profile_id`, `blocked_profile_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_profile_blocks_blocked` ON `profile_blocks` (`blocked_profile_id`);--> statement-breakpoint
ALTER TABLE `game_members` ADD `public_discovery_consent_at` integer;--> statement-breakpoint
ALTER TABLE `game_members` ADD `join_source` text;--> statement-breakpoint
ALTER TABLE `games` ADD `room_status` text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE `games` ADD `closed_at` integer;--> statement-breakpoint
ALTER TABLE `games` ADD `close_reason` text;--> statement-breakpoint
ALTER TABLE `games` ADD `abandoned_since` integer;--> statement-breakpoint
CREATE INDEX `idx_games_room_status_abandoned` ON `games` (`room_status`,`abandoned_since`);