CREATE TABLE `game_presence` (
	`game_id` text NOT NULL,
	`player_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`last_seen_at` integer NOT NULL,
	PRIMARY KEY(`game_id`, `player_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_game_presence_profile` ON `game_presence` (`game_id`,`profile_id`);--> statement-breakpoint
CREATE INDEX `idx_game_presence_activity` ON `game_presence` (`game_id`,`last_seen_at`);