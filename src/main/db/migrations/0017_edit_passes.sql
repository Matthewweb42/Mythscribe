CREATE TABLE `edit_change` (
	`id` text PRIMARY KEY NOT NULL,
	`pass_id` text NOT NULL,
	`node_id` text NOT NULL,
	`kind` text NOT NULL,
	`position` integer NOT NULL,
	`original` text NOT NULL,
	`replacement` text,
	`rationale` text NOT NULL,
	`category` text,
	`flagged` integer DEFAULT false NOT NULL,
	`violation` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`proposal_id` text,
	FOREIGN KEY (`pass_id`) REFERENCES `edit_pass`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`proposal_id`) REFERENCES `ai_proposal`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `edit_change_pass_idx` ON `edit_change` (`pass_id`);--> statement-breakpoint
CREATE INDEX `edit_change_node_idx` ON `edit_change` (`node_id`);--> statement-breakpoint
CREATE TABLE `edit_pass` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`instruction` text,
	`status` text NOT NULL,
	`node_ids` text NOT NULL,
	`done_node_ids` text DEFAULT '[]' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`dropped` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `edit_pass_created_idx` ON `edit_pass` (`created_at`);