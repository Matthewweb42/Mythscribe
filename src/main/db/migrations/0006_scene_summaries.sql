CREATE TABLE `scene_summary` (
	`node_id` text PRIMARY KEY NOT NULL,
	`content_hash` text NOT NULL,
	`summary` text NOT NULL,
	`key_points` text NOT NULL,
	`characters` text NOT NULL,
	`prompt_version` text NOT NULL,
	`model` text NOT NULL,
	`truncated` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade
);
