CREATE TABLE `entity` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`template` text DEFAULT 'structured' NOT NULL,
	`fields` text DEFAULT '{}' NOT NULL,
	`body` text,
	`image` text,
	`tag_id` text,
	`created` text NOT NULL,
	`modified` text NOT NULL,
	FOREIGN KEY (`tag_id`) REFERENCES `tag`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `entity_kind_name_idx` ON `entity` (`kind`,`name`);