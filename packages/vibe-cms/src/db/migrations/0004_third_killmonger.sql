CREATE TABLE `vibe_redirects` (
	`id` text PRIMARY KEY NOT NULL,
	`from` text NOT NULL,
	`to` text NOT NULL,
	`status` integer NOT NULL,
	`keep_query` integer NOT NULL,
	`locale` text,
	`source` text NOT NULL,
	`document_id` text,
	`document_type` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL,
	`last_hit_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vibe_redirects_from` ON `vibe_redirects` (`from`);--> statement-breakpoint
CREATE INDEX `vibe_redirects_document` ON `vibe_redirects` (`document_id`);