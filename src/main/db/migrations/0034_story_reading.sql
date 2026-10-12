CREATE TABLE `card` (
	`node_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`reading_id` text,
	`line` text NOT NULL,
	`gist` text NOT NULL,
	`fields` text DEFAULT '{}' NOT NULL,
	`present` text DEFAULT '[]' NOT NULL,
	`mood` text,
	`theme` text,
	`anchor` text DEFAULT '[]' NOT NULL,
	`line_hash` text,
	`created` text NOT NULL,
	PRIMARY KEY(`node_id`, `draft_id`),
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`draft_id`) REFERENCES `draft`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reading_id`) REFERENCES `reading`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `claim` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`reading_id` text,
	`record_id` text,
	`pending` text,
	`subject_text` text,
	`slot` text NOT NULL,
	`value` text NOT NULL,
	`value_key` text NOT NULL,
	`object_id` text,
	`how` text,
	`from_id` text,
	`voice` text NOT NULL,
	`speaker_id` text,
	`mode` text NOT NULL,
	`quote` text NOT NULL,
	`para` integer NOT NULL,
	`anchor` text DEFAULT '[]' NOT NULL,
	`proof` text NOT NULL,
	`change` integer DEFAULT false NOT NULL,
	`state` text NOT NULL,
	`spot` text,
	`spot_tier` text,
	`spot_at` text,
	`created` text NOT NULL,
	`proved` text NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`draft_id`) REFERENCES `draft`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reading_id`) REFERENCES `reading`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`record_id`) REFERENCES `record`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`object_id`) REFERENCES `record`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`from_id`) REFERENCES `record`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`speaker_id`) REFERENCES `record`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `claim_node_idx` ON `claim` (`node_id`,`draft_id`);--> statement-breakpoint
CREATE INDEX `claim_record_idx` ON `claim` (`record_id`,`slot`);--> statement-breakpoint
CREATE INDEX `claim_state_idx` ON `claim` (`state`);--> statement-breakpoint
CREATE TABLE `memory_backfill` (
	`record_id` text NOT NULL,
	`norm` text NOT NULL,
	`state` text NOT NULL,
	`pages` integer DEFAULT 0 NOT NULL,
	`created` text NOT NULL,
	`done_at` text,
	PRIMARY KEY(`record_id`, `norm`),
	FOREIGN KEY (`record_id`) REFERENCES `record`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `plan_link` (
	`plan_id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`origin` text NOT NULL,
	`score` real DEFAULT 0 NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`reading_id` text,
	`created` text NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scene_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reading_id`) REFERENCES `reading`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `reading` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`purpose` text NOT NULL,
	`pages` integer DEFAULT 1 NOT NULL,
	`paras` text DEFAULT '[]' NOT NULL,
	`prompt_version` text NOT NULL,
	`verify_version` text,
	`model` text NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`cloud` integer DEFAULT false NOT NULL,
	`finish_reason` text,
	`items` integer DEFAULT 0 NOT NULL,
	`quotes_found` integer DEFAULT 0 NOT NULL,
	`literal` integer DEFAULT 0 NOT NULL,
	`verify_sent` integer DEFAULT 0 NOT NULL,
	`verified` integer DEFAULT 0 NOT NULL,
	`rejected` integer DEFAULT 0 NOT NULL,
	`rejections` text DEFAULT '{}' NOT NULL,
	`cut` integer DEFAULT 0 NOT NULL,
	`created` text NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`draft_id`) REFERENCES `draft`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reading_model_idx` ON `reading` (`model`,`created`);--> statement-breakpoint
CREATE INDEX `reading_node_idx` ON `reading` (`node_id`,`draft_id`);--> statement-breakpoint
CREATE TABLE `scene_read` (
	`node_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`sentences` text DEFAULT '[]' NOT NULL,
	`partials` integer DEFAULT 0 NOT NULL,
	`full_at` text,
	`reading_id` text,
	`updated` text NOT NULL,
	PRIMARY KEY(`node_id`, `draft_id`),
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`draft_id`) REFERENCES `draft`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reading_id`) REFERENCES `reading`(`id`) ON UPDATE no action ON DELETE set null
);
