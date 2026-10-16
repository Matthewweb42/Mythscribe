ALTER TABLE `edit_change` ADD `flow_category` text;--> statement-breakpoint
ALTER TABLE `edit_pass` ADD `flow` text;--> statement-breakpoint
ALTER TABLE `edit_pass` ADD `overview` text;--> statement-breakpoint
ALTER TABLE `edit_pass` ADD `note_edits` text DEFAULT '[]' NOT NULL;