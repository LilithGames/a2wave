PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_scm_workspace_removals` (
	`id` text PRIMARY KEY NOT NULL,
	`scm_source_id` text NOT NULL,
	`workspace_name` text NOT NULL,
	`owner_instance_id` text,
	`attempt_token` text DEFAULT 'legacy' NOT NULL,
	`created_at` integer NOT NULL,
	`attempt_started_at` integer NOT NULL,
	FOREIGN KEY (`scm_source_id`) REFERENCES `scm_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_scm_workspace_removals`("id", "scm_source_id", "workspace_name", "owner_instance_id", "attempt_token", "created_at", "attempt_started_at") SELECT "id", "scm_source_id", "workspace_name", "owner_instance_id", "attempt_token", "created_at", "created_at" FROM `scm_workspace_removals`;--> statement-breakpoint
DROP TABLE `scm_workspace_removals`;--> statement-breakpoint
ALTER TABLE `__new_scm_workspace_removals` RENAME TO `scm_workspace_removals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `scm_workspace_removals_scm_source_id_idx` ON `scm_workspace_removals` (`scm_source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scm_workspace_removals_target_unique` ON `scm_workspace_removals` (`scm_source_id`,`workspace_name`);