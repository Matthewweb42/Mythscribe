CREATE TABLE `draft` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`created` text NOT NULL,
	`modified` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `draft_text` (
	`draft_id` text NOT NULL,
	`node_id` text NOT NULL,
	`content` text,
	`word_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`draft_id`, `node_id`),
	FOREIGN KEY (`draft_id`) REFERENCES `draft`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade
);
