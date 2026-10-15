CREATE TABLE `notebook_item` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`content` text,
	`plain` text DEFAULT '' NOT NULL,
	`position` real NOT NULL,
	`deleted` text,
	`created` text NOT NULL,
	`modified` text NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `notebook_item`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notebook_item_parent_idx` ON `notebook_item` (`parent_id`,`position`);--> statement-breakpoint
CREATE TABLE `notebook_version` (
	`id` text PRIMARY KEY NOT NULL,
	`page_id` text NOT NULL,
	`author` text NOT NULL,
	`title` text NOT NULL,
	`content` text,
	`created` text NOT NULL,
	FOREIGN KEY (`page_id`) REFERENCES `notebook_item`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notebook_version_page_idx` ON `notebook_version` (`page_id`,`created`);