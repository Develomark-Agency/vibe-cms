CREATE TABLE `vibe_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`folder` text,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`meta` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `vibe_assets_folder` ON `vibe_assets` (`folder`,`created_at`);--> statement-breakpoint
CREATE TABLE `vibe_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vibe_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vibe_documents` (
	`id` text NOT NULL,
	`type` text NOT NULL,
	`locale` text NOT NULL,
	`draft` text NOT NULL,
	`published` text,
	`published_ver` integer,
	`schema_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`published_at` integer,
	`updated_by` text,
	PRIMARY KEY(`id`, `locale`)
);
--> statement-breakpoint
CREATE INDEX `vibe_documents_type` ON `vibe_documents` (`type`,`locale`,`updated_at`);--> statement-breakpoint
CREATE TABLE `vibe_folders` (
	`path` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vibe_invites` (
	`hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vibe_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vibe_oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`secret_hash` text,
	`name` text NOT NULL,
	`uri` text,
	`redirect_uris` text NOT NULL,
	`auth_method` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vibe_oauth_codes` (
	`hash` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`challenge` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vibe_oauth_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user` text NOT NULL,
	`payload` text NOT NULL,
	`scope` text NOT NULL,
	`access_hash` text,
	`access_expires_at` integer,
	`refresh_hash` text,
	`refresh_expires_at` integer,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vibe_oauth_grants_access_hash_unique` ON `vibe_oauth_grants` (`access_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `vibe_oauth_grants_refresh_hash_unique` ON `vibe_oauth_grants` (`refresh_hash`);--> statement-breakpoint
CREATE TABLE `vibe_oauth_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`challenge` text NOT NULL,
	`state` text,
	`scope` text NOT NULL,
	`user` text,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vibe_passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer NOT NULL,
	`transports` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE TABLE `vibe_schedules` (
	`id` text NOT NULL,
	`locale` text NOT NULL,
	`ver` integer,
	`action` text NOT NULL,
	`run_at` integer NOT NULL,
	`created_by` text NOT NULL,
	PRIMARY KEY(`id`, `locale`, `action`)
);
--> statement-breakpoint
CREATE INDEX `vibe_schedules_run_at` ON `vibe_schedules` (`run_at`);--> statement-breakpoint
CREATE TABLE `vibe_signins` (
	`hash` text PRIMARY KEY NOT NULL,
	`identity` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vibe_trash` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`type` text,
	`item_id` text NOT NULL,
	`locale` text,
	`label` text NOT NULL,
	`payload` text NOT NULL,
	`deleted_at` integer NOT NULL,
	`deleted_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `vibe_trash_deleted_at` ON `vibe_trash` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `vibe_trash_item` ON `vibe_trash` (`item_id`);--> statement-breakpoint
CREATE TABLE `vibe_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`roles` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`last_sign_in_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vibe_users_email_unique` ON `vibe_users` (`email`);--> statement-breakpoint
CREATE TABLE `vibe_versions` (
	`id` text NOT NULL,
	`locale` text NOT NULL,
	`ver` integer NOT NULL,
	`data` text NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`id`, `locale`, `ver`)
);
