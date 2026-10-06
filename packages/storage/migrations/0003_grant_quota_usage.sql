CREATE TABLE `grant_usage` (
	`grant_id` text NOT NULL,
	`period` text NOT NULL,
	`queries` integer DEFAULT 0 NOT NULL,
	`inspected` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`grant_id`, `period`),
	FOREIGN KEY (`grant_id`) REFERENCES `grants`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "grant_usage_counts_check" CHECK("grant_usage"."queries" >= 0 AND "grant_usage"."inspected" >= 0)
);
--> statement-breakpoint
CREATE INDEX `grant_usage_updated_idx` ON `grant_usage` (`updated_at`);--> statement-breakpoint
ALTER TABLE `grants` ADD `quota` text;