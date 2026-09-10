CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`format` text DEFAULT 'novel' NOT NULL,
	`created` text NOT NULL,
	`modified` text NOT NULL,
	`last_opened` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
