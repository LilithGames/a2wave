CREATE TABLE `device_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`device_code_hash` text NOT NULL,
	`user_code` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`user_id` text,
	`client_ip` text,
	`user_agent` text,
	`expires_at` integer NOT NULL,
	`last_polled_at` integer,
	`approved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_authorizations_device_code_hash_unique` ON `device_authorizations` (`device_code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_authorizations_user_code_unique` ON `device_authorizations` (`user_code`);--> statement-breakpoint
CREATE INDEX `device_authorizations_expires_at_idx` ON `device_authorizations` (`expires_at`);