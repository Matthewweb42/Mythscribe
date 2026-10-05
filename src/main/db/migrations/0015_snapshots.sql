CREATE TABLE `snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`kind` text NOT NULL,
	`scope` text NOT NULL,
	`node_id` text,
	`draft_name` text,
	`created` text NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `snapshot_text` (
	`snapshot_id` text NOT NULL,
	`node_id` text NOT NULL,
	`content` text,
	`word_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`snapshot_id`, `node_id`),
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshot`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade
);
