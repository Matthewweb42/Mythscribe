CREATE TABLE `todo_item` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`rule` text NOT NULL,
	`source` text NOT NULL,
	`subject` text NOT NULL,
	`entity_id` text,
	`node_id` text,
	`quote` text,
	`why` text NOT NULL,
	`target` text NOT NULL,
	`suggestions` text DEFAULT '[]' NOT NULL,
	`suggested_at` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entity`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `todo_item_key_unique` ON `todo_item` (`key`);--> statement-breakpoint
CREATE INDEX `todo_item_status_idx` ON `todo_item` (`status`);--> statement-breakpoint
CREATE INDEX `todo_item_entity_idx` ON `todo_item` (`entity_id`);--> statement-breakpoint
CREATE INDEX `todo_item_node_idx` ON `todo_item` (`node_id`);