CREATE TABLE `voice_exemplar` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text,
	`text` text NOT NULL,
	`pov` text,
	`kind` text NOT NULL,
	`created` text NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `voice_exemplar_created_idx` ON `voice_exemplar` (`created`);