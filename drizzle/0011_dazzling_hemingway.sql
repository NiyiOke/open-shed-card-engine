CREATE TABLE `game_message_cursors` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cursor_id` text NOT NULL,
	`game_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_game_message_cursors_id` ON `game_message_cursors` (`cursor_id`);--> statement-breakpoint
CREATE INDEX `idx_game_message_cursors_feed` ON `game_message_cursors` (`game_id`,`sequence`);--> statement-breakpoint
INSERT OR IGNORE INTO `game_message_cursors` (
	`cursor_id`, `game_id`, `created_at`
)
SELECT `id`, `game_id`, `created_at`
FROM `game_messages`
ORDER BY `created_at`, `id`;
