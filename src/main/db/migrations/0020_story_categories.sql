CREATE TABLE `story_category` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`noun` text NOT NULL,
	`icon` text NOT NULL,
	`fields` text,
	`hint` text DEFAULT '' NOT NULL,
	`origin` text NOT NULL,
	`created` text NOT NULL,
	`modified` text NOT NULL
);
