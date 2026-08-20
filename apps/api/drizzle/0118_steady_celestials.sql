DROP INDEX `runs_native_chat_event_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `runs_native_chat_event_unique` ON `runs` (`initiator_agent_id`,`trigger_source`,`trigger_event_id`) WHERE trigger_source IN ('slack', 'discord', 'qq_official') AND trigger_event_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `qq_official_config` text;