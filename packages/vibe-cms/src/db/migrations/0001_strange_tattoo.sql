CREATE TABLE `vibe_hub_users` (
	`sub` text PRIMARY KEY NOT NULL,
	`email` text,
	`name` text,
	`roles` text NOT NULL,
	`site_admin` integer DEFAULT false NOT NULL,
	`last_sign_in_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vibe_roles` (
	`name` text PRIMARY KEY NOT NULL,
	`rules` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL
);
