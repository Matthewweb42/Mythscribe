CREATE TABLE `knew_before` (
	`secret_id` text NOT NULL,
	`record_id` text NOT NULL,
	`created` text NOT NULL,
	PRIMARY KEY(`secret_id`, `record_id`),
	FOREIGN KEY (`secret_id`) REFERENCES `record`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`record_id`) REFERENCES `record`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `topic_quote` (
	`id` text PRIMARY KEY NOT NULL,
	`record_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`node_id` text NOT NULL,
	`role` text NOT NULL,
	`label` text NOT NULL,
	`para` integer NOT NULL,
	`quote` text NOT NULL,
	`anchor` text DEFAULT '[]' NOT NULL,
	`stating` text DEFAULT '[]' NOT NULL,
	`reading_id` text,
	`state` text NOT NULL,
	`created` text NOT NULL,
	`proved` text NOT NULL,
	FOREIGN KEY (`record_id`) REFERENCES `record`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`draft_id`) REFERENCES `draft`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reading_id`) REFERENCES `reading`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `topic_quote_record_idx` ON `topic_quote` (`record_id`);--> statement-breakpoint
CREATE INDEX `topic_quote_node_idx` ON `topic_quote` (`node_id`,`draft_id`);--> statement-breakpoint
ALTER TABLE `claim` ADD `topic_quote_id` text REFERENCES topic_quote(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `scene_read` ADD `topics_read` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `scene_read` ADD `settled` integer DEFAULT false NOT NULL;