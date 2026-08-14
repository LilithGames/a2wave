CREATE TABLE `instance_heartbeats` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`heartbeat_at` integer NOT NULL
);
