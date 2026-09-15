CREATE TABLE `ai_proposal` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`feature` text NOT NULL,
	`node_id` text,
	`prompt_version` text NOT NULL,
	`model` text NOT NULL,
	`prompt_tokens` integer NOT NULL,
	`completion_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`cached` integer NOT NULL,
	`content` text NOT NULL,
	`flagged` integer,
	`violation` text,
	`target_from` integer,
	`target_to` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`note` text,
	`settled_at` text,
	`regenerated_from` text,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`regenerated_from`) REFERENCES `ai_proposal`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ai_proposal_created_at_idx` ON `ai_proposal` (`created_at`);--> statement-breakpoint
CREATE INDEX `ai_proposal_node_idx` ON `ai_proposal` (`node_id`);