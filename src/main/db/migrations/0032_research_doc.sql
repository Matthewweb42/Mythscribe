CREATE TABLE `research_doc` (
	`node_id` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`context_file_id` text,
	`file_type` text,
	`converted` integer DEFAULT false NOT NULL,
	`not_canon` integer DEFAULT false NOT NULL,
	`created` text NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`context_file_id`) REFERENCES `context_file`(`id`) ON UPDATE no action ON DELETE set null
);
