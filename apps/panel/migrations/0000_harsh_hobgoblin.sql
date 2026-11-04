CREATE TABLE `agent_site_tokens` (
	`grant_id` text NOT NULL,
	`site_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`grant_id`, `site_id`)
);
--> statement-breakpoint
CREATE TABLE `backup_policies` (
	`site_id` text PRIMARY KEY NOT NULL,
	`policy` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `backup_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`kind` text NOT NULL,
	`snapshot` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_at` integer NOT NULL,
	`lease_until` integer,
	`progress` text,
	`state` text,
	`error` text,
	`requested_by` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `backup_runs_site` ON `backup_runs` (`site_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `backup_runs_due` ON `backup_runs` (`status`,`next_at`);--> statement-breakpoint
CREATE TABLE `backup_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`taken_at` integer NOT NULL,
	`kind` text NOT NULL,
	`documents` integer NOT NULL,
	`files` integer NOT NULL,
	`bytes` integer NOT NULL,
	`warnings` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `backup_snapshots_site` ON `backup_snapshots` (`site_id`,`taken_at`);--> statement-breakpoint
CREATE TABLE `favorites` (
	`user` text NOT NULL,
	`site_id` text NOT NULL,
	PRIMARY KEY(`user`, `site_id`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `logins` (
	`state` text PRIMARY KEY NOT NULL,
	`verifier` text NOT NULL,
	`nonce` text NOT NULL,
	`return_to` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`secret_hash` text,
	`name` text NOT NULL,
	`uri` text,
	`redirect_uris` text NOT NULL,
	`auth_method` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`hash` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`challenge` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_grants` (
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
CREATE UNIQUE INDEX `oauth_grants_access_hash_unique` ON `oauth_grants` (`access_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_grants_refresh_hash_unique` ON `oauth_grants` (`refresh_hash`);--> statement-breakpoint
CREATE TABLE `oauth_requests` (
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
CREATE TABLE `panel_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`sub` text NOT NULL,
	`email` text,
	`name` text,
	`id_token` text NOT NULL,
	`refresh_token` text,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`name` text NOT NULL,
	`admin` text NOT NULL,
	`org` text,
	`added_by` text NOT NULL,
	`added_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sites_url_unique` ON `sites` (`url`);