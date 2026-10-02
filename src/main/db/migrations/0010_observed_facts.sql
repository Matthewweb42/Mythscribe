CREATE TABLE `observed_fact` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`node_id` text NOT NULL,
	`attribute` text NOT NULL,
	`value` text NOT NULL,
	`quote` text NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entity`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `observed_fact_entity_idx` ON `observed_fact` (`entity_id`);--> statement-breakpoint
CREATE INDEX `observed_fact_node_idx` ON `observed_fact` (`node_id`);--> statement-breakpoint
ALTER TABLE `entity` ADD `origin` text DEFAULT 'author' NOT NULL;