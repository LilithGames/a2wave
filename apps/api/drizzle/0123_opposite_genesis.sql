CREATE TABLE `saml_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `saml_requests_created_at_idx` ON `saml_requests` (`created_at`);