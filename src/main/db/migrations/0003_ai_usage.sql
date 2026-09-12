CREATE TABLE `ai_cache` (
	`context_hash` text PRIMARY KEY NOT NULL,
	`feature` text NOT NULL,
	`prompt_version` text,
	`model` text NOT NULL,
	`response` text NOT NULL,
	`usage` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`feature` text NOT NULL,
	`tier` text NOT NULL,
	`model` text NOT NULL,
	`provider` text NOT NULL,
	`prompt_tokens` integer NOT NULL,
	`completion_tokens` integer NOT NULL,
	`cached_tokens` integer,
	`cost_usd` real NOT NULL,
	`cached` integer NOT NULL,
	`prompt_version` text,
	`context_hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_usage_at_idx` ON `ai_usage` (`at`);--> statement-breakpoint
CREATE INDEX `ai_usage_feature_idx` ON `ai_usage` (`feature`);