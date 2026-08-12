CREATE TABLE `game_message_receipts` (
	`game_id` text NOT NULL,
	`message_id` text NOT NULL,
	`recipient_profile_id` text NOT NULL,
	`received_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`recipient_profile_id`, `message_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_game_message_receipts_game` ON `game_message_receipts` (`game_id`);--> statement-breakpoint
CREATE INDEX `idx_game_message_receipts_expiry` ON `game_message_receipts` (`expires_at`);--> statement-breakpoint
ALTER TABLE `game_message_reports` ADD `evidence_body_text` text;--> statement-breakpoint
ALTER TABLE `game_messages` ADD `body_text` text;--> statement-breakpoint
ALTER TABLE `games` ADD `communication_scope` text DEFAULT 'invite_only' NOT NULL;--> statement-breakpoint
UPDATE `games`
SET `communication_scope` = 'public_safe'
WHERE `communication_scope` = 'invite_only'
  AND (
    EXISTS (
      SELECT 1 FROM `public_game_listings` AS `listing`
      WHERE `listing`.`game_id` = `games`.`id`
    )
    OR EXISTS (
      SELECT 1 FROM `game_members` AS `member`
      WHERE `member`.`game_id` = `games`.`id`
        AND `member`.`join_source` = 'public'
    )
  );
