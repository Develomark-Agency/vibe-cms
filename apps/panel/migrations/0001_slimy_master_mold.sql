CREATE TABLE `hub_roles` (
	`name` text PRIMARY KEY NOT NULL,
	`permissions` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`sub` text,
	`email` text,
	`name` text,
	`role` text NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer NOT NULL,
	`last_seen_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_sub_unique` ON `members` (`sub`);--> statement-breakpoint
CREATE INDEX `members_email` ON `members` (`email`);--> statement-breakpoint
CREATE TABLE `site_assignments` (
	`site_id` text NOT NULL,
	`principal` text NOT NULL,
	`email` text,
	`name` text,
	`roles` text NOT NULL,
	`assigned_by` text NOT NULL,
	`assigned_at` integer NOT NULL,
	PRIMARY KEY(`site_id`, `principal`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `site_assignments_principal` ON `site_assignments` (`principal`);--> statement-breakpoint
CREATE TABLE `site_grants` (
	`site_id` text NOT NULL,
	`sub` text NOT NULL,
	`kind` text NOT NULL,
	`granted_by` text NOT NULL,
	`granted_at` integer NOT NULL,
	PRIMARY KEY(`site_id`, `sub`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`roles` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `sites` ADD `template_id` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `template_state` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `template_skipped` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `template_error` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `template_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sites` ADD `template_by` text;