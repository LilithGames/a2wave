CREATE TABLE `scm_workload_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`workload_type` text NOT NULL,
	`workload_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`scm_source_id` text NOT NULL,
	`phase` text DEFAULT 'reserved' NOT NULL,
	`owner_instance_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scm_source_id`) REFERENCES `scm_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scm_workload_leases_workload_unique` ON `scm_workload_leases` (`workload_type`,`workload_id`);--> statement-breakpoint
CREATE INDEX `scm_workload_leases_agent_id_idx` ON `scm_workload_leases` (`agent_id`);--> statement-breakpoint
CREATE INDEX `scm_workload_leases_scm_source_id_idx` ON `scm_workload_leases` (`scm_source_id`);