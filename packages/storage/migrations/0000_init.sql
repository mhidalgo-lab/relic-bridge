CREATE TABLE `access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`prefix` text NOT NULL,
	`token_hash` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`grant_id`) REFERENCES `grants`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "access_tokens_hash_check" CHECK(length("access_tokens"."token_hash") = 64 AND "access_tokens"."token_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "access_tokens_prefix_check" CHECK(length("access_tokens"."prefix") <= 12)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_tokens_hash_unique` ON `access_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `access_tokens_grant_idx` ON `access_tokens` (`grant_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
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
	CONSTRAINT "audit_log_kind_check" CHECK("audit_log"."kind" IN ('tool_call', 'admin')),
	CONSTRAINT "audit_log_status_check" CHECK("audit_log"."status" IN ('ok', 'error', 'denied'))
);
--> statement-breakpoint
CREATE INDEX `audit_log_ts_idx` ON `audit_log` (`ts`);--> statement-breakpoint
CREATE INDEX `audit_log_project_ts_idx` ON `audit_log` (`project_id`,`ts`);--> statement-breakpoint
CREATE INDEX `audit_log_user_ts_idx` ON `audit_log` (`user_id`,`ts`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text,
	`label` text NOT NULL,
	`region` text NOT NULL,
	`key_ciphertext` blob NOT NULL,
	`key_iv` blob NOT NULL,
	`key_version` integer NOT NULL,
	`key_hint` text,
	`validation_status` text DEFAULT 'unvalidated' NOT NULL,
	`validation_error_code` text,
	`validated_at` integer,
	`nr_user_id` integer,
	`nr_user_email` text,
	`reachable_account_ids` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "credentials_region_check" CHECK("credentials"."region" IN ('US', 'EU', 'JP')),
	CONSTRAINT "credentials_validation_status_check" CHECK("credentials"."validation_status" IN ('unvalidated', 'valid', 'invalid')),
	CONSTRAINT "credentials_key_version_check" CHECK("credentials"."key_version" > 0),
	CONSTRAINT "credentials_key_iv_check" CHECK(length("credentials"."key_iv") = 12),
	CONSTRAINT "credentials_key_hint_check" CHECK("credentials"."key_hint" IS NULL OR length("credentials"."key_hint") <= 4)
);
--> statement-breakpoint
CREATE INDEX `credentials_owner_idx` ON `credentials` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `grants` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text,
	`label` text,
	`credential_id` text,
	`tools` text,
	`account_ids` text,
	`limits` text NOT NULL,
	`rate_limit` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "grants_principal_check" CHECK("grants"."user_id" IS NOT NULL OR "grants"."label" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `grants_project_idx` ON `grants` (`project_id`);--> statement-breakpoint
CREATE INDEX `grants_user_idx` ON `grants` (`user_id`);--> statement-breakpoint
CREATE INDEX `grants_credential_idx` ON `grants` (`credential_id`);--> statement-breakpoint
CREATE TABLE `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE INDEX `kv_expires_idx` ON `kv` (`expires_at`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text,
	`default_account_id` integer NOT NULL,
	`allowed_account_ids` text NOT NULL,
	`enabled_tools` text,
	`limits` text NOT NULL,
	`default_credential_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`disabled_at` integer,
	FOREIGN KEY (`default_credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE INDEX `projects_default_credential_idx` ON `projects` (`default_credential_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`idp` text,
	`idp_subject` text,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`disabled_at` integer,
	CONSTRAINT "users_role_check" CHECK("users"."role" IN ('owner', 'admin', 'member')),
	CONSTRAINT "users_email_lower_check" CHECK("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_identity_unique` ON `users` (`idp`,`idp_subject`);