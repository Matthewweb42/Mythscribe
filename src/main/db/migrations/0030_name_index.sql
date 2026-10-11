CREATE TABLE `memory_scan` (
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`names_hash` text,
	`passages_hash` text,
	`scanned_at` text NOT NULL,
	PRIMARY KEY(`owner_kind`, `owner_id`)
);
--> statement-breakpoint
CREATE TABLE `name_mention` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`record_id` text NOT NULL,
	`para` integer NOT NULL,
	`from` integer NOT NULL,
	`to` integer NOT NULL,
	`text` text NOT NULL,
	`ambiguous` integer DEFAULT false NOT NULL,
	`span_key` text NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`record_id`) REFERENCES `record`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `name_mention_node_idx` ON `name_mention` (`node_id`);--> statement-breakpoint
CREATE INDEX `name_mention_record_idx` ON `name_mention` (`record_id`);