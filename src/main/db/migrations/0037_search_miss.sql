CREATE TABLE `search_miss` (
	`id` text PRIMARY KEY NOT NULL,
	`created` text NOT NULL,
	`question` text NOT NULL,
	`terms` text DEFAULT '[]' NOT NULL,
	`node_id` text NOT NULL,
	`para` integer NOT NULL,
	`quote` text NOT NULL,
	`prompt_version` text NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `search_miss_created_idx` ON `search_miss` (`created`);