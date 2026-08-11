CREATE TABLE `public_game_listings` (
	`game_id` text PRIMARY KEY NOT NULL,
	`listing_id` text NOT NULL,
	`owner_profile_id` text NOT NULL,
	`state` text NOT NULL,
	`pace` text NOT NULL,
	`version` integer NOT NULL,
	`event_floor_version` integer NOT NULL,
	`published_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`unlisted_at` integer,
	`close_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_public_game_listings_listing_id` ON `public_game_listings` (`listing_id`);--> statement-breakpoint
CREATE INDEX `idx_public_game_listings_state_updated` ON `public_game_listings` (`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_public_game_listings_owner` ON `public_game_listings` (`owner_profile_id`);--> statement-breakpoint
ALTER TABLE `game_members` ADD `event_floor_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_games_room_status_closed` ON `games` (`room_status`,`closed_at`);