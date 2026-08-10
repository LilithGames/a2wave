PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_feishu_pending_messages` (
	`message_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`run_id` text,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`message_id`, `agent_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_feishu_pending_messages`("message_id", "agent_id", "run_id", "payload", "created_at") SELECT "message_id", "agent_id", "run_id", "payload", "created_at" FROM `feishu_pending_messages`;--> statement-breakpoint
DROP TABLE `feishu_pending_messages`;--> statement-breakpoint
ALTER TABLE `__new_feishu_pending_messages` RENAME TO `feishu_pending_messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `feishu_pending_messages_agent_id_idx` ON `feishu_pending_messages` (`agent_id`);