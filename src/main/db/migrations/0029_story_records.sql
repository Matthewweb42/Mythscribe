CREATE TABLE `alias` (
	`id` text PRIMARY KEY NOT NULL,
	`record_id` text NOT NULL,
	`text` text NOT NULL,
	`norm` text NOT NULL,
	`is_main` integer DEFAULT false NOT NULL,
	`case_rule` text DEFAULT 'auto' NOT NULL,
	`origin` text DEFAULT 'author' NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`created` text NOT NULL,
	FOREIGN KEY (`record_id`) REFERENCES `record`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alias_record_norm_uq` ON `alias` (`record_id`,`norm`);--> statement-breakpoint
CREATE UNIQUE INDEX `alias_norm_unshared_uq` ON `alias` (`norm`) WHERE "alias"."shared" = 0;--> statement-breakpoint
CREATE UNIQUE INDEX `alias_main_uq` ON `alias` (`record_id`) WHERE "alias"."is_main" = 1;--> statement-breakpoint
CREATE INDEX `alias_norm_idx` ON `alias` (`norm`);--> statement-breakpoint
CREATE TABLE `author_todo` (
	`id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`node_id` text,
	`record_id` text,
	`done` integer DEFAULT false NOT NULL,
	`position` integer NOT NULL,
	`created` text NOT NULL,
	`done_at` text,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`record_id`) REFERENCES `record`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `dismissed` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`record_id` text,
	`node_id` text,
	`label` text NOT NULL,
	`quote` text,
	`created` text NOT NULL,
	FOREIGN KEY (`record_id`) REFERENCES `record`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dismissed_kind_key_uq` ON `dismissed` (`kind`,`key`);--> statement-breakpoint
CREATE TABLE `label` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`colour` text NOT NULL,
	`kind` text NOT NULL,
	`position` integer NOT NULL,
	`legacy_tag_id` text,
	`created` text NOT NULL,
	`modified` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `label_link` (
	`label_id` text NOT NULL,
	`node_id` text NOT NULL,
	PRIMARY KEY(`label_id`, `node_id`),
	FOREIGN KEY (`label_id`) REFERENCES `label`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `label_link_node_idx` ON `label_link` (`node_id`);--> statement-breakpoint
CREATE TABLE `record` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text NOT NULL,
	`image` text,
	`origin` text DEFAULT 'author' NOT NULL,
	`pinned` text,
	`ideas` text,
	`legacy_entity_id` text,
	`legacy_tag_id` text,
	`created` text NOT NULL,
	`modified` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `record_category_idx` ON `record` (`category_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `record_legacy_entity_uq` ON `record` (`legacy_entity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `record_legacy_tag_uq` ON `record` (`legacy_tag_id`);--> statement-breakpoint
CREATE TABLE `scene_detail` (
	`node_id` text PRIMARY KEY NOT NULL,
	`pov_record_id` text,
	`place_record_id` text,
	`place_text` text DEFAULT '' NOT NULL,
	`time_text` text DEFAULT '' NOT NULL,
	`story_year` integer,
	`also_here` text DEFAULT '[]' NOT NULL,
	`modified` text NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pov_record_id`) REFERENCES `record`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`place_record_id`) REFERENCES `record`(`id`) ON UPDATE no action ON DELETE set null
);
