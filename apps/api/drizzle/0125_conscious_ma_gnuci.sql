CREATE TABLE `provider_oauth_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`label` text NOT NULL,
	`email` text,
	`subject` text NOT NULL,
	`client_id` text NOT NULL,
	`host_id` text NOT NULL,
	`created_by_user_id` text,
	`tokens_enc` text NOT NULL,
	`expires_at` integer NOT NULL,
	`earliest_refresh_at` integer,
	`reauth_required` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`refresh_lease_id` text,
	`refresh_lease_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_oauth_accounts_registration_unique` ON `provider_oauth_accounts` (`provider_id`,`client_id`,`subject`);--> statement-breakpoint
CREATE TABLE `provider_oauth_logins` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`account_id` text,
	`created_by_user_id` text NOT NULL,
	`label` text,
	`token_hash` text NOT NULL,
	`pending_enc` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `provider_oauth_account_id` text;