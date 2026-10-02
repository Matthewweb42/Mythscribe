CREATE TABLE `document_tag_dismissal` (
	`node_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`node_id`, `tag_id`),
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tag`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `document_tag` ADD `source` text DEFAULT 'author' NOT NULL;--> statement-breakpoint
ALTER TABLE `tag` ADD `origin` text DEFAULT 'author' NOT NULL;