CREATE TABLE `mutation_quotas` (
	`scope` text NOT NULL,
	`bucket_start` integer NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `bucket_start`)
);
--> statement-breakpoint
CREATE INDEX `idx_mutation_quotas_expiry` ON `mutation_quotas` (`expires_at`);