CREATE TABLE `context_file` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`size` integer NOT NULL,
	`hash` text NOT NULL,
	`stored` text NOT NULL,
	`words` integer DEFAULT 0 NOT NULL,
	`text_hash` text,
	`processed_hash` text,
	`processed_text` text,
	`processed_at` text,
	`created` text NOT NULL,
	`modified` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `context_file_name_idx` ON `context_file` (`name`);