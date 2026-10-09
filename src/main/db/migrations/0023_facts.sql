CREATE TABLE `fact` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`attribute` text NOT NULL,
	`value` text NOT NULL,
	`object_entity_id` text,
	`node_id` text,
	`quote` text,
	`origin` text NOT NULL,
	`status` text DEFAULT 'canon' NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`fact_key` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entity`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`object_entity_id`) REFERENCES `entity`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `fact_entity_attribute_idx` ON `fact` (`entity_id`,`attribute`);--> statement-breakpoint
CREATE INDEX `fact_node_idx` ON `fact` (`node_id`);--> statement-breakpoint
CREATE INDEX `fact_object_idx` ON `fact` (`object_entity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `fact_entity_key_uq` ON `fact` (`entity_id`,`fact_key`);--> statement-breakpoint
CREATE TABLE `knowledge_change` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`created_at` text NOT NULL,
	`node_id` text,
	`quote` text,
	`kind` text NOT NULL,
	`entity_id` text,
	`target_id` text NOT NULL,
	`label` text NOT NULL,
	`undo` text NOT NULL,
	`status` text DEFAULT 'applied' NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`entity_id`) REFERENCES `entity`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `knowledge_change_created_idx` ON `knowledge_change` (`created_at`);--> statement-breakpoint
CREATE INDEX `knowledge_change_run_idx` ON `knowledge_change` (`run_id`);--> statement-breakpoint
ALTER TABLE `entity` ADD `status` text DEFAULT 'canon' NOT NULL;