PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`kind` text NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`request_id` text,
	`user_id` text,
	`grant_id` text,
	`token_id` text,
	`client_id` text,
	`project_id` text,
	`account_ids` text,
	`nrql` text,
	`duration_ms` integer,
	`inspected_count` integer,
	`error_code` text,
	`target_type` text,
	`target_id` text,
	`details` text,
	CONSTRAINT "audit_log_kind_check" CHECK("__new_audit_log"."kind" IN ('tool_call', 'admin', 'auth')),
	CONSTRAINT "audit_log_status_check" CHECK("__new_audit_log"."status" IN ('ok', 'error', 'denied'))
);
--> statement-breakpoint
INSERT INTO `__new_audit_log`("id", "ts", "kind", "action", "status", "request_id", "user_id", "grant_id", "token_id", "client_id", "project_id", "account_ids", "nrql", "duration_ms", "inspected_count", "error_code", "target_type", "target_id", "details") SELECT "id", "ts", "kind", "action", "status", "request_id", "user_id", "grant_id", "token_id", "client_id", "project_id", "account_ids", "nrql", "duration_ms", "inspected_count", "error_code", "target_type", "target_id", "details" FROM `audit_log`;--> statement-breakpoint
DROP TABLE `audit_log`;--> statement-breakpoint
ALTER TABLE `__new_audit_log` RENAME TO `audit_log`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `audit_log_ts_idx` ON `audit_log` (`ts`);--> statement-breakpoint
CREATE INDEX `audit_log_project_ts_idx` ON `audit_log` (`project_id`,`ts`);--> statement-breakpoint
CREATE INDEX `audit_log_user_ts_idx` ON `audit_log` (`user_id`,`ts`);