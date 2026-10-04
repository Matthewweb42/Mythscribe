CREATE TABLE `writing_log` (
	`day` text NOT NULL,
	`hour` integer NOT NULL,
	`words` integer DEFAULT 0 NOT NULL,
	`active_ms` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `hour`)
);
