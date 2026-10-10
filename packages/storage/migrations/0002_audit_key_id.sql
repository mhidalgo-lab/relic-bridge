ALTER TABLE `audit_log` ADD `key_id` text;--> statement-breakpoint
CREATE INDEX `audit_log_key_ts_idx` ON `audit_log` (`key_id`,`ts`);