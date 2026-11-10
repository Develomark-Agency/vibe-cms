CREATE TABLE `vibe_branches` (
	`id` text NOT NULL,
	`locale` text NOT NULL,
	`owner` text NOT NULL,
	`owner_name` text,
	`base_ver` integer,
	`base` text,
	`data` text NOT NULL,
	`via` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`id`, `locale`, `owner`)
);
--> statement-breakpoint
-- Unpublished drafts become their last editor's branch, started from the live copy.
INSERT OR IGNORE INTO `vibe_branches` (`id`, `locale`, `owner`, `owner_name`, `base_ver`, `base`, `data`, `via`, `created_at`, `updated_at`)
SELECT `id`, `locale`, COALESCE(`updated_by`, 'system'), NULL, `published_ver`, `published`, `draft`, 'ui', `updated_at`, `updated_at`
FROM `vibe_documents` WHERE `published` IS NULL OR `published` != `draft`;
--> statement-breakpoint
-- The search triggers read the draft; `migrate()` reinstalls them over branches.
DROP TRIGGER IF EXISTS `vibe_search_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `vibe_search_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `vibe_search_delete`;
--> statement-breakpoint
ALTER TABLE `vibe_documents` DROP COLUMN `draft`;
