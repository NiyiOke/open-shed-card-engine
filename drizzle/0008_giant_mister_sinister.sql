CREATE TABLE `live_voice_cleanup_jobs` (
	`job_key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`game_id` text NOT NULL,
	`player_id` text,
	`requested_at` integer NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_live_voice_cleanup_due` ON `live_voice_cleanup_jobs` (`next_attempt_at`,`job_key`);--> statement-breakpoint
CREATE INDEX `idx_live_voice_cleanup_game` ON `live_voice_cleanup_jobs` (`game_id`,`job_key`);--> statement-breakpoint
CREATE INDEX `idx_live_voice_cleanup_expiry` ON `live_voice_cleanup_jobs` (`expires_at`);