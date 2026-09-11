CREATE TABLE `node` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`section_type` text,
	`kind` text NOT NULL,
	`hierarchy_level` text,
	`title` text NOT NULL,
	`position` integer NOT NULL,
	`content` text,
	`notes` text,
	`word_count` integer DEFAULT 0 NOT NULL,
	`scene_meta` text,
	`matter_type` text,
	`preset` text,
	`created` text NOT NULL,
	`modified` text NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "node_root_is_section" CHECK(("node"."parent_id" IS NULL) = ("node"."section_type" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `node_parent_position_idx` ON `node` (`parent_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `node_section_type_uq` ON `node` (`section_type`);