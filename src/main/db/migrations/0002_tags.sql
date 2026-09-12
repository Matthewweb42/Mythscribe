CREATE TABLE `document_tag` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`created` text NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tag`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_tag_node_tag_uq` ON `document_tag` (`node_id`,`tag_id`);--> statement-breakpoint
CREATE INDEX `document_tag_tag_idx` ON `document_tag` (`tag_id`);--> statement-breakpoint
CREATE TABLE `tag` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`color` text NOT NULL,
	`parent_id` text,
	`created` text NOT NULL,
	`modified` text NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `tag`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tag_name_uq` ON `tag` (`name`);