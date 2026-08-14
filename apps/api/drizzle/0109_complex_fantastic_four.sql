CREATE TABLE `scm_workspace_removals` (
	`id` text PRIMARY KEY NOT NULL,
	`scm_source_id` text NOT NULL,
	`workspace_name` text NOT NULL,
	`owner_instance_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`scm_source_id`) REFERENCES `scm_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scm_workspace_removals_scm_source_id_idx` ON `scm_workspace_removals` (`scm_source_id`);