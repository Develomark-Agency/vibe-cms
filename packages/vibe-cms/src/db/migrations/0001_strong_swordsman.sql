CREATE TABLE `vibe_roles` (
	`name` text PRIMARY KEY NOT NULL,
	`rules` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL
);
