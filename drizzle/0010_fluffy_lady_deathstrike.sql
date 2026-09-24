CREATE TABLE `lobby_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`sender_profile_id` text NOT NULL,
	`recipient_profile_id` text NOT NULL,
	`recipient_presence_id` text NOT NULL,
	`game_id` text NOT NULL,
	`sender_alias` text NOT NULL,
	`command_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`pending_key` text,
	`state` text NOT NULL,
	`response_command_id` text,
	`response_action` text,
	`response_request_hash` text,
	`accepted_alias` text,
	`accepted_revision` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`responded_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lobby_invitations_sender_command` ON `lobby_invitations` (`sender_profile_id`,`command_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lobby_invitations_recipient_response_command` ON `lobby_invitations` (`recipient_profile_id`,`response_command_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lobby_invitations_pending_key` ON `lobby_invitations` (`pending_key`);--> statement-breakpoint
CREATE INDEX `idx_lobby_invitations_recipient_feed` ON `lobby_invitations` (`recipient_profile_id`,`state`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_lobby_invitations_game` ON `lobby_invitations` (`game_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_lobby_invitations_expiry` ON `lobby_invitations` (`expires_at`);--> statement-breakpoint
CREATE TABLE `lobby_presence` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`presence_id` text NOT NULL,
	`alias` text NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lobby_presence_locator` ON `lobby_presence` (`presence_id`);--> statement-breakpoint
CREATE INDEX `idx_lobby_presence_expiry` ON `lobby_presence` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_lobby_presence_activity` ON `lobby_presence` (`last_seen_at`);--> statement-breakpoint
CREATE TABLE `lobby_presence_receipts` (
	`actor_profile_id` text NOT NULL,
	`command_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`actor_profile_id`, `command_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_lobby_presence_receipts_expiry` ON `lobby_presence_receipts` (`expires_at`);