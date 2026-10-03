CREATE TABLE `continuity_finding` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`ref_kind` text NOT NULL,
	`entity_id` text,
	`entity_name` text,
	`entity_kind` text,
	`attribute` text,
	`ref_label` text NOT NULL,
	`ref_value` text NOT NULL,
	`ref_node_id` text,
	`ref_quote` text,
	`quote` text NOT NULL,
	`why` text NOT NULL,
	`fix` text,
	`flagged` integer DEFAULT false NOT NULL,
	`violation` text,
	`status` text DEFAULT 'open' NOT NULL,
	`origin` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`proposal_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entity_id`) REFERENCES `entity`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ref_node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`proposal_id`) REFERENCES `ai_proposal`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `continuity_finding_node_idx` ON `continuity_finding` (`node_id`);--> statement-breakpoint
CREATE INDEX `continuity_finding_status_idx` ON `continuity_finding` (`status`);