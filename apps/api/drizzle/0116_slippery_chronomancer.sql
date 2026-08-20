CREATE TABLE `cli_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`name` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cli_tokens_token_hash_unique` ON `cli_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `cli_tokens_user_id_idx` ON `cli_tokens` (`user_id`);