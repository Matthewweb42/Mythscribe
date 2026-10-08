ALTER TABLE `mention_scan` ADD `passage_hash` text;--> statement-breakpoint
ALTER TABLE `tag_mention` ADD `paragraphs` text DEFAULT '[]' NOT NULL;