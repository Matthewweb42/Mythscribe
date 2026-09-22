CREATE TABLE `mention_scan` (
	`node_id` text PRIMARY KEY NOT NULL,
	`content_hash` text NOT NULL,
	`scanned_at` text NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tag_mention` (
	`id` text PRIMARY KEY NOT NULL,
	`tag_id` text NOT NULL,
	`node_id` text NOT NULL,
	`count` integer NOT NULL,
	`positions` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tag_id`) REFERENCES `tag`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tag_mention_tag_idx` ON `tag_mention` (`tag_id`);--> statement-breakpoint
CREATE INDEX `tag_mention_node_idx` ON `tag_mention` (`node_id`);--> statement-breakpoint
ALTER TABLE `tag` ADD `track_mentions` integer DEFAULT true NOT NULL;