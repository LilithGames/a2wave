CREATE TABLE `user_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`email` text,
	`role` text DEFAULT 'user' NOT NULL,
	`note` text,
	`invited_by` text,
	`accepted_user_id` text,
	`accepted_at` integer,
	`revoked_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`accepted_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_invitations_code_unique` ON `user_invitations` (`code`);--> statement-breakpoint
CREATE INDEX `user_invitations_created_at_idx` ON `user_invitations` (`created_at`);--> statement-breakpoint
CREATE INDEX `user_invitations_email_idx` ON `user_invitations` (`email`);