CREATE TABLE `finding` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`rule` text NOT NULL,
	`variant` text,
	`record_id` text NOT NULL,
	`slot` text NOT NULL,
	`key` text NOT NULL,
	`np_key` text NOT NULL,
	`a` text NOT NULL,
	`b` text NOT NULL,
	`extra` text,
	`verdict_ab` text,
	`verdict_ba` text,
	`why` text,
	`confirm` text,
	`confirm_why` text,
	`state` text NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`shown_at` text,
	`created` text NOT NULL,
	`judged_at` text,
	`confirmed_at` text,
	FOREIGN KEY (`draft_id`) REFERENCES `draft`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`record_id`) REFERENCES `record`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finding_draft_key_uq` ON `finding` (`draft_id`,`key`);--> statement-breakpoint
CREATE INDEX `finding_draft_state_idx` ON `finding` (`draft_id`,`state`);--> statement-breakpoint
CREATE INDEX `finding_record_idx` ON `finding` (`record_id`);--> statement-breakpoint
CREATE TABLE `verdict_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`verdict` text NOT NULL,
	`why` text,
	`tier` text NOT NULL,
	`prompt_version` text NOT NULL,
	`model` text NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`created` text NOT NULL,
	`used` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verdict_cache_used_idx` ON `verdict_cache` (`used`);