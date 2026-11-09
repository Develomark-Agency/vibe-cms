CREATE TABLE `vibe_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`actor` text NOT NULL,
	`actor_name` text,
	`via` text NOT NULL,
	`client` text,
	`on_behalf_of` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`target_label` text,
	`locale` text,
	`ok` integer NOT NULL,
	`error` text,
	`summary` text
);
--> statement-breakpoint
CREATE INDEX `vibe_activity_at` ON `vibe_activity` (`at`);--> statement-breakpoint
CREATE INDEX `vibe_activity_actor` ON `vibe_activity` (`actor`,`at`);--> statement-breakpoint
CREATE INDEX `vibe_activity_target` ON `vibe_activity` (`target_id`,`at`);